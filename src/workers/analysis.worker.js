/* eslint-disable no-restricted-globals */
/* eslint-disable no-unused-vars */
import * as bakana from 'bakana';
import * as scran from 'scran.js';
import * as gesel from 'gesel';
import * as hashwasm from 'hash-wasm';
import { parquetRead } from 'hyparquet';
import { Matrix, SVD, QR } from 'ml-matrix';
import { SparseMatrixCSC } from '../scatac/sparse.js';
import { runSingleSamplePipeline } from '../scatac/runSingleSamplePipeline.js';
import { parseMTXFromBuffer } from '../scatac/parseMTXFromBuffer.js';
import { createCSCMatrixAdapter } from '../scatac/cscMatrixAdapter.js';
import { runMultiSamplePipeline } from '../scatac/runMultiSamplePipeline.js';
import { parsePeakName, mapPeaksToUnified } from '../scatac/peaks.js';
import { runWNNPipeline } from '../scatac/wnn.js';
import { runBanksy } from '../spatial/banksy.js';
import { runSpaGE } from '../spatial/spage.js';
import { runSketchClustering, SKETCH_MIN_CELLS } from '../spatial/sketchClustering.js';
import { summarizePathwayEnrichment } from '../utils/pathwayEnrichment.js';

/** scATAC-seq: keep only cells with peak count > this (single-sample and multi-sample). */
const MIN_PEAKS_ATAC = 1500;
const ENRICHR_BASE_URL = 'https://maayanlab.cloud/Enrichr';
const SELECTED_REGION_CELLMARKER_LIBRARY = 'CellMarker_2024';
const SELECTED_REGION_WIKIPATHWAYS_LIBRARY = 'WikiPathways_2024_Human';

/**
 * Filter cells by minimum number of peaks (non-zero entries per column).
 * @param {import('../scatac/sparse.js').SparseMatrixCSC} countMatrix: peaks x cells
 * @param {string[]} barcodes: cell barcodes, length = ncols
 * @param {number} minPeaks: keep cells with peak count > minPeaks
 * @returns {{ filteredMatrix: import('../scatac/sparse.js').SparseMatrixCSC, filteredBarcodes: string[], nRemoved: number }}
 */
function filterAtacCellsByMinPeaks(countMatrix, barcodes, minPeaks = MIN_PEAKS_ATAC) {
  const { colPtr, ncols } = countMatrix;
  const keepIndices = [];
  for (let j = 0; j < ncols; j++) {
    const nPeaksInCell = colPtr[j + 1] - colPtr[j];
    if (nPeaksInCell > minPeaks) keepIndices.push(j);
  }
  const filteredMatrix = countMatrix.subsetCols(keepIndices);
  const filteredBarcodes = keepIndices.map((j) => barcodes[j]);
  return { filteredMatrix, filteredBarcodes, nRemoved: ncols - keepIndices.length };
}


// Catch unhandled errors in the worker, especially WASM abort() from OOM
let wasmAbortSent = false; // prevent sending duplicate WASM OOM messages
self.addEventListener('error', (e) => {
  const msg = e.message || '';
  console.error('Worker unhandled error:', msg, e.filename, e.lineno);
  // Prevent the empty/opaque ErrorEvent from propagating to the parent thread:
  // the parent's onerror would receive an uninformative Event with no message,
  // causing the worker to appear dead while the UI hangs indefinitely.
  e.preventDefault();
  if (wasmAbortSent) return;
  wasmAbortSent = true;
  const isOOM = /Aborted\(\)|out of memory|RuntimeError/i.test(msg);
  self.postMessage({
    type: 'ANALYSIS_ERROR',
    error: isOOM
      ? 'Out of memory: the dataset is too large for the browser-based analysis engine ' +
        '(WebAssembly 4 GB memory limit). Please subsample your dataset to ~200K cells ' +
        'or fewer before loading (e.g., using scanpy, Seurat, or cellranger reanalyze).'
      : `Analysis engine error: ${msg || 'unknown worker error'}`,
  });
});
self.addEventListener('unhandledrejection', (e) => {
  console.error('Worker unhandled rejection:', e.reason);
  const msg = String(e.reason?.message ?? e.reason ?? '');
  if (!wasmAbortSent && (/Aborted\(\)/.test(msg) || /RuntimeError/.test(msg) || /out of memory/i.test(msg))) {
    wasmAbortSent = true;
    self.postMessage({
      type: 'ANALYSIS_ERROR',
      error: 'Out of memory: the dataset is too large for the browser-based analysis engine ' +
             '(WebAssembly 4 GB memory limit). Please subsample your dataset to ~200K cells ' +
             'or fewer before loading (e.g., using scanpy, Seurat, or cellranger reanalyze).',
    });
  }
});

// hyparquet-compressors loaded dynamically when needed
let hyparquetCompressors = null;

// State variables
let analysisState = null;
let loadedData = null;
let currentResults = {
  umap: null,
  clusters: null,
  qc: null,
  pca: null,
  regionClusters: null,
};
let cachedGeneNames = null;
let cachedGeneLookup = null;
let currentParameters = null;
let spatialData = null; // Store spatial coordinates and metadata
let currentClusterLabelMap = null; // Stores cluster rename/merge mapping from App
// Cache for multiome ATAC gene activity (plot gene in ATAC view), key: normalized gene name
let atacGeneActivityCache = new Map();
// Cache for scATAC gene activity (plot gene activity / coverage plot in peak view), key: normalized gene name
let scAtacGeneActivityCache = new Map();
// Cache for SpaGE-imputed gene expressions, key: lowercase gene name, value: Float32Array
// These are for plotting only and must NEVER be used in reanalysis (PCA/clustering/UMAP).
let imputedGeneCache = new Map();

// Pending ATAC matrix stream (large matrix sent in chunks to avoid renderer OOM)
let pendingAtacPayload = null;
let pendingAtacMatrixData = null;
let pendingAtacReceivedLength = 0;
let initializationPromise = null;
let analysisEngineReady = false;

const RNA_PIPELINE_STEPS = [
  'inputs',
  'rna_quality_control',
  'cell_filtering',
  'rna_normalization',
  'feature_selection',
  'rna_pca',
  'combine_embeddings',
  'batch_correction',
  'neighbor_index',
  'umap',
  'kmeans_cluster',
  'snn_graph_cluster',
  'choose_clustering',
  'marker_detection',
];

function cloneStepParameters(source = {}) {
  const result = {};
  for (const key of RNA_PIPELINE_STEPS) {
    const value = source?.[key];
    result[key] = value ? { ...value } : {};
  }

  if (result.cell_filtering) {
    result.cell_filtering.use_rna = typeof result.cell_filtering.use_rna === 'boolean' ? result.cell_filtering.use_rna : true;
    result.cell_filtering.use_adt = false;
    result.cell_filtering.use_crispr = false;
  }

  if (result.combine_embeddings) {
    result.combine_embeddings.rna_weight = typeof result.combine_embeddings.rna_weight === 'number' ? result.combine_embeddings.rna_weight : 1;
    result.combine_embeddings.adt_weight = 0;
    result.combine_embeddings.crispr_weight = 0;
  }

  if (result.choose_clustering && typeof result.choose_clustering.method !== 'string') {
    result.choose_clustering.method = 'snn_graph';
  }

  if (!result.umap) {
    result.umap = {};
  }

  return result;
}

function applyMemoryFriendlyParameters(params = {}, { aggressive = false } = {}) {
  const maxNeighbors = aggressive ? 12 : 15;
  const maxPcs = aggressive ? 35 : 45;
  const maxHvgs = aggressive ? 4000 : 6000;

  if (typeof bakana.configureApproximateNeighbors === 'function') {
    bakana.configureApproximateNeighbors(params, true);
  } else if (params.neighbor_index) {
    params.neighbor_index.approximate = true;
  }

  if (!params.neighbor_index) {
    params.neighbor_index = {};
  }
  params.neighbor_index.approximate = true;

  if (!params.umap) {
    params.umap = {};
  }
  if (!Number.isFinite(params.umap.num_neighbors) || params.umap.num_neighbors > maxNeighbors) {
    params.umap.num_neighbors = maxNeighbors;
  }
  
  // Note: When approximate=true, neighbor_index doesn't accept 'k' parameter.
  // The neighbor count will be inferred from UMAP's num_neighbors automatically.
  // Only set 'k' if approximate is false.
  if (!params.neighbor_index.approximate) {
    params.neighbor_index.k = params.umap.num_neighbors;
  }
  
  if (aggressive) {
    params.umap.min_dist = Math.max(0.15, Number.isFinite(params.umap.min_dist) ? params.umap.min_dist : 0.2);
  }
  
  // Fewer epochs than the default 500, UMAP converges well for large datasets
  if (!Number.isFinite(params.umap.num_epochs)) {
    params.umap.num_epochs = aggressive ? 200 : 300;
  }

  if (params.rna_pca) {
    if (!Number.isFinite(params.rna_pca.num_pcs) || params.rna_pca.num_pcs > maxPcs) {
      params.rna_pca.num_pcs = maxPcs;
    }
    if (!Number.isFinite(params.rna_pca.num_hvgs) || params.rna_pca.num_hvgs > maxHvgs) {
      params.rna_pca.num_hvgs = maxHvgs;
    }
  }

  if (params.marker_detection) {
    params.marker_detection.compute_auc = false;
  }
}

// Sync neighbor_index.k to umap.num_neighbors; 'k' is only accepted when approximate=false.
function synchronizeNeighborCounts(params = {}) {
  if (!params.umap || !params.neighbor_index) {
    return;
  }

  if (!params.neighbor_index.approximate) {
    const umapNeighbors = params.umap.num_neighbors;
    if (Number.isFinite(umapNeighbors)) {
      params.neighbor_index.k = umapNeighbors;
    }
  }
}

// Scale num_epochs by cell count; min_dist is preserved to avoid the "single blob" collapse issue.
function applyFastUmapParameters(params = {}, cellCount = 0) {
  if (!params.umap) {
    params.umap = {};
  }

  if (cellCount > 300000) {
    params.umap.num_epochs = 300;
  } else if (cellCount > 200000) {
    params.umap.num_epochs = 250;
  } else if (cellCount > 100000) {
    params.umap.num_epochs = 200;
  } else if (cellCount > 50000) {
    params.umap.num_epochs = 200;
  } else if (cellCount > 20000) {
    params.umap.num_epochs = 250;
  }
  // < 20K cells: use default settings
}

// Leiden is ~2-3x faster than Louvain for large graphs; resolution 0.4 gives ~15-30 clusters.
function applyFastClusteringParameters(params = {}, cellCount = 0) {
  if (!params.snn_graph_cluster) {
    params.snn_graph_cluster = {};
  }

  if (cellCount > 200000) {
    params.snn_graph_cluster.algorithm = 'leiden';
    const currentLeidenRes = params.snn_graph_cluster.leiden_resolution;
    const currentMultilevelRes = params.snn_graph_cluster.multilevel_resolution;
    if (!Number.isFinite(currentLeidenRes) || currentLeidenRes >= 0.8) {
      params.snn_graph_cluster.leiden_resolution = 0.4;
    }
    if (!Number.isFinite(currentMultilevelRes) || currentMultilevelRes >= 0.8) {
      params.snn_graph_cluster.multilevel_resolution = 0.4;
    }
  } else if (cellCount > 50000) {
    params.snn_graph_cluster.algorithm = 'leiden';
  }
}

const INVALID_TYPED_ARRAY_REGEX = /invalid typed array length/i;

function isInvalidTypedArrayLength(error) {
  if (!error) {
    return false;
  }
  if (error instanceof RangeError && INVALID_TYPED_ARRAY_REGEX.test(error.message || '')) {
    return true;
  }
  return INVALID_TYPED_ARRAY_REGEX.test(String(error?.message ?? error));
}

/**
 * Detect WASM abort errors (typically caused by out-of-memory in the WASM heap).
 * When the scran.js / bakana WASM module runs out of its 4 GiB address space,
 * Emscripten calls abort() which throws a RuntimeError with "Aborted()".
 * This is FATAL, once aborted, the WASM module cannot be reused.
 */
function isWasmAbort(error) {
  if (!error) return false;
  const msg = String(error?.message ?? error);
  if (/Aborted\(\)/.test(msg)) return true;
  if (error instanceof Error && error.name === 'RuntimeError' && /abort/i.test(msg)) return true;
  // Also detect OOM-related WASM traps
  if (/out of memory|memory access out of bounds|unreachable|table index is out of bounds/i.test(msg)) return true;
  return false;
}

/** Human-readable error message for WASM OOM. */
const WASM_OOM_MESSAGE =
  'Out of memory: the dataset is too large for the browser-based analysis engine ' +
  '(WebAssembly 4 GB memory limit). Please subsample your dataset to ~200K cells ' +
  'or fewer before loading (e.g., using scanpy\'s sc.pp.subsample, Seurat\'s subset, ' +
  'or cellranger reanalyze --downsample).'
;

function buildDefaultParameters({ fastMode = false, aggressive = false } = {}) {
  const defaults = cloneStepParameters(bakana.analysisDefaults());

  if (defaults?.rna_quality_control) {
    defaults.rna_quality_control.mito_threshold = 0.5;
    // Use prefix to identify mitochondrial genes (Human: MT-, Mouse: mt-)
    // For ATAC peaks (chr1:1234-5678), this won't match anything, which is correct
    const genome = loadedData?.info?.genome?.toLowerCase() || '';
    const isMouse = genome.includes('mm') || genome.includes('mouse');
    defaults.rna_quality_control.mito_prefix = isMouse ? 'mt-' : 'MT-';
  }

  return defaults;
}

async function runRnaOnlyAnalysis(state, datasets, params, { startFun = null, finishFun = null, stopAfterStep = null, skipUmap = false } = {}) {
  if (!state) {
    throw new Error('Analysis state unavailable');
  }

  const filteredParams = cloneStepParameters(params);
  const maybeAwait = async (value) => {
    if (value && typeof value.then === 'function') {
      await value;
    }
  };

  const runStep = async (stepName, computeFn) => {
    if (startFun) {
      await startFun(stepName);
    }

    await maybeAwait(computeFn());

    if (finishFun) {
      const stepState = state[stepName];
      if (stepState && stepState.changed) {
        await finishFun(stepName, stepState);
      } else {
        await finishFun(stepName);
      }
    }
  };

  await runStep('inputs', () => state.inputs.compute(datasets, filteredParams.inputs));

  if ('_loaded' in state) {
    state.inputs.changed = true;
    delete state._loaded;
  }

  const preprocessingOrder = [
    'rna_quality_control',
    'cell_filtering',
    'rna_normalization',
    'feature_selection',
    'rna_pca',
    'combine_embeddings',
    'batch_correction',
    'neighbor_index',
  ];

  for (const step of preprocessingOrder) {
    await runStep(step, () => state[step].compute(filteredParams[step]));
    if (stopAfterStep && step === stopAfterStep) {
      return null;
    }
  }

  if (!skipUmap) {
    await runStep('umap', () => state.umap.compute(filteredParams.umap));
  }
  if (stopAfterStep === 'umap') {
    return null;
  }

  const clusteringParams = filteredParams.choose_clustering || {};
  const method = clusteringParams.method || 'snn_graph';

  await runStep('kmeans_cluster', () => state.kmeans_cluster.compute(method === 'kmeans', filteredParams.kmeans_cluster));
  await runStep('snn_graph_cluster', () => state.snn_graph_cluster.compute(method === 'snn_graph', filteredParams.snn_graph_cluster));
  await runStep('choose_clustering', () => state.choose_clustering.compute(clusteringParams));
  await runStep('marker_detection', () => state.marker_detection.compute(filteredParams.marker_detection));

  return null;
}

// Initialize bakana and scran.js
async function ensureAnalysisEngineInitialized() {
  if (analysisEngineReady) {
    return;
  }
  if (!initializationPromise) {
    initializationPromise = initializeAnalysis()
      .then(() => {
        analysisEngineReady = true;
      })
      .catch((error) => {
        initializationPromise = null;
        analysisEngineReady = false;
        throw error;
      });
  }
  await initializationPromise;
}

self.onmessage = async (event) => {
  const { type, ...payload } = event.data;


  try {
    switch (type) {
      case 'INIT':
        await ensureAnalysisEngineInitialized();
        self.postMessage({ type: 'INIT_SUCCESS' });
        break;

      case 'LOAD_DATA': {
        await ensureAnalysisEngineInitialized();
        const matrixFile = payload.files?.matrix;
        if (matrixFile?._chunkKey != null && matrixFile?._matrixSize != null) {
          pendingAtacPayload = payload;
          pendingAtacMatrixData = new Uint8Array(matrixFile._matrixSize);
          pendingAtacReceivedLength = 0;
          break;
        }
        await loadData(payload);
        break;
      }

      case 'ATAC_MATRIX_CHUNK': {
        await ensureAnalysisEngineInitialized();
        if (!pendingAtacPayload || !pendingAtacMatrixData) {
          console.warn('Worker: ATAC_MATRIX_CHUNK received but no pending stream');
          break;
        }
        const { offset, chunk } = payload;
        const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        pendingAtacMatrixData.set(view, offset);
        pendingAtacReceivedLength += view.length;
        const expectedSize = pendingAtacPayload.files?.matrix?._matrixSize ?? 0;
        if (pendingAtacReceivedLength >= expectedSize) {
          const fullPayload = { ...pendingAtacPayload };
          fullPayload.files = { ...fullPayload.files };
          fullPayload.files.matrix = {
            name: fullPayload.files.matrix.name,
            data: pendingAtacMatrixData.buffer,
          };
          pendingAtacPayload = null;
          pendingAtacMatrixData = null;
          pendingAtacReceivedLength = 0;
          await loadData(fullPayload);
        }
        break;
      }

      case 'RUN_ANALYSIS':
        await ensureAnalysisEngineInitialized();
        if (loadedData?.state) {
        }
        await runAnalysis(payload);
        break;

      default:
        console.warn('Unknown message type:', type);
    }
  } catch (error) {
    console.error('Worker error:', error);
    self.postMessage({ 
      type: 'ANALYSIS_ERROR', 
      error: error.message || 'Unknown error occurred' 
    });
  }
};

async function initializeAnalysis() {
  try {
    let nthreads = Math.max(1, Math.round((self.navigator.hardwareConcurrency || 4) * 2 / 3));

    // Whether SharedArrayBuffer is usable (requires crossOriginIsolated).
    // webSecurity:false in Electron can prevent crossOriginIsolated even with COEP headers.
    const canUseSharedMemory = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;

    let scranInitialized = false;

    // Attempt 1: custom SharedArrayBuffer-backed memory (best for large datasets).
    if (canUseSharedMemory) {
      try {
        const pageSize = 64 * 1024;
        const baseBytes = 512 * 1024 * 1024;
        const maxBytes = 4 * 1024 * 1024 * 1024;
        const wasmMemory = new WebAssembly.Memory({
          initial: Math.ceil(baseBytes / pageSize),
          maximum: Math.ceil(maxBytes / pageSize),
          shared: true,
        });
        await scran.initialize({ numberOfThreads: nthreads, wasmMemory, initialMemory: baseBytes, maximumMemory: maxBytes });
        scranInitialized = true;
      } catch (e) {
        console.warn('SharedArrayBuffer scran.js init failed:', e.message);
      }
    }

    // Attempt 2: default multi-threaded (no custom memory).
    if (!scranInitialized) {
      try {
        await scran.initialize({ numberOfThreads: nthreads });
        scranInitialized = true;
      } catch (e) {
        console.warn('Multi-threaded scran.js init failed:', e.message);
      }
    }

    // Attempt 3: single-threaded fallback, always works even without SharedArrayBuffer.
    if (!scranInitialized) {
      nthreads = 1;
      await scran.initialize({ numberOfThreads: 1 });
    }

    await bakana.initialize({ numberOfThreads: nthreads });
    analysisState = await bakana.createAnalysis();
  } catch (error) {
    console.error('Failed to initialize analysis:', error);
    throw error;
  }
}

// Helper class to wrap file data for bakana
class SimpleFile {
  constructor(name, data) {
    this.name_ = name;
    // Ensure data is a Uint8Array
    if (data instanceof Uint8Array) {
      this.data_ = data;
    } else if (data instanceof ArrayBuffer) {
      this.data_ = new Uint8Array(data);
    } else if (Array.isArray(data)) {
      this.data_ = new Uint8Array(data);
    } else if (data && typeof data === 'object' && data.buffer) {
      // Handle typed array views
      this.data_ = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      console.error('Unknown data type for SimpleFile:', typeof data, data);
      throw new Error(`Unknown type '${typeof data}' for SimpleFile constructor`);
    }
  }
  
  name() {
    return this.name_;
  }
  
  size() {
    return this.data_.length;
  }
  
  buffer() {
    return this.data_;
  }
  
  slice(start, end) {
    const sliced = this.data_.slice(start, end);
    return new SimpleFile(this.name_, sliced);
  }
}

function generateIdVariants(identifier) {
  if (identifier === null || typeof identifier === 'undefined') {
    return [];
  }

  let base = identifier.toString().trim();
  if (!base) {
    return [];
  }

  base = base.replace(/^["']|["']$/g, '');

  const variants = new Set();
  const pushVariant = (value) => {
    if (!value) {
      return;
    }
    variants.add(value);
    variants.add(value.toLowerCase());
    variants.add(value.toUpperCase());
  };

  pushVariant(base);

  const dashTrimmed = base.replace(/-[0-9]+$/, '');
  if (dashTrimmed !== base) {
    pushVariant(dashTrimmed);
  }

  const underscoreTrimmed = base.replace(/_[0-9]+$/, '');
  if (underscoreTrimmed !== base) {
    pushVariant(underscoreTrimmed);
  }

  const dotTrimmed = base.replace(/\.[0-9]+$/, '');
  if (dotTrimmed !== base) {
    pushVariant(dotTrimmed);
  }

  return Array.from(variants);
}

/**
 * Convert MERFISH cell ID to a consistent string format.
 * MERFISH files often have large numeric IDs in scientific notation (e.g., 3.686784e+18)
 * which cause precision issues. We use the raw string with a 'c' prefix to avoid this.
 * @param {string|number} rawId: The raw cell ID from the CSV file
 * @returns {string} Consistent string ID with 'c' prefix (e.g., "c3.686784e+18")
 */
function merfishCellIdToString(rawId) {
  if (rawId === null || rawId === undefined || rawId === '') {
    return null;
  }
  // Use the raw string exactly as it appears, with 'c' prefix
  // This avoids floating point precision issues with large scientific notation numbers
  const str = String(rawId).trim().replace(/^["']|["']$/g, '');
  if (!str) {
    return null;
  }
  return 'c' + str;
}

/**
 * Convert numeric cell ID to Visium HD barcode format
 * Input: 2 (from GeoJSON)
 * Output: "cellid_000000002-1" (to match other files)
 */
function numericToBarcodeId(numericId) {
  const padded = String(numericId).padStart(9, '0');
  return `cellid_${padded}-1`;
}

/**
 * Parse spatial coordinates from cells data
 */
async function parseSpatialData(spatialInfo) {
  const { cells, cellSegmentation, analysis, metadata, dataType } = spatialInfo;

  const result = {
    coordinates: null,
    idToCoord: null,
    polygons: null, // For Visium HD cell polygons
    hasPolygons: false,
    precomputed: {
      umap: null,
      clusters: null,
    },
  };

  // For Visium HD: Parse cell segmentation GeoJSON
  if (cellSegmentation && cellSegmentation.data) {
    try {
      const rawBuf = cellSegmentation.data instanceof Uint8Array
        ? cellSegmentation.data
        : new Uint8Array(cellSegmentation.data);
      const jsonText = new TextDecoder().decode(rawBuf);
      const geojson = JSON.parse(jsonText);

      if (geojson && geojson.features && Array.isArray(geojson.features)) {
        const idToCoord = new Map();
        const idToPolygon = new Map();

        for (const feature of geojson.features) {
          if (feature.geometry?.type !== 'Polygon') {
            continue;
          }

          const numericId = feature.properties?.cell_id;
          if (numericId == null) {
            continue;
          }

          // Convert to barcode format for matching with other data
          const cellId = numericToBarcodeId(numericId);

          // Get polygon coordinates (first ring, outer boundary)
          const coordinates = feature.geometry.coordinates[0];
          if (!Array.isArray(coordinates) || coordinates.length < 3) {
            continue;
          }

          // Calculate centroid from polygon
          let sumX = 0;
          let sumY = 0;
          for (const [x, y] of coordinates) {
            sumX += x;
            sumY += y;
          }
          const centroidX = sumX / coordinates.length;
          const centroidY = sumY / coordinates.length;

          // Store centroid for spatial index (points)
          const centroid = [centroidX, centroidY];

          // Generate variants for matching
          const variants = generateIdVariants(cellId);
          for (const variant of variants) {
            idToCoord.set(variant, centroid);
            idToPolygon.set(variant, coordinates);
          }
        }

        result.idToCoord = idToCoord;
        result.polygons = idToPolygon;
        result.hasPolygons = true;
      } else {
        console.warn('Invalid GeoJSON structure in cellSegmentation');
      }
    } catch (error) {
      console.error('Failed to parse cellSegmentation GeoJSON:', error);
    }
  }

  // For Visium HD binned outputs: Parse tissue positions (CSV or parquet)
  if (!result.idToCoord && spatialInfo.tissuePositions && spatialInfo.tissuePositions.data) {
    try {
        const rawBuf = spatialInfo.tissuePositions.data instanceof Uint8Array
          ? spatialInfo.tissuePositions.data
          : new Uint8Array(spatialInfo.tissuePositions.data);

        // Check if it's a parquet file; if so, we can't parse it here
        const parquetMagic = rawBuf.length >= 4 && rawBuf[0] === 0x50 && rawBuf[1] === 0x41 && rawBuf[2] === 0x52 && rawBuf[3] === 0x31;

        if (parquetMagic) {
          // Parse parquet file using hyparquet
          self.postMessage({ type: 'STATUS_UPDATE', message: 'Parsing spatial coordinates from parquet...' });
          try {
            // Load compressors dynamically for ZSTD support
            if (!hyparquetCompressors) {
              const compModule = await import('hyparquet-compressors');
              hyparquetCompressors = compModule.compressors;
            }

            const arrayBuffer = rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength);
            const asyncBuffer = {
              byteLength: arrayBuffer.byteLength,
              slice: (start, end) => Promise.resolve(arrayBuffer.slice(start, end)),
            };

            const parquetData = await new Promise((resolve, reject) => {
              parquetRead({
                file: asyncBuffer,
                compressors: hyparquetCompressors,
                onComplete: (data) => resolve(data),
              }).catch(reject);
            });

            if (parquetData && parquetData.length > 0) {
              const columns = Object.keys(parquetData[0]);

              let barcodeCol = columns.find(c => /barcode/i.test(c));
              let xCol = columns.find(c => /pxl_col/i.test(c));
              let yCol = columns.find(c => /pxl_row/i.test(c));

              // Visium HD binned_output (without segmented_output) uses numeric column names:
              // "0"=barcode, "1","2","3"=bin indices, "4"=y, "5"=x (swap: column 4 as y, 5 as x)
              if (!barcodeCol || !xCol || !yCol) {
                const allNumeric = columns.length > 0 && columns.every(c => /^\d+$/.test(String(c)));
                if (allNumeric && columns.length >= 6 && columns.includes('0') && columns.includes('4') && columns.includes('5')) {
                  const first = parquetData[0];
                  const col4 = parseFloat(first['4']);
                  const col5 = parseFloat(first['5']);
                  if (first['0'] != null && !isNaN(col4) && !isNaN(col5)) {
                    barcodeCol = '0';
                    xCol = '5';  // Column 5 becomes x
                    yCol = '4';  // Column 4 becomes y
                  }
                }
              }


              if (barcodeCol && xCol && yCol) {
                const idToCoord = new Map();
                for (const row of parquetData) {
                  const barcode = row[barcodeCol];
                  const x = parseFloat(row[xCol]);
                  const y = parseFloat(row[yCol]);

                  if (barcode != null && barcode !== '' && !isNaN(x) && !isNaN(y)) {
                    const barcodeStr = String(barcode);
                    // Visium HD: coordPair is [x, y]; xCol/yCol mapping already swapped above
                    const coordPair = [x, y];
                    idToCoord.set(barcodeStr, coordPair);
                    const dashIdx = barcodeStr.lastIndexOf('-');
                    if (dashIdx > 0) {
                      idToCoord.set(barcodeStr.substring(0, dashIdx), coordPair);
                    }
                  }
                }

                result.idToCoord = idToCoord;
                result.hasPolygons = false;
              } else {
                console.warn('Could not find expected columns in parquet. Columns:', columns);
              }
            }
          } catch (parquetErr) {
            console.error('Failed to parse parquet with hyparquet:', parquetErr);
          }
        } else {
          // Assume CSV format
          const csvText = new TextDecoder().decode(rawBuf);
        const lines = csvText.trim().split('\n');

        if (lines.length > 1) {
          const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));

          // Look for barcode and coordinate columns
          // Common column names: barcode, pxl_row_in_fullres, pxl_col_in_fullres, array_row, array_col
          const barcodeIdx = headers.findIndex(h => /^(barcode|cell_id|id)$/i.test(h));
          let xIdx = headers.findIndex(h => /^(pxl_col_in_fullres|x_centroid|x|col)$/i.test(h));
          let yIdx = headers.findIndex(h => /^(pxl_row_in_fullres|y_centroid|y|row)$/i.test(h));

          // Fallback to array coordinates if pixel coordinates not found
          if (xIdx < 0) xIdx = headers.findIndex(h => /^array_col$/i.test(h));
          if (yIdx < 0) yIdx = headers.findIndex(h => /^array_row$/i.test(h));


          if (barcodeIdx >= 0 && xIdx >= 0 && yIdx >= 0) {
            const idToCoord = new Map();
            for (let i = 1; i < lines.length; i++) {
              const values = lines[i].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
              if (values.length > Math.max(barcodeIdx, xIdx, yIdx)) {
                const barcode = values[barcodeIdx];
                const x = parseFloat(values[xIdx]);
                const y = parseFloat(values[yIdx]);

                if (barcode && !isNaN(x) && !isNaN(y)) {
                  const coords = [x, y];
                  const variants = generateIdVariants(barcode);
                  for (const variant of variants) {
                    idToCoord.set(variant, coords);
                  }
                }
              }
            }

            result.idToCoord = idToCoord;
            result.hasPolygons = false; // Binned data doesn't have polygons
          } else {
            console.warn('Could not find expected columns in tissue positions file. Headers:', headers);
          }
        }
      }
    } catch (error) {
      console.error('Failed to parse tissue positions:', error);
    }
  }

  // For Visium HD binned outputs: barcode_mappings.parquet as fallback
  // (This is rarely used; tissuePositions is usually available)
  if (!result.idToCoord && spatialInfo.barcodeMappings && spatialInfo.barcodeMappings.data) {
    console.warn('barcodeMappings parsing not implemented - use tissuePositions instead');
  }

  // For Xenium: Parse cells CSV for spatial coordinates (build id -> coord map)
  if (!result.idToCoord && cells && cells.data) {
    try {
      const rawBuf = cells.data instanceof Uint8Array ? cells.data : new Uint8Array(cells.data);
      const parquetMagic = rawBuf.length >= 4 && rawBuf[0] === 0x50 && rawBuf[1] === 0x41 && rawBuf[2] === 0x52 && rawBuf[3] === 0x31; // 'PAR1'
      if (parquetMagic) {
        console.warn('Cells file appears to be Parquet; skipping spatial coordinate parse (need parquet reader).');
      } else {
        let cellsText = null;
        try {
          cellsText = new TextDecoder().decode(rawBuf);
        } catch (e) {
          console.warn('Failed to decode cells data as UTF-8, skipping spatial parse:', e.message);
        }
        if (cellsText) {
          const lines = cellsText.trim().split('\n');
          if (lines.length > 1) {
            // Strip quotes from headers if present
            const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
            // Try to detect x/y centroid columns with several common variants.
            let xIdx = headers.findIndex(h => /^(x(_?(centroid|center|um|px|coordinate|coord|pos|position))?|.*_x)$/i.test(h));
            let yIdx = headers.findIndex(h => /^(y(_?(centroid|center|um|px|coordinate|coord|pos|position))?|.*_y)$/i.test(h));
            if (xIdx < 0) xIdx = headers.findIndex(h => /^x$/i.test(h));
            if (yIdx < 0) yIdx = headers.findIndex(h => /^y$/i.test(h));
            const idIdx = headers.findIndex(h => /^(cell_id|barcode|cell|id)$/i.test(h));
            if (xIdx >= 0 && yIdx >= 0) {
              const idToCoord = new Map();
              for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
                if (values.length > Math.max(xIdx, yIdx)) {
                  const x = parseFloat(values[xIdx]);
                  const y = parseFloat(values[yIdx]);
                  if (!isNaN(x) && !isNaN(y)) {
                    const rawId = idIdx >= 0 ? values[idIdx] : String(i - 1);
                    const coords = [x, y];
                    const variants = generateIdVariants(rawId);
                    if (variants.length === 0) {
                      variants.push(String(i - 1));
                    }
                    for (const variant of variants) {
                      idToCoord.set(variant, coords);
                    }
                  }
                }
              }
              result.idToCoord = idToCoord;
            } else {
              console.warn('Could not find expected x/y centroid headers in cells file; headers:', headers);
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to parse cells data:', error);
    }
  } else {
    console.warn('No cells data provided to parseSpatialData');
  }

  // Parse UMAP from analysis
  if (analysis && analysis.umap) {
    try {
      const umapKeys = Object.keys(analysis.umap);
      if (umapKeys.length > 0) {
        const umapFile = analysis.umap[umapKeys[0]];
        const umapText = new TextDecoder().decode(umapFile.data);
        const lines = umapText.trim().split('\n');

        if (lines.length > 1) {
          const headers = lines[0].split(',').map(h => h.trim());
          // Look for UMAP-1 and UMAP-2 columns
          let umap1Idx = headers.findIndex(h => h === 'UMAP-1' || h === 'umap_1' || h === '0');
          let umap2Idx = headers.findIndex(h => h === 'UMAP-2' || h === 'umap_2' || h === '1');

          // If not found, try second and third columns (first is usually cell ID)
          if (umap1Idx < 0) umap1Idx = 1;
          if (umap2Idx < 0) umap2Idx = 2;

          const idIdx = headers.findIndex(h => /^(cell_id|barcode|cell|id)$/i.test(h));

          const umapMap = new Map();
          for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',');
            if (values.length > Math.max(umap1Idx, umap2Idx)) {
              const u1 = parseFloat(values[umap1Idx]);
              const u2 = parseFloat(values[umap2Idx]);
              if (!isNaN(u1) && !isNaN(u2)) {
                const cellId = idIdx >= 0 ? values[idIdx].trim().replace(/^["']|["']$/g, '') : String(i - 1);
                const variants = generateIdVariants(cellId);
                const coordPair = [u1, u2];
                if (variants.length === 0) {
                  umapMap.set(cellId, coordPair);
                } else {
                  for (const variant of variants) {
                    umapMap.set(variant, coordPair);
                  }
                }
              }
            }
          }

          if (umapMap.size > 0) {
            result.precomputed.umap = {
              map: umapMap,
            };
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse UMAP data:', error);
    }
  }

  // Parse clustering from analysis
  if (analysis && analysis.clusters && analysis.clusters.data) {
    try {
      const clusterText = new TextDecoder().decode(analysis.clusters.data);
      const lines = clusterText.trim().split('\n');
      if (lines.length > 1) {
        const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
        const idIdx = headers.findIndex(h => /^(cell_id|barcode|cell|id)$/i.test(h));
        let clusterIdx = headers.findIndex(h => /^cluster/i.test(h) || /^group/i.test(h) || /^assignment/i.test(h));
        if (clusterIdx < 0) {
          clusterIdx = 1;
        }

        const clusterMap = new Map();
        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
          if (values.length > Math.max(idIdx, clusterIdx)) {
            const cellId = idIdx >= 0 ? values[idIdx] : String(i - 1);
            const clusterValue = values[clusterIdx];
            const variants = generateIdVariants(cellId);
            if (variants.length === 0) {
              clusterMap.set(cellId, clusterValue);
            } else {
              for (const variant of variants) {
                clusterMap.set(variant, clusterValue);
              }
            }
          }
        }

        if (clusterMap.size > 0) {
          result.precomputed.clusters = {
            map: clusterMap,
          };
        }
      }
    } catch (error) {
      console.warn('Failed to parse clustering data:', error);
    }
  }

  return result;
}

function alignSpatialArtifacts(spatialData, barcodes) {
  if (!spatialData || !Array.isArray(barcodes) || !barcodes.length) {
    return {
      coordinates: null,
      clusters: null,
      umap: null,
      matched: 0,
      unmatchedExamples: [],
    };
  }

  const len = barcodes.length;
  const coordinates = new Array(len).fill(null);
  const unmatchedExamples = [];
  let matched = 0;

  if (spatialData.idToCoord instanceof Map) {
    for (let i = 0; i < len; i += 1) {
      const barcode = barcodes[i];
      if (barcode == null) {
        coordinates[i] = null;
        continue;
      }
      let coord = spatialData.idToCoord.get(barcode);
      if (!coord) {
        const variants = generateIdVariants(barcode);
        for (const variant of variants) {
          coord = spatialData.idToCoord.get(variant);
          if (coord) {
            break;
          }
        }
      }
      if (coord) {
        coordinates[i] = coord;
        matched += 1;
      } else if (unmatchedExamples.length < 5) {
        unmatchedExamples.push(String(barcode));
      }
    }
  }

  let clusters = null;
  const clusterMap = spatialData.precomputed?.clusters?.map;
  if (clusterMap instanceof Map) {
    clusters = new Array(len).fill(null);
    for (let i = 0; i < len; i += 1) {
      const barcode = barcodes[i];
      if (barcode == null) {
        continue;
      }
      let cluster = clusterMap.get(barcode);
      if (!cluster) {
        const variants = generateIdVariants(barcode);
        for (const variant of variants) {
          cluster = clusterMap.get(variant);
          if (cluster) {
            break;
          }
        }
      }
      clusters[i] = cluster ?? null;
    }
  }

  let umap = null;
  const umapMap = spatialData.precomputed?.umap?.map;
  if (umapMap instanceof Map) {
    umap = new Array(len).fill(null);
    let umapMatched = 0;
    let umapUnmatched = [];
    for (let i = 0; i < len; i += 1) {
      const barcode = barcodes[i];
      if (barcode == null) {
        continue;
      }
      let coords = umapMap.get(barcode);
      if (!coords) {
        const variants = generateIdVariants(barcode);
        for (const variant of variants) {
          coords = umapMap.get(variant);
          if (coords) {
            break;
          }
        }
      }
      if (coords) {
        umap[i] = [coords[0], coords[1]];
        umapMatched++;
      } else {
        umap[i] = null;
        if (umapUnmatched.length < 5) {
          umapUnmatched.push(barcode);
        }
      }
    }
    if (umapUnmatched.length > 0) {
    }
  }

  // Align polygon data for Visium HD if available
  let polygons = null;
  if (spatialData.polygons instanceof Map) {
    polygons = new Array(len).fill(null);
    for (let i = 0; i < len; i += 1) {
      const barcode = barcodes[i];
      if (barcode == null) {
        continue;
      }
      let polygon = spatialData.polygons.get(barcode);
      if (!polygon) {
        const variants = generateIdVariants(barcode);
        for (const variant of variants) {
          polygon = spatialData.polygons.get(variant);
          if (polygon) {
            break;
          }
        }
      }
      polygons[i] = polygon ?? null;
    }
  }

  return {
    coordinates,
    clusters,
    umap,
    polygons,
    hasPolygons: spatialData.hasPolygons || false,
    matched,
    unmatchedExamples,
  };
}

/**
 * Realign precomputed UMAP and cluster artifacts to match the filtered cell order after normalization.
 * This is critical for preloaded Xenium data: the original precomputed UMAP/clusters are aligned to
 * the original cell barcode order, but after cell_filtering.compute(), the expression matrix is indexed
 * by the filtered cells. We must realign the precomputed artifacts to match.
 */
async function realignPrecomputedArtifactsAfterFiltering(analysisState, { suppressBroadcast = false } = {}) {
  if (!loadedData || !loadedData.precomputed) {
    return;
  }

  const precomputedUmap = loadedData.precomputed.umap;
  const precomputedClusters = loadedData.precomputed.clusters;

  if (!Array.isArray(precomputedUmap) && !Array.isArray(precomputedClusters)) {
    return;
  }

  // Get the spatial data which contains the precomputed Maps (keyed by cell ID)
  const workingSpatial = loadedData.spatialData;
  if (!workingSpatial || !workingSpatial.precomputed) {
    return;
  }

  const umapMap = workingSpatial.precomputed.umap?.map;
  const clusterMap = workingSpatial.precomputed.clusters?.map;

  if (!(umapMap instanceof Map) && !(clusterMap instanceof Map)) {
    return;
  }

  // Determine the number of filtered cells from the normalized matrix
  let nFilteredCells = 0;
  try {
    const normMatrix = analysisState.rna_normalization.fetchNormalizedMatrix();
    nFilteredCells = normMatrix.numberOfColumns ? normMatrix.numberOfColumns() :
                     (normMatrix.ncol ? normMatrix.ncol() : 0);
  } catch (e) {
    console.warn('Could not determine filtered cell count from normalized matrix:', e.message);
    return;
  }

  if (nFilteredCells === 0) {
    console.warn('Zero filtered cells detected; skipping realignment');
    return;
  }

  // Get ordered barcodes for the filtered cells
  let orderedBarcodes = null;

  // First, try to get barcodes from annotations (this is the most reliable method)
  try {
    const annotations = analysisState.inputs.fetchCellAnnotations();
    orderedBarcodes = extractOrderedBarcodesFromAnnotations(annotations, nFilteredCells);
    if (orderedBarcodes) {
    }
  } catch (annotationError) {
    console.warn('Failed to derive filtered barcodes from annotations:', annotationError.message);
  }

  // Second, try to reconstruct from filter keep mask
  if (!orderedBarcodes && loadedData.cellBarcodes && Array.isArray(loadedData.cellBarcodes)) {
    try {
      const filterState = analysisState.cell_filtering;
      let keptIndices = null;
      if (filterState && typeof filterState.fetchKeep === 'function') {
        const keepResult = filterState.fetchKeep();
        if (keepResult) {
          let mask = null;
          if (typeof keepResult.array === 'function') {
            mask = keepResult.array();
          } else if (typeof keepResult.toArray === 'function') {
            mask = keepResult.toArray();
          } else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) {
            mask = keepResult;
          } else if (typeof keepResult.length === 'number') {
            mask = Array.from({ length: keepResult.length }, (_, idx) => keepResult[idx]);
          }

          if (mask && typeof mask.length === 'number') {
            keptIndices = [];
            for (let i = 0; i < mask.length; i++) {
              const raw = Array.isArray(mask[i]) ? mask[i][0] : mask[i];
              const keepFlag = typeof raw === 'number' ? raw !== 0 : !!raw;
              if (keepFlag) {
                keptIndices.push(i);
              }
            }
          }
        }
      }

      if (Array.isArray(keptIndices) && keptIndices.length > 0) {
        orderedBarcodes = keptIndices.map((idx) => loadedData.cellBarcodes[idx]);
      }
    } catch (filterError) {
      console.warn('Failed to reconstruct filtered barcodes from filter state:', filterError.message);
    }
  }

  // Fall back to assuming no filtering (all cells kept in original order)
  if (!orderedBarcodes && loadedData.cellBarcodes && Array.isArray(loadedData.cellBarcodes)) {
    if (loadedData.cellBarcodes.length === nFilteredCells) {
      orderedBarcodes = loadedData.cellBarcodes;
    } else {
      console.warn('Barcode count mismatch; unable to realign precomputed artifacts');
      return;
    }
  }

  if (!orderedBarcodes || orderedBarcodes.length === 0) {
    console.warn('Unable to determine ordered barcodes for precomputed artifact realignment');
    return;
  }

  // Adjust barcode array length to match filtered cell count
  if (orderedBarcodes.length !== nFilteredCells) {
    console.warn(`Ordered barcode length (${orderedBarcodes.length}) does not match filtered cell count (${nFilteredCells})`);
    if (orderedBarcodes.length > nFilteredCells) {
      orderedBarcodes = orderedBarcodes.slice(0, nFilteredCells);
    } else {
      orderedBarcodes = orderedBarcodes.concat(
        Array.from({ length: nFilteredCells - orderedBarcodes.length }, () => null)
      );
    }
  }

  // Realign the precomputed UMAP coordinates
  let realignedUmap = null;
  if (umapMap instanceof Map) {
    realignedUmap = new Array(nFilteredCells).fill(null);
    let umapMatched = 0;
    for (let i = 0; i < orderedBarcodes.length; i++) {
      const barcode = orderedBarcodes[i];
      if (barcode == null) continue;

      let coords = umapMap.get(barcode);
      if (!coords) {
        const variants = generateIdVariants(barcode);
        for (const variant of variants) {
          coords = umapMap.get(variant);
          if (coords) break;
        }
      }
      if (coords) {
        realignedUmap[i] = [coords[0], coords[1]];
        umapMatched++;
      }
    }
  }

  // Realign the precomputed clusters
  let realignedClusters = null;
  if (clusterMap instanceof Map) {
    realignedClusters = new Array(nFilteredCells).fill(null);
    let clusterMatched = 0;
    for (let i = 0; i < orderedBarcodes.length; i++) {
      const barcode = orderedBarcodes[i];
      if (barcode == null) continue;

      let cluster = clusterMap.get(barcode);
      if (cluster === undefined) {
        const variants = generateIdVariants(barcode);
        for (const variant of variants) {
          cluster = clusterMap.get(variant);
          if (cluster !== undefined) break;
        }
      }
      if (cluster !== undefined && cluster !== null) {
        realignedClusters[i] = cluster;
        clusterMatched++;
      }
    }
  }

  // Also realign spatial coordinates
  let realignedSpatial = null;
  if (workingSpatial.idToCoord instanceof Map) {
    const resolved = mapBarcodesToCoordinates(workingSpatial, orderedBarcodes);
    realignedSpatial = resolved.coordinates;
  }

  // Update the precomputed artifacts in loadedData
  if (realignedUmap) {
    loadedData.precomputed.umap = realignedUmap;
    currentResults.umap = realignedUmap;
  }
  if (realignedClusters) {
    loadedData.precomputed.clusters = realignedClusters;
    currentResults.clusters = realignedClusters;
  }
  if (realignedSpatial) {
    workingSpatial.coordinates = realignedSpatial;
    loadedData.spatialData = workingSpatial;
  }


  // Broadcast the updated UMAP/clusters to UI so the display is consistent.
  // Suppressed when a sketch pipeline will run immediately after (sketch sends its own broadcast).
  if (!suppressBroadcast) {
    if (realignedUmap) {
      let nClusters = 0;
      if (realignedClusters) {
        const clusterSet = new Set(realignedClusters.filter((v) => v !== null && v !== undefined));
        nClusters = clusterSet.size;
      }

      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: realignedUmap,
          clusters: realignedClusters,
          nClusters,
          nCells: realignedUmap.length,
          source: 'precomputed',
          realigned: true,
        },
      });
    }

    // Also broadcast updated spatial coordinates if they changed
    if (realignedSpatial) {
      self.postMessage({
        type: 'DATA_LOADED',
        data: {
          path: loadedData.path,
          cells: nFilteredCells,
          genes: loadedData.nGenes || 0,
          rawCells: loadedData.rawCells || nFilteredCells,
          rawGenes: loadedData.rawGenes || loadedData.nGenes || 0,
          spatialCoordinates: realignedSpatial,
          modality: 'spatial',
          reason: 'post-normalization-realignment',
        },
      });
    }
  } else {
  }
}

function extractOrderedBarcodesFromAnnotations(annotations, expectedLength) {
  if (!annotations || !Number.isFinite(expectedLength) || expectedLength <= 0) {
    return null;
  }

  const tryNormalize = (input) => {
    if (!input || typeof input.length !== 'number') {
      return null;
    }
    if (input.length !== expectedLength) {
      return null;
    }
    return Array.from(input);
  };

  let candidates = null;
  if (typeof annotations.rowNames === 'function') {
    const rows = annotations.rowNames();
    candidates = tryNormalize(rows);
    if (candidates) {
      return candidates;
    }
  }

  if (typeof annotations.columnNames === 'function' && typeof annotations.column === 'function') {
    const columnNames = annotations.columnNames();
    const preferred = ['cell_id', 'barcode', 'Barcode', 'cell', 'id', 'CellID'];
    for (const name of preferred) {
      if (columnNames.includes(name)) {
        const column = annotations.column(name);
        candidates = tryNormalize(column);
        if (candidates) {
          return candidates;
        }
      }
    }
    if (!candidates && columnNames.length) {
      const fallbackColumn = annotations.column(columnNames[0]);
      candidates = tryNormalize(fallbackColumn);
      if (candidates) {
        return candidates;
      }
    }
  }

  return null;
}

function mapBarcodesToCoordinates(spatialSource, orderedBarcodes, { allowLooseVariants = true } = {}) {
  if (!spatialSource || !(spatialSource.idToCoord instanceof Map) || !Array.isArray(orderedBarcodes)) {
    return {
      coordinates: null,
      matched: 0,
      unmatchedExamples: [],
    };
  }

  const coordinates = new Array(orderedBarcodes.length).fill(null);
  const unmatchedExamples = [];
  let matched = 0;

  for (let i = 0; i < orderedBarcodes.length; i += 1) {
    const rawBarcode = orderedBarcodes[i];
    if (rawBarcode == null) {
      continue;
    }

    let coord = null;
    const normalized = String(rawBarcode).trim().replace(/^["']|["']$/g, '');
    if (normalized) {
      coord = spatialSource.idToCoord.get(normalized) || null;
    }
    if (!coord && allowLooseVariants) {
      const variants = generateIdVariants(rawBarcode);
      if (!variants.length) {
        variants.push(String(rawBarcode));
      }
      for (const variant of variants) {
        coord = spatialSource.idToCoord.get(variant);
        if (coord) {
          break;
        }
      }
    }

    if (coord) {
      coordinates[i] = coord;
      matched += 1;
    } else if (unmatchedExamples.length < 5) {
      unmatchedExamples.push(String(rawBarcode));
    }
  }

  return {
    coordinates,
    matched,
    unmatchedExamples,
  };
}

function validateRestoredSpatialClusterConsistency({
  context = '',
  orderedBarcodes = null,
  clusters = null,
  resolved = null,
}) {
  const total = Array.isArray(orderedBarcodes) ? orderedBarcodes.length : 0;
  if (!total || !Array.isArray(clusters) || !resolved || !Array.isArray(resolved.coordinates)) {
    return;
  }

  const n = Math.min(total, clusters.length, resolved.coordinates.length);
  let missingCoords = 0;
  let missingClusters = 0;
  let validPairs = 0;
  const sampleMissingCoords = [];
  const sampleMissingClusters = [];

  for (let i = 0; i < n; i += 1) {
    const bc = orderedBarcodes[i];
    const coord = resolved.coordinates[i];
    const cl = clusters[i];
    const hasCoord = Array.isArray(coord) && Number.isFinite(coord[0]) && Number.isFinite(coord[1]);
    const hasCluster = cl !== null && cl !== undefined && Number.isFinite(cl);

    if (!hasCoord) {
      missingCoords += 1;
      if (sampleMissingCoords.length < 5) {
        sampleMissingCoords.push(String(bc));
      }
    }
    if (!hasCluster) {
      missingClusters += 1;
      if (sampleMissingClusters.length < 5) {
        sampleMissingClusters.push(String(bc));
      }
    }
    if (hasCoord && hasCluster) {
      validPairs += 1;
    }
  }

  const coordCoverage = n > 0 ? (100 * (n - missingCoords) / n).toFixed(2) : '0.00';
  const pairCoverage = n > 0 ? (100 * validPairs / n).toFixed(2) : '0.00';

  if (sampleMissingCoords.length) {
  }
  if (sampleMissingClusters.length) {
  }
}

function alignExpressionToTargetBarcodes(expressionValues, sourceBarcodes, targetBarcodes) {
  if (!Array.isArray(sourceBarcodes) || !Array.isArray(targetBarcodes)) {
    return null;
  }
  if (expressionValues.length !== sourceBarcodes.length || targetBarcodes.length === 0) {
    return null;
  }

  const indexMap = new Map();
  for (let i = 0; i < sourceBarcodes.length; i += 1) {
    const raw = sourceBarcodes[i];
    if (raw == null) continue;
    const normalized = String(raw).trim().replace(/^["']|["']$/g, '');
    if (!normalized) continue;
    if (!indexMap.has(normalized)) indexMap.set(normalized, i);
  }

  const aligned = new Float32Array(targetBarcodes.length);
  let matched = 0;
  const sampleUnmatched = [];
  for (let i = 0; i < targetBarcodes.length; i += 1) {
    const target = targetBarcodes[i];
    if (target == null) continue;
    const variants = generateIdVariants(target);
    let srcIdx = null;
    for (const key of variants) {
      if (indexMap.has(key)) {
        srcIdx = indexMap.get(key);
        break;
      }
    }
    if (srcIdx != null) {
      aligned[i] = expressionValues[srcIdx];
      matched += 1;
    } else if (sampleUnmatched.length < 5) {
      sampleUnmatched.push(String(target));
    }
  }

  return { aligned, matched, sampleUnmatched };
}

function makeCoordKey(coord) {
  if (!Array.isArray(coord)) return null;
  const x = Number(coord[0]);
  const y = Number(coord[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return `${x.toFixed(4)}|${y.toFixed(4)}`;
}

function getDataFrameRowCount(df) {
  if (!df) {
    return 0;
  }
  if (typeof df.numberOfRows === 'function') {
    return df.numberOfRows();
  }
  if (typeof df.shape === 'object' && Array.isArray(df.shape) && df.shape.length > 0) {
    return df.shape[0];
  }
  if (typeof df.nrows === 'function') {
    return df.nrows();
  }
  if (typeof df.nrows === 'number') {
    return df.nrows;
  }
  if (Array.isArray(df)) {
    return df.length;
  }
  if (typeof df.length === 'number') {
    return df.length;
  }
  return 0;
}

async function finalizePrecomputedSpatialLoad({
  path,
  info,
  spatialData,
  barcodes,
  nCells,
  nGenes,
}) {
  const aligned = alignSpatialArtifacts(spatialData, Array.isArray(barcodes) ? barcodes : []);
  const resolvedNCells = nCells || (Array.isArray(aligned.umap) ? aligned.umap.length : (Array.isArray(barcodes) ? barcodes.length : 0));
  const resolvedNGenes = nGenes || loadedData?.nGenes || 0;

  if (spatialData) {
    spatialData.coordinates = aligned.coordinates;
    spatialData.alignedPolygons = aligned.polygons;
    if (!spatialData.precomputed) {
      spatialData.precomputed = {};
    }
    spatialData.precomputed.alignedUmap = aligned.umap;
    spatialData.precomputed.alignedClusters = aligned.clusters;
  }

  if (loadedData) {
    loadedData.nCells = resolvedNCells;
    loadedData.nGenes = resolvedNGenes;
    loadedData.rawCells = resolvedNCells;
    loadedData.rawGenes = resolvedNGenes;
    loadedData.precomputed = {
      umap: aligned.umap,
      clusters: aligned.clusters,
    };
    loadedData.spatialData = spatialData;
    loadedData.hasPolygons = aligned.hasPolygons;

    // For spatial data, automatically run normalization so gene plotting works immediately
    // We'll run normalization in the background without blocking the UI
    if (loadedData.dataset) {
      // Run normalization asynchronously; don't await, let it run in background
      runNormalizationForPrecomputedData().catch(error => {
        console.error('Failed to normalize spatial data:', error);
        // Don't throw; normalization failure shouldn't block data loading
      });
    } else {
      loadedData.state = null;
    }
  }

  // Build DATA_LOADED payload
  const dataLoadedPayload = {
    path,
    cells: resolvedNCells,
    genes: resolvedNGenes,
    rawCells: resolvedNCells,
    rawGenes: resolvedNGenes,
    spatialCoordinates: aligned.coordinates,
    modality: info?.modality || 'spatial',
  };

  // Add polygon data for Visium HD
  if (aligned.hasPolygons && aligned.polygons) {
    dataLoadedPayload.hasPolygons = true;
    dataLoadedPayload.polygons = aligned.polygons;
  }

  self.postMessage({
    type: 'DATA_LOADED',
    data: dataLoadedPayload,
  });

  if (Array.isArray(aligned.umap)) {
    const umapCoords = aligned.umap.map((coord) => (Array.isArray(coord) ? coord : [NaN, NaN]));
    const clusterArray = Array.isArray(aligned.clusters) ? aligned.clusters : null;
    let nClusters = 0;
    if (clusterArray) {
      const clusterSet = new Set(clusterArray.filter((value) => value !== null && value !== undefined));
      nClusters = clusterSet.size;
    }

    currentResults.umap = umapCoords;
    currentResults.clusters = clusterArray;

    // Restore previous results (cluster labels/colors, region data) if available
    const prevResults = loadedData?.previousResults;
    const msg = {
      type: 'umap',
      coordinates: umapCoords,
      clusters: clusterArray,
      nClusters,
      nCells: umapCoords.length,
      source: 'precomputed',
    };
    if (prevResults) {
      if (prevResults.clusterLabelMap && Object.keys(prevResults.clusterLabelMap).length > 0) {
        msg.restoredClusterLabelMap = prevResults.clusterLabelMap;
      }
      if (prevResults.clusterColorOverrides && Object.keys(prevResults.clusterColorOverrides).length > 0) {
        msg.restoredClusterColorOverrides = prevResults.clusterColorOverrides;
      }
      if (prevResults.regionClusters?.length > 0) {
        currentResults.regionClusters = prevResults.regionClusters;
        msg.restoredRegionData = {
          regionClusters: prevResults.regionClusters,
          coordinates: prevResults.regionCoordinates || umapCoords,
          regionNclusters: prevResults.regionNclusters || new Set(prevResults.regionClusters.filter(r => r >= 0)).size,
          regionSpatialCoordinates: prevResults.regionSpatialCoordinates,
          regionBanksyParams: prevResults.regionBanksyParams,
          regionLabelMap: prevResults.regionLabelMap || {},
        };
      }
      // Restore SpaGE-imputed gene arrays into imputedGeneCache so violin/dot plots work immediately.
      // imputedGenes is stored as { [geneLower]: number[] } in the JSON; convert back to Float32Array.
      if (prevResults.imputedGenes && typeof prevResults.imputedGenes === 'object') {
        for (const [key, arr] of Object.entries(prevResults.imputedGenes)) {
          if (Array.isArray(arr) && arr.length > 0) {
            imputedGeneCache.set(key, new Float32Array(arr));
          }
        }
        const restored = Object.keys(prevResults.imputedGenes);
        if (restored.length > 0) {
        }
      }
      loadedData.previousResults = null;
    }

    self.postMessage({ type: 'ANALYSIS_COMPLETE', data: msg });
  } else {
    console.warn('Precomputed UMAP coordinates not available; skipping ANALYSIS_COMPLETE broadcast.');
  }
}

async function runNormalizationForPrecomputedData() {
  if (!loadedData || !loadedData.dataset) {
    console.warn('Cannot run normalization: dataset not available');
    return;
  }

  self.postMessage({
    type: 'STATUS_UPDATE',
    message: 'Normalizing count matrix for gene expression...'
  });

  try {
    const dataset = loadedData.dataset;
    const info = loadedData.info || {};
    const isSpatialModality = info?.modality === 'spatial';

    // Build parameters with minimal settings for faster normalization
    const baseParams = buildDefaultParameters({ fastMode: isSpatialModality });

    // For precomputed data, use very permissive quality control to avoid filtering out cells
    // The parameters go in rna_quality_control, not cell_filtering
    if (!baseParams.rna_quality_control) {
      baseParams.rna_quality_control = {};
    }
    // Set permissive thresholds to avoid filtering cells
    baseParams.rna_quality_control.filter_strategy = 'manual';
    baseParams.rna_quality_control.detected_threshold = 0;
    baseParams.rna_quality_control.sum_threshold = 0;

    // Free existing analysis state if any
    if (analysisState && typeof analysisState.free === 'function') {
      try {
        await analysisState.free();
      } catch (freeError) {
        console.warn('Unable to free previous analysis state:', freeError);
      }
    }

    // Create analysis state
    analysisState = await bakana.createAnalysis();

    // Helper to run a single step
    const runStep = async (stepName, computeFn) => {
      if (stepName === 'rna_normalization') {
        self.postMessage({
          type: 'STATUS_UPDATE',
          message: 'Normalizing gene expression data...',
        });
      }

      await computeFn();

      if (stepName === 'rna_normalization') {
        self.postMessage({
          type: 'STATUS_UPDATE',
          message: 'Normalization complete - gene expression plotting ready',
        });
      }
    };

    // Run ONLY the steps needed for normalization (NO UMAP, NO CLUSTERING)
    await runStep('inputs', () => analysisState.inputs.compute({ sample: dataset }, baseParams.inputs));
    await runStep('rna_quality_control', () => analysisState.rna_quality_control.compute(baseParams.rna_quality_control));
    await runStep('cell_filtering', () => analysisState.cell_filtering.compute(baseParams.cell_filtering));
    await runStep('rna_normalization', () => analysisState.rna_normalization.compute(baseParams.rna_normalization));

    // CRITICAL: After cell filtering, realign precomputed UMAP and clusters to match filtered cell order
    // The expression matrix from rna_normalization is indexed by filtered cells, so we must align
    // the precomputed UMAP/clusters to the same order for gene expression plotting to work correctly.
    await realignPrecomputedArtifactsAfterFiltering(analysisState);

    // Store the analysis state
    loadedData.state = analysisState;
    currentParameters = baseParams;


    // Verify the normalized matrix is accessible
    try {
      const normState = analysisState.rna_normalization;
      if (normState && typeof normState.fetchNormalizedMatrix === 'function') {
      } else {
        console.warn('⚠ Normalized matrix may not be accessible');
      }
    } catch (verifyError) {
      console.warn('⚠ Could not verify normalized matrix:', verifyError);
    }

  } catch (error) {
    console.error('Normalization failed:', error);
    console.error('Error details:', error.stack);
    // Don't throw; let the user know but don't block
    self.postMessage({
      type: 'STATUS_UPDATE',
      message: 'Normalization failed - gene plotting may not work until analysis completes',
    });
  }
}

/**
 * Background normalization for multiome data with precomputed UMAPs.
 * Same pattern as Xenium's runNormalizationForPrecomputedData():
 *   inputs → rna_quality_control → cell_filtering → rna_normalization
 * Then realigns RNA + ATAC UMAPs to the filtered barcode order and broadcasts updated coordinates.
 */
async function runMultiomeNormalizationAsync(infoCellBarcodes, rnaUmapParsed, atacUmapParsed, rnaClustersParsed, atacClustersParsed) {
  if (!loadedData || !loadedData.dataset) {
    console.warn('Cannot run multiome normalization: dataset not available');
    return;
  }

  self.postMessage({
    type: 'STATUS_UPDATE',
    message: 'Normalizing count matrix for gene expression...',
  });

  try {
    const dataset = loadedData.dataset;
    const baseParams = buildDefaultParameters({ fastMode: false });

    // Permissive QC thresholds (same as Xenium) to minimize cell filtering
    if (!baseParams.rna_quality_control) {
      baseParams.rna_quality_control = {};
    }
    baseParams.rna_quality_control.filter_strategy = 'manual';
    baseParams.rna_quality_control.detected_threshold = 0;
    baseParams.rna_quality_control.sum_threshold = 0;

    // Free existing analysis state if any
    if (analysisState && typeof analysisState.free === 'function') {
      try {
        await analysisState.free();
      } catch (freeError) {
        console.warn('Unable to free previous analysis state:', freeError);
      }
    }

    // Create analysis state
    analysisState = await bakana.createAnalysis();

    // Run only the 4 steps needed for normalization (NO UMAP, NO CLUSTERING)
    const steps = [
      ['inputs', () => analysisState.inputs.compute({ sample: dataset }, baseParams.inputs)],
      ['rna_quality_control', () => analysisState.rna_quality_control.compute(baseParams.rna_quality_control)],
      ['cell_filtering', () => analysisState.cell_filtering.compute(baseParams.cell_filtering)],
      ['rna_normalization', () => analysisState.rna_normalization.compute(baseParams.rna_normalization)],
    ];
    for (const [stepName, computeFn] of steps) {
      await computeFn();
    }

    // Get filtered cell count from normalized matrix
    let nFilteredCells = 0;
    try {
      const normMatrix = analysisState.rna_normalization.fetchNormalizedMatrix();
      nFilteredCells = normMatrix.numberOfColumns ? normMatrix.numberOfColumns() :
                       (normMatrix.ncol ? normMatrix.ncol() : 0);
    } catch (e) {
      console.warn('Could not determine filtered cell count:', e.message);
      return;
    }

    // Derive filtered barcode order from cell_filtering keep mask
    let filteredBarcodes = null;
    try {
      const filterState = analysisState.cell_filtering;
      if (filterState && typeof filterState.fetchKeep === 'function') {
        const keepResult = filterState.fetchKeep();
        if (keepResult) {
          let mask = null;
          if (typeof keepResult.array === 'function') {
            mask = keepResult.array();
          } else if (typeof keepResult.toArray === 'function') {
            mask = keepResult.toArray();
          } else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) {
            mask = keepResult;
          } else if (typeof keepResult.length === 'number') {
            mask = Array.from({ length: keepResult.length }, (_, idx) => keepResult[idx]);
          }

          if (mask && mask.length > 0) {
            filteredBarcodes = [];
            for (let i = 0; i < mask.length; i++) {
              const raw = Array.isArray(mask[i]) ? mask[i][0] : mask[i];
              const keepFlag = typeof raw === 'number' ? raw !== 0 : !!raw;
              if (keepFlag && i < infoCellBarcodes.length) {
                filteredBarcodes.push(infoCellBarcodes[i]);
              }
            }
          }
        }
      }
    } catch (filterError) {
      console.warn('Failed to get filter mask:', filterError.message);
    }

    // Fallback: if no filtering applied or mask unavailable, use all barcodes
    if (!filteredBarcodes || filteredBarcodes.length === 0) {
      if (infoCellBarcodes.length === nFilteredCells) {
        filteredBarcodes = [...infoCellBarcodes];
      } else {
        console.warn(`Multiome: barcode count mismatch (${infoCellBarcodes.length} vs ${nFilteredCells}), truncating`);
        filteredBarcodes = infoCellBarcodes.slice(0, nFilteredCells);
      }
    }

    // Realign both RNA and ATAC UMAPs to filtered barcode order
    const alignToFiltered = (umapParsed, clustersParsed) => {
      const barcodeToUmap = new Map();
      for (let i = 0; i < umapParsed.barcodeOrder.length; i++) {
        barcodeToUmap.set(umapParsed.barcodeOrder[i], umapParsed.coords[i]);
      }
      const barcodeToCluster = new Map();
      for (let i = 0; i < clustersParsed.barcodeOrder.length; i++) {
        barcodeToCluster.set(clustersParsed.barcodeOrder[i], clustersParsed.clusters[i]);
      }

      const alignedCoords = [];
      const alignedClusters = [];
      let matched = 0;
      for (const bc of filteredBarcodes) {
        const coord = barcodeToUmap.get(bc);
        const cluster = barcodeToCluster.get(bc);
        if (coord) {
          alignedCoords.push(coord);
          matched++;
        } else {
          alignedCoords.push([NaN, NaN]);
        }
        alignedClusters.push(cluster !== undefined ? cluster : 0);
      }
      return { coordinates: alignedCoords, clusters: alignedClusters, nClusters: new Set(alignedClusters).size };
    };

    const rnaAligned = alignToFiltered(rnaUmapParsed, rnaClustersParsed);
    const atacAligned = alignToFiltered(atacUmapParsed, atacClustersParsed);

    // Update global state
    loadedData.cellBarcodes = filteredBarcodes;
    currentResults.umap = rnaAligned.coordinates;
    currentResults.clusters = rnaAligned.clusters;
    loadedData.precomputed.rnaAligned = rnaAligned;
    loadedData.precomputed.atacAligned = atacAligned;
    // If WNN was restored from saved results, keep WNN coordinates so gene plots use WNN layout
    const prevWnnForNorm = loadedData.previousResults;
    if (prevWnnForNorm?.wnnActive && prevWnnForNorm.umapCoordinates?.length > 0) {
      currentResults.umap = prevWnnForNorm.umapCoordinates;
      currentResults.clusters = prevWnnForNorm.clusters;
    }
    loadedData.state = analysisState;
    currentParameters = baseParams;
    loadedData.nCells = nFilteredCells;

    // Broadcast updated DATA_LOADED with filtered cell count
    self.postMessage({
      type: 'DATA_LOADED',
      data: {
        path: loadedData.path,
        cells: nFilteredCells,
        genes: loadedData.nGenes || 0,
        rawCells: loadedData.rawCells || nFilteredCells,
        rawGenes: loadedData.rawGenes || loadedData.nGenes || 0,
        modality: 'multiome',
        peaks: loadedData.nPeaks,
        reason: 'post-normalization-realignment',
      },
    });

    // Send realigned RNA UMAP (include filtered barcodes so App.jsx can persist them for standalone scripts)
    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'umap',
        coordinates: rnaAligned.coordinates,
        clusters: rnaAligned.clusters,
        nClusters: rnaAligned.nClusters,
        nCells: nFilteredCells,
        source: 'precomputed',
        multiomeModality: 'rna',
        realigned: true,
        cellBarcodes: filteredBarcodes,
      },
    });

    // Send realigned ATAC UMAP
    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'umap',
        coordinates: atacAligned.coordinates,
        clusters: atacAligned.clusters,
        nClusters: atacAligned.nClusters,
        nCells: nFilteredCells,
        source: 'precomputed',
        multiomeModality: 'atac',
        realigned: true,
        cellBarcodes: filteredBarcodes,
      },
    });

    self.postMessage({
      type: 'STATUS_UPDATE',
      message: 'Normalization complete - gene expression plotting ready',
    });
  } catch (error) {
    console.error('Multiome background normalization failed:', error);
    console.error('Error details:', error.stack);
    self.postMessage({
      type: 'STATUS_UPDATE',
      message: 'Normalization failed - gene plotting may not work until analysis completes',
    });
  }
}

/**
 * Realign multiome precomputed RNA/ATAC UMAPs and clusters to the current filtered barcode list
 * so both RNA and ATAC views always show the same cells after reanalysis (e.g. force_reanalysis).
 */
function realignMultiomePrecomputedToCurrentBarcodes() {
  if (loadedData?.info?.modality !== 'multiome' || !loadedData.precomputed) {
    return;
  }
  const filteredBarcodes = loadedData.cellBarcodes;
  if (!Array.isArray(filteredBarcodes) || filteredBarcodes.length === 0) {
    console.warn('Multiome realign: no cellBarcodes, skipping');
    return;
  }
  const { rnaUmap, atacUmap, rnaClusters, atacClusters } = loadedData.precomputed;
  if (!rnaUmap?.barcodeOrder || !atacUmap?.barcodeOrder) {
    console.warn('Multiome realign: missing parsed UMAP/cluster data, skipping');
    return;
  }

  const alignToFiltered = (umapParsed, clustersParsed) => {
    const barcodeToUmap = new Map();
    for (let i = 0; i < umapParsed.barcodeOrder.length; i++) {
      barcodeToUmap.set(umapParsed.barcodeOrder[i], umapParsed.coords[i]);
    }
    const barcodeToCluster = new Map();
    for (let i = 0; i < clustersParsed.barcodeOrder.length; i++) {
      barcodeToCluster.set(clustersParsed.barcodeOrder[i], clustersParsed.clusters[i]);
    }
    const alignedCoords = [];
    const alignedClusters = [];
    let matched = 0;
    for (const bc of filteredBarcodes) {
      const coord = barcodeToUmap.get(bc);
      const cluster = barcodeToCluster.get(bc);
      if (coord) {
        alignedCoords.push(coord);
        matched++;
      } else {
        alignedCoords.push([NaN, NaN]);
      }
      alignedClusters.push(cluster !== undefined ? cluster : 0);
    }
    return { coordinates: alignedCoords, clusters: alignedClusters, nClusters: new Set(alignedClusters).size };
  };

  const rnaAligned = alignToFiltered(rnaUmap, rnaClusters);
  const atacAligned = alignToFiltered(atacUmap, atacClusters);
  loadedData.precomputed.rnaAligned = rnaAligned;
  loadedData.precomputed.atacAligned = atacAligned;
  loadedData.nCells = filteredBarcodes.length;
}

function updateMultiomeFilteredBarcodesFromState(state, expectedLength = null) {
  if (loadedData?.info?.modality !== 'multiome' || !state) {
    return false;
  }

  const expected = Number.isFinite(expectedLength) && expectedLength > 0 ? expectedLength : null;
  let filteredBarcodes = null;

  try {
    filteredBarcodes = getOrderedBarcodesFromFilteredState(state);
    if (Array.isArray(filteredBarcodes) && filteredBarcodes.length) {
    }
  } catch (error) {
    console.warn('Multiome: could not derive filtered barcodes from analysis state:', error.message);
  }

  if (!Array.isArray(filteredBarcodes) || filteredBarcodes.length === 0) {
    const sourceBarcodes = Array.isArray(loadedData.allCellBarcodes) && loadedData.allCellBarcodes.length
      ? loadedData.allCellBarcodes
      : (Array.isArray(loadedData.cellBarcodes) ? loadedData.cellBarcodes : null);
    if (!sourceBarcodes?.length) {
      console.warn('Multiome: no source barcodes available for filtered barcode reconstruction.');
      return false;
    }

    try {
      const keepResult = state.cell_filtering?.fetchKeep?.();
      let mask = null;
      if (typeof keepResult?.array === 'function') mask = keepResult.array();
      else if (typeof keepResult?.toArray === 'function') mask = keepResult.toArray();
      else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) mask = keepResult;
      else if (keepResult && typeof keepResult.length === 'number') {
        mask = Array.from({ length: keepResult.length }, (_, idx) => keepResult[idx]);
      }

      if (mask && typeof mask.length === 'number') {
        if (mask.length !== sourceBarcodes.length) {
          console.warn('Multiome: keep mask length differs from source barcode count.', {
            keepLength: mask.length,
            sourceBarcodeLength: sourceBarcodes.length,
          });
        }
        filteredBarcodes = [];
        const n = Math.min(mask.length, sourceBarcodes.length);
        for (let i = 0; i < n; i++) {
          const raw = Array.isArray(mask[i]) ? mask[i][0] : mask[i];
          const keepFlag = typeof raw === 'number' ? raw !== 0 : !!raw;
          if (keepFlag) filteredBarcodes.push(sourceBarcodes[i]);
        }
      }
    } catch (error) {
      console.warn('Multiome: could not reconstruct filtered barcodes from keep mask:', error.message);
    }
  }

  if (!Array.isArray(filteredBarcodes) || filteredBarcodes.length === 0) {
    return false;
  }

  if (expected && filteredBarcodes.length !== expected) {
    console.warn('Multiome: filtered barcode count differs from analysis outputs.', {
      barcodeLength: filteredBarcodes.length,
      expectedLength: expected,
    });
    if (filteredBarcodes.length > expected) {
      filteredBarcodes = filteredBarcodes.slice(0, expected);
    } else {
      return false;
    }
  }

  loadedData.cellBarcodes = filteredBarcodes;
  loadedData.nCells = filteredBarcodes.length;
  realignMultiomePrecomputedToCurrentBarcodes();
  return true;
}

/**
 * Realign only RNA precomputed UMAP/clusters to the current barcode list (e.g. after ATAC-centric
 * analysis filtered cells by min fragments/peaks). ATAC side is assumed already set (e.g. from runAtacPipeline).
 */
function realignMultiomeRnaPrecomputedToCurrentBarcodes() {
  if (loadedData?.info?.modality !== 'multiome' || !loadedData.precomputed) {
    return;
  }
  const filteredBarcodes = loadedData.cellBarcodes;
  if (!Array.isArray(filteredBarcodes) || filteredBarcodes.length === 0) {
    console.warn('Multiome RNA realign: no cellBarcodes, skipping');
    return;
  }
  const { rnaUmap, rnaClusters } = loadedData.precomputed;
  if (!rnaUmap?.barcodeOrder || !rnaClusters?.barcodeOrder) {
    console.warn('Multiome RNA realign: missing parsed RNA UMAP/cluster data, skipping');
    return;
  }
  const barcodeToUmap = new Map();
  for (let i = 0; i < rnaUmap.barcodeOrder.length; i++) {
    barcodeToUmap.set(rnaUmap.barcodeOrder[i], rnaUmap.coords[i]);
  }
  const barcodeToCluster = new Map();
  for (let i = 0; i < rnaClusters.barcodeOrder.length; i++) {
    barcodeToCluster.set(rnaClusters.barcodeOrder[i], rnaClusters.clusters[i]);
  }
  const alignedCoords = [];
  const alignedClusters = [];
  let matched = 0;
  for (const bc of filteredBarcodes) {
    const coord = barcodeToUmap.get(bc);
    const cluster = barcodeToCluster.get(bc);
    if (coord) {
      alignedCoords.push(coord);
      matched++;
    } else {
      alignedCoords.push([NaN, NaN]);
    }
    alignedClusters.push(cluster !== undefined ? cluster : 0);
  }
  loadedData.precomputed.rnaAligned = {
    coordinates: alignedCoords,
    clusters: alignedClusters,
    nClusters: new Set(alignedClusters).size,
  };
  loadedData.nCells = filteredBarcodes.length;
}

/**
 * Align ATAC results (e.g. from runAtacPipeline LSI) to canonical barcode order and set precomputed.atacAligned.
 * Call after runAtacPipeline when multiome so RNA and ATAC views use the same cell order.
 */
function alignMultiomeAtacResultsToCanonical() {
  if (loadedData?.info?.modality !== 'multiome' || !loadedData.precomputed) return;
  const atacColumnBarcodes = loadedData._atacColumnBarcodesForAlign;
  const canonicalBarcodes = loadedData.cellBarcodes && loadedData.cellBarcodes.length > 0 ? loadedData.cellBarcodes : loadedData.allCellBarcodes;
  if (!atacColumnBarcodes || !canonicalBarcodes?.length) return;
  const atacCoords = currentResults.umap || [];
  const atacClusters = currentResults.clusters || [];
  const normalizeBc = (bc) => (bc == null ? '' : String(bc).trim().toLowerCase().replace(/-[12]$/, ''));
  const barcodeToCoord = new Map();
  const barcodeToCluster = new Map();
  for (let i = 0; i < atacColumnBarcodes.length; i++) {
    const bc = atacColumnBarcodes[i];
    const key = normalizeBc(bc);
    barcodeToCoord.set(bc, atacCoords[i]);
    barcodeToCoord.set(key, atacCoords[i]);
    barcodeToCluster.set(bc, atacClusters[i]);
    barcodeToCluster.set(key, atacClusters[i]);
  }
  const alignedCoords = [];
  const alignedClusters = [];
  for (const bc of canonicalBarcodes) {
    const coord = barcodeToCoord.get(bc) ?? barcodeToCoord.get(normalizeBc(bc));
    const cluster = barcodeToCluster.get(bc) ?? barcodeToCluster.get(normalizeBc(bc));
    alignedCoords.push(coord || [NaN, NaN]);
    alignedClusters.push(cluster !== undefined ? cluster : 0);
  }
  loadedData.precomputed.atacAligned = {
    coordinates: alignedCoords,
    clusters: alignedClusters,
    nClusters: new Set(alignedClusters).size,
  };
  if (loadedData._atacColumnBarcodesForAlign) delete loadedData._atacColumnBarcodesForAlign;
}

/**
 * Convert scran Matrix (peaks x cells) to SparseMatrixCSC for the scATAC pipeline.
 * @param {object} peakMatrix: scran Matrix with numberOfRows(), numberOfColumns(), column(j)
 * @returns {SparseMatrixCSC}
 */
function scranMatrixToSparseCSC(peakMatrix) {
  const nrows = peakMatrix.numberOfRows();
  const ncols = peakMatrix.numberOfColumns();
  const colPtr = new Int32Array(ncols + 1);
  const rowIdx = [];
  const values = [];
  let pos = 0;
  for (let j = 0; j < ncols; j++) {
    colPtr[j] = pos;
    const col = peakMatrix.column(j);
    for (let i = 0; i < nrows; i++) {
      const v = col[i];
      if (v > 0) {
        rowIdx.push(i);
        values.push(Number(v));
        pos++;
      }
    }
  }
  colPtr[ncols] = pos;
  return new SparseMatrixCSC(nrows, ncols, colPtr, new Int32Array(rowIdx), new Float64Array(values));
}

/**
 * Multi-sample ATAC integration pipeline (Harmony batch correction).
 * Reads loadedData.atacSamples, runs runMultiSamplePipeline, populates loadedData, posts ANALYSIS_COMPLETE.
 */
async function runAtacIntegrationPipeline() {
  if (!loadedData || !loadedData.atacSamples) {
    throw new Error('ATAC integration: no sample data available');
  }

  const statusCallback = (msg) => self.postMessage({ type: 'STATUS_UPDATE', message: msg });

  statusCallback('Starting ATAC multi-sample integration...');

  const result = await runMultiSamplePipeline(loadedData.atacSamples, { statusCallback });

  // Store results back into loadedData
  currentResults.umap = result.umapEmbedding;
  currentResults.clusters = result.clusters;

  loadedData.atacPeakMatrix = createCSCMatrixAdapter(result.mergedMatrix);
  loadedData.atacCountMatrix = result.mergedMatrix;
  loadedData.atacPeakNames = result.unifiedPeakNames;
  loadedData.cellBarcodes = result.allBarcodes;
  // Remap per-sample peak annotations to unified peaks so gene names are available.
  // Use coordinate-based matching (not positional indexing) so it works even if
  // peak_annotation.tsv has a different number of rows than peaks.bed (e.g. multiple
  // annotation rows per peak, or filtered peaks).
  const unifiedGenes = new Array(result.unifiedPeaks.length).fill('');
  for (const sample of loadedData.atacSamples) {
    const sampleAnno = sample.peakAnnotation || [];
    if (sampleAnno.length === 0) continue;

    // Build coordinate→gene map from peak annotation TSV (handles many:1 or 1:1)
    const coordToGene = new Map();
    for (const anno of sampleAnno) {
      const gene = (anno.gene || '').trim();
      if (!gene) continue;
      const key = `${anno.chrom}-${anno.start}-${anno.end}`;
      if (!coordToGene.has(key)) coordToGene.set(key, gene);
    }

    // Map each original peak → unified peak, using coordinate-based gene lookup
    const originalPeaks = sample.peakNames.map(parsePeakName);
    const mapping = mapPeaksToUnified(originalPeaks, result.unifiedPeaks);
    let assignedFromSample = 0;
    for (let pi = 0; pi < mapping.length; pi++) {
      const uIdx = mapping[pi];
      if (uIdx < 0) continue;
      // Look up gene by the peak's coordinate (from peaks.bed), not by positional index
      const gene = coordToGene.get(sample.peakNames[pi]) || '';
      if (gene && !unifiedGenes[uIdx]) {
        unifiedGenes[uIdx] = gene;
        assignedFromSample++;
      }
    }
  }
  const nWithGenes = unifiedGenes.filter(Boolean).length;

  loadedData.peakAnnotation = result.unifiedPeakNames.map((p, i) => {
    const m = p.match(/^([^-]+)-(\d+)-(\d+)$/);
    if (m) return { peakName: p, chrom: m[1], start: m[2], end: m[3], gene: unifiedGenes[i] };
    return { peakName: p, chrom: '', start: '', end: '', gene: unifiedGenes[i] };
  });
  loadedData.integrationViews = result.integrationViews;
  // Compute per-cell total counts (library size) for coverage normalization
  loadedData.atacColSums = Array.from(result.mergedMatrix.colSums());
  loadedData.nCells = result.allBarcodes.length;
  loadedData.nGenes = result.unifiedPeakNames.length;
  loadedData.rawCells = result.allBarcodes.length;
  loadedData.rawGenes = result.unifiedPeakNames.length;

  const nCells = result.allBarcodes.length;
  const nClusters = new Set(result.clusters).size;
  const datasetNames = result.datasetNames;

  self.postMessage({
    type: 'DATA_LOADED',
    data: {
      path: loadedData.path,
      cells: nCells,
      genes: result.unifiedPeakNames.length,
      rawCells: nCells,
      rawGenes: result.unifiedPeakNames.length,
      modality: 'atac-integration',
      datasetNames,
    },
  });

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'umap',
      coordinates: result.umapEmbedding,
      clusters: result.clusters,
      nClusters,
      nCells,
      source: 'atac-integration',
      integrationViews: result.integrationViews,
      datasetNames,
    },
  });

}

/**
 * Return integrationViews + datasetNames for the atac-integration modality (used by violin/dotplot).
 */
function getAtacIntegrationViewsForPlot() {
  if (loadedData?.info?.modality !== 'atac-integration') return null;
  if (!loadedData.integrationViews) return null;
  return { integrationViews: loadedData.integrationViews, datasetNames: loadedData.info.datasetNames };
}

/**
 * ATAC pipeline: uses scATAC single-sample pipeline (TF-IDF, FindTopFeatures, LSI, UMAP, Louvain).
 * Matrix is peaks x cells. min_dist/num_neighbors passed through for UMAP.
 * @param {Object} opts: options
 * @param {boolean} opts.skipPostMessage: if true, do not post ANALYSIS_COMPLETE (caller will post both RNA and ATAC for multiome)
 * @param {number} [opts.minDist]: UMAP min_dist (default 0.3, scATAC pipeline default)
 * @param {number} [opts.numNeighbors]: UMAP n_neighbors (default 30)
 * @param {number} [opts.resolution]: Louvain clustering resolution (default 0.8)
 */
async function runAtacPipeline(opts = {}) {
  const { skipPostMessage = false, minDist = null, numNeighbors = null, resolution = null, multiome = false, multiomePeakMatrix = null } = opts;
  if (!loadedData) {
    throw new Error('No ATAC dataset available');
  }
  const scaleFactor = 10000;
  const numPCs = 20;
  const umapNeighbors = numNeighbors != null ? Math.floor(numNeighbors) : 15;
  const umapMinDist = minDist != null && Number.isFinite(minDist) ? minDist : 0.2;
  const clusteringResolution = resolution != null && Number.isFinite(resolution) ? resolution : 0.8;

  let peakMatrix;
  let peakNames;
  let atacColumnBarcodes;
  let nPeaks;
  let nCells;
  let countMatrix;
  let rowSumsArr;
  let colSumsArr;

  if (loadedData.atacCountMatrix && !multiome) {
    countMatrix = loadedData.atacCountMatrix;
    peakMatrix = loadedData.atacPeakMatrix;
    peakNames = loadedData.peakNames || [];
    nPeaks = countMatrix.nrows;
    nCells = countMatrix.ncols;
    rowSumsArr = Array.from(countMatrix.rowSums());
    colSumsArr = Array.from(countMatrix.colSums());
  } else if (multiome && loadedData.info?.modality === 'multiome' && multiomePeakMatrix?.peakMatrix) {
    self.postMessage({ type: 'STATUS_UPDATE', message: 'Using multiome ATAC peak matrix (same cell order as RNA)...' });
    peakMatrix = multiomePeakMatrix.peakMatrix;
    peakNames = multiomePeakMatrix.peakNames || [];
    atacColumnBarcodes = Array.isArray(multiomePeakMatrix.fullBarcodeOrder) && multiomePeakMatrix.fullBarcodeOrder.length === peakMatrix.numberOfColumns()
      ? multiomePeakMatrix.fullBarcodeOrder
      : (loadedData.cellBarcodes && loadedData.cellBarcodes.length === peakMatrix.numberOfColumns() ? loadedData.cellBarcodes : Array.from({ length: peakMatrix.numberOfColumns() }, (_, i) => `cell_${i}`));
    nPeaks = peakMatrix.numberOfRows();
    nCells = peakMatrix.numberOfColumns();
    loadedData._atacColumnBarcodesForAlign = atacColumnBarcodes;
    rowSumsArr = Array.from(scran.rowSums(peakMatrix));
    colSumsArr = Array.from(scran.columnSums(peakMatrix));
    countMatrix = scranMatrixToSparseCSC(peakMatrix);
  } else {
    if (!loadedData.dataset) {
      throw new Error('No ATAC dataset available');
    }
    const dataset = loadedData.dataset;
    self.postMessage({ type: 'STATUS_UPDATE', message: 'Loading ATAC peak matrix...' });
    const loaded = await dataset.load({ cache: true });
    const multiMatrix = loaded.matrix;
    const modalityKeys = multiMatrix && typeof multiMatrix.available === 'function' ? multiMatrix.available() : (multiMatrix ? Object.keys(multiMatrix) : []);
    const firstMod = modalityKeys[0];
    if (!firstMod) {
      throw new Error('ATAC load did not return a matrix (no modality in MultiMatrix)');
    }
    peakMatrix = typeof multiMatrix.get === 'function' ? multiMatrix.get(firstMod) : multiMatrix[firstMod];
    if (!peakMatrix) {
      throw new Error('ATAC load did not return a matrix (get failed for ' + firstMod + ')');
    }
    nPeaks = peakMatrix.numberOfRows();
    nCells = peakMatrix.numberOfColumns();
    peakNames = (loaded.primary_ids && loaded.primary_ids[firstMod]) ? loaded.primary_ids[firstMod] : [];
    atacColumnBarcodes = null;
    if (loaded.cells) {
      try {
        if (typeof loaded.cells.rowNames === 'function') {
          atacColumnBarcodes = loaded.cells.rowNames();
        } else if (loaded.cells.column && typeof loaded.cells.column === 'function') {
          const col = loaded.cells.column(0);
          atacColumnBarcodes = col ? Array.from(col) : null;
        }
      } catch (e) {
        console.warn('Could not get cell barcodes from ATAC load:', e);
      }
    }
    if (!atacColumnBarcodes || atacColumnBarcodes.length !== nCells) {
      atacColumnBarcodes = loadedData.cellBarcodes && loadedData.cellBarcodes.length === nCells
        ? loadedData.cellBarcodes
        : Array.from({ length: nCells }, (_, i) => `cell_${i}`);
    }
    if (multiome && loadedData.info?.modality === 'multiome') {
      loadedData._atacColumnBarcodesForAlign = atacColumnBarcodes;
    } else {
      loadedData.cellBarcodes = atacColumnBarcodes;
    }
    rowSumsArr = Array.from(scran.rowSums(peakMatrix));
    colSumsArr = Array.from(scran.columnSums(peakMatrix));
    countMatrix = scranMatrixToSparseCSC(peakMatrix);
  }

  loadedData.nCells = nCells;
  // For multiome, preserve the RNA gene count (nGenes); only set peak count for standalone ATAC
  if (loadedData.info?.modality !== 'multiome') {
    loadedData.nGenes = nPeaks;
    loadedData.rawGenes = nPeaks;
  }
  loadedData.nPeaks = nPeaks;
  loadedData.rawCells = nCells;

  self.postMessage({ type: 'STATUS_UPDATE', message: 'Running scATAC pipeline (TF-IDF, LSI, UMAP, Louvain)...' });
  const result = await runSingleSamplePipeline(countMatrix, {
    scaleFactor,
    minDist: umapMinDist,
    numNeighbors: umapNeighbors,
    resolution: clusteringResolution,
    statusCallback: (msg) => self.postMessage({ type: 'STATUS_UPDATE', message: msg }),
  });

  currentResults.umap = result.umapEmbedding;
  currentResults.clusters = result.clusters;

  // Store LSI embeddings for WNN integration (row-major, nCells × nComponents)
  if (result.cellEmbeddings && result.nComponents) {
    loadedData.atacLSIEmbeddings = result.cellEmbeddings;
    loadedData.atacLSINComponents = result.nComponents;
  }

  // For multiome, preserve the RNA gene count, only ATAC-only datasets use peak count as "genes"
  postFilteredSummary({
    summary: { cells: nCells, genes: loadedData.info?.modality === 'multiome' ? (loadedData.nGenes || 0) : nPeaks },
    force: true,
    reason: 'atac-pipeline',
  });

  const messageData = {
    type: 'umap',
    coordinates: result.umapEmbedding,
    clusters: result.clusters,
    nClusters: new Set(result.clusters).size,
    nCells,
    cells: nCells,
    genes: nPeaks,
    source: 'atac',
  };
  loadedData.atacPeakMatrix = peakMatrix;
  loadedData.atacPeakNames = peakNames;
  loadedData.atacTopPeakIndices = result.topPeakIndices;
  loadedData.atacRowSums = rowSumsArr;
  loadedData.atacColSums = colSumsArr;
  loadedData.atacScaleFactor = scaleFactor;

  if (!skipPostMessage) {
    self.postMessage({ type: 'ANALYSIS_COMPLETE', data: messageData });
  }
}

/**
 * Get ordered cell barcodes from a bakana state after filtering (for alignment).
 * Tries annotations first; if length doesn't match filtered count, subsets by cell_filtering keep mask.
 */
function getOrderedBarcodesFromFilteredState(state) {
  if (!state?.umap || !state?.inputs || !state?.cell_filtering) return null;
  const umapResults = state.umap.fetchResults();
  const nCells = umapResults?.x?.length ?? 0;
  if (nCells === 0) return null;
  const annotations = state.inputs.fetchCellAnnotations();
  let barcodes = extractOrderedBarcodesFromAnnotations(annotations, nCells);
  if (barcodes) return barcodes;
  const keepResult = state.cell_filtering.fetchKeep();
  if (!keepResult) return null;
  let mask = null;
  if (typeof keepResult.array === 'function') mask = keepResult.array();
  else if (typeof keepResult.toArray === 'function') mask = keepResult.toArray();
  else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) mask = keepResult;
  if (!mask || mask.length === 0) return null;
  let fullBarcodes = null;
  if (typeof annotations.rowNames === 'function') fullBarcodes = annotations.rowNames();
  if (!fullBarcodes && typeof annotations.columnNames === 'function' && typeof annotations.column === 'function') {
    const columnNames = annotations.columnNames();
    const preferred = ['cell_id', 'barcode', 'Barcode', 'cell', 'id', 'CellID'];
    for (const name of preferred) {
      if (columnNames.includes(name)) {
        const col = annotations.column(name);
        if (col && col.length === mask.length) {
          fullBarcodes = Array.from(col);
          break;
        }
      }
    }
    if (!fullBarcodes && columnNames.length) {
      const col = annotations.column(columnNames[0]);
      if (col && col.length === mask.length) fullBarcodes = Array.from(col);
    }
  }
  if (!fullBarcodes || fullBarcodes.length !== mask.length) return null;
  const out = [];
  for (let i = 0; i < mask.length; i++) {
    const kept = Array.isArray(mask) ? mask[i] : mask[i];
    if (kept) out.push(fullBarcodes[i]);
  }
  return out.length === nCells ? out : null;
}

/**
 * Run ATAC analysis for multiome using the same pipeline as scATAC (bakana RNA-style):
 * inputs → QC → cell_filtering → normalization → PCA → neighbor_index → UMAP → clustering.
 * Uses the Peaks modality from the multiome H5 (same as scATAC). Faster and consistent with scATAC.
 */
async function runAtacPipelineBakana(opts = {}) {
  const { skipPostMessage = false, minDist = null, numNeighbors = null, resolution = null, algorithm = null, messageSource = null } = opts;
  if (!loadedData || loadedData.info?.modality !== 'multiome') {
    throw new Error('Multiome ATAC pipeline requires multiome data');
  }
  if (!loadedData.h5Blob) {
    throw new Error('Multiome H5 blob not available for ATAC pipeline');
  }

  self.postMessage({ type: 'STATUS_UPDATE', message: 'Running ATAC analysis (scATAC-style pipeline)...' });
  const atacDataset = new bakana.TenxHdf5Dataset(loadedData.h5Blob);
  atacDataset.setOptions({ featureTypeRnaName: 'Peaks' });

  const baseParams = buildDefaultParameters({ fastMode: false });
  if (!baseParams.rna_quality_control) baseParams.rna_quality_control = {};
  baseParams.rna_quality_control.filter_strategy = 'manual';
  baseParams.rna_quality_control.detected_threshold = 0;
  baseParams.rna_quality_control.sum_threshold = 0;
  // ATAC (Peaks) has no mitochondrial genes; skip reference download (scATAC-style, no mito filter).
  baseParams.rna_quality_control.use_reference_mito = false;
  baseParams.rna_quality_control.mito_prefix = null;
  if (minDist != null && Number.isFinite(minDist)) {
    if (!baseParams.umap) baseParams.umap = {};
    baseParams.umap.min_dist = minDist;
  }
  if (numNeighbors != null && Number.isFinite(numNeighbors)) {
    const n = Math.floor(numNeighbors);
    if (!baseParams.umap) baseParams.umap = {};
    baseParams.umap.num_neighbors = n;
    if (!baseParams.neighbor_index) baseParams.neighbor_index = {};
    if (!baseParams.neighbor_index.approximate) baseParams.neighbor_index.k = n;
  }
  synchronizeNeighborCounts(baseParams);
  if (resolution != null && Number.isFinite(resolution)) {
    baseParams.snn_graph_cluster = baseParams.snn_graph_cluster || {};
    const algo = (algorithm || baseParams.snn_graph_cluster.algorithm || 'multilevel').toLowerCase();
    baseParams.snn_graph_cluster.algorithm = algo;
    if (algo === 'leiden') {
      baseParams.snn_graph_cluster.leiden_resolution = resolution;
    } else if (algo === 'walktrap') {
      baseParams.snn_graph_cluster.walktrap_steps = Math.max(1, Math.round(resolution));
    } else {
      baseParams.snn_graph_cluster.multilevel_resolution = resolution;
    }
  }

  if (loadedData.atacState && typeof loadedData.atacState.free === 'function') {
    try {
      loadedData.atacState.free();
    } catch (e) {
      console.warn('Could not free previous ATAC state:', e);
    }
    loadedData.atacState = null;
  }

  const atacState = await bakana.createAnalysis();
  await runRnaOnlyAnalysis(
    atacState,
    { sample: atacDataset },
    baseParams,
    {
      startFun: async (step) => {
        self.postMessage({ type: 'STATUS_UPDATE', message: `ATAC: ${step}...` });
      },
      finishFun: async () => {},
    }
  );

  const umapResults = await atacState.umap.fetchResults();
  const coordinates = [];
  for (let i = 0; i < umapResults.x.length; i++) {
    coordinates.push([umapResults.x[i], umapResults.y[i]]);
  }
  const clusterResults = atacState.choose_clustering.fetchClusters();
  const clusters = clusterResults ? Array.from(clusterResults) : [];

  currentResults.umap = coordinates;
  currentResults.clusters = clusters;
  loadedData.atacState = atacState;

  let atacColumnBarcodes = getOrderedBarcodesFromFilteredState(atacState);
  // Fallback: multiome H5 has same cell order for RNA and ATAC; if no cells filtered use allCellBarcodes
  if (!atacColumnBarcodes && loadedData.allCellBarcodes && loadedData.allCellBarcodes.length === coordinates.length) {
    atacColumnBarcodes = loadedData.allCellBarcodes;
  }
  // Last resort: assume 1:1 order with canonical so alignment runs and keeps RNA/ATAC in sync
  const canonicalBarcodes = loadedData.cellBarcodes && loadedData.cellBarcodes.length > 0
    ? loadedData.cellBarcodes
    : (loadedData.allCellBarcodes && loadedData.allCellBarcodes.length > 0 ? loadedData.allCellBarcodes : null);
  if (!atacColumnBarcodes && canonicalBarcodes && canonicalBarcodes.length === coordinates.length) {
    atacColumnBarcodes = canonicalBarcodes;
  }
  loadedData._atacColumnBarcodesForAlign = atacColumnBarcodes || null;

  const atacCoords = currentResults.umap || [];
  const atacClusters = currentResults.clusters || [];
  const normalizeBc = (bc) => (bc == null ? '' : String(bc).trim().toLowerCase().replace(/-[12]$/, ''));
  const addSuffixVariants = (bc) => {
    const s = String(bc).trim();
    if (!s || s.endsWith('-1') || s.endsWith('-2')) return [s];
    return [s, s + '-1', s + '-2'];
  };

  if (loadedData.precomputed && Array.isArray(canonicalBarcodes) && canonicalBarcodes.length > 0 && atacColumnBarcodes) {
    const barcodeToCoord = new Map();
    const barcodeToCluster = new Map();
    for (let i = 0; i < atacColumnBarcodes.length; i++) {
      const bc = atacColumnBarcodes[i];
      const keys = [bc, normalizeBc(bc), ...addSuffixVariants(bc)];
      for (const k of keys) {
        if (k) {
          barcodeToCoord.set(k, atacCoords[i]);
          barcodeToCluster.set(k, atacClusters[i]);
        }
      }
    }
    const alignedCoords = [];
    const alignedClusters = [];
    let matched = 0;
    for (const bc of canonicalBarcodes) {
      const coord = barcodeToCoord.get(bc) ?? barcodeToCoord.get(normalizeBc(bc)) ?? barcodeToCoord.get(bc + '-1') ?? barcodeToCoord.get(bc + '-2');
      const cluster = barcodeToCluster.get(bc) ?? barcodeToCluster.get(normalizeBc(bc)) ?? barcodeToCluster.get(bc + '-1') ?? barcodeToCluster.get(bc + '-2');
      if (coord) {
        alignedCoords.push(coord);
        matched++;
      } else {
        alignedCoords.push([NaN, NaN]);
      }
      alignedClusters.push(cluster !== undefined ? cluster : 0);
    }
    const nClusters = new Set(alignedClusters).size;
    loadedData.precomputed.atacAligned = {
      coordinates: alignedCoords,
      clusters: alignedClusters,
      nClusters,
    };
    loadedData.precomputed.atacAligned.barcodeOrder = canonicalBarcodes;
  } else if (loadedData.precomputed) {
    const fallbackBarcodes = canonicalBarcodes && canonicalBarcodes.length === atacCoords.length
      ? canonicalBarcodes
      : (loadedData.allCellBarcodes && loadedData.allCellBarcodes.length === atacCoords.length ? loadedData.allCellBarcodes : null);
    loadedData.precomputed.atacAligned = {
      coordinates: fallbackBarcodes ? atacCoords.slice(0, fallbackBarcodes.length) : atacCoords,
      clusters: fallbackBarcodes ? atacClusters.slice(0, fallbackBarcodes.length) : atacClusters,
      nClusters: new Set(fallbackBarcodes ? atacClusters.slice(0, fallbackBarcodes.length) : atacClusters).size,
    };
    if (fallbackBarcodes) {
      loadedData.precomputed.atacAligned.barcodeOrder = fallbackBarcodes;
    } else {
      console.warn('Multiome: ATAC could not align to RNA barcode order; ATAC view may not match RNA');
    }
  }
  if (loadedData._atacColumnBarcodesForAlign) delete loadedData._atacColumnBarcodesForAlign;

  const atacCountMatrix = atacState.inputs?.fetchCountMatrix?.();
  const atacMod = atacCountMatrix?.available?.()?.[0];
  const nPeaks = atacMod ? (atacCountMatrix.get(atacMod)?.numberOfRows?.() ?? 0) : 0;
  postFilteredSummary({
    summary: { cells: coordinates.length, genes: nPeaks },
    force: true,
    reason: 'atac-bakana',
  });

  if (!skipPostMessage) {
    const atacAligned = loadedData.precomputed?.atacAligned;
    if (atacAligned) {
      const umapSource = messageSource != null ? messageSource : 'atac';
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: atacAligned.coordinates,
          clusters: atacAligned.clusters,
          nClusters: atacAligned.nClusters,
          nCells: atacAligned.coordinates.length,
          source: umapSource,
          multiomeModality: 'atac',
        },
      });
    } else {
      const umapSourceElse = messageSource != null ? messageSource : 'atac';
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: currentResults.umap || [],
          clusters: currentResults.clusters || [],
          nClusters: new Set(currentResults.clusters || []).size,
          nCells: (currentResults.umap || []).length,
          source: umapSourceElse,
          multiomeModality: 'atac',
        },
      });
    }
  }
}

/**
 * WNN integration: combine RNA PCA and ATAC LSI into a co-embedding UMAP.
 *
 * Requires multiome data. Ensures RNA PCA and ATAC LSI are both available,
 * then runs the WNN pipeline to produce a unified UMAP shown in both RNA and ATAC views.
 */
async function runWNNIntegration(params = {}) {
  if (!loadedData || loadedData.info?.modality !== 'multiome') {
    self.postMessage({
      type: 'ANALYSIS_ERROR',
      error: 'WNN integration requires multiome (RNA + ATAC) data.',
    });
    return;
  }

  const post = (msg) => self.postMessage({ type: 'STATUS_UPDATE', message: msg });

  // Step 1: Ensure RNA normalization state is ready
  post('WNN: Preparing RNA analysis state...');
  await ensureAnalysisReady({ reason: 'wnn-integrate' });

  // Step 2: Run PCA if not already computed
  let rnaPcaResults = null;
  try {
    rnaPcaResults = analysisState?.rna_pca?.fetchPCs?.();
  } catch (_e) {
    rnaPcaResults = null;
  }

  if (!rnaPcaResults) {
    post('WNN: Running RNA feature selection + PCA...');
    const baseParams = buildDefaultParameters({ fastMode: false });
    if (currentParameters?.rna_pca?.num_pcs) {
      if (!baseParams.rna_pca) baseParams.rna_pca = {};
      baseParams.rna_pca.num_pcs = currentParameters.rna_pca.num_pcs;
    }
    if (currentParameters?.rna_pca?.num_hvgs) {
      if (!baseParams.rna_pca) baseParams.rna_pca = {};
      baseParams.rna_pca.num_hvgs = currentParameters.rna_pca.num_hvgs;
    }
    await analysisState.feature_selection.compute(baseParams.feature_selection);
    await analysisState.rna_pca.compute(baseParams.rna_pca);
    rnaPcaResults = analysisState.rna_pca.fetchPCs();
  }

  if (!rnaPcaResults) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: 'WNN: Could not obtain RNA PCA embeddings.' });
    return;
  }

  // Step 3: Ensure ATAC TF-IDF/LSI pipeline has run
  if (!loadedData.atacLSIEmbeddings) {
    post('WNN: Running ATAC TF-IDF/LSI pipeline to obtain LSI embeddings...');
    const multiomePeak = await getMultiomePeakMatrix();
    await runAtacPipeline({ skipPostMessage: true, multiome: true, multiomePeakMatrix: multiomePeak || undefined });
  }

  if (!loadedData.atacLSIEmbeddings) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: 'WNN: Could not obtain ATAC LSI embeddings from TF-IDF/LSI pipeline.' });
    return;
  }

  // Step 4: Extract and barcode-align embeddings
  const nRNAPCs = rnaPcaResults.numberOfPCs();
  const nCellsRNA = rnaPcaResults.numberOfCells();
  const rnaPcaColMajor = rnaPcaResults.principalComponents({ copy: true });

  // RNA: scran.js principalComponents() returns column-major (Fortran order): arr[pc + nPCs*cell]
  // This means rows=PCs change fastest; to get row-major (nCells × nPCs) for WNN, use:
  //   rnaPCAEmbeddings[cell * nRNAPCs + pc] = rnaPcaColMajor[pc + nRNAPCs * cell]
  const rnaPCAEmbeddings = new Float64Array(nCellsRNA * nRNAPCs);
  for (let cell = 0; cell < nCellsRNA; cell++) {
    for (let pc = 0; pc < nRNAPCs; pc++) {
      rnaPCAEmbeddings[cell * nRNAPCs + pc] = rnaPcaColMajor[pc + nRNAPCs * cell];
    }
  }

  // ATAC LSI: runSingleSamplePipeline stores row-major (nCells × nComponents)
  const atacLSIFull = loadedData.atacLSIEmbeddings;  // Float64Array, row-major
  const nATACComponents = loadedData.atacLSINComponents;
  const nCellsATACFull = Math.round(atacLSIFull.length / nATACComponents);
  const nATACDims = nATACComponents - 1;  // skip depth-correlated dim 0

  // Step 4b: Align ATAC LSI to RNA cells by barcode
  // After bakana cell_filtering, RNA may be a filtered SUBSET of the full H5 barcode list.
  // The ATAC pipeline uses all cells from the H5 (loadedData.allCellBarcodes).
  // Without alignment, cell indices in RNA PCA and ATAC LSI refer to DIFFERENT cells,
  // which completely corrupts the WNN result.
  const rnaBarcodes = loadedData.cellBarcodes;       // filtered RNA barcodes (set by ensureAnalysisReady)
  const atacBarcodes = loadedData._atacColumnBarcodesForAlign || loadedData.allCellBarcodes;

  let atacLSIEmbeddings;
  const hasBarcodesForAlignment = Array.isArray(rnaBarcodes) && rnaBarcodes.length === nCellsRNA &&
                                   Array.isArray(atacBarcodes) && atacBarcodes.length === nCellsATACFull;

  if (hasBarcodesForAlignment) {
    // Always align by barcode: RNA cells (bakana-filtered) may differ in count or order from ATAC cells
    post(`WNN: Aligning ATAC (${nCellsATACFull} cells) to RNA (${nCellsRNA} cells) by barcode...`);
    const atacBarcodeMap = new Map();
    atacBarcodes.forEach((bc, idx) => atacBarcodeMap.set(bc, idx));

    atacLSIEmbeddings = new Float64Array(nCellsRNA * nATACDims);
    let nMissing = 0;
    for (let ri = 0; ri < nCellsRNA; ri++) {
      const bc = rnaBarcodes[ri];
      let ai = atacBarcodeMap.get(bc);
      if (ai === undefined) ai = atacBarcodeMap.get(bc.replace(/-\d+$/, '')); // strip barcode suffix
      if (ai !== undefined) {
        for (let d = 1; d < nATACComponents; d++) {
          atacLSIEmbeddings[ri * nATACDims + (d - 1)] = atacLSIFull[ai * nATACComponents + d];
        }
      } else {
        nMissing++;
      }
    }
    if (nMissing > 0) {
      console.warn(`WNN barcode alignment: ${nMissing}/${nCellsRNA} RNA cells not found in ATAC barcodes`);
    }
    post(`WNN: Alignment done, ${nCellsRNA - nMissing}/${nCellsRNA} cells matched.`);
  } else {
    // Same count and order (or no barcodes available), skip dim 0, no reordering needed
    const nCellsUse = Math.min(nCellsRNA, nCellsATACFull);
    if (nCellsRNA !== nCellsATACFull) {
      console.warn(`WNN: RNA (${nCellsRNA}) ≠ ATAC (${nCellsATACFull}) cells, no barcodes for alignment, truncating to ${nCellsUse}`);
    }
    atacLSIEmbeddings = new Float64Array(nCellsUse * nATACDims);
    for (let cell = 0; cell < nCellsUse; cell++) {
      for (let d = 1; d < nATACComponents; d++) {
        atacLSIEmbeddings[cell * nATACDims + (d - 1)] = atacLSIFull[cell * nATACComponents + d];
      }
    }
  }

  const nCells = nCellsRNA;

  // Step 4c: Individual RNA and ATAC UMAPs (shown in RNA/ATAC panels of the WNN 3-panel layout)
  post(`WNN: Running individual RNA UMAP (${nCells} cells × ${nRNAPCs} dims)...`);
  {
    const { UMAP } = await import('umap-js');
    const { buildKNN: bknn, buildSNN: bsnn, louvain: lv } = await import('../scatac/clustering.js');

    // Seeded PRNG (same algorithm as wnn.js), makes individual RNA/ATAC UMAPs reproducible
    function mkRng(seed) {
      return function() {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function cosineDistIndividual(a, b) {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
      const d = Math.sqrt(na) * Math.sqrt(nb);
      return d > 0 ? 1 - dot / d : 1;
    }

    // RNA individual UMAP
    const rnaRng = mkRng(42);
    const rnaPoints = [];
    for (let i = 0; i < nCells; i++) {
      rnaPoints.push(Array.from(rnaPCAEmbeddings.subarray(i * nRNAPCs, (i + 1) * nRNAPCs)));
    }
    const umapRNA = new UMAP({ nNeighbors: 20, minDist: 0.3, nComponents: 2, distanceFn: cosineDistIndividual, random: rnaRng });
    const rnaIndividualCoords = umapRNA.fit(rnaPoints);
    const rnaIndividualKNN = bknn(rnaPCAEmbeddings, nCells, nRNAPCs, 20, null, mkRng(42));
    const rnaIndividualSNN = bsnn(rnaIndividualKNN.indices, nCells, 20, 0, null);
    const rnaIndividualClusters = Array.from(lv(rnaIndividualSNN, nCells, 0.3, null, mkRng(42)));
    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'umap', coordinates: rnaIndividualCoords, clusters: rnaIndividualClusters,
        nClusters: new Set(rnaIndividualClusters).size, nCells,
        source: 'wnn-individual', multiomeModality: 'rna',
      },
    });

    // ATAC individual UMAP
    post(`WNN: Running individual ATAC UMAP (${nCells} cells × ${nATACDims} dims)...`);
    const atacRng = mkRng(43);
    const atacPoints = [];
    for (let i = 0; i < nCells; i++) {
      atacPoints.push(Array.from(atacLSIEmbeddings.subarray(i * nATACDims, (i + 1) * nATACDims)));
    }
    const umapATAC = new UMAP({ nNeighbors: 20, minDist: 0.3, nComponents: 2, distanceFn: cosineDistIndividual, random: atacRng });
    const atacIndividualCoords = umapATAC.fit(atacPoints);
    const atacIndividualKNN = bknn(atacLSIEmbeddings, nCells, nATACDims, 20, null, mkRng(43));
    const atacIndividualSNN = bsnn(atacIndividualKNN.indices, nCells, 20, 0, null);
    const atacIndividualClusters = Array.from(lv(atacIndividualSNN, nCells, 0.3, null, mkRng(43)));
    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'umap', coordinates: atacIndividualCoords, clusters: atacIndividualClusters,
        nClusters: new Set(atacIndividualClusters).size, nCells,
        source: 'wnn-individual', multiomeModality: 'atac',
      },
    });
  }

  // Step 5: Run WNN pipeline
  post(`WNN: Running WNN integration on ${nCells} cells (${nRNAPCs} RNA PCs + ${nATACDims} ATAC LSI dims)...`);
  const wnnResult = await runWNNPipeline(
    rnaPCAEmbeddings,
    atacLSIEmbeddings,
    nCells,
    nRNAPCs,
    nATACDims,
    {
      k: 20,
      minDist: params?.minDist ?? 0.3,
      numNeighbors: params?.numNeighbors ?? 20,
      resolution: params?.resolution ?? 0.3,
      statusCallback: post,
    }
  );

  const { umapEmbedding, clusters } = wnnResult;
  const nClusters = new Set(clusters).size;
  const coordinates = umapEmbedding;

  // Update currentResults so gene expression queries use WNN coordinates instead of precomputed individual UMAP
  currentResults.umap = umapEmbedding;
  currentResults.clusters = clusters;

  // Step 6: Broadcast results to both RNA and ATAC views
  post('WNN: Sending co-embedding to RNA and ATAC views...');

  // RNA view gets WNN UMAP + WNN clusters
  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'umap',
      coordinates,
      clusters,
      nClusters,
      nCells,
      source: 'wnn',
      multiomeModality: 'rna',
    },
  });

  // ATAC view gets the same WNN UMAP + WNN clusters
  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'umap',
      coordinates,
      clusters,
      nClusters,
      nCells,
      source: 'wnn',
      multiomeModality: 'atac',
    },
  });

  post('WNN integration complete.');
}

function simpleKmeans(points, k, maxIters = 50) {
  const n = points.length;
  if (n === 0 || k <= 0) return [];
  const dim = points[0].length;
  const centroids = [];
  const used = new Set();
  for (let i = 0; i < k; i++) {
    let idx = Math.floor(Math.random() * n);
    while (used.has(idx)) idx = Math.floor(Math.random() * n);
    used.add(idx);
    centroids.push(points[idx].slice());
  }
  const labels = new Array(n);
  for (let iter = 0; iter < maxIters; iter++) {
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        let d = 0;
        for (let d_ = 0; d_ < dim; d_++) {
          const diff = points[i][d_] - centroids[c][d_];
          d += diff * diff;
        }
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      labels[i] = best;
      for (let d_ = 0; d_ < dim; d_++) sums[best][d_] += points[i][d_];
      counts[best]++;
    }
    let changed = false;
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let d_ = 0; d_ < dim; d_++) {
        const newVal = sums[c][d_] / counts[c];
        if (Math.abs(centroids[c][d_] - newVal) > 1e-6) changed = true;
        centroids[c][d_] = newVal;
      }
    }
    if (!changed) break;
  }
  return labels;
}

/**
 * Pure-JavaScript pipeline for very large datasets (>250K cells).
 *
 * Bypasses bakana/scran WASM entirely to avoid the 4 GB WASM memory limit.
 * Instead, uses h5wasm (separate WASM module) to parse the HDF5 file,
 * then runs normalization, HVG selection, SVD/PCA, UMAP, and Louvain
 * clustering all in JavaScript, the same pattern as the scATAC pipeline
 * but with log-normalization instead of TF-IDF.
 *
 * Pipeline: H5→CSC → QC filter → log-normalize → HVG → SVD → UMAP → SNN → Louvain
 */

/**
 * Build k-NN in 2D using a grid spatial index. Zero heap allocations per query.
 * Used for clustering after UMAP projection, 2D k-NN is exact and fast (no
 * curse of dimensionality).
 *
 * @param {Array<[number,number]>} coords: UMAP coordinates, one [x,y] per cell
 * @param {number} k: number of neighbors
 * @returns {{ indices: Int32Array, distances: Float64Array, k: number }}
 */
function buildKnn2DGrid(coords, k) {
  const n = coords.length;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = coords[i];
    if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
  }
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  // ~4 cells per grid cell on average; minimum 10
  const gridSize = Math.max(10, Math.ceil(Math.sqrt(n / 4)));
  const cellW = rangeX / gridSize;
  const cellH = rangeY / gridSize;

  // Build grid: key = gx * gridSize + gy → array of cell indices
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const c = coords[i];
    const gx = Math.min(gridSize - 1, Math.floor((c[0] - minX) / cellW));
    const gy = Math.min(gridSize - 1, Math.floor((c[1] - minY) / cellH));
    const key = gx * gridSize + gy;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }

  const flatIdx = new Int32Array(n * k);
  const flatDist = new Float64Array(n * k);

  // Reusable candidate buffers, avoids per-cell allocations
  const distBuf = new Float64Array(4096);
  const idxBuf = new Int32Array(4096);

  for (let i = 0; i < n; i++) {
    const cx = coords[i][0], cy = coords[i][1];
    const gx = Math.min(gridSize - 1, Math.floor((cx - minX) / cellW));
    const gy = Math.min(gridSize - 1, Math.floor((cy - minY) / cellH));

    // Expand grid search radius until we have ≥ k candidates
    let nCandidates = 0;
    for (let radius = 0; nCandidates < k && radius <= gridSize; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
          const pts = grid.get(nx * gridSize + ny);
          if (!pts) continue;
          for (const j of pts) {
            if (j === i) continue;
            const d = (cx - coords[j][0]) ** 2 + (cy - coords[j][1]) ** 2;
            distBuf[nCandidates] = d;
            idxBuf[nCandidates] = j;
            nCandidates++;
            if (nCandidates >= distBuf.length) break; // safety, expand next iter
          }
          if (nCandidates >= distBuf.length) break;
        }
        if (nCandidates >= distBuf.length) break;
      }
    }

    // Selection: find top-k by repeated minimum scan (O(nCandidates×k), zero alloc)
    const off = i * k;
    for (let j = 0; j < k; j++) {
      let bestD = Infinity, bestI = 0, bestB = -1;
      for (let b = 0; b < nCandidates; b++) {
        if (distBuf[b] < bestD) { bestD = distBuf[b]; bestI = idxBuf[b]; bestB = b; }
      }
      flatIdx[off + j] = bestI;
      flatDist[off + j] = bestD;
      if (bestB >= 0) distBuf[bestB] = Infinity; // mark used
    }
  }

  return { indices: flatIdx, distances: flatDist, k };
}

async function runLargeDatasetJsPipeline(dataset, baseParams, { labelPrefix = 'large', isSpatialModality = false, preservedBarcodes = null } = {}) {
  const post = (msg) => self.postMessage({ type: 'STATUS_UPDATE', message: msg });

  // Step 1: Streaming H5 → HVG-only normalised matrix
  post('Step 1/4: Reading HDF5 & building HVG matrix (streaming, 2-pass)…');

  // Determine H5 input: lazy-mounted filename (large files) or in-memory blob (small files)
  let h5Input; // string (already-mounted path) or Uint8Array (bytes)
  if (loadedData.h5LazyTmpFile) {
    // Large file: already mounted via FS.createLazyFile, pass the filename directly
    h5Input = loadedData.h5LazyTmpFile;
  } else {
    const h5Blob = loadedData.h5Blob;
    if (!h5Blob) {
      throw new Error('H5 blob not available, pure-JS pipeline requires an HDF5 file');
    }
    let h5ArrayBuf = await h5Blob.arrayBuffer();
    h5Input = new Uint8Array(h5ArrayBuf);
    h5ArrayBuf = null;
    loadedData.h5Blob = null;
  }

  const { readH5StreamingPipeline } = await import('../scatac/h5sparse.js');
  const streamResult = await readH5StreamingPipeline(h5Input, post, {
    nTopGenes: 2000,
    minGenesPerCell: 200,
    scaleFactor: 1e4,
  });
  h5Input = null;

  const {
    normMatrix: hvgMatrix,
    hvgGeneNames, hvgGeneIds,
    allGeneNames, allGeneIds,
    cellBarcodes: filteredBarcodes,
    keptCellIndices, cellTotals, keepCellFlags,
    nOrigCells, nOrigGenes,
    hvgIndices, origToHvg,
    h5TmpFile,
  } = streamResult;


  // Store metadata for gene-expression queries
  loadedData.jsGeneNames      = allGeneNames;
  loadedData.jsGeneIds        = allGeneIds;
  loadedData.jsOrigToHvg      = origToHvg;
  loadedData.jsHvgIndices     = hvgIndices;
  loadedData.jsCellTotals     = cellTotals;
  loadedData.jsKeepCellFlags  = keepCellFlags;
  loadedData.jsNOrigCells     = nOrigCells;
  loadedData.jsH5TmpFile      = h5TmpFile;

  const nCells = hvgMatrix.ncols;
  const nGenes = nOrigGenes;

  // Step 2: PCA
  post(`Step 2/4: Computing PCA (50 components) on ${nCells.toLocaleString()} cells…`);
  const { runPCA } = await import('../scatac/svd.js');

  function seededRandom(seed) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const random = seededRandom(42);

  const nPCAComponents = 50;
  const pcaResult = await runPCA(hvgMatrix, nPCAComponents, 20, 5, true, post, random);

  // Step 3: UMAP
  loadedData.jsFilteredBarcodes = filteredBarcodes;
  loadedData.jsNormMatrix = null;

  // Free HVG sparse matrix data (~1.77 GB), the local `hvgMatrix` const still
  // holds a reference even though loadedData.jsNormMatrix is null.
  // Null out the heavy typed arrays inside the object to actually release memory.
  hvgMatrix.values  = null;
  hvgMatrix.rowIdx  = null;
  hvgMatrix.colPtr  = null;

  const pcaNcells = pcaResult.nCells;
  const pcaNcomps = pcaResult.nComponents;
  let pcaEmbeddings = pcaResult.cellEmbeddings; // Float64Array (~516 MB for 1.3M cells × 50 dims)

  // For very large datasets, reduce dimensions to prevent OOM in UMAP
  // Using first 20 PCs captures ~80-90% of variance and significantly reduces memory
  const umapDims = pcaNcells > 250000 ? 20 : pcaNcomps;

  // Build UMAP input with reduced dimensions for memory efficiency.
  // Use Float32Array (not Float64), halves per-row memory (~103 MB vs ~206 MB for 1.3M×20).
  // Float32 precision is sufficient for UMAP's stochastic algorithm.
  const umapInput = new Array(pcaNcells);
  for (let i = 0; i < pcaNcells; i++) {
    const offset = i * pcaNcomps; // Source stride is still full PCA components
    const row = new Float32Array(umapDims);
    for (let d = 0; d < umapDims; d++) {
      row[d] = pcaEmbeddings[offset + d];
    }
    umapInput[i] = row;
  }

  // Build pcColMajor here (before UMAP) from the same data as umapInput, using Float32.
  // This lets us free the large pcaEmbeddings before the memory-intensive UMAP step.
  // (If we built it after UMAP from pcaEmbeddings the local var would keep 516 MB alive.)
  const pcColMajor = new Float32Array(pcaNcells * umapDims);
  for (let i = 0; i < pcaNcells; i++) {
    const row = umapInput[i];
    for (let d = 0; d < umapDims; d++) {
      pcColMajor[d * pcaNcells + i] = row[d];
    }
  }

  // Free pcaEmbeddings, must null BOTH the object property AND the local variable
  // so V8's GC can collect the ~516 MB Float64Array before UMAP starts.
  pcaResult.cellEmbeddings = null;
  pcaEmbeddings = null;

  const { UMAP } = await import('umap-js');
  const umapMinDist = baseParams?.umap?.min_dist || 0.1;

  // umap-js builds O(sqrt(n)) random projection trees with O(n) nodes each.
  // For >500K cells this exhausts the V8 heap before a single epoch runs.
  // Solution: fit UMAP on a representative sample, project remaining cells
  // via umap.transform(), then build exact 2D k-NN for clustering (grid index).
  const UMAP_SAMPLE_THRESHOLD = 500_000;
  const UMAP_SAMPLE_SIZE = 200_000;

  let umapCoords;
  let kNeighbors;
  let flatIndices;
  let flatDistances;

  if (pcaNcells <= UMAP_SAMPLE_THRESHOLD) {
    // Full fit: all cells in umap-js
    const umapNeighbors = pcaNcells > 250000 ? 12 : Math.min(baseParams?.umap?.num_neighbors || 15, 15);
    const umapEpochs = pcaNcells > 300000 ? 200 : 250;
    post(`Step 3/4: Running UMAP on ${pcaNcells.toLocaleString()} cells…`);

    const umap = new UMAP({ nNeighbors: umapNeighbors, minDist: umapMinDist, nComponents: 2, nEpochs: umapEpochs, random });
    umapCoords = umap.fit(umapInput);
    umapInput.length = 0;

    // Extract k-NN computed by umap-js NN-descent for clustering
    const rawKnnIdx = umap.knnIndices;
    const rawKnnDist = umap.knnDistances;
    kNeighbors = rawKnnIdx[0].length;
    flatIndices = new Int32Array(pcaNcells * kNeighbors);
    flatDistances = new Float64Array(pcaNcells * kNeighbors);
    for (let i = 0; i < pcaNcells; i++) {
      const off = i * kNeighbors;
      for (let j = 0; j < kNeighbors; j++) {
        flatIndices[off + j] = rawKnnIdx[i][j];
        flatDistances[off + j] = rawKnnDist[i][j];
      }
    }

  } else {
    // Very large: sample → fit → transform remaining
    const sampleSize = Math.min(UMAP_SAMPLE_SIZE, pcaNcells);
    // Evenly-spaced indices give good coverage across cell ordering
    const sampleIndices = new Int32Array(sampleSize);
    const step = (pcaNcells - 1) / (sampleSize - 1);
    for (let si = 0; si < sampleSize; si++) sampleIndices[si] = Math.round(si * step);
    const sampleSet = new Set(sampleIndices);

    const sampleInput = Array.from(sampleIndices, idx => umapInput[idx]);

    post(`Step 3/4: UMAP on ${sampleSize.toLocaleString()} representative cells (${pcaNcells.toLocaleString()} total)…`);

    const umap = new UMAP({ nNeighbors: 15, minDist: umapMinDist, nComponents: 2, nEpochs: 200, random });
    const sampleCoords = umap.fit(sampleInput);
    // NOTE: do NOT clear sampleInput, umap.fit() stores a reference to it as this.X,
    // and umap.transform() checks this.X.length to verify data has been fit.

    // Allocate full coords array; sample cells get direct coords
    umapCoords = new Array(pcaNcells);
    for (let si = 0; si < sampleSize; si++) umapCoords[sampleIndices[si]] = sampleCoords[si];

    // Project non-sample cells via umap.transform() in small batches.
    // umap.transform() uses the trained RP trees, O(batch × log(sampleSize)) per call.
    const TRANSFORM_BATCH = 2000;
    let batch = [], batchCellIdxs = [], nProjected = 0;
    for (let i = 0; i < pcaNcells; i++) {
      if (!sampleSet.has(i)) {
        batch.push(umapInput[i]);
        batchCellIdxs.push(i);
      }
      const flush = batch.length === TRANSFORM_BATCH || (i === pcaNcells - 1 && batch.length > 0);
      if (flush) {
        const proj = umap.transform(batch);
        for (let b = 0; b < proj.length; b++) umapCoords[batchCellIdxs[b]] = proj[b];
        nProjected += batch.length;
        if (Math.floor(nProjected / 100_000) !== Math.floor((nProjected - batch.length) / 100_000)) {
          post(`Projecting cells: ${nProjected.toLocaleString()} / ${(pcaNcells - sampleSize).toLocaleString()}…`);
        }
        batch = []; batchCellIdxs = [];
      }
    }
    umapInput.length = 0;

    // Build exact 2D k-NN from UMAP coords for clustering.
    // 2D grid search has no curse-of-dimensionality and perfectly aligns clusters
    // with what the user sees in the UMAP plot.
    post('Building 2D k-NN from UMAP for clustering…');
    kNeighbors = 15;
    const knn2d = buildKnn2DGrid(umapCoords, kNeighbors);
    flatIndices = knn2d.indices;
    flatDistances = knn2d.distances;
  }

  // Step 4: Clustering via scran.js SNN graph
  post(`Step 4/4: Clustering ${pcaNcells.toLocaleString()} cells…`);

  const algo = (baseParams?.snn_graph_cluster?.algorithm || 'multilevel').toLowerCase();
  let resolution;
  if (algo === 'leiden') {
    resolution = baseParams?.snn_graph_cluster?.leiden_resolution ?? 1.0;
  } else {
    resolution = baseParams?.snn_graph_cluster?.multilevel_resolution ?? 1.0;
  }

  const runs = new Int32Array(pcaNcells).fill(kNeighbors);

  let knnResults = null;
  let snnGraph = null;
  let clusterResult = null;
  let clusterArray;

  try {
    post('Building SNN graph from UMAP neighbors…');
    // Reconstruct scran.js FindNearestNeighborsResults from umap-js k-NN
    knnResults = scran.FindNearestNeighborsResults.unserialize(runs, flatIndices, flatDistances);

    snnGraph = scran.buildSnnGraph(knnResults, { scheme: 'rank' });

    post(`Clustering (${algo}, resolution=${resolution})…`);
    if (algo === 'leiden') {
      clusterResult = scran.clusterGraph(snnGraph, {
        method: 'leiden',
        leidenResolution: resolution,
        leidenModularityObjective: true,
      });
    } else {
      clusterResult = scran.clusterGraph(snnGraph, {
        method: 'multilevel',
        multiLevelResolution: resolution,
      });
    }

    const membership = clusterResult.membership();
    clusterArray = Array.from(membership);
  } finally {
    if (clusterResult) try { clusterResult.free(); } catch (_) {}
    if (snnGraph) try { snnGraph.free(); } catch (_) {}
    if (knnResults) try { knnResults.free(); } catch (_) {}
  }

  const nClusters = new Set(clusterArray).size;

  // Store PCA col-major (already built above, before UMAP, from umapInput rows)
  loadedData.jsPcaColMajor = pcColMajor;
  loadedData.jsPcaNcells = pcaNcells;
  loadedData.jsPcaNcomps = umapDims;
  loadedData.jsKNeighbors = kNeighbors;

  // Store results
  currentResults.umap = umapCoords;
  currentResults.clusters = clusterArray;

  loadedData.nCells       = nCells;
  loadedData.nGenes       = nGenes;
  loadedData.rawCells     = nOrigCells;
  loadedData.rawGenes     = nOrigGenes;
  loadedData.cellBarcodes = filteredBarcodes;
  loadedData.precomputed  = { isLoaded: true };
  cachedGeneNames = null;
  cachedGeneLookup = null;
  imputedGeneCache.clear();

  postFilteredSummary({
    summary: { cells: nCells, genes: nGenes },
    force: true,
    reason: 'large-dataset-js',
  });

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'umap',
      coordinates: umapCoords,
      clusters: clusterArray,
      nClusters,
      nCells: umapCoords.length,
      source: 'js-hybrid',
    },
  });

}

// ---------------------------------------------------------------------------
// VisiumHD sketch-based clustering helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the loaded dataset is a single-sample Visium HD experiment
 * (either cell-segmented or binned output) with enough cells to justify sketching.
 */
function isVisiumHDData(data) {
  if (!data) return false;
  const si = data.spatialInfo;
  if (!si) return false;
  // Cell-segmented VisiumHD  (has GeoJSON cell boundaries)
  if (si.cellSegmentation) return true;
  // Binned VisiumHD (tissue_positions parquet/CSV)
  if (si.tissuePositions) return true;
  return false;
}

/**
 * Run the sketch-based UMAP + clustering pipeline for VisiumHD.
 *
 * Extracts bakana PCA coordinates, runs leverage-score sampling, fits UMAP on
 * the sketch, projects all cells, and performs SNN+Louvain clustering.
 * Results are stored in currentResults and broadcast as ANALYSIS_COMPLETE.
 *
 * @param {object} state : bakana analysis state (must have rna_pca computed)
 * @param {boolean} [sendMessage=true]
 */
async function runVisiumHDSketchPipeline(state, sendMessage = true) {
  const post = (msg) => self.postMessage({ type: 'STATUS_UPDATE', message: msg });

  if (!state || typeof state.rna_pca?.fetchPCs !== 'function') {
    console.warn('VisiumHD sketch: PCA not available, falling back to standard pipeline');
    await runClusteringAndUMAP(sendMessage);
    return;
  }

  // Extract PCA from bakana (column-major → row-major conversion)
  let pcaResult;
  try {
    pcaResult = state.rna_pca.fetchPCs();
  } catch (e) {
    console.warn('VisiumHD sketch: could not fetch PCA results:', e.message, '- falling back');
    await runClusteringAndUMAP(sendMessage);
    return;
  }

  const nPCs   = pcaResult.numberOfPCs();
  const nCells = pcaResult.numberOfCells();

  if (nCells < 2 || nPCs < 1) {
    console.warn('VisiumHD sketch: invalid PCA dimensions, falling back');
    await runClusteringAndUMAP(sendMessage);
    return;
  }

  // For rare cell type separation (e.g. podocytes), we need ≥50 PCs.
  // Podocyte markers (NPHS1/NPHS2/WT1) drive variation in PC 21–40 when
  // PCA is computed from the full 276K-cell dataset dominated by tubular cells.
  // If bakana was configured with fewer PCs, recompute with 50 now.
  const VISIUMHD_MIN_PCS = 50;
  let finalPcaResult = pcaResult;
  if (nPCs < VISIUMHD_MIN_PCS) {
    post(`VisiumHD sketch: recomputing PCA with ${VISIUMHD_MIN_PCS} dimensions for rare cell capture…`);
    try {
      const pcaParams = { ...(currentParameters?.rna_pca || {}), num_pcs: VISIUMHD_MIN_PCS };
      await state.rna_pca.compute(pcaParams);
      finalPcaResult = state.rna_pca.fetchPCs();
      // Update currentParameters so subsequent re-runs retain this setting
      if (currentParameters) {
        if (!currentParameters.rna_pca) currentParameters.rna_pca = {};
        currentParameters.rna_pca.num_pcs = finalPcaResult.numberOfPCs();
      }
    } catch (e) {
      console.warn('VisiumHD sketch: PCA recomputation failed, using original PCs:', e.message);
      finalPcaResult = pcaResult;
    }
  }

  const usedNPCs   = finalPcaResult.numberOfPCs();
  post(`VisiumHD sketch: extracting ${usedNPCs} PCA dimensions for ${nCells.toLocaleString()} cells…`);
  const colMajor = finalPcaResult.principalComponents({ copy: true });
  // bakana stores column-major: colMajor[pc + nPCs * cell]
  const pcaEmbeddings = new Float64Array(nCells * usedNPCs);
  for (let cell = 0; cell < nCells; cell++) {
    for (let pc = 0; pc < usedNPCs; pc++) {
      pcaEmbeddings[cell * usedNPCs + pc] = colMajor[pc + usedNPCs * cell];
    }
  }

  // Derive clustering resolution from the dedicated sketch_resolution key.
  // Intentionally do NOT read snn_graph_cluster here: bakana always initialises
  // leiden_resolution / multilevel_resolution to a finite number (0.4 or 1.0),
  // which would silently override the VisiumHD default.
  // sketch_resolution is only set when the user explicitly changes the resolution
  // via a chat command (updateClusteringResolution), so an absent value means
  // "user has never touched it → use the VisiumHD default of 2.5".
  const resolution = Number.isFinite(currentParameters?.sketch_resolution)
    ? currentParameters.sketch_resolution
    : 1.8;

  const nNeighbors = Math.min(
    Number.isFinite(currentParameters?.umap?.num_neighbors) ? currentParameters.umap.num_neighbors : 30,
    30,
    nCells - 1
  );

  const nSketch = Math.min(SKETCH_MIN_CELLS, nCells);

  let sketchResult;
  try {
    sketchResult = await runSketchClustering(pcaEmbeddings, nCells, usedNPCs, {
      nSketch,
      nNeighbors,
      minDist: Number.isFinite(currentParameters?.umap?.min_dist) ? currentParameters.umap.min_dist : 0.1,
      resolution,
      seed: 42,
      statusCallback: post,
    });
  } catch (sketchErr) {
    console.error('VisiumHD sketch pipeline failed:', sketchErr);
    post('Sketch analysis failed, falling back to standard UMAP/clustering…');
    await runClusteringAndUMAP(sendMessage);
    return;
  }

  const { umapCoordinates, clusters, nClusters } = sketchResult;

  // Store results
  currentResults.umap     = umapCoordinates;
  currentResults.clusters = clusters;

  // Align spatial coordinates to the filtered cell order (same logic as runClusteringAndUMAP)
  const workingSpatial = loadedData?.spatialData;
  if (workingSpatial && workingSpatial.idToCoord && loadedData?.cellBarcodes) {
    try {
      let orderedBarcodes = null;
      try {
        const annotations = state.inputs.fetchCellAnnotations();
        orderedBarcodes = extractOrderedBarcodesFromAnnotations(annotations, clusters.length);
      } catch (_) { /* fallback below */ }

      if (!orderedBarcodes) {
        const filterState = state.cell_filtering;
        if (filterState && typeof filterState.fetchKeep === 'function') {
          try {
            const keepResult = filterState.fetchKeep();
            if (keepResult) {
              let mask = typeof keepResult.array === 'function' ? keepResult.array()
                : (typeof keepResult.toArray === 'function' ? keepResult.toArray()
                : keepResult);
              if (mask && typeof mask.length === 'number') {
                const keptIndices = [];
                for (let i = 0; i < mask.length; i++) {
                  const raw = Array.isArray(mask[i]) ? mask[i][0] : mask[i];
                  if (typeof raw === 'number' ? raw !== 0 : !!raw) keptIndices.push(i);
                }
                if (keptIndices.length > 0) {
                  orderedBarcodes = keptIndices.map(idx => loadedData.cellBarcodes[idx]);
                }
              }
            }
          } catch (_) { /* ignore */ }
        }
      }

      if (!orderedBarcodes && loadedData.cellBarcodes.length === clusters.length) {
        orderedBarcodes = loadedData.cellBarcodes;
      }

      if (orderedBarcodes) {
        const resolved = mapBarcodesToCoordinates(workingSpatial, orderedBarcodes);
        workingSpatial.coordinates = resolved.coordinates;
        workingSpatial.matched     = resolved.matched;
        loadedData.spatialData     = workingSpatial;
        spatialData                = workingSpatial;
      }
    } catch (spatialErr) {
      console.warn('VisiumHD sketch: spatial coordinate alignment failed:', spatialErr.message);
    }
  }

  if (!sendMessage) return;

  const messageData = {
    type:        'umap',
    coordinates: umapCoordinates,
    clusters,
    nClusters,
    nCells,
    source:      'sketch',
  };

  if (workingSpatial && Array.isArray(workingSpatial.coordinates)) {
    messageData.spatialCoordinates = workingSpatial.coordinates;
    messageData.spatialMatched     = workingSpatial.matched;
  }

  if (currentClusterLabelMap && Object.keys(currentClusterLabelMap).length > 0) {
    messageData.clusterLabelMap = currentClusterLabelMap;
  }

  self.postMessage({ type: 'ANALYSIS_COMPLETE', data: messageData });
}

async function runFullAnalysisPipeline({ labelPrefix = 'default', stopAfterStep = null, multiomeTarget = null, atacMethod = null, clusteringResolution = null, clusteringAlgorithm = null } = {}) {
  if (!loadedData) {
    throw new Error('No data available for full analysis run');
  }

  // Standalone scATAC (MTX-loaded, no bakana): run scATAC pipeline only
  if (loadedData.info?.modality === 'atac' && loadedData.atacCountMatrix) {
    // Check for previous results, skip TF-IDF/LSI/UMAP pipeline if saved data exists
    const prevResultsAtac = loadedData.previousResults;
    if (prevResultsAtac?.umapCoordinates?.length > 0 && prevResultsAtac?.clusters?.length > 0) {
      loadedData.previousResults = null; // consume so force-reanalysis later runs fresh
      const nCells = loadedData.nCells || prevResultsAtac.umapCoordinates.length;
      const nPeaks = loadedData.nGenes || 0;
      currentResults.umap = prevResultsAtac.umapCoordinates;
      currentResults.clusters = prevResultsAtac.clusters;
      loadedData.precomputed = { isLoaded: true };
      // Ensure atacPeakNames is set so "plot <gene>" (e.g. plot ms4a1) works; runAtacPipeline is skipped so it was never set
      if (!loadedData.atacPeakNames && loadedData.peakNames?.length) loadedData.atacPeakNames = loadedData.peakNames;
      postFilteredSummary({ summary: { cells: nCells, genes: nPeaks }, force: true, reason: 'atac-previous-results' });
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: prevResultsAtac.umapCoordinates,
          clusters: prevResultsAtac.clusters,
          nClusters: prevResultsAtac.nClusters != null ? prevResultsAtac.nClusters : new Set(prevResultsAtac.clusters).size,
          nCells,
          cells: nCells,
          genes: nPeaks,
          source: 'atac',
          restoredClusterLabelMap: prevResultsAtac.clusterLabelMap || {},
          restoredClusterColorOverrides: prevResultsAtac.clusterColorOverrides || {},
        },
      });
      return;
    }
    await runAtacPipeline({ skipPostMessage: false });
    return;
  }

  // Multi-sample scATAC integration (Harmony)
  if (loadedData.info?.modality === 'atac-integration' && loadedData.atacSamples) {
    await runAtacIntegrationPipeline();
    return;
  }

  // Large files loaded via lazy HTTP streaming have no bakana dataset, they go
  // entirely through runLargeDatasetJsPipeline below.
  if (!loadedData.dataset && !loadedData.h5LazyTmpFile) {
    throw new Error('No dataset available for full analysis run');
  }

  const dataset = loadedData.dataset;
  const info = loadedData.info || {};
  const path = loadedData.path;
  const spatialInfo = loadedData.spatialInfo || null;
  let currentSpatialData = loadedData.spatialData || null;
  const preservedBarcodes = Array.isArray(loadedData.cellBarcodes) ? loadedData.cellBarcodes : null;

  // Multiome + user chose ATAC: default to the TF-IDF/LSI scATAC pipeline.
  if (info?.modality === 'multiome' && multiomeTarget === 'atac') {
    const useLsi = atacMethod !== 'bakana';
    self.postMessage({ type: 'STATUS_UPDATE', message: useLsi ? 'Running ATAC-centric full analysis (TF-IDF/LSI pipeline)...' : 'Running ATAC-centric full analysis (bakana peak-as-RNA pipeline)...' });
    if (useLsi) {
      const multiomePeak = await getMultiomePeakMatrix();
      await runAtacPipeline({ skipPostMessage: true, multiome: true, multiomePeakMatrix: multiomePeak || undefined });
      alignMultiomeAtacResultsToCanonical();
      if (loadedData.precomputed) realignMultiomeRnaPrecomputedToCurrentBarcodes();
    } else {
      await runAtacPipelineBakana({ skipPostMessage: true });
      if (loadedData.precomputed) {
        const nClusters = new Set(currentResults.clusters || []).size;
        loadedData.precomputed.atacAligned = {
          coordinates: currentResults.umap || [],
          clusters: currentResults.clusters || [],
          nClusters,
        };
        realignMultiomeRnaPrecomputedToCurrentBarcodes();
      }
    }
    const rnaAligned = loadedData.precomputed?.rnaAligned;
    const atacAligned = loadedData.precomputed?.atacAligned;
    if (rnaAligned) {
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: rnaAligned.coordinates,
          clusters: rnaAligned.clusters,
          nClusters: rnaAligned.nClusters,
          nCells: rnaAligned.coordinates.length,
          source: 'precomputed',
          multiomeModality: 'rna',
        },
      });
    }
    if (atacAligned) {
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: atacAligned.coordinates,
          clusters: atacAligned.clusters,
          nClusters: atacAligned.nClusters,
          nCells: atacAligned.coordinates.length,
          source: 'atac',
          multiomeModality: 'atac',
          cellBarcodes: Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === atacAligned.coordinates.length
            ? loadedData.cellBarcodes
            : undefined,
        },
      });
    }
    postFilteredSummary({
      summary: { cells: loadedData.nCells || 0, genes: loadedData.nGenes || 0 },
      force: true,
      reason: 'full-analysis-atac',
    });
    return;
  }

  const runPipelineAttempt = async (params, { label = labelPrefix } = {}) => {
    const prefix = label ? `[${label}] ` : '';
    if (analysisState && typeof analysisState.free === 'function') {
      try {
        analysisState.free();
      } catch (freeError) {
        console.warn('Unable to free previous analysis state before retry:', freeError);
      }
    }

    analysisState = await bakana.createAnalysis();

    await runRnaOnlyAnalysis(
      analysisState,
      { sample: dataset },
      params,
      {
        startFun: async (step) => {
          const message = `${prefix}Running ${step}...`;
          self.postMessage({
            type: 'STATUS_UPDATE',
            message,
          });
        },
        finishFun: async (step) => {
        },
        stopAfterStep,
      }
    );
  };

  const isSpatialModality = info?.modality === 'spatial';
  const baseParams = buildDefaultParameters({ fastMode: isSpatialModality });
  const largeCellCount = Number.isFinite(loadedData?.nCells) ? loadedData.nCells : 0;
  const datasetBytes = Number.isFinite(loadedData?.datasetBytes) ? loadedData.datasetBytes : 0;
  const isLargeDataset = largeCellCount >= 150000 || datasetBytes >= 40 * 1024 * 1024;
  
  // Apply speed optimizations based on dataset size
  applyFastUmapParameters(baseParams, largeCellCount);
  applyFastClusteringParameters(baseParams, largeCellCount);
  
  if (isLargeDataset) {
    applyMemoryFriendlyParameters(baseParams, {
      aggressive: largeCellCount >= 250000 || datasetBytes >= 80 * 1024 * 1024,
    });
  }
  
  // Ensure neighbor_index and umap num_neighbors are synchronized after all parameter modifications
  synchronizeNeighborCounts(baseParams);

  if (clusteringResolution != null && Number.isFinite(clusteringResolution)) {
    baseParams.snn_graph_cluster = baseParams.snn_graph_cluster || {};
    const algo = (clusteringAlgorithm || baseParams.snn_graph_cluster.algorithm || 'multilevel').toLowerCase();
    baseParams.snn_graph_cluster.algorithm = algo;
    if (algo === 'leiden') {
      baseParams.snn_graph_cluster.leiden_resolution = clusteringResolution;
    } else if (algo === 'walktrap') {
      baseParams.snn_graph_cluster.walktrap_steps = Math.max(1, Math.round(clusteringResolution));
    } else {
      baseParams.snn_graph_cluster.multilevel_resolution = clusteringResolution;
    }
  }


  // === PREVIOUS RESULTS: restore saved UMAP/clusters, run normalization only ===
  const prevResults = loadedData.previousResults;
  if (prevResults?.umapCoordinates?.length > 0 && prevResults?.clusters?.length > 0) {
    loadedData.previousResults = null; // consume so force-reanalysis later runs fresh
    const isMultiome = info?.modality === 'multiome';
    let restoredCellBarcodes = null;

    // Run normalization only so gene expression plotting works
    try {
      self.postMessage({ type: 'STATUS_UPDATE', message: 'Restoring previous results (normalizing data)...' });
      if (analysisState && typeof analysisState.free === 'function') {
        try { await analysisState.free(); } catch (_e) { /* ignore */ }
      }
      analysisState = await bakana.createAnalysis();
      const normParams = buildDefaultParameters({ fastMode: isSpatialModality });
      if (!normParams.rna_quality_control) normParams.rna_quality_control = {};
      normParams.rna_quality_control.filter_strategy = 'manual';
      normParams.rna_quality_control.detected_threshold = 0;
      normParams.rna_quality_control.sum_threshold = 0;
      await analysisState.inputs.compute({ sample: dataset }, normParams.inputs);
      await analysisState.rna_quality_control.compute(normParams.rna_quality_control);
      await analysisState.cell_filtering.compute(normParams.cell_filtering);
      await analysisState.rna_normalization.compute(normParams.rna_normalization);
      loadedData.state = analysisState;
      currentParameters = normParams;
      self.postMessage({ type: 'STATUS_UPDATE', message: 'Normalization complete, gene expression plotting ready' });
    } catch (normError) {
      console.warn('CellPilot: normalization failed for previous results; gene expression may not work:', normError);
    }

    // Build per-cell tissue coordinates from idToCoord (not Space Ranger UMAP) so spatial + DATA_LOADED
    // match a normal analysis load. The old flow hit finalizePrecomputedSpatialLoad and skipped this.
    if (isSpatialModality && !isMultiome && loadedData.spatialData?.idToCoord instanceof Map && analysisState) {
      try {
        const normMatrix = analysisState.rna_normalization.fetchNormalizedMatrix();
        const nFiltered = normMatrix.numberOfColumns ? normMatrix.numberOfColumns() : 0;
        if (nFiltered > 0) {
          const targetN = Array.isArray(prevResults.clusters) ? prevResults.clusters.length : nFiltered;

          // Best case: restore exact saved spatial order from previous session.
          if (Array.isArray(prevResults.spatialCoordinates) && prevResults.spatialCoordinates.length >= targetN && targetN > 0) {
            const finalCoords = prevResults.spatialCoordinates.slice(0, targetN).map((coord) => {
              if (!coord) return null;
              if (Array.isArray(coord)) return [coord[0], coord[1]];
              return [coord.x ?? null, coord.y ?? null];
            });
            const finalMatched = finalCoords.reduce(
              (sum, c) => sum + (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? 1 : 0),
              0
            );
            loadedData.spatialData.coordinates = finalCoords;
            loadedData.spatialData.matched = finalMatched;
            if (Array.isArray(prevResults.cellBarcodes) && prevResults.cellBarcodes.length >= targetN) {
              const exactBarcodes = prevResults.cellBarcodes.slice(0, targetN);
              loadedData.cellBarcodes = exactBarcodes;
              restoredCellBarcodes = exactBarcodes;
            }
            spatialData = loadedData.spatialData;
            validateRestoredSpatialClusterConsistency({
              context: 'previous-results restore (saved spatialCoordinates)',
              orderedBarcodes: restoredCellBarcodes || [],
              clusters: prevResults.clusters,
              resolved: {
                coordinates: finalCoords,
                matched: finalMatched,
              },
            });
          } else {
          let orderedBarcodes = null;

          // Highest priority: reuse the exact barcode order from the saved CellPilot result.
          // This guarantees spatial colors line up with restored UMAP/clusters 1:1.
          if (Array.isArray(prevResults.cellBarcodes) && prevResults.cellBarcodes.length === prevResults.umapCoordinates.length) {
            if (prevResults.cellBarcodes.length === nFiltered) {
              orderedBarcodes = prevResults.cellBarcodes;
            } else {
              console.warn(
                'CellPilot: saved barcode list length does not match current filtered cells, skipping strict saved-order restore:',
                prevResults.cellBarcodes.length,
                'vs',
                nFiltered
              );
            }
          }

          if (!orderedBarcodes) {
            orderedBarcodes = extractOrderedBarcodesFromAnnotations(
              analysisState.inputs.fetchCellAnnotations(),
              nFiltered
            );
          }
          // If annotations are unfiltered, reconstruct filtered barcode order from keep mask.
          if (!orderedBarcodes && Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length > 0) {
            const filterState = analysisState.cell_filtering;
            if (filterState && typeof filterState.fetchKeep === 'function') {
              try {
                const keepResult = filterState.fetchKeep();
                if (keepResult) {
                  let keepMask = typeof keepResult.array === 'function'
                    ? keepResult.array()
                    : (typeof keepResult.toArray === 'function' ? keepResult.toArray() : keepResult);
                  if (!Array.isArray(keepMask) && typeof keepMask?.length === 'number') {
                    keepMask = Array.from(keepMask);
                  }
                  if (Array.isArray(keepMask) && keepMask.length === loadedData.cellBarcodes.length) {
                    const kept = [];
                    for (let i = 0; i < keepMask.length; i += 1) {
                      const raw = Array.isArray(keepMask[i]) ? keepMask[i][0] : keepMask[i];
                      const keep = typeof raw === 'number' ? raw !== 0 : !!raw;
                      if (keep) {
                        kept.push(loadedData.cellBarcodes[i]);
                      }
                    }
                    if (kept.length === nFiltered) {
                      orderedBarcodes = kept;
                    }
                  }
                }
              } catch (keepMaskErr) {
                console.warn('CellPilot: failed to reconstruct filtered barcodes from keep mask:', keepMaskErr);
              }
            }
          }
          if (!orderedBarcodes && Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === nFiltered) {
            orderedBarcodes = loadedData.cellBarcodes;
          }
          if (orderedBarcodes && orderedBarcodes.length === nFiltered) {
            const resolved = mapBarcodesToCoordinates(
              loadedData.spatialData,
              orderedBarcodes,
              { allowLooseVariants: false }
            );
            if (resolved.coordinates) {
              const targetN = Array.isArray(prevResults.clusters) ? prevResults.clusters.length : resolved.coordinates.length;
              let finalCoords = resolved.coordinates;
              let finalBarcodes = orderedBarcodes;
              let finalMatched = resolved.matched;

              // Keep spatial + cluster arrays strictly aligned during previous-results restore.
              if (Number.isFinite(targetN) && targetN > 0 && resolved.coordinates.length !== targetN) {
                console.warn(
                  'CellPilot: previous-results restore length mismatch; truncating spatial mapping to cluster length:',
                  resolved.coordinates.length,
                  '->',
                  targetN
                );
                finalCoords = resolved.coordinates.slice(0, targetN);
                finalBarcodes = orderedBarcodes.slice(0, targetN);
                finalMatched = finalCoords.reduce(
                  (sum, c) => sum + (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? 1 : 0),
                  0
                );
              }

              loadedData.spatialData.coordinates = finalCoords;
              loadedData.spatialData.matched = finalMatched;
              loadedData.cellBarcodes = finalBarcodes;
              restoredCellBarcodes = finalBarcodes;
              // Build explicit expression-order -> restored-order index mapping so gene-expression
              // vectors can be remapped exactly (instead of truncating) when lengths differ.
              const sourceIndex = new Map();
              for (let i = 0; i < orderedBarcodes.length; i += 1) {
                const raw = orderedBarcodes[i];
                if (raw == null) continue;
                const key = String(raw).trim().replace(/^["']|["']$/g, '');
                if (!key) continue;
                if (!sourceIndex.has(key)) sourceIndex.set(key, i);
              }
              const remapIndices = new Int32Array(finalBarcodes.length);
              remapIndices.fill(-1);
              let remapMatched = 0;
              for (let i = 0; i < finalBarcodes.length; i += 1) {
                const variants = generateIdVariants(finalBarcodes[i]);
                let idx = -1;
                for (const v of variants) {
                  if (sourceIndex.has(v)) {
                    idx = sourceIndex.get(v);
                    break;
                  }
                }
                remapIndices[i] = idx;
                if (idx >= 0) remapMatched += 1;
              }
              loadedData.restoredExpressionSourceIndices = remapIndices;
              spatialData = loadedData.spatialData;
              validateRestoredSpatialClusterConsistency({
                context: 'previous-results restore',
                orderedBarcodes: finalBarcodes,
                clusters: prevResults.clusters,
                resolved: {
                  ...resolved,
                  coordinates: finalCoords,
                  matched: finalMatched,
                },
              });
            }
          }
          }
        }
      } catch (spatialAlignErr) {
        console.warn('CellPilot: spatial coordinate alignment for previous results failed:', spatialAlignErr);
      }
    }

    // Restore currentResults
    currentResults.umap = prevResults.umapCoordinates;
    currentResults.clusters = prevResults.clusters;
    loadedData.restoredPreviousResults = {
      umapCoordinates: Array.isArray(prevResults.umapCoordinates) ? prevResults.umapCoordinates : null,
      spatialCoordinates: Array.isArray(loadedData?.spatialData?.coordinates) ? loadedData.spatialData.coordinates : (Array.isArray(prevResults.spatialCoordinates) ? prevResults.spatialCoordinates : null),
      cellBarcodes: Array.isArray(restoredCellBarcodes) ? restoredCellBarcodes : (Array.isArray(prevResults.cellBarcodes) ? prevResults.cellBarcodes : null),
    };
    if (prevResults.regionClusters?.length > 0) {
      currentResults.regionClusters = prevResults.regionClusters;
    }
    const nCellsResult = prevResults.nCells || prevResults.umapCoordinates.length;
    const nClusters = prevResults.nClusters != null ? prevResults.nClusters : new Set(prevResults.clusters).size;

    if (isMultiome) {
      loadedData.precomputed = {
        isLoaded: true,
        rnaAligned: { coordinates: prevResults.umapCoordinates, clusters: prevResults.clusters, nClusters },
      };
      if (prevResults.atacUmapCoordinates?.length > 0 && prevResults.atacClusters?.length > 0) {
        const atacNC = prevResults.atacNClusters != null ? prevResults.atacNClusters : new Set(prevResults.atacClusters).size;
        loadedData.precomputed.atacAligned = {
          coordinates: prevResults.atacUmapCoordinates,
          clusters: prevResults.atacClusters,
          nClusters: atacNC,
        };
      }
      // Restore saved peak-gene links so "show links for X" works without re-running LinkPeaks
      if (Array.isArray(prevResults.peakGeneLinks) && prevResults.peakGeneLinks.length > 0) {
        loadedData.peakGeneLinks = prevResults.peakGeneLinks;
        const nGenesLinked = new Set(prevResults.peakGeneLinks.map(l => l.gene)).size;
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: {
            type: 'link_peaks',
            nLinks: prevResults.peakGeneLinks.length,
            nGenesLinked,
            restored: true,
            message: `Restored ${prevResults.peakGeneLinks.length} saved peak–gene links (${nGenesLinked} genes) from previous session.`,
          },
        });
      }
    } else {
      loadedData.precomputed = { isLoaded: true };
    }

    // Keep DATA_LOADED counts consistent with restored previous-results arrays.
    postFilteredSummary({
      force: true,
      reason: 'previous-results',
      summary: { cells: nCellsResult, genes: loadedData.nGenes || 0 },
    });

    // Determine if this was a WNN run and all individual panels are available
    const wasWnn = isMultiome && prevResults.wnnActive &&
      prevResults.wnnRnaCoordinates?.length > 0 && prevResults.wnnRnaClusters?.length > 0 &&
      prevResults.wnnAtacCoordinates?.length > 0 && prevResults.wnnAtacClusters?.length > 0;

    if (wasWnn) {
      // Restore WNN individual RNA UMAP first
      const wnnRnaNC = prevResults.wnnRnaNClusters != null ? prevResults.wnnRnaNClusters : new Set(prevResults.wnnRnaClusters).size;
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: prevResults.wnnRnaCoordinates,
          clusters: prevResults.wnnRnaClusters,
          nClusters: wnnRnaNC,
          nCells: prevResults.wnnRnaCoordinates.length,
          source: 'wnn-individual',
          multiomeModality: 'rna',
        },
      });
      // Restore WNN individual ATAC UMAP
      const wnnAtacNC = prevResults.wnnAtacNClusters != null ? prevResults.wnnAtacNClusters : new Set(prevResults.wnnAtacClusters).size;
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: prevResults.wnnAtacCoordinates,
          clusters: prevResults.wnnAtacClusters,
          nClusters: wnnAtacNC,
          nCells: prevResults.wnnAtacCoordinates.length,
          source: 'wnn-individual',
          multiomeModality: 'atac',
        },
      });
      // Restore WNN integrated RNA (source: 'wnn' activates 3-panel layout)
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: prevResults.umapCoordinates,
          clusters: prevResults.clusters,
          nClusters,
          nCells: nCellsResult,
          source: 'wnn',
          multiomeModality: 'rna',
          restoredClusterLabelMap: prevResults.clusterLabelMap || {},
          restoredClusterColorOverrides: prevResults.clusterColorOverrides || {},
          restoredAgentClusterAnnotations: prevResults.agentClusterAnnotations || [],
        },
      });
      // Restore WNN integrated ATAC
      if (prevResults.atacUmapCoordinates?.length > 0 && prevResults.atacClusters?.length > 0) {
        const atacNC = prevResults.atacNClusters != null ? prevResults.atacNClusters : new Set(prevResults.atacClusters).size;
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: {
            type: 'umap',
            coordinates: prevResults.atacUmapCoordinates,
            clusters: prevResults.atacClusters,
            nClusters: atacNC,
            nCells: prevResults.atacUmapCoordinates.length,
            source: 'wnn',
            multiomeModality: 'atac',
          },
        });
      }
    } else {
      // Post RNA UMAP ANALYSIS_COMPLETE
      const restoredMsg = {
        type: 'umap',
        coordinates: prevResults.umapCoordinates,
        clusters: prevResults.clusters,
        nClusters,
        nCells: nCellsResult,
        source: 'precomputed',
        ...(isMultiome ? { multiomeModality: 'rna' } : {}),
        restoredClusterLabelMap: prevResults.clusterLabelMap || {},
        restoredClusterColorOverrides: prevResults.clusterColorOverrides || {},
        restoredAgentClusterAnnotations: prevResults.agentClusterAnnotations || [],
      };
      if (prevResults.regionClusters?.length > 0) {
        restoredMsg.restoredRegionData = {
          regionClusters: prevResults.regionClusters,
          coordinates: prevResults.regionCoordinates || prevResults.umapCoordinates,
          regionNclusters: prevResults.regionNclusters || new Set(prevResults.regionClusters.filter(r => r >= 0)).size,
          regionSpatialCoordinates: prevResults.regionSpatialCoordinates,
          regionBanksyParams: prevResults.regionBanksyParams,
          regionLabelMap: prevResults.regionLabelMap || {},
        };
      }
      if (isSpatialModality && !isMultiome && Array.isArray(loadedData.spatialData?.coordinates)) {
        restoredMsg.spatialCoordinates = loadedData.spatialData.coordinates;
        if (Number.isFinite(loadedData.spatialData.matched)) {
          restoredMsg.spatialMatched = loadedData.spatialData.matched;
        }
      }
      if (Array.isArray(restoredCellBarcodes) && restoredCellBarcodes.length === restoredMsg.coordinates.length) {
        restoredMsg.cellBarcodes = restoredCellBarcodes;
      }
      self.postMessage({ type: 'ANALYSIS_COMPLETE', data: restoredMsg });

      // For multiome: also post ATAC ANALYSIS_COMPLETE
      if (isMultiome && prevResults.atacUmapCoordinates?.length > 0 && prevResults.atacClusters?.length > 0) {
        const atacNC = prevResults.atacNClusters != null ? prevResults.atacNClusters : new Set(prevResults.atacClusters).size;
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: {
            type: 'umap',
            coordinates: prevResults.atacUmapCoordinates,
            clusters: prevResults.atacClusters,
            nClusters: atacNC,
            nCells: prevResults.atacUmapCoordinates.length,
            source: 'atac',
            multiomeModality: 'atac',
          },
        });
      }
    }

    return;
  }
  // === END PREVIOUS RESULTS ===

  // === LARGE DATASET HYBRID PATH ===
  // For very large datasets (>250K cells), the full bakana pipeline crashes WASM because
  // neighbor_index + UMAP + clustering together exceed the 4 GB WASM memory limit.
  // Solution: parse H5 in JS, then run normalization, SVD, UMAP, clustering all in
  // pure JavaScript, bypassing bakana/scran WASM entirely.
  // Small datasets (< 250K cells AND < 2 GB) always use the normal bakana WASM pipeline.
  //
  // EXCEPTION: Precomputed spatial modalities (Xenium, MERFISH, Visium-HD) have small gene
  // panels (300–1000 genes) so bakana WASM handles even 250K+ cells efficiently. More
  // importantly, Xenium data is often loaded as MatrixMarket (no H5 blob), which the
  // pure-JS pipeline cannot read. Always use the normal bakana path for spatial data.
  const isPrecomputedSpatialRerun = isSpatialModality && !!loadedData?.precomputed;
  const isVeryLargeDataset = !isPrecomputedSpatialRerun &&
    (largeCellCount >= 250000 || datasetBytes >= 2 * 1024 * 1024 * 1024);
  if (isVeryLargeDataset && !stopAfterStep) {
    self.postMessage({
      type: 'STATUS_UPDATE',
      message: `Large dataset (${largeCellCount.toLocaleString()} cells), using optimized hybrid pipeline...`,
    });

    try {
      // Reset the wasmAbortSent flag
      wasmAbortSent = false;

      await runLargeDatasetJsPipeline(dataset, baseParams, {
        labelPrefix,
        isSpatialModality,
        preservedBarcodes,
      });
      return;
    } catch (hybridError) {
      if (isWasmAbort(hybridError)) {
        const cellCountStr = largeCellCount > 0 ? ` Current dataset: ${largeCellCount.toLocaleString()} cells.` : '';
        throw new Error(WASM_OOM_MESSAGE + cellCountStr);
      }
      console.error('Hybrid JS pipeline failed:', hybridError);
      // For truly large datasets (>250K cells), falling back to full WASM will also OOM.
      // Only fall back for border-case datasets where WASM might still work.
      if (largeCellCount >= 250000) {
        throw new Error(
          `Large dataset analysis failed: ${hybridError.message}. ` +
          `Dataset has ${largeCellCount.toLocaleString()} cells which exceeds WASM capacity.`
        );
      }
      console.warn('Falling back to full WASM pipeline for border-case dataset...');
      // Fall through to try the full WASM pipeline as last resort
    }
  }
  // === END LARGE DATASET HYBRID PATH ===

  let pipelineError = null;
  try {
    await runPipelineAttempt(baseParams, { label: labelPrefix });
  } catch (error) {
    pipelineError = error;
    console.error('Initial analysis pipeline failed:', error);
  }

  // Detect WASM abort, this is FATAL, the WASM module is now broken and cannot be reused.
  // Throw a clear error message so the user understands what happened.
  if (pipelineError && isWasmAbort(pipelineError)) {
    const cellCountStr = largeCellCount > 0 ? ` (${largeCellCount.toLocaleString()} cells)` : '';
    console.error(`WASM abort detected${cellCountStr}. Dataset exceeds WASM 4 GB memory limit.`);
    throw new Error(
      WASM_OOM_MESSAGE +
      (largeCellCount > 0 ? ` Current dataset: ${largeCellCount.toLocaleString()} cells.` : '')
    );
  }

  if (pipelineError && isInvalidTypedArrayLength(pipelineError)) {
    console.warn('Encountered typed array length error; retrying with approximate neighbors and reduced dimensionality.');
    self.postMessage({
      type: 'STATUS_UPDATE',
      message: 'Retrying analysis with memory-friendly settings...',
    });

    const fallbackParams = buildDefaultParameters({ fastMode: true, aggressive: true });
    applyMemoryFriendlyParameters(fallbackParams, { aggressive: true });

    if (typeof bakana.configureApproximateNeighbors === 'function') {
      bakana.configureApproximateNeighbors(fallbackParams, true);
    } else if (fallbackParams?.neighbor_index) {
      fallbackParams.neighbor_index.approximate = true;
    }

    if (fallbackParams?.umap) {
      const umapNeighbors = Math.min(
        Number.isFinite(fallbackParams.umap.num_neighbors) ? fallbackParams.umap.num_neighbors : 15,
        15
      );
      fallbackParams.umap.num_neighbors = umapNeighbors;
    }
    
    // Note: When approximate=true (which is set above), neighbor_index doesn't accept 'k' parameter.
    // The neighbor count will be inferred from UMAP's num_neighbors automatically.
    // Only set 'k' if approximate is false.
    if (fallbackParams?.neighbor_index && !fallbackParams.neighbor_index.approximate) {
      const neighborCount = fallbackParams.umap?.num_neighbors || 15;
      fallbackParams.neighbor_index.k = neighborCount;
    }

    if (fallbackParams?.rna_pca) {
      const maxPcs = Number.isFinite(fallbackParams.rna_pca.num_pcs) ? fallbackParams.rna_pca.num_pcs : 50;
      fallbackParams.rna_pca.num_pcs = Math.min(maxPcs, 50);
    }

    try {
      await runPipelineAttempt(fallbackParams, { label: 'approximate-neighbors' });
      pipelineError = null;
    } catch (fallbackError) {
      console.error('Fallback analysis also failed:', fallbackError);
      pipelineError = fallbackError;
    }
  }

  // Check for WASM abort after all retry attempts, this is fatal
  if (pipelineError && isWasmAbort(pipelineError)) {
    const cellCountStr = largeCellCount > 0 ? ` Current dataset: ${largeCellCount.toLocaleString()} cells.` : '';
    throw new Error(WASM_OOM_MESSAGE + cellCountStr);
  }

  if (pipelineError) {
    throw pipelineError;
  }

  currentParameters = cloneStepParameters(bakana.retrieveParameters(analysisState));

  const countMatrix = analysisState.inputs.fetchCountMatrix();
  const available = countMatrix.available();
  const rnaMatrix = countMatrix.get(available[0]); // Usually 'RNA'
  const nCells = rnaMatrix.numberOfColumns();
  const nGenes = rnaMatrix.numberOfRows();

  loadedData.state = analysisState;
  loadedData.nCells = nCells;
  loadedData.nGenes = nGenes;
  loadedData.rawCells = nCells;
  loadedData.rawGenes = nGenes;
  if (!loadedData.cellBarcodes && preservedBarcodes) {
    loadedData.cellBarcodes = preservedBarcodes;
  }
  // Preserve precomputed data for multiome (it has precomputed RNA/ATAC UMAPs and clusters)
  if (loadedData.info?.modality !== 'multiome') {
    loadedData.precomputed = null;
  }
  cachedGeneNames = null;
  cachedGeneLookup = null;
  imputedGeneCache.clear();

  // For ATAC data, try to extract barcodes from the analysis state if not already set
  if (!loadedData.cellBarcodes || loadedData.cellBarcodes.length !== nCells) {
    try {
      // Try from cell annotations
      const annotations = analysisState.inputs.fetchCellAnnotations();
      if (annotations) {
        // Try rowNames
        if (typeof annotations.rowNames === 'function') {
          const rows = annotations.rowNames();
          if (Array.isArray(rows) && rows.length === nCells) {
            loadedData.cellBarcodes = rows;
          }
        }
        // Try column
        if (!loadedData.cellBarcodes && typeof annotations.column === 'function') {
          const cellIdCandidates = ['cell_id', 'barcode', 'cell', 'id', 'CellID', 'Barcode', 'barcodes'];
          for (const candidate of cellIdCandidates) {
            try {
              if (annotations.hasColumn && annotations.hasColumn(candidate)) {
                const col = annotations.column(candidate);
                if (col && col.length === nCells) {
                  loadedData.cellBarcodes = Array.from(col);
                  break;
                }
              }
            } catch (e) {
              // Column doesn't exist, try next
            }
          }
        }
      }

      // Try from matrix column names
      if (!loadedData.cellBarcodes) {
        const primary = rnaMatrix;
        if (typeof primary.columnNames === 'function') {
          const colNames = primary.columnNames();
          if (colNames && colNames.length === nCells) {
            loadedData.cellBarcodes = Array.from(colNames);
          }
        }
      }

      // Last resort: generate synthetic barcodes
      if (!loadedData.cellBarcodes) {
        loadedData.cellBarcodes = Array.from({ length: nCells }, (_, i) => `cell_${i}`);
      }
    } catch (e) {
      console.warn('Failed to extract barcodes:', e.message);
      // Generate synthetic barcodes as fallback
      loadedData.cellBarcodes = Array.from({ length: nCells }, (_, i) => `cell_${i}`);
    }
  }

  if (isSpatialModality) {
    let workingSpatial = currentSpatialData || loadedData.spatialData || null;
    if (!workingSpatial && spatialInfo) {
      workingSpatial = await parseSpatialData(spatialInfo);
    }
    if (workingSpatial) {
      let barcodes = loadedData.cellBarcodes;
      if (!barcodes || barcodes.length !== nCells) {
        const primary = rnaMatrix;
        try {
          if (!barcodes && typeof primary.columnNames === 'function') {
            barcodes = primary.columnNames();
          } else if (!barcodes && typeof primary.column_names === 'function') {
            barcodes = primary.column_names();
          } else if (!barcodes && primary.colnames) {
            barcodes = primary.colnames();
          }
        } catch (colNameError) {
          console.warn('Failed to obtain barcodes directly from matrix:', colNameError);
        }

        if (!barcodes || !barcodes.length) {
          try {
            const annotations = analysisState.inputs.fetchCellAnnotations();
            if (annotations) {
              if (typeof annotations.rowNames === 'function') {
                const rows = annotations.rowNames();
                if (Array.isArray(rows) && rows.length === nCells) {
                  barcodes = rows;
                }
              }
              if ((!barcodes || !barcodes.length) && typeof annotations.column === 'function' && typeof annotations.hasColumn === 'function') {
                const cellIdCandidates = ['cell_id', 'barcode', 'cell', 'id', 'CellID', 'Barcode'];
                for (const candidate of cellIdCandidates) {
                  if (annotations.hasColumn(candidate)) {
                    const columnValues = annotations.column(candidate);
                    if (columnValues) {
                      let arrayValues;
                      if (typeof columnValues.toArray === 'function') {
                        arrayValues = columnValues.toArray();
                      } else if (typeof columnValues.values === 'function') {
                        arrayValues = Array.from(columnValues.values());
                      } else {
                        arrayValues = Array.from(columnValues);
                      }
                      if (arrayValues.length === nCells) {
                        barcodes = arrayValues;
                        break;
                      }
                    }
                  }
                }
              }
            }
          } catch (annotationError) {
            console.warn('Failed to obtain barcodes from annotations:', annotationError);
          }
        }

        if (!barcodes || !barcodes.length) {
          console.warn('Falling back to sequential indices for spatial alignment');
          barcodes = Array.from({ length: nCells }, (_, i) => String(i));
        }
      }

      const aligned = alignSpatialArtifacts(workingSpatial, Array.isArray(barcodes) ? Array.from(barcodes) : []);
      let finalCoordinates = aligned.coordinates;
      let finalMatched = aligned.matched;

      // CosMX fallback: when key matching yields 0 matches, use metadata coordinates by row order
      // (assume metadata and counts share same row order up to min length)
      if (finalMatched === 0 && Array.isArray(workingSpatial.coordinatesInMetadataOrder)) {
        const metaCoords = workingSpatial.coordinatesInMetadataOrder;
        const nBarcodes = Array.isArray(barcodes) ? barcodes.length : 0;
        if (metaCoords.length > 0 && nBarcodes > 0) {
          const n = Math.min(metaCoords.length, nBarcodes);
          finalCoordinates = Array.from({ length: nBarcodes }, (_, i) => (i < n ? metaCoords[i] : null));
          finalMatched = n;
        }
      }

      workingSpatial.coordinates = finalCoordinates;
      workingSpatial.matched = finalMatched;
      // Store initial barcode order so rebuild can preserve coordinates by index when idToCoord match fails (e.g. CosMX)
      workingSpatial.initialBarcodeOrder = Array.isArray(barcodes) && barcodes.length > 0 ? Array.from(barcodes) : null;
      if (!workingSpatial.precomputed) {
        workingSpatial.precomputed = {};
      }
      workingSpatial.precomputed.alignedUmap = aligned.umap;
      workingSpatial.precomputed.alignedClusters = aligned.clusters;

      if (finalMatched === 0 && aligned.unmatchedExamples.length) {
        console.error('ERROR: Zero coordinates matched!');
        console.error('Sample matrix barcodes (unmatched):', aligned.unmatchedExamples);
        if (workingSpatial.idToCoord instanceof Map) {
          console.error('Sample metadata keys:', Array.from(workingSpatial.idToCoord.keys()).slice(0, 5));
        }
      } else if (aligned.unmatchedExamples.length && finalMatched > 0) {
        console.warn('Some barcodes unmatched. Sample:', aligned.unmatchedExamples);
      }

      loadedData.spatialData = workingSpatial;
      currentResults.umap = aligned.umap ? aligned.umap.map((coord) => (Array.isArray(coord) ? coord : [NaN, NaN])) : null;
      currentResults.clusters = aligned.clusters;
      spatialData = workingSpatial; // update global so postFilteredSummary and others see it
    } else {
      console.warn('No spatial metadata available after parsing.');
      spatialData = null;
    }
  } else {
    spatialData = null;
  }

  postFilteredSummary({
    reason: labelPrefix === 'default' ? 'initial-load' : `full-analysis-${labelPrefix}`,
    force: true,
  });

  // Multiome: realign precomputed RNA/ATAC to current filtered barcode list so both views show same cells
  if (loadedData?.info?.modality === 'multiome') {
    realignMultiomePrecomputedToCurrentBarcodes();
  }

  // For multiome with precomputed data, skip runClusteringAndUMAP entirely:
  // the pipeline may have stopped early (before UMAP/clustering), and the caller
  // (loadData) sends precomputed RNA and ATAC UMAPs after aligning to filtered cell order.
  // For other modalities, suppress the message only for multiome.
  if (stopAfterStep) {
  } else if (isVisiumHDData(loadedData) && nCells >= SKETCH_MIN_CELLS && analysisState) {
    // VisiumHD with enough cells: use sketch-based UMAP + clustering for improved
    // rare-population detection (mirrors Seurat v5 SketchData / ProjectData workflow).
    await runVisiumHDSketchPipeline(analysisState, true);
  } else {
    const suppressUmapMsg = loadedData?.info?.modality === 'multiome';
    await runClusteringAndUMAP(!suppressUmapMsg);
  }

}

async function ensureAnalysisReady({ reason = 'on-demand', minimal = false } = {}) {
  if (!loadedData) {
    throw new Error('No dataset is loaded');
  }
  
  
  if (loadedData.state) {
    // Verify the state is still valid
    try {
      if (loadedData.state.rna_normalization && typeof loadedData.state.rna_normalization.fetchNormalizedMatrix === 'function') {
        return;
      } else {
        console.warn('⚠ Analysis state exists but normalized matrix not accessible, re-running normalization');
        loadedData.state = null; // Force re-normalization
      }
    } catch (verifyError) {
      console.warn('⚠ Error verifying analysis state:', verifyError);
      loadedData.state = null; // Force re-normalization
    }
  }
  
  // If multiome background normalization is in progress, await it instead of starting a new one
  if (loadedData.normalizationPromise) {
    await loadedData.normalizationPromise;
    loadedData.normalizationPromise = null;
    if (loadedData.state) {
      return;
    }
    console.warn('Multiome normalization completed but state not stored, falling through...');
  }

  // Check if normalization is in progress for precomputed data
  if (loadedData.precomputed && loadedData.dataset && !loadedData.normalizationInProgress) {
    try {
      loadedData.normalizationInProgress = true;
      await runNormalizationForPrecomputedData();
      loadedData.normalizationInProgress = false;
      if (loadedData.state) {
        return;
      } else {
        console.error('⚠ Normalization completed but state was not stored');
      }
    } catch (error) {
      loadedData.normalizationInProgress = false;
      console.error('Normalization failed, falling back to full analysis:', error);
    }
  }
  
  // Standalone scATAC (no bakana state): analysis is ready if we have atacPeakMatrix and UMAP already computed
  if (loadedData.info?.modality === 'atac' && loadedData.atacPeakMatrix) {
    const nCells = loadedData.cellBarcodes?.length ?? 0;
    if (currentResults.umap && currentResults.umap.length === nCells) {
      return;
    }
  }

  // Multi-sample ATAC integration: analysis is ready once peak matrix and UMAP are populated
  if (loadedData.info?.modality === 'atac-integration' && loadedData.atacPeakMatrix) {
    const nCells = loadedData.cellBarcodes?.length ?? 0;
    if (currentResults.umap && currentResults.umap.length === nCells) {
      return;
    }
  }

  // For precomputed spatial data, run full analysis when user requests gene plotting
  // The "minimal" analysis still needs to run most steps anyway, so full analysis is more reliable
  await runFullAnalysisPipeline({ labelPrefix: reason || 'on-demand' });
}

async function runMinimalAnalysisForGeneExpression() {
  if (!loadedData || !loadedData.dataset) {
    throw new Error('No dataset available for minimal analysis');
  }

  
  const dataset = loadedData.dataset;
  const info = loadedData.info || {};
  
  if (!dataset) {
    throw new Error('Dataset is not available in loadedData');
  }
  
  
  // Ensure bakana is initialized
  if (!analysisState && typeof bakana.initialize === 'function') {
    // Bakana should already be initialized, but check anyway
  }
  
  try {
    self.postMessage({ type: 'STATUS_UPDATE', message: 'Normalizing data for gene expression...' });
    
    // Build default parameters instead of using ensureCurrentParameters
    // which requires analysisState to exist
    const isSpatialModality = info?.modality === 'spatial';
    const baseParams = buildDefaultParameters({ fastMode: isSpatialModality });
    
    // For precomputed data, use very permissive quality control to avoid filtering out cells
    // The parameters go in rna_quality_control, not cell_filtering
    if (!baseParams.rna_quality_control) {
      baseParams.rna_quality_control = {};
    }
    // Set permissive thresholds to avoid filtering cells
    baseParams.rna_quality_control.filter_strategy = 'manual';
    baseParams.rna_quality_control.detected_threshold = 0;
    baseParams.rna_quality_control.sum_threshold = 0;
    
    // Don't set cell_filtering parameters; let bakana use defaults
    
    // Minimize PCA work
    if (!baseParams.rna_pca) {
      baseParams.rna_pca = {};
    }
    baseParams.rna_pca.num_pcs = 10;
    baseParams.rna_pca.num_hvgs = 1000;
    
    // Use the same pipeline structure as runFullAnalysisPipeline but with minimal parameters
    // Free existing analysis state if it exists
    if (analysisState) {
      try {
        if (typeof analysisState.free === 'function') {
          await analysisState.free();
        }
      } catch (freeError) {
        console.warn('Unable to free previous analysis state:', freeError);
      }
      analysisState = null;
    }

    
    if (typeof bakana?.createAnalysis !== 'function') {
      throw new Error('bakana.createAnalysis is not available. Bakana may not be initialized.');
    }
    
    try {
      const startTime = Date.now();
      
      // createAnalysis should return a promise
      const createPromise = bakana.createAnalysis();
      
      if (!createPromise || typeof createPromise.then !== 'function') {
        throw new Error('bakana.createAnalysis() did not return a promise');
      }
      
      
      // Add a timeout to detect if it hangs
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('createAnalysis() timed out after 60 seconds. The dataset may be too large or there may be a memory issue.'));
        }, 60000);
      });
      
      analysisState = await Promise.race([createPromise, timeoutPromise]);
      
      const elapsed = Date.now() - startTime;
      if (analysisState) {
        const methods = Object.keys(analysisState).filter(k => typeof analysisState[k] === 'function');
      }
    } catch (createError) {
      console.error('✗ Failed to create analysis state:', createError);
      console.error('Error type:', createError?.constructor?.name);
      console.error('Error message:', createError?.message);
      if (createError.stack) {
        console.error('Error stack:', createError.stack);
      }
      throw createError;
    }
    
    // Run RNA-only analysis with minimal parameters
    // Run up to rna_normalization to get the normalized matrix
    
    try {
      await runRnaOnlyAnalysis(
        analysisState,
        { sample: dataset },
        baseParams,
        {
          startFun: async (step) => {
            self.postMessage({
              type: 'STATUS_UPDATE',
              message: `Normalizing data (${step})...`,
            });
          },
          finishFun: async (step) => {
            // Once normalization is done, we can stop (but we need to let the pipeline complete)
            if (step === 'rna_normalization') {
            }
          },
        }
      );
      
    } catch (pipelineError) {
      console.error('RNA analysis pipeline failed:', pipelineError);
      console.error('Pipeline error stack:', pipelineError.stack);
      throw pipelineError;
    }
    
    // Store the state
    loadedData.state = analysisState;
    
    // Initialize currentParameters from the baseParams we used
    currentParameters = baseParams;
    
    
  } catch (error) {
    console.error('Minimal analysis failed:', error);
    console.error('Error details:', error.stack);
    // If minimal analysis fails, fall back to full analysis
    await runFullAnalysisPipeline({ labelPrefix: 'minimal-fallback' });
  }
}

/**
 * Parse MERFISH-specific spatial data files
 * For MERFISH, we use row indices as cell IDs to avoid scientific notation matching issues.
 * All MERFISH files should have cells in the same order, so row 0 in counts = row 0 in spatial, etc.
 *
 * @param {Object} files: MERFISH files (merfishSpatial, merfishClusters, merfishUmap)
 * @param {Array} cellIds: Array of cell IDs from the counts file (for matching)
 * @returns {Object} Spatial data object compatible with the analysis pipeline
 */
async function parseMERFISHSpatialData(files, cellIds) {

  const result = {
    coordinates: null,
    idToCoord: null,
    polygons: null,
    hasPolygons: false,
    precomputed: {
      umap: null,
      clusters: null,
    },
  };

  // Helper to ensure data is Uint8Array
  function ensureUint8Array(data, name) {
    if (!data) {
      throw new Error(`${name} data is null or undefined`);
    }
    if (data instanceof Uint8Array) {
      return data;
    } else if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    } else if (Array.isArray(data)) {
      return new Uint8Array(data);
    }
    throw new Error(`Cannot convert ${name} to Uint8Array`);
  }

  // Parse spatial coordinates from cell_metadata.csv
  // Use row index as cell ID to avoid scientific notation issues
  if (files.merfishSpatial?.data) {
    try {
      const spatialFileData = ensureUint8Array(files.merfishSpatial.data, 'merfishSpatial');
      const spatialText = new TextDecoder().decode(spatialFileData);
      const lines = spatialText.trim().split('\n');

      if (lines.length > 1) {
        const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));

        // Find column indices for cell ID, center_x, center_y
        const idIdx = headers.findIndex(h => /^(EntityID|cell_id|barcode|cell|id)$/i.test(h));
        const xIdx = headers.findIndex(h => /^(center_x|x_centroid|x)$/i.test(h));
        const yIdx = headers.findIndex(h => /^(center_y|y_centroid|y)$/i.test(h));


        if (xIdx >= 0 && yIdx >= 0) {
          const idToCoord = new Map();

          for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
            if (values.length > Math.max(xIdx, yIdx)) {
              const rawId = idIdx >= 0 ? values[idIdx] : String(i - 1);
              const normalizedId = merfishCellIdToString(rawId);
              const x = parseFloat(values[xIdx]);
              const y = parseFloat(values[yIdx]);

              if (normalizedId && !isNaN(x) && !isNaN(y)) {
                idToCoord.set(normalizedId, [x, y]);
              }
            }
          }

          result.idToCoord = idToCoord;
        } else {
          console.warn('Could not find center_x/center_y columns in MERFISH spatial file');
        }
      }
    } catch (error) {
      console.error('Failed to parse MERFISH spatial coordinates:', error);
    }
  }

  // Parse UMAP coordinates from cell_numeric_categories.csv
  if (files.merfishUmap?.data) {
    try {
      const umapFileData = ensureUint8Array(files.merfishUmap.data, 'merfishUmap');
      const umapText = new TextDecoder().decode(umapFileData);
      const lines = umapText.trim().split('\n');

      if (lines.length > 1) {
        const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));

        // Find column indices
        const idIdx = headers.findIndex(h => /^(EntityID|cell_id|barcode|cell|id)$/i.test(h));
        const umapXIdx = headers.findIndex(h => /^(umap_X|UMAP-1|umap_1|UMAP1)$/i.test(h));
        const umapYIdx = headers.findIndex(h => /^(umap_Y|UMAP-2|umap_2|UMAP2)$/i.test(h));


        if (umapXIdx >= 0 && umapYIdx >= 0) {
          const umapMap = new Map();

          for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
            if (values.length > Math.max(umapXIdx, umapYIdx)) {
              const rawId = idIdx >= 0 ? values[idIdx] : String(i - 1);
              const normalizedId = merfishCellIdToString(rawId);
              const u1 = parseFloat(values[umapXIdx]);
              const u2 = parseFloat(values[umapYIdx]);

              if (normalizedId && !isNaN(u1) && !isNaN(u2)) {
                umapMap.set(normalizedId, [u1, u2]);
              }
            }
          }

          result.precomputed.umap = { map: umapMap };
        } else {
          console.warn('Could not find umap_X/umap_Y columns in MERFISH UMAP file');
        }
      }
    } catch (error) {
      console.error('Failed to parse MERFISH UMAP:', error);
    }
  }

  // Parse clustering from cell_categories.csv
  if (files.merfishClusters?.data) {
    try {
      const clusterFileData = ensureUint8Array(files.merfishClusters.data, 'merfishClusters');
      const clusterText = new TextDecoder().decode(clusterFileData);
      const lines = clusterText.trim().split('\n');

      if (lines.length > 1) {
        const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));

        // Find column indices
        const idIdx = headers.findIndex(h => /^(EntityID|cell_id|barcode|cell|id)$/i.test(h));
        let clusterIdx = headers.findIndex(h => /^(leiden|cluster|Cluster|group)$/i.test(h));

        // If no specific cluster column found, use second column
        if (clusterIdx < 0 && headers.length > 1) {
          clusterIdx = 1;
        }


        if (clusterIdx >= 0) {
          const clusterMap = new Map();

          for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
            if (values.length > clusterIdx) {
              const rawId = idIdx >= 0 ? values[idIdx] : String(i - 1);
              const normalizedId = merfishCellIdToString(rawId);
              const clusterValue = values[clusterIdx];

              if (normalizedId && clusterValue !== '') {
                clusterMap.set(normalizedId, clusterValue);
              }
            }
          }

          result.precomputed.clusters = { map: clusterMap };

          // Get unique clusters
          const uniqueClusters = [...new Set(clusterMap.values())];
        } else {
          console.warn('Could not find cluster column in MERFISH clusters file');
        }
      }
    } catch (error) {
      console.error('Failed to parse MERFISH clusters:', error);
    }
  }

  return result;
}

/**
 * Parse CosMX-specific spatial data from the metadata CSV file.
 * CosMX does NOT come with precomputed UMAP or clusters, so we only parse spatial coordinates.
 * The coordinates are in the CenterX_global_px and CenterY_global_px columns.
 *
 * @param {Uint8Array|ArrayBuffer|Array} spatialFileData: Raw bytes of the metadata CSV
 * @param {Array} cellIds: Array of cell IDs from the counts file (for matching)
 * @returns {Object} Spatial data object compatible with the analysis pipeline
 */
function parseCosMXSpatialData(spatialFileData, cellIds) {

  const result = {
    coordinates: null,
    idToCoord: null,
    polygons: null,
    hasPolygons: false,
    precomputed: {
      umap: null,
      clusters: null,
    },
  };

  if (!spatialFileData) {
    console.warn('No CosMX spatial file data provided');
    return result;
  }

  try {
    let data = spatialFileData;
    if (data instanceof ArrayBuffer) {
      data = new Uint8Array(data);
    } else if (Array.isArray(data)) {
      data = new Uint8Array(data);
    }
    const text = new TextDecoder().decode(data);
    const lines = text.trim().split('\n');

    if (lines.length < 2) {
      console.warn('CosMX metadata file has no data rows');
      return result;
    }

    const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));

    // Find column indices: fov, cell_ID (or cell_id / "cell id"), CenterX_global_px, CenterY_global_px
    // Use flexible matching so alternate column names (e.g. "FOV", "Cell_ID", "Center X global px") work
    const fovIdx = headers.findIndex(h => /^fov$/i.test(h.trim()));
    let effectiveCellIdIdx = headers.findIndex(h => /^cell_ID$/i.test(h.trim()) || /^cell_id$/i.test(h.trim()));
    if (effectiveCellIdIdx < 0) {
      effectiveCellIdIdx = headers.findIndex(h => /^cell\s*id$/i.test(h.trim()));
    }

    let xIdx = headers.findIndex(h => /^CenterX_global_px$/i.test(h.trim()));
    let yIdx = headers.findIndex(h => /^CenterY_global_px$/i.test(h.trim()));
    if (xIdx < 0 || yIdx < 0) {
      // Fallback: columns containing center, global, and x/y (e.g. "Center X global px")
      const hx = headers.findIndex(h => /center/i.test(h) && /global/i.test(h) && /x/i.test(h) && /px/i.test(h));
      const hy = headers.findIndex(h => /center/i.test(h) && /global/i.test(h) && /y/i.test(h) && /px/i.test(h));
      if (hx >= 0) xIdx = hx;
      if (hy >= 0) yIdx = hy;
    }
    if (xIdx < 0) xIdx = headers.findIndex(h => /^CenterX$/i.test(h.trim()) || /center.*x.*px/i.test(h));
    if (yIdx < 0) yIdx = headers.findIndex(h => /^CenterY$/i.test(h.trim()) || /center.*y.*px/i.test(h));

    const fovCol = fovIdx >= 0 ? fovIdx : -1;
    const cellIdCol = effectiveCellIdIdx >= 0 ? effectiveCellIdIdx : -1;

    if (xIdx < 0 || yIdx < 0) {
      console.warn('Could not find CenterX_global_px/CenterY_global_px columns in CosMX metadata file. Headers:', headers);
      return result;
    }

    const idToCoord = new Map();
    const coordinatesInMetadataOrder = []; // fallback when key match fails but row count matches

    // Helper: normalize composite key so "01_100" and "1_100" both match (counts may use numeric fov/cell_ID)
    const normalizedKey = (fov, cellId) => {
      const a = String(fov).trim();
      const b = String(cellId).trim();
      const na = /^\d+$/.test(a) ? String(Number(a)) : a;
      const nb = /^\d+$/.test(b) ? String(Number(b)) : b;
      return `${na}_${nb}`;
    };

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
      if (values.length <= Math.max(xIdx, yIdx, fovCol, cellIdCol)) continue;

      const fov = fovCol >= 0 ? values[fovCol] : '';
      const cellId = cellIdCol >= 0 ? values[cellIdCol] : '';
      const key = `${fov}_${cellId}`;
      const x = parseFloat(values[xIdx]);
      const y = parseFloat(values[yIdx]);

      if (isNaN(x) || isNaN(y)) continue;

      const coord = [x, y];
      idToCoord.set(key, coord);
      const norm = normalizedKey(fov, cellId);
      if (norm !== key) idToCoord.set(norm, coord);
      coordinatesInMetadataOrder.push(coord);
    }

    result.idToCoord = idToCoord;
    result.coordinatesInMetadataOrder = coordinatesInMetadataOrder;
  } catch (error) {
    console.error('Failed to parse CosMX spatial coordinates:', error);
  }

  // CosMX does NOT have precomputed UMAP or clusters
  // The analysis pipeline will compute them
  return result;
}

async function loadData(payload) {
  const { path, info, files, spatialInfo } = payload;
  // Saved results from a previous analysis run (from cellpilot_results.json)
  const payloadPreviousResults = payload.previousResults || null;
  const isIntegration = payload.modality === 'integration' && Array.isArray(payload.datasets) && payload.datasets.length >= 2 && payload.datasets.length <= 3;
  const isAtacIntegration = payload.modality === 'atac-integration' && Array.isArray(payload.atacDatasets) && payload.atacDatasets.length >= 2 && payload.atacDatasets.length <= 3;
  const isXeniumIntegration = payload.modality === 'xenium-integration' && Array.isArray(payload.xeniumDatasets) && payload.xeniumDatasets.length === 2;
  const isVisiumHDIntegration = payload.modality === 'visium-hd-integration' && Array.isArray(payload.visiumHDDatasets) && payload.visiumHDDatasets.length === 2;
  const isMerfishIntegration = payload.modality === 'merfish-integration' && Array.isArray(payload.merfishDatasets) && payload.merfishDatasets.length === 2;

  try {
    // Reset state when loading new data
    loadedData = null;
    cachedGeneNames = null;
    cachedGeneLookup = null;
    atacGeneActivityCache.clear();
    scAtacGeneActivityCache.clear();
    imputedGeneCache.clear();
    currentResults = {
      umap: null,
      clusters: null,
      qc: null,
      pca: null,
    };

    self.postMessage({
      type: 'STATUS_UPDATE',
      message: isIntegration ? 'Loading integration datasets...' : isXeniumIntegration ? 'Loading Xenium integration datasets...' : isVisiumHDIntegration ? 'Loading Visium HD integration datasets...' : isMerfishIntegration ? 'Loading MERFISH integration datasets...' : 'Loading 10x data...',
    });

    if (!isIntegration && !isXeniumIntegration && !isVisiumHDIntegration && !isMerfishIntegration) {
    }
    let cellBarcodes = null;
    let spatialData = null; // Will be populated for spatial modalities (MERFISH, Xenium, Visium HD)

    // If data is a plain object with numeric keys (serialized array), convert it
    function ensureUint8Array(data, name) {
      if (!data) {
        throw new Error(`${name} data is null or undefined`);
      }
      if (data instanceof Uint8Array) {
        return data;
      }
      if (data instanceof ArrayBuffer) {
        if (data.byteLength === 0) {
          throw new Error(`${name} ArrayBuffer is empty (0 bytes)`);
        }
        return new Uint8Array(data);
      }
      if (Array.isArray(data)) {
        if (data.length === 0) {
          throw new Error(`${name} Array is empty`);
        }
        return new Uint8Array(data);
      }
      if (data && typeof data === 'object') {
        const keys = Object.keys(data);
        if (keys.length === 0) {
          throw new Error(`${name} object is empty`);
        }
        if (!isNaN(keys[0])) {
          const arr = new Uint8Array(keys.length);
          for (let i = 0; i < keys.length; i++) {
            arr[i] = data[i];
          }
          return arr;
        }
      }
      throw new Error(`Cannot convert ${name} to Uint8Array: received ${typeof data}`);
    }

    // --- Integration: 2–3 scRNA-seq datasets, MNN correction, per-dataset UMAP views ---
    if (isIntegration) {
      const datasetList = payload.datasets;
      const datasetNames = datasetList.map((d) => d.name);
      const datasetsForBakana = {};
      let totalBytes = 0;
      for (let i = 0; i < datasetList.length; i++) {
        const ds = datasetList[i];
        const f = ds.files || {};
        let dset;
        if (ds.info?.format === '10X MatrixMarket' && f.matrix && f.features && f.barcodes) {
          const matrixData = ensureUint8Array(f.matrix.data, 'matrix');
          const featuresData = ensureUint8Array(f.features.data, 'features');
          const barcodesData = ensureUint8Array(f.barcodes.data, 'barcodes');
          totalBytes += matrixData.length + featuresData.length + barcodesData.length;
          const matrixBlob = new File([matrixData], f.matrix.name, { type: 'application/gzip' });
          const featuresBlob = new File([featuresData], f.features.name, { type: 'application/gzip' });
          const barcodesBlob = new File([barcodesData], f.barcodes.name, { type: 'application/gzip' });
          dset = new bakana.TenxMatrixMarketDataset(matrixBlob, featuresBlob, barcodesBlob);
        } else {
          const h5File = f.h5;
          if (!h5File) throw new Error(`Dataset "${ds.name}": HDF5 file missing`);
          const h5Data = ensureUint8Array(h5File.data, 'HDF5');
          totalBytes += h5Data.length;
          const h5Blob = new File([h5Data], h5File.name || 'data.h5', { type: 'application/octet-stream' });
          dset = new bakana.TenxHdf5Dataset(h5Blob);
        }
        // Pass real bakana Dataset (inputs step expects constructor.format() and abbreviate())
        datasetsForBakana[ds.name] = dset;
      }
      loadedData = {
        path: datasetList[0].path,
        info: { modality: 'integration', datasetNames, format: '10X Integration' },
        dataset: null,
        datasets: datasetsForBakana,
        nCells: 0,
        nGenes: 0,
        rawCells: 0,
        rawGenes: 0,
        cellBarcodes: null,
        state: null,
        spatialData: null,
        spatialInfo: null,
        datasetBytes: totalBytes,
      };
      self.postMessage({ type: 'STATUS_UPDATE', message: 'Running integration (normalization, MNN, PCA, UMAP, clustering)...' });
      const baseParams = buildDefaultParameters({ fastMode: false });
      // Set MNN batch correction manually (configureBatchCorrection expects adt_pca/crispr_pca which we don't clone)
      baseParams.batch_correction = baseParams.batch_correction || {};
      baseParams.batch_correction.method = 'mnn';
      baseParams.rna_pca = baseParams.rna_pca || {};
      baseParams.rna_pca.block_method = 'project';
      // Use larger UMAP min_dist for multiple samples (better separation of batches)
      baseParams.umap = baseParams.umap || {};
      baseParams.umap.min_dist = 0.4;
      analysisState = await bakana.createAnalysis();
      await runRnaOnlyAnalysis(analysisState, datasetsForBakana, baseParams, {
        startFun: async (step) => {
          self.postMessage({ type: 'STATUS_UPDATE', message: `Integration: ${step}...` });
        },
        finishFun: async () => {},
      });
      const filterState = analysisState.cell_filtering;
      const filteredMatrix = filterState && typeof filterState.fetchFilteredMatrix === 'function' ? filterState.fetchFilteredMatrix() : null;
      const nCells = filteredMatrix ? filteredMatrix.numberOfColumns() : analysisState.inputs.fetchCountMatrix().get(analysisState.inputs.fetchCountMatrix().available()[0]).numberOfColumns();
      const countMatrix = analysisState.inputs.fetchCountMatrix();
      const available = countMatrix.available();
      const rnaMatrix = countMatrix.get(available[0]);
      const nGenes = rnaMatrix.numberOfRows();
      loadedData.state = analysisState;
      loadedData.nCells = nCells;
      loadedData.nGenes = nGenes;
      loadedData.rawCells = nCells;
      loadedData.rawGenes = nGenes;
      currentParameters = cloneStepParameters(bakana.retrieveParameters(analysisState));
      const annotations = analysisState.inputs.fetchCellAnnotations();
      let blockIds = null;
      let blockLevels = null;
      try {
        const filterState = analysisState.cell_filtering;
        if (filterState && typeof filterState.fetchFilteredBlock === 'function') {
          const block = filterState.fetchFilteredBlock();
          if (block && block.length === nCells) {
            blockIds = Array.from(block);
            const levels = analysisState.inputs.fetchBlockLevels();
            blockLevels = levels ? Array.from(levels) : datasetNames;
          }
        }
      } catch (e) {
        console.warn('Could not get block from filtering state:', e);
      }
      // Fallback: derive block from __batch__ column (set by bakana for multi-dataset)
      // Only use when annotations length matches filtered nCells (inputs annotations may be unfiltered)
      if ((!blockIds || !blockLevels) && annotations && typeof annotations.column === 'function' && annotations.hasColumn && annotations.hasColumn('__batch__')) {
        try {
          const batchCol = annotations.column('__batch__');
          const batchLen = batchCol?.length ?? (Array.isArray(batchCol) ? batchCol.length : 0);
          if (batchLen === nCells) {
            const batchNames = Array.from(batchCol);
            const order = datasetNames.slice();
            blockLevels = order;
            blockIds = batchNames.map((name) => {
              const idx = order.indexOf(name);
              return idx >= 0 ? idx : 0;
            });
          }
        } catch (e) {
          console.warn('Could not get block from __batch__:', e);
        }
      }
      if (!blockIds || !blockLevels) {
        blockLevels = datasetNames.slice();
        blockIds = Array(nCells).fill(0);
      }
      const coordinates = await analysisState.umap.fetchResults({ copy: true });
      const x = coordinates?.x;
      const y = coordinates?.y;
      const coordLen = x?.length ?? y?.length ?? nCells;
      const umapCoords = Array.from({ length: coordLen }, (_, i) => [
        x && i < x.length ? x[i] : NaN,
        y && i < y.length ? y[i] : NaN,
      ]);
      const clusterState = analysisState.choose_clustering;
      const clusterArray = clusterState && typeof clusterState.fetchClusters === 'function' ? Array.from(clusterState.fetchClusters()) : Array(nCells).fill(0);
      const nClusters = new Set(clusterArray).size;
      currentResults.umap = umapCoords;
      currentResults.clusters = clusterArray;
      const integrationViews = {};
      const numLevels = Array.isArray(blockLevels) ? blockLevels.length : 0;
      const numBlockIds = Array.isArray(blockIds) ? blockIds.length : 0;
      for (let v = 0; v < numLevels; v++) {
        const name = blockLevels[v];
        const indices = [];
        for (let i = 0; i < numBlockIds; i++) {
          if (blockIds[i] === v) indices.push(i);
        }
        integrationViews[name] = { indices };
      }
      let cellBarcodesList = [];
      if (annotations && typeof annotations.rowNames === 'function') {
        const rows = annotations.rowNames();
        if (rows != null && (Array.isArray(rows) || typeof rows.length === 'number')) {
          const len = rows.length;
          for (let i = 0; i < len; i++) cellBarcodesList.push(rows[i]);
        }
      }
      if (!cellBarcodesList.length) {
        for (let i = 0; i < nCells; i++) cellBarcodesList.push(`cell_${i}`);
      }
      loadedData.cellBarcodes = cellBarcodesList;
      self.postMessage({
        type: 'DATA_LOADED',
        data: {
          path: loadedData.path,
          cells: nCells,
          genes: nGenes,
          rawCells: nCells,
          rawGenes: nGenes,
          modality: 'integration',
          datasetNames,
        },
      });
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: umapCoords,
          clusters: clusterArray,
          nClusters,
          nCells,
          source: 'integration',
          integrationViews,
          datasetNames,
        },
      });
      return;
    }

    // MERFISH Integration: 2-sample MERFISH with MNN batch correction
    if (isMerfishIntegration) {
      const merfishDatasetList = payload.merfishDatasets;
      const datasetNames = merfishDatasetList.map((d) => d.name);
      const datasetsForBakana = {};
      let totalBytes = 0;

      // Parse per-sample spatial coordinates and build bakana datasets from cell_by_gene.csv
      const perSampleSpatial = {};
      for (let i = 0; i < merfishDatasetList.length; i++) {
        const ds = merfishDatasetList[i];
        const f = ds.files || {};
        self.postMessage({ type: 'STATUS_UPDATE', message: `Parsing MERFISH sample "${ds.name}"...` });

        // Parse cell_by_gene.csv to build counts matrix
        if (!f.counts?.data) {
          throw new Error(`MERFISH sample "${ds.name}": cell_by_gene.csv missing`);
        }
        const countsRaw = ensureUint8Array(f.counts.data, `${ds.name} counts`);
        totalBytes += countsRaw.length;
        const countsText = new TextDecoder().decode(countsRaw);
        const countsLines = countsText.trim().split('\n');
        if (countsLines.length < 2) {
          throw new Error(`MERFISH sample "${ds.name}": cell_by_gene.csv has no data rows`);
        }

        // Parse header to get gene names, filter out "Blank*" columns
        const rawHeaders = countsLines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
        const geneIndices = [];
        const geneNames = [];
        for (let gi = 1; gi < rawHeaders.length; gi++) {
          if (!rawHeaders[gi].startsWith('Blank')) {
            geneIndices.push(gi);
            geneNames.push(rawHeaders[gi]);
          }
        }

        // Parse data rows to build sparse matrix
        const nGenesSample = geneNames.length;
        const nCellsSample = countsLines.length - 1;
        const cellIds = [];
        const sparseData = [];

        for (let cellIdx = 0; cellIdx < nCellsSample; cellIdx++) {
          const line = countsLines[cellIdx + 1];
          const values = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
          const rawCellId = values[0];
          const normalizedCellId = merfishCellIdToString(rawCellId);
          cellIds.push(normalizedCellId || rawCellId);
          for (let gIdx = 0; gIdx < geneIndices.length; gIdx++) {
            const origColIdx = geneIndices[gIdx];
            const countValue = parseInt(values[origColIdx], 10);
            if (countValue > 0) {
              sparseData.push({ row: gIdx, col: cellIdx, val: countValue });
            }
          }
        }

        // Convert to MatrixMarket format
        const mmHeader = '%%MatrixMarket matrix coordinate integer general\n';
        const mmSizeLine = `${nGenesSample} ${nCellsSample} ${sparseData.length}\n`;
        sparseData.sort((a, b) => a.col !== b.col ? a.col - b.col : a.row - b.row);
        const mmDataLines = sparseData.map(d => `${d.row + 1} ${d.col + 1} ${d.val}`).join('\n');
        const mmContent = mmHeader + mmSizeLine + mmDataLines;
        const featuresContent = geneNames.map(g => `${g}\t${g}\tGene Expression`).join('\n');
        const barcodesContent = cellIds.join('\n');

        const pako = await import('pako');
        const mmCompressed = pako.gzip(new TextEncoder().encode(mmContent));
        const featuresCompressed = pako.gzip(new TextEncoder().encode(featuresContent));
        const barcodesCompressed = pako.gzip(new TextEncoder().encode(barcodesContent));

        const matrixBlob = new File([mmCompressed], 'matrix.mtx.gz', { type: 'application/gzip' });
        const featuresBlob = new File([featuresCompressed], 'features.tsv.gz', { type: 'application/gzip' });
        const barcodesBlob = new File([barcodesCompressed], 'barcodes.tsv.gz', { type: 'application/gzip' });

        datasetsForBakana[ds.name] = new bakana.TenxMatrixMarketDataset(matrixBlob, featuresBlob, barcodesBlob);

        // Parse spatial coordinates from cell_metadata.csv
        if (f.spatial?.data) {
          try {
            const spatialRaw = ensureUint8Array(f.spatial.data, `${ds.name} spatial`);
            const spatialText = new TextDecoder().decode(spatialRaw);
            const lines = spatialText.trim().split('\n');
            if (lines.length > 1) {
              const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
              const idIdx = headers.findIndex(h => /^(EntityID|cell_id|barcode|cell|id)$/i.test(h));
              const xIdx = headers.findIndex(h => /^(center_x|x_centroid|x)$/i.test(h));
              const yIdx = headers.findIndex(h => /^(center_y|y_centroid|y)$/i.test(h));
              if (xIdx >= 0 && yIdx >= 0) {
                const coords = [];
                const spatialCellIds = [];
                let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
                for (let j = 1; j < lines.length; j++) {
                  const values = lines[j].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
                  if (values.length > Math.max(xIdx, yIdx)) {
                    const rawId = idIdx >= 0 ? values[idIdx] : String(j - 1);
                    const normalizedId = merfishCellIdToString(rawId);
                    const x = parseFloat(values[xIdx]);
                    const y = parseFloat(values[yIdx]);
                    if (normalizedId && isFinite(x) && isFinite(y)) {
                      coords.push([x, y]);
                      spatialCellIds.push(normalizedId);
                      if (x < xMin) xMin = x;
                      if (x > xMax) xMax = x;
                      if (y < yMin) yMin = y;
                      if (y > yMax) yMax = y;
                    }
                  }
                }
                perSampleSpatial[ds.name] = {
                  spatialCoordinates: coords,
                  cellIds: spatialCellIds,
                  spatialExtent: coords.length > 0 ? { xMin, xMax, yMin, yMax } : null,
                  metadata: payload.perSampleSpatialInfo?.[i]?.metadata || null,
                };
              }
            }
          } catch (e) {
            console.warn(`Failed to parse spatial coords for MERFISH "${ds.name}":`, e);
          }
        }
      }

      // Run MNN integration pipeline
      loadedData = {
        path: merfishDatasetList[0].path,
        info: { modality: 'merfish-integration', datasetNames, format: 'MERFISH Integration' },
        dataset: null,
        datasets: datasetsForBakana,
        nCells: 0,
        nGenes: 0,
        rawCells: 0,
        rawGenes: 0,
        cellBarcodes: null,
        state: null,
        spatialData: null,
        spatialInfo: null,
        datasetBytes: totalBytes,
      };
      const prevResultsMerfish = payload.previousResults || null;
      const hasPreviousMerfish = prevResultsMerfish?.umapCoordinates?.length > 0 && prevResultsMerfish?.clusters?.length > 0;
      if (hasPreviousMerfish) {
        self.postMessage({ type: 'STATUS_UPDATE', message: 'Restoring previous MERFISH integration results (normalizing data)...' });
        const baseParams = buildDefaultParameters({ fastMode: false });
        baseParams.batch_correction = baseParams.batch_correction || {};
        baseParams.batch_correction.method = 'mnn';
        baseParams.rna_pca = baseParams.rna_pca || {};
        baseParams.rna_pca.block_method = 'project';
        baseParams.umap = baseParams.umap || {};
        baseParams.umap.min_dist = 0.4;
        analysisState = await bakana.createAnalysis();
        await runRnaOnlyAnalysis(analysisState, datasetsForBakana, baseParams, {
          startFun: async (step) => {
            self.postMessage({ type: 'STATUS_UPDATE', message: `MERFISH integration: ${step}...` });
          },
          finishFun: async () => {},
          stopAfterStep: 'rna_normalization',
        });
        const filterState = analysisState.cell_filtering;
        const filteredMatrix = filterState && typeof filterState.fetchFilteredMatrix === 'function' ? filterState.fetchFilteredMatrix() : null;
        const nCellsPrev = filteredMatrix ? filteredMatrix.numberOfColumns() : analysisState.inputs.fetchCountMatrix().get(analysisState.inputs.fetchCountMatrix().available()[0]).numberOfColumns();
        const countMatrix = analysisState.inputs.fetchCountMatrix();
        const available = countMatrix.available();
        const rnaMatrix = countMatrix.get(available[0]);
        const nGenesPrev = rnaMatrix.numberOfRows();
        if (nCellsPrev !== prevResultsMerfish.umapCoordinates.length || nCellsPrev !== prevResultsMerfish.clusters.length) {
          console.warn('CellPilot: previous MERFISH integration cell count mismatch, running full pipeline');
        } else {
          loadedData.state = analysisState;
          loadedData.nCells = nCellsPrev;
          loadedData.nGenes = nGenesPrev;
          loadedData.rawCells = nCellsPrev;
          loadedData.rawGenes = nGenesPrev;
          currentParameters = cloneStepParameters(bakana.retrieveParameters(analysisState));
          const annotations = analysisState.inputs.fetchCellAnnotations();
          let blockIds = null;
          let blockLevels = null;
          try {
            const merfishFilterState = analysisState.cell_filtering;
            if (merfishFilterState && typeof merfishFilterState.fetchFilteredBlock === 'function') {
              const block = merfishFilterState.fetchFilteredBlock();
              if (block && block.length === nCellsPrev) {
                blockIds = Array.from(block);
                const levels = analysisState.inputs.fetchBlockLevels();
                blockLevels = levels ? Array.from(levels) : datasetNames;
              }
            }
          } catch (e) {
            console.warn('MERFISH integration restore: could not get block:', e);
          }
          if ((!blockIds || !blockLevels) && annotations && annotations.hasColumn && annotations.hasColumn('__batch__')) {
            try {
              const batchCol = annotations.column('__batch__');
              const batchLen = batchCol?.length ?? (Array.isArray(batchCol) ? batchCol.length : 0);
              if (batchLen === nCellsPrev) {
                const batchNames = Array.from(batchCol);
                blockLevels = datasetNames.slice();
                blockIds = batchNames.map((name) => {
                  const idx = blockLevels.indexOf(name);
                  return idx >= 0 ? idx : 0;
                });
              }
            } catch (e) {
              console.warn('MERFISH integration restore: __batch__ fallback failed:', e);
            }
          }
          if (!blockIds || !blockLevels) {
            blockLevels = datasetNames.slice();
            blockIds = Array(nCellsPrev).fill(0);
          }
          const integrationViews = {};
          for (let v = 0; v < blockLevels.length; v++) {
            const name = blockLevels[v];
            const indices = [];
            for (let ii = 0; ii < blockIds.length; ii++) {
              if (blockIds[ii] === v) indices.push(ii);
            }
            integrationViews[name] = { indices };
          }
          loadedData.integrationViews = integrationViews;
          let cellBarcodesList = [];
          const filteredBarcodes = getOrderedBarcodesFromFilteredState(analysisState);
          if (filteredBarcodes && filteredBarcodes.length === nCellsPrev) {
            cellBarcodesList = filteredBarcodes;
          } else {
            const keepResult = analysisState.cell_filtering?.fetchKeep?.();
            let keepMask = null;
            if (keepResult) {
              if (typeof keepResult.array === 'function') keepMask = keepResult.array();
              else if (typeof keepResult.toArray === 'function') keepMask = keepResult.toArray();
              else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) keepMask = keepResult;
            }
            const block = analysisState.cell_filtering?.fetchFilteredBlock?.();
            const blockArray = block ? (typeof block.array === 'function' ? block.array() : Array.from(block)) : null;
            if (keepMask && blockArray && blockArray.length === nCellsPrev) {
              const nRaw = keepMask.length;
              const levels = blockLevels?.length ? blockLevels : datasetNames;
              const sampleOffsets = [];
              let offset = 0;
              for (let s = 0; s < levels.length; s++) {
                sampleOffsets.push(offset);
                const sp = perSampleSpatial[levels[s]];
                offset += (sp && Array.isArray(sp.cellIds)) ? sp.cellIds.length : 0;
              }
              const rawToFiltered = [];
              for (let r = 0; r < nRaw; r++) {
                if (keepMask[r]) rawToFiltered.push(r);
              }
              for (let j = 0; j < nCellsPrev; j++) {
                const rawIdx = rawToFiltered[j];
                if (rawIdx == null) { cellBarcodesList.push(`cell_${j}`); continue; }
                const blockId = blockArray[j];
                const sampleName = levels && blockId >= 0 && blockId < levels.length ? levels[blockId] : datasetNames[0];
                const sampleStart = sampleOffsets[blockId >= 0 && blockId < sampleOffsets.length ? blockId : 0];
                const inSampleIdx = rawIdx - sampleStart;
                const sampleSpatial = perSampleSpatial[sampleName];
                const cellId = sampleSpatial?.cellIds?.[inSampleIdx];
                cellBarcodesList.push(cellId != null ? String(cellId) : `cell_${j}`);
              }
            } else {
              for (let ii = 0; ii < nCellsPrev; ii++) cellBarcodesList.push(`cell_${ii}`);
            }
          }
          loadedData.cellBarcodes = cellBarcodesList;
          currentResults.umap = prevResultsMerfish.umapCoordinates;
          currentResults.clusters = prevResultsMerfish.clusters;
          const nClustersPrev = prevResultsMerfish.nClusters != null ? prevResultsMerfish.nClusters : new Set(prevResultsMerfish.clusters).size;

          // Align per-sample spatial coordinates to filtered cell order
          for (const name of datasetNames) {
            const sampleSpatial = perSampleSpatial[name];
            if (!sampleSpatial || !Array.isArray(sampleSpatial.cellIds)) continue;
            const { cellIds: sCellIds, spatialCoordinates: allCoords } = sampleSpatial;
            const cellIdToIdx = new Map();
            for (let k = 0; k < sCellIds.length; k++) {
              cellIdToIdx.set(String(sCellIds[k]), k);
            }
            const sampleIndices = integrationViews[name]?.indices || [];
            const alignedCoords = new Array(sampleIndices.length);
            let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
            let matchedCount = 0;
            for (let j = 0; j < sampleIndices.length; j++) {
              const globalIdx = sampleIndices[j];
              const fullBarcode = String(cellBarcodesList[globalIdx] || '');
              let csvIdx = cellIdToIdx.get(fullBarcode);
              if (csvIdx === undefined && fullBarcode.includes('_')) {
                const parts = fullBarcode.split('_');
                for (let p = 1; p < parts.length && csvIdx === undefined; p++) {
                  csvIdx = cellIdToIdx.get(parts.slice(p).join('_'));
                }
              }
              if (csvIdx !== undefined) {
                const coord = allCoords[csvIdx];
                alignedCoords[j] = coord;
                if (coord[0] < xMin) xMin = coord[0];
                if (coord[0] > xMax) xMax = coord[0];
                if (coord[1] < yMin) yMin = coord[1];
                if (coord[1] > yMax) yMax = coord[1];
                matchedCount++;
              } else {
                alignedCoords[j] = null;
              }
            }
            if (matchedCount < sampleIndices.length * 0.5 && allCoords.length > 0) {
              xMin = Infinity; xMax = -Infinity; yMin = Infinity; yMax = -Infinity;
              for (let j = 0; j < sampleIndices.length; j++) {
                const coord = allCoords[Math.min(j, allCoords.length - 1)];
                alignedCoords[j] = coord;
                if (coord[0] < xMin) xMin = coord[0];
                if (coord[0] > xMax) xMax = coord[0];
                if (coord[1] < yMin) yMin = coord[1];
                if (coord[1] > yMax) yMax = coord[1];
              }
            } else {
              for (let j = 0; j < alignedCoords.length; j++) {
                if (alignedCoords[j] === null) alignedCoords[j] = [0, 0];
              }
            }
            sampleSpatial.spatialCoordinates = alignedCoords;
            sampleSpatial.spatialExtent = Number.isFinite(xMin) ? { xMin, xMax, yMin, yMax } : null;
          }

          loadedData.perSampleSpatial = perSampleSpatial;
          self.postMessage({
            type: 'DATA_LOADED',
            data: {
              path: loadedData.path,
              cells: nCellsPrev,
              genes: nGenesPrev,
              rawCells: nCellsPrev,
              rawGenes: nGenesPrev,
              modality: 'merfish-integration',
              datasetNames,
              perSampleSpatial,
            },
          });
          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              type: 'umap',
              coordinates: prevResultsMerfish.umapCoordinates,
              clusters: prevResultsMerfish.clusters,
              nClusters: nClustersPrev,
              nCells: nCellsPrev,
              source: 'integration',
              integrationViews,
              datasetNames,
              perSampleSpatial,
              restoredClusterLabelMap: prevResultsMerfish.clusterLabelMap || {},
              restoredClusterColorOverrides: prevResultsMerfish.clusterColorOverrides || {},
            },
          });
          return;
        }
      }
      // Full pipeline: normalization, MNN, PCA, UMAP, clustering
      self.postMessage({ type: 'STATUS_UPDATE', message: 'Running MERFISH integration (normalization, MNN, PCA, UMAP, clustering)...' });
      const baseParams = buildDefaultParameters({ fastMode: false });
      baseParams.batch_correction = baseParams.batch_correction || {};
      baseParams.batch_correction.method = 'mnn';
      baseParams.rna_pca = baseParams.rna_pca || {};
      baseParams.rna_pca.block_method = 'project';
      baseParams.umap = baseParams.umap || {};
      baseParams.umap.min_dist = 0.4;
      analysisState = await bakana.createAnalysis();
      await runRnaOnlyAnalysis(analysisState, datasetsForBakana, baseParams, {
        startFun: async (step) => {
          self.postMessage({ type: 'STATUS_UPDATE', message: `MERFISH integration: ${step}...` });
        },
        finishFun: async () => {},
      });
      const filterState = analysisState.cell_filtering;
      const filteredMatrix = filterState && typeof filterState.fetchFilteredMatrix === 'function' ? filterState.fetchFilteredMatrix() : null;
      const nCells = filteredMatrix ? filteredMatrix.numberOfColumns() : analysisState.inputs.fetchCountMatrix().get(analysisState.inputs.fetchCountMatrix().available()[0]).numberOfColumns();
      const countMatrix = analysisState.inputs.fetchCountMatrix();
      const available = countMatrix.available();
      const rnaMatrix = countMatrix.get(available[0]);
      const nGenes = rnaMatrix.numberOfRows();
      loadedData.state = analysisState;
      loadedData.nCells = nCells;
      loadedData.nGenes = nGenes;
      loadedData.rawCells = nCells;
      loadedData.rawGenes = nGenes;
      currentParameters = cloneStepParameters(bakana.retrieveParameters(analysisState));
      const annotations = analysisState.inputs.fetchCellAnnotations();
      let blockIds = null;
      let blockLevels = null;
      try {
        const merfishFilterState = analysisState.cell_filtering;
        if (merfishFilterState && typeof merfishFilterState.fetchFilteredBlock === 'function') {
          const block = merfishFilterState.fetchFilteredBlock();
          if (block && block.length === nCells) {
            blockIds = Array.from(block);
            const levels = analysisState.inputs.fetchBlockLevels();
            blockLevels = levels ? Array.from(levels) : datasetNames;
          }
        }
      } catch (e) {
        console.warn('MERFISH integration: could not get block from filtering state:', e);
      }
      if ((!blockIds || !blockLevels) && annotations && typeof annotations.column === 'function' && annotations.hasColumn && annotations.hasColumn('__batch__')) {
        try {
          const batchCol = annotations.column('__batch__');
          const batchLen = batchCol?.length ?? (Array.isArray(batchCol) ? batchCol.length : 0);
          if (batchLen === nCells) {
            const batchNames = Array.from(batchCol);
            const order = datasetNames.slice();
            blockLevels = order;
            blockIds = batchNames.map((name) => {
              const idx = order.indexOf(name);
              return idx >= 0 ? idx : 0;
            });
          }
        } catch (e) {
          console.warn('MERFISH integration: could not get block from __batch__:', e);
        }
      }
      if (!blockIds || !blockLevels) {
        blockLevels = datasetNames.slice();
        blockIds = Array(nCells).fill(0);
      }
      const coordinates = await analysisState.umap.fetchResults({ copy: true });
      const x = coordinates?.x;
      const y = coordinates?.y;
      const coordLen = x?.length ?? y?.length ?? nCells;
      const umapCoords = Array.from({ length: coordLen }, (_, i) => [
        x && i < x.length ? x[i] : NaN,
        y && i < y.length ? y[i] : NaN,
      ]);
      const clusterState = analysisState.choose_clustering;
      const clusterArray = clusterState && typeof clusterState.fetchClusters === 'function' ? Array.from(clusterState.fetchClusters()) : Array(nCells).fill(0);
      const nClusters = new Set(clusterArray).size;
      currentResults.umap = umapCoords;
      currentResults.clusters = clusterArray;
      const integrationViews = {};
      const numLevels = Array.isArray(blockLevels) ? blockLevels.length : 0;
      const numBlockIds = Array.isArray(blockIds) ? blockIds.length : 0;
      for (let v = 0; v < numLevels; v++) {
        const name = blockLevels[v];
        const indices = [];
        for (let ii = 0; ii < numBlockIds; ii++) {
          if (blockIds[ii] === v) indices.push(ii);
        }
        integrationViews[name] = { indices };
      }
      loadedData.integrationViews = integrationViews;
      let cellBarcodesList = [];
      const filteredBarcodes = getOrderedBarcodesFromFilteredState(analysisState);
      if (filteredBarcodes && filteredBarcodes.length === nCells) {
        cellBarcodesList = filteredBarcodes;
      } else {
        const keepResult = analysisState.cell_filtering?.fetchKeep?.();
        let keepMask = null;
        if (keepResult) {
          if (typeof keepResult.array === 'function') keepMask = keepResult.array();
          else if (typeof keepResult.toArray === 'function') keepMask = keepResult.toArray();
          else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) keepMask = keepResult;
        }
        const block = analysisState.cell_filtering?.fetchFilteredBlock?.();
        const blockArray = block ? (typeof block.array === 'function' ? block.array() : Array.from(block)) : null;
        if (keepMask && blockArray && blockArray.length === nCells) {
          const nRaw = keepMask.length;
          const levels = (blockLevels && blockLevels.length) ? blockLevels : datasetNames;
          const sampleOffsets = [];
          let offset = 0;
          for (let s = 0; s < levels.length; s++) {
            sampleOffsets.push(offset);
            const sp = perSampleSpatial[levels[s]];
            offset += (sp && Array.isArray(sp.cellIds)) ? sp.cellIds.length : 0;
          }
          const rawToFiltered = [];
          for (let r = 0; r < nRaw; r++) {
            if (keepMask[r]) rawToFiltered.push(r);
          }
          for (let j = 0; j < nCells; j++) {
            const rawIdx = rawToFiltered[j];
            if (rawIdx == null) { cellBarcodesList.push(`cell_${j}`); continue; }
            const blockId = blockArray[j];
            const sampleName = levels && blockId >= 0 && blockId < levels.length ? levels[blockId] : datasetNames[0];
            const sampleStart = sampleOffsets[blockId >= 0 && blockId < sampleOffsets.length ? blockId : 0];
            const inSampleIdx = rawIdx - sampleStart;
            const sampleSpatial = perSampleSpatial[sampleName];
            const cellId = sampleSpatial?.cellIds?.[inSampleIdx];
            cellBarcodesList.push(cellId != null ? String(cellId) : `cell_${j}`);
          }
        } else {
          for (let ii = 0; ii < nCells; ii++) cellBarcodesList.push(`cell_${ii}`);
          console.warn('MERFISH integration: could not derive barcodes, using fallback');
        }
      }
      loadedData.cellBarcodes = cellBarcodesList;

      // Align per-sample spatial coordinates with bakana's filtered cell order
      for (const name of datasetNames) {
        const sampleSpatial = perSampleSpatial[name];
        if (!sampleSpatial || !Array.isArray(sampleSpatial.cellIds)) continue;
        const { cellIds: sCellIds, spatialCoordinates: allCoords } = sampleSpatial;
        const cellIdToIdx = new Map();
        for (let k = 0; k < sCellIds.length; k++) {
          cellIdToIdx.set(String(sCellIds[k]), k);
        }
        const sampleIndices = integrationViews[name]?.indices || [];
        if (sampleIndices.length > 0) {
          const firstBarcodes = sampleIndices.slice(0, 5).map(ii => String(cellBarcodesList[ii] || ''));
          const firstCsvIds = sCellIds.slice(0, 5).map(id => String(id));
        }
        const alignedCoords = new Array(sampleIndices.length);
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        let matchedCount = 0;
        for (let j = 0; j < sampleIndices.length; j++) {
          const globalIdx = sampleIndices[j];
          const fullBarcode = String(cellBarcodesList[globalIdx] || '');
          let csvIdx = cellIdToIdx.get(fullBarcode);
          if (csvIdx === undefined && fullBarcode.includes('_')) {
            const parts = fullBarcode.split('_');
            for (let p = 1; p < parts.length && csvIdx === undefined; p++) {
              csvIdx = cellIdToIdx.get(parts.slice(p).join('_'));
            }
          }
          if (csvIdx !== undefined) {
            const coord = allCoords[csvIdx];
            alignedCoords[j] = coord;
            if (coord[0] < xMin) xMin = coord[0];
            if (coord[0] > xMax) xMax = coord[0];
            if (coord[1] < yMin) yMin = coord[1];
            if (coord[1] > yMax) yMax = coord[1];
            matchedCount++;
          } else {
            alignedCoords[j] = null;
          }
        }
        if (matchedCount < sampleIndices.length * 0.5 && allCoords.length > 0) {
          xMin = Infinity; xMax = -Infinity; yMin = Infinity; yMax = -Infinity;
          for (let j = 0; j < sampleIndices.length; j++) {
            const coord = allCoords[Math.min(j, allCoords.length - 1)];
            alignedCoords[j] = coord;
            if (coord[0] < xMin) xMin = coord[0];
            if (coord[0] > xMax) xMax = coord[0];
            if (coord[1] < yMin) yMin = coord[1];
            if (coord[1] > yMax) yMax = coord[1];
          }
        } else {
          for (let j = 0; j < alignedCoords.length; j++) {
            if (alignedCoords[j] === null) alignedCoords[j] = [0, 0];
          }
        }
        sampleSpatial.spatialCoordinates = alignedCoords;
        sampleSpatial.spatialExtent = Number.isFinite(xMin) ? { xMin, xMax, yMin, yMax } : null;
      }

      loadedData.perSampleSpatial = perSampleSpatial;
      self.postMessage({
        type: 'DATA_LOADED',
        data: {
          path: loadedData.path,
          cells: nCells,
          genes: nGenes,
          rawCells: nCells,
          rawGenes: nGenes,
          modality: 'merfish-integration',
          datasetNames,
          perSampleSpatial,
        },
      });
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: umapCoords,
          clusters: clusterArray,
          nClusters,
          nCells,
          source: 'integration',
          integrationViews,
          datasetNames,
          perSampleSpatial,
        },
      });
      return;
    }

    // Xenium Integration: 2-sample Xenium with MNN batch correction
    if (isXeniumIntegration) {
      const xeniumDatasetList = payload.xeniumDatasets;
      const datasetNames = xeniumDatasetList.map((d) => d.name);
      const datasetsForBakana = {};
      let totalBytes = 0;

      // Parse per-sample spatial coordinates first (for rendering in the frontend)
      const perSampleSpatial = {};
      for (let i = 0; i < xeniumDatasetList.length; i++) {
        const ds = xeniumDatasetList[i];
        const f = ds.files || {};
        self.postMessage({ type: 'STATUS_UPDATE', message: `Parsing Xenium sample "${ds.name}"...` });

        // Build bakana dataset from cell_feature_matrix
        let dset;
        if (f.h5) {
          const h5Data = ensureUint8Array(f.h5.data, `${ds.name} HDF5`);
          totalBytes += h5Data.length;
          const h5Blob = new File([h5Data], f.h5.name || 'cell_feature_matrix.h5', { type: 'application/octet-stream' });
          dset = new bakana.TenxHdf5Dataset(h5Blob);
        } else if (f.matrix && f.features && f.barcodes) {
          const matrixData = ensureUint8Array(f.matrix.data, `${ds.name} matrix`);
          const featuresData = ensureUint8Array(f.features.data, `${ds.name} features`);
          const barcodesData = ensureUint8Array(f.barcodes.data, `${ds.name} barcodes`);
          totalBytes += matrixData.length + featuresData.length + barcodesData.length;
          const matrixBlob = new File([matrixData], f.matrix.name, { type: 'application/gzip' });
          const featuresBlob = new File([featuresData], f.features.name, { type: 'application/gzip' });
          const barcodesBlob = new File([barcodesData], f.barcodes.name, { type: 'application/gzip' });
          dset = new bakana.TenxMatrixMarketDataset(matrixBlob, featuresBlob, barcodesBlob);
        } else {
          throw new Error(`Xenium sample "${ds.name}": cell feature matrix missing`);
        }
        datasetsForBakana[ds.name] = dset;

        // Parse spatial coordinates from cells CSV
        if (f.cells?.data) {
          try {
            const rawBuf = ensureUint8Array(f.cells.data, `${ds.name} cells`);
            const parquetMagic = rawBuf.length >= 4 && rawBuf[0] === 0x50 && rawBuf[1] === 0x41 && rawBuf[2] === 0x52 && rawBuf[3] === 0x31;
            if (!parquetMagic) {
              const cellsText = new TextDecoder().decode(rawBuf);
              const lines = cellsText.trim().split('\n');
              if (lines.length > 1) {
                const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
                let xIdx = headers.findIndex(h => /^(x(_?(centroid|center|um|px|coordinate|coord|pos|position))?|.*_x)$/i.test(h));
                let yIdx = headers.findIndex(h => /^(y(_?(centroid|center|um|px|coordinate|coord|pos|position))?|.*_y)$/i.test(h));
                if (xIdx < 0) xIdx = headers.findIndex(h => /^x$/i.test(h));
                if (yIdx < 0) yIdx = headers.findIndex(h => /^y$/i.test(h));
                let idIdx = headers.findIndex(h => /^(cell_id|cellid|barcode)$/i.test(h));
                if (idIdx < 0) idIdx = 0;
                if (xIdx >= 0 && yIdx >= 0) {
                  const coords = [];
                  const cellIds = [];
                  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
                  for (let j = 1; j < lines.length; j++) {
                    const values = lines[j].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
                    if (values.length > Math.max(xIdx, yIdx)) {
                      // Store raw µm coordinates, same as single-sample Xenium loader.
                      // SpatialPlotView divides by spatialScaleFactor (0.2125) itself before
                      // applying the transformation matrix, so we must NOT pre-divide here.
                      const x = parseFloat(values[xIdx]);
                      const y = parseFloat(values[yIdx]);
                      if (isFinite(x) && isFinite(y)) {
                        coords.push([x, y]);
                        cellIds.push(values[idIdx] !== undefined ? values[idIdx] : String(coords.length - 1));
                        if (x < xMin) xMin = x;
                        if (x > xMax) xMax = x;
                        if (y < yMin) yMin = y;
                        if (y > yMax) yMax = y;
                      }
                    }
                  }
                  perSampleSpatial[ds.name] = {
                    spatialCoordinates: coords,
                    cellIds,
                    spatialExtent: coords.length > 0 ? { xMin, xMax, yMin, yMax } : null,
                    metadata: payload.perSampleSpatialInfo?.[i]?.metadata || null,
                  };
                }
              }
            }
          } catch (e) {
            console.warn(`Failed to parse spatial coords for "${ds.name}":`, e);
          }
        }
      }

      // Run MNN integration pipeline (same as scRNA-seq integration)
      loadedData = {
        path: xeniumDatasetList[0].path,
        info: { modality: 'xenium-integration', datasetNames, format: 'Xenium Integration' },
        dataset: null,
        datasets: datasetsForBakana,
        nCells: 0,
        nGenes: 0,
        rawCells: 0,
        rawGenes: 0,
        cellBarcodes: null,
        state: null,
        spatialData: null,
        spatialInfo: null,
        datasetBytes: totalBytes,
      };
      const prevResultsXenium = payload.previousResults || null;
      const hasPreviousXenium = prevResultsXenium?.umapCoordinates?.length > 0 && prevResultsXenium?.clusters?.length > 0;
      if (hasPreviousXenium) {
        self.postMessage({ type: 'STATUS_UPDATE', message: 'Restoring previous Xenium integration results (normalizing data)...' });
        const baseParams = buildDefaultParameters({ fastMode: false });
        baseParams.batch_correction = baseParams.batch_correction || {};
        baseParams.batch_correction.method = 'mnn';
        baseParams.rna_pca = baseParams.rna_pca || {};
        baseParams.rna_pca.block_method = 'project';
        baseParams.umap = baseParams.umap || {};
        baseParams.umap.min_dist = 0.4;
        analysisState = await bakana.createAnalysis();
        await runRnaOnlyAnalysis(analysisState, datasetsForBakana, baseParams, {
          startFun: async (step) => {
            self.postMessage({ type: 'STATUS_UPDATE', message: `Xenium integration: ${step}...` });
          },
          finishFun: async () => {},
          stopAfterStep: 'rna_normalization',
        });
        const filterState = analysisState.cell_filtering;
        const filteredMatrix = filterState && typeof filterState.fetchFilteredMatrix === 'function' ? filterState.fetchFilteredMatrix() : null;
        const nCellsPrev = filteredMatrix ? filteredMatrix.numberOfColumns() : analysisState.inputs.fetchCountMatrix().get(analysisState.inputs.fetchCountMatrix().available()[0]).numberOfColumns();
        const countMatrix = analysisState.inputs.fetchCountMatrix();
        const available = countMatrix.available();
        const rnaMatrix = countMatrix.get(available[0]);
        const nGenesPrev = rnaMatrix.numberOfRows();
        if (nCellsPrev !== prevResultsXenium.umapCoordinates.length || nCellsPrev !== prevResultsXenium.clusters.length) {
          console.warn('CellPilot: previous Xenium integration cell count mismatch, running full pipeline');
        } else {
          loadedData.state = analysisState;
          loadedData.nCells = nCellsPrev;
          loadedData.nGenes = nGenesPrev;
          loadedData.rawCells = nCellsPrev;
          loadedData.rawGenes = nGenesPrev;
          currentParameters = cloneStepParameters(bakana.retrieveParameters(analysisState));
          const annotations = analysisState.inputs.fetchCellAnnotations();
          let blockIds = null;
          let blockLevels = null;
          try {
            const xeniumFilterState = analysisState.cell_filtering;
            if (xeniumFilterState && typeof xeniumFilterState.fetchFilteredBlock === 'function') {
              const block = xeniumFilterState.fetchFilteredBlock();
              if (block && block.length === nCellsPrev) {
                blockIds = Array.from(block);
                const levels = analysisState.inputs.fetchBlockLevels();
                blockLevels = levels ? Array.from(levels) : datasetNames;
              }
            }
          } catch (e) {
            console.warn('Xenium integration restore: could not get block:', e);
          }
          if ((!blockIds || !blockLevels) && annotations && annotations.hasColumn && annotations.hasColumn('__batch__')) {
            try {
              const batchCol = annotations.column('__batch__');
              const batchLen = batchCol?.length ?? (Array.isArray(batchCol) ? batchCol.length : 0);
              if (batchLen === nCellsPrev) {
                const batchNames = Array.from(batchCol);
                blockLevels = datasetNames.slice();
                blockIds = batchNames.map((name) => {
                  const idx = blockLevels.indexOf(name);
                  return idx >= 0 ? idx : 0;
                });
              }
            } catch (e) {
              console.warn('Xenium integration restore: __batch__ fallback failed:', e);
            }
          }
          if (!blockIds || !blockLevels) {
            blockLevels = datasetNames.slice();
            blockIds = Array(nCellsPrev).fill(0);
          }
          const integrationViews = {};
          for (let v = 0; v < blockLevels.length; v++) {
            const name = blockLevels[v];
            const indices = [];
            for (let i = 0; i < blockIds.length; i++) {
              if (blockIds[i] === v) indices.push(i);
            }
            integrationViews[name] = { indices };
          }
          loadedData.integrationViews = integrationViews;
          let cellBarcodesList = [];
          const filteredBarcodes = getOrderedBarcodesFromFilteredState(analysisState);
          if (filteredBarcodes && filteredBarcodes.length === nCellsPrev) {
            cellBarcodesList = filteredBarcodes;
          } else {
            const keepResult = analysisState.cell_filtering?.fetchKeep?.();
            let keepMask = null;
            if (keepResult) {
              if (typeof keepResult.array === 'function') keepMask = keepResult.array();
              else if (typeof keepResult.toArray === 'function') keepMask = keepResult.toArray();
              else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) keepMask = keepResult;
            }
            const block = analysisState.cell_filtering?.fetchFilteredBlock?.();
            const blockArray = block ? (typeof block.array === 'function' ? block.array() : Array.from(block)) : null;
            if (keepMask && blockArray && blockArray.length === nCellsPrev) {
              const nRaw = keepMask.length;
              const levels = blockLevels?.length ? blockLevels : datasetNames;
              const sampleOffsets = [];
              let offset = 0;
              for (let s = 0; s < levels.length; s++) {
                sampleOffsets.push(offset);
                const sp = perSampleSpatial[levels[s]];
                offset += (sp && Array.isArray(sp.cellIds)) ? sp.cellIds.length : 0;
              }
              const rawToFiltered = [];
              for (let r = 0; r < nRaw; r++) {
                if (keepMask[r]) rawToFiltered.push(r);
              }
              for (let j = 0; j < nCellsPrev; j++) {
                const rawIdx = rawToFiltered[j];
                if (rawIdx == null) {
                  cellBarcodesList.push(`cell_${j}`);
                  continue;
                }
                const blockId = blockArray[j];
                const sampleName = levels && blockId >= 0 && blockId < levels.length ? levels[blockId] : datasetNames[0];
                const sampleStart = sampleOffsets[blockId >= 0 && blockId < sampleOffsets.length ? blockId : 0];
                const inSampleIdx = rawIdx - sampleStart;
                const sampleSpatial = perSampleSpatial[sampleName];
                const cellId = sampleSpatial?.cellIds?.[inSampleIdx];
                cellBarcodesList.push(cellId != null ? String(cellId) : `cell_${j}`);
              }
            } else {
              for (let i = 0; i < nCellsPrev; i++) cellBarcodesList.push(`cell_${i}`);
              console.warn('Xenium integration restore: using fallback cell_N (spatial alignment may be approximate)');
            }
          }
          loadedData.cellBarcodes = cellBarcodesList;
          currentResults.umap = prevResultsXenium.umapCoordinates;
          currentResults.clusters = prevResultsXenium.clusters;
          const nClustersPrev = prevResultsXenium.nClusters != null ? prevResultsXenium.nClusters : new Set(prevResultsXenium.clusters).size;

          // Align per-sample spatial coordinates to filtered cell order (same as full pipeline)
          // so spatial plot colors match cluster assignments; without this, coords are in CSV order and matching is wrong
          for (const name of datasetNames) {
            const sampleSpatial = perSampleSpatial[name];
            if (!sampleSpatial || !Array.isArray(sampleSpatial.cellIds)) continue;
            const { cellIds, spatialCoordinates: allCoords } = sampleSpatial;
            const cellIdToIdx = new Map();
            for (let k = 0; k < cellIds.length; k++) {
              const id = String(cellIds[k]);
              cellIdToIdx.set(id, k);
              const num = parseInt(id, 10);
              if (!isNaN(num)) {
                const numStr = String(num);
                if (!cellIdToIdx.has(numStr)) cellIdToIdx.set(numStr, k);
              }
            }
            const sampleIndices = integrationViews[name]?.indices || [];
            const alignedCoords = new Array(sampleIndices.length);
            let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
            let matchedCount = 0;
            for (let j = 0; j < sampleIndices.length; j++) {
              const globalIdx = sampleIndices[j];
              const fullBarcode = String(cellBarcodesList[globalIdx] || '');
              let csvIdx = cellIdToIdx.get(fullBarcode);
              if (csvIdx === undefined && fullBarcode.includes('_')) {
                const parts = fullBarcode.split('_');
                for (let p = 1; p < parts.length && csvIdx === undefined; p++) {
                  csvIdx = cellIdToIdx.get(parts.slice(p).join('_'));
                }
              }
              if (csvIdx === undefined) {
                const numMatch = fullBarcode.match(/(\d+)$/);
                if (numMatch) csvIdx = cellIdToIdx.get(numMatch[1]);
              }
              if (csvIdx !== undefined) {
                const coord = allCoords[csvIdx];
                alignedCoords[j] = coord;
                if (coord[0] < xMin) xMin = coord[0];
                if (coord[0] > xMax) xMax = coord[0];
                if (coord[1] < yMin) yMin = coord[1];
                if (coord[1] > yMax) yMax = coord[1];
                matchedCount++;
              } else {
                alignedCoords[j] = null;
              }
            }
            if (matchedCount < sampleIndices.length * 0.5 && allCoords.length > 0) {
              xMin = Infinity; xMax = -Infinity; yMin = Infinity; yMax = -Infinity;
              for (let j = 0; j < sampleIndices.length; j++) {
                const coord = allCoords[Math.min(j, allCoords.length - 1)];
                alignedCoords[j] = coord;
                if (coord[0] < xMin) xMin = coord[0];
                if (coord[0] > xMax) xMax = coord[0];
                if (coord[1] < yMin) yMin = coord[1];
                if (coord[1] > yMax) yMax = coord[1];
              }
            } else {
              for (let j = 0; j < alignedCoords.length; j++) {
                if (alignedCoords[j] === null) alignedCoords[j] = [0, 0];
              }
            }
            sampleSpatial.spatialCoordinates = alignedCoords;
            sampleSpatial.spatialExtent = Number.isFinite(xMin) ? { xMin, xMax, yMin, yMax } : null;
          }

          loadedData.perSampleSpatial = perSampleSpatial;
          self.postMessage({
            type: 'DATA_LOADED',
            data: {
              path: loadedData.path,
              cells: nCellsPrev,
              genes: nGenesPrev,
              rawCells: nCellsPrev,
              rawGenes: nGenesPrev,
              modality: 'xenium-integration',
              datasetNames,
              perSampleSpatial,
            },
          });
          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              type: 'umap',
              coordinates: prevResultsXenium.umapCoordinates,
              clusters: prevResultsXenium.clusters,
              nClusters: nClustersPrev,
              nCells: nCellsPrev,
              source: 'integration',
              integrationViews,
              datasetNames,
              perSampleSpatial,
              restoredClusterLabelMap: prevResultsXenium.clusterLabelMap || {},
              restoredClusterColorOverrides: prevResultsXenium.clusterColorOverrides || {},
            },
          });
          return;
        }
      }
      self.postMessage({ type: 'STATUS_UPDATE', message: 'Running Xenium integration (normalization, MNN, PCA, UMAP, clustering)...' });
      const baseParams = buildDefaultParameters({ fastMode: false });
      baseParams.batch_correction = baseParams.batch_correction || {};
      baseParams.batch_correction.method = 'mnn';
      baseParams.rna_pca = baseParams.rna_pca || {};
      baseParams.rna_pca.block_method = 'project';
      baseParams.umap = baseParams.umap || {};
      baseParams.umap.min_dist = 0.4;
      analysisState = await bakana.createAnalysis();
      await runRnaOnlyAnalysis(analysisState, datasetsForBakana, baseParams, {
        startFun: async (step) => {
          self.postMessage({ type: 'STATUS_UPDATE', message: `Xenium integration: ${step}...` });
        },
        finishFun: async () => {},
      });
      const filterState = analysisState.cell_filtering;
      const filteredMatrix = filterState && typeof filterState.fetchFilteredMatrix === 'function' ? filterState.fetchFilteredMatrix() : null;
      const nCells = filteredMatrix ? filteredMatrix.numberOfColumns() : analysisState.inputs.fetchCountMatrix().get(analysisState.inputs.fetchCountMatrix().available()[0]).numberOfColumns();
      const countMatrix = analysisState.inputs.fetchCountMatrix();
      const available = countMatrix.available();
      const rnaMatrix = countMatrix.get(available[0]);
      const nGenes = rnaMatrix.numberOfRows();
      loadedData.state = analysisState;
      loadedData.nCells = nCells;
      loadedData.nGenes = nGenes;
      loadedData.rawCells = nCells;
      loadedData.rawGenes = nGenes;
      currentParameters = cloneStepParameters(bakana.retrieveParameters(analysisState));
      const annotations = analysisState.inputs.fetchCellAnnotations();
      let blockIds = null;
      let blockLevels = null;
      try {
        const xeniumFilterState = analysisState.cell_filtering;
        if (xeniumFilterState && typeof xeniumFilterState.fetchFilteredBlock === 'function') {
          const block = xeniumFilterState.fetchFilteredBlock();
          if (block && block.length === nCells) {
            blockIds = Array.from(block);
            const levels = analysisState.inputs.fetchBlockLevels();
            blockLevels = levels ? Array.from(levels) : datasetNames;
          }
        }
      } catch (e) {
        console.warn('Xenium integration: could not get block from filtering state:', e);
      }
      if ((!blockIds || !blockLevels) && annotations && typeof annotations.column === 'function' && annotations.hasColumn && annotations.hasColumn('__batch__')) {
        try {
          const batchCol = annotations.column('__batch__');
          const batchLen = batchCol?.length ?? (Array.isArray(batchCol) ? batchCol.length : 0);
          if (batchLen === nCells) {
            const batchNames = Array.from(batchCol);
            const order = datasetNames.slice();
            blockLevels = order;
            blockIds = batchNames.map((name) => {
              const idx = order.indexOf(name);
              return idx >= 0 ? idx : 0;
            });
          }
        } catch (e) {
          console.warn('Xenium integration: could not get block from __batch__:', e);
        }
      }
      if (!blockIds || !blockLevels) {
        blockLevels = datasetNames.slice();
        blockIds = Array(nCells).fill(0);
      }
      const coordinates = await analysisState.umap.fetchResults({ copy: true });
      const x = coordinates?.x;
      const y = coordinates?.y;
      const coordLen = x?.length ?? y?.length ?? nCells;
      const umapCoords = Array.from({ length: coordLen }, (_, i) => [
        x && i < x.length ? x[i] : NaN,
        y && i < y.length ? y[i] : NaN,
      ]);
      const clusterState = analysisState.choose_clustering;
      const clusterArray = clusterState && typeof clusterState.fetchClusters === 'function' ? Array.from(clusterState.fetchClusters()) : Array(nCells).fill(0);
      const nClusters = new Set(clusterArray).size;
      currentResults.umap = umapCoords;
      currentResults.clusters = clusterArray;
      const integrationViews = {};
      const numLevels = Array.isArray(blockLevels) ? blockLevels.length : 0;
      const numBlockIds = Array.isArray(blockIds) ? blockIds.length : 0;
      for (let v = 0; v < numLevels; v++) {
        const name = blockLevels[v];
        const indices = [];
        for (let i = 0; i < numBlockIds; i++) {
          if (blockIds[i] === v) indices.push(i);
        }
        integrationViews[name] = { indices };
      }
      // Store integrationViews on loadedData so "plot clusters" can re-send them later
      loadedData.integrationViews = integrationViews;
      let cellBarcodesList = [];
      // Prefer bakana annotations (rowNames or barcode column), then fall back to spatial cellIds
      const filteredBarcodes = getOrderedBarcodesFromFilteredState(analysisState);
      if (filteredBarcodes && filteredBarcodes.length === nCells) {
        cellBarcodesList = filteredBarcodes;
      } else {
        // Build barcodes from per-sample spatial cellIds (H5 format often lacks barcodes in annotations).
        // Map each filtered cell to its original cell_id via keep mask + block structure.
        const keepResult = analysisState.cell_filtering?.fetchKeep?.();
        let keepMask = null;
        if (keepResult) {
          if (typeof keepResult.array === 'function') keepMask = keepResult.array();
          else if (typeof keepResult.toArray === 'function') keepMask = keepResult.toArray();
          else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) keepMask = keepResult;
        }
        const block = analysisState.cell_filtering?.fetchFilteredBlock?.();
        const blockArray = block ? (typeof block.array === 'function' ? block.array() : Array.from(block)) : null;

        if (keepMask && blockArray && blockArray.length === nCells) {
          const nRaw = keepMask.length;
          const levels = (blockLevels && blockLevels.length) ? blockLevels : datasetNames;
          const sampleOffsets = [];
          let offset = 0;
          for (let s = 0; s < levels.length; s++) {
            sampleOffsets.push(offset);
            const sp = perSampleSpatial[levels[s]];
            offset += (sp && Array.isArray(sp.cellIds)) ? sp.cellIds.length : 0;
          }
          const rawToFiltered = [];
          for (let r = 0; r < nRaw; r++) {
            if (keepMask[r]) rawToFiltered.push(r);
          }
          for (let j = 0; j < nCells; j++) {
            const rawIdx = rawToFiltered[j];
            if (rawIdx == null) {
              cellBarcodesList.push(`cell_${j}`);
              continue;
            }
            const blockId = blockArray[j];
            const sampleName = levels && blockId >= 0 && blockId < levels.length ? levels[blockId] : datasetNames[0];
            const sampleStart = sampleOffsets[blockId >= 0 && blockId < sampleOffsets.length ? blockId : 0];
            const inSampleIdx = rawIdx - sampleStart;
            const sampleSpatial = perSampleSpatial[sampleName];
            const cellId = sampleSpatial?.cellIds?.[inSampleIdx];
            cellBarcodesList.push(cellId != null ? String(cellId) : `cell_${j}`);
          }
        } else {
          for (let i = 0; i < nCells; i++) cellBarcodesList.push(`cell_${i}`);
          console.warn('Xenium integration: could not derive barcodes, using fallback cell_N (spatial alignment may fail)');
        }
      }
      loadedData.cellBarcodes = cellBarcodesList;

      // Align per-sample spatial coordinates with bakana's filtered cell order.
      // perSampleSpatial[name].spatialCoordinates is in CSV row order (all cells),
      // but integrationViews[name].indices are indices into the global filtered array.
      // Reorder so coord[j] matches the j-th filtered cell for each sample.
      for (const name of datasetNames) {
        const sampleSpatial = perSampleSpatial[name];
        if (!sampleSpatial || !Array.isArray(sampleSpatial.cellIds)) continue;
        const { cellIds, spatialCoordinates: allCoords } = sampleSpatial;

        // Build cellId → CSV row index lookup (store both original string and numeric normalization)
        const cellIdToIdx = new Map();
        for (let k = 0; k < cellIds.length; k++) {
          const id = String(cellIds[k]);
          cellIdToIdx.set(id, k);
          // Also index by parsed integer (strips leading zeros etc.)
          const num = parseInt(id, 10);
          if (!isNaN(num)) {
            const numStr = String(num);
            if (!cellIdToIdx.has(numStr)) cellIdToIdx.set(numStr, k);
          }
        }

        const sampleIndices = integrationViews[name]?.indices || [];

        // Diagnostic: log first few barcodes to help diagnose format mismatches
        if (sampleIndices.length > 0) {
          const firstBarcodes = sampleIndices.slice(0, 5).map(i => String(cellBarcodesList[i] || ''));
          const firstCsvIds = cellIds.slice(0, 5).map(id => String(id));
        }

        const alignedCoords = new Array(sampleIndices.length);
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        let matchedCount = 0;

        for (let j = 0; j < sampleIndices.length; j++) {
          const globalIdx = sampleIndices[j];
          const fullBarcode = String(cellBarcodesList[globalIdx] || '');
          let csvIdx;

          // Strategy 1: direct match
          csvIdx = cellIdToIdx.get(fullBarcode);

          // Strategy 2: strip sample-name prefix (parts separated by underscore)
          // e.g. "Day42_1" → try "1"; "SampleA_plate1_42" → try "plate1_42" then "42"
          if (csvIdx === undefined && fullBarcode.includes('_')) {
            const parts = fullBarcode.split('_');
            for (let p = 1; p < parts.length && csvIdx === undefined; p++) {
              csvIdx = cellIdToIdx.get(parts.slice(p).join('_'));
            }
          }

          // Strategy 3: extract trailing numeric suffix (e.g. "AAACCTGAGAAACCAT-1" → "1")
          if (csvIdx === undefined) {
            const numMatch = fullBarcode.match(/(\d+)$/);
            if (numMatch) csvIdx = cellIdToIdx.get(numMatch[1]);
          }

          if (csvIdx !== undefined) {
            const coord = allCoords[csvIdx];
            alignedCoords[j] = coord;
            if (coord[0] < xMin) xMin = coord[0];
            if (coord[0] > xMax) xMax = coord[0];
            if (coord[1] < yMin) yMin = coord[1];
            if (coord[1] > yMax) yMax = coord[1];
            matchedCount++;
          } else {
            alignedCoords[j] = null; // placeholder for positional fallback below
          }
        }


        // Positional fallback: if fewer than 50% matched by barcode, use CSV row order directly.
        // This assumes bakana preserves the relative order of cells within each sample after QC filtering.
        if (matchedCount < sampleIndices.length * 0.5 && allCoords.length > 0) {
          xMin = Infinity; xMax = -Infinity; yMin = Infinity; yMax = -Infinity;
          for (let j = 0; j < sampleIndices.length; j++) {
            const coord = allCoords[Math.min(j, allCoords.length - 1)];
            alignedCoords[j] = coord;
            if (coord[0] < xMin) xMin = coord[0];
            if (coord[0] > xMax) xMax = coord[0];
            if (coord[1] < yMin) yMin = coord[1];
            if (coord[1] > yMax) yMax = coord[1];
          }
        } else {
          // Fill any remaining null placeholders with [0, 0] (unmatched minority of cells)
          for (let j = 0; j < alignedCoords.length; j++) {
            if (alignedCoords[j] === null) alignedCoords[j] = [0, 0];
          }
        }

        sampleSpatial.spatialCoordinates = alignedCoords;
        sampleSpatial.spatialExtent = Number.isFinite(xMin) ? { xMin, xMax, yMin, yMax } : null;
      }

      loadedData.perSampleSpatial = perSampleSpatial;
      self.postMessage({
        type: 'DATA_LOADED',
        data: {
          path: loadedData.path,
          cells: nCells,
          genes: nGenes,
          rawCells: nCells,
          rawGenes: nGenes,
          modality: 'xenium-integration',
          datasetNames,
          perSampleSpatial,
        },
      });
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: umapCoords,
          clusters: clusterArray,
          nClusters,
          nCells,
          source: 'integration',
          integrationViews,
          datasetNames,
          perSampleSpatial,
        },
      });
      return;
    }

    // Visium HD Integration: 2-sample Visium HD with MNN batch correction:
    if (isVisiumHDIntegration) {
      const visiumHDDatasetList = payload.visiumHDDatasets;
      const datasetNames = visiumHDDatasetList.map((d) => d.name);
      const datasetsForBakana = {};
      let totalBytes = 0;

      // Parse per-sample spatial coordinates from GeoJSON cellSegmentation
      const perSampleSpatial = {};
      for (let i = 0; i < visiumHDDatasetList.length; i++) {
        const ds = visiumHDDatasetList[i];
        const f = ds.files || {};
        self.postMessage({ type: 'STATUS_UPDATE', message: `Parsing Visium HD sample "${ds.name}"...` });

        // Build bakana dataset from cell_feature_matrix (HDF5 or MatrixMarket)
        let dset;
        if (f.h5) {
          const h5Data = ensureUint8Array(f.h5.data, `${ds.name} HDF5`);
          totalBytes += h5Data.length;
          const h5Blob = new File([h5Data], f.h5.name || 'filtered_feature_cell_matrix.h5', { type: 'application/octet-stream' });
          dset = new bakana.TenxHdf5Dataset(h5Blob);
        } else if (f.matrix && f.features && f.barcodes) {
          const matrixData = ensureUint8Array(f.matrix.data, `${ds.name} matrix`);
          const featuresData = ensureUint8Array(f.features.data, `${ds.name} features`);
          const barcodesData = ensureUint8Array(f.barcodes.data, `${ds.name} barcodes`);
          totalBytes += matrixData.length + featuresData.length + barcodesData.length;
          const matrixBlob = new File([matrixData], f.matrix.name, { type: 'application/gzip' });
          const featuresBlob = new File([featuresData], f.features.name, { type: 'application/gzip' });
          const barcodesBlob = new File([barcodesData], f.barcodes.name, { type: 'application/gzip' });
          dset = new bakana.TenxMatrixMarketDataset(matrixBlob, featuresBlob, barcodesBlob);
        } else {
          throw new Error(`Visium HD sample "${ds.name}": cell feature matrix missing`);
        }
        datasetsForBakana[ds.name] = dset;

        // Parse spatial coordinates from GeoJSON cell segmentation
        if (f.cellSegmentation?.data) {
          try {
            const rawBuf = ensureUint8Array(f.cellSegmentation.data, `${ds.name} cellSegmentation`);
            const jsonText = new TextDecoder().decode(rawBuf);
            const geojson = JSON.parse(jsonText);

            if (geojson && geojson.features && Array.isArray(geojson.features)) {
              const coords = [];
              const cellIds = [];
              let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;

              for (const feature of geojson.features) {
                if (feature.geometry?.type !== 'Polygon') continue;
                const numericId = feature.properties?.cell_id;
                if (numericId == null) continue;

                const cellId = numericToBarcodeId(numericId);
                const coordinates = feature.geometry.coordinates[0];
                if (!Array.isArray(coordinates) || coordinates.length < 3) continue;

                // Calculate centroid from polygon
                let sumX = 0, sumY = 0;
                for (const [cx, cy] of coordinates) {
                  sumX += cx;
                  sumY += cy;
                  if (cx < xMin) xMin = cx;
                  if (cx > xMax) xMax = cx;
                  if (cy < yMin) yMin = cy;
                  if (cy > yMax) yMax = cy;
                }
                const centroidX = sumX / coordinates.length;
                const centroidY = sumY / coordinates.length;

                coords.push([centroidX, centroidY]);
                cellIds.push(cellId);
              }

              if (coords.length > 0) {
                perSampleSpatial[ds.name] = {
                  spatialCoordinates: coords,
                  cellIds,
                  spatialExtent: { xMin, xMax, yMin, yMax },
                  metadata: payload.perSampleSpatialInfo?.[i]?.metadata || null,
                };
              }
            }
          } catch (e) {
            console.warn(`Failed to parse GeoJSON spatial coords for "${ds.name}":`, e);
          }
        }

        // Fallback for binned VisiumHD: parse tissue positions (CSV or parquet)
        if (!perSampleSpatial[ds.name] && f.tissuePositions?.data) {
          try {
            const rawBuf = ensureUint8Array(f.tissuePositions.data, `${ds.name} tissuePositions`);
            const isParquet = rawBuf.length >= 4 && rawBuf[0] === 0x50 && rawBuf[1] === 0x41 && rawBuf[2] === 0x52 && rawBuf[3] === 0x31;

            if (isParquet) {
              // Parse parquet tissue positions using hyparquet
              self.postMessage({ type: 'STATUS_UPDATE', message: `Parsing spatial coordinates for "${ds.name}" from parquet...` });
              if (!hyparquetCompressors) {
                const compModule = await import('hyparquet-compressors');
                hyparquetCompressors = compModule.compressors;
              }
              const resolvedCompressors = hyparquetCompressors;
              const arrayBuffer = rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength);
              const asyncBuffer = {
                byteLength: arrayBuffer.byteLength,
                slice: (start, end) => Promise.resolve(arrayBuffer.slice(start, end)),
              };
              const parquetData = await new Promise((resolve, reject) => {
                parquetRead({
                  file: asyncBuffer,
                  compressors: resolvedCompressors,
                  onComplete: (data) => resolve(data),
                }).catch(reject);
              });
              if (parquetData && parquetData.length > 0) {
                const columns = Object.keys(parquetData[0]);
                let barcodeCol = columns.find(c => /barcode/i.test(c));
                let xCol = columns.find(c => /pxl_col/i.test(c));
                let yCol = columns.find(c => /pxl_row/i.test(c));
                // Visium HD binned: numeric column names (0=barcode, 4=y, 5=x)
                if (!barcodeCol || !xCol || !yCol) {
                  const allNumeric = columns.length > 0 && columns.every(c => /^\d+$/.test(String(c)));
                  if (allNumeric && columns.length >= 6 && columns.includes('0') && columns.includes('4') && columns.includes('5')) {
                    barcodeCol = '0'; xCol = '5'; yCol = '4';
                  }
                }
                if (barcodeCol && xCol && yCol) {
                  const coords = [], cellIds = [];
                  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
                  for (const row of parquetData) {
                    const barcode = row[barcodeCol];
                    const x = parseFloat(row[xCol]);
                    const y = parseFloat(row[yCol]);
                    if (barcode != null && barcode !== '' && isFinite(x) && isFinite(y)) {
                      coords.push([x, y]);
                      const barcodeStr = String(barcode);
                      cellIds.push(barcodeStr);
                      if (x < xMin) xMin = x;
                      if (x > xMax) xMax = x;
                      if (y < yMin) yMin = y;
                      if (y > yMax) yMax = y;
                    }
                  }
                  if (coords.length > 0) {
                    perSampleSpatial[ds.name] = {
                      spatialCoordinates: coords,
                      cellIds,
                      spatialExtent: { xMin, xMax, yMin, yMax },
                      metadata: payload.perSampleSpatialInfo?.[i]?.metadata || null,
                    };
                  }
                } else {
                  console.warn(`Visium HD "${ds.name}": could not find barcode/x/y columns in parquet. Columns:`, columns);
                }
              }
            } else {
              // CSV tissue positions
              const csvText = new TextDecoder().decode(rawBuf);
              const lines = csvText.trim().split('\n');
              if (lines.length > 1) {
                const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
                let barcodeIdx = headers.findIndex(h => /barcode/i.test(h));
                let xIdx = headers.findIndex(h => /pxl_col/i.test(h));
                let yIdx = headers.findIndex(h => /pxl_row/i.test(h));
                if (barcodeIdx < 0) barcodeIdx = 0;
                if (xIdx < 0 || yIdx < 0) {
                  if (headers.every(h => /^\d+$/.test(h)) && headers.length >= 6) {
                    barcodeIdx = 0; xIdx = 5; yIdx = 4;
                  }
                }
                if (xIdx >= 0 && yIdx >= 0) {
                  const coords = [], cellIds = [];
                  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
                  for (let j = 1; j < lines.length; j++) {
                    const vals = lines[j].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
                    const x = parseFloat(vals[xIdx]);
                    const y = parseFloat(vals[yIdx]);
                    if (isFinite(x) && isFinite(y)) {
                      coords.push([x, y]);
                      cellIds.push(vals[barcodeIdx] || String(coords.length - 1));
                      if (x < xMin) xMin = x;
                      if (x > xMax) xMax = x;
                      if (y < yMin) yMin = y;
                      if (y > yMax) yMax = y;
                    }
                  }
                  if (coords.length > 0) {
                    perSampleSpatial[ds.name] = {
                      spatialCoordinates: coords,
                      cellIds,
                      spatialExtent: { xMin, xMax, yMin, yMax },
                      metadata: payload.perSampleSpatialInfo?.[i]?.metadata || null,
                    };
                  }
                }
              }
            }
          } catch (e) {
            console.warn(`Failed to parse tissue positions for "${ds.name}":`, e);
          }
        }
      }

      // Run MNN integration pipeline
      loadedData = {
        path: visiumHDDatasetList[0].path,
        info: { modality: 'visium-hd-integration', datasetNames, format: 'Visium HD Integration' },
        dataset: null,
        datasets: datasetsForBakana,
        nCells: 0,
        nGenes: 0,
        rawCells: 0,
        rawGenes: 0,
        cellBarcodes: null,
        state: null,
        spatialData: null,
        spatialInfo: null,
        datasetBytes: totalBytes,
      };

      const prevResultsHD = payload.previousResults || null;
      const hasPreviousHD = prevResultsHD?.umapCoordinates?.length > 0 && prevResultsHD?.clusters?.length > 0;

      if (hasPreviousHD) {
        self.postMessage({ type: 'STATUS_UPDATE', message: 'Restoring previous Visium HD integration results (normalizing data)...' });
        const baseParams = buildDefaultParameters({ fastMode: false });
        baseParams.batch_correction = baseParams.batch_correction || {};
        baseParams.batch_correction.method = 'mnn';
        baseParams.rna_pca = baseParams.rna_pca || {};
        baseParams.rna_pca.block_method = 'project';
        baseParams.umap = baseParams.umap || {};
        baseParams.umap.min_dist = 0.4;
        analysisState = await bakana.createAnalysis();
        await runRnaOnlyAnalysis(analysisState, datasetsForBakana, baseParams, {
          startFun: async (step) => {
            self.postMessage({ type: 'STATUS_UPDATE', message: `Visium HD integration: ${step}...` });
          },
          finishFun: async () => {},
          stopAfterStep: 'rna_normalization',
        });
        const filterState = analysisState.cell_filtering;
        const filteredMatrix = filterState && typeof filterState.fetchFilteredMatrix === 'function' ? filterState.fetchFilteredMatrix() : null;
        const nCellsPrev = filteredMatrix ? filteredMatrix.numberOfColumns() : analysisState.inputs.fetchCountMatrix().get(analysisState.inputs.fetchCountMatrix().available()[0]).numberOfColumns();
        const countMatrix = analysisState.inputs.fetchCountMatrix();
        const available = countMatrix.available();
        const rnaMatrix = countMatrix.get(available[0]);
        const nGenesPrev = rnaMatrix.numberOfRows();

        if (nCellsPrev !== prevResultsHD.umapCoordinates.length || nCellsPrev !== prevResultsHD.clusters.length) {
          console.warn('CellPilot: previous Visium HD integration cell count mismatch, running full pipeline');
        } else {
          loadedData.state = analysisState;
          loadedData.nCells = nCellsPrev;
          loadedData.nGenes = nGenesPrev;
          loadedData.rawCells = nCellsPrev;
          loadedData.rawGenes = nGenesPrev;
          currentParameters = cloneStepParameters(bakana.retrieveParameters(analysisState));
          const annotations = analysisState.inputs.fetchCellAnnotations();
          let blockIds = null;
          let blockLevels = null;
          try {
            const hdFilterState = analysisState.cell_filtering;
            if (hdFilterState && typeof hdFilterState.fetchFilteredBlock === 'function') {
              const block = hdFilterState.fetchFilteredBlock();
              if (block && block.length === nCellsPrev) {
                blockIds = Array.from(block);
                const levels = analysisState.inputs.fetchBlockLevels();
                blockLevels = levels ? Array.from(levels) : datasetNames;
              }
            }
          } catch (e) {
            console.warn('Visium HD integration restore: could not get block:', e);
          }
          if ((!blockIds || !blockLevels) && annotations && annotations.hasColumn && annotations.hasColumn('__batch__')) {
            try {
              const batchCol = annotations.column('__batch__');
              const batchLen = batchCol?.length ?? (Array.isArray(batchCol) ? batchCol.length : 0);
              if (batchLen === nCellsPrev) {
                const batchNames = Array.from(batchCol);
                blockLevels = datasetNames.slice();
                blockIds = batchNames.map((name) => {
                  const idx = blockLevels.indexOf(name);
                  return idx >= 0 ? idx : 0;
                });
              }
            } catch (e) {
              console.warn('Visium HD integration restore: __batch__ fallback failed:', e);
            }
          }
          if (!blockIds || !blockLevels) {
            blockLevels = datasetNames.slice();
            blockIds = Array(nCellsPrev).fill(0);
          }
          const integrationViews = {};
          for (let v = 0; v < blockLevels.length; v++) {
            const name = blockLevels[v];
            const indices = [];
            for (let i = 0; i < blockIds.length; i++) {
              if (blockIds[i] === v) indices.push(i);
            }
            integrationViews[name] = { indices };
          }
          loadedData.integrationViews = integrationViews;

          // Extract barcodes from bakana annotations (without requiring UMAP)
          let cellBarcodesList = [];
          {
            const annotations = analysisState.inputs.fetchCellAnnotations();
            // First try: annotations already have filtered-length barcodes
            let barcodes = extractOrderedBarcodesFromAnnotations(annotations, nCellsPrev);
            if (!barcodes) {
              // Second try: use keep mask to filter full-length barcodes
              const keepResult = analysisState.cell_filtering?.fetchKeep?.();
              let mask = null;
              if (keepResult) {
                if (typeof keepResult.array === 'function') mask = keepResult.array();
                else if (typeof keepResult.toArray === 'function') mask = keepResult.toArray();
                else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) mask = keepResult;
              }
              let fullBarcodes = null;
              if (typeof annotations?.rowNames === 'function') {
                const rows = annotations.rowNames();
                if (rows && rows.length > 0) fullBarcodes = Array.from(rows);
              }
              if (!fullBarcodes && typeof annotations?.columnNames === 'function' && typeof annotations?.column === 'function') {
                const columnNames = annotations.columnNames();
                const preferred = ['cell_id', 'barcode', 'Barcode', 'cell', 'id', 'CellID'];
                for (const name of preferred) {
                  if (columnNames.includes(name)) {
                    const col = annotations.column(name);
                    if (col && col.length > 0) { fullBarcodes = Array.from(col); break; }
                  }
                }
                if (!fullBarcodes && columnNames.length > 0) {
                  const col = annotations.column(columnNames[0]);
                  if (col && col.length > 0) fullBarcodes = Array.from(col);
                }
              }
              if (mask && fullBarcodes && fullBarcodes.length === mask.length) {
                const filtered = [];
                for (let i = 0; i < mask.length; i++) {
                  if (mask[i]) filtered.push(String(fullBarcodes[i]));
                }
                if (filtered.length === nCellsPrev) barcodes = filtered;
              }
            }
            if (barcodes && barcodes.length === nCellsPrev) {
              cellBarcodesList = barcodes;
            } else {
              for (let i = 0; i < nCellsPrev; i++) cellBarcodesList.push(`cell_${i}`);
              console.warn('Visium HD restore: could not extract barcodes, using fallback cell_N');
            }
          }
          loadedData.cellBarcodes = cellBarcodesList;
          currentResults.umap = prevResultsHD.umapCoordinates;
          currentResults.clusters = prevResultsHD.clusters;
          const nClustersPrev = prevResultsHD.nClusters != null ? prevResultsHD.nClusters : new Set(prevResultsHD.clusters).size;

          // Align per-sample spatial coordinates to filtered cell order
          // Build keep mask → raw index mapping for position-based fallback
          let restoreKeepMask = null;
          try {
            const kpResult = analysisState.cell_filtering?.fetchKeep?.();
            if (kpResult) {
              if (typeof kpResult.array === 'function') restoreKeepMask = kpResult.array();
              else if (typeof kpResult.toArray === 'function') restoreKeepMask = kpResult.toArray();
              else if (Array.isArray(kpResult) || kpResult instanceof Uint8Array) restoreKeepMask = kpResult;
            }
          } catch (e) { /* ignore */ }

          // Compute per-sample raw cell counts from block structure
          let rawBlockArray = null;
          try {
            const rawBlock = analysisState.inputs?.fetchBlock?.();
            if (rawBlock && rawBlock.length > 0) rawBlockArray = Array.from(rawBlock);
          } catch (e) { /* ignore */ }

          for (const name of datasetNames) {
            const sampleSpatial = perSampleSpatial[name];
            if (!sampleSpatial || !Array.isArray(sampleSpatial.cellIds)) continue;
            const { cellIds, spatialCoordinates: allCoords } = sampleSpatial;
            const cellIdToIdx = new Map();
            for (let k = 0; k < cellIds.length; k++) {
              const id = String(cellIds[k]);
              cellIdToIdx.set(id, k);
              const numMatch = id.match(/cellid_0*(\d+)-\d+/);
              if (numMatch) {
                cellIdToIdx.set(numMatch[1], k);
                const padded = numMatch[1].padStart(9, '0');
                if (padded !== numMatch[1]) cellIdToIdx.set(padded, k);
              }
              const dashIdx = id.lastIndexOf('-');
              if (dashIdx > 0) {
                const stripped = id.substring(0, dashIdx);
                if (!cellIdToIdx.has(stripped)) cellIdToIdx.set(stripped, k);
              }
            }
            const sampleIndices = integrationViews[name]?.indices || [];
            const alignedCoords = new Array(sampleIndices.length);
            let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
            let matchedCount = 0;
            for (let j = 0; j < sampleIndices.length; j++) {
              const globalIdx = sampleIndices[j];
              const fullBarcode = String(cellBarcodesList[globalIdx] || '');
              let csvIdx = cellIdToIdx.get(fullBarcode);
              if (csvIdx === undefined) {
                const dashIdx = fullBarcode.lastIndexOf('-');
                if (dashIdx > 0) csvIdx = cellIdToIdx.get(fullBarcode.substring(0, dashIdx));
              }
              if (csvIdx === undefined) {
                const numMatch = fullBarcode.match(/cellid_0*(\d+)-\d+/);
                if (numMatch) csvIdx = cellIdToIdx.get(numMatch[1]);
              }
              if (csvIdx === undefined && /^\d+$/.test(fullBarcode.trim())) {
                const cellidFormat = numericToBarcodeId(parseInt(fullBarcode, 10));
                csvIdx = cellIdToIdx.get(cellidFormat);
              }
              if (csvIdx !== undefined) {
                const coord = allCoords[csvIdx];
                alignedCoords[j] = coord;
                if (coord[0] < xMin) xMin = coord[0];
                if (coord[0] > xMax) xMax = coord[0];
                if (coord[1] < yMin) yMin = coord[1];
                if (coord[1] > yMax) yMax = coord[1];
                matchedCount++;
              } else {
                alignedCoords[j] = null;
              }
            }

            if (matchedCount < sampleIndices.length * 0.5 && allCoords.length > 0) {
              // Barcode matching failed, use keep mask + block for position-based alignment
              let positionMapped = false;
              if (restoreKeepMask && rawBlockArray) {
                const sampleBlockIdx = datasetNames.indexOf(name);
                if (sampleBlockIdx >= 0) {
                  // Compute raw start offset for this sample from raw block assignments
                  let sampleRawStart = 0;
                  for (let r = 0; r < rawBlockArray.length; r++) {
                    if (rawBlockArray[r] === sampleBlockIdx) { sampleRawStart = r; break; }
                  }
                  // Build filtered→raw index mapping
                  const rawToFilteredIdx = [];
                  for (let r = 0; r < restoreKeepMask.length; r++) {
                    if (restoreKeepMask[r]) rawToFilteredIdx.push(r);
                  }
                  xMin = Infinity; xMax = -Infinity; yMin = Infinity; yMax = -Infinity;
                  let posMatched = 0;
                  for (let j = 0; j < sampleIndices.length; j++) {
                    const globalIdx = sampleIndices[j];
                    const rawIdx = rawToFilteredIdx[globalIdx];
                    if (rawIdx != null && rawBlockArray[rawIdx] === sampleBlockIdx) {
                      const inSampleIdx = rawIdx - sampleRawStart;
                      if (inSampleIdx >= 0 && inSampleIdx < allCoords.length) {
                        const coord = allCoords[inSampleIdx];
                        alignedCoords[j] = coord;
                        if (coord[0] < xMin) xMin = coord[0];
                        if (coord[0] > xMax) xMax = coord[0];
                        if (coord[1] < yMin) yMin = coord[1];
                        if (coord[1] > yMax) yMax = coord[1];
                        posMatched++;
                      } else {
                        alignedCoords[j] = null;
                      }
                    } else {
                      alignedCoords[j] = null;
                    }
                  }
                  if (posMatched > sampleIndices.length * 0.5) {
                    positionMapped = true;
                  }
                }
              }
              if (!positionMapped) {
                console.warn(`Visium HD restore "${name}": position mapping failed, coordinates may be inaccurate`);
                xMin = Infinity; xMax = -Infinity; yMin = Infinity; yMax = -Infinity;
                for (let j = 0; j < sampleIndices.length; j++) {
                  const coord = allCoords[Math.min(j, allCoords.length - 1)];
                  alignedCoords[j] = coord;
                  if (coord[0] < xMin) xMin = coord[0];
                  if (coord[0] > xMax) xMax = coord[0];
                  if (coord[1] < yMin) yMin = coord[1];
                  if (coord[1] > yMax) yMax = coord[1];
                }
              }
            }
            // Fill any remaining null entries
            for (let j = 0; j < alignedCoords.length; j++) {
              if (alignedCoords[j] === null) alignedCoords[j] = [0, 0];
            }
            sampleSpatial.spatialCoordinates = alignedCoords;
            sampleSpatial.spatialExtent = Number.isFinite(xMin) ? { xMin, xMax, yMin, yMax } : null;
          }

          loadedData.perSampleSpatial = perSampleSpatial;
          self.postMessage({
            type: 'DATA_LOADED',
            data: {
              path: loadedData.path,
              cells: nCellsPrev,
              genes: nGenesPrev,
              rawCells: nCellsPrev,
              rawGenes: nGenesPrev,
              modality: 'visium-hd-integration',
              datasetNames,
              perSampleSpatial,
            },
          });
          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              type: 'umap',
              coordinates: prevResultsHD.umapCoordinates,
              clusters: prevResultsHD.clusters,
              nClusters: nClustersPrev,
              nCells: nCellsPrev,
              source: 'integration',
              integrationViews,
              datasetNames,
              perSampleSpatial,
              restoredClusterLabelMap: prevResultsHD.clusterLabelMap || {},
              restoredClusterColorOverrides: prevResultsHD.clusterColorOverrides || {},
            },
          });
          return;
        }
      }

      self.postMessage({ type: 'STATUS_UPDATE', message: 'Running Visium HD integration (normalization, MNN, PCA, UMAP, clustering)...' });
      const baseParamsHD = buildDefaultParameters({ fastMode: false });
      baseParamsHD.batch_correction = baseParamsHD.batch_correction || {};
      baseParamsHD.batch_correction.method = 'mnn';
      baseParamsHD.rna_pca = baseParamsHD.rna_pca || {};
      baseParamsHD.rna_pca.block_method = 'project';
      baseParamsHD.umap = baseParamsHD.umap || {};
      baseParamsHD.umap.min_dist = 0.4;
      analysisState = await bakana.createAnalysis();
      await runRnaOnlyAnalysis(analysisState, datasetsForBakana, baseParamsHD, {
        startFun: async (step) => {
          self.postMessage({ type: 'STATUS_UPDATE', message: `Visium HD integration: ${step}...` });
        },
        finishFun: async () => {},
      });
      const hdFilterState = analysisState.cell_filtering;
      const hdFilteredMatrix = hdFilterState && typeof hdFilterState.fetchFilteredMatrix === 'function' ? hdFilterState.fetchFilteredMatrix() : null;
      const nCellsHD = hdFilteredMatrix ? hdFilteredMatrix.numberOfColumns() : analysisState.inputs.fetchCountMatrix().get(analysisState.inputs.fetchCountMatrix().available()[0]).numberOfColumns();
      const hdCountMatrix = analysisState.inputs.fetchCountMatrix();
      const hdAvailable = hdCountMatrix.available();
      const hdRnaMatrix = hdCountMatrix.get(hdAvailable[0]);
      const nGenesHD = hdRnaMatrix.numberOfRows();
      loadedData.state = analysisState;
      loadedData.nCells = nCellsHD;
      loadedData.nGenes = nGenesHD;
      loadedData.rawCells = nCellsHD;
      loadedData.rawGenes = nGenesHD;
      currentParameters = cloneStepParameters(bakana.retrieveParameters(analysisState));
      const hdAnnotations = analysisState.inputs.fetchCellAnnotations();
      let hdBlockIds = null;
      let hdBlockLevels = null;
      try {
        const hdFs = analysisState.cell_filtering;
        if (hdFs && typeof hdFs.fetchFilteredBlock === 'function') {
          const block = hdFs.fetchFilteredBlock();
          if (block && block.length === nCellsHD) {
            hdBlockIds = Array.from(block);
            const levels = analysisState.inputs.fetchBlockLevels();
            hdBlockLevels = levels ? Array.from(levels) : datasetNames;
          }
        }
      } catch (e) {
        console.warn('Visium HD integration: could not get block from filtering state:', e);
      }
      if ((!hdBlockIds || !hdBlockLevels) && hdAnnotations && typeof hdAnnotations.column === 'function' && hdAnnotations.hasColumn && hdAnnotations.hasColumn('__batch__')) {
        try {
          const batchCol = hdAnnotations.column('__batch__');
          const batchLen = batchCol?.length ?? (Array.isArray(batchCol) ? batchCol.length : 0);
          if (batchLen === nCellsHD) {
            const batchNames = Array.from(batchCol);
            const order = datasetNames.slice();
            hdBlockLevels = order;
            hdBlockIds = batchNames.map((name) => {
              const idx = order.indexOf(name);
              return idx >= 0 ? idx : 0;
            });
          }
        } catch (e) {
          console.warn('Visium HD integration: could not get block from __batch__:', e);
        }
      }
      if (!hdBlockIds || !hdBlockLevels) {
        hdBlockLevels = datasetNames.slice();
        hdBlockIds = Array(nCellsHD).fill(0);
      }
      const hdCoordinates = await analysisState.umap.fetchResults({ copy: true });
      const hdX = hdCoordinates?.x;
      const hdY = hdCoordinates?.y;
      const hdCoordLen = hdX?.length ?? hdY?.length ?? nCellsHD;
      const hdUmapCoords = Array.from({ length: hdCoordLen }, (_, i) => [
        hdX && i < hdX.length ? hdX[i] : NaN,
        hdY && i < hdY.length ? hdY[i] : NaN,
      ]);
      const hdClusterState = analysisState.choose_clustering;
      const hdClusterArray = hdClusterState && typeof hdClusterState.fetchClusters === 'function' ? Array.from(hdClusterState.fetchClusters()) : Array(nCellsHD).fill(0);
      const hdNClusters = new Set(hdClusterArray).size;
      currentResults.umap = hdUmapCoords;
      currentResults.clusters = hdClusterArray;
      const hdIntegrationViews = {};
      for (let v = 0; v < hdBlockLevels.length; v++) {
        const name = hdBlockLevels[v];
        const indices = [];
        for (let i = 0; i < hdBlockIds.length; i++) {
          if (hdBlockIds[i] === v) indices.push(i);
        }
        hdIntegrationViews[name] = { indices };
      }
      loadedData.integrationViews = hdIntegrationViews;

      // Get barcodes from bakana annotations (UMAP was computed on full pipeline)
      let hdCellBarcodesList = [];
      const hdFilteredBarcodes = getOrderedBarcodesFromFilteredState(analysisState);
      if (hdFilteredBarcodes && hdFilteredBarcodes.length === nCellsHD) {
        hdCellBarcodesList = hdFilteredBarcodes;
      } else {
        // Fallback: try annotations + keep mask directly (same logic without UMAP dependency)
        const hdAnno2 = analysisState.inputs.fetchCellAnnotations();
        let hdBarcodes2 = extractOrderedBarcodesFromAnnotations(hdAnno2, nCellsHD);
        if (!hdBarcodes2) {
          const keepResult = analysisState.cell_filtering?.fetchKeep?.();
          let keepMask = null;
          if (keepResult) {
            if (typeof keepResult.array === 'function') keepMask = keepResult.array();
            else if (typeof keepResult.toArray === 'function') keepMask = keepResult.toArray();
            else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) keepMask = keepResult;
          }
          let fullBarcodes = null;
          if (typeof hdAnno2?.rowNames === 'function') {
            const rows = hdAnno2.rowNames();
            if (rows && rows.length > 0) fullBarcodes = Array.from(rows);
          }
          if (!fullBarcodes && typeof hdAnno2?.columnNames === 'function' && typeof hdAnno2?.column === 'function') {
            const columnNames = hdAnno2.columnNames();
            const preferred = ['cell_id', 'barcode', 'Barcode', 'cell', 'id', 'CellID'];
            for (const pn of preferred) {
              if (columnNames.includes(pn)) {
                const col = hdAnno2.column(pn);
                if (col && col.length > 0) { fullBarcodes = Array.from(col); break; }
              }
            }
            if (!fullBarcodes && columnNames.length > 0) {
              const col = hdAnno2.column(columnNames[0]);
              if (col && col.length > 0) fullBarcodes = Array.from(col);
            }
          }
          if (keepMask && fullBarcodes && fullBarcodes.length === keepMask.length) {
            const filtered = [];
            for (let i = 0; i < keepMask.length; i++) {
              if (keepMask[i]) filtered.push(String(fullBarcodes[i]));
            }
            if (filtered.length === nCellsHD) hdBarcodes2 = filtered;
          }
        }
        if (hdBarcodes2 && hdBarcodes2.length === nCellsHD) {
          hdCellBarcodesList = hdBarcodes2;
        } else {
          for (let i = 0; i < nCellsHD; i++) hdCellBarcodesList.push(`cell_${i}`);
          console.warn('Visium HD integration: could not derive barcodes, using fallback cell_N');
        }
      }
      loadedData.cellBarcodes = hdCellBarcodesList;

      // Prepare keep mask + raw block for position-based fallback alignment
      let hdKeepMask = null;
      try {
        const kpResult = analysisState.cell_filtering?.fetchKeep?.();
        if (kpResult) {
          if (typeof kpResult.array === 'function') hdKeepMask = kpResult.array();
          else if (typeof kpResult.toArray === 'function') hdKeepMask = kpResult.toArray();
          else if (Array.isArray(kpResult) || kpResult instanceof Uint8Array) hdKeepMask = kpResult;
        }
      } catch (e) { /* ignore */ }
      let hdRawBlockArray = null;
      try {
        const rawBlock = analysisState.inputs?.fetchBlock?.();
        if (rawBlock && rawBlock.length > 0) hdRawBlockArray = Array.from(rawBlock);
      } catch (e) { /* ignore */ }

      // Align per-sample spatial coordinates to filtered cell order
      for (const name of datasetNames) {
        const sampleSpatial = perSampleSpatial[name];
        if (!sampleSpatial || !Array.isArray(sampleSpatial.cellIds)) continue;
        const { cellIds, spatialCoordinates: allCoords } = sampleSpatial;

        // Build cellId → row index lookup (barcode format, numeric, and stripped suffix)
        const cellIdToIdx = new Map();
        for (let k = 0; k < cellIds.length; k++) {
          const id = String(cellIds[k]);
          cellIdToIdx.set(id, k);
          // cellid_ format: also index by numeric part (with and without leading zeros)
          const numMatch = id.match(/cellid_0*(\d+)-\d+/);
          if (numMatch) {
            cellIdToIdx.set(numMatch[1], k);
            const padded = numMatch[1].padStart(9, '0');
            if (padded !== numMatch[1]) cellIdToIdx.set(padded, k);
          }
          // Standard barcodes (e.g. AAACCTGAGAAACCAT-1): also index without -N suffix
          const dashIdx = id.lastIndexOf('-');
          if (dashIdx > 0) {
            const stripped = id.substring(0, dashIdx);
            if (!cellIdToIdx.has(stripped)) cellIdToIdx.set(stripped, k);
          }
        }

        const sampleIndices = hdIntegrationViews[name]?.indices || [];
        if (sampleIndices.length > 0) {
          const firstBarcodes = sampleIndices.slice(0, 5).map(i => String(hdCellBarcodesList[i] || ''));
          const firstCsvIds = cellIds.slice(0, 5).map(id => String(id));
        }

        const alignedCoords = new Array(sampleIndices.length);
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        let matchedCount = 0;

        for (let j = 0; j < sampleIndices.length; j++) {
          const globalIdx = sampleIndices[j];
          const fullBarcode = String(hdCellBarcodesList[globalIdx] || '');
          let csvIdx = cellIdToIdx.get(fullBarcode);
          // Strategy 2: strip -N suffix from barcode
          if (csvIdx === undefined) {
            const dashIdx = fullBarcode.lastIndexOf('-');
            if (dashIdx > 0) csvIdx = cellIdToIdx.get(fullBarcode.substring(0, dashIdx));
          }
          // Strategy 3: cellid_ prefix stripping (numeric part)
          if (csvIdx === undefined) {
            const numMatch = fullBarcode.match(/cellid_0*(\d+)-\d+/);
            if (numMatch) csvIdx = cellIdToIdx.get(numMatch[1]);
          }
          // Strategy 4: bakana may return raw numeric cell_id (e.g. "1", "42"), convert to GeoJSON cellid_ format
          if (csvIdx === undefined && /^\d+$/.test(fullBarcode.trim())) {
            const cellidFormat = numericToBarcodeId(parseInt(fullBarcode, 10));
            csvIdx = cellIdToIdx.get(cellidFormat);
          }
          if (csvIdx !== undefined) {
            const coord = allCoords[csvIdx];
            alignedCoords[j] = coord;
            if (coord[0] < xMin) xMin = coord[0];
            if (coord[0] > xMax) xMax = coord[0];
            if (coord[1] < yMin) yMin = coord[1];
            if (coord[1] > yMax) yMax = coord[1];
            matchedCount++;
          } else {
            alignedCoords[j] = null;
          }
        }


        if (matchedCount < sampleIndices.length * 0.5 && allCoords.length > 0) {
          // Barcode matching failed, use keep mask + raw block for position-based alignment
          let positionMapped = false;
          if (hdKeepMask && hdRawBlockArray) {
            const sampleBlockIdx = datasetNames.indexOf(name);
            if (sampleBlockIdx >= 0) {
              // Find raw start offset for this sample from raw block assignments
              let sampleRawStart = 0;
              for (let r = 0; r < hdRawBlockArray.length; r++) {
                if (hdRawBlockArray[r] === sampleBlockIdx) { sampleRawStart = r; break; }
              }
              // Build filtered→raw index mapping
              const rawToFilteredIdx = [];
              for (let r = 0; r < hdKeepMask.length; r++) {
                if (hdKeepMask[r]) rawToFilteredIdx.push(r);
              }
              xMin = Infinity; xMax = -Infinity; yMin = Infinity; yMax = -Infinity;
              let posMatched = 0;
              for (let j = 0; j < sampleIndices.length; j++) {
                const globalIdx = sampleIndices[j];
                const rawIdx = rawToFilteredIdx[globalIdx];
                if (rawIdx != null && hdRawBlockArray[rawIdx] === sampleBlockIdx) {
                  const inSampleIdx = rawIdx - sampleRawStart;
                  if (inSampleIdx >= 0 && inSampleIdx < allCoords.length) {
                    const coord = allCoords[inSampleIdx];
                    alignedCoords[j] = coord;
                    if (coord[0] < xMin) xMin = coord[0];
                    if (coord[0] > xMax) xMax = coord[0];
                    if (coord[1] < yMin) yMin = coord[1];
                    if (coord[1] > yMax) yMax = coord[1];
                    posMatched++;
                  } else {
                    alignedCoords[j] = null;
                  }
                } else {
                  alignedCoords[j] = null;
                }
              }
              if (posMatched > sampleIndices.length * 0.5) {
                positionMapped = true;
              }
            }
          }
          if (!positionMapped) {
            console.warn(`Visium HD "${name}": position mapping failed, coordinates may be inaccurate`);
            xMin = Infinity; xMax = -Infinity; yMin = Infinity; yMax = -Infinity;
            for (let j = 0; j < sampleIndices.length; j++) {
              const coord = allCoords[Math.min(j, allCoords.length - 1)];
              alignedCoords[j] = coord;
              if (coord[0] < xMin) xMin = coord[0];
              if (coord[0] > xMax) xMax = coord[0];
              if (coord[1] < yMin) yMin = coord[1];
              if (coord[1] > yMax) yMax = coord[1];
            }
          }
        }
        // Fill any remaining null entries
        for (let j = 0; j < alignedCoords.length; j++) {
          if (alignedCoords[j] === null) alignedCoords[j] = [0, 0];
        }

        sampleSpatial.spatialCoordinates = alignedCoords;
        sampleSpatial.spatialExtent = Number.isFinite(xMin) ? { xMin, xMax, yMin, yMax } : null;
      }

      loadedData.perSampleSpatial = perSampleSpatial;
      self.postMessage({
        type: 'DATA_LOADED',
        data: {
          path: loadedData.path,
          cells: nCellsHD,
          genes: nGenesHD,
          rawCells: nCellsHD,
          rawGenes: nGenesHD,
          modality: 'visium-hd-integration',
          datasetNames,
          perSampleSpatial,
        },
      });
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: hdUmapCoords,
          clusters: hdClusterArray,
          nClusters: hdNClusters,
          nCells: nCellsHD,
          source: 'integration',
          integrationViews: hdIntegrationViews,
          datasetNames,
          perSampleSpatial,
        },
      });
      return;
    }

    // ATAC Integration: multi-sample scATAC-seq with Harmony
    if (isAtacIntegration) {
      const atacDatasetList = payload.atacDatasets;
      const datasetNames = atacDatasetList.map((d) => d.name);
      self.postMessage({ type: 'STATUS_UPDATE', message: 'Parsing ATAC matrices...' });

      const atacSamples = [];
      for (let i = 0; i < atacDatasetList.length; i++) {
        const ds = atacDatasetList[i];
        const matrixData = ensureUint8Array(ds.matrixBuffer, `matrix[${i}]`);
        let countMatrix = parseMTXFromBuffer(matrixData);
        let sampleBarcodes = Array.isArray(ds.barcodes) ? ds.barcodes : Array.from({ length: countMatrix.ncols }, (_, j) => `cell_${j}`);
        const { filteredMatrix: filteredSampleMatrix, filteredBarcodes: filteredSampleBarcodes, nRemoved: sampleRemoved } = filterAtacCellsByMinPeaks(countMatrix, sampleBarcodes);
        countMatrix = filteredSampleMatrix;
        sampleBarcodes = filteredSampleBarcodes;
        if (sampleRemoved > 0) {
          self.postMessage({ type: 'STATUS_UPDATE', message: `  ${ds.name}: min peaks > ${MIN_PEAKS_ATAC}, ${sampleRemoved} cells removed, ${countMatrix.ncols} kept` });
        }

        // Parse per-sample peak annotation if provided
        let samplePeakAnnotation = [];
        if (ds.peakAnnotationBuffer && ds.peakAnnotationBuffer.byteLength > 0) {
          try {
            const annoText = new TextDecoder().decode(new Uint8Array(ds.peakAnnotationBuffer));
            const annoLines = annoText.trim().split('\n');
            if (annoLines.length > 1) {
              const headers = annoLines[0].split('\t').map((h) => h.trim());
              const chromIdx = headers.indexOf('chrom');
              const startIdx = headers.indexOf('start');
              const endIdx = headers.indexOf('end') >= 0 ? headers.indexOf('end') : headers.indexOf('stop');
              const geneIdx = findPeakAnnotationGeneColumnIndex(headers);
              for (let k = 1; k < annoLines.length; k++) {
                if (!annoLines[k].trim()) continue;
                const parts = annoLines[k].split('\t');
                samplePeakAnnotation.push({
                  chrom: chromIdx >= 0 ? (parts[chromIdx] || '') : '',
                  start: startIdx >= 0 ? parseInt(parts[startIdx]) || 0 : 0,
                  end: endIdx >= 0 ? parseInt(parts[endIdx]) || 0 : 0,
                  gene: geneIdx >= 0 ? (parts[geneIdx] || '').trim() : '',
                });
              }
            }
          } catch (e) {
            console.warn(`  Sample "${ds.name}": failed to parse peak annotation:`, e.message);
          }
        }

        atacSamples.push({
          countMatrix,
          peakNames: Array.isArray(ds.peakNames) ? ds.peakNames : [],
          barcodes: sampleBarcodes,
          name: ds.name,
          peakAnnotation: samplePeakAnnotation,
        });
      }

      const totalCells = atacSamples.reduce((s, a) => s + a.barcodes.length, 0);
      const firstPeakCount = atacSamples[0].peakNames.length;

      loadedData = {
        path: payload.path,
        info: { ...payload.info, modality: 'atac-integration', format: 'ATAC Integration', datasetNames },
        atacSamples,
        state: null,
        peakAnnotation: [],
        nCells: totalCells,
        nGenes: firstPeakCount,
        rawCells: totalCells,
        rawGenes: firstPeakCount,
        cellBarcodes: null,
        spatialData: null,
        spatialInfo: null,
        datasetBytes: 0,
        precomputed: null,
      };

      await runFullAnalysisPipeline({ labelPrefix: 'atac-integration-initial' });
      return;
    }
    //

    if (info.format === '10X MatrixMarket') {
    } else {
    }

    // Convert to Uint8Array
    let dataset;

    let datasetByteSize = 0;
    let savedH5Blob = null;  // Preserve H5 blob for pure-JS large-dataset pipeline
    let h5LazyTmpFile = null; // Set when a large H5 file is lazy-mounted via HTTP
    let lazyFileCellCount = 0;
    let lazyFileGeneCount = 0;
    let lazyFileBarcodes = null;

    if (info.format === '10X HDF5') {
      const h5File = files.h5;
      if (!h5File) {
        throw new Error('HDF5 file payload missing');
      }

      if (h5File.isLargeFile && h5File.h5Url) {
        // Large file path: mount lazily via HTTP Range requests
        // The analysis worker uses FS.createLazyFile() so h5wasm fetches only the
        // compressed HDF5 chunks it actually needs, the full 4+ GB file is never
        // copied into memory.
        const h5mod = await import('h5wasm');
        await h5mod.ready;
        const lazyDir = '/_large_h5_';
        try { h5mod.FS.mkdir(lazyDir); } catch (_) { /* may already exist */ }
        // Remove any file left from a previous load before re-creating the lazy entry.
        const candidatePath = `${lazyDir}/${h5File.name}`;
        try { h5mod.FS.unlink(candidatePath); } catch (_) { /* didn't exist */ }
        h5mod.FS.createLazyFile(lazyDir, h5File.name, h5File.h5Url, true, false);
        h5LazyTmpFile = candidatePath;

        // Read shape + barcodes, tiny datasets, only a few HTTP chunks needed.
        try {
          const f = new h5mod.File(h5LazyTmpFile, 'r');
          const rootKeys = f.keys();

          // Detect layout: v3 (/matrix/...), v2 root-level, or genome-named group (/mm10/...)
          let shapePath = null;
          let barcodesPath = null;
          if (rootKeys.includes('matrix')) {
            shapePath    = '/matrix/shape';
            barcodesPath = '/matrix/barcodes';
          } else if (rootKeys.includes('data')) {
            shapePath    = '/shape';
            barcodesPath = '/barcodes';
          } else {
            // Genome-named group (e.g. /mm10/)
            for (const key of rootKeys) {
              try {
                const grp = f.get(key);
                if (!grp || typeof grp.keys !== 'function') continue;
                const gk = grp.keys();
                if (gk.includes('data') && gk.includes('shape')) {
                  shapePath    = `/${key}/shape`;
                  barcodesPath = gk.includes('barcodes') ? `/${key}/barcodes` : null;
                  break;
                }
              } catch (_) { /* skip */ }
            }
          }

          if (!shapePath) throw new Error('Could not detect H5 layout');
          const shapeRaw = f.get(shapePath).value;
          lazyFileGeneCount = typeof shapeRaw[0] === 'bigint' ? Number(shapeRaw[0]) : shapeRaw[0];
          lazyFileCellCount = typeof shapeRaw[1] === 'bigint' ? Number(shapeRaw[1]) : shapeRaw[1];
          if (barcodesPath) {
            try {
              const barcDs = f.get(barcodesPath);
              if (barcDs) lazyFileBarcodes = Array.from(barcDs.value, v => String(v));
            } catch (_) { /* barcodes optional */ }
          }
          f.close();
        } catch (shapeErr) {
          console.warn('[large-h5] Could not read shape:', shapeErr.message);
        }

        datasetByteSize = h5File.size || 0;
        savedH5Blob = null;
        dataset = null; // bakana not used, runLargeDatasetJsPipeline handles everything
      } else {
        // Normal (small) file path
        let h5Data = ensureUint8Array(h5File.data, 'HDF5');
        datasetByteSize = h5Data.length;
        const h5Blob = new File([h5Data], h5File.name || 'dataset.h5', { type: 'application/octet-stream' });
        // Free the JS-side copy ASAP, the File blob has its own copy.
        h5Data = null;
        if (h5File) h5File.data = null;
        if (files.h5) files.h5.data = null;
        savedH5Blob = h5Blob;  // Keep for pure-JS pipeline fallback
        dataset = new bakana.TenxHdf5Dataset(h5Blob);
      }
    } else if (info.format === '10X Multiome') {
      const h5File = files.h5;
      if (!h5File) {
        throw new Error('Multiome HDF5 file payload missing');
      }
      let h5Data = ensureUint8Array(h5File.data, 'HDF5');
      datasetByteSize = h5Data.length;
      const h5Blob = new File([h5Data], h5File.name || 'filtered_feature_bc_matrix.h5', { type: 'application/octet-stream' });
      // Free JS-side copy of H5 data to reduce peak memory
      h5Data = null;
      if (h5File) h5File.data = null;
      if (files.h5) files.h5.data = null;
      // Use default featureTypeRnaName ("Gene Expression") so bakana loads RNA as primary modality
      dataset = new bakana.TenxHdf5Dataset(h5Blob);

      // Parse peak annotation if available
      let peakAnnotation = [];
      const peakAnnoFile = files.peakAnnotation;
      if (peakAnnoFile && peakAnnoFile.data) {
        const peakAnnoData = ensureUint8Array(peakAnnoFile.data, 'peakAnnotation');
        const peakAnnoText = new TextDecoder().decode(peakAnnoData);
        const peakAnnoLines = peakAnnoText.trim().split('\n');
        const peakAnnoHeaders = peakAnnoLines[0].split('\t').map((h) => h.trim());
        const chromIdx = peakAnnoHeaders.indexOf('chrom');
        const startIdx = peakAnnoHeaders.indexOf('start');
        const endIdx = peakAnnoHeaders.indexOf('end');
        const geneIdx = findPeakAnnotationGeneColumnIndex(peakAnnoHeaders);
        for (let k = 1; k < peakAnnoLines.length; k++) {
          const parts = peakAnnoLines[k].split('\t');
          const chrom = chromIdx >= 0 ? parts[chromIdx] : '';
          const start = startIdx >= 0 ? parts[startIdx] : '';
          const end = endIdx >= 0 ? (parts[endIdx] || parts[peakAnnoHeaders.indexOf('stop')]) : '';
          const gene = geneIdx >= 0 ? (parts[geneIdx] || '').trim() : '';
          const peakName = `${chrom}_${start}_${end}`;
          peakAnnotation.push({ peakName, chrom, start, end, gene });
        }
      }

      // Parse precomputed analysis (UMAP + clusters) from CSV text
      const precomputedData = payload.precomputed || {};
      const parseUmapCsv = (csvText) => {
        if (!csvText) return { barcodeOrder: [], coords: [] };
        const lines = csvText.trim().split('\n');
        const barcodeOrder = [];
        const coords = [];
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(',');
          if (parts.length >= 3) {
            barcodeOrder.push(parts[0].trim());
            coords.push([parseFloat(parts[1]), parseFloat(parts[2])]);
          }
        }
        return { barcodeOrder, coords };
      };
      const parseClustersCsv = (csvText) => {
        if (!csvText) return { barcodeOrder: [], clusters: [] };
        const lines = csvText.trim().split('\n');
        const barcodeOrder = [];
        const clusters = [];
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(',');
          if (parts.length >= 2) {
            barcodeOrder.push(parts[0].trim());
            clusters.push(parseInt(parts[1], 10));
          }
        }
        return { barcodeOrder, clusters };
      };

      const rnaUmapParsed = parseUmapCsv(precomputedData.rnaUmap);
      const atacUmapParsed = parseUmapCsv(precomputedData.atacUmap);
      const rnaClustersParsed = parseClustersCsv(precomputedData.rnaClusters);
      const atacClustersParsed = parseClustersCsv(precomputedData.atacClusters);


      // Use cell barcodes from info if provided
      const infoCellBarcodes = Array.isArray(info.cellBarcodes) && info.cellBarcodes.length > 0
        ? info.cellBarcodes
        : (rnaUmapParsed.barcodeOrder.length > 0 ? rnaUmapParsed.barcodeOrder : null);

      loadedData = {
        path,
        info: { ...info, modality: 'multiome' },
        dataset,
        h5Blob, // Store H5 blob for loading ATAC peak matrix
        peakAnnotation,
        nCells: 0,
        nGenes: 0,
        rawCells: 0,
        rawGenes: 0,
        cellBarcodes: infoCellBarcodes,
        state: null,
        spatialData: null,
        spatialInfo: null,
        datasetBytes: datasetByteSize,
        previousResults: payloadPreviousResults,
        precomputed: {
          rnaUmap: rnaUmapParsed,
          atacUmap: atacUmapParsed,
          rnaClusters: rnaClustersParsed,
          atacClusters: atacClustersParsed,
        },
      };

      // Get summary for cell/gene counts
      const multiomeSummary = await dataset.summary({ cache: true });
      const multiModFeatures = multiomeSummary?.modality_features || {};
      const rnaModKey = Object.keys(multiModFeatures).find(k => /rna|gene\s*expression/i.test(k)) || Object.keys(multiModFeatures)[0];
      if (rnaModKey) {
        loadedData.nCells = getDataFrameRowCount(multiomeSummary?.cells);
        loadedData.nGenes = getDataFrameRowCount(multiModFeatures[rnaModKey]);
        loadedData.rawCells = loadedData.nCells;
        loadedData.rawGenes = loadedData.nGenes;
      }
      // Count peaks
      const peaksModKey = Object.keys(multiModFeatures).find(k => /peaks?|atac/i.test(k));
      if (peaksModKey) {
        loadedData.nPeaks = getDataFrameRowCount(multiModFeatures[peaksModKey]);
      }

      // Store unfiltered barcodes for peak matrix column mapping.
      // The ATAC peak matrix itself is loaded lazily by getMultiomePeakMatrix() when needed.
      loadedData.allCellBarcodes = infoCellBarcodes ? [...infoCellBarcodes] : null;

      // === FAST PATH (same as Xenium): send precomputed UMAPs immediately, normalize in background ===
      const hasPrecomputed = loadedData.precomputed &&
        (rnaUmapParsed.coords.length > 0 || atacUmapParsed.coords.length > 0);

      if (hasPrecomputed) {
        // Align precomputed UMAPs to ALL barcodes (before QC, QC runs in background)
        const allBarcodes = infoCellBarcodes || [];
        const barcodeToIdx = new Map();
        for (let i = 0; i < allBarcodes.length; i++) {
          barcodeToIdx.set(allBarcodes[i], i);
        }

        const alignPrecomputed = (umapParsed, clustersParsed) => {
          const nCells = allBarcodes.length;
          const alignedCoords = new Array(nCells).fill(null).map(() => [NaN, NaN]);
          const alignedClusters = new Array(nCells).fill(0);
          const clusterMap = new Map();
          for (let i = 0; i < clustersParsed.barcodeOrder.length; i++) {
            clusterMap.set(clustersParsed.barcodeOrder[i], clustersParsed.clusters[i]);
          }
          let matched = 0;
          for (let i = 0; i < umapParsed.barcodeOrder.length; i++) {
            const bc = umapParsed.barcodeOrder[i];
            const idx = barcodeToIdx.get(bc);
            if (idx !== undefined) {
              alignedCoords[idx] = umapParsed.coords[i];
              const cluster = clusterMap.get(bc);
              if (cluster !== undefined) alignedClusters[idx] = cluster;
              matched++;
            }
          }
          return { coordinates: alignedCoords, clusters: alignedClusters, nClusters: new Set(alignedClusters).size };
        };

        const rnaAligned = alignPrecomputed(rnaUmapParsed, rnaClustersParsed);
        const atacAligned = alignPrecomputed(atacUmapParsed, atacClustersParsed);

        // Store for later use
        currentResults.umap = rnaAligned.coordinates;
        currentResults.clusters = rnaAligned.clusters;
        loadedData.precomputed.rnaAligned = rnaAligned;
        loadedData.precomputed.atacAligned = atacAligned;
        loadedData.cellBarcodes = allBarcodes;

        // Send DATA_LOADED immediately (UI shows data right away)
        self.postMessage({
          type: 'DATA_LOADED',
          data: {
            path,
            cells: allBarcodes.length,
            genes: loadedData.nGenes,
            rawCells: loadedData.rawCells || allBarcodes.length,
            rawGenes: loadedData.rawGenes || loadedData.nGenes,
            modality: 'multiome',
            peaks: loadedData.nPeaks,
          },
        });

        // Send RNA UMAP
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: {
            type: 'umap',
            coordinates: rnaAligned.coordinates,
            clusters: rnaAligned.clusters,
            nClusters: rnaAligned.nClusters,
            nCells: rnaAligned.coordinates.length,
            source: 'precomputed',
            multiomeModality: 'rna',
            cellBarcodes: Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === rnaAligned.coordinates.length
              ? loadedData.cellBarcodes
              : undefined,
          },
        });

        // Send ATAC UMAP
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: {
            type: 'umap',
            coordinates: atacAligned.coordinates,
            clusters: atacAligned.clusters,
            nClusters: atacAligned.nClusters,
            nCells: atacAligned.coordinates.length,
            source: 'precomputed',
            multiomeModality: 'atac',
          },
        });


        // Restore WNN 3-panel layout if a previous WNN run was saved
        const prevWnn = loadedData.previousResults;
        if (prevWnn?.wnnActive &&
            prevWnn.wnnRnaCoordinates?.length > 0 && prevWnn.wnnRnaClusters?.length > 0 &&
            prevWnn.wnnAtacCoordinates?.length > 0 && prevWnn.wnnAtacClusters?.length > 0) {
          const wnnRnaNC = prevWnn.wnnRnaNClusters != null ? prevWnn.wnnRnaNClusters : new Set(prevWnn.wnnRnaClusters).size;
          const wnnAtacNC = prevWnn.wnnAtacNClusters != null ? prevWnn.wnnAtacNClusters : new Set(prevWnn.wnnAtacClusters).size;
          const wnnNC = prevWnn.nClusters != null ? prevWnn.nClusters : new Set(prevWnn.clusters).size;
          // Update currentResults so gene expression queries use WNN coordinates, not precomputed
          currentResults.umap = prevWnn.umapCoordinates;
          currentResults.clusters = prevWnn.clusters;
          // WNN individual RNA UMAP
          self.postMessage({ type: 'ANALYSIS_COMPLETE', data: {
            type: 'umap', coordinates: prevWnn.wnnRnaCoordinates, clusters: prevWnn.wnnRnaClusters,
            nClusters: wnnRnaNC, nCells: prevWnn.wnnRnaCoordinates.length,
            source: 'wnn-individual', multiomeModality: 'rna',
          }});
          // WNN individual ATAC UMAP
          self.postMessage({ type: 'ANALYSIS_COMPLETE', data: {
            type: 'umap', coordinates: prevWnn.wnnAtacCoordinates, clusters: prevWnn.wnnAtacClusters,
            nClusters: wnnAtacNC, nCells: prevWnn.wnnAtacCoordinates.length,
            source: 'wnn-individual', multiomeModality: 'atac',
          }});
          // WNN integrated RNA (activates 3-panel layout)
          self.postMessage({ type: 'ANALYSIS_COMPLETE', data: {
            type: 'umap', coordinates: prevWnn.umapCoordinates, clusters: prevWnn.clusters,
            nClusters: wnnNC, nCells: prevWnn.umapCoordinates.length,
            source: 'wnn', multiomeModality: 'rna',
            restoredClusterLabelMap: prevWnn.clusterLabelMap || {},
            restoredClusterColorOverrides: prevWnn.clusterColorOverrides || {},
          }});
          // WNN integrated ATAC
          if (prevWnn.atacUmapCoordinates?.length > 0 && prevWnn.atacClusters?.length > 0) {
            const wnnAtacIntNC = prevWnn.atacNClusters != null ? prevWnn.atacNClusters : new Set(prevWnn.atacClusters).size;
            self.postMessage({ type: 'ANALYSIS_COMPLETE', data: {
              type: 'umap', coordinates: prevWnn.atacUmapCoordinates, clusters: prevWnn.atacClusters,
              nClusters: wnnAtacIntNC, nCells: prevWnn.atacUmapCoordinates.length,
              source: 'wnn', multiomeModality: 'atac',
            }});
          }
        }

        // Run normalization in background (same as Xenium's runNormalizationForPrecomputedData)
        // This enables gene expression queries, fire-and-forget, don't block UI
        // Store the promise so ensureAnalysisReady can await it instead of starting Xenium normalization
        loadedData.normalizationPromise = runMultiomeNormalizationAsync(infoCellBarcodes, rnaUmapParsed, atacUmapParsed, rnaClustersParsed, atacClustersParsed).catch(err => {
          console.error('Multiome background normalization failed:', err);
        });
        return;
      }

      // === FALLBACK: no precomputed data, run full pipeline ===
      self.postMessage({ type: 'STATUS_UPDATE', message: 'Running analysis for multiome data...' });
      await runFullAnalysisPipeline({ labelPrefix: 'multiome-initial' });
      return;
    } else if (info.format === '10X ATAC') {
      const matrixFile = files.matrix;
      if (!matrixFile) {
        throw new Error('ATAC matrix.mtx payload missing (same as scATAC folder)');
      }
      let matrixData;
      if (Array.isArray(matrixFile.chunks) && matrixFile.chunks.length > 0) {
        const totalLen = matrixFile.chunks.reduce((sum, c) => sum + (c.byteLength || c.length || 0), 0);
        matrixData = new Uint8Array(totalLen);
        let offset = 0;
        for (let i = 0; i < matrixFile.chunks.length; i++) {
          const chunk = ensureUint8Array(matrixFile.chunks[i], 'matrix chunk');
          matrixData.set(chunk, offset);
          offset += chunk.length;
        }
      } else if (matrixFile.data) {
        matrixData = ensureUint8Array(matrixFile.data, 'matrix');
      } else {
        throw new Error('ATAC matrix.mtx payload missing (same as scATAC folder)');
      }
      if (matrixData.length === 0) {
        throw new Error('ATAC matrix.mtx is empty');
      }
      datasetByteSize = matrixData.length;

      self.postMessage({ type: 'STATUS_UPDATE', message: 'Parsing matrix.mtx (scATAC)...' });
      let atacCountMatrix = parseMTXFromBuffer(matrixData);
      const nPeaks = atacCountMatrix.nrows;
      const rawCellsAtac = atacCountMatrix.ncols;
      let cellBarcodes = Array.isArray(files.barcodes) && files.barcodes.length > 0
        ? files.barcodes
        : (Array.isArray(info.cellBarcodes) && info.cellBarcodes.length > 0 ? info.cellBarcodes : Array.from({ length: rawCellsAtac }, (_, i) => `cell_${i}`));

      const { filteredMatrix: filteredAtacMatrix, filteredBarcodes: filteredAtacBarcodes, nRemoved: atacCellsRemoved } = filterAtacCellsByMinPeaks(atacCountMatrix, cellBarcodes);
      atacCountMatrix = filteredAtacMatrix;
      cellBarcodes = filteredAtacBarcodes;
      const nCells = atacCountMatrix.ncols;
      if (atacCellsRemoved > 0) {
        self.postMessage({ type: 'STATUS_UPDATE', message: `Filtering cells (min peaks > ${MIN_PEAKS_ATAC}): ${atacCellsRemoved} removed, ${nCells} kept` });
      }
      const atacPeakMatrix = createCSCMatrixAdapter(atacCountMatrix);
      const peakNames = Array.isArray(files.peaks) && files.peaks.length > 0
        ? files.peaks
        : Array.from({ length: nPeaks }, (_, i) => `peak_${i + 1}`);

      let peakAnnotation = [];
      if (files.peakAnnotation && files.peakAnnotation.data) {
        const peakAnnoData = ensureUint8Array(files.peakAnnotation.data, 'peakAnnotation');
        const peakAnnoText = new TextDecoder().decode(peakAnnoData);
        const peakAnnoLines = peakAnnoText.trim().split('\n');
        if (peakAnnoLines.length > 1) {
          const peakAnnoHeaders = peakAnnoLines[0].split('\t').map((h) => h.trim());
          const chromIdx = peakAnnoHeaders.indexOf('chrom');
          const startIdx = peakAnnoHeaders.indexOf('start');
          const endIdx = peakAnnoHeaders.indexOf('end');
          const geneIdx = findPeakAnnotationGeneColumnIndex(peakAnnoHeaders);
          for (let k = 1; k < peakAnnoLines.length; k++) {
            const parts = peakAnnoLines[k].split('\t');
            const chrom = chromIdx >= 0 ? parts[chromIdx] : '';
            const start = startIdx >= 0 ? parts[startIdx] : '';
            const end = endIdx >= 0 ? (parts[endIdx] || parts[peakAnnoHeaders.indexOf('stop')]) : '';
            const gene = geneIdx >= 0 ? (parts[geneIdx] || '').trim() : '';
            const peakName = `${chrom}_${start}_${end}`;
            peakAnnotation.push({ peakName, chrom, start, end, gene });
          }
        }
      }
      if (peakAnnotation.length === 0 && peakNames.length === nPeaks) {
        peakAnnotation = peakNames.map((p) => {
          const m = p.match(/^([^-]+)-(\d+)-(\d+)$/);
          if (m) return { peakName: p, chrom: m[1], start: m[2], end: m[3], gene: '' };
          return { peakName: p, chrom: '', start: '', end: '', gene: '' };
        });
      }

      loadedData = {
        path,
        info: { ...info, modality: 'atac' },
        atacCountMatrix,
        atacPeakMatrix,
        peakAnnotation,
        peakNames,
        nCells,
        nGenes: nPeaks,
        rawCells: rawCellsAtac,
        rawGenes: nPeaks,
        cellBarcodes,
        state: null,
        spatialData: null,
        spatialInfo: null,
        datasetBytes: datasetByteSize,
        precomputed: null,
        previousResults: payloadPreviousResults,
      };

      await runFullAnalysisPipeline({ labelPrefix: 'atac-initial' });
      return;
    } else if (info.format === '10X MatrixMarket' || info.format === '10X Xenium') {
      const matrixData = ensureUint8Array(files.matrix.data, 'matrix');
      const featuresData = ensureUint8Array(files.features.data, 'features');
      const barcodesData = ensureUint8Array(files.barcodes.data, 'barcodes');

      datasetByteSize = matrixData.length + featuresData.length + barcodesData.length;
  
      // Parse barcodes to extract cell IDs for later spatial matching
      try {
        const pako = await import('pako');
        const decompressed = pako.inflate(barcodesData, { to: 'string' });
        const barcodeLines = decompressed.trim().split('\n');
        cellBarcodes = barcodeLines;
      } catch (parseError) {
        console.warn('Failed to pre-parse barcodes:', parseError);
      }


      const matrixBlob = new File([matrixData], files.matrix.name, { type: 'application/gzip' });
      const featuresBlob = new File([featuresData], files.features.name, { type: 'application/gzip' });
      const barcodesBlob = new File([barcodesData], files.barcodes.name, { type: 'application/gzip' });


      dataset = new bakana.TenxMatrixMarketDataset(
        matrixBlob,
        featuresBlob,
        barcodesBlob
      );
    } else if (info.format === 'MERFISH') {
      self.postMessage({ type: 'STATUS_UPDATE', message: 'Parsing MERFISH counts...' });

      // Parse MERFISH counts CSV (cell_by_gene.csv)
      const countsData = ensureUint8Array(files.merfishCounts.data, 'merfishCounts');
      const countsText = new TextDecoder().decode(countsData);
      const countsLines = countsText.trim().split('\n');

      if (countsLines.length < 2) {
        throw new Error('MERFISH counts file has no data rows');
      }

      // Parse header to get gene names, filter out "Blank*" columns
      const headerLine = countsLines[0];
      const rawHeaders = headerLine.split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));

      // First column is cell ID (usually "cell")
      const cellIdColName = rawHeaders[0];

      // Filter out Blank* columns (used as negative controls)
      const geneIndices = [];
      const geneNames = [];
      for (let i = 1; i < rawHeaders.length; i++) {
        const geneName = rawHeaders[i];
        if (!geneName.startsWith('Blank')) {
          geneIndices.push(i);
          geneNames.push(geneName);
        }
      }

      // Parse data rows to build sparse matrix
      const nGenes = geneNames.length;
      const nCells = countsLines.length - 1;
      const cellIds = [];
      const sparseData = []; // [{row, col, val}, ...]

      for (let cellIdx = 0; cellIdx < nCells; cellIdx++) {
        const line = countsLines[cellIdx + 1];
        const values = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));

        // First value is cell ID: normalize it for consistent matching
        const rawCellId = values[0];
        const normalizedCellId = merfishCellIdToString(rawCellId);
        cellIds.push(normalizedCellId || rawCellId);

        // Parse gene counts (only non-Blank genes)
        for (let gIdx = 0; gIdx < geneIndices.length; gIdx++) {
          const origColIdx = geneIndices[gIdx];
          const countValue = parseInt(values[origColIdx], 10);
          if (countValue > 0) {
            // MatrixMarket uses 1-based indices, but bakana internally converts
            // Store as 0-based for consistency with scran.js
            sparseData.push({ row: gIdx, col: cellIdx, val: countValue });
          }
        }

        // Progress update every 10000 cells
        if (cellIdx > 0 && cellIdx % 10000 === 0) {
        }
      }

      cellBarcodes = cellIds;

      // Convert to MatrixMarket format for bakana
      // MatrixMarket format: rows are features/genes, columns are cells
      // Header: %%MatrixMarket matrix coordinate integer general
      // Size line: nRows nCols nEntries
      // Data lines: row col value (1-based indices)
      const mmHeader = '%%MatrixMarket matrix coordinate integer general\n';
      const mmSizeLine = `${nGenes} ${nCells} ${sparseData.length}\n`;

      // Sort by column then row for efficient reading
      sparseData.sort((a, b) => {
        if (a.col !== b.col) return a.col - b.col;
        return a.row - b.row;
      });

      const mmDataLines = sparseData.map(d => `${d.row + 1} ${d.col + 1} ${d.val}`).join('\n');
      const mmContent = mmHeader + mmSizeLine + mmDataLines;

      // Create features.tsv content (gene_id\tgene_name)
      const featuresContent = geneNames.map(g => `${g}\t${g}\tGene Expression`).join('\n');

      // Create barcodes.tsv content
      const barcodesContent = cellIds.join('\n');

      // Convert to Uint8Array and compress with gzip for bakana
      const pako = await import('pako');

      const mmBytes = new TextEncoder().encode(mmContent);
      const featuresBytes = new TextEncoder().encode(featuresContent);
      const barcodesBytes = new TextEncoder().encode(barcodesContent);

      // Compress the data (bakana expects .gz files)
      const mmCompressed = pako.gzip(mmBytes);
      const featuresCompressed = pako.gzip(featuresBytes);
      const barcodesCompressed = pako.gzip(barcodesBytes);

      datasetByteSize = mmCompressed.length + featuresCompressed.length + barcodesCompressed.length;

      // Create File objects for bakana
      const matrixBlob = new File([mmCompressed], 'matrix.mtx.gz', { type: 'application/gzip' });
      const featuresBlob = new File([featuresCompressed], 'features.tsv.gz', { type: 'application/gzip' });
      const barcodesBlob = new File([barcodesCompressed], 'barcodes.tsv.gz', { type: 'application/gzip' });


      dataset = new bakana.TenxMatrixMarketDataset(
        matrixBlob,
        featuresBlob,
        barcodesBlob
      );

      // Parse MERFISH spatial data
      self.postMessage({ type: 'STATUS_UPDATE', message: 'Parsing MERFISH spatial coordinates...' });

      // Parse spatial coordinates from cell_metadata.csv
      const merfishSpatialData = await parseMERFISHSpatialData(files, cellIds);
      spatialData = merfishSpatialData;

    } else if (info.format === 'CosMX') {
      let cellIds;

      if (files.cosmxCounts.preparsedUrls) {
        // Large expression file was stream-parsed; fetch preparsed files from URLs (avoids huge IPC)
        self.postMessage({ type: 'STATUS_UPDATE', message: 'Fetching stream-parsed CosMX counts...' });
        const urls = files.cosmxCounts.preparsedUrls;
        const [matrixRes, featuresRes, barcodesRes, cellIdsRes] = await Promise.all([
          fetch(urls.matrix),
          fetch(urls.features),
          fetch(urls.barcodes),
          fetch(urls.cellIds),
        ]);
        if (!matrixRes.ok || !featuresRes.ok || !barcodesRes.ok || !cellIdsRes.ok) {
          throw new Error('Failed to fetch CosMX preparsed files: ' + [matrixRes.status, featuresRes.status, barcodesRes.status, cellIdsRes.status].join(', '));
        }
        const matrixBlob = await matrixRes.blob();
        const featuresBlob = await featuresRes.blob();
        const barcodesBlob = await barcodesRes.blob();
        const cellIdsJson = await cellIdsRes.json();
        cellIds = Array.isArray(cellIdsJson) ? cellIdsJson : [];

        datasetByteSize = matrixBlob.size + featuresBlob.size + barcodesBlob.size;
        cellBarcodes = cellIds;

        const matrixFile = new File([matrixBlob], 'matrix.mtx.gz', { type: 'application/gzip' });
        const featuresFile = new File([featuresBlob], 'features.tsv.gz', { type: 'application/gzip' });
        const barcodesFile = new File([barcodesBlob], 'barcodes.tsv.gz', { type: 'application/gzip' });

        dataset = new bakana.TenxMatrixMarketDataset(matrixFile, featuresFile, barcodesFile);
      } else {
        // Small expression file: parse CSV in worker
        self.postMessage({ type: 'STATUS_UPDATE', message: 'Parsing CosMX counts...' });

        const countsData = ensureUint8Array(files.cosmxCounts.data, 'cosmxCounts');
        const countsText = new TextDecoder().decode(countsData);
        const countsLines = countsText.trim().split('\n');

        if (countsLines.length < 2) {
          throw new Error('CosMX expression matrix file has no data rows');
        }

        const headerLine = countsLines[0];
        const rawHeaders = headerLine.split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));

        const countsFovIdx = rawHeaders.findIndex(h => /^fov$/i.test(h));
        const countsCellIdIdx = rawHeaders.findIndex(h => /^cell_ID$/i.test(h));

        if (countsFovIdx < 0) {
          throw new Error('Could not find "fov" column in CosMX expression matrix');
        }
        if (countsCellIdIdx < 0) {
          throw new Error('Could not find "cell_ID" column in CosMX expression matrix');
        }

        const idColumnIndices = new Set([countsFovIdx, countsCellIdIdx]);
        const geneIndices = [];
        const geneNames = [];
        for (let i = 0; i < rawHeaders.length; i++) {
          if (idColumnIndices.has(i)) continue;
          const geneName = rawHeaders[i];
          if (!geneName.startsWith('NegPrb')) {
            geneIndices.push(i);
            geneNames.push(geneName);
          }
        }

        const nGenes = geneNames.length;
        const nCells = countsLines.length - 1;
        cellIds = [];
        const sparseData = [];

        for (let cellIdx = 0; cellIdx < nCells; cellIdx++) {
          const line = countsLines[cellIdx + 1];
          const values = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));

          const fov = values[countsFovIdx];
          const cellId = values[countsCellIdIdx];
          cellIds.push(`${fov}_${cellId}`);

          for (let gIdx = 0; gIdx < geneIndices.length; gIdx++) {
            const countValue = parseInt(values[geneIndices[gIdx]], 10);
            if (countValue > 0) {
              sparseData.push({ row: gIdx, col: cellIdx, val: countValue });
            }
          }
          if (cellIdx > 0 && cellIdx % 10000 === 0) {
            self.postMessage({ type: 'STATUS_UPDATE', message: `Parsing CosMX counts... ${cellIdx}/${nCells} cells` });
          }
        }

        cellBarcodes = cellIds;

        sparseData.sort((a, b) => (a.col !== b.col ? a.col - b.col : a.row - b.row));

        const mmHeader = '%%MatrixMarket matrix coordinate integer general\n';
        const mmSizeLine = `${nGenes} ${nCells} ${sparseData.length}\n`;
        const mmDataLines = sparseData.map(d => `${d.row + 1} ${d.col + 1} ${d.val}`).join('\n');
        const mmContent = mmHeader + mmSizeLine + mmDataLines;
        const featuresContent = geneNames.map(g => `${g}\t${g}\tGene Expression`).join('\n');
        const barcodesContent = cellIds.join('\n');

        const pako = await import('pako');
        const mmCompressed = pako.gzip(new TextEncoder().encode(mmContent));
        const featuresCompressed = pako.gzip(new TextEncoder().encode(featuresContent));
        const barcodesCompressed = pako.gzip(new TextEncoder().encode(barcodesContent));

        datasetByteSize = mmCompressed.length + featuresCompressed.length + barcodesCompressed.length;

        const matrixBlob = new File([mmCompressed], 'matrix.mtx.gz', { type: 'application/gzip' });
        const featuresBlob = new File([featuresCompressed], 'features.tsv.gz', { type: 'application/gzip' });
        const barcodesBlob = new File([barcodesCompressed], 'barcodes.tsv.gz', { type: 'application/gzip' });

        dataset = new bakana.TenxMatrixMarketDataset(
          matrixBlob,
          featuresBlob,
          barcodesBlob
        );
      }

      // Parse CosMX spatial data (same for preparsed and in-worker parsed)
      self.postMessage({ type: 'STATUS_UPDATE', message: 'Parsing CosMX spatial coordinates...' });
      spatialData = parseCosMXSpatialData(files.cosmxSpatial?.data, cellIds);

    } else {
      throw new Error('Unsupported format: ' + info.format);
    }


    // For non-MERFISH/CosMX spatial data, parse spatial info here
    // (MERFISH/CosMX spatialData is already set in their handling blocks above)
    if (!spatialData && info?.modality === 'spatial' && spatialInfo) {
      spatialData = await parseSpatialData(spatialInfo);
    }

    let summary = null;
    let nCellsFromSummary = lazyFileCellCount;   // pre-filled for large lazy-loaded files
    let nGenesFromSummary = lazyFileGeneCount;
    if (lazyFileBarcodes) cellBarcodes = lazyFileBarcodes;
    try {
      if (!dataset) throw new Error('skip-summary'); // large file: shape already read above
      summary = await dataset.summary({ cache: true });
      if (summary?.cells) {
        nCellsFromSummary = getDataFrameRowCount(summary.cells);

        // For HDF5 format, extract barcodes from the summary if not already set
        if (!cellBarcodes && info.format === '10X HDF5') {
          try {
            // Try to get barcodes from the cells DataFrame rowNames
            if (typeof summary.cells.rowNames === 'function') {
              const rowNames = summary.cells.rowNames();
              if (Array.isArray(rowNames) && rowNames.length > 0) {
                cellBarcodes = rowNames;
              }
            }
            // Fallback: try column data
            if (!cellBarcodes && typeof summary.cells.column === 'function') {
              const columnCandidates = ['barcode', 'barcodes', 'cell_id', 'cellid', 'CellID', 'Barcode'];
              for (const col of columnCandidates) {
                try {
                  if (typeof summary.cells.hasColumn === 'function' && summary.cells.hasColumn(col)) {
                    const colData = summary.cells.column(col);
                    if (Array.isArray(colData) && colData.length > 0) {
                      cellBarcodes = colData;
                      break;
                    }
                  }
                } catch (colError) {
                  // Continue to next column candidate
                }
              }
            }
          } catch (barcodeError) {
            console.warn('Failed to extract barcodes from HDF5 summary:', barcodeError);
          }
        }
      }
      if (summary?.modality_features) {
        if (summary.modality_features.RNA) {
          nGenesFromSummary = getDataFrameRowCount(summary.modality_features.RNA);
        } else {
          const modalityKeys = Object.keys(summary.modality_features);
          if (modalityKeys.length) {
            nGenesFromSummary = getDataFrameRowCount(summary.modality_features[modalityKeys[0]]);
          }
        }
      }
    } catch (summaryError) {
      if (summaryError.message !== 'skip-summary') {
        console.warn('Failed to summarize dataset for counts:', summaryError);
      }
    } finally {
      if (dataset && typeof dataset.clear === 'function') {
        try {
          dataset.clear();
        } catch (clearError) {
          console.warn('Failed to clear dataset caches after summary:', clearError);
        }
      }
    }

    if (!nCellsFromSummary && Array.isArray(cellBarcodes)) {
      nCellsFromSummary = cellBarcodes.length;
    }

    loadedData = {
      path,
      info,
      dataset,
      h5Blob: savedH5Blob,       // Preserved for pure-JS large-dataset pipeline (small files)
      h5LazyTmpFile,              // Set for large files mounted via HTTP lazy loading
      nCells: nCellsFromSummary,
      nGenes: nGenesFromSummary,
      rawCells: nCellsFromSummary,
      rawGenes: nGenesFromSummary,
      cellBarcodes: Array.isArray(cellBarcodes) ? cellBarcodes : null,
      state: null,
      spatialData,
      spatialInfo: spatialInfo || null,
      datasetBytes: datasetByteSize,
      precomputed: null,
      previousResults: payloadPreviousResults,
    };

    // If user chose "Load previous saved result" (cellpilot_results.json), we must not take the Space
    // Ranger umap.csv/cluster.csv fast path, that would show 10x precomputed UMAP instead of the
    // saved CellPilot analysis (e.g. sketch UMAP for Visium HD).
    const canRestoreFromSaved =
      payloadPreviousResults &&
      Array.isArray(payloadPreviousResults.umapCoordinates) && payloadPreviousResults.umapCoordinates.length > 0 &&
      Array.isArray(payloadPreviousResults.clusters) && payloadPreviousResults.clusters.length > 0;

    const hasPrecomputedSpatialAnalysis =
      !canRestoreFromSaved &&
      info?.modality === 'spatial' &&
      spatialData &&
      spatialData.precomputed?.umap?.map instanceof Map &&
      spatialData.precomputed?.clusters?.map instanceof Map;

    if (hasPrecomputedSpatialAnalysis) {
      await finalizePrecomputedSpatialLoad({
        path,
        info,
        spatialData,
        barcodes: loadedData.cellBarcodes,
        nCells: nCellsFromSummary,
        nGenes: nGenesFromSummary,
      });
      return;
    }

    // Proactive memory estimation for very large HDF5 datasets
    // Estimate whether the dataset will exceed the WASM 4 GiB limit.
    // A compressed H5 file typically decompresses to 5-8× its file size inside WASM
    // (raw data + separate arrays for values/indices/pointers + working buffers).
    const WASM_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
    const WASM_SAFE_THRESHOLD = 3.5 * 1024 * 1024 * 1024; // ~3.5 GiB (leave room for overhead)
    const estimatedWasmBytes = datasetByteSize > 0  
      ? datasetByteSize * 6  // conservative multiplier for decompression + indexing
      : (nCellsFromSummary > 0 && nGenesFromSummary > 0
          ? nCellsFromSummary * nGenesFromSummary * 0.03 * 8 + datasetByteSize // ~3% non-zero × 8 bytes
          : 0);

    if (estimatedWasmBytes > WASM_SAFE_THRESHOLD || nCellsFromSummary > 300000) {
      const sizeMB = (datasetByteSize / (1024 * 1024)).toFixed(0);
      const estGB = (estimatedWasmBytes / (1024 * 1024 * 1024)).toFixed(1);
      console.warn(
        `⚠️ Very large dataset detected: ${nCellsFromSummary.toLocaleString()} cells × ` +
        `${nGenesFromSummary.toLocaleString()} genes, ${sizeMB} MB file, ` +
        `estimated WASM memory: ${estGB} GB (limit: 4 GB).`
      );
      // Don't fail early, the hybrid pipeline in runFullAnalysisPipeline will handle
      // large datasets by running PCA in WASM and UMAP/clustering in JavaScript.
      self.postMessage({
        type: 'STATUS_UPDATE',
        message: `Large dataset (${nCellsFromSummary.toLocaleString()} cells). Using optimized hybrid pipeline...`,
      });
    }

    // Reset the wasmAbortSent flag before attempting the pipeline
    wasmAbortSent = false;

    await runFullAnalysisPipeline({ labelPrefix: 'default' });
    return;

  } catch (error) {
    console.error('Failed to load data:', error);
    console.error('Error stack:', error.stack);
    // Re-check for WASM abort in case the error wasn't caught earlier
    if (isWasmAbort(error)) {
      throw new Error(WASM_OOM_MESSAGE);
    }
    throw error;
  }
}

function resetAnalysisCaches() {
  currentResults = {
    umap: null,
    clusters: null,
    qc: null,
    pca: null,
    regionClusters: null,
  };
  cachedGeneNames = null;
  cachedGeneLookup = null;
  imputedGeneCache.clear();
}

function computeFilteredSummary() {
  if (!analysisState) {
    return { cells: 0, genes: 0 };
  }

  try {
    const filterState = analysisState.cell_filtering;
    if (!filterState) {
      return { cells: loadedData?.nCells ?? 0, genes: loadedData?.nGenes ?? 0 };
    }

    const filtered = filterState.fetchFilteredMatrix();
    const modalities = filtered.available();
    if (!modalities.length) {
      return { cells: 0, genes: 0 };
    }

    const primary = filtered.get(modalities[0]);
    return {
      cells: primary.numberOfColumns(),
      genes: primary.numberOfRows(),
    };
  } catch (error) {
    console.warn('Failed to compute filtered summary:', error);
    return { cells: loadedData?.nCells ?? 0, genes: loadedData?.nGenes ?? 0 };
  }
}

function postFilteredSummary({ summary = null, force = false, reason = '' } = {}) {
  if (!loadedData) {
    return;
  }

  const filtered = summary ?? computeFilteredSummary();
  const filteredCells = Number.isFinite(filtered?.cells) ? filtered.cells : loadedData.nCells;
  const filteredGenes = Number.isFinite(filtered?.genes) ? filtered.genes : loadedData.nGenes;

  const rawCells = Number.isFinite(loadedData.rawCells) ? loadedData.rawCells : filteredCells;
  const rawGenes = Number.isFinite(loadedData.rawGenes) ? loadedData.rawGenes : filteredGenes;

  const changed = filteredCells !== loadedData.nCells || filteredGenes !== loadedData.nGenes;

  loadedData.nCells = filteredCells;
  loadedData.nGenes = filteredGenes;

  if (!force && !changed && !reason) {
    return;
  }

  const payload = {
    path: loadedData.path,
    cells: filteredCells,
    genes: filteredGenes,
    rawCells: rawCells,
    rawGenes: rawGenes,
  };

  if (loadedData?.info?.modality === 'atac') {
    payload.modality = 'atac';
  }
  if (loadedData?.info?.modality === 'atac-integration') {
    payload.modality = 'atac-integration';
    payload.datasetNames = loadedData.info.datasetNames;
  }
  if (loadedData?.info?.modality === 'multiome') {
    payload.modality = 'multiome';
    if (Number.isFinite(loadedData.nPeaks)) {
      payload.peaks = loadedData.nPeaks;
    }
  }
  
  // Include spatial coordinates if available (prefer loadedData.spatialData set by pipeline, e.g. CosMX/MERFISH)
  const spatialSource = loadedData?.spatialData ?? spatialData;
  if (spatialSource && Array.isArray(spatialSource.coordinates)) {
    payload.spatialCoordinates = spatialSource.coordinates;
    payload.modality = 'spatial';
  } else {
    // For single cell data (no spatial coordinates), this is expected; reduce logging noise
    if (spatialSource) {
    }
  }

  if (reason) {
    payload.reason = reason;
  }

  // Only log detailed payload info for spatial data (single cell data is more common, reduce noise)
  if (payload.spatialCoordinates) {
  }

  self.postMessage({
    type: 'DATA_LOADED',
    data: payload,
  });
}

async function rerunAnalysisWithCurrentParameters({
  rerunClusters = true,
  rerunUmapOnly = false,
  reason = '',
} = {}) {
  if (!analysisState || !currentParameters) {
    throw new Error('Analysis has not been initialized');
  }

  resetAnalysisCaches();

  const statusMessage = (step) => {
    const pretty = step.replace(/_/g, ' ');
    return pretty.charAt(0).toUpperCase() + pretty.slice(1);
  };

  const rerunParams = cloneStepParameters(currentParameters);
  // Pass the dataset for proper reanalysis when parameters change
  const datasets = loadedData?.dataset ? { sample: loadedData.dataset } : null;

  // For precomputed spatial data (Xenium, MERFISH, Visium-HD): the existing bakana state
  // only has QC→normalization computed (normalization-only pipeline). Reusing it causes
  // bakana to cache QC/filtering steps and only re-run from feature_selection onwards,
  // so cell filtering parameter changes are silently ignored. Create a fresh state so
  // the full pipeline runs from cell_filtering with the new parameters, same as scRNA-seq
  // force_reanalysis.
  const isPrecomputedSpatial = !!loadedData?.precomputed &&
    (loadedData?.info?.modality === 'spatial' ||
     loadedData?.info?.modality === 'merfish' ||
     loadedData?.info?.modality === 'visium-hd');
  if (isPrecomputedSpatial) {
    if (analysisState && typeof analysisState.free === 'function') {
      try { analysisState.free(); } catch (_) {}
    }
    analysisState = await bakana.createAnalysis();
  }

  // For VisiumHD datasets with enough cells, sketch will override UMAP+clusters, skip
  // bakana's expensive full-dataset UMAP (5-10 min on 300k+ cells) while keeping marker detection.
  const sketchWillRun = isVisiumHDData(loadedData) &&
    (loadedData?.nCells || 0) >= SKETCH_MIN_CELLS;

  // For VisiumHD sketch: ensure at least 50 PCs so rare cell types (podocytes)
  // are captured. With only 20-25 PCs from the full 276K-cell dataset, the
  // podocyte signal (NPHS1/NPHS2/WT1) is diluted into PC 21+ and lost.
  // Seurat's sketch uses the sketch's own PCA which naturally avoids this;
  // we compensate by requesting more PCs from bakana upfront.
  if (sketchWillRun) {
    if (!rerunParams.rna_pca) rerunParams.rna_pca = {};
    if (!Number.isFinite(rerunParams.rna_pca.num_pcs) || rerunParams.rna_pca.num_pcs < 50) {
      rerunParams.rna_pca.num_pcs = 50;
    }
  }

  await runRnaOnlyAnalysis(
    analysisState,
    datasets,
    rerunParams,
    {
      startFun: (step) => {
        self.postMessage({
          type: 'STATUS_UPDATE',
          message: `Re-running ${statusMessage(step)}...`,
        });
      },
      finishFun: async (step) => {
      },
      skipUmap: sketchWillRun,
    }
  );

  // For precomputed spatial: after full reanalysis, re-align spatial coordinates to the
  // new bakana-filtered cell order (different cells may be kept with new QC thresholds).
  if (isPrecomputedSpatial) {
    try {
      // Suppress the precomputed broadcast when sketch will immediately override it:
      // sending source:'precomputed' first causes the App to set a flag that ignores
      // the subsequent sketch ANALYSIS_COMPLETE.
      await realignPrecomputedArtifactsAfterFiltering(analysisState, { suppressBroadcast: sketchWillRun });
    } catch (alignErr) {
      console.warn('[spatial rerun] Failed to realign spatial coordinates:', alignErr.message);
    }
    loadedData.state = analysisState;
  }

  currentParameters = cloneStepParameters(bakana.retrieveParameters(analysisState));

  const summary = computeFilteredSummary();
  if (!Number.isFinite(loadedData.rawCells)) {
    loadedData.rawCells = summary.cells;
  }
  if (!Number.isFinite(loadedData.rawGenes)) {
    loadedData.rawGenes = summary.genes;
  }
  if (loadedData?.info?.modality === 'multiome' && loadedData.precomputed) {
    updateMultiomeFilteredBarcodesFromState(analysisState, summary.cells);
  }

  postFilteredSummary({
    summary,
    force: true,
    reason: reason || 'parameters-updated',
  });

  if (rerunClusters) {
    // For VisiumHD with sufficient cells, use sketch-based pipeline by default
    const rerNcells = loadedData?.nCells || 0;
    if (isVisiumHDData(loadedData) && rerNcells >= SKETCH_MIN_CELLS && analysisState) {
      await runVisiumHDSketchPipeline(analysisState, true);
    } else {
      // Pass 'reclustered' source to reset cluster labels in the UI
      await runClusteringAndUMAP(true, 'reclustered');
    }
  } else if (rerunUmapOnly) {
    await runUMAP();
  }
}

function ensureCurrentParameters() {
  if (!currentParameters) {
    throw new Error('Parameters are not available; load data first.');
  }
}

function notifyParameterUpdate(step, summary) {
  self.postMessage({
    type: 'PARAMETERS_UPDATED',
    data: {
      step,
      summary,
      timestamp: new Date().toISOString(),
    }
  });
}

async function updateCellFiltering(params = {}) {
  ensureCurrentParameters();

  const {
    detected_threshold,
    sum_threshold,
    mito_threshold,
  } = params;

  if (
    detected_threshold == null &&
    sum_threshold == null &&
    mito_threshold == null
  ) {
    throw new Error('No filtering thresholds supplied.');
  }

  const qcParams = currentParameters.rna_quality_control || {};
  qcParams.filter_strategy = 'manual';

  if (detected_threshold != null) {
    qcParams.detected_threshold = detected_threshold;
  }
  if (sum_threshold != null) {
    qcParams.sum_threshold = sum_threshold;
  }
  if (mito_threshold != null) {
    qcParams.mito_threshold = mito_threshold;
  }

  currentParameters.rna_quality_control = qcParams;

  await rerunAnalysisWithCurrentParameters({
    rerunClusters: true,
    reason: 'Cell filtering parameters updated',
  });

  const summaryParts = ['Cell filters updated'];
  if (detected_threshold != null) {
    summaryParts.push(`min genes >= ${detected_threshold}`);
  }
  if (sum_threshold != null) {
    summaryParts.push(`min UMI >= ${sum_threshold}`);
  }
  if (mito_threshold != null) {
    summaryParts.push(`max mito <= ${mito_threshold}`);
  }
  notifyParameterUpdate('cell_filtering', summaryParts.join('; '));
}

async function updateGeneFiltering(params = {}) {
  // Gene-level filtering of the raw matrix is not yet supported without reloading the dataset.
  throw new Error('Gene-level filtering is not currently supported in this version of CellPilot.');
}

async function updateVariableGeneCount(params = {}) {
  ensureCurrentParameters();

  const { num_hvgs } = params;
  if (!Number.isFinite(num_hvgs) || num_hvgs <= 0) {
    throw new Error('Number of variable genes must be a positive number.');
  }

  currentParameters.rna_pca = currentParameters.rna_pca || {};
  currentParameters.rna_pca.num_hvgs = Math.floor(num_hvgs);

  await rerunAnalysisWithCurrentParameters({
    rerunClusters: true,
    reason: `Variable gene count set to ${currentParameters.rna_pca.num_hvgs}`,
  });

  notifyParameterUpdate('rna_pca', `Using ${currentParameters.rna_pca.num_hvgs} variable genes for PCA.`);
}

async function updateClusteringResolution(params = {}) {
  const { resolution, algorithm, multiomeTarget } = params;
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new Error('Resolution must be a positive number.');
  }

  // Precomputed multiome: no analysis/ATAC state yet, run full pipeline with new resolution
  if (loadedData?.info?.modality === 'multiome') {
    if (multiomeTarget === 'atac') {
      atacGeneActivityCache.clear();
      const useLsi = params?.atacMethod !== 'bakana';
      self.postMessage({ type: 'STATUS_UPDATE', message: useLsi
        ? `Reclustering ATAC with resolution ${resolution} (TF-IDF/LSI pipeline)...`
        : `Reclustering ATAC with resolution ${resolution} (bakana peak-as-RNA pipeline)...`
      });
      if (useLsi) {
        const multiomePeak = await getMultiomePeakMatrix();
        await runAtacPipeline({
          skipPostMessage: true,
          multiome: true,
          multiomePeakMatrix: multiomePeak || undefined,
          resolution,
        });
        alignMultiomeAtacResultsToCanonical();
      } else {
        await runAtacPipelineBakana({
          skipPostMessage: true,
          resolution,
          algorithm,
          messageSource: 'reclustered',
        });
      }
      if (loadedData.precomputed) realignMultiomeRnaPrecomputedToCurrentBarcodes();
      const atacAligned = loadedData.precomputed?.atacAligned;
      if (atacAligned) {
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: {
            type: 'umap',
            coordinates: atacAligned.coordinates,
            clusters: atacAligned.clusters,
            nClusters: atacAligned.nClusters,
            nCells: atacAligned.coordinates.length,
            source: 'reclustered',
            multiomeModality: 'atac',
            cellBarcodes: Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === atacAligned.coordinates.length
              ? loadedData.cellBarcodes
              : undefined,
          },
        });
      } else if (!useLsi) {
        await runAtacPipelineBakana({
          skipPostMessage: false,
          resolution,
          algorithm,
          messageSource: 'reclustered',
        });
      }
      const rnaAligned = loadedData.precomputed?.rnaAligned;
      if (rnaAligned?.coordinates && rnaAligned?.clusters) {
        currentResults.umap = rnaAligned.coordinates;
        currentResults.clusters = rnaAligned.clusters;
      }
      notifyParameterUpdate('snn_graph_cluster', `ATAC clustering resolution set to ${resolution} (${useLsi ? 'TF-IDF/LSI' : 'bakana'}).`);
      return;
    }
    // RNA (or unspecified): run full pipeline when no analysis state or state has no UMAP/clustering (e.g. only normalization ran)
    if (multiomeTarget !== 'atac' || multiomeTarget == null) {
      let needFullRnaPipeline = !analysisState;
      if (analysisState) {
        try {
          const umapRes = analysisState.umap ? await analysisState.umap.fetchResults() : null;
          needFullRnaPipeline = !umapRes || !umapRes.x || umapRes.x.length === 0;
        } catch (e) {
          needFullRnaPipeline = true;
        }
      }
      if (needFullRnaPipeline) {
        self.postMessage({ type: 'STATUS_UPDATE', message: `Running full RNA analysis with resolution ${resolution}...` });
        await runFullAnalysisPipeline({
          labelPrefix: 'recluster',
          clusteringResolution: resolution,
          clusteringAlgorithm: algorithm,
        });
        await runClusteringAndUMAP(true, 'reclustered');
        notifyParameterUpdate('snn_graph_cluster', `Clustering resolution set to ${resolution} (full pipeline).`);
        return;
      }
    }
  }

  ensureCurrentParameters();

  // Multiome ATAC: recluster ATAC with new resolution so downstream plot gene activity uses new clusters
  if (loadedData?.info?.modality === 'multiome' && multiomeTarget === 'atac' && loadedData.atacState) {
    atacGeneActivityCache.clear();
    self.postMessage({ type: 'STATUS_UPDATE', message: `Reclustering ATAC with resolution ${resolution}...` });
    const atacState = loadedData.atacState;
    let atacParams;
    try {
      atacParams = bakana.retrieveParameters(atacState);
    } catch (e) {
      console.warn('Could not retrieve ATAC parameters, using defaults for resolution:', e.message);
      atacParams = buildDefaultParameters({ fastMode: false });
    }
    atacParams.choose_clustering = atacParams.choose_clustering || {};
    atacParams.choose_clustering.method = 'snn_graph';
    atacParams.snn_graph_cluster = atacParams.snn_graph_cluster || {};
    const atacAlgo = (algorithm || atacParams.snn_graph_cluster.algorithm || 'multilevel').toLowerCase();
    atacParams.snn_graph_cluster.algorithm = atacAlgo;
    if (atacAlgo === 'leiden') {
      atacParams.snn_graph_cluster.leiden_resolution = resolution;
    } else if (atacAlgo === 'walktrap') {
      atacParams.snn_graph_cluster.walktrap_steps = Math.max(1, Math.round(resolution));
    } else {
      atacParams.snn_graph_cluster.multilevel_resolution = resolution;
    }
    const atacClusteringParams = atacParams.choose_clustering || {};
    const atacMethod = atacClusteringParams.method || 'snn_graph';
    await atacState.snn_graph_cluster.compute(atacMethod === 'snn_graph', atacParams.snn_graph_cluster);
    await atacState.choose_clustering.compute(atacClusteringParams);
    const clusterResults = atacState.choose_clustering.fetchClusters();
    const newClusters = clusterResults ? Array.from(clusterResults) : [];
    currentResults.umap = currentResults.umap || [];
    currentResults.clusters = newClusters;
    const atacColumnBarcodes = getOrderedBarcodesFromFilteredState(atacState) ||
      (loadedData.allCellBarcodes && loadedData.allCellBarcodes.length === newClusters.length ? loadedData.allCellBarcodes : null);
    const canonicalBarcodes = (loadedData.cellBarcodes && loadedData.cellBarcodes.length > 0
      ? loadedData.cellBarcodes
      : (loadedData.allCellBarcodes && loadedData.allCellBarcodes.length > 0 ? loadedData.allCellBarcodes : null));
    const normalizeBc = (bc) => (bc == null ? '' : String(bc).trim().toLowerCase().replace(/-[12]$/, ''));
    const addSuffixVariants = (bc) => {
      const s = String(bc).trim();
      if (!s || s.endsWith('-1') || s.endsWith('-2')) return [s];
      return [s, s + '-1', s + '-2'];
    };
    if (loadedData.precomputed && Array.isArray(canonicalBarcodes) && canonicalBarcodes.length > 0 && atacColumnBarcodes && atacColumnBarcodes.length === newClusters.length) {
      const barcodeToCluster = new Map();
      for (let i = 0; i < atacColumnBarcodes.length; i++) {
        const bc = atacColumnBarcodes[i];
        const keys = [bc, normalizeBc(bc), ...addSuffixVariants(bc)];
        for (const k of keys) {
          if (k) barcodeToCluster.set(k, newClusters[i]);
        }
      }
      const alignedClusters = [];
      for (const bc of canonicalBarcodes) {
        const cluster = barcodeToCluster.get(bc) ?? barcodeToCluster.get(normalizeBc(bc)) ?? barcodeToCluster.get(bc + '-1') ?? barcodeToCluster.get(bc + '-2');
        alignedClusters.push(cluster !== undefined ? cluster : 0);
      }
      const existingCoords = loadedData.precomputed.atacAligned?.coordinates;
      loadedData.precomputed.atacAligned = {
        coordinates: Array.isArray(existingCoords) && existingCoords.length === alignedClusters.length ? existingCoords : (loadedData.precomputed.atacAligned?.coordinates || []),
        clusters: alignedClusters,
        nClusters: new Set(alignedClusters).size,
      };
      if (loadedData.precomputed.atacAligned.barcodeOrder) {
        loadedData.precomputed.atacAligned.barcodeOrder = canonicalBarcodes;
      }
    } else if (loadedData.precomputed?.atacAligned) {
      loadedData.precomputed.atacAligned.clusters = newClusters.length === (loadedData.precomputed.atacAligned.coordinates?.length || 0)
        ? newClusters
        : loadedData.precomputed.atacAligned.clusters;
      loadedData.precomputed.atacAligned.nClusters = new Set(loadedData.precomputed.atacAligned.clusters).size;
    }
    const atacAligned = loadedData.precomputed?.atacAligned;
    if (atacAligned) {
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: atacAligned.coordinates,
          clusters: atacAligned.clusters,
          nClusters: atacAligned.nClusters,
          nCells: atacAligned.coordinates.length,
          source: 'reclustered',
          multiomeModality: 'atac',
        },
      });
    }
    notifyParameterUpdate('snn_graph_cluster', `ATAC clustering resolution updated to ${resolution} (${atacAlgo}).`);
    return;
  }

  // VisiumHD sketch: store resolution in a dedicated key and re-run sketch pipeline
  const nCellsForSketch = loadedData?.nCells || 0;
  if (isVisiumHDData(loadedData) && nCellsForSketch >= SKETCH_MIN_CELLS && analysisState) {
    currentParameters.sketch_resolution = resolution;
    resetAnalysisCaches();
    self.postMessage({ type: 'STATUS_UPDATE', message: `Reclustering VisiumHD sketch with resolution ${resolution}...` });
    await runVisiumHDSketchPipeline(analysisState, true);
    notifyParameterUpdate('snn_graph_cluster', `VisiumHD sketch resolution updated to ${resolution}.`);
    return;
  }

  currentParameters.choose_clustering = currentParameters.choose_clustering || {};
  currentParameters.choose_clustering.method = 'snn_graph';

  currentParameters.snn_graph_cluster = currentParameters.snn_graph_cluster || {};

  const algo = (algorithm || currentParameters.snn_graph_cluster.algorithm || 'multilevel').toLowerCase();
  currentParameters.snn_graph_cluster.algorithm = algo;

  if (algo === 'leiden') {
    currentParameters.snn_graph_cluster.leiden_resolution = resolution;
  } else if (algo === 'walktrap') {
    // walktrap uses steps, not resolution; we could map resolution sensibly but we'll just log.
    currentParameters.snn_graph_cluster.walktrap_steps = Math.max(1, Math.round(resolution));
  } else {
    currentParameters.snn_graph_cluster.multilevel_resolution = resolution;
  }

  // Clear cached results to force fresh fetch after recomputation
  resetAnalysisCaches();

  // Directly recompute clustering steps with new resolution
  // This avoids issues with bakana's caching when only resolution changes
  if (analysisState) {
    self.postMessage({ type: 'STATUS_UPDATE', message: `Reclustering with resolution ${resolution}...` });

    const clusteringParams = currentParameters.choose_clustering || {};
    const method = clusteringParams.method || 'snn_graph';

    // Force recomputation of SNN clustering with new resolution
    await analysisState.snn_graph_cluster.compute(method === 'snn_graph', currentParameters.snn_graph_cluster);
    await analysisState.choose_clustering.compute(clusteringParams);

    // Patch fetchClusters to convert BigInt64 to Int32 for marker detection
    // This fixes the type mismatch with scoreMarkers
    const originalFetchClusters = analysisState.choose_clustering.fetchClusters.bind(analysisState.choose_clustering);
    analysisState.choose_clustering.fetchClusters = function() {
      const clusters = originalFetchClusters();
      if (clusters && clusters.constructor && clusters.constructor.className === 'BigInt64WasmArray') {
        const int32Clusters = scran.createInt32WasmArray(clusters.length);
        const clustersArray = clusters.array();
        const int32Array = int32Clusters.array();
        for (let i = 0; i < clustersArray.length; i++) {
          int32Array[i] = Number(clustersArray[i]);
        }
        return int32Clusters;
      }
      return clusters;
    };

    // Recompute marker detection with new clusters
    await analysisState.marker_detection.compute(currentParameters.marker_detection || {});

    // Restore original fetchClusters
    analysisState.choose_clustering.fetchClusters = originalFetchClusters;

    // Fetch and send new results with 'reclustered' source to reset cluster labels
    await runClusteringAndUMAP(true, 'reclustered');
  } else {
    // Fallback to full rerun if no analysis state
    await rerunAnalysisWithCurrentParameters({
      rerunClusters: true,
      reason: `Clustering resolution set to ${resolution} (${algo})`,
    });
  }

  notifyParameterUpdate('snn_graph_cluster', `Clustering resolution updated to ${resolution} (${algo}).`);
}

async function updatePcaForUmap(params = {}) {
  ensureCurrentParameters();

  const { num_pcs } = params;
  if (!Number.isFinite(num_pcs) || num_pcs <= 0) {
    throw new Error('Number of PCA components must be a positive number.');
  }

  currentParameters.rna_pca = currentParameters.rna_pca || {};
  currentParameters.rna_pca.num_pcs = Math.floor(num_pcs);

  await rerunAnalysisWithCurrentParameters({
    rerunClusters: false,
    rerunUmapOnly: true,
    reason: `PCA components set to ${currentParameters.rna_pca.num_pcs}`,
  });

  notifyParameterUpdate('rna_pca', `Using ${currentParameters.rna_pca.num_pcs} principal components for UMAP.`);
}

async function updateUmapParameters(params = {}) {
  const { min_dist, num_neighbors, multiomeTarget } = params || {};

  // LSI is for ATAC only: if user said "LSI" but selected RNA, do not run and inform.
  if (loadedData?.info?.modality === 'multiome' && multiomeTarget === 'rna' && params?.atacMethod === 'lsi') {
    self.postMessage({
      type: 'ANALYSIS_ERROR',
      error: 'RNA has no LSI method. LSI is for ATAC-seq only. Select ATAC (chromatin accessibility) to use LSI.',
      lsiRnaRefused: true,
    });
    return;
  }

  // Multiome + user chose ATAC: default to the TF-IDF/LSI scATAC pipeline.
  if (loadedData?.info?.modality === 'multiome' && multiomeTarget === 'atac') {
    if (min_dist != null && (!Number.isFinite(min_dist) || min_dist <= 0)) {
      throw new Error('UMAP min_dist must be a positive number.');
    }
    if (num_neighbors != null && (!Number.isFinite(num_neighbors) || num_neighbors <= 0)) {
      throw new Error('UMAP num_neighbors must be a positive number.');
    }

    const useLsi = params?.atacMethod !== 'bakana';
    self.postMessage({ type: 'STATUS_UPDATE', message: useLsi ? 'Updating ATAC UMAP parameters (TF-IDF/LSI pipeline)...' : 'Updating ATAC UMAP parameters (bakana peak-as-RNA pipeline)...' });
    if (useLsi) {
      const multiomePeak = await getMultiomePeakMatrix();
      await runAtacPipeline({
        skipPostMessage: true,
        minDist: min_dist ?? undefined,
        numNeighbors: num_neighbors != null ? num_neighbors : undefined,
        multiome: true,
        multiomePeakMatrix: multiomePeak || undefined,
      });
      alignMultiomeAtacResultsToCanonical();
    } else {
      await runAtacPipelineBakana({
        skipPostMessage: true,
        minDist: min_dist ?? undefined,
        numNeighbors: num_neighbors != null ? num_neighbors : undefined,
      });
    }
    const atacAligned = loadedData.precomputed?.atacAligned;
    if (atacAligned) {
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: atacAligned.coordinates,
          clusters: atacAligned.clusters,
          nClusters: atacAligned.nClusters,
          nCells: atacAligned.coordinates.length,
          source: 'atac',
          multiomeModality: 'atac',
        },
      });
    }
    // Restore currentResults to RNA so RNA view (dot plot, violin, etc.) keeps using RNA clusters
    const rnaAligned = loadedData.precomputed?.rnaAligned;
    if (rnaAligned?.coordinates && rnaAligned?.clusters) {
      currentResults.umap = rnaAligned.coordinates;
      currentResults.clusters = rnaAligned.clusters;
    }
    const parts = [];
    if (min_dist != null) parts.push(`min_dist = ${min_dist}`);
    if (num_neighbors != null) parts.push(`neighbors = ${num_neighbors}`);
    notifyParameterUpdate('umap', `ATAC UMAP updated (${parts.length ? parts.join(', ') : 'default'})`);
    return;
  }

  // Standalone scATAC has no bakana state/currentParameters. Its native path is
  // the TF-IDF/LSI pipeline, so update UMAP by rerunning that pipeline directly.
  if (loadedData?.info?.modality === 'atac') {
    if (min_dist != null && (!Number.isFinite(min_dist) || min_dist <= 0)) {
      throw new Error('UMAP min_dist must be a positive number.');
    }
    if (num_neighbors != null && (!Number.isFinite(num_neighbors) || num_neighbors <= 0)) {
      throw new Error('UMAP num_neighbors must be a positive number.');
    }
    self.postMessage({ type: 'STATUS_UPDATE', message: 'Updating ATAC UMAP (TF-IDF/LSI pipeline)...' });
    await runAtacPipeline({
      skipPostMessage: true,
      minDist: min_dist ?? undefined,
      numNeighbors: num_neighbors != null ? num_neighbors : undefined,
      multiome: false,
    });
    const coords = currentResults.umap || [];
    const clusters = currentResults.clusters || [];
    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'umap',
        coordinates: coords,
        clusters,
        nClusters: new Set(clusters).size,
        nCells: coords.length,
        source: 'atac',
      },
    });
    const parts = [];
    if (min_dist != null) parts.push(`min_dist = ${min_dist}`);
    if (num_neighbors != null) parts.push(`neighbors = ${num_neighbors}`);
    notifyParameterUpdate('umap', `ATAC UMAP updated (TF-IDF/LSI, ${parts.length ? parts.join(', ') : 'default'})`);
    return;
  }

  ensureCurrentParameters();

  if (min_dist != null && (!Number.isFinite(min_dist) || min_dist <= 0)) {
    throw new Error('UMAP min_dist must be a positive number.');
  }
  if (num_neighbors != null && (!Number.isFinite(num_neighbors) || num_neighbors <= 0)) {
    throw new Error('UMAP num_neighbors must be a positive number.');
  }

  currentParameters.umap = currentParameters.umap || {};

  if (min_dist != null) {
    currentParameters.umap.min_dist = min_dist;
  }
  if (num_neighbors != null) {
    currentParameters.umap.num_neighbors = Math.floor(num_neighbors);
    
    // CRITICAL: Synchronize neighbor_index.k with umap.num_neighbors
    // UMAP requires the neighbor index to have the same number of neighbors
    // Note: neighbor_index uses 'k', not 'num_neighbors', and only accepts 'k' when approximate=false
    if (!currentParameters.neighbor_index) {
      currentParameters.neighbor_index = {};
    }
    // Only set 'k' if approximate is false (when approximate=true, neighbor count is inferred automatically)
    if (!currentParameters.neighbor_index.approximate) {
      currentParameters.neighbor_index.k = currentParameters.umap.num_neighbors;
    }
  }

  await rerunAnalysisWithCurrentParameters({
    rerunClusters: false,
    rerunUmapOnly: true,
    reason: 'UMAP parameters updated',
  });

  const parts = [];
  if (min_dist != null) {
    parts.push(`min_dist = ${min_dist}`);
  }
  if (num_neighbors != null) {
    parts.push(`neighbors = ${currentParameters.umap.num_neighbors}`);
  }

  notifyParameterUpdate('umap', `UMAP updated (${parts.join(', ')})`);
}

async function runAnalysis(payload) {
  const { command, dataPath, clusterLabelMap } = payload;


  // Store clusterLabelMap if provided (for UMAP updates that need to preserve merges)
  if (clusterLabelMap !== undefined) {
    currentClusterLabelMap = clusterLabelMap;
  }

  if (!loadedData) {
    throw new Error('No data loaded');
  }

  self.postMessage({ 
    type: 'STATUS_UPDATE', 
    message: 'Running analysis...' 
  });

  try {
    const { action, params } = command;
    if (action === 'list_dataset_items') {
      await listDatasetItems(params);
      return;
    }

    // ATAC-only UMAP update does not need RNA state or normalization (no mito reference fetch).
    const isAtacOnlyUmapUpdate = action === 'update_umap_parameters' &&
      params?.multiomeTarget === 'atac' &&
      loadedData?.info?.modality === 'multiome';
    if (!isAtacOnlyUmapUpdate) {
      await ensureAnalysisReady({ reason: action || 'analysis-request' });
    }

    
    switch (action) {
      case 'cluster_and_visualize':
        await runClusteringAndUMAP(true, null, params?.multiomeTarget, params?.atacMethod);
        break;

      case 'force_reanalysis':
        // User explicitly requested reanalysis: ignore precomputed data
        const multiomeTarget = params?.multiomeTarget;
        const atacMethod = params?.atacMethod;
        if (loadedData?.info?.modality === 'multiome' && multiomeTarget === 'rna' && atacMethod === 'lsi') {
          self.postMessage({
            type: 'ANALYSIS_ERROR',
            error: 'RNA has no LSI method. LSI is for ATAC-seq only. Select ATAC (chromatin accessibility) to use LSI.',
            lsiRnaRefused: true,
          });
          break;
        }
        // Standalone scATAC + user requested LSI: run TF-IDF/LSI pipeline (backup)
        if (loadedData?.info?.modality === 'atac' && atacMethod === 'lsi') {
          self.postMessage({ type: 'STATUS_UPDATE', message: 'Running ATAC reanalysis (TF-IDF/LSI pipeline)...' });
          await runAtacPipeline({ skipPostMessage: true, multiome: false });
          const coords = currentResults.umap || [];
          const clusters = currentResults.clusters || [];
          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              type: 'umap',
              coordinates: coords,
              clusters,
              nClusters: new Set(clusters).size,
              nCells: coords.length,
              source: 'atac',
            },
          });
          postFilteredSummary({
            summary: { cells: loadedData.nCells || 0, genes: loadedData.nGenes || 0 },
            force: true,
            reason: 'force-reanalysis-atac-lsi',
          });
          break;
        }
        // Multiome + user chose ATAC: default to the TF-IDF/LSI scATAC pipeline.
        if (loadedData?.info?.modality === 'multiome' && multiomeTarget === 'atac') {
          const useLsi = atacMethod !== 'bakana';
          self.postMessage({ type: 'STATUS_UPDATE', message: useLsi ? 'Running ATAC-centric analysis (TF-IDF/LSI pipeline)...' : 'Running ATAC-centric analysis (bakana peak-as-RNA pipeline)...' });
          if (useLsi) {
            const multiomePeak = await getMultiomePeakMatrix();
            await runAtacPipeline({ skipPostMessage: true, multiome: true, multiomePeakMatrix: multiomePeak || undefined });
            alignMultiomeAtacResultsToCanonical();
          } else {
            await runAtacPipelineBakana({ skipPostMessage: true });
          }
          if (loadedData.precomputed) realignMultiomeRnaPrecomputedToCurrentBarcodes();
          const rnaAligned = loadedData.precomputed?.rnaAligned;
          const atacAligned = loadedData.precomputed?.atacAligned;
          if (rnaAligned) {
            self.postMessage({
              type: 'ANALYSIS_COMPLETE',
              data: {
                type: 'umap',
                coordinates: rnaAligned.coordinates,
                clusters: rnaAligned.clusters,
                nClusters: rnaAligned.nClusters,
                nCells: rnaAligned.coordinates.length,
                source: 'precomputed',
                multiomeModality: 'rna',
              },
            });
          }
          if (atacAligned) {
            self.postMessage({
              type: 'ANALYSIS_COMPLETE',
              data: {
                type: 'umap',
                coordinates: atacAligned.coordinates,
                clusters: atacAligned.clusters,
                nClusters: atacAligned.nClusters,
                nCells: atacAligned.coordinates.length,
                source: 'atac',
                multiomeModality: 'atac',
                cellBarcodes: Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === atacAligned.coordinates.length
                  ? loadedData.cellBarcodes
                  : undefined,
              },
            });
          }
          postFilteredSummary({
            summary: { cells: loadedData.nCells || 0, genes: loadedData.nGenes || 0 },
            force: true,
            reason: 'force-reanalysis-atac',
          });
          break;
        }
        if (currentParameters && loadedData?.dataset) {
          // Preserve current parameters (including custom filtering) when rerunning

          // Reset caches
          resetAnalysisCaches();

          // Free existing state and create new one
          if (analysisState && typeof analysisState.free === 'function') {
            try {
              analysisState.free();
            } catch (freeError) {
              console.warn('Unable to free previous analysis state:', freeError);
            }
          }
          analysisState = await bakana.createAnalysis();

          // Run with current parameters (preserves user's custom settings)
          await runRnaOnlyAnalysis(
            analysisState,
            { sample: loadedData.dataset },
            cloneStepParameters(currentParameters),
            {
              startFun: async (step) => {
                self.postMessage({
                  type: 'STATUS_UPDATE',
                  message: `Re-running ${step}...`,
                });
              },
              finishFun: async (step) => {
              }
            }
          );

          // Update parameters from the new state
          currentParameters = cloneStepParameters(bakana.retrieveParameters(analysisState));

          // Recompute summary and post
          const summary = computeFilteredSummary();
          if (!Number.isFinite(loadedData.rawCells)) {
            loadedData.rawCells = summary.cells;
          }
          if (!Number.isFinite(loadedData.rawGenes)) {
            loadedData.rawGenes = summary.genes;
          }
          postFilteredSummary({
            summary,
            force: true,
            reason: 'force-reanalysis',
          });

          // Multiome: update cell barcodes to filtered list and realign ATAC so both views show same cells
          if (loadedData?.info?.modality === 'multiome' && loadedData.precomputed) {
            updateMultiomeFilteredBarcodesFromState(analysisState);
          }

          // Re-run clustering and UMAP
          // For VisiumHD with sufficient cells, use sketch-based pipeline by default
          const reanalysisNCells = loadedData?.nCells || 0;
          if (isVisiumHDData(loadedData) && reanalysisNCells >= SKETCH_MIN_CELLS && analysisState) {
            await runVisiumHDSketchPipeline(analysisState, true);
          } else {
            await runClusteringAndUMAP(true, 'reclustered');
          }
        } else {
          // No current parameters or dataset; use defaults
          await runFullAnalysisPipeline({ labelPrefix: 'user-requested', multiomeTarget, atacMethod: params?.atacMethod });
        }
        break;

      case 'run_umap':
        await runUMAP(params?.multiomeTarget, params?.atacMethod);
        break;

      case 'plot_gene_expression':
        await plotGeneExpression(params);
        break;

      case 'plot_gene_violin':
        await plotGeneViolin(params);
        break;

      case 'plot_gene_dotplot':
        await plotGeneDotplot(params);
        break;

      case 'find_markers':
        await findMarkers(params);
        break;

      case 'spatial_region_markers':
        await findMarkers({ ...params, spatialRegionMode: true });
        break;

      case 'spatial_cell_interaction':
        await runSpatialCellInteraction(params);
        break;

      case 'deg_between_samples':
        if (loadedData?.info?.modality === 'atac-integration') {
          await degPeaksBetweenSamples(params);
        } else {
          await degBetweenSamples(params);
        }
        break;

      case 'plot_cell_fraction':
        await plotCellFraction(params);
        break;

      case 'cluster_info':
        await getClusterInfo(params);
        break;

      case 'identify_cell_type_clusters':
        await identifyCellTypeClusters(params);
        break;

      case 'run_qc':
        await runQC();
        break;

      case 'general_analysis':
        await runGeneralAnalysis(params);
        break;

      case 'update_cell_filtering':
        await updateCellFiltering(params);
        break;

      case 'update_gene_filtering':
        await updateGeneFiltering(params);
        break;

      case 'update_variable_genes':
        await updateVariableGeneCount(params);
        break;

      case 'update_clustering_resolution':
        await updateClusteringResolution(params);
        break;

      case 'update_pca_for_umap':
        await updatePcaForUmap(params);
        break;

      case 'update_umap_parameters':
        await updateUmapParameters(params);
        break;

      case 'show_parameters':
        await showAnalysisParameters(params);
        break;

      case 'merge_clusters':
        await mergeClusters(params);
        break;

      case 'wnn_integrate':
        await runWNNIntegration(params);
        break;

      case 'region_segmentation':
        await runBanksyRegionSegmentation(params);
        break;

      case 'region_composition':
        await regionComposition(params);
        break;

      case 'impute_gene':
        await imputeGeneExpression(params, payload.scrnaFiles);
        break;

      case 'link_peaks':
        await runLinkPeaksAction(params);
        break;

      case 'show_peak_gene_links':
        await showPeakGeneLinksAction(params);
        break;

      case 'tf_motif_analysis':
        await runTfMotifAnalysisAction(params);
        break;

      default:
        throw new Error(`Unknown action: ${action}`);
    }

  } catch (error) {
    console.error('Analysis failed:', error);
    console.error('Error stack:', error.stack);
    // Send error message to UI
    self.postMessage({
      type: 'ANALYSIS_ERROR',
      error: error.message || 'Unknown error occurred',
      action: command?.action || 'unknown',
      stack: error.stack,
    });
    throw error;
  }
}

// ============================================================================
// Peak-to-Gene Linkage (scMultiome LinkPeaks)
// ============================================================================

/**
 * Read gene TSS coordinates from the 10x multiome H5 file.
 * Cell Ranger ARC stores gene body intervals in matrix/features/interval
 * as "chr1:1000-2000" strings, we use the start position as the TSS.
 * Returns { GENENAME: { chr, tss } }.
 */
async function buildGeneTSSFromH5() {
  const geneTSS = {};
  const h5mod = await import('h5wasm');
  await h5mod.ready;

  // Resolve H5 input: lazy-mounted path (large files) or in-memory blob (small files)
  let tmpPath = null;
  let wroteFile = false;
  let f = null;

  try {
    if (loadedData.h5LazyTmpFile) {
      // Already mounted in MEMFS by the large-file pipeline
      tmpPath = loadedData.h5LazyTmpFile;
    } else if (loadedData.h5Blob) {
      tmpPath = '/_linkpeaks_tss.h5';
      const bytes = new Uint8Array(await loadedData.h5Blob.arrayBuffer());
      h5mod.FS.writeFile(tmpPath, bytes);
      wroteFile = true;
    } else {
      console.warn('[linkPeaks] No H5 source available for TSS lookup');
      return geneTSS;
    }

    f = new h5mod.File(tmpPath, 'r');

    const namesDS     = f.get('matrix/features/name');
    const typesDS     = f.get('matrix/features/feature_type') || f.get('matrix/features/feature_types');
    const intervalsDS = f.get('matrix/features/interval');

    if (!namesDS || !typesDS || !intervalsDS) {
      console.warn('[linkPeaks] H5 missing matrix/features/name|feature_type(s)|interval, cannot build TSS table');
      return geneTSS;
    }

    const names     = Array.from(namesDS.value,     s => String(s));
    const types     = Array.from(typesDS.value,     s => String(s));
    const intervals = Array.from(intervalsDS.value, s => String(s));

    for (let i = 0; i < names.length; i++) {
      if (types[i] !== 'Gene Expression') continue;
      const iv = intervals[i];          // e.g. "chr1:826206-827522"
      const colon = iv.indexOf(':');
      const dash  = iv.indexOf('-', colon);
      if (colon === -1 || dash === -1) continue;
      const chr   = iv.slice(0, colon);
      const start = parseInt(iv.slice(colon + 1, dash), 10);
      const end   = parseInt(iv.slice(dash + 1), 10);
      if (!isNaN(start) && !isNaN(end)) {
        geneTSS[names[i]] = { chr, tss: start };
      }
    }
  } catch (e) {
    console.warn('[linkPeaks] Could not read gene intervals from H5:', e.message);
  } finally {
    try { f?.close(); } catch (_) {}
    if (wroteFile && tmpPath) {
      try { h5mod.FS.unlink(tmpPath); } catch (_) {}
    }
  }
  return geneTSS;
}

/**
 * Subset columns of a SparseMatrixCSC by an array of column indices.
 * Returns a new object with the same shape interface { nrows, ncols, colPtr, rowIdx, values, nnz }.
 */
function subsetCSCColumns(csc, colIndices) {
  const newNcols = colIndices.length;
  const newColPtr = new Int32Array(newNcols + 1);
  // First pass: count nnz per selected column
  let totalNnz = 0;
  for (let jj = 0; jj < newNcols; jj++) {
    const j = colIndices[jj];
    const count = csc.colPtr[j + 1] - csc.colPtr[j];
    totalNnz += count;
    newColPtr[jj + 1] = totalNnz;
  }
  const newRowIdx = new Int32Array(totalNnz);
  const newValues = new Float64Array(totalNnz);
  let pos = 0;
  for (let jj = 0; jj < newNcols; jj++) {
    const j = colIndices[jj];
    for (let k = csc.colPtr[j]; k < csc.colPtr[j + 1]; k++) {
      newRowIdx[pos] = csc.rowIdx[k];
      newValues[pos] = csc.values[k];
      pos++;
    }
  }
  return new SparseMatrixCSC(csc.nrows, newNcols, newColPtr, newRowIdx, newValues);
}

/**
 * Handle the link_peaks action.
 * Runs the peak-to-gene linkage analysis and stores results in loadedData.peakGeneLinks.
 */
async function runLinkPeaksAction({ gene: geneFilter } = {}) {
  const statusCallback = (msg) => self.postMessage({ type: 'STATUS_UPDATE', message: msg });
  if (loadedData?.info?.modality !== 'multiome') {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: 'LinkPeaks requires multiome (RNA + ATAC) data.' });
    return;
  }

  statusCallback('Loading ATAC peak matrix…');
  const atacResult = await getMultiomePeakMatrix();
  if (!atacResult) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: 'Could not load ATAC peak matrix for LinkPeaks.' });
    return;
  }
  const { peakMatrix: rawPeakMatrix, peakNames } = atacResult;

  statusCallback('Converting ATAC matrix…');
  let peakCSC = scranMatrixToSparseCSC(rawPeakMatrix);

  statusCallback('Getting RNA expression matrix…');
  const normMatrix = loadedData.state?.rna_normalization?.fetchNormalizedMatrix?.();
  if (!normMatrix) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: 'RNA normalized matrix not available. Please wait for preprocessing to finish.' });
    return;
  }
  const rnaCSC   = scranMatrixToSparseCSC(normMatrix);

  // Resolve gene names: try jsGeneNames (large-dataset JS path), then bakana annotations
  let geneNames = loadedData.jsGeneNames || null;
  if (!geneNames || geneNames.length === 0) {
    try {
      const featureAnnotations = loadedData.state.inputs.fetchFeatureAnnotations();
      const annotations = featureAnnotations?.['RNA'] || featureAnnotations?.[Object.keys(featureAnnotations || {})[0]];
      if (annotations) {
        const rows = typeof annotations.rowNames === 'function' ? annotations.rowNames() : null;
        if (rows && rows.length > 0) {
          geneNames = Array.from(rows);
        } else {
          const columnNames = annotations.columnNames();
          const col = ['Symbol', 'symbol', 'gene_name', 'gene', 'Name', 'name'].find(n => columnNames.includes(n));
          geneNames = col ? Array.from(annotations.column(col)) : [];
        }
      }
    } catch (e) {
      console.warn('[linkPeaks] Could not fetch gene annotations from bakana state:', e.message);
    }
  }
  if (!geneNames || geneNames.length === 0) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: 'Could not determine gene names for LinkPeaks. Gene annotations not available.' });
    return;
  }

  // Verify column counts match (cells must be aligned)
  if (peakCSC.ncols !== rnaCSC.ncols) {
    console.warn(`[linkPeaks] Column mismatch: ATAC has ${peakCSC.ncols} cells, RNA has ${rnaCSC.ncols} cells. Attempting cell alignment…`);
    // Use cell_filtering.fetchKeep() to get the keep mask (bakana API)
    let keepIndices = null;
    const keepResult = loadedData.state?.cell_filtering?.fetchKeep?.();
    if (keepResult) {
      let keepMask = null;
      if (typeof keepResult.array === 'function') keepMask = keepResult.array();
      else if (typeof keepResult.toArray === 'function') keepMask = keepResult.toArray();
      else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) keepMask = keepResult;
      if (keepMask) {
        keepIndices = [];
        for (let i = 0; i < keepMask.length; i++) {
          if (keepMask[i]) keepIndices.push(i);
        }
      }
    }
    // Fallback: try rna_quality_control.fetchDiscards()
    if (!keepIndices) {
      const qcDiscard = loadedData.state?.rna_quality_control?.fetchDiscards?.();
      if (qcDiscard) {
        let discardMask = null;
        if (typeof qcDiscard.array === 'function') discardMask = qcDiscard.array();
        else if (typeof qcDiscard.toArray === 'function') discardMask = qcDiscard.toArray();
        else if (Array.isArray(qcDiscard) || qcDiscard instanceof Uint8Array) discardMask = qcDiscard;
        if (discardMask) {
          keepIndices = [];
          for (let i = 0; i < discardMask.length; i++) {
            if (!discardMask[i]) keepIndices.push(i);
          }
        }
      }
    }
    if (keepIndices && keepIndices.length === rnaCSC.ncols) {
      statusCallback('Aligning ATAC and RNA cell matrices…');
      peakCSC = subsetCSCColumns(peakCSC, keepIndices);
    } else if (keepIndices) {
      console.warn(`[linkPeaks] Keep mask gave ${keepIndices.length} cells but RNA has ${rnaCSC.ncols}, truncating ATAC to RNA column count`);
      // Last resort: just take the first N columns (cells are in the same order in 10x multiome)
      const indices = Array.from({ length: rnaCSC.ncols }, (_, i) => i);
      peakCSC = subsetCSCColumns(peakCSC, indices);
    } else {
      console.warn('[linkPeaks] No cell filter mask available, truncating ATAC to RNA column count');
      const indices = Array.from({ length: rnaCSC.ncols }, (_, i) => i);
      peakCSC = subsetCSCColumns(peakCSC, indices);
    }
  }

  statusCallback('Loading gene TSS coordinates from H5…');
  const geneTSS = await buildGeneTSSFromH5();
  if (Object.keys(geneTSS).length === 0) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: 'Could not load gene coordinates from H5 file. Make sure the data was loaded from a 10x multiome H5 file.' });
    return;
  }

  statusCallback('Running peak–gene linkage analysis (this may take a few minutes)…');
  const { linkPeaks: runLP } = await import('../scatac/linkPeaks.js');
  const links = await runLP(peakCSC, peakNames, rnaCSC, geneNames, geneTSS, {
    distance:     500_000,
    minCells:     10,
    scoreCutoff:  0.05,
    pvalueCutoff: 0.05,
    nSample:      200,
    onProgress:   (pct, msg) => statusCallback(msg),
  });

  loadedData.peakGeneLinks = links;

  const byGene = {};
  for (const l of links) {
    if (!byGene[l.gene]) byGene[l.gene] = 0;
    byGene[l.gene]++;
  }
  const topGenes = Object.entries(byGene)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([g, n]) => `${g} (${n})`);

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'link_peaks',
      nLinks: links.length,
      nGenesLinked: Object.keys(byGene).length,
      topGenes,
      links, // full array so frontend can persist it to cellpilot_results.json
      message: `Found ${links.length} significant peak–gene links across ${Object.keys(byGene).length} genes.\nTop linked genes: ${topGenes.slice(0, 5).join(', ')}`,
    },
  });
}

/**
 * Handle show_peak_gene_links, returns links + coverage data for a gene.
 */
async function showPeakGeneLinksAction({ gene } = {}) {
  if (!gene) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: 'Please specify a gene name, e.g. "show links for CD14".' });
    return;
  }
  if (!loadedData.peakGeneLinks) {
    self.postMessage({
      type: 'LINK_PEAKS_REQUIRED',
      message: 'Please perform "link peaks to genes" first.',
      action: 'show_peak_gene_links',
    });
    return;
  }

  const geneLinks = loadedData.peakGeneLinks.filter(
    l => l.gene.toLowerCase() === gene.toLowerCase()
  );

  if (geneLinks.length === 0) {
    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'peak_gene_links',
        gene,
        links: [],
        message: `No significant peak–gene links found for ${gene}. The gene may not be expressed or no peaks are within 500 kb.`,
      },
    });
    return;
  }

  // Compute coverage data for a Signac-style display region around the TSS.
  // The display window is TSS-5kb to TSS+50kb; links beyond this are still drawn
  // (arcs extend from the edge) but coverage tracks only cover this narrower window.
  let coverageByCluster = null;
  let region = null;
  let peaksOnGene = null;
  let cellBarcodes = null;
  let clusters = null;
  let clusterMeanDepths = null;
  try {
    const chr = geneLinks[0].chr;
    const tss = geneLinks[0].tss;
    const regionStart = Math.max(0, tss - 5000);
    const regionEnd = tss + 50000;
    region = { chrom: chr, start: regionStart, end: regionEnd };

    // Build peaksOnGene from the links themselves
    peaksOnGene = geneLinks.map(l => ({
      chrom: l.chr,
      start: l.peakStart,
      end: l.peakEnd,
      peakName: l.peak,
    }));

    // Collect cell barcodes + clusters for fragment-based coverage in the frontend
    clusters = currentResults.clusters || null;
    cellBarcodes = loadedData.cellBarcodes || null;

    // Per-cluster mean depth for Signac-style normalization
    const colSums = loadedData.atacColSums;
    const nCells = cellBarcodes ? cellBarcodes.length : 0;
    if (Array.isArray(colSums) && colSums.length === nCells && Array.isArray(clusters) && clusters.length === nCells) {
      const depthMap = {};
      const countMap = {};
      for (let i = 0; i < nCells; i++) {
        const c = clusters[i];
        if (c == null) continue;
        depthMap[c] = (depthMap[c] || 0) + (colSums[i] || 0);
        countMap[c] = (countMap[c] || 0) + 1;
      }
      clusterMeanDepths = {};
      for (const c of Object.keys(depthMap)) {
        clusterMeanDepths[c] = countMap[c] > 0 ? depthMap[c] / countMap[c] : 0;
      }
    }

    // Compute peak-matrix coverage as initial fallback (overridden by fragment-based in frontend)
    const peakAnnotation = loadedData.peakAnnotation || [];
    if (Array.isArray(clusters) && clusters.length > 0) {
      if (loadedData?.info?.modality === 'multiome') {
        // Multiome: use ATAC peak matrix (not RNA matrix from state)
        const multiomePeak = await getMultiomePeakMatrix();
        if (multiomePeak && multiomePeak.peakMatrix) {
          const { peakMatrix, fullBarcodeOrder, peakNames: atacPeakNames } = multiomePeak;
          const { peakRows } = getPeaksInRegion(peakAnnotation, atacPeakNames, chr, regionStart, regionEnd);
          if (peakRows.length > 0) {
            const filteredBarcodes = loadedData.cellBarcodes || [];
            const barcodeToColIdx = new Map();
            for (let i = 0; i < fullBarcodeOrder.length; i++) {
              barcodeToColIdx.set(fullBarcodeOrder[i], i);
            }
            const clusterToColumnIndices = new Map();
            for (let j = 0; j < filteredBarcodes.length; j++) {
              const colIdx = barcodeToColIdx.get(filteredBarcodes[j]);
              if (colIdx === undefined) continue;
              const cl = clusters[j];
              if (cl == null) continue;
              if (!clusterToColumnIndices.has(cl)) clusterToColumnIndices.set(cl, []);
              clusterToColumnIndices.get(cl).push(colIdx);
            }
            coverageByCluster = computeCoverageByClusterRawFromColumnMap(peakMatrix, clusterToColumnIndices, peakRows);
          }
        }
      } else {
        // scATAC: use state count matrix
        const state = loadedData.state;
        if (state) {
          const { geneNames: peakNames } = await ensureGeneLookup();
          const { peakRows } = getPeaksInRegion(peakAnnotation, peakNames, chr, regionStart, regionEnd);
          if (peakRows.length > 0) {
            const countMatrixContainer = state.inputs.fetchCountMatrix();
            const countModality = countMatrixContainer.available()[0];
            const normMatrix = countMatrixContainer.get(countModality);
            coverageByCluster = computeCoverageByCluster(normMatrix, clusters, peakRows);
          }
        }
      }
    }
  } catch (e) {
    console.warn('[showPeakGeneLinksAction] Could not compute coverage:', e.message);
  }

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'peak_gene_links',
      gene,
      links: geneLinks,
      coverageByCluster,
      region,
      peaksOnGene,
      genome: loadedData.info?.genome || null,
      cellBarcodes: cellBarcodes || undefined,
      clusters: clusters || undefined,
      clusterMeanDepths: clusterMeanDepths || undefined,
      message: `Found ${geneLinks.length} peak–gene link${geneLinks.length !== 1 ? 's' : ''} for ${gene}.`,
    },
  });
}

// ============================================================================
// TF Motif Enrichment Analysis
// ============================================================================

let jasparPwmCache = null;

function ucscGenomeName(genome) {
  if (!genome) return null;
  const g = genome.toLowerCase();
  if (g === 'hg38' || g === 'grch38' || g.startsWith('grch38.')) return 'hg38';
  if (g === 'hg19' || g === 'grch37' || g.startsWith('grch37.')) return 'hg19';
  if (g === 'mm10' || g === 'grcm38' || g.startsWith('grcm38.')) return 'mm10';
  if (g === 'mm39' || g === 'grcm39' || g.startsWith('grcm39.')) return 'mm39';
  return genome;
}

async function fetchJasparPwms() {
  if (jasparPwmCache !== null) return jasparPwmCache;

  const pseudo = 0.1;

  function parsePfmEntries(entries) {
    const pwms = [];
    for (const entry of entries) {
      const pfm = entry.pfm;
      if (!pfm || !pfm.A) continue;
      const L = pfm.A.length;
      let totalIC = 0;
      const pssm = [];
      for (let j = 0; j < L; j++) {
        const tot = pfm.A[j] + pfm.C[j] + pfm.G[j] + pfm.T[j];
        const pos = [pfm.A[j], pfm.C[j], pfm.G[j], pfm.T[j]].map(
          c => Math.log2((c + pseudo) / (tot + 4 * pseudo) / 0.25)
        );
        pssm.push(pos);
        totalIC += Math.max(...pos);
      }
      const maxScore = pssm.reduce((s, pos) => s + Math.max(...pos), 0);
      pwms.push({ id: entry.matrix_id, name: entry.name, pssm, threshold: maxScore * 0.60, ic: totalIC / L });
    }
    return pwms.filter(p => p.ic >= 0.5);
  }

  try {
    const resp = await fetch('https://jaspar.genereg.net/api/v1/matrix/?collection=CORE&tax_group=vertebrates&format=json&page_size=1000');
    if (resp.ok) {
      const data = await resp.json();
      const pwms = parsePfmEntries(data.results || []);
      if (pwms.length > 0) {
        jasparPwmCache = pwms;
        return jasparPwmCache;
      }
    }
  } catch (e) {
    console.warn('[TF Motif] REST API failed:', e.message);
  }

  // Fallback: bulk flat-file
  const bulkResp = await fetch('https://jaspar.genereg.net/download/data/2024/CORE/JASPAR2024_CORE_vertebrates_non-redundant_pfms_jaspar.txt');
  if (!bulkResp.ok) throw new Error(`JASPAR bulk file returned ${bulkResp.status}`);
  const text = await bulkResp.text();
  const entries = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('>')) {
      if (cur) entries.push(cur);
      const parts = line.slice(1).trim().split(/\s+/);
      cur = { matrix_id: parts[0], name: parts[1] || parts[0], pfm: { A: null, C: null, G: null, T: null } };
    } else if (cur) {
      const m = line.match(/^([ACGT])\s*\[?\s*([\d\s.]+)\s*\]?$/);
      if (m) cur.pfm[m[1]] = m[2].trim().split(/\s+/).map(Number);
    }
  }
  if (cur) entries.push(cur);
  jasparPwmCache = parsePfmEntries(entries);
  return jasparPwmCache;
}

function peakHitsMotif(seq, pssm, threshold) {
  const nucIdx = { A: 0, C: 1, G: 2, T: 3 };
  const comp   = { A: 3, C: 2, G: 1, T: 0 };
  const L = pssm.length;
  const N = seq.length - L + 1;
  if (N <= 0) return false;
  for (let i = 0; i < N; i++) {
    let fwd = 0, rev = 0;
    let fwdOk = true, revOk = true;
    for (let j = 0; j < L; j++) {
      const fi = nucIdx[seq[i + j]];
      if (fi === undefined) { fwdOk = false; break; }
      fwd += pssm[j][fi];
      if (fwd + (L - j - 1) * 2 < threshold) { fwdOk = false; break; }
    }
    if (fwdOk && fwd >= threshold) return true;
    for (let j = 0; j < L; j++) {
      const ri = comp[seq[i + L - 1 - j]];
      if (ri === undefined) { revOk = false; break; }
      rev += pssm[j][ri];
      if (rev + (L - j - 1) * 2 < threshold) { revOk = false; break; }
    }
    if (revOk && rev >= threshold) return true;
  }
  return false;
}

function _lgamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - _lgamma(1 - z);
  z -= 1;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = c[0];
  for (let i = 1; i <= 8; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function _logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  if (k === 0 || k === n) return 0;
  return _lgamma(n + 1) - _lgamma(k + 1) - _lgamma(n - k + 1);
}
function hypergeomPvalue(k, n, K, N) {
  const kMax = Math.min(n, K);
  if (k > kMax) return 1e-300;
  if (k <= 0) return 1.0;
  const logDenom = _logChoose(N, n);
  let p = 0;
  for (let x = k; x <= kMax; x++) {
    p += Math.exp(_logChoose(K, x) + _logChoose(N - K, n - x) - logDenom);
  }
  return Math.min(p, 1.0);
}
function bhCorrect(pvalues) {
  const n = pvalues.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => pvalues[a] - pvalues[b]);
  const adj = new Array(n).fill(1);
  let running = 1;
  for (let r = n - 1; r >= 0; r--) {
    const i = idx[r];
    running = Math.min(running, pvalues[i] * n / (r + 1));
    adj[i] = running;
  }
  return adj;
}

async function computeTopLinkedMarkers(cluster, topN = 30) {
  const links = loadedData.peakGeneLinks || [];
  const linkedGeneSet = new Set(links.map(l => l.gene.toLowerCase()));
  if (linkedGeneSet.size === 0) throw new Error('No peak-gene links available. Run LinkPeaks first.');

  let clusterAssignments = currentResults.clusters;
  if (loadedData.info?.modality === 'multiome' && loadedData.precomputed?.rnaAligned?.clusters) {
    clusterAssignments = loadedData.precomputed.rnaAligned.clusters;
  }
  if (!clusterAssignments?.length) throw new Error('No cluster assignments available.');

  // cluster may be a single ID or a Set of IDs (for merged/renamed clusters)
  const clusterSet = cluster instanceof Set ? cluster : new Set([String(cluster)]);
  const inIdx = [], outIdx = [];
  for (let i = 0; i < clusterAssignments.length; i++) {
    if (clusterSet.has(String(clusterAssignments[i]))) inIdx.push(i); else outIdx.push(i);
  }
  if (inIdx.length === 0) throw new Error(`Cluster ${[...clusterSet].join('/')} not found.`);

  const { lookup } = await ensureGeneLookup();
  const state = loadedData.state;
  if (!state) throw new Error('No normalized RNA matrix available.');
  const normMatrix = state.rna_normalization.fetchNormalizedMatrix();

  const results = [];
  const pseudo = 1e-3;
  for (const geneLower of linkedGeneSet) {
    const gIdx = lookup.get(geneLower) ?? lookup.get(normalizeGeneName(geneLower));
    if (gIdx === undefined) continue;
    const row = normMatrix.row(gIdx, { asTypedArray: true });
    let sumIn = 0, sumOut = 0;
    for (const i of inIdx) sumIn += row[i] || 0;
    for (const i of outIdx) sumOut += row[i] || 0;
    const meanIn  = sumIn / inIdx.length;
    const meanOut = sumOut / (outIdx.length || 1);
    results.push({ gene: geneLower, fc: Math.log2((meanIn + pseudo) / (meanOut + pseudo)), meanIn, meanOut });
  }
  results.sort((a, b) => b.fc - a.fc);
  return results.slice(0, topN);
}

async function runTfMotifAnalysisAction({ cluster, clusters: mergedClusters, nMarkers = 100, nBackground = 150 } = {}) {
  const statusMsg = m => self.postMessage({ type: 'STATUS_UPDATE', message: m });
  if (cluster === undefined || cluster === null) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: 'Please specify a cluster, e.g. "show top TF for cluster 3".' });
    return;
  }
  // Build a Set of cluster IDs to treat as a single group (handles merged/renamed clusters)
  const clusterSet = Array.isArray(mergedClusters) && mergedClusters.length > 1
    ? new Set(mergedClusters.map(String))
    : new Set([String(cluster)]);
  if (!loadedData?.peakGeneLinks?.length) {
    self.postMessage({
      type: 'LINK_PEAKS_REQUIRED',
      message: 'Please perform "link peaks to genes" first.',
      action: 'tf_motif_analysis',
    });
    return;
  }
  const genome = ucscGenomeName(loadedData.info?.genome);
  if (!genome) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: 'Genome not specified for this dataset, cannot fetch sequences.' });
    return;
  }

  const clusterLabel = clusterSet.size > 1 ? [...clusterSet].join('/') : String(cluster);
  statusMsg(`Finding marker genes for cluster ${clusterLabel}...`);
  let topMarkers;
  try {
    topMarkers = await computeTopLinkedMarkers(clusterSet, nMarkers);
  } catch (e) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: e.message });
    return;
  }
  if (topMarkers.length === 0) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: `No linked genes found expressed in cluster ${clusterLabel}.` });
    return;
  }
  const markerGeneNames = new Set(topMarkers.map(m => m.gene.toLowerCase()));

  // Collect query peaks from linked peaks of marker genes
  const seen = new Set();
  const queryPeaks = [];
  for (const link of loadedData.peakGeneLinks) {
    if (!markerGeneNames.has(link.gene.toLowerCase())) continue;
    const key = `${link.chr}:${link.peakStart}-${link.peakEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queryPeaks.push({ chrom: link.chr, start: link.peakStart, end: link.peakEnd });
  }
  if (queryPeaks.length === 0) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: `No linked peaks found for marker genes of cluster ${cluster}.` });
    return;
  }
  const cappedQuery = queryPeaks.slice(0, 300);

  // Sample background peaks from peaks linked to NON-marker genes.
  // This gives peaks accessible in other cell types, making cluster-specific TF motifs
  // (e.g. PAX5 in B cells, HNF4A in PT) detectable via fold enrichment.
  const queryKeySet = new Set(cappedQuery.map(p => `${p.chrom}:${p.start}-${p.end}`));
  const bgCandMap = new Map();
  for (const link of loadedData.peakGeneLinks) {
    if (markerGeneNames.has(link.gene.toLowerCase())) continue;
    const key = `${link.chr}:${link.peakStart}-${link.peakEnd}`;
    if (queryKeySet.has(key) || bgCandMap.has(key)) continue;
    bgCandMap.set(key, { chrom: link.chr, start: link.peakStart, end: link.peakEnd });
  }
  let bgPool = [...bgCandMap.values()];
  // Fallback: if not enough non-marker linked peaks, supplement with random peaks from all peaks
  if (bgPool.length < nBackground) {
    const peakAnnotation = loadedData.peakAnnotation || [];
    for (const p of peakAnnotation) {
      if (bgPool.length >= nBackground * 3) break;
      const key = `${p.chrom}:${p.start}-${p.end}`;
      if (queryKeySet.has(key) || bgCandMap.has(key)) continue;
      if (!p.chrom || p.start == null || p.end == null) continue;
      bgPool.push({ chrom: p.chrom, start: Number(p.start), end: Number(p.end) });
    }
  }
  const bgPeaks = [];
  for (let i = 0; i < bgPool.length && bgPeaks.length < nBackground; i++) {
    const j = Math.floor(Math.random() * (bgPool.length - i)) + i;
    [bgPool[i], bgPool[j]] = [bgPool[j], bgPool[i]];
    bgPeaks.push(bgPool[i]);
  }

  // Fetch sequences from UCSC
  statusMsg(`Fetching sequences for ${cappedQuery.length + bgPeaks.length} peaks from UCSC...`);
  const allPeaks = [...cappedQuery, ...bgPeaks];
  const seqs = new Array(allPeaks.length).fill('');
  for (let start = 0; start < allPeaks.length; start += 20) {
    const batch = allPeaks.slice(start, start + 20);
    const batchSeqs = await Promise.all(batch.map(async p => {
      try {
        const url = `https://api.genome.ucsc.edu/getData/sequence?genome=${genome}&chrom=${p.chrom}&start=${p.start}&end=${p.end}`;
        const r = await fetch(url);
        if (!r.ok) return '';
        return ((await r.json()).dna || '').toUpperCase();
      } catch { return ''; }
    }));
    for (let k = 0; k < batchSeqs.length; k++) seqs[start + k] = batchSeqs[k];
    await new Promise(r => setTimeout(r, 0));
  }

  // Load JASPAR PWMs
  statusMsg('Loading JASPAR motif database (first run downloads ~400 KB)...');
  let pwms;
  try {
    pwms = await fetchJasparPwms();
  } catch (e) {
    self.postMessage({ type: 'ANALYSIS_ERROR', error: `Failed to fetch JASPAR database: ${e.message}. Check your internet connection.` });
    return;
  }

  // Scan motifs
  statusMsg(`Scanning ${pwms.length} motifs across ${allPeaks.length} peaks...`);
  const nQ = cappedQuery.length;
  const nBg = bgPeaks.length;
  const motifResults = [];
  for (let mi = 0; mi < pwms.length; mi++) {
    if (mi > 0 && mi % 100 === 0) {
      await new Promise(r => setTimeout(r, 0));
      statusMsg(`Scanning motifs... ${mi}/${pwms.length}`);
    }
    const { pssm, threshold } = pwms[mi];
    let qHits = 0, bHits = 0;
    for (let i = 0; i < nQ; i++)  if (seqs[i]      && peakHitsMotif(seqs[i],      pssm, threshold)) qHits++;
    for (let i = 0; i < nBg; i++) if (seqs[nQ + i] && peakHitsMotif(seqs[nQ + i], pssm, threshold)) bHits++;
    motifResults.push({ id: pwms[mi].id, name: pwms[mi].name, qHits, bHits });
  }

  // Hypergeometric test + BH correction
  const rawP = motifResults.map(m => hypergeomPvalue(m.qHits, nQ, m.bHits, nBg));
  const adjP = bhCorrect(rawP);
  const enriched = motifResults.map((m, i) => ({
    motifId: m.id, tfName: m.name,
    queryHits: m.qHits, bgHits: m.bHits, nQuery: nQ, nBackground: nBg,
    pctQuery: nQ > 0 ? m.qHits / nQ : 0,
    pctBackground: nBg > 0 ? m.bHits / nBg : 0,
    foldEnrichment: nBg > 0 && m.bHits > 0 ? (m.qHits / nQ) / (m.bHits / nBg) : (m.qHits > 0 ? 99 : 0),
    pvalue: rawP[i], pvalueAdj: adjP[i],
    negLogP: rawP[i] > 0 ? -Math.log10(rawP[i]) : 300,
  }));

  // RENIN step 2: correlate TF expression with target gene expression (cluster cells)
  // RENIN paper: "correlate expression of predicted binding TFs to expression of target genes"
  // Score = mean_expr_in_cluster(TF) × Σ_genes max(0, pearsonCorr(TF_expr, gene_expr))
  // Mirrors rank_tfs: Score_TF = mean_expr(TF) × Σ coef_if_kept(TF→gene)
  // where Pearson correlation is our tractable proxy for the AEN regression coefficient
  try {
    const { lookup } = await ensureGeneLookup();
    const state = loadedData.state;
    let clusterAssignments = currentResults.clusters;
    if (loadedData.info?.modality === 'multiome' && loadedData.precomputed?.rnaAligned?.clusters) {
      clusterAssignments = loadedData.precomputed.rnaAligned.clusters;
    }
    const inIdx = [], outIdx = [];
    for (let i = 0; i < clusterAssignments?.length; i++) {
      if (clusterSet.has(String(clusterAssignments[i]))) inIdx.push(i);
      else if (clusterAssignments[i] != null) outIdx.push(i);
    }
    if (state && inIdx.length > 0 && typeof state.rna_normalization?.fetchNormalizedMatrix === 'function') {
      const normMatrix = state.rna_normalization.fetchNormalizedMatrix();
      const nC = inIdx.length;

      // Pearson correlation over cluster cells
      function pearsonCorr(a, b) {
        let sumA = 0, sumB = 0;
        for (let i = 0; i < nC; i++) { sumA += a[i]; sumB += b[i]; }
        const mA = sumA / nC, mB = sumB / nC;
        let num = 0, varA = 0, varB = 0;
        for (let i = 0; i < nC; i++) {
          const da = a[i] - mA, db = b[i] - mB;
          num += da * db; varA += da * da; varB += db * db;
        }
        const denom = Math.sqrt(varA * varB);
        return denom < 1e-10 ? 0 : num / denom;
      }

      // Pre-fetch marker gene expression vectors (cluster cells only)
      statusMsg('Computing RENIN TF–gene expression correlations...');
      const markerVecs = [];
      for (const m of topMarkers) {
        const gIdx = lookup.get(m.gene.toLowerCase()) ?? lookup.get(normalizeGeneName(m.gene));
        if (gIdx === undefined) continue;
        const fullRow = normMatrix.row(gIdx, { asTypedArray: true });
        const vec = new Float32Array(nC);
        for (let i = 0; i < nC; i++) vec[i] = fullRow[inIdx[i]] || 0;
        markerVecs.push(vec);
      }

      // Only score the candidates that passed hypergeometric filter, avoids 700× normMatrix.row() calls
      const candidates = enriched.filter(e => e.queryHits > 0 && e.pvalue < 0.05);
      for (const e of candidates) {
        // Handle composite JASPAR names: "SP1::CTCF" → try SP1 first, then CTCF
        const parts = e.tfName.split('::').map(p => p.split('(')[0].trim());
        let gIdx;
        for (const part of parts) {
          gIdx = lookup.get(part.toLowerCase()) ?? lookup.get(normalizeGeneName(part));
          if (gIdx !== undefined) break;
        }
        if (gIdx !== undefined) {
          const fullRow = normMatrix.row(gIdx, { asTypedArray: true });
          const tfVec = new Float32Array(nC);
          let sumIn = 0, sumOut = 0;
          for (let i = 0; i < nC; i++) { tfVec[i] = fullRow[inIdx[i]] || 0; sumIn += tfVec[i]; }
          for (let i = 0; i < outIdx.length; i++) sumOut += fullRow[outIdx[i]] || 0;
          e.meanExprInCluster = sumIn / nC;
          const meanExprOut = sumOut / (outIdx.length || 1);
          const log2FC = Math.log2((e.meanExprInCluster + 1e-3) / (meanExprOut + 1e-3));

          // Σ max(0, corr(TF, gene)) across marker genes, RENIN step 2
          let corrSum = 0;
          for (const mv of markerVecs) corrSum += Math.max(0, pearsonCorr(tfVec, mv));
          e.corrSum = corrSum;
          e.reninScore = Math.max(0, log2FC) * e.meanExprInCluster * corrSum;  // balances specificity × level × correlation
        } else {
          e.meanExprInCluster = 0;
          e.corrSum = 0;
          e.reninScore = 0;
        }
      }
    }
  } catch (_) { /* RENIN scoring optional, fall back to fold enrichment ranking */ }

  // Deduplicate by TF name, JASPAR has multiple matrices per TF; keep the best-scoring one
  const byTfName = new Map();
  for (const e of enriched.filter(e => e.queryHits > 0 && e.pvalue < 0.05)) {
    const key = e.tfName.toLowerCase();
    const score = e.reninScore ?? e.foldEnrichment;
    const existing = byTfName.get(key);
    if (!existing || score > (existing.reninScore ?? existing.foldEnrichment)) {
      byTfName.set(key, e);
    }
  }
  const topTFs = [...byTfName.values()]
    .sort((a, b) => (b.reninScore ?? b.foldEnrichment) - (a.reninScore ?? a.foldEnrichment))
    .slice(0, 30);
  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'tf_motif_enrichment',
      cluster: clusterLabel,
      topMarkers: topMarkers.slice(0, 10).map(m => m.gene),
      nQueryPeaks: nQ, nBgPeaks: nBg,
      results: topTFs, genome,
      message: topTFs.length > 0
        ? `Found ${topTFs.length} enriched TF motifs for cluster ${clusterLabel} (${nQ} linked peaks, ${nBg} background peaks).`
        : `No significantly enriched TF motifs found for cluster ${clusterLabel}. Try running with more marker genes.`,
    },
  });
}

// ============================================================================
// SpaGE Gene Imputation
// ============================================================================

/**
 * Read a 10x h5 scRNA-seq file using h5wasm and return log-normalized expression
 * for a specific set of genes.
 *
 * @param {Uint8Array} h5Bytes  – raw HDF5 file bytes
 * @param {Set<string>} genesToFetch  – lowercase gene names needed (common + predict)
 * @returns {{ geneNames: string[], matrix: Float32Array, nCells: number }}
 *   matrix is row-major (nCells × nFetched), log1p(counts / cellTotal * 1e4)
 */
async function readScrnaH5ForSpaGE(h5Bytes, genesToFetch) {
  const h5mod = await import('h5wasm');
  await h5mod.ready;

  const tmpPath = '/_spage_scrna_ref.h5';
  h5mod.FS.writeFile(tmpPath, h5Bytes);

  let f;
  try {
    f = new h5mod.File(tmpPath, 'r');

    // Detect layout (v3: /matrix/..., v2: root-level, or genome-group)
    const rootKeys = f.keys();
    let dataPath, indicesPath, indptrPath, shapePath, geneNamesPath;

    if (rootKeys.includes('matrix')) {
      dataPath     = '/matrix/data';
      indicesPath  = '/matrix/indices';
      indptrPath   = '/matrix/indptr';
      shapePath    = '/matrix/shape';
      const fk = f.get('matrix/features').keys();
      geneNamesPath = fk.includes('name') ? '/matrix/features/name'
                    : fk.includes('id')   ? '/matrix/features/id'
                    : null;
    } else if (rootKeys.includes('data')) {
      dataPath     = '/data';
      indicesPath  = '/indices';
      indptrPath   = '/indptr';
      shapePath    = '/shape';
      geneNamesPath = rootKeys.includes('gene_names') ? '/gene_names'
                    : rootKeys.includes('genes')       ? '/genes'
                    : null;
    } else {
      // Try genome-named group
      for (const key of rootKeys) {
        try {
          const grp = f.get(key);
          if (grp && typeof grp.keys === 'function') {
            const gk = grp.keys();
            if (gk.includes('data') && gk.includes('indptr')) {
              const p = `/${key}`;
              dataPath     = `${p}/data`;
              indicesPath  = `${p}/indices`;
              indptrPath   = `${p}/indptr`;
              shapePath    = `${p}/shape`;
              geneNamesPath = gk.includes('gene_names') ? `${p}/gene_names`
                            : gk.includes('genes')      ? `${p}/genes`
                            : null;
              break;
            }
          }
        } catch (_) { /* skip */ }
      }
    }

    if (!dataPath) throw new Error('Could not detect 10x HDF5 layout for scRNA reference');

    // Read gene names
    const rawNames = geneNamesPath ? f.get(geneNamesPath).value : [];
    const geneNames = Array.from(rawNames, s => String(s));

    // Read shape [nGenes, nCells]
    const shapeArr = f.get(shapePath).value;
    const nGenes = Number(shapeArr[0]);
    const nCells = Number(shapeArr[1]);

    // Build index lookup for genes we need
    const geneToFetchIdx = new Map(); // h5 gene index → fetch slot
    const fetchedNames   = [];
    for (let i = 0; i < geneNames.length; i++) {
      if (genesToFetch.has(geneNames[i].toLowerCase())) {
        geneToFetchIdx.set(i, fetchedNames.length);
        fetchedNames.push(geneNames[i]);
      }
    }
    if (fetchedNames.length === 0) {
      throw new Error('No genes from the spatial panel were found in the scRNA HDF5 reference. Check gene name conventions (e.g. upper vs lower case).');
    }

    // Read full sparse arrays (CSC: cells=columns)
    const dataArr    = f.get(dataPath).value;
    const indicesArr = f.get(indicesPath).value;
    const indptrRaw  = f.get(indptrPath).value;
    // Convert indptr to regular numbers (may be BigInt64Array)
    const indptr = new Float64Array(nCells + 1);
    for (let i = 0; i <= nCells; i++) {
      indptr[i] = typeof indptrRaw[i] === 'bigint' ? Number(indptrRaw[i]) : indptrRaw[i];
    }
    // Compute per-cell totals for library-size normalization
    const cellTotals = new Float64Array(nCells);
    for (let c = 0; c < nCells; c++) {
      const start = indptr[c], end = indptr[c + 1];
      for (let k = start; k < end; k++) cellTotals[c] += dataArr[k];
    }

    // Build dense matrix (nCells × nFetched)
    // indicesArr may be BigInt64Array (h5wasm returns 64-bit indices as BigInt);
    // Map keys are plain numbers so we must convert before lookup.
    const indicesAreBigInt = indicesArr.length > 0 && typeof indicesArr[0] === 'bigint';
    const nFetched = fetchedNames.length;
    const dense    = new Float32Array(nCells * nFetched);
    for (let c = 0; c < nCells; c++) {
      const start = indptr[c], end = indptr[c + 1];
      const scale = cellTotals[c] > 0 ? 1e4 / cellTotals[c] : 0;
      for (let k = start; k < end; k++) {
        const gIdx = indicesAreBigInt ? Number(indicesArr[k]) : indicesArr[k];
        const slot = geneToFetchIdx.get(gIdx);
        if (slot !== undefined) {
          dense[c * nFetched + slot] = Math.log1p(dataArr[k] * scale);
        }
      }
    }

    return { geneNames: fetchedNames, matrix: dense, nCells };
  } finally {
    if (f) try { f.close(); } catch (_) { /* ignore */ }
    try { h5mod.FS.unlink(tmpPath); } catch (_) { /* ignore */ }
  }
}

/**
 * Read a 10x MatrixMarket scRNA-seq dataset and return log-normalized
 * expression for a specific set of genes.
 *
 * @param {Uint8Array} matrixBuf   – matrix.mtx bytes (uncompressed)
 * @param {string[]}   allGeneNames – gene names from features.tsv (one per row of matrix)
 * @param {Set<string>} genesToFetch
 * @returns {{ geneNames: string[], matrix: Float32Array, nCells: number }}
 */
function readScrnaMtxForSpaGE(matrixBuf, allGeneNames, genesToFetch) {
  // parseMTXFromBuffer returns SparseMatrixCSC (genes=rows, cells=columns)
  const sparse = parseMTXFromBuffer(matrixBuf);
  const nGenes = sparse.nrows;
  const nCells = sparse.ncols;
  const { colPtr, rowIdx, values } = sparse;

  const geneToFetchIdx = new Map();
  const fetchedNames   = [];
  for (let i = 0; i < allGeneNames.length; i++) {
    const norm = allGeneNames[i].toLowerCase();
    if (genesToFetch.has(norm)) {
      geneToFetchIdx.set(i, fetchedNames.length);
      fetchedNames.push(allGeneNames[i]);
    }
  }
  if (fetchedNames.length === 0) {
    throw new Error('No genes from the spatial panel were found in the scRNA matrix reference.');
  }

  const nFetched   = fetchedNames.length;
  const cellTotals = new Float64Array(nCells);
  for (let c = 0; c < nCells; c++) {
    for (let k = colPtr[c]; k < colPtr[c + 1]; k++) cellTotals[c] += values[k];
  }

  const dense = new Float32Array(nCells * nFetched);
  for (let c = 0; c < nCells; c++) {
    const scale = cellTotals[c] > 0 ? 1e4 / cellTotals[c] : 0;
    for (let k = colPtr[c]; k < colPtr[c + 1]; k++) {
      const slot = geneToFetchIdx.get(rowIdx[k]);
      if (slot !== undefined) {
        dense[c * nFetched + slot] = Math.log1p(values[k] * scale);
      }
    }
  }

  return { geneNames: fetchedNames, matrix: dense, nCells };
}

/**
 * Main imputation handler: runs SpaGE to predict unmeasured gene expression
 * in the loaded spatial dataset using a provided scRNA-seq reference.
 *
 * @param {object} params      – { gene: string, genes?: string[] }
 * @param {object} scrnaFiles  – pre-read file buffers from Electron IPC (read10xFiles return value)
 *   For h5:  { success, format: '10X HDF5', files: { h5: { data: Uint8Array, name: string } } }
 *   For mtx: { success, format: '10X MatrixMarket', files: { matrix: { data }, features: { data }, barcodes: { data } } }
 */
async function imputeGeneExpression(params, scrnaFiles) {
  const genesToPredict = params.genes
    ? params.genes
    : params.gene
      ? [params.gene]
      : [];

  if (genesToPredict.length === 0) {
    throw new Error('impute_gene: no gene specified');
  }
  if (!scrnaFiles) {
    throw new Error('impute_gene: scRNA-seq reference files not provided');
  }

  self.postMessage({ type: 'STATUS_UPDATE', message: `Imputing gene(s): ${genesToPredict.join(', ')}…` });

  // Get spatial count matrix and gene names from loaded data
  if (!loadedData) throw new Error('No spatial data loaded');

  const { geneNames: spatialGeneNames, lookup } = await ensureGeneLookup();
  const nSpatialGenes = spatialGeneNames.length;

  // Fetch log-normalized expression for ALL spatial genes
  self.postMessage({ type: 'STATUS_UPDATE', message: 'SpaGE: Extracting spatial expression matrix…' });
  const { logExpressions: spatialExprArrs } = await resolveGeneExpressions(spatialGeneNames);

  const nSpatial = spatialExprArrs[0].length;
  // Build spatial matrix (nSpatial × nSpatialGenes), row-major
  const spatialMatrix = new Float32Array(nSpatial * nSpatialGenes);
  for (let g = 0; g < nSpatialGenes; g++) {
    const col = spatialExprArrs[g];
    for (let c = 0; c < nSpatial; c++) {
      spatialMatrix[c * nSpatialGenes + g] = col[c];
    }
  }

  // Load scRNA reference
  self.postMessage({ type: 'STATUS_UPDATE', message: 'SpaGE: Loading scRNA-seq reference…' });

  // Fetch only: common genes (all spatial panel genes) + genes to predict
  const genesToFetch = new Set([
    ...spatialGeneNames.map(g => g.toLowerCase()),
    ...genesToPredict.map(g => g.toLowerCase()),
  ]);

  let rnaGeneNames, rnaMatrix, nRNA;

  // read10xFiles returns { success, format, files: { h5 } } or { success, format, files: { matrix, features, barcodes } }
  const files = scrnaFiles.files || scrnaFiles;
  const isH5 = scrnaFiles.format === '10X HDF5' || scrnaFiles.format === 'h5' || !!files.h5;

  if (isH5) {
    const h5Entry = files.h5 || scrnaFiles.h5;
    const h5Raw = h5Entry?.data ?? h5Entry;
    const h5Bytes = h5Raw instanceof Uint8Array ? h5Raw : new Uint8Array(h5Raw);
    ({ geneNames: rnaGeneNames, matrix: rnaMatrix, nCells: nRNA } = await readScrnaH5ForSpaGE(h5Bytes, genesToFetch));
  } else if (files.matrix && files.features) {
    // MTX format: features file contains gene names; decompress .gz if needed
    // Simpler gzip decompress using DecompressionStream (available in workers)
    const decompressGzip = async (buf) => {
      if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf; // not gzipped
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(buf);
      writer.close();
      const chunks = [];
      let totalLen = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLen += value.length;
      }
      const result = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      return result;
    };

    const rawMatrix   = files.matrix.data instanceof Uint8Array ? files.matrix.data : new Uint8Array(files.matrix.data);
    const rawFeatures = files.features.data instanceof Uint8Array ? files.features.data : new Uint8Array(files.features.data);

    const matrixBuf   = await decompressGzip(rawMatrix);
    const featuresBuf = await decompressGzip(rawFeatures);

    // Decode features TSV to get gene names (column 2 = gene name)
    const featText = new TextDecoder().decode(featuresBuf);
    const allGeneNames = featText.trim().split('\n').map(line => {
      const cols = line.split('\t');
      return cols[1] || cols[0] || '';
    });


    ({ geneNames: rnaGeneNames, matrix: rnaMatrix, nCells: nRNA } =
      readScrnaMtxForSpaGE(matrixBuf, allGeneNames, genesToFetch));
  } else {
    throw new Error('SpaGE: unrecognized scRNA reference format. Provide an h5 file or a matrix folder.');
  }

  self.postMessage({ type: 'STATUS_UPDATE', message: `SpaGE: ${nRNA} RNA cells × ${rnaGeneNames.length} genes loaded. Running alignment…` });

  // Run SpaGE
  let imputedMap;
  try {
    imputedMap = runSpaGE({
      spatialMatrix,
      spatialGenes: spatialGeneNames,
      rnaMatrix,
      rnaGenes: rnaGeneNames,
      genesToPredict,
      nPV: 20,
      onProgress: (msg) => self.postMessage({ type: 'STATUS_UPDATE', message: msg }),
    });
  } catch (err) {
    throw new Error(`SpaGE imputation failed: ${err.message}`);
  }

  // Debug: check imputed values
  for (const [geneName, expression] of imputedMap) {
    const nonzero = expression.filter(v => v > 0).length;
    const max = Math.max(...expression.subarray(0, Math.min(200, expression.length)));
  }

  // Store imputed values in cache for violin/dot plots
  // These are plotting-only and must NEVER be used in reanalysis (PCA/clustering/UMAP).
  // Keep a copy before transferring the buffer below.
  const imputedCopies = new Map();
  for (const [geneName, expression] of imputedMap) {
    imputedCopies.set(geneName.toLowerCase(), expression.slice());
  }

  // Send results back as gene_expression (one per gene)
  const isSpatialIntegration =
    loadedData?.info?.modality === 'xenium-integration' ||
    loadedData?.info?.modality === 'merfish-integration' ||
    loadedData?.info?.modality === 'visium-hd-integration';

  const spatialDataSource = loadedData?.spatialData || spatialData;
  const spatialCoordinates = (!isSpatialIntegration && spatialDataSource && Array.isArray(spatialDataSource.coordinates))
    ? spatialDataSource.coordinates.map(c => {
        if (!c) return [0, 0];
        return Array.isArray(c) ? [c[0] ?? 0, c[1] ?? 0] : [c.x ?? 0, c.y ?? 0];
      })
    : null;

  const umapCoords = currentResults.umap || null;

  // For spatial integration: include integrationViews + perSampleSpatial so the
  // frontend can display the imputed gene on each sample's tissue view in the same
  // merged-cell order (values are comparable across samples, joint SpaGE imputation).
  const integrationMeta = isSpatialIntegration ? {
    integrationViews: loadedData.integrationViews || null,
    datasetNames: loadedData.info?.datasetNames || [],
    perSampleSpatial: loadedData.perSampleSpatial || null,
  } : {};

  // Send one message per imputed gene
  for (const [geneName, expression] of imputedMap) {
    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'gene_expression',
        geneName: `${geneName} (imputed)`,
        expression,
        coordinates: umapCoords,
        spatialCoordinates,
        isImputed: true,
        ...integrationMeta,
      },
    }, [expression.buffer]);
  }

  // Populate cache after sending (the buffer is transferred above, use copies)
  for (const [key, copy] of imputedCopies) {
    imputedGeneCache.set(key, copy);
  }
}

// ============================================================================
// BANKSY Region Segmentation
// ============================================================================

/**
 * Run BANKSY spatial region segmentation.
 * Requires spatial coordinates and normalized expression data.
 *
 * Returns a 'umap' type result with BANKSY cluster labels replacing the
 * standard transcriptomic clusters, displayed on the spatial tissue view.
 *
 * @param {Object} params
 * @param {number} [params.lambda=0.3]: Neighborhood contribution (0=transcriptomic, 1=spatial)
 * @param {number} [params.numNeighbors=15]: Spatial k-NN neighbors
 * @param {number} [params.clusterNeighbors=50]: BANKSY PCA graph neighbors
 * @param {number} [params.resolution=0.7]: Leiden/multilevel clustering resolution
 * @param {number} [params.numHvgs=500]: Number of HVGs to use for BANKSY
 * @param {number} [params.numPcaDims=20]: PCA dimensions
 */
async function runBanksyRegionSegmentation(params = {}) {
  const {
    lambda = 0.3,
    numNeighbors = 15,
    clusterNeighbors = 50,
    // Lower resolution than cell-type clustering, region segmentation should
    // produce fewer, larger cohesive areas (typically 5–15 regions).
    // BANKSY paper uses 0.2–0.3 for tissue domain detection.
    resolution = 0.3,
    numHvgs = 500,
    numPcaDims = 20,
  } = params;

  const post = (msg) => self.postMessage({ type: 'STATUS_UPDATE', message: msg });

  post('BANKSY: Checking for spatial data...');

  if (!loadedData) {
    throw new Error('No data loaded. Please load a spatial dataset first.');
  }

  // Get spatial coordinates
  const spatialDataSource = loadedData.spatialData || spatialData;
  if (!spatialDataSource || !Array.isArray(spatialDataSource.coordinates) || spatialDataSource.coordinates.length === 0) {
    self.postMessage({
      type: 'ANALYSIS_ERROR',
      error: 'BANKSY region segmentation requires spatial data with tissue coordinates. ' +
             'Please load a spatial dataset (Visium, Xenium, MERFISH, etc.) first.',
    });
    return;
  }

  const rawCoords = spatialDataSource.coordinates;

  // Parse coordinates to [x, y] pairs (handle both array and object formats)
  const allCoords = rawCoords.map(c => {
    if (c == null) return [0, 0];
    return Array.isArray(c) ? [c[0] ?? 0, c[1] ?? 0] : [c.x ?? 0, c.y ?? 0];
  });

  // Determine which cells have valid (non-null) coordinates
  const validCellMask = rawCoords.map(c => c != null && !isNaN(Array.isArray(c) ? c[0] : c.x));
  const validIndices = validCellMask.map((v, i) => v ? i : -1).filter(i => i >= 0);

  const nCells = validIndices.length;
  const coords = validIndices.map(i => allCoords[i]);

  post(`BANKSY: Preparing expression matrix for ${nCells.toLocaleString()} cells...`);

  // Get normalized expression matrix
  // Prefer bakana state, fall back to JS pipeline data
  let normMatrix = null;
  let nGenesTotal = 0;
  let geneNames = [];

  if (loadedData.state && typeof loadedData.state.rna_normalization?.fetchNormalizedMatrix === 'function') {
    normMatrix = loadedData.state.rna_normalization.fetchNormalizedMatrix();
    nGenesTotal = normMatrix.numberOfRows();
    try {
      const namesResult = await (async () => {
        if (cachedGeneNames) return { geneNames: cachedGeneNames };
        const featureAnnotations = loadedData.state.inputs.fetchFeatureAnnotations();
        const annotations = featureAnnotations?.['RNA'] || featureAnnotations?.[Object.keys(featureAnnotations || {})[0]];
        if (!annotations) return { geneNames: [] };
        const rows = typeof annotations.rowNames === 'function' ? annotations.rowNames() : null;
        if (rows && rows.length > 0) return { geneNames: Array.from(rows) };
        const columnNames = annotations.columnNames();
        const col = ['Symbol', 'symbol', 'gene_name', 'gene', 'Name', 'name'].find(n => columnNames.includes(n));
        return { geneNames: col ? Array.from(annotations.column(col)) : [] };
      })();
      geneNames = namesResult.geneNames;
    } catch (_) {
      geneNames = Array.from({ length: nGenesTotal }, (_, i) => `gene_${i}`);
    }
  } else if (loadedData.jsGeneNames) {
    // Large dataset JS path, use HVG matrix if available
    geneNames = loadedData.jsGeneNames;
    nGenesTotal = geneNames.length;
  } else {
    self.postMessage({
      type: 'ANALYSIS_ERROR',
      error: 'BANKSY requires normalized expression data. Please run the initial analysis first.',
    });
    return;
  }

  // Select HVGs for BANKSY (top N by expression variance)
  const nHvgs = Math.min(numHvgs, nGenesTotal);
  post(`BANKSY: Selecting top ${nHvgs} variable genes...`);

  // Compute per-gene variance to select HVGs
  // For the bakana path, sample up to 5K cells for variance estimation to save time
  const nForVariance = Math.min(nCells, 5000);
  const varianceSampleStep = nCells > nForVariance ? Math.floor(nCells / nForVariance) : 1;
  const geneVar = new Float64Array(nGenesTotal);

  if (normMatrix) {
    // For each gene, get expression values from all valid cells (step for speed on large datasets)
    for (let g = 0; g < nGenesTotal; g++) {
      const row = normMatrix.row(g);
      if (!row) continue;
      let sum = 0, sum2 = 0, count = 0;
      for (let si = 0; si < nCells; si += varianceSampleStep) {
        const cellIdx = validIndices[si];
        const v = row[cellIdx] ?? 0;
        sum += v;
        sum2 += v * v;
        count++;
      }
      if (count > 1) {
        const mean = sum / count;
        geneVar[g] = sum2 / count - mean * mean;
      }
    }
  } else if (loadedData.jsNormMatrix) {
    // JS pipeline path: use jsNormMatrix (sparse CSC)
    const mat = loadedData.jsNormMatrix;
    for (let g = 0; g < nGenesTotal; g++) {
      geneVar[g] = 1; // treat all as equally variable if no variance info
    }
  } else {
    for (let g = 0; g < nGenesTotal; g++) geneVar[g] = 1;
  }

  // Sort genes by variance (descending) and pick top nHvgs
  const geneOrder = Array.from({ length: nGenesTotal }, (_, i) => i);
  geneOrder.sort((a, b) => geneVar[b] - geneVar[a]);
  const hvgIndices = geneOrder.slice(0, nHvgs);

  // Build dense expression matrix (nCells × nHvgs), row-major, Float32
  post(`BANKSY: Extracting expression matrix (${nCells.toLocaleString()} cells × ${nHvgs} genes)...`);
  const X = new Float32Array(nCells * nHvgs);

  if (normMatrix) {
    for (let hi = 0; hi < nHvgs; hi++) {
      const g = hvgIndices[hi];
      const row = normMatrix.row(g);
      if (!row) continue;
      for (let ci = 0; ci < nCells; ci++) {
        const cellIdx = validIndices[ci];
        X[ci * nHvgs + hi] = row[cellIdx] ?? 0;
      }
    }
  } else {
    // fallback: all zeros (algorithm will still run, just won't be meaningful)
    post('BANKSY: Warning, could not extract expression data, spatial-only mode.');
  }

  // Seeded PRNG for reproducibility
  function seededRandom(seed) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rng = seededRandom(42);

  // Run BANKSY
  post(`BANKSY: Running BANKSY algorithm (lambda=${lambda}, k=${numNeighbors})...`);
  let banksyResult;
  try {
    banksyResult = await runBanksy({
      coords,
      expressionMatrix: X,
      nCells,
      nGenes: nHvgs,
      lambda,
      numNeighbors,
      numPcaDims: Math.min(numPcaDims, nHvgs * 2 - 1, nCells - 1),
      pcaIter: 3,
      statusCallback: post,
      randomFn: rng,
    });
  } catch (banksyErr) {
    throw new Error(`BANKSY algorithm failed: ${banksyErr.message}`);
  }

  const { cellEmbeddings, nComponents, kUsed } = banksyResult;
  post(`BANKSY: Clustering ${nCells.toLocaleString()} cells in BANKSY space...`);

  // Build kNN from BANKSY PCA for SNN clustering. BANKSY's graph clustering
  // defaults to k_neighbors=50; keeping this separate from the spatial k keeps
  // the neighborhood feature calculation and the final graph aligned with the
  // upstream workflow.
  const kClustering = Math.min(Math.max(1, Math.floor(clusterNeighbors)), nCells - 1);

  // Cluster with scran.js SNN graph + multilevel/leiden
  post('BANKSY: Building k-NN/SNN graph in full BANKSY PCA space...');
  const pcaColumnMajor = new Float64Array(nCells * nComponents);
  for (let i = 0; i < nCells; i++) {
    const inBase = i * nComponents;
    for (let d = 0; d < nComponents; d++) {
      pcaColumnMajor[d + i * nComponents] = cellEmbeddings[inBase + d];
    }
  }
  let neighborIndex = null;
  let knnResults = null;
  let snnGraph = null;
  let clusterResult = null;
  let clusterArray;

  try {
    neighborIndex = scran.buildNeighborSearchIndex(pcaColumnMajor, {
      numberOfDims: nComponents,
      numberOfCells: nCells,
      approximate: nCells > 10000,
    });
    knnResults = scran.findNearestNeighbors(neighborIndex, kClustering);
    snnGraph = scran.buildSnnGraph(knnResults, { scheme: 'rank' });
    clusterResult = scran.clusterGraph(snnGraph, {
      method: 'multilevel',
      multiLevelResolution: resolution,
    });
    const membership = clusterResult.membership();
    clusterArray = Array.from(membership);
  } finally {
    if (clusterResult) try { clusterResult.free(); } catch (_) {}
    if (snnGraph) try { snnGraph.free(); } catch (_) {}
    if (knnResults) try { knnResults.free(); } catch (_) {}
    if (neighborIndex) try { neighborIndex.free(); } catch (_) {}
  }

  const nRegions = new Set(clusterArray).size;
  post(`BANKSY: Found ${nRegions} spatial region${nRegions !== 1 ? 's' : ''}!`);

  // Build full-length cluster and coordinate arrays aligned to all original cells.
  // Cells with null/invalid coordinates (validCellMask=false) get label -1.
  const nAllCells = allCoords.length;
  const finalClusters = new Array(nAllCells).fill(-1);
  for (let ci = 0; ci < nCells; ci++) {
    finalClusters[validIndices[ci]] = clusterArray[ci];
  }
  const finalSpatialCoords = allCoords.map(c => [c[0], c[1]]);

  // Store region labels independently so they don't overwrite transcriptomic clusters
  currentResults.regionClusters = finalClusters;

  // Ensure transcriptomic clusters are populated for cross-referencing
  if (!currentResults.clusters || !currentResults.clusters.length) {
    try {
      const state = loadedData.state;
      const fetched = state.choose_clustering.fetchClusters();
      if (fetched && fetched.length) {
        currentResults.clusters = Array.from(fetched);
      }
    } catch (_) { /* clustering may not be available yet */ }
  }

  // Use existing UMAP coordinates (or spatial coords if no UMAP)
  const umapCoordinates = currentResults.umap || null;

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'umap',
      coordinates: umapCoordinates || finalSpatialCoords,
      clusters: finalClusters,
      nClusters: nRegions,
      nCells: nAllCells,
      source: 'banksy',
      banksyResult: true,
      spatialCoordinates: finalSpatialCoords,
      banksyParams: { lambda, numNeighbors, clusterNeighbors: kClustering, resolution, nHvgs },
    },
  });
}

async function runClusteringAndUMAP(sendMessage = true, source = null, multiomeTarget = null, atacMethod = null) {
  if (!loadedData) {
    throw new Error('No data loaded. Please load data first.');
  }

  // Reclustering: clear scATAC caches so downstream plot gene activity uses new clusters
  if (source === 'reclustered') {
    scAtacGeneActivityCache.clear();
  }

  if (loadedData.info?.modality === 'multiome' && multiomeTarget === 'rna' && atacMethod === 'lsi') {
    self.postMessage({
      type: 'ANALYSIS_ERROR',
      error: 'RNA has no LSI method. LSI is for ATAC-seq only. Select ATAC (chromatin accessibility) to use LSI.',
      lsiRnaRefused: true,
    });
    return;
  }

  // Standalone scATAC: default is bakana (RNA-style); when user requests LSI, run TF-IDF/LSI pipeline
  if (loadedData.info?.modality === 'atac' && atacMethod === 'lsi') {
    self.postMessage({ type: 'STATUS_UPDATE', message: 'Running ATAC clustering and UMAP (TF-IDF/LSI pipeline)...' });
    await runAtacPipeline({ skipPostMessage: true, multiome: false });
    const coords = currentResults.umap || [];
    const clusters = currentResults.clusters || [];
    if (sendMessage) {
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'umap',
          coordinates: coords,
          clusters,
          nClusters: new Set(clusters).size,
          nCells: coords.length,
          source: 'atac',
        },
      });
    }
    return;
  }

  try {
    // Multiome + user chose ATAC: default to the TF-IDF/LSI scATAC pipeline.
    if (loadedData.info?.modality === 'multiome' && multiomeTarget === 'atac') {
      const useLsi = atacMethod !== 'bakana';
      self.postMessage({ type: 'STATUS_UPDATE', message: useLsi ? 'Running ATAC clustering and UMAP (TF-IDF/LSI pipeline)...' : 'Running ATAC clustering and UMAP (bakana peak-as-RNA pipeline)...' });
      if (useLsi) {
        const multiomePeak = await getMultiomePeakMatrix();
        await runAtacPipeline({ skipPostMessage: true, multiome: true, multiomePeakMatrix: multiomePeak || undefined });
        alignMultiomeAtacResultsToCanonical();
      } else {
        await runAtacPipelineBakana({ skipPostMessage: true });
      }
      if (loadedData.precomputed) realignMultiomeRnaPrecomputedToCurrentBarcodes();
      if (sendMessage) {
        const rnaAligned = loadedData.precomputed?.rnaAligned;
        const atacAligned = loadedData.precomputed?.atacAligned;
        if (rnaAligned) {
          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              type: 'umap',
              coordinates: rnaAligned.coordinates,
              clusters: rnaAligned.clusters,
              nClusters: rnaAligned.nClusters,
              nCells: rnaAligned.coordinates.length,
              source: 'precomputed',
              multiomeModality: 'rna',
            },
          });
        }
        if (atacAligned) {
          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              type: 'umap',
              coordinates: atacAligned.coordinates,
              clusters: atacAligned.clusters,
              nClusters: atacAligned.nClusters,
              nCells: atacAligned.coordinates.length,
              source: 'atac',
              multiomeModality: 'atac',
              cellBarcodes: Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === atacAligned.coordinates.length
                ? loadedData.cellBarcodes
                : undefined,
            },
          });
        }
      }
      const rnaAligned = loadedData.precomputed?.rnaAligned;
      if (rnaAligned?.coordinates && rnaAligned?.clusters) {
        currentResults.umap = rnaAligned.coordinates;
        currentResults.clusters = rnaAligned.clusters;
      }
      return;
    }

    // ATAC integration: use existing UMAP/clusters from currentResults (from initial runAtacIntegrationPipeline).
    // No bakana state; "plot umap" / cluster_and_visualize should resend UMAP colored by cluster.
    if (loadedData.info?.modality === 'atac-integration' && source !== 'reclustered' &&
        currentResults.umap && currentResults.clusters &&
        currentResults.umap.length > 0 && currentResults.clusters.length > 0) {
      const coordinates = currentResults.umap;
      const clusters = currentResults.clusters;
      const uniqueClusters = new Set(clusters.filter((c) => c !== null && c !== undefined));
      const nClusters = uniqueClusters.size;
      if (sendMessage) {
        const messageData = {
          type: 'umap',
          coordinates,
          clusters,
          nClusters,
          nCells: coordinates.length,
          source: 'atac',
        };
        if (loadedData.integrationViews) messageData.integrationViews = loadedData.integrationViews;
        if (loadedData.info?.datasetNames) messageData.datasetNames = loadedData.info.datasetNames;
        if (currentClusterLabelMap && Object.keys(currentClusterLabelMap).length > 0) {
          messageData.clusterLabelMap = currentClusterLabelMap;
        }
        self.postMessage({ type: 'ANALYSIS_COMPLETE', data: messageData });
      }
      return;
    }

    // Standalone scATAC: use existing UMAP/clusters from currentResults (e.g. from initial runFullAnalysisPipeline)
    // when we have them, so "plot clusters" shows the UMAP even when precomputed is null.
    // Skip when source === 'reclustered' so we fall through to state path and update currentResults with new clusters.
    if (loadedData.info?.modality === 'atac' && source !== 'reclustered' &&
        currentResults.umap && currentResults.clusters &&
        currentResults.umap.length > 0 && currentResults.clusters.length > 0) {
      const coordinates = currentResults.umap;
      const clusters = currentResults.clusters;
      const uniqueClusters = new Set(clusters.filter((c) => c !== null && c !== undefined));
      const nClusters = uniqueClusters.size;
      if (sendMessage) {
        const messageData = {
          type: 'umap',
          coordinates,
          clusters,
          nClusters,
          nCells: coordinates.length,
          source: 'atac',
        };
        if (currentClusterLabelMap && Object.keys(currentClusterLabelMap).length > 0) {
          messageData.clusterLabelMap = currentClusterLabelMap;
        }
        self.postMessage({ type: 'ANALYSIS_COMPLETE', data: messageData });
      }
      return;
    }

    // FIRST: Check if we have precomputed UMAP/clusters (e.g., from Xenium preloaded data)
    // Use these directly without running full analysis pipeline.
    // Skip when source === 'reclustered' and we have state so we send newly computed results instead.
    const usePrecomputed = loadedData.precomputed && currentResults.umap && currentResults.clusters &&
      !(source === 'reclustered' && loadedData.state);
    if (usePrecomputed) {

      const coordinates = currentResults.umap;
      const clusters = currentResults.clusters;

      // Count unique clusters
      const uniqueClusters = new Set(clusters.filter(c => c !== null && c !== undefined));
      const nClusters = uniqueClusters.size;

      if (sendMessage) {
        // For multiome: send both RNA and ATAC UMAPs
        if (loadedData.info?.modality === 'multiome' && loadedData.precomputed.atacAligned) {
          const rnaAligned = loadedData.precomputed.rnaAligned || { coordinates, clusters, nClusters };
          const atacAligned = loadedData.precomputed.atacAligned;

          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              type: 'umap',
              coordinates: rnaAligned.coordinates,
              clusters: rnaAligned.clusters,
              nClusters: rnaAligned.nClusters || nClusters,
              nCells: rnaAligned.coordinates.length,
              source: 'precomputed',
              multiomeModality: 'rna',
            },
          });
          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              type: 'umap',
              coordinates: atacAligned.coordinates,
              clusters: atacAligned.clusters,
              nClusters: atacAligned.nClusters,
              nCells: atacAligned.coordinates.length,
              source: 'precomputed',
              multiomeModality: 'atac',
            },
          });
          return;
        }

        const messageData = {
          type: 'umap',
          coordinates: coordinates,
          clusters: clusters,
          nClusters: nClusters,
          nCells: coordinates.length,
          source: 'precomputed',
        };

        // Add spatial data if present
        if (loadedData.spatialData && Array.isArray(loadedData.spatialData.coordinates)) {
          messageData.spatialCoordinates = loadedData.spatialData.coordinates;
          messageData.spatialMatched = loadedData.spatialData.matched;
        }

        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: messageData
        });
      }

      return;
    }

    // If no precomputed data, we need analysis state (or for scATAC legacy path: run ATAC pipeline)
    if (!loadedData.state) {
      // Standalone scATAC with legacy atacPeakMatrix (no bakana state): run TF-IDF/LSI pipeline to get UMAP/clusters
      if (loadedData.info?.modality === 'atac') {
        self.postMessage({ type: 'STATUS_UPDATE', message: 'Running ATAC analysis (TF-IDF/LSI pipeline)...' });
        await runAtacPipeline({ skipPostMessage: false, multiome: false });
        return;
      }
      throw new Error('No analysis state available. Please run analysis first.');
    }

    const state = loadedData.state;

    // Check if UMAP has already been computed in bakana state
    // If not, we need to run the full pipeline to compute UMAP and clustering
    let needsFullPipeline = false;
    try {
      // Try to check if UMAP results exist
      const testResults = state.umap ? await state.umap.fetchResults() : null;
      if (!testResults || !testResults.x || testResults.x.length === 0) {
        needsFullPipeline = true;
      } else {
      }
    } catch (e) {
      needsFullPipeline = true;
    }

    // If UMAP hasn't been computed (e.g., only normalization was run), run full pipeline
    // EXCEPT: for integration/xenium/atac/visium-hd we may have loaded previous results in currentResults, use those instead
    if (needsFullPipeline) {
      const isIntegration = loadedData.info?.modality === 'integration' || loadedData.info?.modality === 'xenium-integration' || loadedData.info?.modality === 'atac-integration' || loadedData.info?.modality === 'visium-hd-integration' || loadedData.info?.modality === 'merfish-integration';
      // For precomputed spatial (Xenium, MERFISH, Visium HD): when not explicitly reclustering,
      // return precomputed results rather than trying to re-run the full pipeline.
      // When source === 'reclustered', the user explicitly requested reanalysis, fall through
      // to runFullAnalysisPipeline so fresh results are computed.
      const isPrecomputedSpatial = !!loadedData.precomputed && (
        loadedData.info?.modality === 'spatial' ||
        loadedData.info?.modality === 'merfish' ||
        loadedData.info?.modality === 'visium-hd'
      );
      if (isPrecomputedSpatial && source !== 'reclustered') {
        // Prefer currentResults (realigned to filtered cells); fall back to loadedData.precomputed arrays
        const umapCoords = (currentResults.umap && currentResults.umap.length > 0)
          ? currentResults.umap
          : (Array.isArray(loadedData.precomputed.umap) ? loadedData.precomputed.umap : null);
        const clusterArr = (currentResults.clusters && currentResults.clusters.length > 0)
          ? currentResults.clusters
          : (Array.isArray(loadedData.precomputed.clusters) ? loadedData.precomputed.clusters : null);
        if (umapCoords && umapCoords.length > 0) {
          if (sendMessage) {
            self.postMessage({ type: 'STATUS_UPDATE', message: 'Using precomputed UMAP and cluster data...' });
          }
          const nClusters = clusterArr
            ? new Set(clusterArr.filter(c => c !== null && c !== undefined)).size
            : 0;
          const messageData = {
            type: 'umap',
            coordinates: umapCoords,
            clusters: clusterArr,
            nClusters,
            nCells: umapCoords.length,
            source: 'precomputed',
          };
          if (loadedData.spatialData && Array.isArray(loadedData.spatialData.coordinates)) {
            messageData.spatialCoordinates = loadedData.spatialData.coordinates;
            messageData.spatialMatched = loadedData.spatialData.matched;
          }
          if (currentClusterLabelMap && Object.keys(currentClusterLabelMap).length > 0) {
            messageData.clusterLabelMap = currentClusterLabelMap;
          }
          if (sendMessage) {
            self.postMessage({ type: 'ANALYSIS_COMPLETE', data: messageData });
          }
          return;
        }
      }
      const hasExistingResults = currentResults.umap && currentResults.clusters &&
        currentResults.umap.length > 0 && currentResults.clusters.length === currentResults.umap.length;
      if (isIntegration && hasExistingResults) {
        if (sendMessage) {
          self.postMessage({ type: 'STATUS_UPDATE', message: 'Using existing UMAP and cluster data...' });
        }
        const coordinates = currentResults.umap;
        const clusters = currentResults.clusters;
        const nClusters = new Set(clusters.filter(c => c !== null && c !== undefined)).size;
        const messageData = {
          type: 'umap',
          coordinates,
          clusters,
          nClusters,
          nCells: coordinates.length,
          source: 'integration',
        };
        if (loadedData.info?.modality === 'integration') {
          const integrationMeta = getIntegrationViewsForPlot(coordinates.length);
          if (integrationMeta) {
            messageData.integrationViews = integrationMeta.integrationViews;
            messageData.datasetNames = integrationMeta.datasetNames;
          }
        }
        if (loadedData.info?.modality === 'xenium-integration' && loadedData.integrationViews && loadedData.info.datasetNames) {
          messageData.integrationViews = loadedData.integrationViews;
          messageData.datasetNames = loadedData.info.datasetNames;
        }
        if (loadedData.info?.modality === 'atac-integration' && loadedData.integrationViews && loadedData.info.datasetNames) {
          messageData.integrationViews = loadedData.integrationViews;
          messageData.datasetNames = loadedData.info.datasetNames;
        }
        if (loadedData.info?.modality === 'visium-hd-integration' && loadedData.integrationViews && loadedData.info.datasetNames) {
          messageData.integrationViews = loadedData.integrationViews;
          messageData.datasetNames = loadedData.info.datasetNames;
        }
        if (loadedData.info?.modality === 'merfish-integration' && loadedData.integrationViews && loadedData.info.datasetNames) {
          messageData.integrationViews = loadedData.integrationViews;
          messageData.datasetNames = loadedData.info.datasetNames;
        }
        if (currentClusterLabelMap && Object.keys(currentClusterLabelMap).length > 0) {
          messageData.clusterLabelMap = currentClusterLabelMap;
        }
        self.postMessage({ type: 'ANALYSIS_COMPLETE', data: messageData });
        return;
      }
      await runFullAnalysisPipeline({ labelPrefix: 'recluster' });
      // After full pipeline, the results will be sent by runFullAnalysisPipeline
      return;
    }

    // Otherwise, UMAP was already computed (from precomputed data or previous analysis)
    // Just fetch and send the existing results
    if (sendMessage) {
      self.postMessage({ type: 'STATUS_UPDATE', message: 'Fetching existing UMAP and cluster data...' });
    }

    // Get UMAP coordinates from bakana
    const umapResults = await state.umap.fetchResults();
    const coordinates = [];
    for (let i = 0; i < umapResults.x.length; i++) {
      coordinates.push([umapResults.x[i], umapResults.y[i]]);
    }

    // Get cluster assignments
    // If we're not reclustering and we have existing (potentially merged) clusters, preserve them
    // Only fetch fresh clusters from bakana state when actually reclustering
    let clusters;
    if (source !== 'reclustered' && currentResults.clusters && currentResults.clusters.length === coordinates.length) {
      // Use existing clusters (preserves any merged clusters)
      clusters = currentResults.clusters;
    } else {
      // Fetch fresh clusters from bakana state (for reclustering or initial load)
      const clusterResults = state.choose_clustering.fetchClusters();
      clusters = Array.from(clusterResults);
    }

    // Store results
    currentResults.umap = coordinates;
    currentResults.clusters = clusters;

    // Rebuild spatial coordinates to match filtered cell order & cluster indexing.
    // Previous attempt assumed coordinates array index matched original matrix column index after simple discard filtering, which is fragile.
    // Use the global spatialData variable (reassign it) instead of creating a local const to avoid shadowing
    spatialData = loadedData?.spatialData;
    if (spatialData && spatialData.idToCoord && loadedData?.cellBarcodes) {
      try {
        let orderedBarcodes = null;

        try {
          const annotations = state.inputs.fetchCellAnnotations();
          orderedBarcodes = extractOrderedBarcodesFromAnnotations(annotations, clusters.length);
          if (orderedBarcodes) {
          }
        } catch (annotationError) {
          console.warn('Failed to derive filtered barcodes from annotations:', annotationError);
        }

        if (!orderedBarcodes) {
          const filterState = state.cell_filtering;
          let keptIndices = null;
          if (filterState && typeof filterState.fetchKeep === 'function') {
            try {
              const keepResult = filterState.fetchKeep();
              if (keepResult) {
                let mask = null;
                if (typeof keepResult.array === 'function') {
                  mask = keepResult.array();
                } else if (typeof keepResult.toArray === 'function') {
                  mask = keepResult.toArray();
                } else if (Array.isArray(keepResult) || keepResult instanceof Uint8Array) {
                  mask = keepResult;
                } else if (typeof keepResult.length === 'number') {
                  mask = Array.from({ length: keepResult.length }, (_, idx) => keepResult[idx]);
                }

                if (mask && typeof mask.length === 'number') {
                  if (loadedData?.cellBarcodes && mask.length !== loadedData.cellBarcodes.length) {
                    console.warn('Keep mask length does not match cell barcode count.', {
                      keepLength: mask.length,
                      barcodeLength: loadedData.cellBarcodes.length,
                    });
                  }

                  keptIndices = [];
                  for (let i = 0; i < mask.length; i += 1) {
                    const raw = Array.isArray(mask[i]) ? mask[i][0] : mask[i];
                    const keepFlag = typeof raw === 'number' ? raw !== 0 : !!raw;
                    if (keepFlag) {
                      keptIndices.push(i);
                    }
                  }
                }
              }
            } catch (e) {
              console.warn('Error extracting keep mask from filter state:', e);
            }
          }

          if (!Array.isArray(keptIndices) || keptIndices.length === 0) {
            console.warn('Keep mask unavailable; assuming all cells kept (original order).');
            keptIndices = loadedData.cellBarcodes.map((_, i) => i);
          }

          orderedBarcodes = keptIndices.map((idx) => loadedData.cellBarcodes[idx]);
        }

        if (Array.isArray(orderedBarcodes)) {
          if (orderedBarcodes.length !== clusters.length) {
            console.warn('Ordered barcode list length mismatch with analysis outputs.', {
              barcodeLength: orderedBarcodes.length,
              clusterLength: clusters.length,
            });
            if (orderedBarcodes.length > clusters.length) {
              orderedBarcodes = orderedBarcodes.slice(0, clusters.length);
            } else {
              orderedBarcodes = orderedBarcodes.concat(
                Array.from({ length: clusters.length - orderedBarcodes.length }, () => null)
              );
            }
          }

          let resolved = mapBarcodesToCoordinates(spatialData, orderedBarcodes);
          let finalCoords = resolved.coordinates;

          // When idToCoord match fails (0 matches), preserve coordinates by mapping through initial barcode order (CosMX)
          if (resolved.matched === 0 &&
              Array.isArray(spatialData.initialBarcodeOrder) &&
              Array.isArray(spatialData.coordinates) &&
              spatialData.initialBarcodeOrder.length === spatialData.coordinates.length) {
            const initialOrder = spatialData.initialBarcodeOrder;
            const initialCoords = spatialData.coordinates;
            const barcodeToIndex = new Map();
            for (let i = 0; i < initialOrder.length; i++) {
              const b = initialOrder[i];
              if (b != null) barcodeToIndex.set(b, i);
            }
            let preserved = 0;
            finalCoords = orderedBarcodes.map((b) => {
              const idx = b != null ? barcodeToIndex.get(b) : undefined;
              const c = idx !== undefined ? initialCoords[idx] : null;
              if (c != null) preserved++;
              return c;
            });
            resolved = { coordinates: finalCoords, matched: preserved, unmatchedExamples: [] };
            if (preserved > 0) {
            }
          }

          if (Array.isArray(finalCoords) && finalCoords.length !== clusters.length) {
            if (finalCoords.length > clusters.length) {
              finalCoords = finalCoords.slice(0, clusters.length);
            } else {
              finalCoords = finalCoords.concat(
                Array.from({ length: clusters.length - finalCoords.length }, () => null)
              );
            }
            console.warn('Adjusted spatial coordinate array length to match clusters.', {
              adjustedLength: finalCoords.length,
              clusterLength: clusters.length,
            });
          }

          if (resolved.matched === 0) {
            console.error('Coordinate rebuild produced zero matches; spatial alignment will be invalid.', {
              sampleUnmatched: resolved.unmatchedExamples,
            });
          } else {
            if (resolved.unmatchedExamples.length) {
              console.warn('Sample unmatched barcodes after rebuild:', resolved.unmatchedExamples);
            }
          }

          spatialData.coordinates = finalCoords;
          spatialData.matched = resolved.matched;
          spatialData.filteredBarcodes = orderedBarcodes;
          // Persist the updated spatial data back to loadedData
          loadedData.spatialData = spatialData;
        } else {
          console.warn('Unable to derive ordered barcodes for spatial alignment; leaving coordinates unchanged.');
        }
      } catch (rebuildError) {
        console.warn('Failed to rebuild spatial coordinates for filtered order:', rebuildError);
      }
    } else {
      // For single cell data (no spatial coordinates), this is expected; no need to warn
      // Only log if we actually have spatial data but missing required fields
      if (spatialData) {
        console.warn('Skipping spatial coordinate rebuild: missing idToCoord or cellBarcodes', {
          hasSpatialData: !!spatialData,
          hasIdToCoord: !!(spatialData?.idToCoord),
          hasCellBarcodes: !!loadedData?.cellBarcodes,
        });
      }
      // For single cell data without spatialData, silently skip (this is normal)
    }

    // Get number of clusters
    let maxClusterId = -Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const candidate = Number(clusters[i]); // Convert BigInt to Number
      if (candidate > maxClusterId) {
        maxClusterId = candidate;
      }
    }
    const nClusters = (maxClusterId === -Infinity ? 0 : maxClusterId + 1);


    postFilteredSummary({
      reason: sendMessage ? 'post-clustering' : '',
    });

    // Only send message if this was called directly, not as a helper function
    if (sendMessage) {
      // Include spatial coordinates if available (for spatial datasets after reanalysis)
      const messageData = {
        type: 'umap',
        coordinates: coordinates,
        clusters: clusters,
        nClusters: nClusters,
        nCells: coordinates.length,
      };

      // Add source if specified (e.g., 'reclustered' to indicate cluster labels should be reset)
      if (source) {
        messageData.source = source;
      }

      // Add spatial data if present
      if (spatialData && Array.isArray(spatialData.coordinates)) {
        messageData.spatialCoordinates = spatialData.coordinates;
        messageData.spatialMatched = spatialData.matched;
      }

      // Integration: include per-sample views so the app shows Healthy/PKD UMAP cards and clears DEG view
      if (loadedData.info?.modality === 'integration') {
        const nCellsForViews = coordinates.length;
        const integrationMeta = getIntegrationViewsForPlot(nCellsForViews);
        if (integrationMeta) {
          messageData.integrationViews = integrationMeta.integrationViews;
          messageData.datasetNames = integrationMeta.datasetNames;
        }
      }

      // Xenium integration: include per-sample views so all spatial cards show cluster colors
      if (loadedData.info?.modality === 'xenium-integration' && loadedData.integrationViews && loadedData.info.datasetNames) {
        messageData.integrationViews = loadedData.integrationViews;
        messageData.datasetNames = loadedData.info.datasetNames;
      }

      // Visium HD integration: include per-sample views so spatial cards show coordinates colored by clusters
      if (loadedData.info?.modality === 'visium-hd-integration' && loadedData.integrationViews && loadedData.info.datasetNames) {
        messageData.integrationViews = loadedData.integrationViews;
        messageData.datasetNames = loadedData.info.datasetNames;
      }

      // MERFISH integration: include per-sample views so spatial cards show coordinates colored by clusters
      if (loadedData.info?.modality === 'merfish-integration' && loadedData.integrationViews && loadedData.info.datasetNames) {
        messageData.integrationViews = loadedData.integrationViews;
        messageData.datasetNames = loadedData.info.datasetNames;
      }

      // Multiome: send both RNA and ATAC UMAP so both views show cluster UMAP
      if (loadedData.info?.modality === 'multiome') {
        if (Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === coordinates.length) {
          messageData.cellBarcodes = loadedData.cellBarcodes;
        }
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: { ...messageData, multiomeModality: 'rna' },
        });
        const atacAligned = loadedData.precomputed?.atacAligned;
        if (atacAligned) {
          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              type: 'umap',
              coordinates: atacAligned.coordinates,
              clusters: atacAligned.clusters,
              nClusters: atacAligned.nClusters,
              nCells: atacAligned.coordinates.length,
              cellBarcodes: Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === atacAligned.coordinates.length
                ? loadedData.cellBarcodes
                : undefined,
              ...(source ? { source } : {}),
              multiomeModality: 'atac',
            },
          });
        } else {
          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: { ...messageData, multiomeModality: 'atac' },
          });
        }
      } else {
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: messageData
        });
      }
    }

  } catch (error) {
    console.error('Clustering and UMAP failed:', error);
    throw error;
  }
}

async function runUMAP(multiomeTarget = null, atacMethod = null) {
  if (!loadedData) {
    throw new Error('No data loaded. Please load data first.');
  }

  if (loadedData.info?.modality === 'multiome' && multiomeTarget === 'rna' && atacMethod === 'lsi') {
    self.postMessage({
      type: 'ANALYSIS_ERROR',
      error: 'RNA has no LSI method. LSI is for ATAC-seq only. Select ATAC (chromatin accessibility) to use LSI.',
      lsiRnaRefused: true,
    });
    return;
  }

  // Standalone scATAC: default is bakana (RNA-style); when user requests LSI, run TF-IDF/LSI pipeline
  if (loadedData.info?.modality === 'atac' && atacMethod === 'lsi') {
    self.postMessage({ type: 'STATUS_UPDATE', message: 'Running ATAC UMAP (TF-IDF/LSI pipeline)...' });
    await runAtacPipeline({ skipPostMessage: true, multiome: false });
    const coords = currentResults.umap || [];
    const clusters = currentResults.clusters || [];
    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'umap',
        coordinates: coords,
        clusters,
        nClusters: new Set(clusters).size,
        nCells: coords.length,
        source: 'atac',
      },
    });
    return;
  }

  try {
    // Multiome + user chose ATAC: default to the TF-IDF/LSI scATAC pipeline.
    if (loadedData.info?.modality === 'multiome' && multiomeTarget === 'atac') {
      const useLsi = atacMethod !== 'bakana';
      self.postMessage({ type: 'STATUS_UPDATE', message: useLsi ? 'Running ATAC UMAP (TF-IDF/LSI pipeline)...' : 'Running ATAC UMAP (bakana peak-as-RNA pipeline)...' });
      if (useLsi) {
        const multiomePeak = await getMultiomePeakMatrix();
        await runAtacPipeline({ skipPostMessage: true, multiome: true, multiomePeakMatrix: multiomePeak || undefined });
        alignMultiomeAtacResultsToCanonical();
      } else {
        await runAtacPipelineBakana({ skipPostMessage: true });
      }
      if (loadedData.precomputed) realignMultiomeRnaPrecomputedToCurrentBarcodes();
      const rnaAligned = loadedData.precomputed?.rnaAligned;
      const atacAligned = loadedData.precomputed?.atacAligned;
      if (rnaAligned) {
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: {
            type: 'umap',
            coordinates: rnaAligned.coordinates,
            clusters: rnaAligned.clusters,
            nClusters: rnaAligned.nClusters,
            nCells: rnaAligned.coordinates.length,
            source: 'precomputed',
            multiomeModality: 'rna',
          },
        });
      }
      if (atacAligned) {
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: {
            type: 'umap',
            coordinates: atacAligned.coordinates,
            clusters: atacAligned.clusters,
            nClusters: atacAligned.nClusters,
            nCells: atacAligned.coordinates.length,
            source: 'atac',
            multiomeModality: 'atac',
            cellBarcodes: Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === atacAligned.coordinates.length
              ? loadedData.cellBarcodes
              : undefined,
          },
        });
      }
      if (rnaAligned?.coordinates && rnaAligned?.clusters) {
        currentResults.umap = rnaAligned.coordinates;
        currentResults.clusters = rnaAligned.clusters;
      }
      return;
    }

    // For precomputed data (Xenium), use the existing UMAP coordinates and clusters
    if (loadedData.precomputed && currentResults.umap && currentResults.clusters) {

      const coordinates = currentResults.umap;
      const clusters = currentResults.clusters;

      // Count unique clusters
      const uniqueClusters = new Set(clusters.filter(c => c !== null && c !== undefined));
      const nClusters = uniqueClusters.size;

      // Multiome: send both RNA and ATAC UMAP so both views show cluster UMAP
      if (loadedData.info?.modality === 'multiome' && loadedData.precomputed.atacAligned) {
        const rnaAligned = loadedData.precomputed.rnaAligned || { coordinates, clusters, nClusters };
        const atacAligned = loadedData.precomputed.atacAligned;

        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: {
            type: 'umap',
            coordinates: rnaAligned.coordinates,
            clusters: rnaAligned.clusters,
            nClusters: rnaAligned.nClusters || nClusters,
            nCells: rnaAligned.coordinates.length,
            source: 'precomputed',
            multiomeModality: 'rna',
            cellBarcodes: Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === rnaAligned.coordinates.length
              ? loadedData.cellBarcodes
              : undefined,
          },
        });
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: {
            type: 'umap',
            coordinates: atacAligned.coordinates,
            clusters: atacAligned.clusters,
            nClusters: atacAligned.nClusters,
            nCells: atacAligned.coordinates.length,
            source: 'precomputed',
            multiomeModality: 'atac',
            cellBarcodes: Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === atacAligned.coordinates.length
              ? loadedData.cellBarcodes
              : undefined,
          },
        });
        return;
      }

      const messageData = {
        type: 'umap',
        coordinates: coordinates,
        clusters: clusters,
        nClusters: nClusters,
        nCells: coordinates.length,
        source: 'precomputed',
      };

      // Add spatial data if present
      if (loadedData.spatialData && Array.isArray(loadedData.spatialData.coordinates)) {
        messageData.spatialCoordinates = loadedData.spatialData.coordinates;
        messageData.spatialMatched = loadedData.spatialData.matched;
      }

      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: messageData
      });
      return;
    }

    // For regular data, compute UMAP from bakana state
    if (!loadedData.state) {
      throw new Error('Analysis state not ready. Please run analysis first.');
    }

    const state = loadedData.state;

    self.postMessage({ type: 'STATUS_UPDATE', message: 'Computing UMAP...' });

    // Get UMAP coordinates from bakana
    const umapResults = await state.umap.fetchResults();
    const coordinates = [];
    for (let i = 0; i < umapResults.x.length; i++) {
      coordinates.push([umapResults.x[i], umapResults.y[i]]);
    }

    // Fetch clusters so UMAP is colored by existing clusters (clustering is unchanged when only UMAP params change)
    const clusterResults = state.choose_clustering.fetchClusters();
    const clusters = Array.from(clusterResults);

    currentResults.umap = coordinates;
    currentResults.clusters = clusters;

    // Compute nClusters for the UI
    let maxClusterId = -Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const candidate = Number(clusters[i]);
      if (Number.isFinite(candidate) && candidate > maxClusterId) {
        maxClusterId = candidate;
      }
    }
    const nClusters = (maxClusterId === -Infinity ? 0 : maxClusterId + 1);

    const messageData = {
      type: 'umap',
      coordinates: coordinates,
      clusters: clusters,
      nClusters: nClusters,
      nCells: coordinates.length,
    };

    // Include clusterLabelMap so App can preserve cluster renames/merges
    if (currentClusterLabelMap && Object.keys(currentClusterLabelMap).length > 0) {
      messageData.clusterLabelMap = currentClusterLabelMap;
    }

    // Add spatial data if present
    const spatialDataSource = loadedData?.spatialData || spatialData;
    if (spatialDataSource && Array.isArray(spatialDataSource.coordinates)) {
      messageData.spatialCoordinates = spatialDataSource.coordinates;
      messageData.spatialMatched = spatialDataSource.matched;
    }

    // Multiome: send both RNA and ATAC UMAP so both views show cluster UMAP
    if (loadedData.info?.modality === 'multiome') {
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: { ...messageData, multiomeModality: 'rna' },
      });
      const atacAligned = loadedData.precomputed?.atacAligned;
      if (atacAligned) {
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: {
            type: 'umap',
            coordinates: atacAligned.coordinates,
            clusters: atacAligned.clusters,
            nClusters: atacAligned.nClusters,
            nCells: atacAligned.coordinates.length,
            multiomeModality: 'atac',
            cellBarcodes: Array.isArray(loadedData.cellBarcodes) && loadedData.cellBarcodes.length === atacAligned.coordinates.length
              ? loadedData.cellBarcodes
              : undefined,
          },
        });
      } else {
        // No ATAC-specific UMAP: use same RNA coordinates/clusters for ATAC view so both show same clusters
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: { ...messageData, multiomeModality: 'atac' },
        });
      }
    } else {
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: messageData
      });
    }

  } catch (error) {
    console.error('UMAP failed:', error);
    throw error;
  }
}

function normalizeGeneName(name) {
  return (name ?? '').toString().toLowerCase().replace(/\.[0-9]+$/, '');
}

async function ensureGeneLookup() {
  if (!loadedData) {
    throw new Error('No data loaded');
  }

  if (cachedGeneNames && cachedGeneLookup) {
    return { geneNames: cachedGeneNames, lookup: cachedGeneLookup };
  }

  // Pure-JS pipeline: gene names stored directly on loadedData
  if (!loadedData.state && loadedData.jsGeneNames) {
    const geneNames = loadedData.jsGeneNames;
    const lookup = new Map();
    for (let i = 0; i < geneNames.length; i++) {
      const key = normalizeGeneName(String(geneNames[i]));
      if (!lookup.has(key)) lookup.set(key, i);
    }
    cachedGeneNames = geneNames;
    cachedGeneLookup = lookup;
    return { geneNames, lookup };
  }

  if (!loadedData.state) {
    throw new Error('No analysis state or gene names available');
  }

  const state = loadedData.state;
  const featureAnnotations = state.inputs.fetchFeatureAnnotations();
  let annotations = featureAnnotations?.['RNA'];
  if (!annotations && (loadedData?.info?.modality === 'atac' || loadedData?.info?.modality === 'multiome') && featureAnnotations) {
    const peakKey = Object.keys(featureAnnotations).find(k => /peaks?/i.test(k));
    annotations = peakKey ? featureAnnotations[peakKey] : featureAnnotations[Object.keys(featureAnnotations)[0]];
  }
  if (!annotations) {
    throw new Error('RNA feature annotations unavailable');
  }

  let geneNames = null;
  if (typeof annotations.rowNames === 'function') {
    const rows = annotations.rowNames();
    if (rows && typeof rows.length === 'number' && rows.length > 0) {
      geneNames = Array.from(rows);
    }
  }

  if (!geneNames || geneNames.length === 0) {
    const columnNames = annotations.columnNames();
    const possibleGeneColumns = ['Symbol', 'symbol', 'gene_name', 'gene', 'Name', 'name'];
    let geneColumn = null;

    for (const colName of possibleGeneColumns) {
      if (columnNames.includes(colName)) {
        geneColumn = annotations.column(colName);
        break;
      }
    }

    if (!geneColumn) {
      const fallbackColumn = columnNames[0];
      geneColumn = annotations.column(fallbackColumn);
    }

    geneNames = Array.from(geneColumn);
  }

  if (!geneNames || geneNames.length === 0) {
    throw new Error('Could not determine gene names from annotations');
  }

  const lookup = new Map();
  const peakIdRegex = /^chr\w+[:_]\d+[-_]\d+$/i;
  for (let i = 0; i < geneNames.length; i++) {
    const name = String(geneNames[i]);
    const key = normalizeGeneName(name);
    if (!lookup.has(key)) {
      lookup.set(key, i);
    }
    // ATAC peak IDs: allow both chr6:88141558-88142467 and chr6_88141558_88142467 to resolve to same row
    if (peakIdRegex.test(name)) {
      const withUnderscores = name.replace(/:/g, '_').replace(/-/g, '_').toLowerCase();
      const withColonDash = name.replace(/^chr(\w+)_(\d+)_(\d+)$/i, 'chr$1:$2-$3').toLowerCase();
      if (withUnderscores !== key && !lookup.has(withUnderscores)) lookup.set(withUnderscores, i);
      if (withColonDash !== key && withColonDash !== withUnderscores && !lookup.has(withColonDash)) lookup.set(withColonDash, i);
    }
  }

  cachedGeneNames = geneNames;
  cachedGeneLookup = lookup;

  return { geneNames, lookup };
}

function inferFeatureListLabel() {
  const modality = loadedData?.info?.modality || loadedData?.modality;
  if (modality === 'atac' || modality === 'atac-integration') {
    return 'peaks';
  }
  return 'genes';
}

async function getDatasetFeatureNamesForList() {
  if (!loadedData) {
    throw new Error('No data loaded');
  }

  const modality = loadedData?.info?.modality || loadedData?.modality;
  if (modality === 'atac' || modality === 'atac-integration') {
    const peakNames = loadedData.atacPeakNames || loadedData.peakNames || loadedData.jsGeneNames;
    if (Array.isArray(peakNames) && peakNames.length) {
      return peakNames;
    }
  }

  const directNames = loadedData.geneNames || loadedData.jsGeneNames || loadedData.featureNames;
  if (Array.isArray(directNames) && directNames.length) {
    return directNames;
  }

  const { geneNames } = await ensureGeneLookup();
  return geneNames;
}

function getDatasetCellNamesForList() {
  if (!loadedData) {
    throw new Error('No data loaded');
  }

  const direct = loadedData.cellBarcodes || loadedData.allCellBarcodes || loadedData.barcodes;
  if (Array.isArray(direct) && direct.length) {
    return direct;
  }

  const state = loadedData.state;
  if (state?.inputs && loadedData.nCells) {
    try {
      const annotations = state.inputs.fetchCellAnnotations();
      const barcodes = extractOrderedBarcodesFromAnnotations(annotations, loadedData.nCells);
      if (Array.isArray(barcodes) && barcodes.length) {
        return barcodes;
      }
    } catch (error) {
      console.warn('Could not read cell annotations for list_cells:', error.message);
    }
  }

  const nCells = loadedData.nCells || loadedData.rawCells || 0;
  if (Number.isFinite(nCells) && nCells > 0) {
    return Array.from({ length: nCells }, (_, i) => `Cell ${i + 1}`);
  }

  return [];
}

async function listDatasetItems(params = {}) {
  const kind = params.kind === 'cells' ? 'cells' : 'genes';
  const offset = Math.max(0, Number.isFinite(Number(params.offset)) ? Math.floor(Number(params.offset)) : 0);
  const requestedLimit = Number.isFinite(Number(params.limit)) ? Math.floor(Number(params.limit)) : 50;
  const limit = Math.max(1, Math.min(100, requestedLimit));
  const names = kind === 'cells'
    ? getDatasetCellNamesForList()
    : await getDatasetFeatureNamesForList();

  const total = Array.isArray(names) ? names.length : 0;
  const items = Array.isArray(names)
    ? names.slice(offset, Math.min(offset + limit, total)).map(name => String(name))
    : [];
  const nextOffset = offset + items.length;

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'dataset_list',
      kind,
      itemLabel: kind === 'cells' ? 'cells' : inferFeatureListLabel(),
      items,
      offset,
      limit,
      nextOffset,
      total,
      hasMore: nextOffset < total,
    },
  });
}

async function resolveGeneExpressions(geneList) {
  if (!Array.isArray(geneList) || geneList.length === 0) {
    throw new Error('No genes specified');
  }

  const state = loadedData?.state;
  const hasJsNormMatrix = !!loadedData?.jsNormMatrix;
  const hasJsH5Pipeline = !!loadedData?.jsH5TmpFile;
  if (!state && !hasJsNormMatrix && !hasJsH5Pipeline) {
    throw new Error('No data loaded');
  }

  const { geneNames, lookup } = await ensureGeneLookup();

  const indices = [];
  const resolvedNames = [];
  const missing = [];
  for (const rawGene of geneList) {
    const normalized = normalizeGeneName(rawGene);
    if (!normalized) {
      continue;
    }
    const idx = lookup.get(normalized);
    if (idx === undefined) {
      missing.push(rawGene);
    } else {
      indices.push(idx);
      resolvedNames.push(geneNames[idx]);
    }
  }

  // Check imputedGeneCache for genes not found in the bakana/JS matrix
  // (e.g. SpaGE-imputed genes not in the spatial panel).
  // These are plotting-only, never used in reanalysis.
  const imputedResults = []; // { rawGene, key, expression }
  const stillMissing = [];
  for (const rawGene of missing) {
    const key = normalizeGeneName(rawGene);
    if (imputedGeneCache.has(key)) {
      imputedResults.push({ rawGene, key, expression: imputedGeneCache.get(key) });
    } else {
      stillMissing.push(rawGene);
    }
  }

  if (!indices.length && !imputedResults.length) {
    throw new Error(`Gene(s) not found: ${stillMissing.join(', ')}`);
  }
  if (stillMissing.length) {
    throw new Error(`Could not find genes: ${stillMissing.join(', ')}`);
  }

  const logExpressions = [];

  if ((hasJsNormMatrix || hasJsH5Pipeline) && !state) {
    // Pure-JS streaming pipeline
    const jsMatrix  = loadedData.jsNormMatrix;  // may be null if freed for memory
    const origToHvg = loadedData.jsOrigToHvg;   // Int32Array: orig gene idx → HVG row (−1 = non-HVG)
    const nKeptCells = loadedData.jsFilteredBarcodes?.length || jsMatrix?.ncols || 0;

    for (const index of indices) {
      const hvgIdx = origToHvg ? origToHvg[index] : -1;

      if (hvgIdx >= 0 && jsMatrix) {
        // Fast path: gene is in the HVG matrix (if matrix is in memory)
        const row = new Float32Array(jsMatrix.ncols);
        for (let j = 0; j < jsMatrix.ncols; j++) {
          for (let p = jsMatrix.colPtr[j]; p < jsMatrix.colPtr[j + 1]; p++) {
            if (jsMatrix.rowIdx[p] === hvgIdx) {
              row[j] = jsMatrix.values[p];
              break;
            }
          }
        }
        logExpressions.push(row);
      } else if (loadedData.jsH5TmpFile) {
        // H5 path: stream from H5 for any gene
        const { readSingleGeneFromH5 } = await import('../scatac/h5sparse.js');
        const row = await readSingleGeneFromH5(
          loadedData.jsH5TmpFile,
          index,
          loadedData.jsKeepCellFlags,
          loadedData.jsCellTotals,
          loadedData.jsNOrigCells,
          nKeptCells,
        );
        logExpressions.push(row);
      } else {
        // Fallback: zeros
        logExpressions.push(new Float32Array(nKeptCells));
      }
    }
  } else {
    const normMatrix = state.rna_normalization.fetchNormalizedMatrix();
    // Matrix is already log-normalized (scran/bakana: log(1 + count/sizeFactor), i.e. log1p(CPM)-scale).
    // Use values as-is so dot plot "Mean" is in standard log-normalized units (0 to ~9), not double-logged (0-1).
    for (const index of indices) {
      const row = normMatrix.row(index);
      const logArray = new Float32Array(row.length);
      for (let i = 0; i < row.length; i++) {
        const v = row[i];
        logArray[i] = Number.isFinite(v) ? v : 0;
      }
      logExpressions.push(logArray);
    }
  }

  // Append imputed gene results (from imputedGeneCache).
  // Always return a .slice() copy, postMessage may transfer the buffer on the
  // caller side, which would detach the original and break subsequent requests.
  for (const { rawGene, expression } of imputedResults) {
    resolvedNames.push(rawGene);
    logExpressions.push(expression.slice());
    indices.push(-1); // sentinel: not a real matrix index
  }

  return {
    geneNames: resolvedNames,
    logExpressions,
    geneIndices: indices,
  };
}

function computeQuantile(sortedValues, q) {
  if (!sortedValues.length) {
    return NaN;
  }
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedValues[base + 1] !== undefined) {
    return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
  }
  return sortedValues[base];
}

/**
 * Get integration views (per-sample indices) for integration modality.
 * Used by violin/dotplot to plot per-sample with global normalization.
 * @param {number} nCells: total number of cells (filtered)
 * @returns {{ integrationViews: Object.<string, { indices: number[] }>, datasetNames: string[] } | null}
 */
function getIntegrationViewsForPlot(nCells) {
  if (!loadedData) return null;

  const modality = loadedData.info?.modality;

  // Xenium integration: integrationViews is stored directly on loadedData
  if (modality === 'xenium-integration') {
    const integrationViews = loadedData.integrationViews;
    const datasetNames = loadedData.info?.datasetNames;
    if (!integrationViews || !Array.isArray(datasetNames) || datasetNames.length === 0) {
      return null;
    }
    return { integrationViews, datasetNames };
  }

  // Visium HD integration: same as Xenium, integrationViews stored on loadedData
  if (modality === 'visium-hd-integration') {
    const integrationViews = loadedData.integrationViews;
    const datasetNames = loadedData.info?.datasetNames;
    if (!integrationViews || !Array.isArray(datasetNames) || datasetNames.length === 0) {
      return null;
    }
    return { integrationViews, datasetNames };
  }

  // MERFISH integration: same as Xenium, integrationViews stored on loadedData
  if (modality === 'merfish-integration') {
    const integrationViews = loadedData.integrationViews;
    const datasetNames = loadedData.info?.datasetNames;
    if (!integrationViews || !Array.isArray(datasetNames) || datasetNames.length === 0) {
      return null;
    }
    return { integrationViews, datasetNames };
  }

  // Standard scRNA-seq integration: derive integrationViews from bakana state
  if (modality !== 'integration' || !loadedData.state) {
    return null;
  }
  const state = loadedData.state;
  const datasetNames = loadedData.info?.datasetNames;
  if (!Array.isArray(datasetNames) || datasetNames.length === 0) {
    return null;
  }
  let blockIds = null;
  let blockLevels = null;
  try {
    const filterState = state.cell_filtering;
    if (filterState && typeof filterState.fetchFilteredBlock === 'function') {
      const block = filterState.fetchFilteredBlock();
      if (block && block.length === nCells) {
        blockIds = Array.from(block);
        try {
          const levels = state.inputs.fetchBlockLevels();
          blockLevels = levels ? Array.from(levels) : datasetNames;
        } catch (_) {
          blockLevels = datasetNames;
        }
      }
    }
  } catch (e) {
    console.warn('getIntegrationViewsForPlot: could not get block', e.message);
  }
  if (!blockLevels || !blockIds || blockIds.length !== nCells) {
    return null;
  }
  const integrationViews = {};
  for (let v = 0; v < blockLevels.length; v++) {
    const name = blockLevels[v];
    const indices = [];
    for (let i = 0; i < blockIds.length; i++) {
      if (blockIds[i] === v) indices.push(i);
    }
    integrationViews[name] = { indices };
  }
  return { integrationViews, datasetNames };
}

function summarizeDistribution(values) {
  if (!values.length) {
    return {
      size: 0,
      min: NaN,
      max: NaN,
      mean: NaN,
      median: NaN,
      q1: NaN,
      q3: NaN,
    };
  }

  const sorted = values.slice().sort((a, b) => a - b);
  const sum = values.reduce((acc, val) => acc + val, 0);

  return {
    size: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / values.length,
    median: computeQuantile(sorted, 0.5),
    q1: computeQuantile(sorted, 0.25),
    q3: computeQuantile(sorted, 0.75),
  };
}

function createWilcoxonWorkspace(inCount, outCount) {
  const total = inCount + outCount;
  return {
    values: new Float64Array(total),
    groups: new Uint8Array(total),
    order: new Array(total),
    tolerance: 1e-12,
  };
}

function wilcoxonRankSumPValue(rowValues, inIndices, outIndices, workspace) {
  const n1 = inIndices.length;
  const n2 = outIndices.length;
  const total = n1 + n2;

  if (n1 === 0 || n2 === 0 || total <= 1) {
    return 1;
  }

  const { values, groups, order, tolerance } = workspace;

  for (let i = 0; i < total; i++) {
    order[i] = i;
  }

  for (let i = 0; i < n1; i++) {
    values[i] = rowValues[inIndices[i]];
    groups[i] = 1;
  }

  for (let j = 0; j < n2; j++) {
    const target = n1 + j;
    values[target] = rowValues[outIndices[j]];
    groups[target] = 0;
  }

  order.length = total;
  order.sort((a, b) => {
    const diff = values[a] - values[b];
    return diff < 0 ? -1 : diff > 0 ? 1 : 0;
  });

  let rank = 1;
  let index = 0;
  let rankSumIn = 0;
  let tieCorrection = 0;

  while (index < total) {
    let tieEnd = index + 1;
    const currentValue = values[order[index]];

    while (
      tieEnd < total &&
      Math.abs(values[order[tieEnd]] - currentValue) <= tolerance
    ) {
      tieEnd++;
    }

    const tieSize = tieEnd - index;
    const avgRank = (rank + rank + tieSize - 1) / 2;

    for (let k = index; k < tieEnd; k++) {
      if (groups[order[k]] === 1) {
        rankSumIn += avgRank;
      }
    }

    if (tieSize > 1) {
      tieCorrection += tieSize * tieSize * tieSize - tieSize;
    }

    rank += tieSize;
    index = tieEnd;
  }

  const U1 = rankSumIn - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);

  const N = total;
  let varianceTerm = N + 1;
  if (tieCorrection > 0 && N > 1) {
    varianceTerm -= tieCorrection / (N * (N - 1));
  }

  const sigmaSquared = (n1 * n2 / 12) * varianceTerm;
  if (!Number.isFinite(sigmaSquared) || sigmaSquared <= 0) {
    return 1;
  }

  const sigma = Math.sqrt(sigmaSquared);
  const z = (U - (n1 * n2) / 2) / sigma;
  const p = Math.min(1, Math.max(0, complementaryErrorFunction(Math.abs(z) / Math.SQRT2)));
  return p || Number.MIN_VALUE;
}

function benjaminiHochberg(pValues) {
  const n = pValues.length;
  const ordered = pValues
    .map((p, index) => ({ p: Number.isFinite(p) && p >= 0 ? p : 1, index }))
    .sort((a, b) => a.p - b.p);

  const adjusted = new Array(n);
  let minAdjusted = 1;

  for (let i = n - 1; i >= 0; i--) {
    const rank = i + 1;
    const raw = ordered[i].p;
    const candidate = Math.min(minAdjusted, (raw * n) / rank);
    minAdjusted = candidate;
    adjusted[ordered[i].index] = Math.min(candidate, 1);
  }

  return adjusted;
}

function complementaryErrorFunction(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const polynomial =
    1.00002368 +
    t *
      (0.37409196 +
        t *
          (0.09678418 +
            t *
              (-0.18628806 +
                t *
                  (0.27886807 +
                    t *
                      (-1.13520398 +
                        t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))));
  const ans = t * Math.exp(-z * z - 1.26551223 + t * polynomial);
  return x >= 0 ? ans : 2 - ans;
}

async function resolveGeneExpression(gene) {
  if (!gene) {
    throw new Error('No gene specified');
  }

  const { geneNames, logExpressions } = await resolveGeneExpressions([gene]);
  return {
    geneName: geneNames[0],
    logExpression: Array.from(logExpressions[0]),
  };
}

function getMarkerSetForCellType(cellType, markerGenes = [], markerSource = 'provided') {
  const provided = Array.isArray(markerGenes)
    ? markerGenes.map(g => String(g).trim()).filter(Boolean)
    : [];
  if (provided.length > 0) {
    return {
      cellType: cellType || 'requested cell type',
      markers: provided,
      source: markerSource || 'provided',
    };
  }

  const query = String(cellType || '').trim();
  return {
    cellType: query || 'requested cell type',
    markers: [],
    source: 'none',
  };
}

function getCurrentClusterAssignmentsForScoring(multiomeTarget) {
  let clusterAssignments = currentResults.clusters;
  if (loadedData?.info?.modality === 'multiome' && loadedData.precomputed) {
    if (multiomeTarget === 'atac' && loadedData.precomputed.atacAligned?.clusters) {
      clusterAssignments = loadedData.precomputed.atacAligned.clusters;
    } else if (multiomeTarget !== 'atac' && loadedData.precomputed.rnaAligned?.clusters) {
      clusterAssignments = loadedData.precomputed.rnaAligned.clusters;
    }
  }
  return clusterAssignments ? Array.from(clusterAssignments) : [];
}

async function identifyCellTypeClusters(params = {}) {
  if (!loadedData) {
    throw new Error('No data loaded. Please load data first.');
  }

  const requestedCellType = params.cellType || params.cell_type || params.query || '';
  const markerSet = getMarkerSetForCellType(
    requestedCellType,
    params.markerGenes || params.markers,
    params.markerSource || 'provided'
  );
  if (!markerSet.markers.length) {
    throw new Error(`No marker set is available for "${requestedCellType}". Try specifying marker genes, for example: identify clusters using markers GeneA, GeneB, GeneC.`);
  }

  let clusterAssignments = getCurrentClusterAssignmentsForScoring(params.multiomeTarget);
  if (!clusterAssignments.length && loadedData.state) {
    let fetched = loadedData.state.choose_clustering.fetchClusters();
    if (!fetched || !fetched.length) {
      await runClusteringAndUMAP(false);
      fetched = loadedData.state.choose_clustering.fetchClusters();
    }
    clusterAssignments = fetched ? Array.from(fetched) : [];
    currentResults.clusters = clusterAssignments;
  }

  if (!clusterAssignments.length) {
    throw new Error('Cluster assignments are unavailable.');
  }

  const { lookup } = await ensureGeneLookup();
  const availableMarkerGenes = markerSet.markers.filter(gene => lookup.has(normalizeGeneName(gene)));
  const missingMarkers = markerSet.markers.filter(gene => !lookup.has(normalizeGeneName(gene)));
  if (!availableMarkerGenes.length) {
    throw new Error(`None of the marker genes for ${markerSet.cellType} were found in this dataset: ${markerSet.markers.join(', ')}`);
  }

  const { geneNames, logExpressions } = await resolveGeneExpressions(availableMarkerGenes);
  const nCells = clusterAssignments.length;
  const uniqueClusters = Array.from(new Set(clusterAssignments.map(c => String(c)))).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  const clusterIndex = new Map(uniqueClusters.map((id, idx) => [id, idx]));
  const counts = new Array(uniqueClusters.length).fill(0);
  for (let i = 0; i < Math.min(nCells, clusterAssignments.length); i++) {
    const idx = clusterIndex.get(String(clusterAssignments[i]));
    if (idx !== undefined) counts[idx]++;
  }

  const means = uniqueClusters.map(() => new Array(geneNames.length).fill(0));
  const pctExpressing = uniqueClusters.map(() => new Array(geneNames.length).fill(0));

  for (let gi = 0; gi < logExpressions.length; gi++) {
    const expr = logExpressions[gi];
    for (let cell = 0; cell < Math.min(expr.length, clusterAssignments.length); cell++) {
      const ci = clusterIndex.get(String(clusterAssignments[cell]));
      if (ci === undefined) continue;
      const value = Number.isFinite(expr[cell]) ? expr[cell] : 0;
      means[ci][gi] += value;
      if (value > 0) pctExpressing[ci][gi] += 1;
    }
  }

  for (let ci = 0; ci < uniqueClusters.length; ci++) {
    const denom = counts[ci] || 1;
    for (let gi = 0; gi < geneNames.length; gi++) {
      means[ci][gi] /= denom;
      pctExpressing[ci][gi] /= denom;
    }
  }

  const geneMeanAcrossClusters = geneNames.map((_, gi) => {
    const vals = means.map(row => row[gi]);
    return vals.reduce((sum, value) => sum + value, 0) / Math.max(1, vals.length);
  });
  const geneSdAcrossClusters = geneNames.map((_, gi) => {
    const mean = geneMeanAcrossClusters[gi];
    const variance = means.reduce((sum, row) => {
      const diff = row[gi] - mean;
      return sum + diff * diff;
    }, 0) / Math.max(1, means.length);
    return Math.sqrt(variance) || 1;
  });

  const rankings = uniqueClusters.map((clusterId, ci) => {
    const markerStats = geneNames.map((gene, gi) => {
      const mean = means[ci][gi];
      const pct = pctExpressing[ci][gi];
      const z = (mean - geneMeanAcrossClusters[gi]) / geneSdAcrossClusters[gi];
      return {
        gene,
        mean,
        pctExpressing: pct,
        z,
      };
    });
    const expressedMarkers = markerStats.filter(stat => stat.pctExpressing >= 0.05 && stat.mean > 0);
    const avgZ = markerStats.reduce((sum, stat) => sum + stat.z, 0) / Math.max(1, markerStats.length);
    const avgPct = markerStats.reduce((sum, stat) => sum + stat.pctExpressing, 0) / Math.max(1, markerStats.length);
    const strongMarkers = markerStats.filter(stat => stat.pctExpressing >= 0.1 && stat.z >= 1 && stat.mean > 0);
    const strongestPct = markerStats.reduce((max, stat) => Math.max(max, stat.pctExpressing), 0);
    const strongestZ = markerStats.reduce((max, stat) => Math.max(max, stat.z), -Infinity);
    const score = avgZ + avgPct;
    const evidence = (
      strongMarkers.length >= 2 ||
      (strongMarkers.length >= 1 && expressedMarkers.length >= 2 && strongestPct >= 0.15) ||
      (expressedMarkers.length >= 3 && avgZ >= 0.5)
    ) ? 'candidate' : 'weak';
    return {
      cluster: clusterId,
      cellCount: counts[ci],
      score,
      avgZ,
      avgPct,
      strongestPct,
      strongestZ,
      expressedMarkerCount: expressedMarkers.length,
      strongMarkerCount: strongMarkers.length,
      evidence,
      markerStats: markerStats
        .sort((a, b) => (b.z + b.pctExpressing) - (a.z + a.pctExpressing))
        .map(stat => ({
          gene: stat.gene,
          mean: Number(stat.mean.toFixed(3)),
          pctExpressing: Number(stat.pctExpressing.toFixed(3)),
          z: Number(stat.z.toFixed(3)),
        })),
    };
  }).sort((a, b) => {
    if (a.evidence !== b.evidence) return a.evidence === 'candidate' ? -1 : 1;
    if (b.expressedMarkerCount !== a.expressedMarkerCount) return b.expressedMarkerCount - a.expressedMarkerCount;
    return b.score - a.score;
  });

  const candidateRankings = rankings.filter(item => item.evidence === 'candidate');

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'cell_type_cluster_search',
      requestedCellType,
      interpretedCellType: markerSet.cellType,
      markerSource: markerSet.source,
      markerRationale: params.markerRationale || null,
      requestedMarkers: markerSet.markers,
      resolvedMarkers: geneNames,
      missingMarkers,
      rankings,
      candidateRankings,
      hasConvincingCandidate: candidateRankings.length > 0,
      totalClusters: uniqueClusters.length,
      totalCells: nCells,
    },
  });
}

const ATAC_EXTEND_UPSTREAM = 1000;
const ATAC_EXTEND_DOWNSTREAM = 5000;
const ATAC_MAX_CLUSTERS_COVERAGE = 12;

/**
 * Get the peak matrix for multiome data.
 * Uses the pre-loaded atacPeakMatrix, or loads on-the-fly from H5 blob using featureTypeRnaName='Peaks'.
 * Returns { peakMatrix, peakNames, fullBarcodeOrder } or null if not available.
 */
async function getMultiomePeakMatrix() {
  if (loadedData?.info?.modality !== 'multiome') {
    return null;
  }
  // Use peak matrix loaded during multiome initialization (same approach as scATAC)
  if (loadedData.atacPeakMatrix) {
    const peakMatrix = loadedData.atacPeakMatrix;
    const peakNames = loadedData.atacPeakNames || loadedData.peakNames || [];
    const fullBarcodeOrder = loadedData.allCellBarcodes ||
      Array.from({ length: peakMatrix.numberOfColumns() }, (_, i) => `cell_${i}`);
    return { peakMatrix, peakNames, fullBarcodeOrder };
  }
  // Fallback: load peak matrix on-the-fly from H5 blob (same approach as scATAC 10X ATAC load)
  // scATAC uses setOptions({ featureTypeRnaName: 'Peaks' }) so the reader loads only Peaks rows
  // and maps them to the first modality key "RNA" (the mapping key, not the file's feature_type name).
  const h5Blob = loadedData.h5Blob;
  if (!h5Blob) {
    console.warn('Multiome: no ATAC peak matrix and no H5 blob available');
    return null;
  }
  try {
    const atacDataset = new bakana.TenxHdf5Dataset(h5Blob);
    atacDataset.setOptions({ featureTypeRnaName: 'Peaks' });
    const atacLoaded = await atacDataset.load({ cache: true });
    const atacMultiMatrix = atacLoaded.matrix;
    if (!atacMultiMatrix) {
      console.warn('Multiome: ATAC load did not return a matrix');
      return null;
    }
    const rawModalityKeys = typeof atacMultiMatrix.available === 'function'
      ? atacMultiMatrix.available()
      : Object.keys(atacMultiMatrix || {});
    const atacModalityKeys = Array.isArray(rawModalityKeys) ? rawModalityKeys : (rawModalityKeys ? Object.keys(rawModalityKeys) : []);
    // With featureTypeRnaName: 'Peaks', the reader maps "Peaks" feature_type to modality key "RNA"
    // (same as scATAC). So the (only) modality is the peak matrix; use first key.
    const atacPeaksKey = atacModalityKeys.find(k => /peaks?|atac/i.test(k)) || atacModalityKeys[0];
    if (!atacPeaksKey) {
      console.warn('Multiome: no Peaks modality found in H5, keys:', atacModalityKeys);
      return null;
    }
    const peakMatrix = typeof atacMultiMatrix.get === 'function'
      ? atacMultiMatrix.get(atacPeaksKey)
      : atacMultiMatrix[atacPeaksKey];
    if (!peakMatrix) {
      console.warn('Multiome: could not get peak matrix for', atacPeaksKey);
      return null;
    }
    const rawPeakNames = atacLoaded.primary_ids?.[atacPeaksKey];
    const peakNames = rawPeakNames
      ? (Array.isArray(rawPeakNames) ? rawPeakNames : Array.from(rawPeakNames))
      : [];
    // Get barcodes from the loaded data (ensure we never assign null so .length is safe)
    let fullBarcodeOrder = [];
    if (atacLoaded.cells) {
      try {
        if (typeof atacLoaded.cells.rowNames === 'function') {
          const rowNames = atacLoaded.cells.rowNames();
          fullBarcodeOrder = rowNames == null ? [] : (Array.isArray(rowNames) ? rowNames : Array.from(rowNames));
        } else if (atacLoaded.cells.column && typeof atacLoaded.cells.column === 'function') {
          const col = atacLoaded.cells.column(0);
          fullBarcodeOrder = col ? Array.from(col) : [];
        }
      } catch (e) {
        console.warn('Multiome: could not get barcodes from ATAC load:', e.message);
      }
    }
    if (!Array.isArray(fullBarcodeOrder) || !fullBarcodeOrder.length || fullBarcodeOrder.length !== peakMatrix.numberOfColumns()) {
      fullBarcodeOrder = loadedData.allCellBarcodes ||
        Array.from({ length: peakMatrix.numberOfColumns() }, (_, i) => `cell_${i}`);
    }
    // Cache for subsequent calls
    loadedData.atacPeakMatrix = peakMatrix;
    loadedData.atacPeakNames = peakNames;
    loadedData.atacDataset = atacDataset;
    if (!loadedData.allCellBarcodes) {
      loadedData.allCellBarcodes = Array.isArray(fullBarcodeOrder) ? fullBarcodeOrder : Array.from(fullBarcodeOrder);
    }
    return { peakMatrix, peakNames, fullBarcodeOrder };
  } catch (e) {
    console.warn('Multiome: on-the-fly peak matrix load failed:', e.message);
    return null;
  }
}

/** Get all peaks in a genomic region from peakAnnotation and map to row indices. */
function getPeaksInRegion(peakAnnotation, peakNamesOrRowNames, chrom, regionStart, regionEnd) {
  const peakIdRegex = /^chr\w+[:_]\d+[-_]\d+$/i;
  const nameToIndex = new Map();
  if (Array.isArray(peakNamesOrRowNames)) {
    for (let i = 0; i < peakNamesOrRowNames.length; i++) {
      const raw = peakNamesOrRowNames[i];
      const n = String(raw).toLowerCase();
      if (!nameToIndex.has(n)) nameToIndex.set(n, i);
      const withUnderscores = String(raw).replace(/:/g, '_').replace(/-/g, '_').toLowerCase();
      const withColonDash = String(raw).replace(/^chr(\w+)_(\d+)_(\d+)$/i, 'chr$1:$2-$3').toLowerCase();
      if (peakIdRegex.test(raw)) {
        if (!nameToIndex.has(withUnderscores)) nameToIndex.set(withUnderscores, i);
        if (!nameToIndex.has(withColonDash)) nameToIndex.set(withColonDash, i);
      }
      // Peaks.bed uses chr-start-end; annotation lookups use chr:start-end or chr_start_end
      const hyphenToColon = String(raw).replace(/^chr(\w+)-(\d+)-(\d+)$/i, 'chr$1:$2-$3').toLowerCase();
      if (hyphenToColon !== n && !nameToIndex.has(hyphenToColon)) nameToIndex.set(hyphenToColon, i);
    }
  }
  const peakRows = [];
  const peaksInRegion = [];
  for (let k = 0; k < peakAnnotation.length; k++) {
    const c = String(peakAnnotation[k].chrom || '').toLowerCase();
    const chromNorm = String(chrom || '').toLowerCase();
    if (c !== chromNorm) continue;
    const start = Number(peakAnnotation[k].start) || 0;
    const end = Number(peakAnnotation[k].end) || 0;
    if (end < regionStart || start > regionEnd) continue;
    const pname = peakAnnotation[k].peakName;
    const pnameId = `${peakAnnotation[k].chrom}:${start}-${end}`;
    peaksInRegion.push({ chrom: peakAnnotation[k].chrom, start, end, peakName: pname || pnameId });
    let idx = nameToIndex.get((pname || '').toLowerCase()) ?? nameToIndex.get(pnameId.toLowerCase());
    if (idx === undefined && pname) idx = nameToIndex.get(pname.replace(/:/g, '_').replace(/-/g, '_').toLowerCase());
    if (idx === undefined) idx = nameToIndex.get(pnameId.replace(/:/g, '_').replace(/-/g, '_').toLowerCase());
    if (idx !== undefined) peakRows.push({ rowIndex: idx, start, end });
  }
  peakRows.sort((a, b) => a.start - b.start);
  return { peakRows, peaksInRegion };
}

/** Find a peak by ID (chr:start-end or chr_start_end) in the peakNames array. Returns index or -1. */
function findPeakIndex(peakId, peakNames) {
  const normalized = String(peakId).toLowerCase();
  const altUnderscore = normalized.replace(/:/g, '_').replace(/-/g, '_');
  for (let i = 0; i < peakNames.length; i++) {
    const name = String(peakNames[i]).toLowerCase();
    if (name === normalized) return i;
    const nameAlt = name.replace(/:/g, '_').replace(/-/g, '_');
    if (nameAlt === altUnderscore) return i;
  }
  return -1;
}

/** Preferred header names for the gene column in peak annotation (first match wins). */
const PEAK_ANNO_GENE_HEADERS = ['gene', 'gene_name', 'symbol', 'gene_symbol', 'Gene', 'Gene_Symbol', 'name'];

/**
 * Minimal gene TSS references for TSS-based gene activity when peak annotation has no gene column.
 * Signac-style: link peaks to genes by distance to transcription start site.
 * Genome is chosen from loadedData.info.genome (e.g. from summary.csv or dataset metadata).
 */
const GENE_TSS_HG38 = {
  slc12a1: { chrom: 'chr15', tss: 48206301 },
  cd4: { chrom: 'chr12', tss: 6819476 },
  cd8a: { chrom: 'chr2', tss: 86772426 },
  ms4a1: { chrom: 'chr11', tss: 60233214 },
  cd3d: { chrom: 'chr11', tss: 118176628 },
  cd3e: { chrom: 'chr11', tss: 118185593 },
  foxp3: { chrom: 'chrX', tss: 49217719 },
  nphs2: { chrom: 'chr1', tss: 179550503 },
  gapdh: { chrom: 'chr12', tss: 6645787 },
  actb: { chrom: 'chr7', tss: 5566777 },
  cd79a: { chrom: 'chr19', tss: 41896334 },
  cd14: { chrom: 'chr5', tss: 140631760 },
  cd68: { chrom: 'chr17', tss: 7571726 },
  lyz: { chrom: 'chr12', tss: 69338521 },
  cd74: { chrom: 'chr5', tss: 150401639 },
  'hla-dra': { chrom: 'chr6', tss: 32407521 },
  ccl5: { chrom: 'chr17', tss: 36083107 },
  nkg7: { chrom: 'chr19', tss: 46002017 },
  gnly: { chrom: 'chr2', tss: 85899420 },
  il7r: { chrom: 'chr5', tss: 35876389 },
  s100a8: { chrom: 'chr1', tss: 153390623 },
  s100a9: { chrom: 'chr1', tss: 153389993 },
  ppbp: { chrom: 'chr4', tss: 73982189 },
  pfn1: { chrom: 'chr17', tss: 5524985 },
  cd34: { chrom: 'chr1', tss: 207602800 },
  kit: { chrom: 'chr4', tss: 54657819 },
  epor: { chrom: 'chr19', tss: 11346739 },
  hba1: { chrom: 'chr16', tss: 176680 },
  hbb: { chrom: 'chr11', tss: 5342839 },
};

/** Mouse mm10 TSS (same gene symbols, lowercase). Used when genome is mm10/mm39. */
const GENE_TSS_MM10 = {
  slc12a1: { chrom: 'chr2', tss: 124994430 },
  cd4: { chrom: 'chr6', tss: 125068656 },
  cd8a: { chrom: 'chr6', tss: 71130367 },
  ms4a1: { chrom: 'chr19', tss: 112423745 },
  cd3d: { chrom: 'chr9', tss: 44900417 },
  cd3e: { chrom: 'chr9', tss: 44900717 },
  foxp3: { chrom: 'chrX', tss: 7481064 },
  nphs2: { chrom: 'chr1', tss: 136259483 },
  gapdh: { chrom: 'chr6', tss: 125138413 },
  actb: { chrom: 'chr5', tss: 142903019 },
  cd79a: { chrom: 'chr7', tss: 24602612 },
  cd14: { chrom: 'chr18', tss: 36379506 },
  cd68: { chrom: 'chr11', tss: 69677569 },
  lyz: { chrom: 'chr10', tss: 116284257 },
  cd74: { chrom: 'chr18', tss: 60880889 },
  ccl5: { chrom: 'chr11', tss: 83299414 },
  nkg7: { chrom: 'chr7', tss: 126753161 },
  gnly: { chrom: 'chr2', tss: 85483033 },
  il7r: { chrom: 'chr15', tss: 91280019 },
  s100a8: { chrom: 'chr3', tss: 90638056 },
  s100a9: { chrom: 'chr3', tss: 90638190 },
  ppbp: { chrom: 'chr5', tss: 90907859 },
  pfn1: { chrom: 'chr11', tss: 70312394 },
  cd34: { chrom: 'chr1', tss: 194618285 },
  kit: { chrom: 'chr5', tss: 75623489 },
  epor: { chrom: 'chr9', tss: 137312270 },
  hba1: { chrom: 'chr11', tss: 32193396 },
  hbb: { chrom: 'chr7', tss: 103970980 },
};

/** Default distance (bp) from TSS to link peaks to gene (Signac default is 500kb). */
const GENE_ACTIVITY_TSS_DISTANCE_BP = 500000;

/**
 * Resolve which TSS reference to use from genome build (e.g. from summary.csv or dataset info).
 * Returns GENE_TSS_MM10 for mouse (mm10, mm39), else GENE_TSS_HG38 for human.
 */
function getTSSReferenceForGenome(genome) {
  const g = (genome && String(genome).toLowerCase()) || '';
  if (g.includes('mm') || g.includes('mouse') || g === 'grcm38' || g === 'grcm39') return GENE_TSS_MM10;
  return GENE_TSS_HG38;
}

/**
 * Get peaks linked to a gene by distance to TSS (fallback when peak annotation has no gene column).
 * Uses genome from loadedData.info.genome to pick human (hg38) or mouse (mm10) TSS reference.
 * Returns { peakIndices, peaksOnGene } or { peakIndices: [], peaksOnGene: [] } if gene not in reference or no peaks in range.
 */
function getPeaksForGeneByTSS(geneName, peakAnnotation, peakNamesOrRowNames, distanceBp = GENE_ACTIVITY_TSS_DISTANCE_BP, genome = null) {
  const geneLower = (geneName && String(geneName).trim()).toLowerCase() || '';
  const tssRef = getTSSReferenceForGenome(genome);
  const ref = tssRef[geneLower];
  if (!ref) return { peakIndices: [], peaksOnGene: [] };

  const { chrom: refChrom, tss } = ref;
  const refChromNorm = refChrom.toLowerCase().replace(/^chr/, '') || refChrom;
  const windowStart = Math.max(0, tss - distanceBp);
  const windowEnd = tss + distanceBp;

  const peakIdRegex = /^chr\w+[:_]\d+[-_]\d+$/i;
  const nameToIndex = new Map();
  if (Array.isArray(peakNamesOrRowNames)) {
    for (let i = 0; i < peakNamesOrRowNames.length; i++) {
      const raw = peakNamesOrRowNames[i];
      const n = String(raw).toLowerCase();
      if (!nameToIndex.has(n)) nameToIndex.set(n, i);
      const withUnderscores = String(raw).replace(/:/g, '_').replace(/-/g, '_').toLowerCase();
      const withColonDash = String(raw).replace(/^chr(\w+)_(\d+)_(\d+)$/i, 'chr$1:$2-$3').toLowerCase();
      if (peakIdRegex.test(raw)) {
        if (!nameToIndex.has(withUnderscores)) nameToIndex.set(withUnderscores, i);
        if (!nameToIndex.has(withColonDash)) nameToIndex.set(withColonDash, i);
      }
      const hyphenToColon = String(raw).replace(/^chr(\w+)-(\d+)-(\d+)$/i, 'chr$1:$2-$3').toLowerCase();
      if (hyphenToColon !== n && !nameToIndex.has(hyphenToColon)) nameToIndex.set(hyphenToColon, i);
    }
  }

  const indexSet = new Set();
  const peaksOnGene = [];

  for (let k = 0; k < peakAnnotation.length; k++) {
    const c = String(peakAnnotation[k].chrom || '').trim();
    const peakChromNorm = c.toLowerCase().replace(/^chr/, '') || c;
    if (peakChromNorm !== refChromNorm && c.toLowerCase() !== refChrom.toLowerCase()) continue;
    const start = Number(peakAnnotation[k].start) || 0;
    const end = Number(peakAnnotation[k].end) || 0;
    const peakMid = (start + end) / 2;
    if (peakMid < windowStart || peakMid > windowEnd) continue;
    const pname = peakAnnotation[k].peakName;
    const pnameId = `${peakAnnotation[k].chrom}:${start}-${end}`;
    const pnameUnderscore = `${peakAnnotation[k].chrom}_${start}_${end}`;
    const pnameDash = `${peakAnnotation[k].chrom}-${start}-${end}`;
    peaksOnGene.push({ chrom: peakAnnotation[k].chrom, start, end, peakName: pname || pnameId });
    let idx = nameToIndex.get((pname || '').toLowerCase()) ?? nameToIndex.get(pnameId.toLowerCase());
    if (idx === undefined) idx = nameToIndex.get(pnameUnderscore.toLowerCase());
    if (idx === undefined) idx = nameToIndex.get(pnameDash.toLowerCase());
    if (idx === undefined && pname) idx = nameToIndex.get(pname.replace(/:/g, '_').replace(/-/g, '_').toLowerCase());
    if (idx === undefined) idx = nameToIndex.get(pnameId.replace(/:/g, '_').replace(/-/g, '_').toLowerCase());
    if (idx === undefined) idx = nameToIndex.get(pnameId.replace(/:/g, '-').toLowerCase());
    if (idx !== undefined) indexSet.add(idx);
  }

  return { peakIndices: Array.from(indexSet), peaksOnGene };
}

function findPeakAnnotationGeneColumnIndex(headers) {
  if (!Array.isArray(headers)) return -1;
  const lower = headers.map((h) => (h && String(h).trim()).toLowerCase());
  for (const want of PEAK_ANNO_GENE_HEADERS) {
    const i = lower.indexOf(want.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

/** Get peaks linked to a gene from peakAnnotation (for ATAC). Returns { peakIndices, peaksOnGene }. */
function getPeaksForGene(geneName, peakAnnotation, peakNamesOrRowNames) {
  const geneLower = (geneName && String(geneName).trim()).toLowerCase() || '';
  const indexSet = new Set();
  const peaksOnGene = [];
  const peakIdRegex = /^chr\w+[:_]\d+[-_]\d+$/i;
  const nameToIndex = new Map();
  if (Array.isArray(peakNamesOrRowNames)) {
    for (let i = 0; i < peakNamesOrRowNames.length; i++) {
      const raw = peakNamesOrRowNames[i];
      const n = String(raw).toLowerCase();
      if (!nameToIndex.has(n)) nameToIndex.set(n, i);
      const withUnderscores = String(raw).replace(/:/g, '_').replace(/-/g, '_').toLowerCase();
      const withColonDash = String(raw).replace(/^chr(\w+)_(\d+)_(\d+)$/i, 'chr$1:$2-$3').toLowerCase();
      if (peakIdRegex.test(raw)) {
        if (!nameToIndex.has(withUnderscores)) nameToIndex.set(withUnderscores, i);
        if (!nameToIndex.has(withColonDash)) nameToIndex.set(withColonDash, i);
      }
      // Peaks.bed uses chr-start-end; annotation uses chr:start-end or chr_start_end for lookups
      const hyphenToColon = String(raw).replace(/^chr(\w+)-(\d+)-(\d+)$/i, 'chr$1:$2-$3').toLowerCase();
      if (hyphenToColon !== n && !nameToIndex.has(hyphenToColon)) nameToIndex.set(hyphenToColon, i);
    }
  }
  for (let k = 0; k < peakAnnotation.length; k++) {
    const rawGene = (peakAnnotation[k].gene || '').trim();
    const geneList = rawGene.split(/[\s,;|]+/).map((s) => s.toLowerCase().trim()).filter(Boolean);
    const matches = geneList.length === 0 ? rawGene.toLowerCase() === geneLower : geneList.includes(geneLower);
    if (!matches) continue;
    const chrom = peakAnnotation[k].chrom;
    const start = Number(peakAnnotation[k].start) || 0;
    const end = Number(peakAnnotation[k].end) || 0;
    const pname = peakAnnotation[k].peakName;
    const pnameId = `${chrom}:${start}-${end}`;
    const pnameUnderscore = `${chrom}_${start}_${end}`;
    peaksOnGene.push({ chrom, start, end, peakName: pname || pnameId });
    let idx = nameToIndex.get((pname || '').toLowerCase()) ?? nameToIndex.get(pnameId.toLowerCase());
    if (idx === undefined) idx = nameToIndex.get(pnameUnderscore.toLowerCase());
    if (idx === undefined && pname) idx = nameToIndex.get(pname.replace(/:/g, '_').replace(/-/g, '_').toLowerCase());
    if (idx === undefined) idx = nameToIndex.get(pnameId.replace(/:/g, '_').replace(/-/g, '_').toLowerCase());
    if (idx !== undefined) indexSet.add(idx);
  }
  return { peakIndices: Array.from(indexSet), peaksOnGene };
}

/** Normalize coverage signal by global max so all tracks share scale [0,1]; aligns Peak View with UMAP (high-activity clusters stand out). */
function normalizeCoverageByGlobalMax(coverageByCluster) {
  if (!coverageByCluster || coverageByCluster.length === 0) return;
  let globalMax = 0;
  for (const c of coverageByCluster) {
    for (const s of c.signal || []) {
      const v = Number(s.value);
      if (!Number.isNaN(v) && v > globalMax) globalMax = v;
    }
  }
  if (globalMax <= 0) return;
  for (const c of coverageByCluster) {
    for (const s of c.signal || []) {
      s.value = Number(s.value) / globalMax;
    }
  }
}

/** Compute per-cluster normalized signal over peaks in region (Signac CoveragePlot-style). Returns top N clusters by cell count. */
function computeCoverageByCluster(normMatrix, clusters, peakRows) {
  const nCells = normMatrix.numberOfColumns();
  const uniqueClusters = Array.from(new Set(clusters)).filter((c) => c !== null && c !== undefined);
  uniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
  const clusterToCells = new Map();
  for (let i = 0; i < nCells; i++) {
    const c = clusters[i];
    if (c === null || c === undefined) continue;
    if (!clusterToCells.has(c)) clusterToCells.set(c, []);
    clusterToCells.get(c).push(i);
  }
  const coverageByCluster = [];
  for (const clusterId of uniqueClusters) {
    const cellIndices = clusterToCells.get(clusterId) || [];
    const signal = [];
    for (const p of peakRows) {
      let sum = 0;
      const row = normMatrix.row(p.rowIndex);
      for (let j = 0; j < cellIndices.length; j++) {
        const val = row && row[cellIndices[j]] != null ? row[cellIndices[j]] : 0;
        sum += val;
      }
      const value = cellIndices.length > 0 ? sum / cellIndices.length : 0;
      signal.push({ start: p.start, end: p.end, value });
    }
    coverageByCluster.push({
      clusterId,
      label: String(clusterId),
      cellCount: cellIndices.length,
      signal,
    });
  }
  coverageByCluster.sort((a, b) => (b.cellCount || 0) - (a.cellCount || 0));
  return coverageByCluster.slice(0, ATAC_MAX_CLUSTERS_COVERAGE);
}

/** Deep-copy coverageByCluster for cache (array of { clusterId, label, cellCount, signal }). */
function copyCoverageByCluster(coverageByCluster) {
  if (!coverageByCluster || !coverageByCluster.length) return undefined;
  return coverageByCluster.map((c) => ({
    ...c,
    signal: (c.signal || []).map((s) => ({ ...s })),
  }));
}

/**
 * Plot gene activity (peak-derived score) for ATAC: sum peak counts per cell for peaks linked to the gene.
 * Also returns peaksOnGene for the Peak View track.
 */
async function plotAtacGeneActivity(params) {
  const { gene, colorMap } = params;
  const showPeakView = params.showPeakView === true;
  if (!loadedData || !loadedData.atacPeakMatrix || !loadedData.peakAnnotation) {
    throw new Error('ATAC data or peak matrix not available for gene activity.');
  }
  const geneName = (gene && String(gene).trim()) || 'gene';
  const cacheKey = geneName.toLowerCase().trim();
  const cached = scAtacGeneActivityCache.get(cacheKey);
  if (cached) {
    const cachedData = {
      ...cached,
      expression: [...cached.expression],
      coordinates: cached.coordinates ? cached.coordinates.map((c) => [...c]) : undefined,
    };
    if (!showPeakView) {
      cachedData.coverageByCluster = undefined;
      cachedData.viewCoverageByCluster = undefined;
      cachedData.region = undefined;
      cachedData.peaksOnGene = undefined;
    }
    self.postMessage({ type: 'ANALYSIS_COMPLETE', data: cachedData });
    return;
  }
  const peakMatrix = loadedData.atacPeakMatrix;
  const peakNames = loadedData.atacPeakNames || loadedData.peakNames || [];
  const peakAnnotation = loadedData.peakAnnotation;
  const nCells = peakMatrix.numberOfColumns();

  let { peakIndices, peaksOnGene } = getPeaksForGene(geneName, peakAnnotation, peakNames);
  const usedTSS = peakIndices.length === 0;
  if (peakIndices.length === 0) {
    const genome = loadedData.info?.genome;
    const tssResult = getPeaksForGeneByTSS(geneName, peakAnnotation, peakNames, undefined, genome);
    if (tssResult.peakIndices.length > 0) {
      peakIndices = tssResult.peakIndices;
      peaksOnGene = tssResult.peaksOnGene;
      console.log('scATAC: gene activity for', geneName, 'via TSS-based linking (' + peakIndices.length + ' peaks within 500kb of TSS, genome:', genome || 'default');
    } else {
      const hint = peakAnnotation.length === 0 || peakAnnotation.every((p) => !(p.gene && String(p.gene).trim()))
        ? ' Ensure your peak annotation file has a gene column (e.g. "gene", "gene_name", or "symbol"), or try a gene in the TSS reference (e.g. SLC12A1, CD4, MS4A1).'
        : '';
      throw new Error(`No peaks found for gene "${geneName}". Try another gene or check spelling.${hint}`);
    }
  }

  // Diagnostic logging for debugging gene activity
  const isIntegration = loadedData?.info?.modality === 'atac-integration';
  console.log(`scATAC gene activity [${geneName}]: modality=${loadedData?.info?.modality}, nCells=${nCells}, ` +
    `peakIndices=${peakIndices.length}, usedTSS=${usedTSS}, ` +
    `totalAnnotations=${peakAnnotation.length}, totalPeakNames=${peakNames.length}`);
  if (isIntegration && peakIndices.length > 0) {
    // Log matched peak details for debugging
    const samplePeaks = peakIndices.slice(0, 5).map(idx => `${peakNames[idx]}(gene=${peakAnnotation[idx]?.gene || '?'})`);
    console.log(`  Matched peaks (first 5): ${samplePeaks.join(', ')}`);
  }

  const expression = new Float32Array(nCells);
  const cscForExpr = peakMatrix.getCSC ? peakMatrix.getCSC() : null;
  if (cscForExpr) {
    // Fast path: iterate CSC non-zeros directly — avoids allocating a dense column per cell
    const peakSet = new Set(peakIndices);
    const { colPtr, rowIdx, values } = cscForExpr;

    for (let c = 0; c < nCells; c++) {
      let geneSum = 0;
      for (let p = colPtr[c]; p < colPtr[c + 1]; p++) {
        if (peakSet.has(rowIdx[p])) geneSum += values[p];
      }
      expression[c] = geneSum;
    }
  } else {
    for (let c = 0; c < nCells; c++) {
      let sum = 0;
      const col = peakMatrix.column(c);
      for (let p = 0; p < peakIndices.length; p++) sum += col[peakIndices[p]] || 0;
      expression[c] = sum;
    }
  }
  // Diagnostic: expression stats before normalization
  if (isIntegration) {
    let nNonZero = 0, exprSum = 0, exprMax = 0;
    for (let c = 0; c < nCells; c++) {
      if (expression[c] > 0) { nNonZero++; exprSum += expression[c]; }
      if (expression[c] > exprMax) exprMax = expression[c];
    }
    console.log(`  Expression stats (raw): nonzero=${nNonZero}/${nCells} (${(nNonZero/nCells*100).toFixed(1)}%), ` +
      `mean=${(exprSum/nCells).toFixed(3)}, max=${exprMax}`);
    // Per-sample breakdown
    if (loadedData.integrationViews) {
      for (const [vName, vData] of Object.entries(loadedData.integrationViews)) {
        const indices = vData.indices || [];
        let vNonZero = 0, vSum = 0, vMax = 0;
        for (const idx of indices) {
          if (expression[idx] > 0) { vNonZero++; vSum += expression[idx]; }
          if (expression[idx] > vMax) vMax = expression[idx];
        }
        console.log(`    ${vName}: nonzero=${vNonZero}/${indices.length} (${(vNonZero/indices.length*100).toFixed(1)}%), ` +
          `mean=${(vSum/indices.length).toFixed(3)}, max=${vMax}`);
      }
    }
  }

  // For integration: depth-normalize per cell so cross-sample comparison is fair,
  // then apply log1p for sharper color contrast (same principle as scRNA-seq library-size normalization).
  // Standalone single-sample ATAC uses raw counts (cells from one experiment have uniform depth),
  // but integration combines samples with potentially very different total fragment counts per cell,
  // causing the raw-count color scale to appear flat.
  if (isIntegration) {
    const colSumsForNorm = loadedData.atacColSums;
    if (Array.isArray(colSumsForNorm) && colSumsForNorm.length === nCells) {
      // Step 1: Depth-normalize per cell so cross-sample depth differences don't drive color.
      // Scale to median library size so absolute values stay interpretable.
      const depthsSorted = Float64Array.from(colSumsForNorm).sort();
      const mid = Math.floor(depthsSorted.length / 2);
      const medianDepth = depthsSorted.length % 2 === 1
        ? depthsSorted[mid]
        : (depthsSorted[mid - 1] + depthsSorted[mid]) / 2;
      const targetDepth = medianDepth > 0 ? medianDepth : 1;
      for (let c = 0; c < nCells; c++) {
        const depth = colSumsForNorm[c] > 0 ? colSumsForNorm[c] : 1;
        expression[c] = Math.log1p((expression[c] / depth) * targetDepth);
      }

      // Step 2: Background subtraction — remove the noise floor.
      // In the unified peak set, even non-expressing cells accumulate small counts
      // across many gene-linked peaks, shifting them off zero and washing out color contrast.
      // Subtract the p15 level (noise floor) and clip to 0, so background cells collapse
      // to pure blue while truly expressing cells keep their signal. This mirrors what
      // Seurat ScaleData / Signac does to create sharp FeaturePlot colors.
      const exprSorted = Float64Array.from(expression).sort();
      const noiseFloor = exprSorted[Math.floor(0.15 * exprSorted.length)];
      if (noiseFloor > 0) {
        for (let c = 0; c < nCells; c++) {
          expression[c] = Math.max(0, expression[c] - noiseFloor);
        }
      }
      console.log(`  Integration gene activity: depth-normalized + log1p + bg-subtraction applied, medianDepth=${medianDepth.toFixed(0)}, noiseFloor=${noiseFloor.toFixed(4)}`);
    }
  }

  let maxVal = 1;
  for (let c = 0; c < nCells; c++) { if (expression[c] > maxVal) maxVal = expression[c]; }

  const coordinates = currentResults.umap;
  if (!coordinates || coordinates.length !== nCells) {
    throw new Error('UMAP coordinates not available for ATAC gene activity plot.');
  }

  let coverageByCluster = null;
  let region = null;
  let viewCoverageByCluster = null;
  const clusters = currentResults.clusters;
  if (peaksOnGene.length > 0 && Array.isArray(clusters) && clusters.length === nCells) {
    const chrom = peaksOnGene[0].chrom;
    const minStart = Math.min(...peaksOnGene.map((p) => Number(p.start) || 0));
    const maxEnd = Math.max(...peaksOnGene.map((p) => Number(p.end) || 0));
    const regionStart = Math.max(0, minStart - ATAC_EXTEND_UPSTREAM);
    const regionEnd = maxEnd + ATAC_EXTEND_DOWNSTREAM;
    const { peakRows: regionPeakRows } = getPeaksInRegion(peakAnnotation, peakNames, chrom, regionStart, regionEnd);

    // atac-integration: rebuild regionPeakRows using original per-sample peak coordinates
    // instead of merged/unified coordinates, so coverage curves look like single-sample mode.
    // Each original peak is mapped to its unified matrix row by coordinate overlap.
    let effectivePeakRows = regionPeakRows;
    if (loadedData?.info?.modality === 'atac-integration' && Array.isArray(loadedData.atacSamples) && regionPeakRows.length > 0) {
      // Build lookup: for a given genomic position, find the unified peak row that contains it
      const unifiedRowsByRange = regionPeakRows.map(pr => ({
        rowIndex: pr.rowIndex,
        start: Number(pr.start) || 0,
        end: Number(pr.end) || 0,
      }));
      unifiedRowsByRange.sort((a, b) => a.start - b.start);

      // Find unified row index for an original peak by coordinate overlap
      function findUnifiedRow(oStart, oEnd) {
        for (const u of unifiedRowsByRange) {
          if (u.end <= oStart) continue;
          if (u.start >= oEnd) break;
          // Overlap found
          return u.rowIndex;
        }
        return -1;
      }

      // Collect original per-sample peaks in the region.
      // Use peakNames (peaks.bed, always present) parsed as chr-start-end coordinates.
      const origRows = [];
      const seenCoords = new Set();
      const chromNorm = String(chrom || '').toLowerCase();
      for (const sample of loadedData.atacSamples) {
        const sPeakNames = sample.peakNames || [];
        for (const pn of sPeakNames) {
          const m = String(pn).match(/^([^-]+)-(\d+)-(\d+)$/);
          if (!m) continue;
          const pChrom = m[1];
          if (pChrom.toLowerCase() !== chromNorm) continue;
          const s = parseInt(m[2]);
          const e = parseInt(m[3]);
          if (e < regionStart || s > regionEnd) continue;
          const key = `${s}-${e}`;
          if (seenCoords.has(key)) continue;
          seenCoords.add(key);
          const uRow = findUnifiedRow(s, e);
          if (uRow >= 0) {
            origRows.push({ rowIndex: uRow, start: s, end: e });
          }
        }
      }
      if (origRows.length > 0) {
        origRows.sort((a, b) => a.start - b.start);
        console.log(`scATAC integration: using ${origRows.length} original per-sample peak positions instead of ${regionPeakRows.length} unified for coverage`);
        effectivePeakRows = origRows;
      }
    }

    if (effectivePeakRows.length > 0) {
      coverageByCluster = computeCoverageByClusterRaw(peakMatrix, clusters, effectivePeakRows, loadedData.atacColSums);
      region = { chrom, start: regionStart, end: regionEnd };
      // atac-integration: compute per-sample coverage (mask cells outside each sample to null)
      // Use a global medianScale so all samples are on the same scale for comparison
      if (loadedData?.info?.modality === 'atac-integration') {
        const iViews = getAtacIntegrationViewsForPlot();
        if (iViews) {
          // Compute global median scale factor from ALL cells (same as the global coverageByCluster above)
          const hasCS = Array.isArray(loadedData.atacColSums) && loadedData.atacColSums.length === nCells;
          let globalMedianScale = null;
          if (hasCS) {
            const uniqueC = Array.from(new Set(clusters)).filter(c => c !== null && c !== undefined);
            const gsFactors = [];
            for (const cId of uniqueC) {
              let depthSum = 0, cnt = 0;
              for (let i = 0; i < nCells; i++) {
                if (clusters[i] === cId) { depthSum += loadedData.atacColSums[i] || 0; cnt++; }
              }
              if (cnt > 0) gsFactors.push((depthSum / cnt) * cnt);
            }
            gsFactors.sort((a, b) => a - b);
            if (gsFactors.length > 0) {
              globalMedianScale = gsFactors.length % 2 === 1
                ? gsFactors[Math.floor(gsFactors.length / 2)]
                : (gsFactors[gsFactors.length / 2 - 1] + gsFactors[gsFactors.length / 2]) / 2;
              if (globalMedianScale <= 0) globalMedianScale = 1;
            }
          }
          viewCoverageByCluster = {};
          // Full list of all cluster IDs in the dataset (no cap) for consistent order and empty tracks
          const allClusterIds = Array.from(new Set(clusters)).filter((c) => c !== null && c !== undefined);
          allClusterIds.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
          const maxClustersUncap = Math.max(100000, allClusterIds.length);
          for (const vName of iViews.datasetNames) {
            const vIndices = iViews.integrationViews[vName]?.indices;
            if (!Array.isArray(vIndices) || vIndices.length === 0) continue;
            const maskedClusters = new Array(nCells).fill(null);
            for (const idx of vIndices) maskedClusters[idx] = clusters[idx];
            viewCoverageByCluster[vName] = computeCoverageByClusterRaw(
              peakMatrix, maskedClusters, effectivePeakRows, loadedData.atacColSums, globalMedianScale, maxClustersUncap
            );
          }
          // Ensure every view has the same set of clusters (all clusters); fill missing with empty tracks
          for (const vName of Object.keys(viewCoverageByCluster)) {
            const cov = viewCoverageByCluster[vName];
            if (!Array.isArray(cov)) continue;
            const byId = new Map();
            for (const c of cov) byId.set(c.clusterId, c);
            const filled = [];
            for (const cid of allClusterIds) {
              if (byId.has(cid)) {
                filled.push(byId.get(cid));
              } else {
                const emptySignal = effectivePeakRows.map((p) => ({ start: p.start, end: p.end, value: 0 }));
                filled.push({ clusterId: cid, label: String(cid), cellCount: 0, signal: emptySignal });
              }
            }
            viewCoverageByCluster[vName] = filled;
          }
        }
      }
    }
  }

  // atac-integration: replace peaksOnGene with original per-sample peaks (un-merged)
  // so the PEAKS track matches what single-sample mode shows.
  // The unified (merged) peaks were used above for region/coverage computation which is correct,
  // but for display we want the original discrete peaks from each sample.
  if (loadedData?.info?.modality === 'atac-integration' && Array.isArray(loadedData.atacSamples) && peaksOnGene.length > 0) {
    const origPeaks = [];
    const seen = new Set();
    const genome = loadedData.info?.genome;
    for (const sample of loadedData.atacSamples) {
      const sAnno = sample.peakAnnotation || [];
      const sPeakNames = sample.peakNames || [];
      // Try gene-based lookup first, then TSS-based fallback (same logic as main path)
      let sResult = getPeaksForGene(geneName, sAnno, sPeakNames);
      if (sResult.peaksOnGene.length === 0) {
        sResult = getPeaksForGeneByTSS(geneName, sAnno, sPeakNames, undefined, genome);
      }
      for (const p of sResult.peaksOnGene) {
        const key = `${p.chrom}:${p.start}-${p.end}`;
        if (!seen.has(key)) {
          seen.add(key);
          origPeaks.push(p);
        }
      }
    }
    if (origPeaks.length > 0) {
      console.log(`scATAC integration: replaced ${peaksOnGene.length} unified peaks with ${origPeaks.length} original per-sample peaks for display`);
      peaksOnGene = origPeaks;
    }
  }

  // Get filtered/ordered barcodes that match the clusters array
  // For legacy path, try to apply filter mask if available
  let cellBarcodes = null;
  if (loadedData.cellBarcodes && Array.isArray(loadedData.cellBarcodes)) {
    const state = loadedData.state;
    if (state && state.cell_filtering && typeof state.cell_filtering.fetchKeep === 'function') {
      try {
        const keepResult = state.cell_filtering.fetchKeep();
        let keptIndices = null;
        if (keepResult && typeof keepResult[Symbol.iterator] === 'function') {
          keptIndices = [];
          let idx = 0;
          for (const kept of keepResult) {
            if (kept) keptIndices.push(idx);
            idx++;
          }
        } else if (keepResult && typeof keepResult.length === 'number') {
          keptIndices = [];
          for (let i = 0; i < keepResult.length; i++) {
            if (keepResult[i]) keptIndices.push(i);
          }
        }
        if (keptIndices && keptIndices.length > 0 && keptIndices.length === clusters?.length) {
          cellBarcodes = keptIndices.map(idx => loadedData.cellBarcodes[idx]);
          console.log('Using filtered barcodes (legacy, keep mask):', cellBarcodes.length);
        }
      } catch (e) {
        console.warn('Failed to get keep mask for barcode filtering (legacy):', e.message);
      }
    }
    // Fallback: use original barcodes if lengths match
    if (!cellBarcodes && loadedData.cellBarcodes.length === nCells) {
      cellBarcodes = loadedData.cellBarcodes;
      console.log('Using original barcodes (legacy, no filtering):', cellBarcodes.length);
    }
  }

  // Percentile-based range for color scale.
  // For integration: after background subtraction most cells are 0, so percentiles over the full
  // array are dominated by zeros. Use only the non-zero cells to set the upper bound — this
  // ensures that moderate expressors map to the middle of the color scale (white) rather than
  // appearing as barely-visible pale blue. Min is always 0 (background-subtracted baseline).
  // For single-sample: use 2nd-98th percentile of full array as before.
  let expressionRange = null;
  if (expression.length > 0) {
    if (isIntegration) {
      const nonZero = [];
      for (let c = 0; c < nCells; c++) { if (expression[c] > 0) nonZero.push(expression[c]); }
      if (nonZero.length > 0) {
        nonZero.sort((a, b) => a - b);
        // Use p95 of non-zero cells as max — the top 5% of expressors saturate at red,
        // and cells with moderate accessibility get a full color spread.
        const p95nz = nonZero[Math.floor(0.95 * nonZero.length)];
        const rangeMax = p95nz > 0 ? p95nz : nonZero[nonZero.length - 1];
        if (Number.isFinite(rangeMax) && rangeMax > 0) {
          expressionRange = [0, rangeMax];
        }
      }
      console.log(`  Integration color range: nonZeroCells=${nonZero.length}/${nCells} (${(nonZero.length/nCells*100).toFixed(1)}%), rangeMax=${expressionRange ? expressionRange[1].toFixed(4) : 'null'}`);
    } else {
      const sorted = Array.from(expression).sort((a, b) => a - b);
      const p02 = sorted[Math.floor(0.02 * sorted.length)];
      const p98 = sorted[Math.floor(0.98 * sorted.length)];
      const exprMax = sorted[sorted.length - 1];
      const rangeMax = (p98 > p02) ? p98 : exprMax;
      if (Number.isFinite(rangeMax) && rangeMax > 0) {
        expressionRange = [p02, rangeMax];
      }
    }
  }

  console.log('ATAC gene activity response (legacy):', {
    geneName,
    nCells,
    cellBarcodesLength: cellBarcodes?.length,
    clustersLength: clusters?.length,
    hasRegion: !!region,
    barcodesMatchClusters: cellBarcodes?.length === clusters?.length,
  });

  // Compute per-cluster mean depth for Signac-style fragment normalization
  let clusterMeanDepths = undefined;
  const colSums = loadedData.atacColSums;
  if (Array.isArray(colSums) && colSums.length === nCells && Array.isArray(clusters) && clusters.length === nCells) {
    const depthMap = {};
    const countMap = {};
    for (let i = 0; i < nCells; i++) {
      const c = clusters[i];
      if (c === null || c === undefined) continue;
      depthMap[c] = (depthMap[c] || 0) + (colSums[i] || 0);
      countMap[c] = (countMap[c] || 0) + 1;
    }
    clusterMeanDepths = {};
    for (const c of Object.keys(depthMap)) {
      clusterMeanDepths[c] = countMap[c] > 0 ? depthMap[c] / countMap[c] : 0;
    }
  }

  const payload = {
    type: 'gene_expression',
    geneName,
    expression: Array.from(expression),
    expressionRange: expressionRange || undefined,
    coordinates,
    colorMap: colorMap || null,
    peaksOnGene: peaksOnGene.length ? peaksOnGene : undefined,
    coverageByCluster: coverageByCluster && coverageByCluster.length ? coverageByCluster : undefined,
    region: region || undefined,
    genome: loadedData.info?.genome || undefined,
    cellBarcodes: cellBarcodes || undefined,
    clusters: clusters || undefined,
    clusterMeanDepths: clusterMeanDepths || undefined,
    isAtac: true,
    viewCoverageByCluster: viewCoverageByCluster || undefined,
    // Include integration views so frontend can query per-sample fragments
    integrationViews: (loadedData?.info?.modality === 'atac-integration' && loadedData.integrationViews)
      ? loadedData.integrationViews : undefined,
    datasetNames: (loadedData?.info?.modality === 'atac-integration' && loadedData.info?.datasetNames)
      ? loadedData.info.datasetNames : undefined,
  };
  scAtacGeneActivityCache.set(cacheKey, {
    ...payload,
    expression: [...payload.expression],
    expressionRange: payload.expressionRange ? [...payload.expressionRange] : undefined,
    coordinates: payload.coordinates ? payload.coordinates.map((c) => [...c]) : undefined,
    peaksOnGene: payload.peaksOnGene ? payload.peaksOnGene.map((p) => ({ ...p })) : undefined,
    coverageByCluster: copyCoverageByCluster(payload.coverageByCluster),
    viewCoverageByCluster: payload.viewCoverageByCluster
      ? Object.fromEntries(Object.entries(payload.viewCoverageByCluster).map(([k, v]) => [k, copyCoverageByCluster(v)]))
      : undefined,
    region: payload.region ? { ...payload.region } : undefined,
    cellBarcodes: payload.cellBarcodes ? [...payload.cellBarcodes] : undefined,
    clusters: payload.clusters ? [...payload.clusters] : undefined,
  });
  // Strip coverage fields when user only asked for gene activity UMAP (not coverage plot)
  const responsePayload = showPeakView ? payload : {
    ...payload,
    coverageByCluster: undefined,
    viewCoverageByCluster: undefined,
    region: undefined,
    peaksOnGene: undefined,
  };
  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: responsePayload,
  });
}

/**
 * Signac-style per-cluster coverage: raw sum per peak, normalized by
 * group_scale_factor = mean_depth * n_cells, rescaled to median(group_scale_factors).
 * Falls back to simple mean-per-cell when colSums is unavailable.
 */
function computeCoverageByClusterRaw(peakMatrix, clusters, peakRows, colSums, globalMedianScale, maxClustersCap) {
  const nCells = peakMatrix.numberOfColumns();
  const uniqueClusters = Array.from(new Set(clusters)).filter((c) => c !== null && c !== undefined);
  uniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
  const clusterToCells = new Map();
  for (let i = 0; i < nCells; i++) {
    const c = clusters[i];
    if (c === null || c === undefined) continue;
    if (!clusterToCells.has(c)) clusterToCells.set(c, []);
    clusterToCells.get(c).push(i);
  }

  // Signac-style: compute group scale factors = mean_depth * n_cells per cluster
  const hasColSums = Array.isArray(colSums) && colSums.length === nCells;
  const groupScaleFactors = new Map();
  if (hasColSums) {
    for (const clusterId of uniqueClusters) {
      const cellIndices = clusterToCells.get(clusterId) || [];
      if (cellIndices.length === 0) { groupScaleFactors.set(clusterId, 1); continue; }
      let depthSum = 0;
      for (let j = 0; j < cellIndices.length; j++) depthSum += colSums[cellIndices[j]] || 0;
      const meanDepth = depthSum / cellIndices.length;
      groupScaleFactors.set(clusterId, meanDepth * cellIndices.length);
    }
    // Global scale factor = median of group scale factors
    // If globalMedianScale is provided (e.g. for cross-sample comparability), use it instead
    const gsVals = Array.from(groupScaleFactors.values()).sort((a, b) => a - b);
    var medianScale;
    if (globalMedianScale != null && globalMedianScale > 0) {
      medianScale = globalMedianScale;
    } else {
      medianScale = gsVals.length % 2 === 1
        ? gsVals[Math.floor(gsVals.length / 2)]
        : (gsVals[gsVals.length / 2 - 1] + gsVals[gsVals.length / 2]) / 2;
      if (medianScale <= 0) medianScale = 1;
    }
  }

  // Fast path: pre-accumulate per-cluster sums by scanning CSC non-zeros once
  const cscForCov = peakMatrix.getCSC ? peakMatrix.getCSC() : null;
  const peakRowMap = new Map(); // peakRow rowIndex → index in peakRows array
  for (let ri = 0; ri < peakRows.length; ri++) peakRowMap.set(peakRows[ri].rowIndex, ri);
  const clusterIdxMap = new Map();
  for (let ci = 0; ci < uniqueClusters.length; ci++) clusterIdxMap.set(uniqueClusters[ci], ci);
  // sums[clusterIdx][peakRowIdx] = raw sum
  const sums = Array.from({ length: uniqueClusters.length }, () => new Float64Array(peakRows.length));
  if (cscForCov) {
    const { colPtr, rowIdx, values } = cscForCov;
    for (let c = 0; c < nCells; c++) {
      const clustId = clusters[c];
      if (clustId === null || clustId === undefined) continue;
      const ci = clusterIdxMap.get(clustId);
      if (ci === undefined) continue;
      for (let p = colPtr[c]; p < colPtr[c + 1]; p++) {
        const ri = peakRowMap.get(rowIdx[p]);
        if (ri !== undefined) sums[ci][ri] += values[p];
      }
    }
  } else {
    // Fallback: original row-access approach
    for (let ci = 0; ci < uniqueClusters.length; ci++) {
      const cellIndices = clusterToCells.get(uniqueClusters[ci]) || [];
      for (let ri = 0; ri < peakRows.length; ri++) {
        const row = peakMatrix.row(peakRows[ri].rowIndex);
        for (let j = 0; j < cellIndices.length; j++) sums[ci][ri] += (row[cellIndices[j]] || 0);
      }
    }
  }

  const coverageByCluster = [];
  for (let ci = 0; ci < uniqueClusters.length; ci++) {
    const clusterId = uniqueClusters[ci];
    const cellIndices = clusterToCells.get(clusterId) || [];
    const signal = [];
    for (let ri = 0; ri < peakRows.length; ri++) {
      const p = peakRows[ri];
      const sum = sums[ci][ri];
      let value;
      if (hasColSums) {
        // Signac: norm = raw_sum / group_scale_factor * median_scale_factor
        const gsf = groupScaleFactors.get(clusterId) || 1;
        value = (sum / gsf) * medianScale;
      } else {
        // Fallback: simple mean per cell
        value = cellIndices.length > 0 ? sum / cellIndices.length : 0;
      }
      signal.push({ start: p.start, end: p.end, value });
    }
    coverageByCluster.push({ clusterId, label: String(clusterId), cellCount: cellIndices.length, signal });
  }
  coverageByCluster.sort((a, b) => (b.cellCount || 0) - (a.cellCount || 0));
  const cap = maxClustersCap != null ? maxClustersCap : ATAC_MAX_CLUSTERS_COVERAGE;
  return coverageByCluster.slice(0, cap);
}

/** Per-cluster mean raw count over peaks when clusters map to full-matrix column indices (multiome). */
function computeCoverageByClusterRawFromColumnMap(peakMatrix, clusterToColumnIndices, peakRows) {
  const coverageByCluster = [];
  const clusterIds = Array.from(clusterToColumnIndices.keys()).filter(c => c !== null && c !== undefined);
  clusterIds.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
  for (const clusterId of clusterIds) {
    const columnIndices = clusterToColumnIndices.get(clusterId) || [];
    const signal = [];
    for (const p of peakRows) {
      let sum = 0;
      const row = peakMatrix.row(p.rowIndex);
      for (let j = 0; j < columnIndices.length; j++) {
        const val = (row && row[columnIndices[j]] != null) ? row[columnIndices[j]] : 0;
        sum += val;
      }
      const value = columnIndices.length > 0 ? sum / columnIndices.length : 0;
      signal.push({ start: p.start, end: p.end, value });
    }
    coverageByCluster.push({ clusterId, label: String(clusterId), cellCount: columnIndices.length, signal });
  }
  coverageByCluster.sort((a, b) => (b.cellCount || 0) - (a.cellCount || 0));
  return coverageByCluster.slice(0, ATAC_MAX_CLUSTERS_COVERAGE);
}

/**
 * Plot gene activity for ATAC when we have state (runFullAnalysisPipeline) and peakAnnotation:
 * sum normalized peak rows linked to the gene, then log-scale. Returns peaksOnGene and coverageByCluster for Peak View (Signac CoveragePlot-style).
 */
async function plotAtacGeneActivityFromState(params) {
  const { gene, colorMap } = params;
  const showPeakView = params.showPeakView === true;
  const geneName = (gene && String(gene).trim()) || 'gene';
  const cacheKey = geneName.toLowerCase().trim();
  const cached = scAtacGeneActivityCache.get(cacheKey);
  if (cached) {
    console.log('scATAC: serving gene activity from cache for', geneName);
    const cachedData = {
      ...cached,
      expression: [...cached.expression],
      coordinates: cached.coordinates ? cached.coordinates.map((c) => [...c]) : undefined,
    };
    if (!showPeakView) {
      cachedData.coverageByCluster = undefined;
      cachedData.viewCoverageByCluster = undefined;
      cachedData.region = undefined;
      cachedData.peaksOnGene = undefined;
    }
    self.postMessage({ type: 'ANALYSIS_COMPLETE', data: cachedData });
    return;
  }
  const peakAnnotation = loadedData.peakAnnotation;
  const state = loadedData.state;
  // Use raw count matrix (not normalized) for linear-scale ATAC gene activity
  const countMatrixContainer = state.inputs.fetchCountMatrix();
  const countModality = countMatrixContainer.available()[0];
  const normMatrix = countMatrixContainer.get(countModality);
  const nCells = normMatrix.numberOfColumns();
  const { geneNames } = await ensureGeneLookup();
  let { peakIndices, peaksOnGene } = getPeaksForGene(geneName, peakAnnotation, geneNames);
  if (peakIndices.length === 0) {
    const genome = loadedData.info?.genome;
    const tssResult = getPeaksForGeneByTSS(geneName, peakAnnotation, geneNames, undefined, genome);
    if (tssResult.peakIndices.length > 0) {
      peakIndices = tssResult.peakIndices;
      peaksOnGene = tssResult.peaksOnGene;
      console.log('scATAC: gene activity for', geneName, 'via TSS-based linking (' + peakIndices.length + ' peaks within 500kb of TSS, genome:', genome || 'default');
    } else {
      const hint = peakAnnotation.length === 0 || peakAnnotation.every((p) => !(p.gene && String(p.gene).trim()))
        ? ' Ensure your peak annotation file has a gene column (e.g. "gene", "gene_name", or "symbol"), or try a gene in the TSS reference (e.g. SLC12A1, CD4, MS4A1).'
        : '';
      throw new Error(`No peaks found for gene "${geneName}". Try another gene or check spelling.${hint}`);
    }
  }

  const expression = new Float32Array(nCells);
  for (let c = 0; c < nCells; c++) {
    let sum = 0;
    for (let p = 0; p < peakIndices.length; p++) {
      const row = normMatrix.row(peakIndices[p]);
      sum += (row && row[c]) ? row[c] : 0;
    }
    expression[c] = sum;
  }
  // Use raw counts directly (linear scale) for ATAC gene activity

  const coordinates = currentResults.umap;
  if (!coordinates || coordinates.length !== nCells) {
    throw new Error('UMAP coordinates not available for ATAC gene activity plot.');
  }

  let coverageByCluster = null;
  let region = null;
  const clusters = currentResults.clusters;
  if (peaksOnGene.length > 0 && Array.isArray(clusters) && clusters.length === nCells) {
    const chrom = peaksOnGene[0].chrom;
    const minStart = Math.min(...peaksOnGene.map((p) => Number(p.start) || 0));
    const maxEnd = Math.max(...peaksOnGene.map((p) => Number(p.end) || 0));
    const regionStart = Math.max(0, minStart - ATAC_EXTEND_UPSTREAM);
    const regionEnd = maxEnd + ATAC_EXTEND_DOWNSTREAM;
    const { peakRows, peaksInRegion } = getPeaksInRegion(peakAnnotation, geneNames, chrom, regionStart, regionEnd);
    if (peakRows.length > 0) {
      coverageByCluster = computeCoverageByCluster(normMatrix, clusters, peakRows);
      region = { chrom, start: regionStart, end: regionEnd };
    }
  }

  // Get filtered/ordered barcodes that match the clusters array
  // This is critical: after cell filtering, the indices don't match original barcodes
  let cellBarcodes = null;
  if (loadedData.cellBarcodes && Array.isArray(loadedData.cellBarcodes)) {
    const state = loadedData.state;
    if (state && state.cell_filtering && typeof state.cell_filtering.fetchKeep === 'function') {
      try {
        const keepResult = state.cell_filtering.fetchKeep();
        let keptIndices = null;
        if (keepResult && typeof keepResult[Symbol.iterator] === 'function') {
          keptIndices = [];
          let idx = 0;
          for (const kept of keepResult) {
            if (kept) keptIndices.push(idx);
            idx++;
          }
        } else if (keepResult && typeof keepResult.length === 'number') {
          keptIndices = [];
          for (let i = 0; i < keepResult.length; i++) {
            if (keepResult[i]) keptIndices.push(i);
          }
        }
        if (keptIndices && keptIndices.length === nCells) {
          cellBarcodes = keptIndices.map(idx => loadedData.cellBarcodes[idx]);
          console.log('Using filtered barcodes (keep mask):', cellBarcodes.length, 'of', loadedData.cellBarcodes.length);
        }
      } catch (e) {
        console.warn('Failed to get keep mask for barcode filtering:', e.message);
      }
    }
    // Fallback: if no filtering or lengths match, use original barcodes
    if (!cellBarcodes && loadedData.cellBarcodes.length === nCells) {
      cellBarcodes = loadedData.cellBarcodes;
      console.log('Using original barcodes (no filtering detected):', cellBarcodes.length);
    }
  }

  let expressionRangeFromState = null;
  if (expression.length > 0) {
    const sorted = Array.from(expression).sort((a, b) => a - b);
    const p02 = sorted[Math.floor(0.02 * sorted.length)];
    const p98 = sorted[Math.floor(0.98 * sorted.length)];
    const exprMax = sorted[sorted.length - 1];
    const rangeMax = (p98 > p02) ? p98 : exprMax;
    if (Number.isFinite(rangeMax) && rangeMax > 0) {
      expressionRangeFromState = [p02, rangeMax];
    }
  }

  console.log('ATAC gene activity response:', {
    geneName,
    nCells,
    cellBarcodesLength: cellBarcodes?.length,
    clustersLength: clusters?.length,
    hasRegion: !!region,
    coverageByClusterLength: coverageByCluster?.length,
    barcodesMatchClusters: cellBarcodes?.length === clusters?.length,
  });

  // Compute per-cluster mean depth for Signac-style fragment normalization
  let clusterMeanDepths = undefined;
  const colSumsState = loadedData.atacColSums;
  if (Array.isArray(colSumsState) && colSumsState.length === nCells && Array.isArray(clusters) && clusters.length === nCells) {
    const depthMap = {};
    const countMap = {};
    for (let i = 0; i < nCells; i++) {
      const c = clusters[i];
      if (c === null || c === undefined) continue;
      depthMap[c] = (depthMap[c] || 0) + (colSumsState[i] || 0);
      countMap[c] = (countMap[c] || 0) + 1;
    }
    clusterMeanDepths = {};
    for (const c of Object.keys(depthMap)) {
      clusterMeanDepths[c] = countMap[c] > 0 ? depthMap[c] / countMap[c] : 0;
    }
  }

  const payload = {
    type: 'gene_expression',
    geneName,
    expression: Array.from(expression),
    expressionRange: expressionRangeFromState || undefined,
    coordinates,
    colorMap: colorMap || null,
    peaksOnGene: peaksOnGene.length ? peaksOnGene : undefined,
    coverageByCluster: coverageByCluster && coverageByCluster.length ? coverageByCluster : undefined,
    region: region || undefined,
    genome: loadedData.info?.genome || undefined,
    cellBarcodes: cellBarcodes || undefined,
    clusters: clusters || undefined,
    clusterMeanDepths: clusterMeanDepths || undefined,
    isAtac: true,
  };
  scAtacGeneActivityCache.set(cacheKey, {
    ...payload,
    expression: [...payload.expression],
    expressionRange: payload.expressionRange ? [...payload.expressionRange] : undefined,
    coordinates: payload.coordinates ? payload.coordinates.map((c) => [...c]) : undefined,
    peaksOnGene: payload.peaksOnGene ? payload.peaksOnGene.map((p) => ({ ...p })) : undefined,
    coverageByCluster: copyCoverageByCluster(payload.coverageByCluster),
    region: payload.region ? { ...payload.region } : undefined,
    cellBarcodes: payload.cellBarcodes ? [...payload.cellBarcodes] : undefined,
    clusters: payload.clusters ? [...payload.clusters] : undefined,
  });
  const responsePayloadState = showPeakView ? payload : {
    ...payload,
    coverageByCluster: undefined,
    viewCoverageByCluster: undefined,
    region: undefined,
    peaksOnGene: undefined,
  };
  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: responsePayloadState,
  });
}

async function plotGeneExpression(params) {
  const { gene, colorMap } = params;

  console.log('====== plotGeneExpression called ======');
  console.log('Gene:', gene);
  console.log('ColorMap:', colorMap);
  console.log('loadedData exists:', !!loadedData);
  console.log('loadedData.state exists:', !!loadedData?.state);

  const isPeakId = /^chr\w+[:-]\d+[:-]\d+$/i.test(String(gene || '').trim());

  // scATAC (single-sample or atac-integration) + peak ID: plot single peak expression on UMAP
  if ((loadedData?.info?.modality === 'atac' || loadedData?.info?.modality === 'atac-integration') &&
      loadedData.atacPeakMatrix && isPeakId) {
    const peakMatrix = loadedData.atacPeakMatrix;
    const peakNames = loadedData.atacPeakNames || loadedData.peakNames || [];
    const peakIdx = findPeakIndex(gene, peakNames);
    if (peakIdx === -1) {
      throw new Error(`Peak ${gene} not found in peak matrix (${peakNames.length} peaks available).`);
    }
    const nCells = peakMatrix.numberOfColumns();
    const fullRow = peakMatrix.row(peakIdx);
    const peakExpression = new Float32Array(nCells);
    for (let j = 0; j < nCells; j++) {
      peakExpression[j] = Math.log1p(fullRow[j] || 0);
    }
    const coordinates = currentResults.umap;
    const clusters = currentResults.clusters;
    if (!coordinates || coordinates.length !== nCells) {
      throw new Error('UMAP coordinates not available for peak plot.');
    }
    const cellBarcodes = loadedData.cellBarcodes || [];
    const payload = {
      type: 'gene_expression',
      coordinates,
      expression: peakExpression,
      geneName: peakNames[peakIdx],
      colorMap,
      coverageByCluster: undefined,
      region: undefined,
      genome: loadedData.info?.genome || 'hg38',
      cellBarcodes: cellBarcodes.length === nCells ? cellBarcodes : null,
      clusters,
      isAtac: true,
      umapOnly: true,
    };
    if (loadedData?.info?.modality === 'atac-integration' && loadedData.integrationViews) {
      payload.integrationViews = loadedData.integrationViews;
      payload.datasetNames = loadedData.info?.datasetNames || [];
    }
    self.postMessage({ type: 'ANALYSIS_COMPLETE', data: payload });
    console.log('scATAC: sent peak plot for', peakNames[peakIdx]);
    return;
  }

  // ATAC with legacy runAtacPipeline (atacPeakMatrix): plot gene activity from peaks linked to gene
  if ((loadedData?.info?.modality === 'atac' || loadedData?.info?.modality === 'atac-integration') && loadedData.atacPeakMatrix && loadedData.peakAnnotation) {
    console.log('>>> ROUTING: plotAtacGeneActivity (legacy raw peak matrix path)');
    await plotAtacGeneActivity(params);
    return;
  }

  // ATAC with state + peakAnnotation: if "gene" is a gene name (not peak ID), plot gene activity from state matrix
  if (
    loadedData?.info?.modality === 'atac' &&
    loadedData.state &&
    loadedData.peakAnnotation &&
    !isPeakId
  ) {
    console.log('>>> ROUTING: plotAtacGeneActivityFromState (bakana state path)');
    await plotAtacGeneActivityFromState(params);
    return;
  }

  // Multiome: plot RNA expression AND ATAC gene activity for the same gene
  if (loadedData?.info?.modality === 'multiome' && !isPeakId) {
    console.log('Multiome: will plot both RNA expression and ATAC gene activity for', gene);
  }

  // Multiome + peak ID: plot ATAC-only using peak matrix (no RNA dual-plot)
  if (loadedData?.info?.modality === 'multiome' && isPeakId) {
    console.log('Multiome: plotting peak', gene, 'in ATAC view only');
    const multiomePeak = await getMultiomePeakMatrix();
    if (!multiomePeak) throw new Error('No peak matrix available for ATAC peak plotting.');
    const { peakMatrix, peakNames, fullBarcodeOrder } = multiomePeak;
    const peakIdx = findPeakIndex(gene, peakNames);
    if (peakIdx === -1) throw new Error(`Peak ${gene} not found in peak matrix (${peakNames.length} peaks available).`);

    // Extract peak values for filtered cells
    const filteredBarcodes = loadedData.cellBarcodes || [];
    const nFiltered = filteredBarcodes.length;
    const barcodeToColIdx = new Map();
    for (let i = 0; i < fullBarcodeOrder.length; i++) barcodeToColIdx.set(fullBarcodeOrder[i], i);

    const fullRow = peakMatrix.row(peakIdx);
    const peakExpression = new Float32Array(nFiltered);
    for (let j = 0; j < nFiltered; j++) {
      const colIdx = barcodeToColIdx.get(filteredBarcodes[j]);
      if (colIdx !== undefined) peakExpression[j] = Math.log1p(fullRow[colIdx] || 0);
    }

    // Get ATAC coordinates + clusters
    let atacCoordinates = loadedData.precomputed?.atacAligned?.coordinates || currentResults.umap;
    let atacClusters = loadedData.precomputed?.atacAligned?.clusters || currentResults.clusters;
    if (atacCoordinates && atacCoordinates.length !== nFiltered) {
      atacCoordinates = currentResults.umap;
      if (atacCoordinates && atacCoordinates.length !== nFiltered) atacCoordinates = null;
    }
    if (!atacClusters || atacClusters.length !== nFiltered) atacClusters = currentResults.clusters;

    // Build region from peak coordinates
    const peakMatch = gene.match(/^(chr\w+):(\d+)-(\d+)$/i);
    const region = peakMatch ? {
      chrom: peakMatch[1],
      start: Math.max(0, parseInt(peakMatch[2]) - 5000),
      end: parseInt(peakMatch[3]) + 5000,
    } : null;
    const peaksOnGene = peakMatch
      ? [{ chrom: peakMatch[1], start: parseInt(peakMatch[2]), end: parseInt(peakMatch[3]),
           peakName: peakNames[peakIdx] }]
      : [];

    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'gene_expression',
        multiomeModality: 'atac',
        coordinates: atacCoordinates,
        expression: peakExpression,
        geneName: peakNames[peakIdx],
        colorMap,
        peaksOnGene,
        coverageByCluster: null,
        region,
        genome: loadedData.info?.genome || 'hg38',
        cellBarcodes: filteredBarcodes,
        clusters: atacClusters,
        isAtac: true,
      },
    });
    console.log('Multiome: sent ATAC peak plot for', peakNames[peakIdx]);
    return;
  }

  // ATAC with state: "gene" can be a peak ID (chrN:start-end); use state matrix. RNA: use resolveGeneExpression.
  if (!loadedData || (!loadedData.state && !loadedData.jsNormMatrix && !loadedData.jsH5TmpFile)) {
    const error = new Error('No data loaded. Please load data first.');
    console.error('plotGeneExpression error:', error.message);
    throw error;
  }

  try {
    console.log('Resolving gene expression for:', gene);
    const { geneName, logExpression } = await resolveGeneExpression(gene);
    console.log('Gene resolved:', geneName);
    console.log('Expression array length:', logExpression.length);
    console.log('Expression sample (first 10):', Array.from(logExpression.slice(0, 10)));

    // Always fetch UMAP coordinates for the UMAP view.
    // For "Load previous results", prefer the restored saved coordinates to avoid stale
    // currentResults.umap from other branches that may have different cell ordering/length.
    const restoredPrev = loadedData?.restoredPreviousResults;
    let umapCoordinates = Array.isArray(restoredPrev?.umapCoordinates) ? restoredPrev.umapCoordinates : currentResults.umap;
    if (!umapCoordinates && loadedData.state) {
      console.log('Fetching UMAP results from analysis state...');
      const umapResults = await loadedData.state.umap.fetchResults();
      umapCoordinates = [];
      for (let i = 0; i < umapResults.x.length; i++) {
        umapCoordinates.push([umapResults.x[i], umapResults.y[i]]);
      }
      currentResults.umap = umapCoordinates; // cache for later
      console.log('UMAP coordinates fetched:', umapCoordinates.length);
    } else {
      console.log('Using cached UMAP coordinates:', umapCoordinates.length);
    }

    // For spatial datasets, also include spatial coordinates
    // The spatial view will use spatialIndex coordinates (which match spatialData.coordinates order)
    // The UMAP view will use the umapCoordinates from the artifact
    // IMPORTANT: Check loadedData.spatialData directly instead of relying on global spatialData variable
    let spatialCoordinates = null;
    const spatialDataSource = loadedData?.spatialData || spatialData;
    console.log('Checking for spatial coordinates:', {
      hasLoadedDataSpatialData: !!loadedData?.spatialData,
      hasGlobalSpatialData: !!spatialData,
      hasCoordinatesInLoadedData: Array.isArray(loadedData?.spatialData?.coordinates),
      coordinatesLengthInLoadedData: loadedData?.spatialData?.coordinates?.length,
      hasCoordinatesInGlobal: Array.isArray(spatialData?.coordinates),
      coordinatesLengthInGlobal: spatialData?.coordinates?.length,
    });

    const preferredSpatialCoords =
      Array.isArray(restoredPrev?.spatialCoordinates) && restoredPrev.spatialCoordinates.length > 0
        ? restoredPrev.spatialCoordinates
        : (Array.isArray(spatialDataSource?.coordinates) ? spatialDataSource.coordinates : null);
    if (Array.isArray(preferredSpatialCoords) && preferredSpatialCoords.length > 0) {
      spatialCoordinates = preferredSpatialCoords.map(coord => {
        if (coord == null) return [0, 0];
        return Array.isArray(coord) ? [coord[0] ?? 0, coord[1] ?? 0] : [coord.x ?? 0, coord.y ?? 0];
      });
      console.log('Including spatial coordinates for gene expression plot: ' + spatialCoordinates.length + ' cells');
    } else {
      console.log('No spatial coordinates available - spatial data source:', spatialDataSource);
    }

    // Use UMAP coordinates as the primary coordinates (for backward compatibility with UMAP view)
    // The spatial view will use its own spatialIndex coordinates, which should match spatialCoordinates
    let coordinates = umapCoordinates;
    console.log(`Using UMAP coordinates for gene expression plot: ${coordinates.length} cells`);

    // Ensure expression array length matches coordinates length
    let finalExpression = logExpression;
    if (logExpression.length !== coordinates.length) {
      console.warn(`Expression array length (${logExpression.length}) does not match coordinates length (${coordinates.length})`);
      let realigned = false;

      const restoredRemap = loadedData?.restoredExpressionSourceIndices;
      if (restoredRemap && restoredRemap.length === coordinates.length) {
        const remapped = new Float32Array(coordinates.length);
        let matched = 0;
        for (let i = 0; i < restoredRemap.length; i += 1) {
          const src = restoredRemap[i];
          if (src >= 0 && src < logExpression.length) {
            remapped[i] = logExpression[src];
            matched += 1;
          }
        }
        if (matched > 0) {
          finalExpression = remapped;
          realigned = true;
          console.log(`Gene expression restored-index realignment: matched ${matched}/${coordinates.length} cells`);
        }
      }

      // Prefer barcode-based realignment when restored previous results changed cell ordering.
      const preferredTargetBarcodes =
        Array.isArray(restoredPrev?.cellBarcodes) && restoredPrev.cellBarcodes.length === coordinates.length
          ? restoredPrev.cellBarcodes
          : loadedData?.cellBarcodes;
      const targetBarcodes = Array.isArray(preferredTargetBarcodes) && preferredTargetBarcodes.length === coordinates.length
        ? preferredTargetBarcodes
        : null;
      if (targetBarcodes && loadedData?.state) {
        try {
          const annotations = loadedData.state.inputs.fetchCellAnnotations();
          const sourceBarcodes = extractOrderedBarcodesFromAnnotations(annotations, logExpression.length);
          const remapped = alignExpressionToTargetBarcodes(logExpression, sourceBarcodes, targetBarcodes);
          if (remapped && remapped.matched > 0) {
            finalExpression = remapped.aligned;
            realigned = true;
            console.log(
              `Gene expression barcode realignment: matched ${remapped.matched}/${targetBarcodes.length} cells`
            );
            if (remapped.sampleUnmatched.length > 0) {
              console.log('Gene expression realignment sample unmatched barcodes:', remapped.sampleUnmatched);
            }
          }
        } catch (exprAlignErr) {
          console.warn('Gene expression barcode realignment failed:', exprAlignErr);
        }
      }

      if (!realigned) {
        // Coordinate-key fallback for legacy saves without cellBarcodes:
        // map expression from current state-order spatial coords to restored spatial coords.
        if (
          loadedData?.state &&
          spatialDataSource?.idToCoord instanceof Map &&
          Array.isArray(spatialCoordinates) &&
          spatialCoordinates.length === coordinates.length
        ) {
          try {
            const nExpr = logExpression.length;
            let stateBarcodes = extractOrderedBarcodesFromAnnotations(
              loadedData.state.inputs.fetchCellAnnotations(),
              nExpr
            );
            if (!stateBarcodes) {
              const src = Array.isArray(loadedData.cellBarcodes) ? loadedData.cellBarcodes : null;
              const keepState = loadedData.state.cell_filtering;
              if (src && keepState && typeof keepState.fetchKeep === 'function') {
                const keepResult = keepState.fetchKeep();
                let keepMask = keepResult
                  ? (typeof keepResult.array === 'function'
                      ? keepResult.array()
                      : (typeof keepResult.toArray === 'function' ? keepResult.toArray() : keepResult))
                  : null;
                if (!Array.isArray(keepMask) && typeof keepMask?.length === 'number') keepMask = Array.from(keepMask);
                if (Array.isArray(keepMask) && keepMask.length === src.length) {
                  const kept = [];
                  for (let i = 0; i < keepMask.length; i += 1) {
                    const raw = Array.isArray(keepMask[i]) ? keepMask[i][0] : keepMask[i];
                    const keep = typeof raw === 'number' ? raw !== 0 : !!raw;
                    if (keep) kept.push(src[i]);
                  }
                  if (kept.length === nExpr) stateBarcodes = kept;
                }
              }
            }

            if (Array.isArray(stateBarcodes) && stateBarcodes.length === nExpr) {
              const stateSpatial = mapBarcodesToCoordinates(
                spatialDataSource,
                stateBarcodes,
                { allowLooseVariants: false }
              );
              if (Array.isArray(stateSpatial.coordinates) && stateSpatial.coordinates.length === nExpr) {
                const exprByCoord = new Map();
                for (let i = 0; i < nExpr; i += 1) {
                  const key = makeCoordKey(stateSpatial.coordinates[i]);
                  if (!key) continue;
                  if (!exprByCoord.has(key)) exprByCoord.set(key, logExpression[i]);
                }
                const remapped = new Float32Array(spatialCoordinates.length);
                let matched = 0;
                for (let i = 0; i < spatialCoordinates.length; i += 1) {
                  const key = makeCoordKey(spatialCoordinates[i]);
                  if (key && exprByCoord.has(key)) {
                    remapped[i] = exprByCoord.get(key);
                    matched += 1;
                  }
                }
                if (matched > 0) {
                  finalExpression = remapped;
                  realigned = true;
                  console.log(`Gene expression coord-key realignment: matched ${matched}/${spatialCoordinates.length} cells`);
                }
              }
            }
          } catch (coordAlignErr) {
            console.warn('Gene expression coord-key realignment failed:', coordAlignErr);
          }
        }
      }

      if (!realigned) {
        // If restore metadata is incomplete (e.g. older saves without cellBarcodes),
        // fall back to the *current analysis-state order* so expression and coordinates
        // are still aligned by cell index.
        if (loadedData?.state && spatialDataSource?.idToCoord instanceof Map) {
          try {
            const nExpr = logExpression.length;
            let stateBarcodes = extractOrderedBarcodesFromAnnotations(
              loadedData.state.inputs.fetchCellAnnotations(),
              nExpr
            );
            if (!stateBarcodes) {
              const keepState = loadedData.state.cell_filtering;
              const sourceBarcodes = Array.isArray(loadedData.cellBarcodes) ? loadedData.cellBarcodes : null;
              if (keepState && typeof keepState.fetchKeep === 'function' && sourceBarcodes?.length) {
                const keepResult = keepState.fetchKeep();
                let keepMask = keepResult
                  ? (typeof keepResult.array === 'function'
                      ? keepResult.array()
                      : (typeof keepResult.toArray === 'function' ? keepResult.toArray() : keepResult))
                  : null;
                if (!Array.isArray(keepMask) && typeof keepMask?.length === 'number') {
                  keepMask = Array.from(keepMask);
                }
                if (Array.isArray(keepMask) && keepMask.length === sourceBarcodes.length) {
                  const kept = [];
                  for (let i = 0; i < keepMask.length; i += 1) {
                    const raw = Array.isArray(keepMask[i]) ? keepMask[i][0] : keepMask[i];
                    const keep = typeof raw === 'number' ? raw !== 0 : !!raw;
                    if (keep) kept.push(sourceBarcodes[i]);
                  }
                  if (kept.length === nExpr) {
                    stateBarcodes = kept;
                  }
                }
              }
            }

            if (Array.isArray(stateBarcodes) && stateBarcodes.length === nExpr) {
              let stateUmapCoords = null;
              try {
                const um = await loadedData.state.umap.fetchResults();
                stateUmapCoords = Array.from({ length: um.x.length }, (_, i) => [um.x[i], um.y[i]]);
              } catch (_) {
                stateUmapCoords = null;
              }
              const stateSpatial = mapBarcodesToCoordinates(
                spatialDataSource,
                stateBarcodes,
                { allowLooseVariants: false }
              );
              if (Array.isArray(stateUmapCoords) && stateUmapCoords.length === nExpr) {
                coordinates = stateUmapCoords;
                currentResults.umap = stateUmapCoords;
              }
              if (Array.isArray(stateSpatial.coordinates) && stateSpatial.coordinates.length === nExpr) {
                spatialCoordinates = stateSpatial.coordinates;
              }
              finalExpression = logExpression;
              realigned = true;
              console.warn('Gene expression fallback: switched to analysis-state cell order for aligned plotting');
            }
          } catch (stateAlignErr) {
            console.warn('Gene expression state-order fallback failed:', stateAlignErr);
          }
        }
      }

      if (!realigned) {
        // Last resort fallback: truncate/pad to avoid hard failure.
        if (logExpression.length > coordinates.length) {
          console.warn('Truncating expression array to match coordinates length');
          finalExpression = logExpression.slice(0, coordinates.length);
        } else {
          console.warn('Padding expression array with zeros to match coordinates length');
          const padded = new Float32Array(coordinates.length);
          padded.set(logExpression);
          finalExpression = padded;
        }
      }
    }

    // Compute percentile-based expression range for better color mapping.
    // Without this, outlier max values cause most cells to map near the bottom of the
    // color scale (appearing white/blue). Use 2nd-98th percentile like ATAC modules.
    let expressionRange = null;
    if (finalExpression.length > 0) {
      const sorted = Array.from(finalExpression).sort((a, b) => a - b);
      const p02 = sorted[Math.floor(0.02 * sorted.length)];
      const p98 = sorted[Math.floor(0.98 * sorted.length)];
      const exprMax = sorted[sorted.length - 1];
      const rangeMax = (p98 > p02) ? p98 : exprMax;
      if (Number.isFinite(rangeMax) && rangeMax > 0) {
        expressionRange = [p02, rangeMax];
      }
    }

    console.log('Sending gene expression results to UI');
    console.log('Data summary:', {
      geneName,
      expressionLength: finalExpression.length,
      coordinatesLength: coordinates.length,
      hasSpatialCoordinates: !!spatialCoordinates,
      colorMap,
      expressionRange,
    });

    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'gene_expression',
        coordinates: coordinates, // UMAP coordinates for UMAP view
        spatialCoordinates: spatialCoordinates, // Spatial coordinates (spatial view uses spatialIndex instead)
        expression: finalExpression,
        geneName,
        colorMap,
        expressionRange: expressionRange || undefined,
      }
    });

    console.log('Gene expression plot message sent successfully');

    // Multiome: also compute ATAC gene activity (peak-derived) and send to ATAC view
    // RNA view shows gene expression (already sent above); ATAC view shows gene activity from peak matrix (same as scATAC-seq).
    if (loadedData?.info?.modality === 'multiome' && loadedData.peakAnnotation?.length > 0) {
      try {
        const atacCacheKey = (geneName || '').toLowerCase().trim();
        const cachedAtac = atacGeneActivityCache.get(atacCacheKey);
        if (cachedAtac) {
          console.log('Multiome: serving ATAC gene activity from cache for', geneName);
          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              ...cachedAtac,
              expression: new Float32Array(cachedAtac.expression),
            },
          });
          return;
        }
        console.log('Multiome: computing ATAC gene activity for', geneName);
        const peakAnnotation = loadedData.peakAnnotation;
        const multiomePeak = await getMultiomePeakMatrix();
        // Always get peaksOnGene from peak annotation (works with or without peak matrix)
        const peakNames = multiomePeak?.peakNames || [];
        const { peakIndices, peaksOnGene } = getPeaksForGene(geneName, peakAnnotation, peakNames);

        if (multiomePeak && peakIndices.length > 0) {
          // Full path: gene activity UMAP coloring + region/barcodes/clusters for fragment-based coverage
          // (same approach as scATAC: fragment-based coverage is computed in App.jsx via Electron IPC)
          const { peakMatrix, fullBarcodeOrder } = multiomePeak;
          const filteredBarcodes = loadedData.cellBarcodes || [];
          const nFiltered = filteredBarcodes.length;
          const barcodeToColIdx = new Map();
          for (let i = 0; i < fullBarcodeOrder.length; i++) {
            barcodeToColIdx.set(fullBarcodeOrder[i], i);
          }

            // Gene activity: sum raw peak counts per cell for peaks linked to the gene (same as scATAC plotAtacGeneActivity)
            const atacExpression = new Float32Array(nFiltered);
            for (let j = 0; j < nFiltered; j++) {
              const colIdx = barcodeToColIdx.get(filteredBarcodes[j]);
              if (colIdx === undefined) continue;
              const col = peakMatrix.column(colIdx);
              let sum = 0;
              for (let p = 0; p < peakIndices.length; p++) {
                sum += col[peakIndices[p]] || 0;
              }
              atacExpression[j] = sum;
            }
            // Use raw counts directly (linear scale) for ATAC gene activity
            // Compute 2nd-98th percentile range for color scale (matching plot_gene_activity_linear.mjs)
            let atacExpressionRange = null;
            if (atacExpression.length > 0) {
              const sortedAtac = Array.from(atacExpression).sort((a, b) => a - b);
              const atacP02 = sortedAtac[Math.floor(0.02 * sortedAtac.length)];
              const atacP98 = sortedAtac[Math.floor(0.98 * sortedAtac.length)];
              const atacExprMax = sortedAtac[sortedAtac.length - 1];
              const atacRangeMax = (atacP98 > atacP02) ? atacP98 : atacExprMax;
              if (Number.isFinite(atacRangeMax) && atacRangeMax > 0) {
                atacExpressionRange = [atacP02, atacRangeMax];
              }
            }

            let atacCoordinates = loadedData.precomputed?.atacAligned?.coordinates || currentResults.umap;
            let atacClusters = loadedData.precomputed?.atacAligned?.clusters || currentResults.clusters;
            if (atacCoordinates && atacCoordinates.length !== nFiltered) {
              console.warn('Multiome: ATAC coordinates length', atacCoordinates.length, '!= filtered', nFiltered, '- falling back');
              atacCoordinates = currentResults.umap; // try RNA UMAP
              if (atacCoordinates && atacCoordinates.length !== nFiltered) {
                atacCoordinates = null;
              }
            }
            // Ensure clusters are always available (needed for fragment query + coverage computation)
            if (!atacClusters || atacClusters.length !== nFiltered) {
              atacClusters = currentResults.clusters;
            }

            // Compute region from peaks (needed for fragment-based coverage query in App.jsx)
            let region = null;
            if (peaksOnGene.length > 0) {
              const ATAC_EXTEND_UP = 5000;
              const ATAC_EXTEND_DOWN = 5000;
              const chrom = peaksOnGene[0].chrom;
              const minStart = Math.min(...peaksOnGene.map(p => Number(p.start) || 0));
              const maxEnd = Math.max(...peaksOnGene.map(p => Number(p.end) || 0));
              region = { chrom, start: Math.max(0, minStart - ATAC_EXTEND_UP), end: maxEnd + ATAC_EXTEND_DOWN };
            }

            // Cache ATAC gene activity for same-gene repeat requests (copy so postMessage doesn't transfer away)
            const atacPayload = {
              type: 'gene_expression',
              multiomeModality: 'atac',
              coordinates: atacCoordinates ? atacCoordinates.map((c) => [...c]) : null,
              expression: new Float32Array(atacExpression),
              expressionRange: atacExpressionRange ? [...atacExpressionRange] : undefined,
              geneName,
              colorMap,
              peaksOnGene: peaksOnGene.map((p) => ({ ...p })),
              coverageByCluster: null,
              region: region ? { ...region } : null,
              genome: loadedData.info?.genome || 'hg38',
              cellBarcodes: filteredBarcodes.length ? [...filteredBarcodes] : undefined,
              clusters: atacClusters ? [...atacClusters] : null,
              isAtac: true,
            };
            atacGeneActivityCache.set(atacCacheKey, atacPayload);

            // Send ATAC data — coverage is computed via fragment query in App.jsx (same as scATAC)
            self.postMessage({
              type: 'ANALYSIS_COMPLETE',
              data: {
                type: 'gene_expression',
                multiomeModality: 'atac',
                coordinates: atacCoordinates,
                expression: atacExpression,
                expressionRange: atacExpressionRange || undefined,
                geneName,
                colorMap,
                peaksOnGene: peaksOnGene,
                coverageByCluster: null,
                region: region,
                genome: loadedData.info?.genome || 'hg38',
                cellBarcodes: filteredBarcodes.length ? filteredBarcodes : undefined,
                clusters: atacClusters,
                isAtac: true,
              },
            });
            console.log('Multiome: sent ATAC gene activity for', geneName, 'with', peakIndices.length, 'peaks');

        } else if (peaksOnGene.length > 0 && params.showPeakView) {
          // Coverage-only path: peak matrix unavailable or no matching indices, but peaks exist
          // in annotation. Send peaksOnGene + region so frontend can query fragment-based coverage.
          console.log('Multiome: no peak matrix indices, using coverage-only path for', geneName, '(', peaksOnGene.length, 'peaks from annotation)');
          const filteredBarcodes = loadedData.cellBarcodes || [];
          const nFiltered = filteredBarcodes.length;
          let atacCoordinates = loadedData.precomputed?.atacAligned?.coordinates || currentResults.umap;
          let atacClusters = loadedData.precomputed?.atacAligned?.clusters || currentResults.clusters;
          if (atacCoordinates && atacCoordinates.length !== nFiltered) {
            atacCoordinates = null;
            atacClusters = null;
          }

          const ATAC_EXTEND_UP = 5000;
          const ATAC_EXTEND_DOWN = 5000;
          const chrom = peaksOnGene[0].chrom;
          const minStart = Math.min(...peaksOnGene.map(p => Number(p.start) || 0));
          const maxEnd = Math.max(...peaksOnGene.map(p => Number(p.end) || 0));
          const region = { chrom, start: Math.max(0, minStart - ATAC_EXTEND_UP), end: maxEnd + ATAC_EXTEND_DOWN };

          const coverageOnlyPayload = {
            type: 'gene_expression',
            multiomeModality: 'atac',
            coordinates: atacCoordinates ? atacCoordinates.map((c) => [...c]) : null,
            expression: new Float32Array(nFiltered),
            geneName,
            colorMap,
            peaksOnGene: peaksOnGene.map((p) => ({ ...p })),
            coverageByCluster: null,
            region: { ...region },
            genome: loadedData.info?.genome || 'hg38',
            cellBarcodes: filteredBarcodes.length ? [...filteredBarcodes] : undefined,
            clusters: atacClusters ? [...atacClusters] : null,
            isAtac: true,
          };
          atacGeneActivityCache.set(atacCacheKey, coverageOnlyPayload);
          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              type: 'gene_expression',
              multiomeModality: 'atac',
              coordinates: atacCoordinates,
              expression: new Float32Array(nFiltered), // zeros — no gene activity without peak matrix
              geneName,
              colorMap,
              peaksOnGene,
              coverageByCluster: null, // frontend will query atac_fragments.tsv.gz
              region,
              genome: loadedData.info?.genome || 'hg38',
              cellBarcodes: filteredBarcodes.length ? filteredBarcodes : undefined,
              clusters: atacClusters,
              isAtac: true,
            },
          });
          console.log('Multiome: sent coverage-only ATAC data for', geneName);

        } else if (peaksOnGene.length > 0) {
          console.log('Multiome: peaks found for', geneName, 'but no peak matrix indices — skipping ATAC gene activity (use "coverage plot" for fragment-based view)');
        } else {
          console.log('Multiome: no peaks found for gene', geneName, '- skipping ATAC view');
        }
      } catch (atacError) {
        console.warn('Multiome: ATAC gene activity failed (non-fatal):', atacError.message);
      }
    }

  } catch (error) {
    console.error('Gene expression plot failed:', error);
    console.error('Error details:', error.stack);
    // Send error message to UI
    self.postMessage({
      type: 'ANALYSIS_ERROR',
      error: error.message,
      action: 'plot_gene_expression',
      gene: gene,
    });
    throw error;
  }
}

async function plotGeneViolin(params) {
  const { gene } = params || {};

  if (!loadedData) {
    throw new Error('No data loaded. Please load data first.');
  }

  const isPeakId = /^chr\w+[:-]\d+[:-]\d+$/i.test(String(gene || '').trim());

  // Multiome + peak ID: violin plot ATAC-only using peak matrix
  if (loadedData?.info?.modality === 'multiome' && isPeakId) {
    console.log('Multiome violin: plotting peak', gene, 'in ATAC view only');
    const multiomePeak = await getMultiomePeakMatrix();
    if (!multiomePeak) throw new Error('No peak matrix available for ATAC peak violin.');
    const { peakMatrix, peakNames, fullBarcodeOrder } = multiomePeak;
    const peakIdx = findPeakIndex(gene, peakNames);
    if (peakIdx === -1) throw new Error(`Peak ${gene} not found in peak matrix.`);

    // Extract peak values for filtered cells
    const filteredBarcodes = loadedData.cellBarcodes || [];
    const nFiltered = filteredBarcodes.length;
    const barcodeToColIdx = new Map();
    for (let i = 0; i < fullBarcodeOrder.length; i++) barcodeToColIdx.set(fullBarcodeOrder[i], i);

    const fullRow = peakMatrix.row(peakIdx);
    const peakValues = new Float32Array(nFiltered);
    for (let j = 0; j < nFiltered; j++) {
      const colIdx = barcodeToColIdx.get(filteredBarcodes[j]);
      if (colIdx !== undefined) peakValues[j] = Math.log1p(fullRow[colIdx] || 0);
    }

    // Get ATAC clusters
    let atacClusters = loadedData.precomputed?.atacAligned?.clusters || currentResults.clusters;
    if (!atacClusters || atacClusters.length !== nFiltered) atacClusters = currentResults.clusters;
    const clusters = Array.from(atacClusters || []);
    let alignedClusters = clusters;
    if (clusters.length > nFiltered) alignedClusters = clusters.slice(0, nFiltered);

    const uniqueClusters = Array.from(new Set(alignedClusters))
      .filter(c => c !== null && c !== undefined);
    uniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));

    const clusterIndex = new Map(uniqueClusters.map((id, idx) => [id, idx]));
    const expressionByCluster = uniqueClusters.map(() => []);
    for (let i = 0; i < alignedClusters.length; i++) {
      const clusterId = alignedClusters[i];
      if (clusterId === null || clusterId === undefined) continue;
      const targetIndex = clusterIndex.get(clusterId);
      if (targetIndex !== undefined) expressionByCluster[targetIndex].push(peakValues[i]);
    }

    const summaries = expressionByCluster.map((values) => summarizeDistribution(values));
    const typedExpression = expressionByCluster.map((values) => Float32Array.from(values));
    const transferableBuffers = typedExpression.map((arr) => arr.buffer);

    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'gene_violin',
        multiomeModality: 'atac',
        geneName: peakNames[peakIdx],
        clusterIds: uniqueClusters,
        expressionByCluster: typedExpression,
        summary: summaries,
        totalCells: nFiltered,
      }
    }, transferableBuffers);
    console.log('Multiome: sent ATAC peak violin for', peakNames[peakIdx]);
    return;
  }

  // ── scATAC / atac-integration + peak ID: violin plot single peak ───────────
  if ((loadedData.info?.modality === 'atac' || loadedData.info?.modality === 'atac-integration') && isPeakId && loadedData.atacPeakMatrix) {
    const peakMatrix = loadedData.atacPeakMatrix;
    const peakNames = loadedData.atacPeakNames || loadedData.peakNames || [];
    const peakIdx = findPeakIndex(gene, peakNames);
    if (peakIdx === -1) throw new Error(`Peak ${gene} not found in peak matrix (${peakNames.length} peaks available).`);
    const nCells = peakMatrix.numberOfColumns();
    const fullRow = peakMatrix.row(peakIdx);
    const expr = new Float32Array(nCells);
    for (let c = 0; c < nCells; c++) expr[c] = Math.log1p(fullRow[c] || 0);
    const clusters = currentResults.clusters;
    if (!clusters || clusters.length === 0) throw new Error('No clustering results available. Please run analysis first.');
    let alignedClusters = Array.from(clusters);
    if (alignedClusters.length > nCells) alignedClusters = alignedClusters.slice(0, nCells);
    const uniqueClusters = Array.from(new Set(alignedClusters)).filter(c => c !== null && c !== undefined);
    uniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
    const clusterIndex = new Map(uniqueClusters.map((id, idx) => [id, idx]));
    const expressionByCluster = uniqueClusters.map(() => []);
    for (let i = 0; i < alignedClusters.length; i++) {
      const cid = alignedClusters[i]; if (cid === null || cid === undefined) continue;
      const ti = clusterIndex.get(cid); if (ti !== undefined) expressionByCluster[ti].push(expr[i]);
    }
    const summaries = expressionByCluster.map((vals) => summarizeDistribution(vals));
    const typedExpression = expressionByCluster.map((vals) => Float32Array.from(vals));
    const transferableBuffers = typedExpression.map((arr) => arr.buffer);
    const atacIntegrationViews = getAtacIntegrationViewsForPlot();
    if (atacIntegrationViews) {
      const { integrationViews: iViews, datasetNames: iNames } = atacIntegrationViews;
      const viewData = {};
      let globalMin = Infinity, globalMax = -Infinity;
      for (const viewName of iNames) {
        const indices = iViews[viewName]?.indices;
        if (!Array.isArray(indices) || indices.length === 0) continue;
        const viewClusters = indices.map((i) => alignedClusters[i]);
        const viewExpr = indices.map((i) => expr[i]);
        const viewUniqueClusters = Array.from(new Set(viewClusters)).filter((c) => c != null);
        viewUniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
        const clusterIdx = new Map(viewUniqueClusters.map((id, i) => [id, i]));
        const viewExprByCluster = viewUniqueClusters.map(() => []);
        for (let i = 0; i < viewClusters.length; i++) {
          const cid = viewClusters[i]; if (cid == null) continue;
          const ti = clusterIdx.get(cid); if (ti !== undefined) viewExprByCluster[ti].push(viewExpr[i]);
        }
        for (const vals of viewExprByCluster) {
          for (const v of vals) { if (Number.isFinite(v)) { if (v < globalMin) globalMin = v; if (v > globalMax) globalMax = v; } }
        }
        const viewSummaries = viewExprByCluster.map((vals) => summarizeDistribution(vals));
        const viewTyped = viewExprByCluster.map((vals) => Float32Array.from(vals));
        viewData[viewName] = { clusterIds: viewUniqueClusters, expressionByCluster: viewTyped, summary: viewSummaries };
      }
      if (!Number.isFinite(globalMin)) globalMin = 0;
      if (!Number.isFinite(globalMax)) globalMax = globalMin + 1e-6;
      const allTransferables = [];
      for (const vName of Object.keys(viewData)) { viewData[vName].expressionByCluster.forEach((arr) => allTransferables.push(arr.buffer)); }
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: { type: 'gene_violin', geneName: peakNames[peakIdx], integrationViews: iViews, datasetNames: iNames, viewData, globalExpressionRange: [globalMin, globalMax] }
      }, allTransferables);
      console.log('scATAC: sent peak violin for', peakNames[peakIdx]);
      return;
    }
    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'gene_violin',
        geneName: peakNames[peakIdx],
        clusterIds: uniqueClusters,
        expressionByCluster: typedExpression,
        summary: summaries,
        totalCells: nCells,
      }
    }, transferableBuffers);
    console.log('scATAC: sent peak violin for', peakNames[peakIdx]);
    return;
  }

  // ── scATAC-only (or atac-integration) violin via gene activity ────────────
  if (loadedData.info?.modality === 'atac' || loadedData.info?.modality === 'atac-integration') {
    const geneName = (gene && String(gene).trim()) || 'gene';
    const peakMatrix = loadedData.atacPeakMatrix;
    const peakNames = loadedData.atacPeakNames || loadedData.peakNames || [];
    const peakAnnotation = loadedData.peakAnnotation || [];

    if (!peakMatrix) throw new Error('ATAC peak matrix not available for violin plot.');

    let { peakIndices } = getPeaksForGene(geneName, peakAnnotation, peakNames);
    if (peakIndices.length === 0) {
      const genome = loadedData.info?.genome;
      const tssResult = getPeaksForGeneByTSS(geneName, peakAnnotation, peakNames, undefined, genome);
      if (tssResult.peakIndices.length > 0) {
        peakIndices = tssResult.peakIndices;
        console.log(`scATAC violin: ${geneName} linked via TSS (${peakIndices.length} peaks)`);
      } else {
        throw new Error(`No peaks found for gene "${geneName}". Try another gene or check spelling.`);
      }
    }

    const nCells = peakMatrix.numberOfColumns();
    const expr = new Float32Array(nCells);
    for (let c = 0; c < nCells; c++) {
      let sum = 0;
      const col = peakMatrix.column(c);
      for (let p = 0; p < peakIndices.length; p++) sum += col[peakIndices[p]] || 0;
      expr[c] = sum;
    }
    // Use raw counts directly (linear scale) for ATAC gene activity

    const clusters = currentResults.clusters;
    if (!clusters || clusters.length === 0) {
      throw new Error('No clustering results available. Please run analysis first.');
    }
    let alignedClusters = Array.from(clusters);
    if (alignedClusters.length > nCells) alignedClusters = alignedClusters.slice(0, nCells);

    const uniqueClusters = Array.from(new Set(alignedClusters)).filter(c => c !== null && c !== undefined);
    uniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));

    const clusterIndex = new Map(uniqueClusters.map((id, idx) => [id, idx]));
    const expressionByCluster = uniqueClusters.map(() => []);
    for (let i = 0; i < alignedClusters.length; i++) {
      const cid = alignedClusters[i];
      if (cid === null || cid === undefined) continue;
      const ti = clusterIndex.get(cid);
      if (ti !== undefined) expressionByCluster[ti].push(expr[i]);
    }

    const summaries = expressionByCluster.map((values) => summarizeDistribution(values));
    const typedExpression = expressionByCluster.map((values) => Float32Array.from(values));
    const transferableBuffers = typedExpression.map((arr) => arr.buffer);

    const atacIntegrationViews = getAtacIntegrationViewsForPlot();
    if (atacIntegrationViews) {
      // Build per-view violin data for atac-integration
      const { integrationViews: iViews, datasetNames: iNames } = atacIntegrationViews;
      const viewData = {};
      let globalMin = Infinity, globalMax = -Infinity;
      for (const viewName of iNames) {
        const indices = iViews[viewName]?.indices;
        if (!Array.isArray(indices) || indices.length === 0) continue;
        const viewClusters = indices.map((i) => alignedClusters[i]);
        const viewExpr = indices.map((i) => expr[i]);
        const viewUniqueClusters = Array.from(new Set(viewClusters)).filter((c) => c != null);
        viewUniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
        const clusterIdx = new Map(viewUniqueClusters.map((id, i) => [id, i]));
        const viewExprByCluster = viewUniqueClusters.map(() => []);
        for (let i = 0; i < viewClusters.length; i++) {
          const cid = viewClusters[i]; if (cid == null) continue;
          const ti = clusterIdx.get(cid); if (ti !== undefined) viewExprByCluster[ti].push(viewExpr[i]);
        }
        for (const vals of viewExprByCluster) {
          for (const v of vals) { if (Number.isFinite(v)) { if (v < globalMin) globalMin = v; if (v > globalMax) globalMax = v; } }
        }
        const viewSummaries = viewExprByCluster.map((vals) => summarizeDistribution(vals));
        const viewTyped = viewExprByCluster.map((vals) => Float32Array.from(vals));
        viewData[viewName] = { clusterIds: viewUniqueClusters, expressionByCluster: viewTyped, summary: viewSummaries };
      }
      if (!Number.isFinite(globalMin)) globalMin = 0;
      if (!Number.isFinite(globalMax)) globalMax = globalMin + 1e-6;
      const allTransferables = [];
      for (const vName of Object.keys(viewData)) { viewData[vName].expressionByCluster.forEach((arr) => allTransferables.push(arr.buffer)); }
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: { type: 'gene_violin', geneName, integrationViews: iViews, datasetNames: iNames, viewData, globalExpressionRange: [globalMin, globalMax] }
      }, allTransferables);
      console.log('scATAC-integration violin: sent per-view violin for', geneName);
      return;
    }
    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'gene_violin',
        geneName,
        clusterIds: uniqueClusters,
        expressionByCluster: typedExpression,
        summary: summaries,
        totalCells: nCells,
      }
    }, transferableBuffers);
    console.log('scATAC violin: sent gene activity violin for', geneName);
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  try {
    const { geneName, logExpression } = await resolveGeneExpression(gene);
    const state = loadedData.state;

    console.log('plotGeneViolin - Expression length:', logExpression.length);
    console.log('plotGeneViolin - Available cluster sources:', {
      hasCurrentResultsClusters: !!currentResults.clusters,
      currentResultsClustersLength: currentResults.clusters?.length,
      hasStateChooseClustering: !!state?.choose_clustering,
      hasPrecomputedClusters: !!loadedData.precomputed?.clusters,
      precomputedClustersLength: loadedData.precomputed?.clusters?.length,
    });

    // Try to use existing clusters - for multiome RNA use precomputed RNA so RNA view is unchanged after ATAC-only update
    let clusterArray = null;
    if (loadedData?.info?.modality === 'multiome' && loadedData.precomputed?.rnaAligned?.clusters) {
      clusterArray = loadedData.precomputed.rnaAligned.clusters;
      console.log('Using RNA clusters for multiome RNA violin plot:', clusterArray.length);
    }
    if (!clusterArray && currentResults.clusters && Array.isArray(currentResults.clusters)) {
      clusterArray = currentResults.clusters;
      console.log('Using cached clusters for violin plot (aligned with filtered data):', clusterArray.length);
    }

    // Second, try fetching from state (if analysis was run)
    if (!clusterArray && state) {
      clusterArray = state.choose_clustering.fetchClusters();
      if (clusterArray && clusterArray.length > 0) {
        console.log('Using state clusters for violin plot:', clusterArray.length);
      }
    }

    // Third, try precomputed clusters (for Xenium data) - only as fallback
    // Note: These may not be aligned with filtered data, so only use if nothing else available
    if (!clusterArray && loadedData.precomputed?.clusters && Array.isArray(loadedData.precomputed.clusters)) {
      clusterArray = loadedData.precomputed.clusters;
      console.log('Using precomputed clusters for violin plot (may need alignment):', clusterArray.length);
    }

    // Only if no clusters exist at all, run clustering (this should rarely happen)
    if (!clusterArray || clusterArray.length === 0) {
      if (!state) {
        throw new Error('No clustering data available. Please run analysis first or wait for data to finish loading.');
      }
      console.log('No clusters available; running implicit clustering & UMAP for violin plot...');
      await runClusteringAndUMAP(false); // false = don't send UMAP message
      clusterArray = state.choose_clustering.fetchClusters();
    }

    const clusters = Array.from(clusterArray);

    // Handle length mismatch (happens when cells are filtered during QC)
    // Truncate clusters to match expression length (filtered cells)
    let alignedClusters = clusters;
    if (clusters.length !== logExpression.length) {
      if (clusters.length > logExpression.length) {
        // Expected: some cells filtered during QC, truncate clusters to match
        alignedClusters = clusters.slice(0, logExpression.length);
      } else {
        console.error(`Expression array (${logExpression.length}) is longer than clusters (${clusters.length}) - this should not happen`);
        throw new Error(`Cluster assignments length (${clusters.length}) is less than expression length (${logExpression.length})`);
      }
    }

    // Filter out null/undefined clusters and get unique valid clusters
    const uniqueClusters = Array.from(new Set(alignedClusters))
      .filter(c => c !== null && c !== undefined);
    uniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));

    console.log(`Valid clusters for violin plot: ${uniqueClusters.length} clusters (filtered out null/undefined)`);

    const clusterIndex = new Map(uniqueClusters.map((id, idx) => [id, idx]));
    const expressionByCluster = uniqueClusters.map(() => []);
    for (let i = 0; i < alignedClusters.length; i++) {
      const clusterId = alignedClusters[i];
      // Skip null/undefined clusters
      if (clusterId === null || clusterId === undefined) {
        continue;
      }
      const targetIndex = clusterIndex.get(clusterId);
      if (targetIndex !== undefined) {
        expressionByCluster[targetIndex].push(logExpression[i]);
      }
    }

    const summaries = expressionByCluster.map((values) => summarizeDistribution(values));
    const typedExpression = expressionByCluster.map((values) => Float32Array.from(values));
    const transferableBuffers = typedExpression.map((arr) => arr.buffer);

    // Integration: per-sample violin with global normalization (same gene expression scale across views)
    const integrationMeta = getIntegrationViewsForPlot(logExpression.length);
    if (integrationMeta) {
      const { integrationViews, datasetNames } = integrationMeta;
      const viewData = {};
      let globalMin = Infinity;
      let globalMax = -Infinity;
      for (const viewName of datasetNames) {
        const indices = integrationViews[viewName]?.indices;
        if (!Array.isArray(indices) || indices.length === 0) continue;
        const viewClusters = indices.map((i) => alignedClusters[i]);
        const viewExpr = indices.map((i) => logExpression[i]);
        const viewUniqueClusters = Array.from(new Set(viewClusters))
          .filter((c) => c !== null && c !== undefined);
        viewUniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
        const clusterIndex = new Map(viewUniqueClusters.map((id, idx) => [id, idx]));
        const viewExprByCluster = viewUniqueClusters.map(() => []);
        for (let i = 0; i < viewClusters.length; i++) {
          const cid = viewClusters[i];
          if (cid == null) continue;
          const ti = clusterIndex.get(cid);
          if (ti !== undefined) viewExprByCluster[ti].push(viewExpr[i]);
        }
        for (const vals of viewExprByCluster) {
          for (let j = 0; j < vals.length; j++) {
            const v = vals[j];
            if (Number.isFinite(v)) {
              if (v < globalMin) globalMin = v;
              if (v > globalMax) globalMax = v;
            }
          }
        }
        const viewSummaries = viewExprByCluster.map((values) => summarizeDistribution(values));
        const viewTyped = viewExprByCluster.map((values) => Float32Array.from(values));
        viewData[viewName] = {
          clusterIds: viewUniqueClusters,
          expressionByCluster: viewTyped,
          summary: viewSummaries,
        };
      }
      if (!Number.isFinite(globalMin)) globalMin = 0;
      if (!Number.isFinite(globalMax)) globalMax = globalMin + 1e-6;
      const allTransferables = [];
      for (const viewName of Object.keys(viewData)) {
        viewData[viewName].expressionByCluster.forEach((arr) => allTransferables.push(arr.buffer));
      }
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'gene_violin',
          geneName,
          integrationViews,
          datasetNames,
          viewData,
          globalExpressionRange: [globalMin, globalMax],
        }
      }, allTransferables);
      console.log('Integration: sent gene violin with per-view data for', geneName);
      return;
    }

    // For spatial datasets, also include spatial coordinates so the spatial view can show gene expression scatter plot
    let spatialCoordinates = null;
    const spatialDataSource = loadedData?.spatialData || spatialData;
    console.log('Checking for spatial coordinates in violin plot:', {
      hasLoadedDataSpatialData: !!loadedData?.spatialData,
      hasGlobalSpatialData: !!spatialData,
      hasCoordinatesInLoadedData: Array.isArray(loadedData?.spatialData?.coordinates),
      coordinatesLengthInLoadedData: loadedData?.spatialData?.coordinates?.length,
      expressionLength: logExpression.length,
    });

    if (spatialDataSource && Array.isArray(spatialDataSource.coordinates) && spatialDataSource.coordinates.length > 0) {
      let allSpatialCoords = spatialDataSource.coordinates.map(coord => {
        if (coord == null) return [0, 0];
        return Array.isArray(coord) ? [coord[0] ?? 0, coord[1] ?? 0] : [coord.x ?? 0, coord.y ?? 0];
      });

      // IMPORTANT: Truncate spatial coordinates to match expression length (same filtering as clusters)
      if (allSpatialCoords.length > logExpression.length) {
        console.log(`Truncating spatial coordinates from ${allSpatialCoords.length} to ${logExpression.length} to match expression (QC filtered)`);
        spatialCoordinates = allSpatialCoords.slice(0, logExpression.length);
      } else if (allSpatialCoords.length === logExpression.length) {
        spatialCoordinates = allSpatialCoords;
      } else {
        console.warn(`Spatial coordinates (${allSpatialCoords.length}) is less than expression (${logExpression.length}) - skipping spatial coordinates`);
        spatialCoordinates = null;
      }

      if (spatialCoordinates) {
        console.log(`Including spatial coordinates for violin plot: ${spatialCoordinates.length} cells`);
      }
    } else {
      console.log('No spatial coordinates available for violin plot');
    }

    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'gene_violin',
        geneName,
        clusterIds: uniqueClusters,
        expressionByCluster: typedExpression,
        summary: summaries,
        totalCells: logExpression.length,
        // Include expression and spatial coordinates for the spatial view
        expression: logExpression,
        spatialCoordinates: spatialCoordinates,
      }
    }, transferableBuffers);

    // Multiome: also compute ATAC gene activity violin and send to ATAC view
    if (loadedData?.info?.modality === 'multiome' && loadedData.peakAnnotation?.length > 0) {
      try {
        console.log('Multiome violin: computing ATAC gene activity violin for', geneName);
        const peakAnnotation = loadedData.peakAnnotation;
        const multiomePeak = await getMultiomePeakMatrix();
        const peakNames = multiomePeak?.peakNames || [];

        if (multiomePeak) {
          const { peakIndices } = getPeaksForGene(geneName, peakAnnotation, peakNames);

          if (peakIndices.length > 0) {
            const { peakMatrix, fullBarcodeOrder } = multiomePeak;
            const filteredBarcodes = loadedData.cellBarcodes || [];
            const nFiltered = filteredBarcodes.length;
            const barcodeToColIdx = new Map();
            for (let i = 0; i < fullBarcodeOrder.length; i++) {
              barcodeToColIdx.set(fullBarcodeOrder[i], i);
            }

            // Gene activity: sum peak counts per cell
            const atacExpression = new Float32Array(nFiltered);
            for (let j = 0; j < nFiltered; j++) {
              const colIdx = barcodeToColIdx.get(filteredBarcodes[j]);
              if (colIdx === undefined) continue;
              const col = peakMatrix.column(colIdx);
              let sum = 0;
              for (let p = 0; p < peakIndices.length; p++) {
                sum += col[peakIndices[p]] || 0;
              }
              atacExpression[j] = sum;
            }
            // Use raw counts directly (linear scale) for ATAC gene activity

            // Use ATAC clusters
            let atacClusters = loadedData.precomputed?.atacAligned?.clusters;
            if (!atacClusters || atacClusters.length !== nFiltered) {
              atacClusters = alignedClusters; // fallback to RNA clusters
            }
            let atacClusterArr = Array.from(atacClusters);
            if (atacClusterArr.length > nFiltered) {
              atacClusterArr = atacClusterArr.slice(0, nFiltered);
            }

            const atacUniqueClusters = Array.from(new Set(atacClusterArr))
              .filter(c => c !== null && c !== undefined);
            atacUniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));

            const atacClusterIndex = new Map(atacUniqueClusters.map((id, idx) => [id, idx]));
            const atacExprByCluster = atacUniqueClusters.map(() => []);
            for (let i = 0; i < atacClusterArr.length; i++) {
              const clusterId = atacClusterArr[i];
              if (clusterId === null || clusterId === undefined) continue;
              const targetIndex = atacClusterIndex.get(clusterId);
              if (targetIndex !== undefined) {
                atacExprByCluster[targetIndex].push(atacExpression[i]);
              }
            }

            const atacSummaries = atacExprByCluster.map((values) => summarizeDistribution(values));
            const atacTypedExpression = atacExprByCluster.map((values) => Float32Array.from(values));
            const atacTransferables = atacTypedExpression.map((arr) => arr.buffer);

            self.postMessage({
              type: 'ANALYSIS_COMPLETE',
              data: {
                type: 'gene_violin',
                multiomeModality: 'atac',
                geneName,
                clusterIds: atacUniqueClusters,
                expressionByCluster: atacTypedExpression,
                summary: atacSummaries,
                totalCells: nFiltered,
              }
            }, atacTransferables);
            console.log('Multiome violin: sent ATAC gene activity violin for', geneName);
          } else {
            console.log('Multiome violin: no peaks found for gene', geneName, '- skipping ATAC violin');
          }
        } else {
          console.log('Multiome violin: no peak matrix available, skipping ATAC violin');
        }
      } catch (atacErr) {
        console.warn('Multiome violin: ATAC gene activity violin failed (non-fatal):', atacErr);
      }
    }

  } catch (error) {
    console.error('Gene violin plot failed:', error);
    console.error('Error details:', error.stack);
    throw error;
  }
}

const DEFAULT_DOTPLOT_COLORMAP = { type: 'custom', colors: ['lightgray', 'orange', 'red'] };

function normalizeDotplotColorMap(colorMap) {
  if (colorMap && typeof colorMap === 'object') {
    if (colorMap.type === 'custom' && Array.isArray(colorMap.colors) && colorMap.colors.length >= 3) return colorMap;
    if (colorMap.type === 'scheme' && colorMap.name) return colorMap;
  }
  return DEFAULT_DOTPLOT_COLORMAP;
}

async function plotGeneDotplot(params) {
  try {
    console.log('====== WORKER: plotGeneDotplot called ======');
    console.log('Params:', params);
    
    const { genes, gene, colorMap } = params || {};
    const appliedColorMap = normalizeDotplotColorMap(colorMap);

    if (!loadedData) {
      throw new Error('No data loaded. Please load data first.');
    }

    // ── scATAC-only (or atac-integration) dotplot via gene activity ──────────
    if (loadedData.info?.modality === 'atac' || loadedData.info?.modality === 'atac-integration') {
      const peakMatrix = loadedData.atacPeakMatrix;
      const peakNames = loadedData.atacPeakNames || loadedData.peakNames || [];
      const peakAnnotation = loadedData.peakAnnotation || [];

      if (!peakMatrix) {
        throw new Error('ATAC peak matrix not available for dot plot.');
      }

      // Collect unique gene names from params
      const scatacRequestedGenes = [];
      const scatacCollect = (value) => {
        if (typeof value !== 'string') return;
        value.split(/[,;\s]+/).map(t => t.trim()).filter(t => t.length > 0)
          .forEach(t => scatacRequestedGenes.push(t));
      };
      if (Array.isArray(genes)) genes.forEach(g => scatacCollect(g));
      else scatacCollect(genes);
      if (gene) scatacCollect(gene);

      const scatacSeen = new Set();
      const scatacUniqueGenes = scatacRequestedGenes.filter(g => {
        const n = normalizeGeneName(g);
        if (!n || scatacSeen.has(n)) return false;
        scatacSeen.add(n);
        return true;
      });

      if (!scatacUniqueGenes.length) {
        throw new Error('No valid genes provided for dot plot.');
      }

      const nCells = peakMatrix.numberOfColumns();
      const clusters = currentResults.clusters;
      if (!clusters || clusters.length === 0) {
        throw new Error('No clustering results available. Please run analysis first.');
      }

      const peakIdRegex = /^chr\w+[:-]\d+[:-]\d+$/i;
      const resolvedGeneNames = [];
      const geneActivityExprs = [];

      for (const gName of scatacUniqueGenes) {
        let peakIndices;
        if (peakIdRegex.test(gName)) {
          const peakIdx = findPeakIndex(gName, peakNames);
          if (peakIdx === -1) {
            console.warn(`scATAC dotplot: peak ${gName} not found in peak matrix, skipping`);
            continue;
          }
          peakIndices = [peakIdx];
        } else {
          let result = getPeaksForGene(gName, peakAnnotation, peakNames);
          if (result.peakIndices.length === 0) {
            const genome = loadedData.info?.genome;
            const tssResult = getPeaksForGeneByTSS(gName, peakAnnotation, peakNames, undefined, genome);
            if (tssResult.peakIndices.length > 0) {
              result = tssResult;
              console.log(`scATAC dotplot: ${gName} linked via TSS (${result.peakIndices.length} peaks)`);
            } else {
              console.warn(`scATAC dotplot: no peaks found for gene ${gName}, skipping`);
              continue;
            }
          }
          peakIndices = result.peakIndices;
        }
        const expr = new Float32Array(nCells);
        for (let c = 0; c < nCells; c++) {
          let sum = 0;
          const col = peakMatrix.column(c);
          for (let p = 0; p < peakIndices.length; p++) sum += col[peakIndices[p]] || 0;
          expr[c] = sum;
        }
        // Use raw counts directly (linear scale) for ATAC gene activity
        resolvedGeneNames.push(peakIdRegex.test(gName) ? peakNames[peakIndices[0]] : gName);
        geneActivityExprs.push(expr);
      }

      if (!resolvedGeneNames.length) {
        throw new Error(`No peaks found for the requested gene(s). Try another gene or check spelling.`);
      }

      // Align clusters to nCells
      let alignedClusters = Array.from(clusters);
      if (alignedClusters.length > nCells) alignedClusters = alignedClusters.slice(0, nCells);
      const nAligned = alignedClusters.length;

      const uniqueClusters = Array.from(new Set(alignedClusters)).filter(c => c !== null && c !== undefined);
      uniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
      const nClusters = uniqueClusters.length;
      const nGenes = resolvedGeneNames.length;
      const clusterIndexMap = new Map(uniqueClusters.map((id, idx) => [id, idx]));
      const clusterCellCounts = new Array(nClusters).fill(0);
      const clusterIndicesPerCell = new Int32Array(nAligned);
      for (let i = 0; i < nAligned; i++) {
        const idx = clusterIndexMap.get(alignedClusters[i]);
        clusterIndicesPerCell[i] = idx !== undefined ? idx : -1;
        if (idx !== undefined) clusterCellCounts[idx]++;
      }

      const percentExpressing = Array.from({ length: nClusters }, () => new Float32Array(nGenes));
      const averageExpression = Array.from({ length: nClusters }, () => new Float32Array(nGenes));
      let globalMin = Infinity, globalMax = -Infinity;

      for (let gi = 0; gi < nGenes; gi++) {
        const expr = geneActivityExprs[gi];
        const detectedCounts = new Array(nClusters).fill(0);
        const expressionSums = new Array(nClusters).fill(0);
        for (let cell = 0; cell < nAligned; cell++) {
          const ci = clusterIndicesPerCell[cell];
          if (ci < 0) continue;
          const value = expr[cell];
          if (value > 0) { detectedCounts[ci]++; expressionSums[ci] += value; }
        }
        for (let ci = 0; ci < nClusters; ci++) {
          const total = clusterCellCounts[ci];
          const detected = detectedCounts[ci];
          percentExpressing[ci][gi] = total > 0 ? detected / total : 0;
          const avg = detected > 0 ? expressionSums[ci] / detected : 0;
          averageExpression[ci][gi] = avg;
          if (avg > 0) { if (avg < globalMin) globalMin = avg; if (avg > globalMax) globalMax = avg; }
        }
      }
      if (!Number.isFinite(globalMin)) globalMin = 0;
      if (!Number.isFinite(globalMax)) globalMax = 1;
      else if (globalMin === globalMax) globalMax = globalMin + 1e-3;

      const transferables = [];
      for (let ci = 0; ci < nClusters; ci++) {
        transferables.push(percentExpressing[ci].buffer, averageExpression[ci].buffer);
      }
      const atacIntegrationViewsDotplot = getAtacIntegrationViewsForPlot();
      if (atacIntegrationViewsDotplot) {
        // Build per-view dotplot data for atac-integration
        const { integrationViews: iViews, datasetNames: iNames } = atacIntegrationViewsDotplot;
        const viewData = {};
        for (const viewName of iNames) {
          const indices = iViews[viewName]?.indices;
          if (!Array.isArray(indices) || indices.length === 0) continue;
          const viewClusterArr = indices.map((i) => alignedClusters[i]);
          const viewUnique = Array.from(new Set(viewClusterArr)).filter((c) => c != null);
          viewUnique.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
          const viewClusterIdxMap = new Map(viewUnique.map((id, i) => [id, i]));
          const nVC = viewUnique.length;
          const vCellCounts = new Array(nVC).fill(0);
          const vClusterIndices = new Int32Array(indices.length);
          for (let i = 0; i < indices.length; i++) {
            const ci = viewClusterIdxMap.get(viewClusterArr[i]);
            vClusterIndices[i] = ci !== undefined ? ci : -1;
            if (ci !== undefined) vCellCounts[ci]++;
          }
          const vPct = Array.from({ length: nVC }, () => new Float32Array(nGenes));
          const vAvg = Array.from({ length: nVC }, () => new Float32Array(nGenes));
          for (let gi = 0; gi < nGenes; gi++) {
            const exprFull = geneActivityExprs[gi];
            const detCounts = new Array(nVC).fill(0);
            const exprSums = new Array(nVC).fill(0);
            for (let i = 0; i < indices.length; i++) {
              const ci = vClusterIndices[i]; if (ci < 0) continue;
              const v = exprFull[indices[i]];
              if (v > 0) { detCounts[ci]++; exprSums[ci] += v; }
            }
            for (let ci = 0; ci < nVC; ci++) {
              const tot = vCellCounts[ci];
              vPct[ci][gi] = tot > 0 ? detCounts[ci] / tot : 0;
              vAvg[ci][gi] = detCounts[ci] > 0 ? exprSums[ci] / detCounts[ci] : 0;
            }
          }
          const vTransfer = [];
          for (let ci = 0; ci < nVC; ci++) { vTransfer.push(vPct[ci].buffer, vAvg[ci].buffer); }
          viewData[viewName] = { clusterIds: viewUnique, percentExpressing: vPct, averageExpression: vAvg, clusterCellCounts: vCellCounts, totalCells: indices.length };
        }
        const allTransferables2 = [];
        for (const vn of Object.keys(viewData)) {
          for (let ci = 0; ci < viewData[vn].clusterIds.length; ci++) {
            allTransferables2.push(viewData[vn].percentExpressing[ci].buffer, viewData[vn].averageExpression[ci].buffer);
          }
        }
        self.postMessage({
          type: 'ANALYSIS_COMPLETE',
          data: { type: 'gene_dotplot', geneNames: resolvedGeneNames, integrationViews: iViews, datasetNames: iNames, viewData, expressionRange: [globalMin, globalMax], colorMap: appliedColorMap }
        }, allTransferables2);
        console.log('scATAC-integration dotplot: sent per-view dotplot for', resolvedGeneNames.join(', '));
        return;
      }
      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'gene_dotplot',
          geneNames: resolvedGeneNames,
          clusterIds: uniqueClusters,
          percentExpressing,
          averageExpression,
          clusterCellCounts,
          totalCells: nAligned,
          expressionRange: [globalMin, globalMax],
          colorMap: appliedColorMap,
        }
      }, transferables);
      console.log('scATAC dotplot: sent gene activity dot plot for', resolvedGeneNames.join(', '));
      return;
    }
    // ─────────────────────────────────────────────────────────────────────

    if (!loadedData.state) {
      throw new Error('No data loaded. Please load data first.');
    }

    const requestedGenes = [];

    const collectFromString = (value) => {
      if (typeof value !== 'string') {
        return;
      }
      value
        .split(/[,;\s]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0)
        .forEach((token) => requestedGenes.push(token));
    };

    if (Array.isArray(genes)) {
      genes.forEach((entry) => {
        if (typeof entry === 'string') {
          collectFromString(entry);
        }
      });
    } else {
      collectFromString(genes);
    }

    if (gene) {
      collectFromString(gene);
    }

    const uniqueGenes = [];
    const seen = new Set();
    for (const g of requestedGenes) {
      const normalized = normalizeGeneName(g);
      if (!normalized) {
        continue;
      }
      if (!seen.has(normalized)) {
        seen.add(normalized);
        uniqueGenes.push(g);
      }
    }

    if (!uniqueGenes.length) {
      throw new Error('No valid genes provided for dot plot.');
    }

    // For spatial data (Xenium), only use the first gene
    const modality = loadedData.info?.modality || loadedData.modality;
    console.log('Dot plot: Detected modality:', modality);
    const genesToPlot = (modality === 'spatial' && uniqueGenes.length > 1)
      ? [uniqueGenes[0]]
      : uniqueGenes;

    if (modality === 'spatial' && uniqueGenes.length > 1) {
      console.log(`Spatial data: using only first gene (${genesToPlot[0]}) out of ${uniqueGenes.length} requested genes`);
    }

    // Multiome + all peak IDs: dotplot ATAC-only using peak matrix
    const peakIdRegex = /^chr\w+:\d+-\d+$/i;
    const allPeakIds = genesToPlot.every(g => peakIdRegex.test(g.trim()));
    if (modality === 'multiome' && allPeakIds) {
      console.log('Multiome dotplot: all features are peaks, plotting ATAC-only');
      const multiomePeak = await getMultiomePeakMatrix();
      if (!multiomePeak) throw new Error('No peak matrix available for ATAC peak dotplot.');
      const { peakMatrix, peakNames, fullBarcodeOrder } = multiomePeak;

      // Resolve each peak
      const resolvedPeakNames = [];
      const peakExpressions = [];
      for (const p of genesToPlot) {
        const peakIdx = findPeakIndex(p, peakNames);
        if (peakIdx === -1) {
          console.warn(`Dotplot: peak ${p} not found in peak matrix, skipping`);
          continue;
        }
        resolvedPeakNames.push(peakNames[peakIdx]);
        const filteredBarcodes = loadedData.cellBarcodes || [];
        const nFiltered = filteredBarcodes.length;
        const barcodeToColIdx = new Map();
        for (let i = 0; i < fullBarcodeOrder.length; i++) barcodeToColIdx.set(fullBarcodeOrder[i], i);
        const fullRow = peakMatrix.row(peakIdx);
        const vals = new Float32Array(nFiltered);
        for (let j = 0; j < nFiltered; j++) {
          const colIdx = barcodeToColIdx.get(filteredBarcodes[j]);
          if (colIdx !== undefined) vals[j] = Math.log1p(fullRow[colIdx] || 0);
        }
        peakExpressions.push(vals);
      }

      if (!resolvedPeakNames.length) throw new Error('No valid peaks found in peak matrix.');

      // Get ATAC clusters
      const filteredBarcodes = loadedData.cellBarcodes || [];
      const nFiltered = filteredBarcodes.length;
      let atacClusters = loadedData.precomputed?.atacAligned?.clusters || currentResults.clusters;
      if (!atacClusters || atacClusters.length !== nFiltered) atacClusters = currentResults.clusters;
      const clusters = Array.from(atacClusters || []);
      let alignedClusters = clusters;
      if (clusters.length > nFiltered) alignedClusters = clusters.slice(0, nFiltered);
      const nCells = Math.min(alignedClusters.length, nFiltered);

      const uniqueClusters = Array.from(new Set(alignedClusters))
        .filter(c => c !== null && c !== undefined);
      uniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
      const nClusters = uniqueClusters.length;
      const nPeaks = resolvedPeakNames.length;

      const clusterIndexMap = new Map(uniqueClusters.map((id, idx) => [id, idx]));
      const clusterCellCounts = new Array(nClusters).fill(0);
      const clusterIndicesPerCell = new Int32Array(nCells);
      for (let i = 0; i < nCells; i++) {
        const cid = alignedClusters[i];
        const idx = clusterIndexMap.get(cid);
        clusterIndicesPerCell[i] = idx !== undefined ? idx : -1;
        if (idx !== undefined) clusterCellCounts[idx]++;
      }

      const percentExpressing = Array.from({ length: nClusters }, () => new Float32Array(nPeaks));
      const averageExpression = Array.from({ length: nClusters }, () => new Float32Array(nPeaks));
      let globalMin = Infinity, globalMax = -Infinity;

      for (let peakIdx = 0; peakIdx < nPeaks; peakIdx++) {
        const expr = peakExpressions[peakIdx];
        const detectedCounts = new Array(nClusters).fill(0);
        const expressionSums = new Array(nClusters).fill(0);
        for (let cell = 0; cell < nCells; cell++) {
          const ci = clusterIndicesPerCell[cell];
          if (ci < 0) continue;
          const value = expr[cell];
          if (value > 0) {
            detectedCounts[ci]++;
            expressionSums[ci] += value;
          }
        }
        for (let ci = 0; ci < nClusters; ci++) {
          const total = clusterCellCounts[ci];
          const detected = detectedCounts[ci];
          percentExpressing[ci][peakIdx] = total > 0 ? detected / total : 0;
          const avg = detected > 0 ? expressionSums[ci] / detected : 0;
          averageExpression[ci][peakIdx] = avg;
          if (avg > 0) {
            if (avg < globalMin) globalMin = avg;
            if (avg > globalMax) globalMax = avg;
          }
        }
      }
      if (!Number.isFinite(globalMin)) globalMin = 0;
      if (!Number.isFinite(globalMax)) globalMax = 1;

      const transferables = [];
      for (let ci = 0; ci < nClusters; ci++) {
        transferables.push(percentExpressing[ci].buffer, averageExpression[ci].buffer);
      }

      self.postMessage({
        type: 'ANALYSIS_COMPLETE',
        data: {
          type: 'gene_dotplot',
          multiomeModality: 'atac',
          geneNames: resolvedPeakNames,
          clusterIds: uniqueClusters,
          percentExpressing,
          averageExpression,
          clusterCellCounts,
          totalCells: nCells,
          expressionRange: [globalMin, globalMax],
          colorMap: appliedColorMap,
        }
      }, transferables);
      console.log('Multiome: sent ATAC peak dotplot for', resolvedPeakNames.join(', '));
      return;
    }

    console.log('Dot plot: Resolving gene expressions for:', genesToPlot);
    const { geneNames, logExpressions } = await resolveGeneExpressions(genesToPlot);
    console.log('Dot plot: Gene names resolved:', geneNames);
    console.log('Dot plot: Expression array lengths:', logExpressions.map(arr => arr.length));

    const state = loadedData.state;

    // Ensure clustering has been performed; for multiome RNA use precomputed RNA clusters so RNA view is unchanged after ATAC-only update
    let clusters = currentResults.clusters;
    if (loadedData?.info?.modality === 'multiome' && loadedData.precomputed?.rnaAligned?.clusters) {
      clusters = loadedData.precomputed.rnaAligned.clusters;
      console.log('Dot plot: using RNA clusters for multiome RNA view');
    }
    if (!clusters || clusters.length === 0) {
      console.log('Dot plot: No cached clusters, fetching from state...');
      let clusterArray = state.choose_clustering.fetchClusters();
      if (!clusterArray || clusterArray.length === 0) {
        console.log('Dot plot: No clusters in state, running clustering...');
        await runClusteringAndUMAP(false); // false = don't send UMAP message
        clusterArray = state.choose_clustering.fetchClusters();
      }
      clusters = Array.from(clusterArray);
    }

    console.log('Dot plot: Using clusters, length:', clusters.length);

    // Get the number of cells in the normalized matrix
    const normMatrix = state.rna_normalization.fetchNormalizedMatrix();
    const nCellsInMatrix = normMatrix.numberOfColumns();
    console.log('Dot plot: Normalized matrix columns:', nCellsInMatrix);

    // If clusters array is longer than the normalized matrix, it means some cells were filtered
    // We need to match the lengths - assume the first nCellsInMatrix cells are retained
    if (clusters.length > nCellsInMatrix) {
      console.log(`Dot plot: Trimming clusters array from ${clusters.length} to ${nCellsInMatrix} to match filtered cells`);
      clusters = clusters.slice(0, nCellsInMatrix);
    }

  const uniqueClusters = Array.from(new Set(clusters));
  uniqueClusters.sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b;
    }
    return String(a).localeCompare(String(b));
  });

  const clusterIndexLookup = new Map(uniqueClusters.map((id, idx) => [id, idx]));
  const nClusters = uniqueClusters.length;
  const nGenes = geneNames.length;

  if (!nClusters) {
    throw new Error('No clusters available for dot plot.');
  }

  const clusterCellCounts = new Array(nClusters).fill(0);
  const clusterIndicesPerCell = new Array(clusters.length);
  for (let i = 0; i < clusters.length; i++) {
    const idx = clusterIndexLookup.get(clusters[i]);
    clusterIndicesPerCell[i] = idx;
    if (idx !== undefined) {
      clusterCellCounts[idx] += 1;
    }
  }

  const percentExpressing = Array.from({ length: nClusters }, () => new Float32Array(nGenes));
  const averageExpression = Array.from({ length: nClusters }, () => new Float32Array(nGenes));

  let globalMin = Infinity;
  let globalMax = -Infinity;

  const nCells = clusters.length;

  for (let geneIdx = 0; geneIdx < nGenes; geneIdx++) {
    const logExpr = logExpressions[geneIdx];
    if (!logExpr || logExpr.length !== nCells) {
      throw new Error(`Expression vector length mismatch for gene index ${geneIdx}`);
    }

    const detectedCounts = new Array(nClusters).fill(0);
    const expressionSums = new Array(nClusters).fill(0);

    for (let cell = 0; cell < nCells; cell++) {
      const clusterIdx = clusterIndicesPerCell[cell];
      if (clusterIdx === undefined || clusterIdx === null) {
        continue;
      }
      const value = logExpr[cell];
      if (value > 0) {
        detectedCounts[clusterIdx] += 1;
        expressionSums[clusterIdx] += value;
      }
    }

    for (let clusterIdx = 0; clusterIdx < nClusters; clusterIdx++) {
      const totalCells = clusterCellCounts[clusterIdx];
      const detected = detectedCounts[clusterIdx];
      const percent = totalCells > 0 ? detected / totalCells : 0;
      const mean = detected > 0 ? expressionSums[clusterIdx] / detected : 0;

      percentExpressing[clusterIdx][geneIdx] = percent;
      averageExpression[clusterIdx][geneIdx] = mean;

      if (detected > 0) {
        if (mean < globalMin) {
          globalMin = mean;
        }
        if (mean > globalMax) {
          globalMax = mean;
        }
      }
    }
  }

  if (!Number.isFinite(globalMin) || !Number.isFinite(globalMax)) {
    globalMin = 0;
    globalMax = 1;
  } else if (globalMin === globalMax) {
    globalMax = globalMin + 1e-3;
  }

  // Integration: per-sample dotplot with global normalization (same expression scale across views)
  const integrationMeta = getIntegrationViewsForPlot(nCells);
  if (integrationMeta) {
    const { integrationViews, datasetNames } = integrationMeta;
    const viewData = {};
    const transferables = [];
    for (const viewName of datasetNames) {
      const indices = integrationViews[viewName]?.indices;
      if (!Array.isArray(indices) || indices.length === 0) continue;
      const viewClusters = indices.map((i) => clusters[i]);
      const viewUniqueClusters = Array.from(new Set(viewClusters))
        .filter((c) => c !== null && c !== undefined);
      viewUniqueClusters.sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
      const clusterIndexMap = new Map(viewUniqueClusters.map((id, idx) => [id, idx]));
      const nViewClusters = viewUniqueClusters.length;
      const viewClusterCellCounts = new Array(nViewClusters).fill(0);
      const viewClusterIndicesPerCell = indices.map((i) => clusterIndexMap.get(clusters[i]));
      for (let i = 0; i < viewClusterIndicesPerCell.length; i++) {
        const idx = viewClusterIndicesPerCell[i];
        if (idx !== undefined && idx !== null) viewClusterCellCounts[idx]++;
      }
      const viewPercentExpressing = Array.from({ length: nViewClusters }, () => new Float32Array(nGenes));
      const viewAverageExpression = Array.from({ length: nViewClusters }, () => new Float32Array(nGenes));
      for (let geneIdx = 0; geneIdx < nGenes; geneIdx++) {
        const logExpr = logExpressions[geneIdx];
        const detectedCounts = new Array(nViewClusters).fill(0);
        const expressionSums = new Array(nViewClusters).fill(0);
        for (let k = 0; k < indices.length; k++) {
          const cell = indices[k];
          const clusterIdx = viewClusterIndicesPerCell[k];
          if (clusterIdx === undefined || clusterIdx === null) continue;
          const value = logExpr[cell];
          if (value > 0) {
            detectedCounts[clusterIdx]++;
            expressionSums[clusterIdx] += value;
          }
        }
        for (let ci = 0; ci < nViewClusters; ci++) {
          const total = viewClusterCellCounts[ci];
          const detected = detectedCounts[ci];
          viewPercentExpressing[ci][geneIdx] = total > 0 ? detected / total : 0;
          viewAverageExpression[ci][geneIdx] = detected > 0 ? expressionSums[ci] / detected : 0;
        }
      }
      viewData[viewName] = {
        clusterIds: viewUniqueClusters,
        percentExpressing: viewPercentExpressing,
        averageExpression: viewAverageExpression,
        clusterCellCounts: viewClusterCellCounts,
        totalCells: indices.length,
      };
      viewPercentExpressing.forEach((row) => transferables.push(row.buffer));
      viewAverageExpression.forEach((row) => transferables.push(row.buffer));
    }
    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'gene_dotplot',
        geneNames,
        integrationViews,
        datasetNames,
        viewData,
        expressionRange: [globalMin, globalMax],
        colorMap: appliedColorMap,
      }
    }, transferables);
    console.log('Integration: sent gene dotplot with per-view data for', geneNames.join(', '));
    return;
  }

  const transferables = [];
  percentExpressing.forEach((row) => transferables.push(row.buffer));
  averageExpression.forEach((row) => transferables.push(row.buffer));

  // For spatial data, also include gene expression data for the first gene
  // so the spatial view can show the scatter plot
  let spatialGeneExpression = null;
  if (modality === 'spatial' && geneNames.length > 0) {
    spatialGeneExpression = {
      geneName: geneNames[0],
      expression: logExpressions[0],
      colorMap: appliedColorMap,
    };
    transferables.push(logExpressions[0].buffer);
  }

  console.log('====== DOT PLOT: About to send message ======');
  console.log('Dot plot: Sending results to UI with', geneNames.length, 'genes and', uniqueClusters.length, 'clusters');
  console.log('percentExpressing array length:', percentExpressing.length);
  console.log('averageExpression array length:', averageExpression.length);
  console.log('transferables count:', transferables.length);
  console.log('colorMap:', colorMap);
  console.log('spatialGeneExpression:', spatialGeneExpression ? `gene ${spatialGeneExpression.geneName}` : 'none');

  const messageData = {
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'gene_dotplot',
      geneNames,
      clusterIds: uniqueClusters,
      percentExpressing,
      averageExpression,
      clusterCellCounts,
      totalCells: nCells,
      expressionRange: [globalMin, globalMax],
      colorMap: appliedColorMap,
      spatialGeneExpression, // Include gene expression for spatial view
    }
  };
  
  console.log('Message data structure:', {
    type: messageData.type,
    dataType: messageData.data.type,
    hasGeneNames: !!messageData.data.geneNames,
    hasClusterIds: !!messageData.data.clusterIds,
    hasPercentExpressing: !!messageData.data.percentExpressing,
    hasAverageExpression: !!messageData.data.averageExpression,
    colorMap: messageData.data.colorMap,
  });
  
  self.postMessage(messageData, transferables);
  console.log('====== DOT PLOT: Message sent successfully ======');

  // Multiome: also compute ATAC gene activity dotplot and send to ATAC view
  if (loadedData?.info?.modality === 'multiome' && loadedData.peakAnnotation?.length > 0) {
    try {
      console.log('Multiome dotplot: computing ATAC gene activity dotplot for', geneNames);
      const peakAnnotation = loadedData.peakAnnotation;
      const multiomePeak = await getMultiomePeakMatrix();
      const peakNames = multiomePeak?.peakNames || [];

      if (multiomePeak) {
        const { peakMatrix, fullBarcodeOrder } = multiomePeak;
        const filteredBarcodes = loadedData.cellBarcodes || [];
        const nFiltered = filteredBarcodes.length;
        const barcodeToColIdx = new Map();
        for (let i = 0; i < fullBarcodeOrder.length; i++) {
          barcodeToColIdx.set(fullBarcodeOrder[i], i);
        }

        // Compute gene activity (sum peak counts) for each gene
        const atacLogExpressions = [];
        const atacResolvedGenes = [];
        for (let gIdx = 0; gIdx < geneNames.length; gIdx++) {
          const gName = geneNames[gIdx];
          const { peakIndices } = getPeaksForGene(gName, peakAnnotation, peakNames);
          if (peakIndices.length === 0) {
            console.log('Multiome dotplot: no peaks found for gene', gName, '- skipping');
            continue;
          }
          const atacExpr = new Float32Array(nFiltered);
          for (let j = 0; j < nFiltered; j++) {
            const colIdx = barcodeToColIdx.get(filteredBarcodes[j]);
            if (colIdx === undefined) continue;
            const col = peakMatrix.column(colIdx);
            let sum = 0;
            for (let p = 0; p < peakIndices.length; p++) {
              sum += col[peakIndices[p]] || 0;
            }
            atacExpr[j] = sum;
          }
          // Use raw counts directly (linear scale) for ATAC gene activity
          atacLogExpressions.push(atacExpr);
          atacResolvedGenes.push(gName);
        }

        if (atacResolvedGenes.length > 0) {
          // Use ATAC clusters
          let atacClusters = loadedData.precomputed?.atacAligned?.clusters;
          if (!atacClusters || atacClusters.length !== nFiltered) {
            atacClusters = clusters; // fallback to RNA clusters
          }
          let atacClusterArr = Array.from(atacClusters);
          if (atacClusterArr.length > nFiltered) {
            atacClusterArr = atacClusterArr.slice(0, nFiltered);
          }

          const atacUniqueClusters = Array.from(new Set(atacClusterArr));
          atacUniqueClusters.sort((a, b) => {
            if (typeof a === 'number' && typeof b === 'number') return a - b;
            return String(a).localeCompare(String(b));
          });
          const atacClusterLookup = new Map(atacUniqueClusters.map((id, idx) => [id, idx]));
          const atacNClusters = atacUniqueClusters.length;
          const atacNGenes = atacResolvedGenes.length;

          const atacClusterCellCounts = new Array(atacNClusters).fill(0);
          const atacClusterIndicesPerCell = new Array(atacClusterArr.length);
          for (let i = 0; i < atacClusterArr.length; i++) {
            const idx = atacClusterLookup.get(atacClusterArr[i]);
            atacClusterIndicesPerCell[i] = idx;
            if (idx !== undefined) atacClusterCellCounts[idx] += 1;
          }

          const atacPercentExpressing = Array.from({ length: atacNClusters }, () => new Float32Array(atacNGenes));
          const atacAverageExpression = Array.from({ length: atacNClusters }, () => new Float32Array(atacNGenes));
          let atacGlobalMin = Infinity;
          let atacGlobalMax = -Infinity;
          const atacNCells = atacClusterArr.length;

          for (let geneIdx = 0; geneIdx < atacNGenes; geneIdx++) {
            const logExpr = atacLogExpressions[geneIdx];
            const detectedCounts = new Array(atacNClusters).fill(0);
            const expressionSums = new Array(atacNClusters).fill(0);

            for (let cell = 0; cell < atacNCells; cell++) {
              const clusterIdx = atacClusterIndicesPerCell[cell];
              if (clusterIdx === undefined || clusterIdx === null) continue;
              const value = logExpr[cell];
              if (value > 0) {
                detectedCounts[clusterIdx] += 1;
                expressionSums[clusterIdx] += value;
              }
            }

            for (let clusterIdx = 0; clusterIdx < atacNClusters; clusterIdx++) {
              const totalCells = atacClusterCellCounts[clusterIdx];
              const detected = detectedCounts[clusterIdx];
              const percent = totalCells > 0 ? detected / totalCells : 0;
              const mean = detected > 0 ? expressionSums[clusterIdx] / detected : 0;
              atacPercentExpressing[clusterIdx][geneIdx] = percent;
              atacAverageExpression[clusterIdx][geneIdx] = mean;
              if (detected > 0) {
                if (mean < atacGlobalMin) atacGlobalMin = mean;
                if (mean > atacGlobalMax) atacGlobalMax = mean;
              }
            }
          }

          if (!Number.isFinite(atacGlobalMin) || !Number.isFinite(atacGlobalMax)) {
            atacGlobalMin = 0; atacGlobalMax = 1;
          } else if (atacGlobalMin === atacGlobalMax) {
            atacGlobalMax = atacGlobalMin + 1e-3;
          }

          const atacTransferables = [];
          atacPercentExpressing.forEach((row) => atacTransferables.push(row.buffer));
          atacAverageExpression.forEach((row) => atacTransferables.push(row.buffer));

          self.postMessage({
            type: 'ANALYSIS_COMPLETE',
            data: {
              type: 'gene_dotplot',
              multiomeModality: 'atac',
              geneNames: atacResolvedGenes,
              clusterIds: atacUniqueClusters,
              percentExpressing: atacPercentExpressing,
              averageExpression: atacAverageExpression,
              clusterCellCounts: atacClusterCellCounts,
              totalCells: atacNCells,
              expressionRange: [atacGlobalMin, atacGlobalMax],
              colorMap,
            }
          }, atacTransferables);
          console.log('Multiome dotplot: sent ATAC gene activity dotplot for', atacResolvedGenes.join(', '));
        } else {
          console.log('Multiome dotplot: no genes had matching peaks, skipping ATAC dotplot');
        }
      } else {
        console.log('Multiome dotplot: no peak matrix available, skipping ATAC dotplot');
      }
    } catch (atacErr) {
      console.warn('Multiome dotplot: ATAC gene activity dotplot failed (non-fatal):', atacErr);
    }
  }

  } catch (error) {
    console.error('====== DOT PLOT: ERROR CAUGHT ======');
    console.error('Gene dot plot failed:', error);
    console.error('Error details:', error.stack);
    throw error;
  }
}

const cellChatDbCache = new Map();

async function fetchJsonFromPublic(paths) {
  let lastError = null;
  for (const path of paths) {
    try {
      const response = await fetch(path);
      if (!response.ok) {
        lastError = new Error(`${path}: HTTP ${response.status}`);
        continue;
      }
      const text = await response.text();
      const trimmed = text.trim();
      if (trimmed.startsWith('<')) {
        lastError = new Error(`${path}: received HTML instead of JSON`);
        continue;
      }
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Could not load JSON asset');
}

async function loadCellChatLrDatabase(species) {
  const key = species === 'mouse' ? 'mouse' : 'human';
  if (cellChatDbCache.has(key)) return cellChatDbCache.get(key);
  const fileName = `cellchatdb_${key}_lr.json`;
  const workerHref = self?.location?.href || '';
  const origin = self?.location?.origin || '';
  const candidates = [];
  try {
    if (workerHref) candidates.push(new URL('../../cellchatdb/' + fileName, workerHref).href);
  } catch (e) {
    // Ignore malformed worker URLs and try simpler fallbacks below.
  }
  if (origin && origin !== 'null') {
    candidates.push(`${origin}/cellchatdb/${fileName}`);
  }
  candidates.push(
    `cellchatdb/${fileName}`,
    `/cellchatdb/${fileName}`,
    `./cellchatdb/${fileName}`,
  );
  const db = await fetchJsonFromPublic([
    ...new Set(candidates),
  ]);
  cellChatDbCache.set(key, db);
  return db;
}

function inferSpeciesFromGenome() {
  const genome = String(loadedData?.info?.genome || loadedData?.info?.species || '').toLowerCase();
  if (genome.includes('mm') || genome.includes('mouse') || genome.includes('grcm')) return 'mouse';
  if (genome.includes('hg') || genome.includes('human') || genome.includes('grch')) return 'human';
  return null;
}

function countDbGeneMatches(db, lookup) {
  const genes = new Set();
  for (const item of db?.interactions || []) {
    (item.ligand_genes || []).forEach(g => genes.add(normalizeGeneName(g)));
    (item.receptor_genes || []).forEach(g => genes.add(normalizeGeneName(g)));
  }
  let count = 0;
  genes.forEach(g => {
    if (lookup.has(g)) count += 1;
  });
  return count;
}

async function chooseCellChatLrDatabase() {
  const species = inferSpeciesFromGenome();
  if (species) {
    const db = await loadCellChatLrDatabase(species);
    return { db, species, matchCount: null };
  }

  const { lookup } = await ensureGeneLookup();
  const [humanDb, mouseDb] = await Promise.all([
    loadCellChatLrDatabase('human'),
    loadCellChatLrDatabase('mouse'),
  ]);
  const humanMatches = countDbGeneMatches(humanDb, lookup);
  const mouseMatches = countDbGeneMatches(mouseDb, lookup);
  return mouseMatches > humanMatches
    ? { db: mouseDb, species: 'mouse', matchCount: mouseMatches }
    : { db: humanDb, species: 'human', matchCount: humanMatches };
}

async function getNormalizedGeneRowByName(gene) {
  const { geneNames, lookup } = await ensureGeneLookup();
  const idx = lookup.get(normalizeGeneName(gene));
  if (idx === undefined) return { row: null, geneName: null };
  let row = null;
  if (loadedData?.state?.rna_normalization) {
    row = loadedData.state.rna_normalization.fetchNormalizedMatrix().row(idx, { asTypedArray: true });
  } else if (loadedData?.jsNormMatrix || loadedData?.jsH5TmpFile) {
    const expressions = await resolveGeneExpressions([geneNames[idx]]);
    row = expressions.logExpressions?.[0] || null;
  }
  return { row, geneName: geneNames[idx] || gene };
}

function summarizeRowForIndices(row, indices) {
  let sum = 0;
  let detected = 0;
  for (const idx of indices) {
    const value = row?.[idx] || 0;
    sum += value;
    if (value > 0) detected += 1;
  }
  const n = Math.max(1, indices.length);
  return { mean: sum / n, pct: detected / n };
}

function createSeededRandom(seed = 1) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffledCopy(values, random) {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

async function runSpatialCellInteraction(params = {}) {
  if (!loadedData) {
    throw new Error('No data loaded. Please load data first.');
  }
  const rawRegions = Array.isArray(params.regions) ? params.regions : [];
  if (rawRegions.length < 2) {
    throw new Error('Cell-cell interaction analysis needs at least two selected spatial areas. Please select two regions in Spatial View, then ask again.');
  }
  const inferredCellCount =
    loadedData.cellBarcodes?.length ||
    loadedData.spatialData?.coordinates?.length ||
    loadedData.nCells ||
    loadedData.state?.rna_normalization?.fetchNormalizedMatrix?.()?.numberOfColumns?.() ||
    0;
  const regions = rawRegions.map((region, index) => {
    const indices = Array.from(new Set((region.selectedCellIndices || region.globalIndices || [])
      .map(v => Number(v))
      .filter(v => Number.isInteger(v) && v >= 0 && v < inferredCellCount)));
    return { id: region.id || `Region ${index + 1}`, indices };
  });
  if (regions.some(region => region.indices.length < 3)) {
    throw new Error('Each selected area needs at least 3 cells for ligand-receptor analysis. Please select larger regions.');
  }

  self.postMessage({ type: 'STATUS_UPDATE', message: 'Computing region ligand-receptor gene summaries...' });
  const regionSets = regions.map(region => new Set(region.indices));
  const allSelectedSet = new Set(regions.flatMap(region => region.indices));
  const otherForRegion = regions.map((region, idx) => {
    const out = [];
    for (let i = 0; i < inferredCellCount; i++) {
      if (!regionSets[idx].has(i) && !allSelectedSet.has(i)) out.push(i);
    }
    return out.length ? out : regions.filter((_, otherIdx) => otherIdx !== idx).flatMap(other => other.indices);
  });

  const { db: lrDb, species: lrSpecies, matchCount: lrDbMatchCount } = await chooseCellChatLrDatabase();
  const lrInteractions = Array.isArray(lrDb?.interactions) ? lrDb.interactions : [];
  const lrGenes = Array.from(new Set(lrInteractions.flatMap((item) => [
    ...(item.ligand_genes || []),
    ...(item.receptor_genes || []),
  ]).filter(Boolean)));
  if (!lrGenes.length) {
    throw new Error('CellChat ligand-receptor database is empty or unavailable.');
  }
  const nboot = Math.max(10, Math.min(1000, Number(params.nboot || 100)));
  const pValueThreshold = Number.isFinite(Number(params.pValueThreshold))
    ? Number(params.pValueThreshold)
    : 0.05;
  const selectedPool = regions.flatMap(region => region.indices);
  const regionSizes = regions.map(region => region.indices.length);
  const random = createSeededRandom(params.seed || 1);
  const bootRegionIndices = [];
  for (let b = 0; b < nboot; b++) {
    const shuffled = shuffledCopy(selectedPool, random);
    let offset = 0;
    bootRegionIndices.push(regionSizes.map((size) => {
      const slice = shuffled.slice(offset, offset + size);
      offset += size;
      return slice;
    }));
  }

  const regionCount = regions.length;
  const markerResults = regions.map(() => ({ markers: [] }));
  const geneStats = new Map();
  const uniqueLrGenes = Array.from(new Set(lrGenes.map(g => String(g || '').trim()).filter(Boolean)));
  for (let geneIdx = 0; geneIdx < uniqueLrGenes.length; geneIdx++) {
    if (geneIdx % 100 === 0) {
      self.postMessage({
        type: 'STATUS_UPDATE',
        message: `Summarizing CellChatDB genes ${geneIdx + 1}-${Math.min(geneIdx + 100, uniqueLrGenes.length)} of ${uniqueLrGenes.length.toLocaleString()}...`
      });
    }
    const gene = uniqueLrGenes[geneIdx];
    const { row, geneName } = await getNormalizedGeneRowByName(gene);
    if (!row) continue;
    const actual = regions.map(region => summarizeRowForIndices(row, region.indices));
    const background = otherForRegion.map(indices => summarizeRowForIndices(row, indices));
    const bootMean = new Float32Array(nboot * regionCount);
    const bootPct = new Float32Array(nboot * regionCount);
    for (let b = 0; b < nboot; b++) {
      for (let regionIdx = 0; regionIdx < regionCount; regionIdx++) {
        const stats = summarizeRowForIndices(row, bootRegionIndices[b][regionIdx]);
        const offset = b * regionCount + regionIdx;
        bootMean[offset] = stats.mean;
        bootPct[offset] = stats.pct;
      }
    }
    const displayGene = geneName || gene;
    geneStats.set(normalizeGeneName(gene), { gene: displayGene, actual, background, bootMean, bootPct });
    geneStats.set(normalizeGeneName(displayGene), { gene: displayGene, actual, background, bootMean, bootPct });
    actual.forEach((inStats, regionIdx) => {
      const outStats = background[regionIdx] || { mean: 0, pct: 0 };
      const logFC = Math.log((inStats.mean + 1e-6) / (outStats.mean + 1e-6));
      if (logFC <= 0) return;
      markerResults[regionIdx].markers.push({
        gene: displayGene,
        avg_logFC: logFC,
        pct1: inStats.pct,
        pct2: outStats.pct,
        mean_in: inStats.mean,
        mean_out: outStats.mean,
        markerScore: logFC * Math.max(inStats.pct, 0.01),
      });
    });
  }
  markerResults.forEach(result => result.markers.sort((a, b) => b.markerScore - a.markerScore));
  const markerMaps = markerResults.map(result => new Map(result.markers.map(row => [normalizeGeneName(row.gene), row])));

  function getGeneSummary(gene) {
    return geneStats.get(normalizeGeneName(gene));
  }

  function complexStats(genes, regionIdx) {
    let minMean = Infinity;
    let minPct = Infinity;
    for (const gene of genes) {
      const stats = getGeneSummary(gene);
      const regionStats = stats?.actual?.[regionIdx] || { mean: 0, pct: 0 };
      minMean = Math.min(minMean, regionStats.mean);
      minPct = Math.min(minPct, regionStats.pct);
    }
    return {
      mean: minMean === Infinity ? 0 : minMean,
      pct: minPct === Infinity ? 0 : minPct,
      genes,
    };
  }

  function complexBootStats(genes, bootIdx, regionIdx) {
    let minMean = Infinity;
    let minPct = Infinity;
    const offset = bootIdx * regionCount + regionIdx;
    for (const gene of genes) {
      const stats = getGeneSummary(gene);
      minMean = Math.min(minMean, stats?.bootMean?.[offset] || 0);
      minPct = Math.min(minPct, stats?.bootPct?.[offset] || 0);
    }
    return {
      mean: minMean === Infinity ? 0 : minMean,
      pct: minPct === Infinity ? 0 : minPct,
      genes,
    };
  }

  const communicationScore = (ligandGenes, receptorGenes, sourceIdx, targetIdx, bootIdx = null) => {
    const ligStats = bootIdx == null
      ? complexStats(ligandGenes, sourceIdx)
      : complexBootStats(ligandGenes, bootIdx, sourceIdx);
    const recStats = bootIdx == null
      ? complexStats(receptorGenes, targetIdx)
      : complexBootStats(receptorGenes, bootIdx, targetIdx);
    const probability = Math.sqrt(Math.max(ligStats.mean, 0) * Math.max(recStats.mean, 0)) *
      Math.sqrt(Math.max(ligStats.pct, 0) * Math.max(recStats.pct, 0));
    return { probability, ligStats, recStats };
  };

  self.postMessage({ type: 'STATUS_UPDATE', message: `Scoring ${lrInteractions.length.toLocaleString()} CellChatDB ligand-receptor pairs with ${nboot} permutations...` });
  const allInteractions = [];
  for (const lr of lrInteractions) {
    const ligandGenes = Array.isArray(lr.ligand_genes) ? lr.ligand_genes.filter(Boolean) : [];
    const receptorGenes = Array.isArray(lr.receptor_genes) ? lr.receptor_genes.filter(Boolean) : [];
    if (!ligandGenes.length || !receptorGenes.length) continue;
    for (let sourceIdx = 0; sourceIdx < regions.length; sourceIdx++) {
      for (let targetIdx = 0; targetIdx < regions.length; targetIdx++) {
        if (sourceIdx === targetIdx) continue;
        const dir = { sourceIdx, targetIdx };
        const ligandMarker = ligandGenes.every(g => markerMaps[dir.sourceIdx].has(normalizeGeneName(g)));
        const receptorMarker = receptorGenes.every(g => markerMaps[dir.targetIdx].has(normalizeGeneName(g)));
        if (!ligandMarker || !receptorMarker) continue;
        const { probability: communicationProbability, ligStats, recStats } = communicationScore(
          ligandGenes,
          receptorGenes,
          dir.sourceIdx,
          dir.targetIdx,
        );
        if (!(communicationProbability > 0)) continue;
        let nReject = 0;
        for (let b = 0; b < nboot; b++) {
          const bootScore = communicationScore(
            ligandGenes,
            receptorGenes,
            dir.sourceIdx,
            dir.targetIdx,
            b,
          ).probability;
          if (bootScore - communicationProbability > 0) nReject += 1;
        }
        const pValue = nReject / nboot;
        allInteractions.push({
          source: regions[dir.sourceIdx].id,
          target: regions[dir.targetIdx].id,
          ligand: lr.ligand || ligandGenes.join('_'),
          receptor: lr.receptor || receptorGenes.join('_'),
          ligandGenes,
          receptorGenes,
          pair: `${lr.ligand || ligandGenes.join('_')} - ${lr.receptor || receptorGenes.join('_')}`,
          pathway: lr.pathway || 'Unknown',
          category: lr.category || lr.annotation || 'Unknown',
          annotation: lr.annotation || lr.category || null,
          evidence: lr.evidence || null,
          interactionName: lr.interaction_name || null,
          probability: communicationProbability,
          p_value: pValue,
          significant: pValue <= pValueThreshold,
          ligandMean: ligStats.mean,
          receptorMean: recStats.mean,
          ligandPct: ligStats.pct,
          receptorPct: recStats.pct,
        });
      }
    }
  }
  const interactions = allInteractions.filter(item => item.significant);
  interactions.sort((a, b) => b.probability - a.probability);
  allInteractions.sort((a, b) => {
    if (a.p_value !== b.p_value) return a.p_value - b.p_value;
    return b.probability - a.probability;
  });

  const pathways = Array.from(new Set(interactions.map(item => item.pathway)));
  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'spatial_cell_interaction',
      method: 'cellchatdb_ligand_receptor_marker_filter_cellchat_like_score',
      significance: {
        method: 'cellchat_style_label_permutation',
        nboot,
        threshold: pValueThreshold,
        definition: 'p_value = fraction of permuted communication scores greater than observed score',
      },
      lrDatabase: {
        source: lrDb.source || `CellChatDB.${lrSpecies}`,
        species: lrSpecies,
        interactionCount: lrDb.interaction_count || lrInteractions.length,
        categories: lrDb.categories || [],
        matchedGenes: lrDbMatchCount,
      },
      regions: regions.map(region => ({ id: region.id, cellCount: region.indices.length })),
      markerGenes: Object.fromEntries(regions.map((region, idx) => [region.id, markerResults[idx].markers.slice(0, 50)])),
      interactions,
      allInteractions: allInteractions.slice(0, 200),
      summary: {
        interactionCount: interactions.length,
        testedInteractionCount: allInteractions.length,
        pathwayCount: pathways.length,
        pathways,
        topInteractions: interactions.slice(0, 8).map(item => ({
          source: item.source,
          target: item.target,
          pair: item.pair,
          pathway: item.pathway,
          score: item.probability,
        })),
      },
    },
  });
}

async function findMarkers(params = {}) {
  if (!loadedData) {
    throw new Error('No data loaded. Please load data first.');
  }
  const isAtacIntegration = loadedData.info?.modality === 'atac-integration';
  if (!loadedData.state && !isAtacIntegration) {
    throw new Error('No data loaded. Please load data first.');
  }

  // Support both single cluster and array of clusters (for merged/renamed clusters)
  const { cluster, clusters: mergedClusters, multiomeTarget, spatialRegionMode = false } = params;
  const rawSelectedCellIndices = Array.isArray(params.selectedCellIndices)
    ? params.selectedCellIndices
    : Array.isArray(params.cellIndices)
      ? params.cellIndices
      : [];
  const state = loadedData.state;

  // For atac-integration: no bakana state; use currentResults.clusters from runAtacIntegrationPipeline
  let clusterAssignments = currentResults.clusters;
  if (isAtacIntegration) {
    if (!clusterAssignments || !clusterAssignments.length) {
      throw new Error('Cluster assignments are unavailable. Please load and run ATAC integration first.');
    }
    clusterAssignments = Array.from(clusterAssignments);
  } else {
    // For multiome: use RNA or ATAC precomputed clusters so RNA view is unchanged after ATAC-only update
    if (loadedData?.info?.modality === 'multiome' && loadedData.precomputed) {
      if (multiomeTarget === 'atac' && loadedData.precomputed.atacAligned) {
        clusterAssignments = loadedData.precomputed.atacAligned.clusters;
        console.log('Multiome: using ATAC clusters for find_markers');
      } else if (multiomeTarget !== 'atac' && loadedData.precomputed.rnaAligned?.clusters) {
        clusterAssignments = loadedData.precomputed.rnaAligned.clusters;
        console.log('Multiome: using RNA clusters for find_markers');
      }
    }
    if (!clusterAssignments || !clusterAssignments.length) {
      let fetched = state.choose_clustering.fetchClusters();
      if (!fetched || !fetched.length) {
        await runClusteringAndUMAP(false);
        fetched = state.choose_clustering.fetchClusters();
      }
      clusterAssignments = Array.from(fetched);
      currentResults.clusters = clusterAssignments;
    }
  }

  if ((!clusterAssignments || !clusterAssignments.length) && !spatialRegionMode) {
    throw new Error('Cluster assignments are unavailable.');
  }

  if (spatialRegionMode) {
    const inferredCellCount =
      (Array.isArray(clusterAssignments) && clusterAssignments.length) ||
      loadedData.cellBarcodes?.length ||
      loadedData.spatialData?.coordinates?.length ||
      loadedData.nCells ||
      0;
    if (!inferredCellCount) {
      throw new Error('Could not determine the cell count for the selected spatial region.');
    }
    const selectedSet = new Set(
      rawSelectedCellIndices
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value < inferredCellCount)
    );
    if (selectedSet.size < 3) {
      throw new Error('The selected spatial region contains too few cells for marker analysis.');
    }
    clusterAssignments = Array.from({ length: inferredCellCount }, (_, idx) => selectedSet.has(idx) ? 1 : 0);
    currentResults.clusters = currentResults.clusters || clusterAssignments;
    console.log('findMarkers: spatial region request', {
      selectedCells: selectedSet.size,
      totalCells: inferredCellCount,
      regionFormat: params.regionFormat,
    });
  }

  const uniqueClusters = Array.from(new Set(clusterAssignments));
  uniqueClusters.sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b;
    }
    return String(a).localeCompare(String(b));
  });

  // Handle merged clusters (multiple cluster IDs renamed to the same label)
  let targetClusterIds = [];
  let isMergedClusterRequest = false;

  if (Array.isArray(mergedClusters) && mergedClusters.length > 1) {
    // Multiple clusters merged to the same label - treat as one group
    isMergedClusterRequest = true;
    targetClusterIds = mergedClusters.map(c => {
      // Match each cluster ID against uniqueClusters
      const numVal = typeof c === 'number' ? c : parseInt(c);
      const matched = uniqueClusters.find(uc =>
        uc === c || uc === numVal || String(uc) === String(c) || Number(uc) === numVal
      );
      return matched !== undefined ? matched : c;
    });
    console.log('findMarkers: Merged cluster request, target IDs:', targetClusterIds);
  }

  // Debug: Log cluster types and values
  console.log('findMarkers: Cluster debug info:', {
    requestedClusterInput: cluster,
    mergedClustersInput: mergedClusters,
    isMergedClusterRequest,
    targetClusterIds,
    requestedClusterType: typeof cluster,
    uniqueClustersCount: uniqueClusters.length,
    uniqueClustersSample: uniqueClusters.slice(0, 10),
    uniqueClustersTypes: uniqueClusters.slice(0, 5).map(c => typeof c),
  });

  let requestedCluster = spatialRegionMode ? 1 : cluster;
  if (requestedCluster === undefined || requestedCluster === null || requestedCluster === '') {
    requestedCluster = uniqueClusters[0];
  }

  // Try to find the matching cluster in uniqueClusters
  // First, check if the exact value exists
  let matchedCluster = uniqueClusters.find(c => c === requestedCluster);

  // If not found and requestedCluster is a string, try parsing as number
  if (matchedCluster === undefined && typeof requestedCluster === 'string') {
    const trimmed = requestedCluster.trim();
    const numMatch = trimmed.match(/(\d+)/);
    if (numMatch) {
      const numValue = Number(numMatch[1]);
      // Try to find matching cluster as number or string
      matchedCluster = uniqueClusters.find(c =>
        c === numValue || c === String(numValue) || String(c) === String(numValue)
      );
      if (matchedCluster !== undefined) {
        requestedCluster = matchedCluster;
      }
    }
  }

  // If requestedCluster is a number, try to find matching cluster
  if (matchedCluster === undefined && typeof requestedCluster === 'number') {
    matchedCluster = uniqueClusters.find(c =>
      c === requestedCluster || c === String(requestedCluster) || Number(c) === requestedCluster
    );
    if (matchedCluster !== undefined) {
      requestedCluster = matchedCluster;
    }
  }

  console.log('findMarkers: After matching:', {
    requestedCluster,
    requestedClusterType: typeof requestedCluster,
    matchedCluster,
    matchedClusterType: typeof matchedCluster,
    isMergedClusterRequest,
    targetClusterIds,
  });

  if (matchedCluster === undefined && !isMergedClusterRequest) {
    throw new Error(
      `Cluster ${cluster} not found. Available clusters: ${uniqueClusters.join(', ')}`
    );
  }

  // Use the matched cluster value for all subsequent comparisons
  requestedCluster = matchedCluster;

  // For merged clusters, use targetClusterIds instead of single requestedCluster
  const targetClustersSet = isMergedClusterRequest
    ? new Set(targetClusterIds.map(c => String(c)))
    : new Set([String(requestedCluster)]);

  // ATAC marker detection: use peak matrix (multiome ATAC or atac-integration)
  const isAtacMarkers = (loadedData?.info?.modality === 'multiome' && multiomeTarget === 'atac') || isAtacIntegration;
  let markerState = null;
  let normMatrix = null;
  let geneNames = [];
  let nGenes = 0;
  let atacPeakMatrixRef = null;
  let atacFilteredColIndices = null;
  let atacFilteredCellCount = 0;

  if (isAtacMarkers) {
    if (isAtacIntegration) {
      // atac-integration: peak matrix and cell order from loadedData (set by runAtacIntegrationPipeline)
      console.log('findMarkers: ATAC integration mode - using unified peak matrix');
      const peakMatrix = loadedData.atacPeakMatrix;
      const atacPeakNames = loadedData.atacPeakNames || loadedData.peakNames || [];
      const nCells = loadedData.cellBarcodes?.length ?? peakMatrix?.numberOfColumns() ?? 0;
      if (!peakMatrix || !atacPeakNames.length || nCells === 0) {
        throw new Error('No peak matrix available for ATAC integration marker detection.');
      }
      atacPeakMatrixRef = peakMatrix;
      geneNames = atacPeakNames;
      nGenes = atacPeakNames.length;
      atacFilteredCellCount = nCells;
      // Matrix columns are in same order as loadedData.cellBarcodes
      atacFilteredColIndices = new Int32Array(nCells);
      for (let j = 0; j < nCells; j++) atacFilteredColIndices[j] = j;
    } else {
      // Multiome ATAC: use getMultiomePeakMatrix and map filtered barcodes to matrix columns
      console.log('findMarkers: ATAC mode - using peak matrix directly');
      const multiomePeak = await getMultiomePeakMatrix();
      if (!multiomePeak) {
        throw new Error('No peak matrix available for ATAC marker detection.');
      }
      const { peakMatrix, peakNames: atacPeakNames, fullBarcodeOrder } = multiomePeak;
      const filteredBarcodes = loadedData.cellBarcodes || [];
      const nCells = filteredBarcodes.length;

      const barcodeToColIdx = new Map();
      for (let i = 0; i < fullBarcodeOrder.length; i++) {
        barcodeToColIdx.set(fullBarcodeOrder[i], i);
      }
      atacFilteredColIndices = new Int32Array(nCells);
      for (let j = 0; j < nCells; j++) {
        const colIdx = barcodeToColIdx.get(filteredBarcodes[j]);
        atacFilteredColIndices[j] = colIdx !== undefined ? colIdx : -1;
      }
      atacPeakMatrixRef = peakMatrix;
      atacFilteredCellCount = nCells;
      geneNames = atacPeakNames;
      nGenes = atacPeakNames.length;
    }

    console.log(`findMarkers: ATAC mode - ${nGenes} peaks in peak matrix`);
    self.postMessage({
      type: 'STATUS_UPDATE',
      message: `Finding marker peaks across ${nGenes} peaks...`,
    });
  } else if (state && state.marker_detection && state.rna_normalization) {
    markerState = state.marker_detection;
    normMatrix = state.rna_normalization.fetchNormalizedMatrix();
    const lookup = await ensureGeneLookup();
    geneNames = lookup.geneNames;
    nGenes = geneNames.length;
  } else if ((loadedData.jsNormMatrix || loadedData.jsH5TmpFile) && loadedData.jsGeneNames) {
    // Pure-JS streaming pipeline: restrict markers to HVG genes for performance
    // (non-HVG genes would require full H5 re-scan per gene — too slow for marker detection)
    const hvgIndices = loadedData.jsHvgIndices;
    if (hvgIndices && hvgIndices.length > 0) {
      const allNames = loadedData.jsGeneNames;
      geneNames = hvgIndices.map(i => allNames[i]);
      nGenes = geneNames.length;
    } else {
      const lookup = await ensureGeneLookup();
      geneNames = lookup.geneNames;
      nGenes = geneNames.length;
    }
    // normMatrix stays null — getGeneRow below handles jsNormMatrix or H5 fallback
  } else {
    throw new Error('No normalized matrix available for marker detection');
  }

  // Helper: get feature values (RNA normalized expression or ATAC peak counts)
  async function getGeneRow(geneIndex) {
    if (atacPeakMatrixRef) {
      // Extract peak row from peak matrix, filtered to cells in the dataset
      const fullRow = atacPeakMatrixRef.row(geneIndex);
      const filtered = new Float32Array(atacFilteredCellCount);
      for (let j = 0; j < atacFilteredCellCount; j++) {
        if (atacFilteredColIndices[j] >= 0) {
          filtered[j] = fullRow[atacFilteredColIndices[j]] || 0;
        }
      }
      return filtered;
    }
    if (normMatrix) {
      return normMatrix.row(geneIndex, { asTypedArray: true });
    }
    // Pure-JS streaming pipeline: geneIndex is the HVG row index
    // (findMarkers already restricted geneNames to HVG, so index maps directly)
    if (loadedData.jsNormMatrix) {
      const jsMatrix = loadedData.jsNormMatrix;
      const row = new Float32Array(jsMatrix.ncols);
      for (let j = 0; j < jsMatrix.ncols; j++) {
        for (let p = jsMatrix.colPtr[j]; p < jsMatrix.colPtr[j + 1]; p++) {
          if (jsMatrix.rowIdx[p] === geneIndex) {
            row[j] = jsMatrix.values[p];
            break;
          }
        }
      }
      return row;
    }
    // H5 fallback: geneIndex is HVG index, map back to original gene index
    if (loadedData.jsH5TmpFile && loadedData.jsHvgIndices) {
      const origGeneIdx = loadedData.jsHvgIndices[geneIndex];
      const nKeptCells = loadedData.jsFilteredBarcodes?.length || 0;
      const { readSingleGeneFromH5 } = await import('../scatac/h5sparse.js');
      const row = await readSingleGeneFromH5(
        loadedData.jsH5TmpFile,
        origGeneIdx,
        loadedData.jsKeepCellFlags,
        loadedData.jsCellTotals,
        loadedData.jsNOrigCells,
        nKeptCells,
      );
      return row;
    }
    throw new Error('No matrix available for gene expression lookup');
  }

  // Check if bakana's marker detection has been computed
  let markerResults = markerState?.fetchResults?.();
  let rnaMarkers = markerResults?.RNA;

  // For ATAC markers, skip bakana's RNA marker results - compute from peak matrix instead
  if (isAtacMarkers) {
    rnaMarkers = null;
  }

  // Determine if we should use precomputed clusters for marker detection
  // This is true ONLY for spatial/Xenium data that loaded with precomputed UMAP/clusters
  // and hasn't been fully processed through bakana's pipeline yet.
  // For single-cell data, we always use bakana's marker statistics even after cluster merges,
  // because the Wilcoxon test (which determines gene ranking) uses the current cluster
  // assignments from currentResults.clusters anyway.
  const hasPrecomputedData = loadedData.precomputed &&
                              loadedData.precomputed.umap &&
                              loadedData.precomputed.clusters;
  const usePrecomputedClusters = hasPrecomputedData && !rnaMarkers;

  let meanTarget, detectedTarget, meanOther, detectedOther;
  let groupCount = uniqueClusters.length;
  const totalCells = clusterAssignments.length;

  // Build cluster counts using precomputed clusters
  const clusterCounts = new Map();
  for (const c of uniqueClusters) {
    clusterCounts.set(c, 0);
  }
  for (const value of clusterAssignments) {
    if (clusterCounts.has(value)) {
      clusterCounts.set(value, clusterCounts.get(value) + 1);
    }
  }

  // For merged clusters, sum up all cluster sizes
  let targetClusterSize;
  if (isMergedClusterRequest) {
    targetClusterSize = 0;
    for (const clusterId of targetClusterIds) {
      targetClusterSize += clusterCounts.get(clusterId) || 0;
    }
    console.log('findMarkers: Merged cluster total size:', targetClusterSize, 'from clusters:', targetClusterIds);
  } else {
    targetClusterSize = clusterCounts.get(requestedCluster) || 0;
  }
  const otherCells = Math.max(0, totalCells - targetClusterSize);

  // Log the decision path
  console.log('findMarkers: Decision path', {
    usePrecomputedClusters,
    hasRnaMarkers: !!rnaMarkers,
    targetClusterSize,
    otherCells,
  });

  // Always derive RNA means and detection fractions from the normalized matrix.
  // Bakana's cached ScoreMarkersResults can be stale after cluster restoration,
  // relabelling, or reclustering, and its factorized group order is not guaranteed
  // to stay aligned with currentResults.clusters. The Wilcoxon test below already
  // reads these same matrix rows, so using the matrix here keeps pct.1/pct.2 and
  // avg_logFC consistent with the expression plot and the tested cell groups.
  const computeStatsFromMatrix = !isAtacMarkers || usePrecomputedClusters || !rnaMarkers;
  if (computeStatsFromMatrix) {
    // Compute marker statistics directly from expression matrix using current cluster assignments
    // This is used when:
    // 1. Using precomputed clusters (e.g., Xenium data) without bakana marker detection
    // 2. Marker detection hasn't been run yet
    // Note: For single-cell data with merged clusters, we still use bakana's marker statistics
    // because the Wilcoxon test (which determines gene ranking) uses the current merged
    // cluster assignments from currentResults.clusters.
    const reason = !isAtacMarkers
      ? 'use current RNA matrix and cluster assignments'
      : usePrecomputedClusters
        ? 'precomputed clusters'
        : 'no marker detection';
    console.log(`Computing marker statistics from expression matrix (reason: ${reason})...`);
    self.postMessage({
      type: 'STATUS_UPDATE',
      message: 'Computing marker genes from expression data...',
    });

    // Initialize arrays for mean and detection statistics
    meanTarget = new Float64Array(nGenes);
    detectedTarget = new Float64Array(nGenes);
    meanOther = new Float64Array(nGenes);
    detectedOther = new Float64Array(nGenes);

    // Compute mean expression and detection rate per cluster directly from matrix
    // For each gene, iterate through cells and accumulate statistics
    const targetCellCount = targetClusterSize;
    const otherCellCount = otherCells;

    // Build cell index lists for target and other clusters
    // Use flexible matching to handle type differences (number vs string)
    // For merged clusters, match against all cluster IDs in the target set
    const targetIndices = [];
    const otherIndices = [];
    clusterAssignments.forEach((value, index) => {
      // Match if value is in the target clusters set (handles merged clusters)
      const matches = targetClustersSet.has(String(value));
      if (matches) {
        targetIndices.push(index);
      } else {
        otherIndices.push(index);
      }
    });

    const matrixCols = isAtacMarkers ? atacFilteredCellCount : (normMatrix?.numberOfColumns?.() ?? 0);
    const matrixRows = isAtacMarkers ? nGenes : (normMatrix?.numberOfRows?.() ?? 0);
    console.log('findMarkers: Cell index counts:', {
      targetIndices: targetIndices.length,
      otherIndices: otherIndices.length,
      requestedCluster,
      sampleClusterValues: JSON.stringify(clusterAssignments.slice(0, 20)),
      sampleTargetIndices: JSON.stringify(targetIndices.slice(0, 20)),
      clustersLength: clusterAssignments.length,
      normMatrixCols: matrixCols,
      normMatrixRows: matrixRows,
      MISMATCH: clusterAssignments.length !== matrixCols ? `CLUSTERS(${clusterAssignments.length}) != MATRIX(${matrixCols})` : 'OK',
    });

    // ATAC: single-pass over CSC for O(nnz) stats (avoids N row extractions)
    if (isAtacMarkers && atacPeakMatrixRef?.getCSC) {
      const csc = atacPeakMatrixRef.getCSC();
      const { colPtr, rowIdx, values: cscValues } = csc;
      const ncols = csc.ncols ?? (csc.numberOfColumns ? csc.numberOfColumns() : 0);

      const colToCellIdx = new Int32Array(ncols);
      colToCellIdx.fill(-1);
      for (let i = 0; i < atacFilteredCellCount; i++) {
        const col = atacFilteredColIndices[i];
        if (col >= 0 && col < ncols) colToCellIdx[col] = i;
      }

      for (let j = 0; j < ncols; j++) {
        const cellIdx = colToCellIdx[j];
        if (cellIdx < 0) continue;
        const inTarget = targetClustersSet.has(String(clusterAssignments[cellIdx]));
        for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
          const r = rowIdx[p];
          const v = cscValues[p];
          if (inTarget) {
            meanTarget[r] += v;
            if (v > 0) detectedTarget[r] += 1;
          } else {
            meanOther[r] += v;
            if (v > 0) detectedOther[r] += 1;
          }
        }
      }
      for (let i = 0; i < nGenes; i++) {
        meanTarget[i] = targetCellCount > 0 ? meanTarget[i] / targetCellCount : 0;
        detectedTarget[i] = targetCellCount > 0 ? detectedTarget[i] / targetCellCount : 0;
        meanOther[i] = otherCellCount > 0 ? meanOther[i] / otherCellCount : 0;
        detectedOther[i] = otherCellCount > 0 ? detectedOther[i] / otherCellCount : 0;
      }
      console.log(`Computed ATAC marker statistics (single-pass over ${csc.values?.length ?? 0} nnz)`);
    } else {
      // Process each gene (RNA or when CSC single-pass not available)
      for (let geneIndex = 0; geneIndex < nGenes; geneIndex++) {
        const row = await getGeneRow(geneIndex);

        let sumTarget = 0;
        let detectedCountTarget = 0;
        for (const idx of targetIndices) {
          const val = row[idx];
          sumTarget += val;
          if (val > 0) detectedCountTarget++;
        }
        meanTarget[geneIndex] = targetCellCount > 0 ? sumTarget / targetCellCount : 0;
        detectedTarget[geneIndex] = targetCellCount > 0 ? detectedCountTarget / targetCellCount : 0;

        let sumOther = 0;
        let detectedCountOther = 0;
        for (const idx of otherIndices) {
          const val = row[idx];
          sumOther += val;
          if (val > 0) detectedCountOther++;
        }
        meanOther[geneIndex] = otherCellCount > 0 ? sumOther / otherCellCount : 0;
        detectedOther[geneIndex] = otherCellCount > 0 ? detectedCountOther / otherCellCount : 0;
      }
    }

    console.log(`Computed marker statistics: ${targetIndices.length} cells in cluster ${requestedCluster}, ${otherIndices.length} in other clusters`);

    // Debug: Log stats for first few genes to verify computation
    console.log('findMarkers DEBUG - First 5 genes stats:', {
      gene0: { mean: meanTarget[0], detected: detectedTarget[0], meanOther: meanOther[0] },
      gene1: { mean: meanTarget[1], detected: detectedTarget[1], meanOther: meanOther[1] },
      gene2: { mean: meanTarget[2], detected: detectedTarget[2], meanOther: meanOther[2] },
    });
  } else {
    // Use bakana's pre-computed marker statistics
    // But check if clusters have been merged - if so, compute stats from matrix
    // to get accurate pct.1/pct.2 values for the merged population
    const bakanaGroupCount = typeof rnaMarkers.numberOfGroups === 'function'
      ? rnaMarkers.numberOfGroups()
      : uniqueClusters.length;

    const clustersWereMerged = bakanaGroupCount !== uniqueClusters.length;

    // Also treat as merged if multiple cluster IDs were passed (visual merge without data merge)
    const needsRecomputation = clustersWereMerged || isMergedClusterRequest;

    if (needsRecomputation) {
      // Clusters were merged OR multiple clusters renamed to same label - compute statistics
      // directly from expression matrix to get accurate values for the merged population
      const reason = isMergedClusterRequest ? 'multiple clusters renamed to same label' : 'clusters were merged';
      console.log(`Computing stats from expression matrix (reason: ${reason})`);

      meanTarget = new Float64Array(nGenes);
      detectedTarget = new Float64Array(nGenes);
      meanOther = new Float64Array(nGenes);
      detectedOther = new Float64Array(nGenes);

      // Build cell indices for the merged cluster
      // For merged clusters (multiple IDs renamed to same label), match against all target IDs
      const targetIndices = [];
      const otherIndicesForStats = [];
      clusterAssignments.forEach((value, index) => {
        const matches = targetClustersSet.has(String(value));
        if (matches) {
          targetIndices.push(index);
        } else {
          otherIndicesForStats.push(index);
        }
      });

      const targetCellCount = targetIndices.length;
      const otherCellCount = otherIndicesForStats.length;

      // Process each gene to compute actual statistics
      for (let geneIndex = 0; geneIndex < nGenes; geneIndex++) {
        const row = await getGeneRow(geneIndex);

        // Compute statistics for target (merged) cluster
        let sumTarget = 0;
        let detectedCountTarget = 0;
        for (const idx of targetIndices) {
          const val = row[idx];
          sumTarget += val;
          if (val > 0) detectedCountTarget++;
        }
        meanTarget[geneIndex] = targetCellCount > 0 ? sumTarget / targetCellCount : 0;
        detectedTarget[geneIndex] = targetCellCount > 0 ? detectedCountTarget / targetCellCount : 0;

        // Compute statistics for other clusters combined
        let sumOther = 0;
        let detectedCountOther = 0;
        for (const idx of otherIndicesForStats) {
          const val = row[idx];
          sumOther += val;
          if (val > 0) detectedCountOther++;
        }
        meanOther[geneIndex] = otherCellCount > 0 ? sumOther / otherCellCount : 0;
        detectedOther[geneIndex] = otherCellCount > 0 ? detectedCountOther / otherCellCount : 0;
      }

      console.log(`Computed merged cluster stats: ${targetCellCount} cells in cluster, ${otherCellCount} in other clusters`);
    } else {
      // No merge - use bakana's pre-computed statistics directly
      groupCount = bakanaGroupCount;

      if (
        typeof requestedCluster !== 'number' ||
        requestedCluster < 0 ||
        requestedCluster >= groupCount
      ) {
        throw new Error(`Requested cluster ${requestedCluster} is out of range of computed markers.`);
      }

      meanTarget = rnaMarkers.mean(requestedCluster, { copy: true });
      detectedTarget = rnaMarkers.detected(requestedCluster, { copy: true });

      meanOther = new Float64Array(nGenes);
      detectedOther = new Float64Array(nGenes);

      for (let g = 0; g < groupCount; g++) {
        if (g === requestedCluster || String(g) === String(requestedCluster)) {
          continue;
        }
        const weight = clusterCounts.get(g) || 0;
        if (!weight) {
          continue;
        }
        const meanG = rnaMarkers.mean(g, { copy: true });
        const detectedG = rnaMarkers.detected(g, { copy: true });
        for (let i = 0; i < nGenes; i++) {
          meanOther[i] += meanG[i] * weight;
          detectedOther[i] += detectedG[i] * weight;
        }
      }

      if (otherCells > 0) {
        for (let i = 0; i < nGenes; i++) {
          meanOther[i] /= otherCells;
          detectedOther[i] /= otherCells;
        }
      }
    }
  }

  // Build cell index lists for Wilcoxon test
  // Use flexible matching to handle type differences (number vs string)
  // For merged clusters, match against all cluster IDs in the target set
  const inIndices = [];
  const outIndices = [];
  clusterAssignments.forEach((value, index) => {
    const matches = targetClustersSet.has(String(value));
    if (matches) {
      inIndices.push(index);
    } else {
      outIndices.push(index);
    }
  });

  console.log('findMarkers: Wilcoxon indices:', {
    inIndices: inIndices.length,
    outIndices: outIndices.length,
  });

  const wilcoxonWorkspace = createWilcoxonWorkspace(inIndices.length, outIndices.length);
  const pValues = new Float64Array(nGenes);
  pValues.fill(1); // Default for skipped peaks

  // ATAC: pre-filter to peaks with >0.1% detection to avoid Wilcoxon on 100k+ peaks
  const MIN_DETECTION = 0.001;
  let genesToIterate;
  if (isAtacMarkers && nGenes > 10000) {
    const peakIndicesToTest = [];
    for (let i = 0; i < nGenes; i++) {
      if ((detectedTarget[i] ?? 0) > MIN_DETECTION || (detectedOther[i] ?? 0) > MIN_DETECTION) {
        peakIndicesToTest.push(i);
      }
    }
    console.log(`findMarkers: ATAC pre-filter: testing ${peakIndicesToTest.length}/${nGenes} peaks (detection > ${MIN_DETECTION * 100}%)`);
    genesToIterate = peakIndicesToTest;
  } else {
    genesToIterate = Array.from({ length: nGenes }, (_, i) => i);
  }
  const BATCH_SIZE = 2000;
  const featureLabel = isAtacMarkers ? 'peaks' : 'genes';

  for (let k = 0; k < genesToIterate.length; k++) {
    if (k > 0 && k % BATCH_SIZE === 0) {
      await new Promise((r) => setTimeout(r, 0));
      self.postMessage({
        type: 'STATUS_UPDATE',
        message: `Finding marker ${featureLabel}... ${k}/${genesToIterate.length}`,
      });
    }
    const geneIndex = genesToIterate[k];
    const row = await getGeneRow(geneIndex);
    const p = wilcoxonRankSumPValue(row, inIndices, outIndices, wilcoxonWorkspace);
    pValues[geneIndex] = Number.isFinite(p) && p > 0 ? p : Number.MIN_VALUE;
  }

  const adjustedP = benjaminiHochberg(Array.from(pValues));
  const pseudoCount = 1e-6;
  const rows = new Array(nGenes);

  for (let geneIndex = 0; geneIndex < nGenes; geneIndex++) {
    const meanIn = meanTarget[geneIndex];
    const meanOut = otherCells > 0 ? meanOther[geneIndex] : 0;
    const pctIn = detectedTarget[geneIndex];
    const pctOut = otherCells > 0 ? detectedOther[geneIndex] : 0;

    const avgLogFC = Math.log((meanIn + pseudoCount) / (meanOut + pseudoCount));

    rows[geneIndex] = {
      gene: geneNames[geneIndex] ?? `Gene ${geneIndex}`,
      p_val: pValues[geneIndex],
      avg_logFC: avgLogFC,
      pct1: pctIn,
      pct2: pctOut,
      p_val_adj: adjustedP[geneIndex],
      mean_in: meanIn,
      mean_out: meanOut,
    };
  }

  // Keep only upregulated markers (positive logFC = higher in target cluster).
  // The Wilcoxon test floors p-values of strongly downregulated genes to
  // Number.MIN_VALUE. Because that is strictly smaller than the p-values of
  // moderately upregulated genes, downregulated markers sort first even though
  // they have negative logFC — the opposite of what "find markers" means.
  const positiveRows = rows.filter(r => r.avg_logFC > 0);
  positiveRows.sort((a, b) => {
    if (a.p_val !== b.p_val) return a.p_val - b.p_val;
    return b.avg_logFC - a.avg_logFC;
  });

  // Debug: Log top 5 markers being returned
  console.log('findMarkers DEBUG - Top 5 markers:', positiveRows.slice(0, 5).map(r => ({
    gene: r.gene,
    pval: r.p_val,
    logFC: r.avg_logFC,
    pct1: r.pct1,
    pct2: r.pct2,
  })));

  const maxRows = 200;
  let pathwayEnrichment = null;
  let structureEnrichment = null;
  if (spatialRegionMode && !isAtacMarkers) {
    try {
      self.postMessage({
        type: 'STATUS_UPDATE',
        message: 'Running structure and pathway enrichment for selected-region markers...',
      });
      const geneSetEnrichment = await computeSelectedRegionGeneSetEnrichments(positiveRows, geneNames, state);
      structureEnrichment = geneSetEnrichment.structureEnrichment;
      pathwayEnrichment = geneSetEnrichment.pathwayEnrichment;
    } catch (pathwayError) {
      console.warn('Selected-region gene-set enrichment failed:', pathwayError);
      structureEnrichment = {
        available: false,
        reason: 'structure_enrichment_failed',
        error: pathwayError.message,
        pathways: [],
        themes: [],
      };
      pathwayEnrichment = {
        available: false,
        reason: 'pathway_enrichment_failed',
        error: pathwayError.message,
        pathways: [],
        themes: [],
      };
    }
  }

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'markers',
      comparison: spatialRegionMode ? 'selected_spatial_region_vs_other_cells' : undefined,
      selectedRegion: spatialRegionMode ? {
        cellCount: targetClusterSize,
        otherCells,
        format: params.regionFormat || loadedData.info?.format || loadedData.info?.modality || null,
        hasHistologyImage: !!params.hasHistologyImage,
      } : undefined,
      suppressNeutralSummary: spatialRegionMode ? !!params.suppressNeutralSummary : undefined,
      multiomeTarget: multiomeTarget || null,
      featureType: isAtacMarkers ? 'peak' : 'gene',
      cluster: spatialRegionMode ? 'Selected spatial region' : requestedCluster,
      // Include info about merged clusters
      mergedClusters: isMergedClusterRequest ? targetClusterIds : null,
      isMergedCluster: isMergedClusterRequest,
      totalCells,
      clusterSize: targetClusterSize,
      otherCells,
      totalGenes: nGenes,
      method: 'wilcoxon_rank_sum',
      logFCPseudoCount: pseudoCount,
      structureEnrichment,
      pathwayEnrichment,
      markers: positiveRows.slice(0, maxRows),
      availableClusters: uniqueClusters,
    },
  });
}

async function computeSelectedRegionGeneSetEnrichments(markerRows, geneNames, state) {
  const selectedMarkerNames = [];
  for (const row of markerRows.slice(0, 100)) {
    if (!row?.gene || !(row.avg_logFC > 0)) continue;
    if (Number.isFinite(row.p_val_adj) && row.p_val_adj > 0.1 && selectedMarkerNames.length >= 25) continue;
    const gene = String(row.gene).trim();
    if (gene) selectedMarkerNames.push(gene);
  }

  const queryGenes = Array.from(new Set(selectedMarkerNames.map(normalizePathwayGene).filter(Boolean)));
  if (queryGenes.length < 5) {
    const notEnough = {
      available: false,
      reason: 'not_enough_mapped_marker_genes',
      queryGenes,
      pathways: [],
      themes: [],
    };
    return { structureEnrichment: notEnough, pathwayEnrichment: notEnough };
  }

  const enrichrUserListId = await submitEnrichrGeneList(queryGenes, 'CellPilot selected spatial region markers');

  return {
    structureEnrichment: await computeEnrichrLibraryEnrichment(enrichrUserListId, queryGenes, {
      libraryName: SELECTED_REGION_CELLMARKER_LIBRARY,
      displayName: 'CellMarker 2024',
      reasonPrefix: 'cellmarker',
      method: 'enrichr_overrepresentation',
      source: 'Enrichr CellMarker 2024',
      maxThemes: 8,
      maxRawTerms: 80,
    }),
    pathwayEnrichment: await computeEnrichrLibraryEnrichment(enrichrUserListId, queryGenes, {
      libraryName: SELECTED_REGION_WIKIPATHWAYS_LIBRARY,
      displayName: 'WikiPathways 2024 Human',
      reasonPrefix: 'wikipathways',
      method: 'enrichr_overrepresentation',
      source: 'Enrichr WikiPathways 2024 Human',
      maxThemes: 8,
      maxRawTerms: 80,
    }),
  };
}

async function computeEnrichrLibraryEnrichment(userListId, queryGenes, options) {
  try {
    const url = `${ENRICHR_BASE_URL}/enrich?userListId=${encodeURIComponent(userListId)}&backgroundType=${encodeURIComponent(options.libraryName)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Enrichr ${options.displayName} request failed (${response.status})`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload?.[options.libraryName]) ? payload[options.libraryName] : [];
    if (!rows.length) {
      return {
        available: false,
        reason: `no_enrichr_${options.reasonPrefix}_results`,
        method: options.method,
        source: options.source,
        queryGenes,
        collections: [options.displayName],
        pathways: [],
        themes: [],
      };
    }

    const raw = rows.map(row => ({
      collection: options.displayName,
      term: row[1],
      description: '',
      pValue: Number(row[2]),
      enrichrAdjustedPValue: Number(row[6]),
      combinedScore: Number(row[4]),
      overlapGenes: Array.isArray(row[5])
        ? row[5].map(gene => String(gene).trim()).filter(Boolean)
        : String(row[5] || '').split(/[;,]/).map(gene => gene.trim()).filter(Boolean),
      overlapCount: Array.isArray(row[5]) ? row[5].length : String(row[5] || '').split(/[;,]/).filter(Boolean).length,
      querySize: queryGenes.length,
      geneSetSize: null,
      backgroundSize: null,
    })).filter(item => item.term && Number.isFinite(item.pValue));

    return summarizePathwayEnrichment(raw, {
      method: options.method,
      source: options.source,
      queryGenes,
      backgroundSize: null,
      collections: [options.displayName],
      maxThemes: options.maxThemes,
      maxRawTerms: options.maxRawTerms,
    });
  } catch (error) {
    console.warn(`Selected-region Enrichr ${options.displayName} enrichment failed:`, error);
    return {
      available: false,
      reason: `enrichr_${options.reasonPrefix}_failed`,
      error: error.message,
      method: options.method,
      source: options.source,
      queryGenes,
      collections: [options.displayName],
      pathways: [],
      themes: [],
    };
  }
}

async function submitEnrichrGeneList(queryGenes, description) {
  const body = new FormData();
  body.append('list', queryGenes.join('\n'));
  body.append('description', description);

  const response = await fetch(`${ENRICHR_BASE_URL}/addList`, {
    method: 'POST',
    body,
  });
  if (!response.ok) {
    throw new Error(`Enrichr addList failed (${response.status})`);
  }

  const payload = await response.json();
  if (payload?.userListId == null) {
    throw new Error('Enrichr addList response did not include a userListId');
  }
  return payload.userListId;
}

function computeGeneSetEnrichmentForCollections(context, options) {
  const wantedCollections = new Set();
  for (let i = 0; i < context.collectionNames.length; i++) {
    const text = `${context.collectionNames[i] || ''} ${context.collectionDescriptions[i] || ''}`;
    if (options.collectionPredicate(text)) {
      wantedCollections.add(i);
    }
  }

  if (!wantedCollections.size) {
    return {
      available: false,
      reason: `requested_${options.reasonPrefix}_collections_not_found`,
      collections: context.collectionNames,
      pathways: [],
      themes: [],
    };
  }

  const geneSets = [];
  const retainedSetIds = [];
  const universeSet = new Set();
  for (let setId = 0; setId < context.setNames.length; setId++) {
    if (!wantedCollections.has(context.setCollections[setId])) continue;
    const indices = Array.from(context.featureSetState.fetchFeatureSetIndices(setId) || []);
    if (indices.length < 5 || indices.length > options.maxSetSize) continue;
    geneSets.push(Int32Array.from(indices));
    retainedSetIds.push(setId);
    for (const index of indices) universeSet.add(index);
  }

  const queryInUniverse = context.selectedMarkerIndices.filter(index => universeSet.has(index));
  const retainedCollectionNames = context.collectionNames.filter((_, index) => wantedCollections.has(index));
  if (queryInUniverse.length < 8 || !geneSets.length) {
    return {
      available: false,
      reason: `not_enough_marker_genes_in_${options.reasonPrefix}_universe`,
      queryGenes: context.selectedMarkerNames,
      backgroundSize: universeSet.size || context.featureSetState.fetchUniverseSize?.() || null,
      collections: retainedCollectionNames,
      pathways: [],
      themes: [],
    };
  }

  const tested = scran.testGeneSetEnrichment(
    Int32Array.from(Array.from(new Set(queryInUniverse))),
    geneSets,
    Math.max(context.geneNames.length, ...Array.from(universeSet)) + 1
  );
  const querySet = new Set(queryInUniverse);
  const raw = [];
  for (let i = 0; i < retainedSetIds.length; i++) {
    const overlapCount = tested.count[i];
    if (overlapCount < 3) continue;
    const setId = retainedSetIds[i];
    const overlapGenes = Array.from(geneSets[i])
      .filter(index => querySet.has(index))
      .map(index => context.geneNames[index])
      .filter(Boolean);
    raw.push({
      collection: context.collectionNames[context.setCollections[setId]] || 'Gene set collection',
      term: context.setNames[setId],
      description: context.setDescriptions[setId] || '',
      pValue: tested.pvalue[i],
      overlapCount,
      querySize: queryInUniverse.length,
      geneSetSize: tested.size[i],
      backgroundSize: universeSet.size || context.featureSetState.fetchUniverseSize?.() || null,
      overlapGenes,
    });
  }

  return summarizePathwayEnrichment(raw, {
    method: options.method,
    source: options.source,
    queryGenes: context.selectedMarkerNames,
    backgroundSize: universeSet.size || context.featureSetState.fetchUniverseSize?.() || null,
    collections: retainedCollectionNames,
    maxThemes: options.maxThemes,
    maxRawTerms: options.maxRawTerms,
  });
}

function isFunctionalPathwayCollection(text) {
  return /hallmark/i.test(text) ||
    /reactome/i.test(text) ||
    /(go|gene ontology).*biological process/i.test(text) ||
    /biological process/i.test(text);
}

function isCellStructureCollection(text) {
  return /\bc8\b/i.test(text) ||
    /cell[\s_-]*type/i.test(text) ||
    /cell[\s_-]*marker/i.test(text) ||
    /single[\s_-]*cell/i.test(text) ||
    /tissue[\s_-]*(signature|marker|specific|structure|atlas)/i.test(text) ||
    /human protein atlas/i.test(text) ||
    /panglao/i.test(text) ||
    /tabula/i.test(text);
}

function normalizePathwayGene(gene) {
  return String(gene || '').trim().toUpperCase();
}

/**
 * Differential gene expression between two samples within a cluster (integration only).
 * Uses Wilcoxon rank-sum test; returns DEG table and data for volcano plot.
 */
async function degBetweenSamples(params = {}) {
  if (!loadedData || !loadedData.state) {
    throw new Error('No data loaded. Please load data first.');
  }
  const modality = loadedData.info?.modality;
  if (modality !== 'integration' && modality !== 'xenium-integration' && modality !== 'visium-hd-integration' && modality !== 'merfish-integration') {
    throw new Error('DEG between samples is only available for multi-sample integration data (scRNA, Xenium, Visium HD, or MERFISH integration).');
  }

  const { cluster, sample1, sample2 } = params;
  const datasetNames = loadedData.info?.datasetNames;
  if (!Array.isArray(datasetNames) || datasetNames.length < 2) {
    throw new Error('Integration dataset names are missing or insufficient.');
  }

  const state = loadedData.state;
  const normMatrix = state.rna_normalization.fetchNormalizedMatrix();
  const nCells = normMatrix.numberOfColumns();
  const nGenes = normMatrix.numberOfRows();
  const integrationMeta = getIntegrationViewsForPlot(nCells);
  if (!integrationMeta) {
    throw new Error('Could not get per-sample cell indices for integration.');
  }
  const { integrationViews, datasetNames: names } = integrationMeta;

  const resolveSampleName = (s) => {
    if (!s || typeof s !== 'string') return null;
    const t = s.trim().toLowerCase();
    const m1 = t.match(/sample\s*1/);
    const m2 = t.match(/sample\s*2/);
    if (m1) return names[0];
    if (m2) return names[1];
    const idx = names.findIndex((n) => n.toLowerCase() === t);
    if (idx >= 0) return names[idx];
    if (t === '1') return names[0];
    if (t === '2') return names[1];
    return null;
  };

  const s1 = resolveSampleName(sample1) || names[0];
  const s2 = resolveSampleName(sample2) || names[1];
  if (s1 === s2) {
    throw new Error(`Sample 1 and sample 2 must be different. Got: "${s1}". Available: ${names.join(', ')}`);
  }

  const indices1 = integrationViews[s1]?.indices ?? [];
  const indices2 = integrationViews[s2]?.indices ?? [];
  if (!indices1.length || !indices2.length) {
    throw new Error(`Missing cell indices for samples. Available: ${Object.keys(integrationViews).join(', ')}`);
  }

  let clusterAssignments = currentResults.clusters;
  if (!clusterAssignments || !clusterAssignments.length) {
    const fetched = state.choose_clustering.fetchClusters();
    if (!fetched || !fetched.length) {
      await runClusteringAndUMAP(false);
      clusterAssignments = Array.from(state.choose_clustering.fetchClusters());
    } else {
      clusterAssignments = Array.from(fetched);
    }
    currentResults.clusters = clusterAssignments;
  }
  if (!clusterAssignments || clusterAssignments.length !== nCells) {
    throw new Error('Cluster assignments unavailable or length mismatch.');
  }

  const uniqueClusters = Array.from(new Set(clusterAssignments));
  uniqueClusters.sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
  });

  let requestedCluster = cluster;
  if (requestedCluster === undefined || requestedCluster === null || requestedCluster === '') {
    requestedCluster = uniqueClusters[0];
  }
  let matchedCluster = uniqueClusters.find((c) => c === requestedCluster || String(c) === String(requestedCluster));
  if (matchedCluster === undefined && typeof requestedCluster === 'string') {
    const numMatch = requestedCluster.trim().match(/(\d+)/);
    if (numMatch) {
      const numVal = Number(numMatch[1]);
      matchedCluster = uniqueClusters.find((c) => c === numVal || String(c) === String(numVal));
      if (matchedCluster !== undefined) requestedCluster = matchedCluster;
    }
  }
  if (matchedCluster === undefined && typeof requestedCluster === 'number') {
    matchedCluster = uniqueClusters.find((c) => c === requestedCluster || Number(c) === requestedCluster);
    if (matchedCluster !== undefined) requestedCluster = matchedCluster;
  }
  if (matchedCluster === undefined) {
    throw new Error(`Cluster ${cluster} not found. Available: ${uniqueClusters.join(', ')}`);
  }
  requestedCluster = matchedCluster;
  const targetClusterSet = new Set([String(requestedCluster)]);

  const inClusterIndices = [];
  for (let i = 0; i < nCells; i++) {
    if (targetClusterSet.has(String(clusterAssignments[i]))) inClusterIndices.push(i);
  }

  const set1 = new Set(indices1);
  const set2 = new Set(indices2);
  const inIndices = inClusterIndices.filter((i) => set1.has(i));
  const outIndices = inClusterIndices.filter((i) => set2.has(i));
  if (inIndices.length === 0 || outIndices.length === 0) {
    throw new Error(
      `Not enough cells in cluster ${requestedCluster} for both samples. ` +
      `Sample "${s1}": ${inIndices.length} cells. Sample "${s2}": ${outIndices.length} cells.`
    );
  }

  self.postMessage({ type: 'STATUS_UPDATE', message: `Computing DEG in cluster ${requestedCluster} (${s1} vs ${s2})...` });

  const { geneNames } = await ensureGeneLookup();
  const pseudoCount = 1e-6;
  const mean1 = new Float64Array(nGenes);
  const mean2 = new Float64Array(nGenes);
  const detected1 = new Float64Array(nGenes);
  const detected2 = new Float64Array(nGenes);

  for (let g = 0; g < nGenes; g++) {
    const row = normMatrix.row(g, { asTypedArray: true });
    let sum1 = 0, sum2 = 0;
    let d1 = 0, d2 = 0;
    for (const i of inIndices) {
      sum1 += row[i];
      if (row[i] > 0) d1++;
    }
    for (const i of outIndices) {
      sum2 += row[i];
      if (row[i] > 0) d2++;
    }
    mean1[g] = inIndices.length ? sum1 / inIndices.length : 0;
    mean2[g] = outIndices.length ? sum2 / outIndices.length : 0;
    detected1[g] = inIndices.length ? d1 / inIndices.length : 0;
    detected2[g] = outIndices.length ? d2 / outIndices.length : 0;
  }

  const wilcoxonWorkspace = createWilcoxonWorkspace(inIndices.length, outIndices.length);
  const pValues = new Float64Array(nGenes);
  for (let g = 0; g < nGenes; g++) {
    const row = normMatrix.row(g, { asTypedArray: true });
    const p = wilcoxonRankSumPValue(row, inIndices, outIndices, wilcoxonWorkspace);
    pValues[g] = Number.isFinite(p) && p > 0 ? p : Number.MIN_VALUE;
  }
  const adjustedP = benjaminiHochberg(Array.from(pValues));

  const rows = [];
  for (let g = 0; g < nGenes; g++) {
    const m1 = mean1[g];
    const m2 = mean2[g];
    const avgLogFC = Math.log((m1 + pseudoCount) / (m2 + pseudoCount));
    rows.push({
      gene: geneNames[g] ?? `Gene_${g}`,
      p_val: pValues[g],
      avg_logFC: avgLogFC,
      pct1: detected1[g],
      pct2: detected2[g],
      p_val_adj: adjustedP[g],
      mean_in: m1,
      mean_out: m2,
    });
  }
  // DEG between samples: keep both directions but sort by descending logFC
  // so upregulated genes in sample1 appear first.
  rows.sort((a, b) => {
    if (a.p_val !== b.p_val) return a.p_val - b.p_val;
    return b.avg_logFC - a.avg_logFC;
  });

  const maxRows = 200;
  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'deg_between_samples',
      cluster: requestedCluster,
      sample1: s1,
      sample2: s2,
      markers: rows.slice(0, maxRows),
      allMarkers: rows,
      totalGenes: nGenes,
      method: 'wilcoxon_rank_sum',
      clusterSizeSample1: inIndices.length,
      clusterSizeSample2: outIndices.length,
      datasetNames: names,
    },
  });
}

/**
 * Differential peak accessibility between two samples within a cluster (atac-integration only).
 * Same interface as degBetweenSamples but uses peak matrix; returns table + volcano data with featureType: 'peak'.
 */
async function degPeaksBetweenSamples(params = {}) {
  if (!loadedData) {
    throw new Error('No data loaded. Please load data first.');
  }
  if (loadedData.info?.modality !== 'atac-integration') {
    throw new Error('Differential peaks between samples is only available for scATAC-seq multi-sample integration.');
  }

  const peakMatrix = loadedData.atacPeakMatrix;
  const peakNames = loadedData.atacPeakNames || loadedData.peakNames || [];
  const nCells = loadedData.cellBarcodes?.length ?? peakMatrix?.numberOfColumns?.() ?? 0;
  const integrationViews = loadedData.integrationViews;
  const datasetNames = loadedData.info?.datasetNames;

  if (!peakMatrix || !peakNames.length || nCells === 0) {
    throw new Error('Peak matrix not available for differential peak analysis.');
  }
  if (!integrationViews || typeof integrationViews !== 'object' || !Array.isArray(datasetNames) || datasetNames.length < 2) {
    throw new Error('Integration views or dataset names missing for differential peak analysis.');
  }

  const names = datasetNames;
  const { cluster, sample1, sample2 } = params;

  const resolveSampleName = (s) => {
    if (!s || typeof s !== 'string') return null;
    const t = s.trim().toLowerCase();
    const m1 = t.match(/sample\s*1/);
    const m2 = t.match(/sample\s*2/);
    if (m1) return names[0];
    if (m2) return names[1];
    const idx = names.findIndex((n) => n.toLowerCase() === t);
    if (idx >= 0) return names[idx];
    if (t === '1') return names[0];
    if (t === '2') return names[1];
    return null;
  };

  const s1 = resolveSampleName(sample1) || names[0];
  const s2 = resolveSampleName(sample2) || names[1];
  if (s1 === s2) {
    throw new Error(`Sample 1 and sample 2 must be different. Got: "${s1}". Available: ${names.join(', ')}`);
  }

  const indices1 = integrationViews[s1]?.indices ?? [];
  const indices2 = integrationViews[s2]?.indices ?? [];
  if (!indices1.length || !indices2.length) {
    throw new Error(`Missing cell indices for samples. Available: ${Object.keys(integrationViews).join(', ')}`);
  }

  let clusterAssignments = currentResults.clusters;
  if (!clusterAssignments || !clusterAssignments.length || clusterAssignments.length !== nCells) {
    throw new Error('Cluster assignments unavailable or length mismatch. Please run ATAC integration first.');
  }

  const uniqueClusters = Array.from(new Set(clusterAssignments));
  uniqueClusters.sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
  });

  let requestedCluster = cluster;
  if (requestedCluster === undefined || requestedCluster === null || requestedCluster === '') {
    requestedCluster = uniqueClusters[0];
  }
  let matchedCluster = uniqueClusters.find((c) => c === requestedCluster || String(c) === String(requestedCluster));
  if (matchedCluster === undefined && typeof requestedCluster === 'string') {
    const numMatch = requestedCluster.trim().match(/(\d+)/);
    if (numMatch) {
      const numVal = Number(numMatch[1]);
      matchedCluster = uniqueClusters.find((c) => c === numVal || String(c) === String(numVal));
      if (matchedCluster !== undefined) requestedCluster = matchedCluster;
    }
  }
  if (matchedCluster === undefined && typeof requestedCluster === 'number') {
    matchedCluster = uniqueClusters.find((c) => c === requestedCluster || Number(c) === requestedCluster);
    if (matchedCluster !== undefined) requestedCluster = matchedCluster;
  }
  if (matchedCluster === undefined) {
    throw new Error(`Cluster ${cluster} not found. Available: ${uniqueClusters.join(', ')}`);
  }
  requestedCluster = matchedCluster;
  const targetClusterSet = new Set([String(requestedCluster)]);

  const inClusterIndices = [];
  for (let i = 0; i < nCells; i++) {
    if (targetClusterSet.has(String(clusterAssignments[i]))) inClusterIndices.push(i);
  }

  const set1 = new Set(indices1);
  const set2 = new Set(indices2);
  const inIndices = inClusterIndices.filter((i) => set1.has(i));
  const outIndices = inClusterIndices.filter((i) => set2.has(i));
  if (inIndices.length === 0 || outIndices.length === 0) {
    throw new Error(
      `Not enough cells in cluster ${requestedCluster} for both samples. ` +
      `Sample "${s1}": ${inIndices.length} cells. Sample "${s2}": ${outIndices.length} cells.`
    );
  }

  const nGenes = peakNames.length;
  self.postMessage({ type: 'STATUS_UPDATE', message: `Computing differential peaks in cluster ${requestedCluster} (${s1} vs ${s2})...` });

  const pseudoCount = 1e-6;
  const mean1 = new Float64Array(nGenes);
  const mean2 = new Float64Array(nGenes);
  const detected1 = new Float64Array(nGenes);
  const detected2 = new Float64Array(nGenes);

  for (let g = 0; g < nGenes; g++) {
    const row = peakMatrix.row(g);
    let sum1 = 0, sum2 = 0;
    let d1 = 0, d2 = 0;
    for (const i of inIndices) {
      const v = row[i] ?? 0;
      sum1 += v;
      if (v > 0) d1++;
    }
    for (const i of outIndices) {
      const v = row[i] ?? 0;
      sum2 += v;
      if (v > 0) d2++;
    }
    mean1[g] = inIndices.length ? sum1 / inIndices.length : 0;
    mean2[g] = outIndices.length ? sum2 / outIndices.length : 0;
    detected1[g] = inIndices.length ? d1 / inIndices.length : 0;
    detected2[g] = outIndices.length ? d2 / outIndices.length : 0;
  }

  const wilcoxonWorkspace = createWilcoxonWorkspace(inIndices.length, outIndices.length);
  const pValues = new Float64Array(nGenes);
  for (let g = 0; g < nGenes; g++) {
    const row = peakMatrix.row(g);
    const p = wilcoxonRankSumPValue(row, inIndices, outIndices, wilcoxonWorkspace);
    pValues[g] = Number.isFinite(p) && p > 0 ? p : Number.MIN_VALUE;
  }
  const adjustedP = benjaminiHochberg(Array.from(pValues));

  const rows = [];
  for (let g = 0; g < nGenes; g++) {
    const m1 = mean1[g];
    const m2 = mean2[g];
    const avgLogFC = Math.log((m1 + pseudoCount) / (m2 + pseudoCount));
    rows.push({
      gene: peakNames[g] ?? `Peak_${g}`,
      p_val: pValues[g],
      avg_logFC: avgLogFC,
      pct1: detected1[g],
      pct2: detected2[g],
      p_val_adj: adjustedP[g],
      mean_in: m1,
      mean_out: m2,
    });
  }
  rows.sort((a, b) => {
    if (a.p_val !== b.p_val) return a.p_val - b.p_val;
    return b.avg_logFC - a.avg_logFC;
  });

  const maxRows = 200;
  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'deg_between_samples',
      featureType: 'peak',
      cluster: requestedCluster,
      sample1: s1,
      sample2: s2,
      markers: rows.slice(0, maxRows),
      allMarkers: rows,
      totalGenes: nGenes,
      method: 'wilcoxon_rank_sum',
      clusterSizeSample1: inIndices.length,
      clusterSizeSample2: outIndices.length,
      datasetNames: names,
    },
  });
}

/**
 * Cell fraction (proportion) per cluster per sample for integration. Returns counts and % for bar charts.
 */
async function plotCellFraction(params = {}) {
  if (!loadedData || !loadedData.state) {
    throw new Error('No data loaded. Please load data first.');
  }
  if (loadedData.info?.modality !== 'integration') {
    throw new Error('Cell fraction plot is only available for multi-sample integration data.');
  }

  const datasetNames = loadedData.info?.datasetNames;
  if (!Array.isArray(datasetNames) || datasetNames.length === 0) {
    throw new Error('Integration dataset names are missing.');
  }

  let clusterAssignments = currentResults.clusters;
  if (!clusterAssignments || !clusterAssignments.length) {
    const state = loadedData.state;
    let fetched = state.choose_clustering.fetchClusters();
    if (!fetched || !fetched.length) {
      await runClusteringAndUMAP(false);
      fetched = state.choose_clustering.fetchClusters();
    }
    clusterAssignments = Array.from(fetched);
    currentResults.clusters = clusterAssignments;
  }

  const nCells = clusterAssignments.length;
  const integrationMeta = getIntegrationViewsForPlot(nCells);
  if (!integrationMeta) {
    throw new Error('Could not get per-sample cell indices for integration.');
  }
  const { integrationViews, datasetNames: names } = integrationMeta;

  self.postMessage({ type: 'STATUS_UPDATE', message: 'Computing cell fraction per cluster per sample...' });

  const uniqueClusters = Array.from(new Set(clusterAssignments));
  uniqueClusters.sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
  });

  const perSample = {};
  for (const sampleName of names) {
    const indices = integrationViews[sampleName]?.indices ?? [];
    const totalCells = indices.length;
    const countByCluster = {};
    for (const id of uniqueClusters) countByCluster[String(id)] = 0;
    for (const i of indices) {
      const c = String(clusterAssignments[i]);
      if (countByCluster[c] !== undefined) countByCluster[c]++;
    }
    const entries = uniqueClusters.map((id) => ({
      clusterId: typeof id === 'number' ? id : Number(id),
      count: countByCluster[String(id)] ?? 0,
    }));
    perSample[sampleName] = { entries, totalCells };
  }

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'cell_fraction',
      datasetNames: names,
      perSample,
      clusterColorDomain: uniqueClusters.slice(),
    },
  });
}

async function regionComposition(params = {}) {
  if (!loadedData || !loadedData.state) {
    throw new Error('No data loaded. Please load data first.');
  }

  const regionClusters = currentResults.regionClusters;
  if (!regionClusters || !regionClusters.length) {
    throw new Error('No region segmentation data available. Please run BANKSY region segmentation first.');
  }

  let clusterAssignments = currentResults.clusters;
  if (!clusterAssignments || !clusterAssignments.length) {
    const state = loadedData.state;
    let fetched = state.choose_clustering.fetchClusters();
    if (!fetched || !fetched.length) {
      await runClusteringAndUMAP(false);
      fetched = state.choose_clustering.fetchClusters();
    }
    clusterAssignments = Array.from(fetched);
    currentResults.clusters = clusterAssignments;
  }

  const regionId = params.regionId != null ? Number(params.regionId) : null;
  const availableRegions = Array.from(new Set(regionClusters.filter(r => r >= 0))).sort((a, b) => a - b);

  if (regionId === null || !availableRegions.includes(regionId)) {
    throw new Error(
      `Invalid region ID "${params.regionId}". Available regions: ${availableRegions.join(', ')}`
    );
  }

  self.postMessage({ type: 'STATUS_UPDATE', message: `Computing cell type composition for region ${regionId}...` });

  const cellIndices = [];
  for (let i = 0; i < regionClusters.length; i++) {
    if (regionClusters[i] === regionId) cellIndices.push(i);
  }

  const countByCluster = {};
  for (const i of cellIndices) {
    if (i < clusterAssignments.length) {
      const c = String(clusterAssignments[i]);
      countByCluster[c] = (countByCluster[c] || 0) + 1;
    }
  }

  const uniqueClusters = Object.keys(countByCluster)
    .map(Number)
    .sort((a, b) => a - b);

  const totalCells = cellIndices.length;
  const entries = uniqueClusters.map((id) => ({
    clusterId: id,
    count: countByCluster[String(id)] || 0,
    fraction: totalCells > 0 ? (countByCluster[String(id)] || 0) / totalCells : 0,
  }));

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'region_composition',
      regionId,
      entries,
      totalCells,
      availableRegions,
      clusterColorDomain: uniqueClusters.slice(),
    },
  });
}

async function getClusterInfo(params = {}) {
  if (!loadedData || !loadedData.state) {
    throw new Error('No data loaded. Please load data first.');
  }

  // Support both single cluster and array of clusters (for merged/renamed clusters)
  const { cluster, clusters: mergedClusters, multiomeTarget } = params;
  const state = loadedData.state;

  // Get clusters – for multiome use RNA or ATAC precomputed so RNA view is unchanged after ATAC-only update
  let clusterAssignments = currentResults.clusters;
  if (loadedData?.info?.modality === 'multiome' && loadedData.precomputed) {
    if (multiomeTarget === 'atac' && loadedData.precomputed.atacAligned) {
      clusterAssignments = loadedData.precomputed.atacAligned.clusters;
      console.log('Multiome: using ATAC clusters for cluster_info');
    } else if (multiomeTarget !== 'atac' && loadedData.precomputed.rnaAligned?.clusters) {
      clusterAssignments = loadedData.precomputed.rnaAligned.clusters;
      console.log('Multiome: using RNA clusters for cluster_info');
    }
  }
  if (!clusterAssignments || !clusterAssignments.length) {
    let fetched = state.choose_clustering.fetchClusters();
    if (!fetched || !fetched.length) {
      await runClusteringAndUMAP(false);
      fetched = state.choose_clustering.fetchClusters();
    }
    clusterAssignments = Array.from(fetched);
    currentResults.clusters = clusterAssignments;
  }

  if (!clusterAssignments || !clusterAssignments.length) {
    throw new Error('Cluster assignments are unavailable.');
  }

  const totalCells = clusterAssignments.length;
  const uniqueClusters = Array.from(new Set(clusterAssignments));
  uniqueClusters.sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b;
    }
    return String(a).localeCompare(String(b));
  });

  // Handle merged clusters (multiple cluster IDs renamed to the same label)
  let targetClusterIds = [];
  let isMergedClusterRequest = false;

  if (Array.isArray(mergedClusters) && mergedClusters.length > 1) {
    // Multiple clusters merged to the same label - treat as one group
    isMergedClusterRequest = true;
    targetClusterIds = mergedClusters.map(c => {
      const numVal = typeof c === 'number' ? c : parseInt(c);
      const matched = uniqueClusters.find(uc =>
        uc === c || uc === numVal || String(uc) === String(c) || Number(uc) === numVal
      );
      return matched !== undefined ? matched : c;
    });
    console.log('getClusterInfo: Merged cluster request, target IDs:', targetClusterIds);
  }

  // Determine the requested cluster
  let requestedCluster = cluster;
  if (requestedCluster === undefined || requestedCluster === null || requestedCluster === '') {
    requestedCluster = uniqueClusters[0];
  }

  // Match the cluster (handle number/string type differences)
  let matchedCluster = uniqueClusters.find(c => c === requestedCluster);
  if (matchedCluster === undefined && typeof requestedCluster === 'string') {
    const numMatch = requestedCluster.trim().match(/(\d+)/);
    if (numMatch) {
      const numValue = Number(numMatch[1]);
      matchedCluster = uniqueClusters.find(c =>
        c === numValue || c === String(numValue) || String(c) === String(numValue)
      );
      if (matchedCluster !== undefined) {
        requestedCluster = matchedCluster;
      }
    }
  }
  if (matchedCluster === undefined && typeof requestedCluster === 'number') {
    matchedCluster = uniqueClusters.find(c =>
      c === requestedCluster || c === String(requestedCluster) || Number(c) === requestedCluster
    );
    if (matchedCluster !== undefined) {
      requestedCluster = matchedCluster;
    }
  }

  if (matchedCluster === undefined && !isMergedClusterRequest) {
    throw new Error(
      `Cluster ${cluster} not found. Available clusters: ${uniqueClusters.join(', ')}`
    );
  }

  requestedCluster = matchedCluster;

  // For merged clusters, use targetClusterIds instead of single requestedCluster
  const targetClustersSet = isMergedClusterRequest
    ? new Set(targetClusterIds.map(c => String(c)))
    : new Set([String(requestedCluster)]);

  // Count cells in the target cluster(s)
  let clusterCellCount = 0;
  clusterAssignments.forEach((value) => {
    if (targetClustersSet.has(String(value))) {
      clusterCellCount++;
    }
  });

  const clusterFraction = clusterCellCount / totalCells;

  // Now get top 10 markers for this cluster
  // We'll call findMarkers internally and extract the top 10
  console.log(`getClusterInfo: Getting top markers for cluster ${requestedCluster}`);

  const normMatrix = state.rna_normalization.fetchNormalizedMatrix();
  const { geneNames } = await ensureGeneLookup();
  const nGenes = geneNames.length;

  let meanTarget, detectedTarget, meanOther, detectedOther;
  const otherCells = totalCells - clusterCellCount;

  // Always compute cluster-info marker summaries from the current normalized
  // matrix. The old cached-results branch populated meanTarget/detectedTarget
  // from Bakana but left meanOther/detectedOther as zero-filled arrays. Since
  // cluster_info is rendered as the same marker table as find_markers, that
  // produced pct.2 = 0 and pseudo-count-inflated logFC values.
  meanTarget = new Float64Array(nGenes);
  detectedTarget = new Float64Array(nGenes);
  meanOther = new Float64Array(nGenes);
  detectedOther = new Float64Array(nGenes);

  const targetIndicesForStats = [];
  const otherIndicesForStats = [];
  clusterAssignments.forEach((value, index) => {
    if (targetClustersSet.has(String(value))) {
      targetIndicesForStats.push(index);
    } else {
      otherIndicesForStats.push(index);
    }
  });

  for (let geneIndex = 0; geneIndex < nGenes; geneIndex++) {
    const row = normMatrix.row(geneIndex, { asTypedArray: true });
    let sumTarget = 0, detectedCountTarget = 0;
    for (const idx of targetIndicesForStats) {
      const val = row[idx];
      sumTarget += val;
      if (val > 0) detectedCountTarget++;
    }
    meanTarget[geneIndex] = targetIndicesForStats.length > 0 ? sumTarget / targetIndicesForStats.length : 0;
    detectedTarget[geneIndex] = targetIndicesForStats.length > 0 ? detectedCountTarget / targetIndicesForStats.length : 0;

    let sumOther = 0, detectedCountOther = 0;
    for (const idx of otherIndicesForStats) {
      const val = row[idx];
      sumOther += val;
      if (val > 0) detectedCountOther++;
    }
    meanOther[geneIndex] = otherIndicesForStats.length > 0 ? sumOther / otherIndicesForStats.length : 0;
    detectedOther[geneIndex] = otherIndicesForStats.length > 0 ? detectedCountOther / otherIndicesForStats.length : 0;
  }

  // Compute Wilcoxon p-values for ranking
  // For merged clusters, match against all cluster IDs in the target set
  const inIndices = [];
  const outIndices = [];
  clusterAssignments.forEach((value, index) => {
    if (targetClustersSet.has(String(value))) {
      inIndices.push(index);
    } else {
      outIndices.push(index);
    }
  });

  const wilcoxonWorkspace = createWilcoxonWorkspace(inIndices.length, outIndices.length);
  const pValues = new Float64Array(nGenes);

  for (let geneIndex = 0; geneIndex < nGenes; geneIndex++) {
    const row = normMatrix.row(geneIndex, { asTypedArray: true });
    const p = wilcoxonRankSumPValue(row, inIndices, outIndices, wilcoxonWorkspace);
    pValues[geneIndex] = Number.isFinite(p) && p > 0 ? p : Number.MIN_VALUE;
  }

  // Build marker rows and sort
  const pseudoCount = 1e-6;
  const rows = [];
  for (let geneIndex = 0; geneIndex < nGenes; geneIndex++) {
    const meanIn = meanTarget[geneIndex];
    const meanOut = otherCells > 0 ? meanOther[geneIndex] : 0;
    const avgLogFC = Math.log((meanIn + pseudoCount) / (meanOut + pseudoCount));

    rows.push({
      gene: geneNames[geneIndex] ?? `Gene ${geneIndex}`,
      p_val: pValues[geneIndex],
      avg_logFC: avgLogFC,
      pct1: detectedTarget[geneIndex],
      pct2: detectedOther[geneIndex],
    });
  }

  // Only positive logFC markers (same reasoning as findMarkers)
  const positiveMarkerRows = rows.filter(r => r.avg_logFC > 0);
  positiveMarkerRows.sort((a, b) => {
    if (a.p_val !== b.p_val) return a.p_val - b.p_val;
    return b.avg_logFC - a.avg_logFC;
  });

  // Get top 10 markers for the summary text
  const topMarkers = positiveMarkerRows.slice(0, 10);
  // Get more markers for the full table display (same as find_markers)
  const maxRows = 200;
  const allMarkers = positiveMarkerRows.slice(0, maxRows);

  console.log(`getClusterInfo: Cluster ${requestedCluster} has ${clusterCellCount} cells (${(clusterFraction * 100).toFixed(1)}%)`);
  console.log('Top 10 markers:', topMarkers.map(m => m.gene));

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'cluster_info',
      cluster: requestedCluster,
      cellCount: clusterCellCount,
      totalCells: totalCells,
      fraction: clusterFraction,
      topMarkers: topMarkers,
      requestAnnotation: !!params.annotateCellType,
      // Include full marker data for table display (same format as 'markers' type)
      markers: allMarkers,
      totalGenes: nGenes,
      method: 'wilcoxon_rank_sum',
      availableClusters: uniqueClusters,
    },
  });
}

async function runQC() {
  if (!loadedData || !loadedData.state) {
    throw new Error('No data loaded');
  }

  try {
    const state = loadedData.state;

    // Get QC metrics from bakana
    const qcMetrics = state.rna_quality_control.fetchMetrics();
    
    const sums = Array.from(qcMetrics.sum());
    const detected = Array.from(qcMetrics.detected());
    let mitoPercent = null;
    try {
      const mito = qcMetrics.subsetProportion(0);
      mitoPercent = Array.from(mito).map(x => x * 100);
    } catch (e) {
      console.warn('Unable to fetch mitochondrial proportion:', e);
      mitoPercent = new Array(sums.length).fill(NaN);
    }
    
    // Calculate medians
    const median = (arr) => {
      const sorted = arr.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const metrics = {
      nCells: loadedData.nCells,
      nGenes: loadedData.nGenes,
      medianGenesPerCell: Math.round(median(detected)),
      medianUMIsPerCell: Math.round(median(sums)),
      meanGenesPerCell: Math.round(detected.reduce((a, b) => a + b, 0) / detected.length),
      meanUMIsPerCell: Math.round(sums.reduce((a, b) => a + b, 0) / sums.length),
      medianMitoPercent: Math.round(median(mitoPercent) * 10) / 10,
      meanMitoPercent: Math.round((mitoPercent.reduce((a, b) => a + b, 0) / mitoPercent.length) * 10) / 10,
    };

    currentResults.qc = metrics;

    console.log('QC metrics:', metrics);

    self.postMessage({
      type: 'ANALYSIS_COMPLETE',
      data: {
        type: 'qc',
        metrics: metrics,
        perCell: {
          genesPerCell: detected,
          umiPerCell: sums,
          mitoPercent: mitoPercent,
        }
      }
    });

  } catch (error) {
    console.error('QC failed:', error);
    throw error;
  }
}

async function mergeClusters(params = {}) {
  console.log('====== mergeClusters called ======');
  console.log('Params:', params);

  const isAtacIntegration = loadedData?.info?.modality === 'atac-integration';
  if (!loadedData || (!loadedData.state && !isAtacIntegration)) {
    throw new Error('No data loaded. Please load data first.');
  }

  const { sourceClusterIds, targetClusterId } = params;

  if (!Array.isArray(sourceClusterIds) || sourceClusterIds.length === 0) {
    throw new Error('sourceClusterIds must be a non-empty array');
  }

  if (targetClusterId === undefined || targetClusterId === null) {
    throw new Error('targetClusterId is required');
  }

  const state = loadedData.state;

  // Get current clusters
  let clusters = currentResults.clusters;
  if (!clusters || !clusters.length) {
    if (!state) throw new Error('No cluster assignments available');
    const fetched = state.choose_clustering.fetchClusters();
    if (!fetched || !fetched.length) {
      throw new Error('No cluster assignments available');
    }
    clusters = Array.from(fetched);
    currentResults.clusters = clusters;
  }

  console.log('Original clusters sample:', clusters.slice(0, 10));
  console.log('Merging clusters', sourceClusterIds, 'into', targetClusterId);

  // Merge: replace all occurrences of sourceClusterIds with targetClusterId
  let mergedCount = 0;
  for (let i = 0; i < clusters.length; i++) {
    const currentCluster = clusters[i];
    // Check if current cluster is one of the source clusters
    const shouldMerge = sourceClusterIds.some(srcId => {
      // Handle both numeric and string comparisons
      if (typeof currentCluster === 'number' && typeof srcId === 'number') {
        return currentCluster === srcId;
      }
      return String(currentCluster) === String(srcId);
    });

    if (shouldMerge) {
      clusters[i] = targetClusterId;
      mergedCount++;
    }
  }

  console.log(`Merged ${mergedCount} cells from clusters ${sourceClusterIds} into cluster ${targetClusterId}`);
  console.log('Updated clusters sample:', clusters.slice(0, 10));

  // Update the cached clusters
  currentResults.clusters = clusters;

  // Store the updated clusters back into the state (skip for atac-integration: no bakana state)
  if (state) {
    try {
      state.choose_clustering.storeClusters(clusters);
      console.log('Stored updated clusters back to state');
    } catch (error) {
      console.warn('Could not store clusters back to state:', error);
    }
  }

  // Get updated unique clusters
  const uniqueClusters = Array.from(new Set(clusters));
  uniqueClusters.sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b;
    }
    return String(a).localeCompare(String(b));
  });

  console.log('New unique clusters:', uniqueClusters);

  // Re-fetch UMAP coordinates to send back
  let umapCoordinates = currentResults.umap;
  if (!umapCoordinates && state) {
    const umapResults = await state.umap.fetchResults();
    umapCoordinates = [];
    for (let i = 0; i < umapResults.x.length; i++) {
      umapCoordinates.push([umapResults.x[i], umapResults.y[i]]);
    }
    currentResults.umap = umapCoordinates;
  }

  // Build the response message
  const uniqueAfterMerge = new Set(clusters.filter((c) => c !== null && c !== undefined));
  const messageData = {
    type: 'umap',
    coordinates: umapCoordinates,
    clusters: clusters,
    nClusters: uniqueAfterMerge.size,
    source: 'merged',
  };

  // Include spatial coordinates if available (for spatial modality)
  if (spatialData && Array.isArray(spatialData.coordinates)) {
    messageData.spatialCoordinates = spatialData.coordinates;
    messageData.spatialMatched = spatialData.matched;
    console.log('Including spatialCoordinates in merge response:', spatialData.coordinates.length);
  } else if (loadedData.spatialData && Array.isArray(loadedData.spatialData.coordinates)) {
    messageData.spatialCoordinates = loadedData.spatialData.coordinates;
    messageData.spatialMatched = loadedData.spatialData.matched;
    console.log('Including spatialCoordinates from loadedData in merge response:', loadedData.spatialData.coordinates.length);
  }

  // Include clusterLabelMap if it exists, so App can preserve cluster merges
  if (currentClusterLabelMap && Object.keys(currentClusterLabelMap).length > 0) {
    messageData.clusterLabelMap = currentClusterLabelMap;
    console.log('Including clusterLabelMap in merge response:', currentClusterLabelMap);
  }

  // atac-integration: include integrationViews + datasetNames so per-sample cards keep their cell indices
  if (loadedData?.info?.modality === 'atac-integration' && loadedData.integrationViews) {
    messageData.integrationViews = loadedData.integrationViews;
    messageData.datasetNames = loadedData.info.datasetNames;
  }

  // Clear gene-activity cache so re-plots use updated cluster assignments
  scAtacGeneActivityCache.clear();
  atacGeneActivityCache.clear();

  // Send the updated UMAP with merged clusters
  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: messageData,
  });

  console.log('mergeClusters complete - sent updated UMAP data');
}

async function runGeneralAnalysis(params) {
  // Run a default analysis pipeline
  await runClusteringAndUMAP();
}

async function showAnalysisParameters(params = {}) {
  if (!currentParameters) {
    throw new Error('No analysis has been run yet. Please run analysis first.');
  }

  const { step } = params; // Optional step filter: 'umap', 'clustering', 'pca', etc.

  // Extract and format key parameters from each analysis step
  const allParams = {
    cellFiltering: {},
    geneFiltering: {},
    featureSelection: {},
    pca: {},
    clustering: {},
    umap: {}
  };

  // Cell filtering (QC) parameters
  if (currentParameters.rna_quality_control) {
    const qc = currentParameters.rna_quality_control;
    allParams.cellFiltering = {
      minGenes: qc.detected_threshold ?? 'N/A',
      minUMIs: qc.sum_threshold ?? 'N/A',
      maxMito: qc.mito_threshold ?? 'N/A'
    };
  }

  // Gene filtering parameters
  if (currentParameters.feature_selection) {
    const fs = currentParameters.feature_selection;
    allParams.geneFiltering = {
      minCounts: fs.min_counts ?? 'N/A'
    };
  }

  // Variable genes (feature selection) parameters
  if (currentParameters.rna_pca) {
    allParams.featureSelection = {
      numVariableGenes: currentParameters.rna_pca.num_hvgs ?? 'N/A'
    };
  }

  // PCA parameters
  if (currentParameters.rna_pca) {
    allParams.pca = {
      numPCs: currentParameters.rna_pca.num_pcs ?? 'N/A'
    };
  }

  // Clustering parameters
  if (currentParameters.snn_graph_cluster) {
    const cluster = currentParameters.snn_graph_cluster;
    allParams.clustering = {
      algorithm: cluster.algorithm ?? 'N/A',
      resolution: cluster.leiden_resolution ?? cluster.multilevel_resolution ?? cluster.walktrap_steps ?? 'N/A'
    };
  }

  // UMAP parameters
  if (currentParameters.umap) {
    const umap = currentParameters.umap;
    allParams.umap = {
      minDist: umap.min_dist ?? 'N/A',
      numNeighbors: umap.num_neighbors ?? 'N/A'
    };
  }

  // Filter to specific step if requested
  let filteredParams = allParams;
  if (step) {
    filteredParams = {};
    if (allParams[step]) {
      filteredParams[step] = allParams[step];
    }
  }

  console.log('Analysis parameters retrieved:', filteredParams);

  self.postMessage({
    type: 'ANALYSIS_COMPLETE',
    data: {
      type: 'parameters',
      parameters: filteredParams,
      step: step || null
    }
  });
}

console.log('Analysis worker loaded');
