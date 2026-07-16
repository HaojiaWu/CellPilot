import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './App.css';
import FileLoader from './components/FileLoader';
import ChatBot from './components/ChatBot';
import ModelSelector from './components/ModelSelector';
import PlotView from './components/PlotView';
import CoveragePlot from './components/CoveragePlot';
import SpatialPlotView from './components/SpatialPlotView';
import CellPilotLogo from './components/CellPilotLogo';
import PreviousResultsDialog from './components/PreviousResultsDialog';
import spatialIcon from './assets/spatial-map.svg';
import { Toaster, Position, Icon, Tooltip } from '@blueprintjs/core';
import { buildSpatialIndex } from './utils/spatialIndex';
import { downloadModel, isModelLoaded, getCurrentModel } from './llm/webllmService';

// Patch window.Worker so ASAR paths are transparently redirected to the
// physically-unpacked copy. Chromium's Worker fetch bypasses Electron's ASAR
// protocol interceptor, so file:///...app.asar/... URLs fail silently.
// This must run at module load time, before any Worker is constructed.
if (typeof window !== 'undefined' && typeof Worker !== 'undefined' && !window.__electronWorkerPatched) {
  const _OriginalWorker = window.Worker;
  window.Worker = function ElectronAsarWorker(url, options) {
    let src = (url instanceof URL ? url.href : String(url));
    if (src.startsWith('file://') && src.includes('.asar/') && !src.includes('.asar.unpacked/')) {
      src = src.replace('.asar/', '.asar.unpacked/');
    }
    return new _OriginalWorker(src, options);
  };
  window.Worker.prototype = _OriginalWorker.prototype;
  window.__electronWorkerPatched = true;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const getClientCoordinates = (event) => {
  if ('touches' in event) {
    const touch = event.touches[0];
    if (!touch) {
      return null;
    }
    return { clientX: touch.clientX, clientY: touch.clientY };
  }
  return { clientX: event.clientX, clientY: event.clientY };
};

const MIN_TOP_PERCENT = 35;
const MAX_TOP_PERCENT = 80;
const MIN_UMAP_PERCENT = 30;
const MAX_UMAP_PERCENT = 70;
const MIN_GUIDE_WIDTH = 15;
const MAX_GUIDE_WIDTH = 40;
const MIN_LOADER_WIDTH = 20;
const MAX_LOADER_WIDTH = 40;
const MIN_CHAT_WIDTH = 30;

const getTutorialCommands = (dataInfo) => {
  const modality = dataInfo?.modality;
  const isAtac = modality === 'atac' || modality === 'atac-integration';
  const commonCommands = isAtac ? [
    'Rename cluster 1 to B cells',
    'Find marker peaks for cluster 2',
    'Dotplot MS4A1 CD3D',
    'Violin plot gene activity for MS4A1',
    'Plot gene activity for MS4A1',
    'List 10 peaks',
    'List cells',
    'Change color to green black red',
    'Rerun ATAC UMAP with min dist = 0.4',
    'Recluster the cells using resolution = 2.0',
    'Plot qc',
    'Tell me about cluster 6',
    'List parameters for cell filtering',
  ] : [
    'Rename cluster 1 and 3 to PT, then rename cluster 15 to Pod',
    'Find markers for PT',
    'Dotplot slc5a2 umod',
    'Violin plot slc5a2',
    'Plot slc5a2',
    'List 10 genes',
    'List cells',
    'Change color to green black red',
    'Rerun the analysis by setting min gene = 500',
    'Rerun umap with min dist = 0.4',
    'Recluster the cells using resolution = 2.0',
    'Plot qc',
    'Tell me about cluster 6',
    'List parameters for cell filtering',
  ];

  if (!dataInfo?.modality) {
    return commonCommands;
  }

  const format = dataInfo.format || '';
  const isSpatial = modality === 'spatial' ||
    modality === 'visium' ||
    modality === 'visium-hd' ||
    modality === 'xenium' ||
    modality === 'merfish' ||
    dataInfo.spatialCoordinates?.length > 0;
  const isVisiumHD = modality === 'visium-hd' || format === '10X Visium HD';
  const supportsSpatialImputation =
    (modality === 'spatial' && /xenium|merfish|cosmx/i.test(format)) ||
    ['xenium-integration', 'merfish-integration', 'cosmx-integration'].includes(modality);

  let moduleCommands = [];

  if (modality === 'multiome') {
    moduleCommands = [
      'Run WNN analysis',
      'Coverage plot MS4A1',
      'Link peaks to genes',
      'Show peak-gene links for MS4A1',
      'Run TF motif analysis for cluster 2',
      'Prioritize TF for cluster 2',
      'Highlight RNA cluster 1 on ATAC',
      'Highlight ATAC cluster 3 on RNA',
      'Rerun clustering for RNA with resolution = 1.2',
      'Rerun clustering for ATAC with resolution = 1.2',
      'Find markers for ATAC cluster 2',
    ];
  } else if (modality === 'atac') {
    moduleCommands = [
      'Plot gene activity for MS4A1',
      'Coverage plot MS4A1',
      'Violin plot gene activity for MS4A1',
      'Dotplot MS4A1 CD3D',
      'Find markers for cluster 2',
    ];
  } else if (modality === 'atac-integration') {
    moduleCommands = [
      'Plot gene activity for MS4A1',
      'Coverage plot MS4A1',
      'Find differential peaks for cluster 2 between sample 1 and sample 2',
      'Violin plot gene activity for MS4A1',
      'Dotplot MS4A1 CD3D',
    ];
  } else if (modality === 'integration' || modality === 'xenium-integration' || modality === 'visium-hd-integration' || modality === 'merfish-integration') {
    moduleCommands = [
      'Find differential genes for cluster 2 between sample 1 and sample 2',
      'Dotplot slc5a2 umod by sample',
    ];
    if (modality === 'integration') {
      moduleCommands.splice(1, 0, 'Plot cell fraction by sample');
    }
    if (supportsSpatialImputation) {
      moduleCommands.push('Impute NPHS2 expression');
    }
  } else if (isSpatial) {
    if (isVisiumHD) {
      const visiumHdCommands = [
        'Rerun the analysis by setting min gene = 50',
        'Recluster the cells using resolution = 2.0',
        'Rerun umap with min dist = 0.4',
        'Find markers for cluster 6',
        'Plot NPHS2',
        'Dotplot NPHS2 PODXL',
        'List 10 genes',
        'List cells',
        'Run BANKSY region segmentation',
        'Show regions',
        'What cell types are in region 1?',
        'Rename region 1 to cortex',
        'Find markers for the selected spatial region',
        'Run cell-cell interaction analysis across selected regions',
      ];
      return Array.from(new Set(visiumHdCommands)).slice(0, 15);
    }
    moduleCommands = [
      'Run BANKSY region segmentation',
      'Show regions',
      'What cell types are in region 1?',
      'Rename region 1 to cortex',
      'Find markers for the selected spatial region',
      'Run cell-cell interaction analysis across selected regions',
    ];
    if (supportsSpatialImputation) {
      moduleCommands.push('Impute NPHS2 expression');
    }
  }

  const commands = Array.from(new Set([...moduleCommands, ...commonCommands]));
  return commands.slice(0, 15);
};

function App() {
  const [dataPath, setDataPath] = useState(null);
  const [dataInfo, setDataInfo] = useState(null);
  const [selectedModel, setSelectedModel] = useState('all-minilm-l6');
  const [selectedChatModel, setSelectedChatModel] = useState('chatgpt');
  const [activePlot, setActivePlot] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [lastActiveArtifactId, setLastActiveArtifactId] = useState(null);
  const [worker, setWorker] = useState(null);
  const [autoClusterIssued, setAutoClusterIssued] = useState(false);
  // Previous results dialog: non-null when a saved cellpilot_results.json was found on load
  const [previousResultsDialog, setPreviousResultsDialog] = useState(null);
  const saveResultsDebounceRef = useRef(null);
  const toasterRef = useRef(null);
  const chatBotRef = useRef(null);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  const showToast = useCallback((options) => {
    if (!options) {
      return;
    }
    const { message, intent = 'primary', timeout = 2000 } = options;
    toasterRef.current?.show({ message, intent, timeout });
  }, []);
  const describeColorMap = (map) => {
    if (!map) return 'lightgray-orange-red';
    if (map.type === 'scheme') {
      return map.name;
    }
    if (map.type === 'custom' && Array.isArray(map.colors)) {
      return map.colors.join(' → ');
    }
    return 'custom colors';
  };
  const [defaultColorMap, setDefaultColorMap] = useState({ type: 'custom', colors: ['lightgray', 'orange', 'red'] });
  const [pendingGeneColorMap, setPendingGeneColorMap] = useState(null);
  const mainContentRef = useRef(null);
  const visualRowRef = useRef(null);
  const interactionRowRef = useRef(null);
  const resizeStateRef = useRef({ type: null, startX: 0, startY: 0, initialLayout: null });
  const [activeHandle, setActiveHandle] = useState(null);
  const [clusterPlot, setClusterPlot] = useState(null);
  const [regionPlot, setRegionPlot] = useState(null);
  const [regionLabelMap, setRegionLabelMap] = useState({});
  const [spatialSelection, setSpatialSelection] = useState(null);
  // Integration/atac-integration: when true, per-sample cards show UMAP by cluster only (no gene overlay from last plot)
  const [integrationShowClustersOnly, setIntegrationShowClustersOnly] = useState(false);
  // Multiome: separate ATAC cluster/UMAP and active plot states
  const [atacClusterPlot, setAtacClusterPlot] = useState(null);
  const [atacActivePlot, setAtacActivePlot] = useState(null);
  // scATAC: Peak View content (gene/coverage plot); kept when user says "plot clusters" so UMAP View updates only
  const [peakViewPlot, setPeakViewPlot] = useState(null);
  const [atacClusterLabelMap, setAtacClusterLabelMap] = useState({});
  const [atacClusterColorOverrides, setAtacClusterColorOverrides] = useState({});
  const [atacSelectedClusters, setAtacSelectedClusters] = useState(new Set());
  const [selectedClusters, setSelectedClusters] = useState(new Set());
  // Multiome: highlight cells from this RNA cluster on the ATAC view (same cells, red highlight)
  const [rnaClusterHighlightOnAtac, setRnaClusterHighlightOnAtac] = useState(null);
  // Multiome: highlight cells from this ATAC cluster on the RNA view (same cells, red highlight)
  const [atacClusterHighlightOnRna, setAtacClusterHighlightOnRna] = useState(null);
  // Multiome: legend-click selection – same cells highlighted on both RNA and ATAC in cluster colors; { modality, clusterIds: Set, clusterIdToColor: { [id]: [r,g,b,a] } }
  const [legendHighlightSelection, setLegendHighlightSelection] = useState(null);
  // WNN 3-panel mode: individual RNA/ATAC UMAPs + integrated view
  const [wnnRnaPlot, setWnnRnaPlot] = useState(null);
  const [wnnAtacPlot, setWnnAtacPlot] = useState(null);
  const [wnnActive, setWnnActive] = useState(false);
  const [wnnClusterLabelMap, setWnnClusterLabelMap] = useState({});
  const [wnnClusterColorOverrides, setWnnClusterColorOverrides] = useState({});
  // WNN cross-panel highlight: { sourceClusters: Array, highlightClusterId: string, sourceModality: 'wnn-rna'|'wnn-atac'|'wnn-integrated' } | null
  const [wnnCrossHighlight, setWnnCrossHighlight] = useState(null);
  // Cluster color overrides: { [clusterId: string]: '#rrggbb' }
  const [clusterColorOverrides, setClusterColorOverrides] = useState({});
  // Cluster label map: { [originalClusterId: string]: 'newLabel' } for renaming clusters
  const [clusterLabelMap, setClusterLabelMap] = useState({});
  // Agent annotation table from the most recent "annotate all clusters" run.
  const [agentAnnotationRows, setAgentAnnotationRows] = useState([]);
  // Track when worker is processing an analysis request
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // Realtime status message from worker (e.g. scATAC loading steps), shown in chat input when loading
  const [workerStatusMessage, setWorkerStatusMessage] = useState('');
  // Auto-load embedding model on app start
  const [autoModelLoadAttempted, setAutoModelLoadAttempted] = useState(false);
  const [layout, setLayout] = useState({
    topHeight: 60,
    umapWidth: 50,
    guideWidth: 24,
    loaderWidth: 24,
  });
  const dataInfoRef = useRef(null);
  const dataPathRef = useRef(null);
  // Refs mirroring state for use in async callbacks/saves
  const clusterLabelMapRef = useRef({});
  const clusterColorOverridesRef = useRef({});
  const atacClusterLabelMapRef = useRef({});
  const agentAnnotationRowsRef = useRef([]);
  const wnnActiveRef = useRef(false);
  const clusterPlotRef = useRef(null);
  const regionLabelMapRef = useRef({});
  // Stores latest UMAP/cluster data for auto-save (set after analysis completes)
  const pendingSaveDataRef = useRef(null);
  // Hash of last saved payload to avoid redundant disk writes when save is triggered multiple times
  const lastSavedPayloadHashRef = useRef(null);
  // When user says "coverage plot [gene]", show Peak View (CoveragePlot) as main content in ATAC view
  const pendingShowPeakViewRef = useRef(false);
  // Multiome gene plot: timeout to re-enable chat if ATAC message never arrives (e.g. no peaks for gene)
  const multiomeGenePlotTimeoutRef = useRef(null);
  // Set when we start a multiome plot_gene_expression so RNA handler knows to wait for ATAC
  const pendingMultiomeGenePlotRef = useRef(false);
  // Cache fragment-based coverage by region (key: fragmentsPath|chrom|start|end) so repeat same-gene is instant
  const atacFragmentCoverageCacheRef = useRef(new Map());
  /** Sync horizontal/vertical scroll across atac-integration per-sample coverage plots. */
  const coverageScrollSyncRef = useRef({ containers: {}, handlers: {}, syncing: false });

  // Multiome / integration: handle legend cluster click – sync highlight on both views in cluster colors; Ctrl+click = multi-select
  // In integration mode, when a label is merged (e.g. PT = clusters 0,1,3,5), clicking that label highlights all cluster IDs with that label
  const handleLegendClusterClick = useCallback((modality, clusterId, colorRgba, ctrlKey) => {
    const id = String(clusterId);
    const color = Array.isArray(colorRgba) ? colorRgba : [102, 126, 234, 255];
    setLegendHighlightSelection((prev) => {
      const nextIds = new Set(prev?.clusterIds ?? []);
      const nextColors = { ...(prev?.clusterIdToColor ?? {}) };
      if (prev?.modality !== modality) {
        nextIds.clear();
        Object.keys(nextColors).forEach((k) => delete nextColors[k]);
      }
      // Resolve all cluster IDs that share the same label (merged/renamed clusters), applies to all modalities
      const labelMapForModality = modality === 'atac' ? atacClusterLabelMap : clusterLabelMap;
      const idsToToggle = labelMapForModality
        ? (() => {
            const label = labelMapForModality[id] ?? id;
            const allForLabel = Object.entries(labelMapForModality)
              .filter(([, v]) => v === label)
              .map(([k]) => k);
            return allForLabel.length > 0 ? allForLabel : [id];
          })()
        : [id];
      if (ctrlKey) {
        const allSelected = idsToToggle.every((cid) => nextIds.has(cid));
        if (allSelected) {
          idsToToggle.forEach((cid) => {
            nextIds.delete(cid);
            delete nextColors[cid];
          });
        } else {
          idsToToggle.forEach((cid) => {
            nextIds.add(cid);
            nextColors[cid] = color;
          });
        }
      } else {
        const onlyThisSelected = idsToToggle.length > 0 && idsToToggle.every((cid) => nextIds.has(cid)) && nextIds.size === idsToToggle.length;
        if (onlyThisSelected) {
          return null;
        }
        nextIds.clear();
        Object.keys(nextColors).forEach((k) => delete nextColors[k]);
        idsToToggle.forEach((cid) => {
          nextIds.add(cid);
          nextColors[cid] = color;
        });
      }
      if (nextIds.size === 0) return null;
      const sourceClusters = modality === 'atac'
        ? atacClusterPlot?.data?.clusters
        : clusterPlot?.data?.clusters;
      const sourceBarcodes = modality === 'atac'
        ? atacClusterPlot?.data?.cellBarcodes
        : clusterPlot?.data?.cellBarcodes;
      const selectedBarcodes = new Set();
      if (Array.isArray(sourceClusters) && Array.isArray(sourceBarcodes) && sourceClusters.length === sourceBarcodes.length) {
        for (let i = 0; i < sourceClusters.length; i++) {
          if (nextIds.has(String(sourceClusters[i]))) {
            const barcode = String(sourceBarcodes[i] ?? '').trim();
            if (barcode) selectedBarcodes.add(barcode);
          }
        }
      }
      return { modality, clusterIds: nextIds, clusterIdToColor: nextColors, selectedBarcodes, color };
    });
  }, [atacClusterLabelMap, atacClusterPlot, clusterLabelMap, clusterPlot]);

  const clearLegendHighlight = useCallback(() => {
    setLegendHighlightSelection(null);
  }, []);

  const buildAgentCellAnnotations = useCallback((rows, clusters, cellBarcodes = []) => {
    if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(clusters) || clusters.length === 0) {
      return [];
    }

    const byCluster = new Map();
    rows.forEach((row) => {
      const clusterId = row?.clusterId ?? row?.cluster ?? row?.id;
      if (clusterId === null || clusterId === undefined) return;
      byCluster.set(String(clusterId), {
        clusterId: String(clusterId),
        clusterLabel: row.clusterLabel || `Cluster ${clusterId}`,
        cellType: row.cellType || '',
        shortName: row.shortName || row.cellType || '',
        confidence: row.confidence || '',
        supportingMarkers: row.markers || row.supportingMarkers || '',
        rationale: row.rationale || '',
      });
    });

    return clusters.map((cluster, index) => {
      const clusterId = String(cluster);
      const annotation = byCluster.get(clusterId);
      return {
        cellIndex: index,
        barcode: cellBarcodes[index] || null,
        cluster: clusterId,
        annotation: annotation?.shortName || clusterLabelMapRef.current?.[clusterId] || clusterId,
        cellType: annotation?.cellType || '',
        confidence: annotation?.confidence || '',
      };
    });
  }, []);

  // WNN 3-panel cross-highlight: clicking a cluster in any panel highlights the same cells in all panels
  const wnnHighlightMask = useMemo(() => {
    if (!wnnCrossHighlight) return null;
    const { sourceClusters, highlightClusterId } = wnnCrossHighlight;
    if (!Array.isArray(sourceClusters)) return null;
    return sourceClusters.map(c => String(c) === String(highlightClusterId));
  }, [wnnCrossHighlight]);

  // WNN legend click: called by onLegendClusterClick in each panel with its viewModality
  const handleWnnLegendClick = useCallback((viewModality, clusterId) => {
    const sourceClusters =
      viewModality === 'wnn-rna' ? wnnRnaPlot?.data?.clusters :
      viewModality === 'wnn-atac' ? wnnAtacPlot?.data?.clusters :
      clusterPlot?.data?.clusters;
    if (!Array.isArray(sourceClusters)) return;
    const id = String(clusterId);
    setWnnCrossHighlight((prev) => {
      if (prev && prev.sourceModality === viewModality && prev.highlightClusterId === id) {
        return null; // toggle off when clicking same cluster again
      }
      return { sourceClusters, highlightClusterId: id, sourceModality: viewModality };
    });
  }, [wnnRnaPlot, wnnAtacPlot, clusterPlot]);

  useEffect(() => {
    return () => {
      if (multiomeGenePlotTimeoutRef.current) clearTimeout(multiomeGenePlotTimeoutRef.current);
    };
  }, []);

  const handleResizeMove = useCallback((event) => {
    const state = resizeStateRef.current;
    if (!state.type) {
      return;
    }

    if ('touches' in event && event.touches.length > 0 && event.cancelable) {
      event.preventDefault();
    }

    const coords = getClientCoordinates(event);
    if (!coords) {
      return;
    }
    const { clientX, clientY } = coords;
    const { initialLayout } = state;

    if (state.type === 'mainSplit') {
      const container = mainContentRef.current;
      if (!container) {
        return;
      }
      const totalHeight = container.clientHeight || 1;
      const deltaPercent = ((clientY - state.startY) / totalHeight) * 100;
      const proposedTop = initialLayout.topHeight + deltaPercent;
      setLayout((prev) => ({
        ...prev,
        topHeight: clamp(proposedTop, MIN_TOP_PERCENT, MAX_TOP_PERCENT),
      }));
      return;
    }

    if (state.type === 'umapSpatial') {
      const row = visualRowRef.current;
      if (!row) {
        return;
      }
      const totalWidth = row.clientWidth || 1;
      const deltaPercent = ((clientX - state.startX) / totalWidth) * 100;
      const proposed = initialLayout.umapWidth + deltaPercent;
      setLayout((prev) => ({
        ...prev,
        umapWidth: clamp(proposed, MIN_UMAP_PERCENT, MAX_UMAP_PERCENT),
      }));
      return;
    }

    if (state.type === 'guideChat') {
      const panel = interactionRowRef.current;
      if (!panel) {
        return;
      }
      const totalWidth = panel.clientWidth || 1;
      const deltaPercent = ((clientX - state.startX) / totalWidth) * 100;
      const proposed = initialLayout.guideWidth + deltaPercent;
      setLayout((prev) => {
        const dynamicMax = Math.max(
          MIN_GUIDE_WIDTH,
          Math.min(MAX_GUIDE_WIDTH, 100 - prev.loaderWidth - MIN_CHAT_WIDTH)
        );
        return {
          ...prev,
          guideWidth: clamp(proposed, MIN_GUIDE_WIDTH, dynamicMax),
        };
      });
      return;
    }

    if (state.type === 'chatLoader') {
      const panel = interactionRowRef.current;
      if (!panel) {
        return;
      }
      const totalWidth = panel.clientWidth || 1;
      const deltaPercent = ((clientX - state.startX) / totalWidth) * 100;
      const proposed = initialLayout.loaderWidth - deltaPercent;
      setLayout((prev) => {
        const dynamicMax = Math.max(
          MIN_LOADER_WIDTH,
          Math.min(MAX_LOADER_WIDTH, 100 - prev.guideWidth - MIN_CHAT_WIDTH)
        );
        return {
          ...prev,
          loaderWidth: clamp(proposed, MIN_LOADER_WIDTH, dynamicMax),
        };
      });
    }
  }, []);

  const handleResizeEnd = useCallback(() => {
    if (!resizeStateRef.current.type) {
      return;
    }
    resizeStateRef.current = { type: null, startX: 0, startY: 0, initialLayout: null };
    setActiveHandle(null);
    window.removeEventListener('mousemove', handleResizeMove);
    window.removeEventListener('mouseup', handleResizeEnd);
    window.removeEventListener('touchmove', handleResizeMove);
    window.removeEventListener('touchend', handleResizeEnd);
    window.removeEventListener('touchcancel', handleResizeEnd);
  }, [handleResizeMove]);

  const startResize = useCallback((type) => (event) => {
    const coords = getClientCoordinates(event);
    if (!coords) {
      return;
    }
    if (event.preventDefault) {
      event.preventDefault();
    }
    resizeStateRef.current = {
      type,
      startX: coords.clientX,
      startY: coords.clientY,
      initialLayout: { ...layout },
    };
    setActiveHandle(type);
    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);
    window.addEventListener('touchmove', handleResizeMove, { passive: false });
    window.addEventListener('touchend', handleResizeEnd);
    window.addEventListener('touchcancel', handleResizeEnd);
  }, [handleResizeEnd, handleResizeMove, layout]);

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
      window.removeEventListener('touchmove', handleResizeMove);
      window.removeEventListener('touchend', handleResizeEnd);
      window.removeEventListener('touchcancel', handleResizeEnd);
    };
  }, [handleResizeEnd, handleResizeMove]);

  useEffect(() => {
    dataInfoRef.current = dataInfo;
  }, [dataInfo]);

  useEffect(() => {
    dataPathRef.current = dataPath;
    atacFragmentCoverageCacheRef.current.clear();
  }, [dataPath]);

  // Sync cluster state to refs so async save callbacks always read latest values
  useEffect(() => { clusterLabelMapRef.current = clusterLabelMap; }, [clusterLabelMap]);
  useEffect(() => { clusterColorOverridesRef.current = clusterColorOverrides; }, [clusterColorOverrides]);
  useEffect(() => { atacClusterLabelMapRef.current = atacClusterLabelMap; }, [atacClusterLabelMap]);
  useEffect(() => { agentAnnotationRowsRef.current = agentAnnotationRows; }, [agentAnnotationRows]);
  useEffect(() => { clusterPlotRef.current = clusterPlot; }, [clusterPlot]);
  useEffect(() => { regionLabelMapRef.current = regionLabelMap; }, [regionLabelMap]);
  useEffect(() => { wnnActiveRef.current = wnnActive; }, [wnnActive]);

  // Execute the actual save to cellpilot_results.json (skips write if payload unchanged to avoid redundant writes)
  const doSaveResults = useCallback(async () => {
    const savePath = dataPathRef.current;
    // For H5/HDF5 files the save path is the file itself; write next to the file instead
    const saveFolder = /\.(h5|hdf5)$/i.test(savePath || '')
      ? savePath.substring(0, Math.max(savePath.lastIndexOf('/'), savePath.lastIndexOf('\\')))
      : savePath;
    const pending = pendingSaveDataRef.current;
    // If regionData exists but umapData is missing, fall back to clusterPlot data
    if (pending && !pending.umapData && pending.regionData && clusterPlotRef.current?.data) {
      pending.umapData = clusterPlotRef.current.data;
    }
    if (!savePath || !pending?.umapData?.coordinates || !window.electron?.saveCellpilotResults) {
      return;
    }
    const results = {
      version: 1,
      timestamp: new Date().toISOString(),
      modality: dataInfoRef.current?.modality,
      umapCoordinates: pending.umapData.coordinates,
      clusters: pending.umapData.clusters,
      nCells: pending.umapData.nCells || pending.umapData.coordinates?.length,
      nClusters: pending.umapData.nClusters,
      clusterLabelMap: clusterLabelMapRef.current || {},
      clusterColorOverrides: clusterColorOverridesRef.current || {},
    };
    if (pending.umapData.integrationViews) results.integrationViews = pending.umapData.integrationViews;
    if (pending.umapData.datasetNames) results.datasetNames = pending.umapData.datasetNames;
    if (pending.atacUmapData?.coordinates) {
      results.atacUmapCoordinates = pending.atacUmapData.coordinates;
      results.atacClusters = pending.atacUmapData.clusters;
      results.atacNClusters = pending.atacUmapData.nClusters;
      results.atacClusterLabelMap = atacClusterLabelMapRef.current || {};
    }
    if (pending.wnnWasActive) {
      results.wnnActive = true;
      if (pending.wnnRnaUmapData?.coordinates) {
        results.wnnRnaCoordinates = pending.wnnRnaUmapData.coordinates;
        results.wnnRnaClusters = pending.wnnRnaUmapData.clusters;
        results.wnnRnaNClusters = pending.wnnRnaUmapData.nClusters;
      }
      if (pending.wnnAtacUmapData?.coordinates) {
        results.wnnAtacCoordinates = pending.wnnAtacUmapData.coordinates;
        results.wnnAtacClusters = pending.wnnAtacUmapData.clusters;
        results.wnnAtacNClusters = pending.wnnAtacUmapData.nClusters;
      }
    }
    // BANKSY region segmentation data (independent from transcriptomic clusters)
    if (pending.regionData?.regionClusters?.length > 0) {
      results.regionClusters = pending.regionData.regionClusters;
      results.regionCoordinates = pending.regionData.coordinates;
      results.regionNclusters = pending.regionData.regionNclusters;
      results.regionSpatialCoordinates = pending.regionData.regionSpatialCoordinates;
      results.regionBanksyParams = pending.regionData.regionBanksyParams;
      const rlm = regionLabelMapRef.current;
      if (rlm && Object.keys(rlm).length > 0) {
        results.regionLabelMap = rlm;
      }
    }
    // Include SpaGE-imputed gene arrays (plotting-only, never used in reanalysis)
    if (pending.imputedGenes && Object.keys(pending.imputedGenes).length > 0) {
      results.imputedGenes = pending.imputedGenes;
    }
    // Persist peak-gene links so the expensive LinkPeaks analysis is not repeated on reload
    if (Array.isArray(pending.peakGeneLinks) && pending.peakGeneLinks.length > 0) {
      results.peakGeneLinks = pending.peakGeneLinks;
    }
    // Persist filtered cell barcodes for barcode-to-cluster mapping in standalone scripts
    if (Array.isArray(pending.cellBarcodes) && pending.cellBarcodes.length > 0) {
      results.cellBarcodes = pending.cellBarcodes;
    }
    if (Array.isArray(agentAnnotationRowsRef.current) && agentAnnotationRowsRef.current.length > 0) {
      results.agentClusterAnnotations = agentAnnotationRowsRef.current;
      results.agentCellAnnotations = buildAgentCellAnnotations(
        agentAnnotationRowsRef.current,
        pending.umapData.clusters,
        pending.cellBarcodes || pending.umapData.cellBarcodes || []
      );
    }
    // Persist spatial coordinates so "Load previous" can restore the exact same tissue view order.
    const savedSpatial = pending.umapData?.spatialCoordinates || dataInfoRef.current?.spatialCoordinates;
    if (Array.isArray(savedSpatial) && savedSpatial.length > 0) {
      results.spatialCoordinates = savedSpatial;
    }
    // Skip write if content unchanged (avoids repeated saves when multiple triggers fire)
    const payloadHash = JSON.stringify({
      n: results.nCells,
      c: results.nClusters,
      labels: results.clusterLabelMap,
      colors: results.clusterColorOverrides,
      wnn: results.wnnActive ? 1 : 0,
      regionN: results.regionNclusters || 0,
      regionLabels: regionLabelMapRef.current || {},
      imputedGeneKeys: Object.keys(pending.imputedGenes || {}).sort().join(','),
      linkNLinks: results.peakGeneLinks?.length || 0,
      hasBarcodes: results.cellBarcodes?.length || 0,
      hasSpatialCoords: results.spatialCoordinates?.length || 0,
      agentAnnotations: agentAnnotationRowsRef.current || [],
    });
    if (lastSavedPayloadHashRef.current === payloadHash) return;
    try {
      await window.electron.saveCellpilotResults(saveFolder, results);
      lastSavedPayloadHashRef.current = payloadHash;
    } catch (e) {
      console.warn('CellPilot: failed to save results:', e);
    }
  }, [buildAgentCellAnnotations]);

  // Debounced save scheduler (coalesces rapid triggers into one save)
  const scheduleResultsSave = useCallback(() => {
    if (saveResultsDebounceRef.current) clearTimeout(saveResultsDebounceRef.current);
    saveResultsDebounceRef.current = setTimeout(doSaveResults, 2500);
  }, [doSaveResults]);

  // Auto-save when cluster/region labels or colors change (user renamed clusters/regions etc.)
  useEffect(() => {
    if (pendingSaveDataRef.current?.umapData || pendingSaveDataRef.current?.regionData) scheduleResultsSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterLabelMap, clusterColorOverrides, atacClusterLabelMap, regionLabelMap, agentAnnotationRows]);

  // Flush pending save synchronously when app closes so results are never lost
  useEffect(() => {
    const handleBeforeUnload = () => {
      const savePath = dataPathRef.current;
      const saveFolder = /\.(h5|hdf5)$/i.test(savePath || '')
        ? savePath.substring(0, Math.max(savePath.lastIndexOf('/'), savePath.lastIndexOf('\\')))
        : savePath;
      const pending = pendingSaveDataRef.current;
      // If regionData exists but umapData is missing, fall back to clusterPlot data
      if (pending && !pending.umapData && pending.regionData && clusterPlotRef.current?.data) {
        pending.umapData = clusterPlotRef.current.data;
      }
      if (!savePath || !pending?.umapData?.coordinates || !window.electron?.saveCellpilotResultsSync) return;
      const results = {
        version: 1,
        timestamp: new Date().toISOString(),
        modality: dataInfoRef.current?.modality,
        umapCoordinates: pending.umapData.coordinates,
        clusters: pending.umapData.clusters,
        nCells: pending.umapData.nCells || pending.umapData.coordinates?.length,
        nClusters: pending.umapData.nClusters,
        clusterLabelMap: clusterLabelMapRef.current || {},
        clusterColorOverrides: clusterColorOverridesRef.current || {},
      };
      if (pending.umapData.integrationViews) results.integrationViews = pending.umapData.integrationViews;
      if (pending.umapData.datasetNames) results.datasetNames = pending.umapData.datasetNames;
      if (pending.atacUmapData?.coordinates) {
        results.atacUmapCoordinates = pending.atacUmapData.coordinates;
        results.atacClusters = pending.atacUmapData.clusters;
        results.atacNClusters = pending.atacUmapData.nClusters;
        results.atacClusterLabelMap = atacClusterLabelMapRef.current || {};
      }
      if (pending.wnnWasActive) {
        results.wnnActive = true;
        if (pending.wnnRnaUmapData?.coordinates) {
          results.wnnRnaCoordinates = pending.wnnRnaUmapData.coordinates;
          results.wnnRnaClusters = pending.wnnRnaUmapData.clusters;
          results.wnnRnaNClusters = pending.wnnRnaUmapData.nClusters;
        }
        if (pending.wnnAtacUmapData?.coordinates) {
          results.wnnAtacCoordinates = pending.wnnAtacUmapData.coordinates;
          results.wnnAtacClusters = pending.wnnAtacUmapData.clusters;
          results.wnnAtacNClusters = pending.wnnAtacUmapData.nClusters;
        }
      }
      if (pending.regionData?.regionClusters?.length > 0) {
        results.regionClusters = pending.regionData.regionClusters;
        results.regionCoordinates = pending.regionData.coordinates;
        results.regionNclusters = pending.regionData.regionNclusters;
        results.regionSpatialCoordinates = pending.regionData.regionSpatialCoordinates;
        results.regionBanksyParams = pending.regionData.regionBanksyParams;
        const rlm = regionLabelMapRef.current;
        if (rlm && Object.keys(rlm).length > 0) {
          results.regionLabelMap = rlm;
        }
      }
      if (pending.imputedGenes && Object.keys(pending.imputedGenes).length > 0) {
        results.imputedGenes = pending.imputedGenes;
      }
      if (Array.isArray(pending.cellBarcodes) && pending.cellBarcodes.length > 0) {
        results.cellBarcodes = pending.cellBarcodes;
      }
      if (Array.isArray(agentAnnotationRowsRef.current) && agentAnnotationRowsRef.current.length > 0) {
        results.agentClusterAnnotations = agentAnnotationRowsRef.current;
        results.agentCellAnnotations = buildAgentCellAnnotations(
          agentAnnotationRowsRef.current,
          pending.umapData.clusters,
          pending.cellBarcodes || pending.umapData.cellBarcodes || []
        );
      }
      const savedSpatial = pending.umapData?.spatialCoordinates || dataInfoRef.current?.spatialCoordinates;
      if (Array.isArray(savedSpatial) && savedSpatial.length > 0) {
        results.spatialCoordinates = savedSpatial;
      }
      window.electron.saveCellpilotResultsSync(saveFolder, results);
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-load first embedding model on app start (bundled model)
  useEffect(() => {
    const autoLoadModel = async () => {
      // Only auto-load once on app start
      if (autoModelLoadAttempted) return;

      // Check if model is already loaded (from cache)
      if (isModelLoaded()) {
        setAutoModelLoadAttempted(true);
        // Ensure selected model matches what's loaded
        const currentModel = getCurrentModel();
        if (currentModel) {
          setSelectedModel(currentModel);
        }
        return;
      }

      // Mark that we've attempted loading (even if it fails)
      setAutoModelLoadAttempted(true);

      const firstModelId = 'all-minilm-l6';
      const success = await downloadModel(firstModelId, (progress) => {
        // Only show toast when fully loaded to avoid interrupting user
        if (progress === 100) {
          // Don't show toast on initial load, it's expected behavior
        }
      });

      if (success) {
        // Update selected model to match what was loaded
        setSelectedModel(firstModelId);
      } else {
        console.warn('Auto-load of embedding model failed');
      }
    };

    // Load model immediately on app start (don't wait for data)
    autoLoadModel();
  }, [autoModelLoadAttempted]);

  const chatWidth = Math.max(MIN_CHAT_WIDTH, 100 - layout.guideWidth - layout.loaderWidth);
  const bottomHeight = Math.max(0, 100 - layout.topHeight);

  // Initialize WebAssembly worker
  useEffect(() => {
    // new URL() MUST be written directly inside new Worker() so webpack detects it
    // as a worker entry and emits a compiled IIFE chunk to static/js/.
    // The module-level window.Worker patch above handles the ASAR → ASAR.unpacked
    // URL redirect at runtime, covering this worker and all others (ONNX, WebLLM).
    const analysisWorker = new Worker(
      new URL('./workers/analysis.worker.js', import.meta.url)
    );

    // Handle worker messages
    analysisWorker.onmessage = (event) => {
      const { type, data, error, message } = event.data;
      
      
      if (type === 'INIT_SUCCESS') {
        showToast({
          message: 'Analysis engine ready',
          intent: 'success',
          timeout: 2000,
        });
      } else if (type === 'DATA_LOADED') {

        // If this is spatial data with precomputed coordinates, or ATAC (pipeline runs on load), prevent auto-clustering
        if (data.modality === 'spatial' && data.spatialCoordinates) {
          setAutoClusterIssued(true);
        }
        if (data.modality === 'atac') {
          setAutoClusterIssued(true);
        }
        if (data.modality === 'multiome') {
          setAutoClusterIssued(true);
          // Store peak count if provided
          if (data.peaks) {
            setDataInfo(prev => prev ? { ...prev, peaks: data.peaks } : prev);
          }
        }
        if (data.modality === 'integration' || data.modality === 'atac-integration' || data.modality === 'xenium-integration' || data.modality === 'visium-hd-integration' || data.modality === 'merfish-integration') {
          setAutoClusterIssued(true);
        }

        // Log polygon data if present (Visium HD)
        if (data.hasPolygons) {
        }

        setDataInfo(prev => {
          const nextCoords = data.spatialCoordinates || prev?.spatialCoordinates;
          const nextExtent = data.spatialExtent || prev?.spatialExtent;
          const hasSpatialCoords = Array.isArray(nextCoords) && nextCoords.length > 0;
          // Build spatial index whenever we have coordinates (including on first DATA_LOADED for Visium HD binned)
          const shouldBuildIndex = hasSpatialCoords;
          const modality = data.modality || prev?.modality || 'single-cell';

          return {
            ...prev,
            cells: data.cells,
            genes: data.genes,
            rawCells: Number.isFinite(data.rawCells)
              ? data.rawCells
              : (Number.isFinite(prev?.rawCells) ? prev.rawCells : data.cells),
            rawGenes: Number.isFinite(data.rawGenes)
              ? data.rawGenes
              : (Number.isFinite(prev?.rawGenes) ? prev.rawGenes : data.genes),
            spatialCoordinates: nextCoords,
            spatialExtent: nextExtent,
            spatialIndex: shouldBuildIndex
              ? buildSpatialIndex(nextCoords, (() => {
                  if (prev?.format !== '10X Visium HD') {
                    return { maxLevels: 9, baseSamplesPerTile: 800, levelSampleMultiplier: 1.8, hardSampleCap: 25000 };
                  }
                  // Binned needs 4x sampling (sparser bins); segmented uses 2x
                  return prev?.dataType === 'binned'
                    ? { maxLevels: 9, baseSamplesPerTile: 3200, levelSampleMultiplier: 1.8, hardSampleCap: 100000 }
                    : { maxLevels: 9, baseSamplesPerTile: 1600, levelSampleMultiplier: 1.8, hardSampleCap: 50000 };
                })())
              : prev?.spatialIndex,
            spatialReady: prev?.spatialReady || (modality === 'spatial' && hasSpatialCoords),
            modality,
            datasetNames: data.datasetNames || prev?.datasetNames || null,
            // Xenium integration: per-sample spatial data
            perSampleSpatial: data.perSampleSpatial || prev?.perSampleSpatial || null,
            // Visium HD polygon data
            hasPolygons: data.hasPolygons || prev?.hasPolygons || false,
            polygons: data.polygons || prev?.polygons || null,
          };
        });
        const featureLabel = (data.modality === 'atac' || data.modality === 'atac-integration') ? 'peaks' : data.modality === 'integration' ? 'genes' : 'genes';
        showToast({
          message: `Data loaded: ${data.cells} cells, ${data.genes} ${featureLabel}`,
          intent: 'success',
          timeout: 3000,
        });
      } else if (type === 'ANALYSIS_COMPLETE') {
        if (data.type === 'dataset_list') {
          chatBotRef.current?.handleDatasetListResult?.(data);
          setIsAnalyzing(false);
          return;
        }
        chatBotRef.current?.handleAnalysisResultForAgent?.({ data });
        const modality = dataInfoRef.current?.modality;
        if (data.source === 'precomputed') {
          setAutoClusterIssued(true);
        }

        if (data.type === 'umap') {
          // Detect reclustering and reset labels/colors so merged clusters don't persist
          const isReclustered = data.source === 'reclustered';
          if (isReclustered) {
            setClusterLabelMap({});
            setClusterColorOverrides({});
            if (modality === 'multiome') {
              setAtacClusterLabelMap({});
              setAtacClusterColorOverrides({});
              setWnnClusterLabelMap({});
              setWnnClusterColorOverrides({});
            }
            setRegionPlot(null);
            setRegionLabelMap({});
            if (pendingSaveDataRef.current) {
              pendingSaveDataRef.current = { ...pendingSaveDataRef.current, regionData: null };
            }
            atacFragmentCoverageCacheRef.current.clear();
          }

          // Multiome: clear cross-view highlights and legend-click selection so both views show full cluster colors
          if (modality === 'multiome') {
            setRnaClusterHighlightOnAtac(null);
            setAtacClusterHighlightOnRna(null);
            setLegendHighlightSelection(null);
          }

          // Multiome: route to RNA or ATAC cluster plot based on multiomeModality
          if (data.multiomeModality === 'atac') {
            // WNN individual ATAC UMAP: store for the ATAC panel of the 3-panel WNN layout
            if (data.source === 'wnn-individual') {
              setWnnAtacPlot({ source: 'analysis', data });
              setAtacClusterLabelMap({});
              setAtacClusterColorOverrides({});
              pendingSaveDataRef.current = { ...(pendingSaveDataRef.current || {}), wnnAtacUmapData: data, wnnWasActive: true };
              return;
            }
            const atacPayload = { source: 'analysis', data };
            // When WNN is active, atacClusterPlot holds the WNN ATAC coordinates, don't overwrite with realigned precomputed data
            if (!data.realigned || !wnnActiveRef.current) {
              setAtacClusterPlot(atacPayload);
              setAtacActivePlot(null); // Clear any active ATAC plot (dotplot/violin) so UMAP shows
            }
            const isWNN = data.source === 'wnn';
            showToast({
              message: isWNN
                ? 'WNN complete, 3-panel view ready (RNA / ATAC / WNN)'
                : 'ATAC UMAP updated (colored by ATAC clusters)',
              intent: 'success',
              timeout: isWNN ? 4000 : 2000,
            });
            // Save multiome ATAC UMAP data for combined save
            pendingSaveDataRef.current = { ...(pendingSaveDataRef.current || {}), atacUmapData: data };
            scheduleResultsSave();
            // WNN: force-save immediately (bypass hash check so WNN data is never skipped)
            if (isWNN) {
              lastSavedPayloadHashRef.current = null; // force fresh write
              doSaveResults();
            }
            // Only re-enable chat if we're not waiting for multiome gene plot (RNA + ATAC gene_expression)
            if (!pendingMultiomeGenePlotRef.current) {
              setIsAnalyzing(false);
              setWorkerStatusMessage('');
            }
            return;
          }

          // Multiome RNA: clear active plot so UMAP shows instead of previous dotplot/violin
          if (modality === 'multiome') {
            // WNN individual RNA UMAP: store for the RNA panel of the 3-panel WNN layout
            if (data.source === 'wnn-individual') {
              setWnnRnaPlot({ source: 'analysis', data });
              setClusterLabelMap({});
              setClusterColorOverrides({});
              pendingSaveDataRef.current = { ...(pendingSaveDataRef.current || {}), wnnRnaUmapData: data, wnnWasActive: true };
              return;
            }
            // WNN integrated result: activate the 3-panel layout
            if (data.source === 'wnn') {
              setWnnActive(true);
              setWnnClusterLabelMap({});
              setWnnClusterColorOverrides({});
              setWnnCrossHighlight(null);
            } else if (!data.realigned) {
              // Non-WNN cluster result (not a post-normalization realignment): deactivate WNN layout
              // data.realigned=true means background normalization re-sent precomputed UMAPs, don't kill WNN
              setWnnActive(false);
            }
            setActivePlot(null);
            setLastActiveArtifactId(null);
          }

          // Integration: store full UMAP + integrationViews for per-dataset panels
          if (data.integrationViews && data.datasetNames) {
            setClusterPlot({ source: 'analysis', data });
            setIntegrationShowClustersOnly(true); // show UMAP by cluster only (no gene overlay) until user plots a gene again
            if (data.source !== 'merged') {
              setActivePlot(null);
              setLastActiveArtifactId(null);
            }
            // Restore saved cluster labels/colors when loading previous results (so renamed clusters persist after reload)
            if (data.restoredClusterLabelMap && Object.keys(data.restoredClusterLabelMap).length > 0) {
              setClusterLabelMap(data.restoredClusterLabelMap);
            }
            if (data.restoredClusterColorOverrides && Object.keys(data.restoredClusterColorOverrides).length > 0) {
              setClusterColorOverrides(data.restoredClusterColorOverrides);
            }
            if (Array.isArray(data.restoredAgentClusterAnnotations) && data.restoredAgentClusterAnnotations.length > 0) {
              setAgentAnnotationRows(data.restoredAgentClusterAnnotations);
            }
            // Xenium/VisiumHD integration: store per-sample spatial coordinates and build spatial indices
            if (data.perSampleSpatial) {
              const isHD = modality === 'visium-hd-integration';
              setDataInfo((prev) => ({
                ...prev,
                perSampleSpatial: Object.fromEntries(
                  Object.entries(data.perSampleSpatial).map(([name, sampleData]) => {
                    const coords = sampleData.spatialCoordinates;
                    const spatialIndexParams = isHD
                      ? { maxLevels: 9, baseSamplesPerTile: 1600, levelSampleMultiplier: 1.8, hardSampleCap: 50000 }
                      : { maxLevels: 9, baseSamplesPerTile: 800, levelSampleMultiplier: 1.8, hardSampleCap: 25000 };
                    const idx = Array.isArray(coords) && coords.length > 0
                      ? buildSpatialIndex(coords, spatialIndexParams)
                      : null;
                    return [name, { ...sampleData, spatialIndex: idx }];
                  })
                ),
              }));
            }
            setIsAnalyzing(false);
            setWorkerStatusMessage('');
            const toastMsg = data.source === 'merged'
              ? 'Clusters merged, all sample views updated'
              : modality === 'xenium-integration'
                ? 'Xenium integration complete (per-sample spatial views)'
                : modality === 'visium-hd-integration'
                  ? 'Visium HD integration complete (per-sample spatial views)'
                  : modality === 'merfish-integration'
                    ? 'MERFISH integration complete (per-sample spatial views)'
                    : 'Integration UMAP ready (per-dataset views)';
            showToast({ message: toastMsg, intent: 'success', timeout: 2000 });
            // Save integration results (UMAP + clusters) to disk
            pendingSaveDataRef.current = { ...(pendingSaveDataRef.current || {}), umapData: data };
            scheduleResultsSave();
            return;
          }

          const umapPayload = { source: 'analysis', data };

          if (data.source === 'banksy') {
            // BANKSY regions are stored independently, never overwrite transcriptomic clusterPlot
            setRegionPlot(umapPayload);
          } else {
            // When WNN is active, clusterPlot holds the WNN integrated coordinates.
            // A realigned post-normalization update would overwrite them with precomputed coords,
            // making the WNN panel show the wrong UMAP shape. Skip it.
            if (!data.realigned || !wnnActiveRef.current) {
              setClusterPlot(umapPayload);
            }
          }
          // For spatial: show UMAP in the main view. For scATAC: set activePlot so UMAP View updates;
          // Peak View stays unchanged (uses peakViewPlot, not activePlot).
          if (modality === 'spatial' || modality === 'atac') {
            setActivePlot(umapPayload);
            setLastActiveArtifactId(null);
          }
          if (modality === 'atac') {
            setIsAnalyzing(false);
            setWorkerStatusMessage('');
            // Set numeric cells/genes so dataLoaded is true and plot commands (e.g. plot Nphs2) work
            setDataInfo((prev) => {
              if (!prev || prev.modality !== 'atac') return prev;
              const cells = data.cells ?? data.nCells;
              const genes = data.genes ?? data.nGenes;
              return Number.isFinite(cells) && Number.isFinite(genes)
                ? { ...prev, cells, genes, rawCells: prev.rawCells ?? cells, rawGenes: prev.rawGenes ?? genes }
                : prev;
            });
          }
          setDataInfo((prev) => {
            if (!prev || prev.modality !== 'spatial') {
              return prev;
            }
            
            // Update spatial coordinates if they were sent with the analysis results
            // (this happens after reanalysis where cell order may have changed)
            const coords = data.spatialCoordinates || prev.spatialCoordinates;
            const shouldRebuildIndex = data.spatialCoordinates && Array.isArray(coords) && coords.length > 0;
            
            if (data.spatialCoordinates) {
            }
            
            return {
              ...prev,
              spatialCoordinates: coords,
              spatialReady: true,
              spatialIndex: shouldRebuildIndex || !prev.spatialReady
                ? (Array.isArray(coords) && coords.length
                    ? buildSpatialIndex(coords, {
                        maxLevels: 9,
                        baseSamplesPerTile: 800,
                        levelSampleMultiplier: 1.8,
                        hardSampleCap: 25000,
                      })
                    : null)
                : prev.spatialIndex,
            };
          });
          showToast({
            message: data.source === 'wnn'
              ? 'WNN co-embedding ready, building 3-panel view...'
              : data.source === 'banksy'
                ? `BANKSY complete, ${data.nClusters} spatial region${data.nClusters !== 1 ? 's' : ''} identified`
                : 'UMAP updated (colored by clusters)',
            intent: 'success',
            timeout: data.source === 'banksy' ? 4000 : 2000,
          });
          // Restore saved cluster labels/colors when loading previous results
          if (data.restoredClusterLabelMap && Object.keys(data.restoredClusterLabelMap).length > 0) {
            setClusterLabelMap(data.restoredClusterLabelMap);
          }
          if (data.restoredClusterColorOverrides && Object.keys(data.restoredClusterColorOverrides).length > 0) {
            setClusterColorOverrides(data.restoredClusterColorOverrides);
          }
          if (Array.isArray(data.restoredAgentClusterAnnotations) && data.restoredAgentClusterAnnotations.length > 0) {
            setAgentAnnotationRows(data.restoredAgentClusterAnnotations);
          }
          // Restore saved region data when loading previous results
          if (data.restoredRegionData) {
            const rd = data.restoredRegionData;
            setRegionPlot({
              source: 'analysis',
              data: {
                type: 'umap',
                coordinates: rd.coordinates || data.coordinates,
                clusters: rd.regionClusters,
                nClusters: rd.regionNclusters || new Set(rd.regionClusters).size,
                nCells: rd.regionClusters.length,
                source: 'banksy',
                banksyResult: true,
                spatialCoordinates: rd.regionSpatialCoordinates || data.spatialCoordinates,
                banksyParams: rd.regionBanksyParams || {},
              },
            });
            pendingSaveDataRef.current = { ...(pendingSaveDataRef.current || {}), regionData: rd };
            if (rd.regionLabelMap && Object.keys(rd.regionLabelMap).length > 0) {
              setRegionLabelMap(rd.regionLabelMap);
            }
          }
          // Schedule auto-save of results (UMAP + clusters) to the input folder
          if (data.source === 'banksy') {
            // BANKSY: save region data separately, don't overwrite transcriptomic umapData
            const prev = pendingSaveDataRef.current || {};
            // Ensure umapData is present so doSaveResults doesn't bail out.
            // Fall back to current clusterPlot if umapData was never populated.
            if (!prev.umapData && clusterPlotRef.current?.data) {
              prev.umapData = clusterPlotRef.current.data;
            }
            pendingSaveDataRef.current = {
              ...prev,
              regionData: {
                regionClusters: data.clusters,
                coordinates: data.coordinates,
                regionNclusters: data.nClusters,
                regionSpatialCoordinates: data.spatialCoordinates,
                regionBanksyParams: data.banksyParams,
              },
            };
            // Force immediate save (bypass debounce) to ensure region data is persisted
            lastSavedPayloadHashRef.current = null;
            doSaveResults();
          } else {
            const umap_update = { ...(pendingSaveDataRef.current || {}), umapData: data };
            if (Array.isArray(data.cellBarcodes) && data.cellBarcodes.length > 0) {
              umap_update.cellBarcodes = data.cellBarcodes;
            }
            pendingSaveDataRef.current = umap_update;
          }
          scheduleResultsSave();
        } else if (data.type === 'gene_expression') {
          // Multiome: this is the RNA (first) message, mark that we're waiting for ATAC so we don't re-enable chat yet
          if (!data.multiomeModality && modality === 'multiome') {
            pendingMultiomeGenePlotRef.current = true;
          }
          // Multiome ATAC gene expression → route to ATAC view
          if (data.multiomeModality === 'atac') {
            const appliedColorMap = data.colorMap || pendingGeneColorMap || defaultColorMap;
            const atacArtifactId = `atac_plot_${Date.now()}`;
            const showPeakViewAsPrimary = pendingShowPeakViewRef.current;
            if (pendingShowPeakViewRef.current) pendingShowPeakViewRef.current = false;
            const atacArtifact = {
              id: atacArtifactId,
              type: 'gene_expression',
              geneName: data.geneName,
              coordinates: data.coordinates || atacClusterPlot?.data?.coordinates,
              expression: data.expression,
              expressionRange: data.expressionRange,
              colorMap: appliedColorMap,
              peaksOnGene: data.peaksOnGene,
              coverageByCluster: data.coverageByCluster,
              region: data.region,
              genome: data.genome,
              isAtac: true,
              showPeakViewAsPrimary: showPeakViewAsPrimary,
              createdAt: new Date().toISOString(),
            };

            // Handle fragment-based coverage async update (same as ATAC mode)
            const currentDataPath = dataPathRef.current;
            const willQueryFragments =
              data.region &&
              data.cellBarcodes?.length > 0 &&
              data.clusters?.length > 0 &&
              currentDataPath &&
              window.electron?.queryAtacFragments;


            if (willQueryFragments) {
              const fragmentsPath = `${currentDataPath}/atac_fragments.tsv.gz`;
              const fragmentCacheKey = `${fragmentsPath}|${data.region.chrom}|${data.region.start}|${data.region.end}`;
              const cachedCoverage = atacFragmentCoverageCacheRef.current.get(fragmentCacheKey);
              if (cachedCoverage) {
                atacArtifact.coverageByCluster = cachedCoverage;
                atacArtifact.fragmentBased = true;
              } else {
                // Show loading until fragment-based coverage is ready (smooth binned signal from fragments.tsv.gz).
                atacArtifact.coverageByCluster = null;
                (async () => {
                  try {
                    const barcodeToCluster = {};
                    const numMapped = Math.min(data.cellBarcodes.length, data.clusters.length);
                    for (let i = 0; i < numMapped; i++) {
                      barcodeToCluster[data.cellBarcodes[i]] = data.clusters[i];
                    }
                    const result = await window.electron.queryAtacFragments({
                      fragmentsPath,
                      region: data.region,
                      cellBarcodes: data.cellBarcodes,
                      barcodeToCluster,
                      clusterMeanDepths: data.clusterMeanDepths || null,
                      binSize: 25,
                    });
                    if (result.success && result.coverageByCluster?.length > 0) {
                      // Coverage is already Signac-style normalized by electron.js
                      atacFragmentCoverageCacheRef.current.set(fragmentCacheKey, result.coverageByCluster);
                      setArtifacts(prev => prev.map(a =>
                        a.id === atacArtifactId
                          ? { ...a, coverageByCluster: result.coverageByCluster, fragmentBased: true }
                          : a
                      ));
                    } else if (!result.success) {
                      console.warn('Multiome fragment query failed:', result.error);
                    } else {
                      console.warn('Multiome fragment query returned no coverage:', result.fragmentCount, 'fragments found');
                    }
                  } catch (err) {
                    console.warn('Failed to query multiome ATAC fragments:', err);
                  }
                })();
              }
            }

            setArtifacts(prev => [...prev, atacArtifact]);
            setAtacActivePlot({ source: 'artifact', artifactId: atacArtifactId });
            showToast({
              message: showPeakViewAsPrimary
                ? (data.peaksOnGene?.length
                  ? `Peak View: ${data.geneName} (${data.peaksOnGene.length} peaks)`
                  : `Peak View: ${data.geneName}`)
                : (data.peaksOnGene?.length
                  ? `ATAC: Gene activity for ${data.geneName} (${data.peaksOnGene.length} peaks)`
                  : `ATAC: Gene activity plotted for ${data.geneName}`),
              intent: 'success',
              timeout: 2000,
            });
            if (multiomeGenePlotTimeoutRef.current) {
              clearTimeout(multiomeGenePlotTimeoutRef.current);
              multiomeGenePlotTimeoutRef.current = null;
            }
            pendingMultiomeGenePlotRef.current = false;
            setIsAnalyzing(false);
            setWorkerStatusMessage('');
            return;
          }

          // Use colorMap from the worker data if available, otherwise fall back to pending or default
          const appliedColorMap = data.colorMap || pendingGeneColorMap || defaultColorMap;
          setPendingGeneColorMap(null);
          const artifactId = `plot_${Date.now()}`;


          // For ATAC data, try to compute fragment-based coverage for smoother peak plots
          const currentDataPath = dataPathRef.current;

          // Check if we will query fragment-based coverage
          const willQueryFragments =
            data.isAtac &&
            data.region &&
            data.cellBarcodes?.length > 0 &&
            data.clusters?.length > 0 &&
            currentDataPath &&
            window.electron?.queryAtacFragments;

          // When we will fetch fragment-based coverage, do not show the initial peak-matrix (bin-bar) plot.
          // Show loading until fragment-based coverage is ready, then a single peak coverage plot with chromosome + gene track.
          let finalCoverageByCluster = willQueryFragments ? null : data.coverageByCluster;

          // Debug: Log fragment query conditions (explicit strings for easier debugging)

          if (willQueryFragments) {
            const fragmentsPath = `${currentDataPath}/fragments.tsv.gz`;
            const fragmentCacheKey = `${fragmentsPath}|${data.region.chrom}|${data.region.start}|${data.region.end}`;
            const cachedCoverage = atacFragmentCoverageCacheRef.current.get(fragmentCacheKey);
            if (cachedCoverage) {
              finalCoverageByCluster = cachedCoverage;
            } else {
              // Query fragment-based coverage asynchronously
              (async () => {
                try {

                  // Build barcode to cluster mapping (only for cells that have clusters)
                  const barcodeToCluster = {};
                  const numMapped = Math.min(data.cellBarcodes.length, data.clusters.length);
                  for (let i = 0; i < numMapped; i++) {
                    barcodeToCluster[data.cellBarcodes[i]] = data.clusters[i];
                  }

                  const result = await window.electron.queryAtacFragments({
                    fragmentsPath,
                    region: data.region,
                    cellBarcodes: data.cellBarcodes,
                    barcodeToCluster,
                    clusterMeanDepths: data.clusterMeanDepths || null,
                    binSize: 25, // 25bp bins for fine-grained peak clusters like Signac
                  });

                  if (result.success && result.coverageByCluster?.length > 0) {

                    // Coverage is already Signac-style normalized by electron.js
                    // (raw / group_scale_factor * median_scale_factor)
                    // Frontend CoveragePlot handles y-axis scaling
                    atacFragmentCoverageCacheRef.current.set(fragmentCacheKey, result.coverageByCluster);

                    // Update the artifact with fragment-based coverage
                    setArtifacts(prev => prev.map(a =>
                      a.id === artifactId
                        ? { ...a, coverageByCluster: result.coverageByCluster, fragmentBased: true }
                        : a
                    ));

                    showToast({
                      message: `Peak coverage updated (${result.fragmentCount.toLocaleString()} fragments)`,
                      intent: 'success',
                      timeout: 2000,
                    });
                  } else if (!result.success) {
                    console.warn('Fragment query failed:', result.error);
                    // Fall back to peak-matrix coverage so we still show one plot
                    if (data.coverageByCluster?.length > 0) {
                      setArtifacts(prev => prev.map(a =>
                        a.id === artifactId ? { ...a, coverageByCluster: data.coverageByCluster } : a
                      ));
                    }
                  }
                } catch (err) {
                  console.warn('Failed to query ATAC fragments:', err);
                  // Fall back to peak-matrix coverage so we still show one plot
                  if (data.coverageByCluster?.length > 0) {
                    setArtifacts(prev => prev.map(a =>
                      a.id === artifactId ? { ...a, coverageByCluster: data.coverageByCluster } : a
                    ));
                  }
                }
              })();
            }
          }

          // Consume pendingShowPeakViewRef for scATAC / atac-integration.
          // Multiome: the ATAC message handler (line 869) consumes it, do NOT consume here for the
          // multiome RNA message or the flag will be reset before the ATAC handler reads it.
          const isMultiomeRnaMessage = modality === 'multiome' && !data.multiomeModality && !data.isAtac;
          const showPeakViewAsPrimary = isMultiomeRnaMessage ? false : pendingShowPeakViewRef.current;
          if (!isMultiomeRnaMessage && pendingShowPeakViewRef.current) pendingShowPeakViewRef.current = false;

          // atac-integration: when we will query fragment-based coverage per sample, do not show the initial
          // peak-matrix (binned/bar) coverage, show only after fragment-based (individual peak) data is ready.
          const willQueryIntegrationFragments =
            modality === 'atac-integration' &&
            data.isAtac &&
            data.region &&
            data.cellBarcodes?.length > 0 &&
            data.clusters?.length > 0 &&
            !!window.electron?.queryAtacFragments &&
            (dataInfoRef.current?.atacIntegrationDatasets?.length ?? 0) > 0;
          const initialViewCoverageByCluster = willQueryIntegrationFragments ? null : (data.viewCoverageByCluster || null);

          const geneArtifact = {
            id: artifactId,
            type: 'gene_expression',
            geneName: data.geneName,
            coordinates: data.coordinates, // UMAP coordinates for UMAP view
            spatialCoordinates: data.spatialCoordinates, // Spatial coordinates (for reference, spatial view uses spatialIndex)
            expression: data.expression, // Expression array aligned with analysis state cell order
            expressionRange: data.expressionRange, // Percentile range for color scale
            colorMap: appliedColorMap,
            peaksOnGene: data.peaksOnGene, // ATAC: peaks linked to this gene for Peak View track
            coverageByCluster: finalCoverageByCluster, // ATAC: per-cluster signal for CoveragePlot-style view
            fragmentBased: !!finalCoverageByCluster, // true when using cached fragment coverage
            region: data.region, // ATAC: genomic region { chrom, start, end }
            genome: data.genome, // ATAC: reference genome for IGV (e.g. hg38, mm10)
            isAtac: data.isAtac || false, // true for scATAC and atac-integration
            viewCoverageByCluster: initialViewCoverageByCluster, // atac-integration: per-sample coverage (null until fragment-based ready when willQueryIntegrationFragments)
            showPeakViewAsPrimary: showPeakViewAsPrimary, // true when user said "coverage plot [gene]"
            // Spatial integration: per-sample views (present for imputed genes on xenium/merfish/visium-hd integration)
            integrationViews: data.integrationViews || null,
            datasetNames: data.datasetNames || null,
            perSampleSpatial: data.perSampleSpatial || null,
            createdAt: new Date().toISOString(),
          };
          setArtifacts(prev => [...prev, geneArtifact]);
          setLastActiveArtifactId(artifactId);
          setActivePlot({ source: 'artifact', artifactId });
          if (data.isAtac) setPeakViewPlot({ source: 'artifact', artifactId });
          if (modality === 'integration' || modality === 'atac-integration' || modality === 'xenium-integration' || modality === 'visium-hd-integration' || modality === 'merfish-integration') setIntegrationShowClustersOnly(false);
          showToast({
            message: data.isImputed
              ? `Imputed expression ready: ${data.geneName}`
              : showPeakViewAsPrimary
                ? (data.peaksOnGene?.length
                  ? `Peak View: ${data.geneName} (${data.peaksOnGene.length} peaks)`
                  : `Peak View: ${data.geneName}`)
                : (data.peaksOnGene?.length
                  ? `Gene activity for ${data.geneName} (${data.peaksOnGene.length} peaks)`
                  : `Gene expression plotted (${describeColorMap(appliedColorMap)})`),
            intent: 'success',
            timeout: 2000,
          });
          if (data.isImputed) {
            chatBotRef.current?.addBotMessage(
              `**SpaGE imputation complete** ✓\n\nPredicted expression for **${data.geneName}** is now shown on the spatial tissue view.`,
              'success'
            );
            // Persist imputed expression so it survives session close/reload.
            // Strip the " (imputed)" suffix added by the worker and use lowercase as key.
            const imputedKey = data.geneName.replace(/ \(imputed\)$/i, '').toLowerCase();
            const imputedArr = data.expression instanceof Float32Array
              ? Array.from(data.expression)
              : Array.from(data.expression || []);
            const cur = pendingSaveDataRef.current || {};
            pendingSaveDataRef.current = {
              ...cur,
              imputedGenes: { ...(cur.imputedGenes || {}), [imputedKey]: imputedArr },
            };
            scheduleResultsSave();
          }

          // atac-integration: query fragment-based coverage per sample (same approach as single-sample scATAC)
          // This replaces the peak-matrix viewCoverageByCluster with fine-grained 25bp-binned fragment pileup
          if (
            modality === 'atac-integration' &&
            data.isAtac &&
            data.region &&
            data.cellBarcodes?.length > 0 &&
            data.clusters?.length > 0 &&
            window.electron?.queryAtacFragments &&
            dataInfoRef.current?.atacIntegrationDatasets?.length > 0
          ) {
            const integrationDatasets = dataInfoRef.current.atacIntegrationDatasets;
            const allBarcodes = data.cellBarcodes;
            const allClusters = data.clusters;
            const region = data.region;
            const clusterMeanDepths = data.clusterMeanDepths || null;
            // Get integrationViews from the worker response (not from clusterPlot state which may be stale in this closure)
            const iViews = data.integrationViews;
            const datasetNames = data.datasetNames || dataInfoRef.current?.datasetNames;

            if (iViews && datasetNames) {
              (async () => {
                try {
                  const updatedViewCoverage = {};
                  let totalFragments = 0;

                  for (let si = 0; si < integrationDatasets.length; si++) {
                    const ds = integrationDatasets[si];
                    const viewName = datasetNames[si];
                    const viewIndices = iViews[viewName]?.indices;
                    if (!viewName || !Array.isArray(viewIndices) || viewIndices.length === 0) continue;

                    // Build per-sample barcodes and barcode→cluster mapping.
                    // Strip the sample-name prefix (e.g. "aa_ACGT..." → "ACGT...") since
                    // fragments.tsv.gz contains original unprefixed barcodes.
                    const prefix = `${viewName}_`;
                    const sampleBarcodes = viewIndices.map(i => {
                      const bc = allBarcodes[i];
                      return bc && bc.startsWith(prefix) ? bc.slice(prefix.length) : bc;
                    }).filter(Boolean);
                    const barcodeToCluster = {};
                    for (const idx of viewIndices) {
                      let bc = allBarcodes[idx];
                      if (bc && bc.startsWith(prefix)) bc = bc.slice(prefix.length);
                      const cl = allClusters[idx];
                      if (bc != null && cl != null) barcodeToCluster[bc] = cl;
                    }

                    // Look for fragments.tsv.gz in the sample's directory
                    const fragmentsPath = `${ds.path}/fragments.tsv.gz`;
                    const cacheKey = `${fragmentsPath}|${region.chrom}|${region.start}|${region.end}`;
                    const cached = atacFragmentCoverageCacheRef.current.get(cacheKey);
                    if (cached) {
                      updatedViewCoverage[viewName] = cached;
                      continue;
                    }

                    try {
                      const result = await window.electron.queryAtacFragments({
                        fragmentsPath,
                        region,
                        cellBarcodes: sampleBarcodes,
                        barcodeToCluster,
                        clusterMeanDepths,
                        binSize: 25,
                      });

                      if (result.success && result.coverageByCluster?.length > 0) {
                        atacFragmentCoverageCacheRef.current.set(cacheKey, result.coverageByCluster);
                        updatedViewCoverage[viewName] = result.coverageByCluster;
                        totalFragments += result.fragmentCount || 0;
                      } else {
                        console.warn(`  ${viewName}: fragment query failed or empty, keeping peak-matrix coverage`);
                      }
                    } catch (err) {
                      console.warn(`  ${viewName}: fragment query error:`, err.message);
                    }
                  }

                  // Update the artifact with fragment-based per-sample coverage
                  if (Object.keys(updatedViewCoverage).length > 0) {
                    setArtifacts(prev => prev.map(a => {
                      if (a.id !== artifactId) return a;
                      // Merge: keep peak-matrix coverage for samples where fragments failed
                      const merged = { ...(a.viewCoverageByCluster || {}) };
                      for (const [vn, cov] of Object.entries(updatedViewCoverage)) {
                        merged[vn] = cov;
                      }
                      return { ...a, viewCoverageByCluster: merged, viewFragmentBased: true };
                    }));
                    showToast({
                      message: `Peak coverage updated from fragments (${totalFragments.toLocaleString()} total)`,
                      intent: 'success',
                      timeout: 2000,
                    });
                  }
                } catch (err) {
                  console.warn('atac-integration fragment coverage failed:', err);
                }
              })();
            }
          }
          // Multiome: keep chat disabled until ATAC gene activity is also received
          if (pendingMultiomeGenePlotRef.current) {
            if (multiomeGenePlotTimeoutRef.current) clearTimeout(multiomeGenePlotTimeoutRef.current);
            // ATAC peak matrix load + gene activity can take 10–30+ seconds; only re-enable after ATAC message or long fallback
            multiomeGenePlotTimeoutRef.current = setTimeout(() => {
              multiomeGenePlotTimeoutRef.current = null;
              pendingMultiomeGenePlotRef.current = false;
              setIsAnalyzing(false);
              setWorkerStatusMessage('');
            }, 60000);
            return;
          }
        } else if (data.type === 'gene_violin') {
          // Multiome: mark that we're waiting for ATAC violin
          if (!data.multiomeModality && modality === 'multiome') {
            pendingMultiomeGenePlotRef.current = true;
          }

          // Multiome ATAC violin → route to ATAC view
          if (data.multiomeModality === 'atac') {
            setAtacActivePlot({ source: 'analysis', data });
            showToast({
              message: `ATAC: Gene activity violin plot ready for ${data.geneName}`,
              intent: 'success',
              timeout: 2000,
            });
            pendingMultiomeGenePlotRef.current = false;
            setIsAnalyzing(false);
            setWorkerStatusMessage('');
          } else {

          setPendingGeneColorMap(null);

          // Integration: violin with per-view data → store as artifact and show in each sample view
          if (data.integrationViews && data.datasetNames && (dataInfo?.modality === 'integration' || modality === 'integration' || dataInfo?.modality === 'atac-integration' || modality === 'atac-integration' || dataInfo?.modality === 'xenium-integration' || modality === 'xenium-integration' || dataInfo?.modality === 'visium-hd-integration' || modality === 'visium-hd-integration' || dataInfo?.modality === 'merfish-integration' || modality === 'merfish-integration')) {
            setIntegrationShowClustersOnly(false);
            const artifactId = `plot_${Date.now()}`;
            const violinArtifact = {
              id: artifactId,
              type: 'gene_violin',
              geneName: data.geneName,
              integrationViews: data.integrationViews,
              datasetNames: data.datasetNames,
              viewData: data.viewData,
              globalExpressionRange: data.globalExpressionRange,
              createdAt: new Date().toISOString(),
            };
            setArtifacts(prev => [...prev, violinArtifact]);
            setLastActiveArtifactId(artifactId);
            setActivePlot({ source: 'artifact', artifactId });
            showToast({
              message: `Violin plot ready for ${data.geneName} (per sample view)`,
              intent: 'success',
              timeout: 2000,
            });
          } else if (modality === 'spatial' && data.expression && data.spatialCoordinates) {
            // For spatial mode, create a gene expression artifact so the spatial view can show the scatter plot
            const artifactId = `plot_${Date.now()}`;
            // Prefer worker-provided coordinates (already aligned with expression).
            // Falling back to clusterPlot coordinates can re-introduce stale-length mismatches.
            const umapCoordinates = Array.isArray(data.coordinates) && data.coordinates.length > 0
              ? data.coordinates
              : (clusterPlot?.source === 'analysis' ? clusterPlot.data?.coordinates : null);
            const geneArtifact = {
              id: artifactId,
              type: 'gene_expression',
              geneName: data.geneName,
              coordinates: umapCoordinates,
              spatialCoordinates: data.spatialCoordinates,
              expression: data.expression,
              colorMap: defaultColorMap,
              createdAt: new Date().toISOString(),
            };
            setArtifacts(prev => [...prev, geneArtifact]);
            setLastActiveArtifactId(artifactId);
            setActivePlot({ source: 'analysis', data, spatialArtifactId: artifactId });
          } else {
            setLastActiveArtifactId(null);
            setActivePlot({ source: 'analysis', data });
          }

          if (!(data.integrationViews && data.datasetNames && (dataInfo?.modality === 'integration' || modality === 'integration' || dataInfo?.modality === 'atac-integration' || modality === 'atac-integration' || dataInfo?.modality === 'xenium-integration' || modality === 'xenium-integration' || dataInfo?.modality === 'visium-hd-integration' || modality === 'visium-hd-integration' || dataInfo?.modality === 'merfish-integration' || modality === 'merfish-integration'))) {
            showToast({
              message: `Violin plot ready for ${data.geneName}`,
              intent: 'success',
              timeout: 2000,
            });
          }
          } // end else (RNA violin)
        } else if (data.type === 'gene_dotplot') {

          // Multiome: mark that we're waiting for ATAC dotplot
          if (!data.multiomeModality && modality === 'multiome') {
            pendingMultiomeGenePlotRef.current = true;
          }

          // Multiome ATAC dotplot → route to ATAC view
          if (data.multiomeModality === 'atac') {
            const appliedColorMap = data.colorMap || pendingGeneColorMap || defaultColorMap;
            const atacArtifactId = `atac_dotplot_${Date.now()}`;
            const atacDotplotArtifact = {
              id: atacArtifactId,
              type: 'gene_dotplot',
              geneNames: data.geneNames,
              clusterIds: data.clusterIds,
              percentExpressing: data.percentExpressing,
              averageExpression: data.averageExpression,
              clusterCellCounts: data.clusterCellCounts,
              totalCells: data.totalCells,
              expressionRange: data.expressionRange,
              colorMap: appliedColorMap,
              isAtac: true,
              createdAt: new Date().toISOString(),
            };
            setArtifacts(prev => [...prev, atacDotplotArtifact]);
            setAtacActivePlot({ source: 'artifact', artifactId: atacArtifactId });
            const genesLabel = Array.isArray(data.geneNames) ? data.geneNames.join(', ') : 'genes';
            showToast({
              message: `ATAC: Gene activity dot plot ready for ${genesLabel}`,
              intent: 'success',
              timeout: 2000,
            });
            pendingMultiomeGenePlotRef.current = false;
            setIsAnalyzing(false);
            setWorkerStatusMessage('');
          } else {

          // Use colorMap from the worker data if available, otherwise fall back to pending or default
          const appliedColorMap = data.colorMap || pendingGeneColorMap || defaultColorMap;
          setPendingGeneColorMap(null);

          // Integration: dotplot with per-view data → store as artifact and show in each sample view
          if (data.integrationViews && data.datasetNames && (dataInfo?.modality === 'integration' || modality === 'integration' || dataInfo?.modality === 'atac-integration' || modality === 'atac-integration' || dataInfo?.modality === 'xenium-integration' || modality === 'xenium-integration' || dataInfo?.modality === 'visium-hd-integration' || modality === 'visium-hd-integration' || dataInfo?.modality === 'merfish-integration' || modality === 'merfish-integration')) {
            setIntegrationShowClustersOnly(false);
            const artifactId = `plot_${Date.now()}`;
            const dotplotArtifact = {
              id: artifactId,
              type: 'gene_dotplot',
              geneNames: data.geneNames,
              integrationViews: data.integrationViews,
              datasetNames: data.datasetNames,
              viewData: data.viewData,
              expressionRange: data.expressionRange,
              colorMap: appliedColorMap,
              createdAt: new Date().toISOString(),
            };
            setArtifacts(prev => [...prev, dotplotArtifact]);
            setLastActiveArtifactId(artifactId);
            setActivePlot({ source: 'artifact', artifactId });
            const genesLabel = Array.isArray(data.geneNames) ? data.geneNames.join(', ') : 'genes';
            showToast({
              message: `Dot plot ready for ${genesLabel} (per sample view)`,
              intent: 'success',
              timeout: 2000,
            });
          } else {
          // Store dotplot as artifact (like gene expression) so it can be recolored
          const artifactId = `plot_${Date.now()}`;
          const dotplotArtifact = {
            id: artifactId,
            type: 'gene_dotplot',
            geneNames: data.geneNames,
            clusterIds: data.clusterIds,
            percentExpressing: data.percentExpressing,
            averageExpression: data.averageExpression,
            clusterCellCounts: data.clusterCellCounts,
            totalCells: data.totalCells,
            expressionRange: data.expressionRange,
            colorMap: appliedColorMap,
            createdAt: new Date().toISOString(),
          };

          // For spatial data, also create a gene expression artifact for the spatial view
          let spatialArtifactId = null;
          if (data.spatialGeneExpression && modality === 'spatial') {
            spatialArtifactId = `plot_${Date.now()}_spatial`;
            // Get UMAP coordinates from clusterPlot if available
            const umapCoordinates = clusterPlot?.source === 'analysis' ? clusterPlot.data?.coordinates : null;
            const spatialArtifact = {
              id: spatialArtifactId,
              type: 'gene_expression',
              geneName: data.spatialGeneExpression.geneName,
              coordinates: umapCoordinates, // Include UMAP coordinates for UMAP view
              expression: data.spatialGeneExpression.expression,
              colorMap: appliedColorMap,
              createdAt: new Date().toISOString(),
            };
            setArtifacts(prev => [...prev, dotplotArtifact, spatialArtifact]);
            setActivePlot({
              source: 'artifact',
              artifactId,
              spatialArtifactId, // Link to the spatial expression artifact
            });
          } else {
            setArtifacts(prev => [...prev, dotplotArtifact]);
            setActivePlot({ source: 'artifact', artifactId });
          }

          setLastActiveArtifactId(artifactId);

          const genesLabel = Array.isArray(data.geneNames) ? data.geneNames.join(', ') : 'genes';
          showToast({
            message: `Dot plot ready for ${genesLabel} (${describeColorMap(appliedColorMap)})`,
            intent: 'success',
            timeout: 2000,
          });
          } // end else (non-integration dotplot)
          } // end else (RNA dotplot)
        } else if (data.type === 'markers') {
          setPendingGeneColorMap(null);
          setLastActiveArtifactId(null);

          // Multiome ATAC markers → route to ATAC view
          if (data.multiomeTarget === 'atac') {
            setAtacActivePlot({ source: 'analysis', data });
          } else {
            setActivePlot({ source: 'analysis', data });
          }

          const isPeakMarkers = data.featureType === 'peak';
          const topGenes = Array.isArray(data.markers)
            ? data.markers.slice(0, 3).map((entry) => entry.gene).join(', ')
            : '';

          const summary =
            topGenes && topGenes.length
              ? `Top ${isPeakMarkers ? 'peaks' : 'markers'}: ${topGenes}`
              : `Found ${data.markers?.length || 0} ${isPeakMarkers ? 'marker peaks' : 'markers'}`;

          showToast({
            message: `${isPeakMarkers ? 'Marker peaks' : 'Marker'} table ready for cluster ${data.cluster}. ${summary}`,
            intent: 'success',
            timeout: 3000,
          });

          if (
            data.comparison === 'selected_spatial_region_vs_other_cells' &&
            !data.suppressNeutralSummary &&
            chatBotRef.current?.addBotMessage
          ) {
            const topRows = Array.isArray(data.markers) ? data.markers.slice(0, 8) : [];
            const markerText = topRows.length
              ? topRows.map((entry) => {
                  const pct1 = Number.isFinite(entry.pct1) ? `${Math.round(entry.pct1 * 100)}%` : 'n/a';
                  const pct2 = Number.isFinite(entry.pct2) ? `${Math.round(entry.pct2 * 100)}%` : 'n/a';
                  const logFc = Number.isFinite(entry.avg_logFC) ? entry.avg_logFC.toFixed(2) : 'n/a';
                  return `- **${entry.gene}**: logFC ${logFc}, selected ${pct1}, other ${pct2}`;
                }).join('\n')
              : 'No positive marker genes were detected for the selected region.';
            const selectedCount = data.selectedRegion?.cellCount ?? data.clusterSize ?? 0;
            const otherCount = data.selectedRegion?.otherCells ?? data.otherCells ?? 0;
            chatBotRef.current.addBotMessage(
              `**Selected region marker analysis is ready**\n\n` +
              `Compared **${selectedCount.toLocaleString()} selected cells** against **${otherCount.toLocaleString()} non-selected cells**. ` +
              `The full marker table is shown in Analysis View.\n\n` +
              `Top enriched markers:\n${markerText}`,
              'success'
            );
          }
        } else if (data.type === 'spatial_cell_interaction') {
          setPendingGeneColorMap(null);
          setLastActiveArtifactId(null);
          setActivePlot({ source: 'analysis', data });
          const nPairs = data.summary?.interactionCount || data.interactions?.length || 0;
          showToast({
            message: `Ligand-receptor analysis ready: ${nPairs} interactions`,
            intent: nPairs ? 'success' : 'warning',
            timeout: 3000,
          });
          if (chatBotRef.current?.addBotMessage) {
            const top = (data.summary?.topInteractions || []).slice(0, 5);
            const sig = data.significance || {};
            const topText = top.length
              ? top.map((item, idx) => {
                  const p = Number.isFinite(item.p_value) ? `, p=${item.p_value.toFixed(3)}` : '';
                  return `${idx + 1}. **${item.pathway}** through **${item.pair}** (${item.source} → ${item.target}, score ${item.score.toFixed(3)}${p})`;
                }).join('\n')
              : `No ligand-receptor pairs passed the CellChat-style permutation threshold${Number.isFinite(sig.threshold) ? ` (p <= ${sig.threshold})` : ''}.`;
            const regionNames = (data.regions || []).map(region => region.id).join(', ') || 'the selected regions';
            chatBotRef.current.addBotMessage(
              `**Spatial cell-cell interaction analysis is ready**\n\n` +
              `${regionNames} have **${nPairs} significant ligand-receptor interaction${nPairs === 1 ? '' : 's'}** across **${data.summary?.pathwayCount || 0} signaling pathway${data.summary?.pathwayCount === 1 ? '' : 's'}** ` +
              `using CellChat-style label permutation${sig.nboot ? ` (${sig.nboot} permutations` : ''}${Number.isFinite(sig.threshold) ? `, p <= ${sig.threshold}` : ''}).\n\n` +
              `Strongest interactions:\n${topText}`,
              nPairs ? 'success' : 'warning'
            );
          }
        } else if (data.type === 'deg_between_samples') {
          setPendingGeneColorMap(null);
          setLastActiveArtifactId(null);
          setActivePlot({ source: 'analysis', data });
          const s1 = data.sample1 ?? 'sample1';
          const s2 = data.sample2 ?? 'sample2';
          const nItems = Array.isArray(data.markers) ? data.markers.length : 0;
          const isPeak = data.featureType === 'peak';
          showToast({
            message: isPeak
              ? `Differential peaks between ${s1} vs ${s2} (cluster ${data.cluster}) ready`
              : `DEG between ${s1} vs ${s2} (cluster ${data.cluster}) ready`,
            intent: 'success',
            timeout: 3000,
          });
          if (chatBotRef.current?.addBotMessage) {
            const label = isPeak ? 'Differential peak' : 'Differential gene';
            const itemsLabel = isPeak ? 'peaks' : 'genes';
            chatBotRef.current.addBotMessage(
              `${label} analysis for **cluster ${data.cluster}** between **${s1}** and **${s2}** is ready. ` +
              `See the **Analysis View** panel (table + volcano plot). ${nItems} ${itemsLabel} shown.`,
              'success'
            );
          }
        } else if (data.type === 'cell_fraction') {
          setPendingGeneColorMap(null);
          setLastActiveArtifactId(null);
          setActivePlot({ source: 'analysis', data });
          const names = data.datasetNames ?? [];
          showToast({
            message: `Cell fraction per sample ready${names.length ? ` (${names.join(', ')})` : ''}`,
            intent: 'success',
            timeout: 3000,
          });
        } else if (data.type === 'link_peaks') {
          // LinkPeaks genome-wide run complete, report results and persist to disk
          if (!data.restored) {
            setIsAnalyzing(false);
            setWorkerStatusMessage('');
          }
          if (data.restored) {
            // Silently inform the user links are available from the previous session
            if (chatBotRef.current?.addBotMessage) {
              chatBotRef.current.addBotMessage(
                `**Peak–gene links loaded** ✓\n\n` +
                `Restored **${data.nLinks}** saved peak–gene links (${data.nGenesLinked} genes) from the previous session.\n\n` +
                `Say *"show links for <gene>"* to visualise them.`,
                'info'
              );
            }
          } else {
            showToast({
              message: `LinkPeaks complete: ${data.nLinks} peak–gene links across ${data.nGenesLinked} genes`,
              intent: 'success',
              timeout: 4000,
            });
            if (chatBotRef.current?.addBotMessage) {
              chatBotRef.current.addBotMessage(
                `**LinkPeaks complete** ✓\n\n` +
                `Found **${data.nLinks}** significant peak–gene links across **${data.nGenesLinked}** genes.\n\n` +
                `Top linked genes: ${(data.topGenes || []).slice(0, 5).join(', ')}\n\n` +
                `To visualise links for a gene, say: *"show links for CD14"*`,
                'success'
              );
            }
            // Persist the full links array so re-loading the dataset skips the expensive analysis
            if (Array.isArray(data.links) && data.links.length > 0) {
              pendingSaveDataRef.current = {
                ...(pendingSaveDataRef.current || {}),
                peakGeneLinks: data.links,
              };
              scheduleResultsSave();
            }
          }
        } else if (data.type === 'tf_motif_enrichment') {
          setIsAnalyzing(false);
          setWorkerStatusMessage('');
          const artifactId = `plot_${Date.now()}`;
          const clusterDisplayName = clusterLabelMapRef.current?.[String(data.cluster)] ?? data.cluster;
          setArtifacts(prev => [...prev, {
            id: artifactId,
            type: 'tf_motif_enrichment',
            cluster: clusterDisplayName,
            topMarkers: data.topMarkers || [],
            nQueryPeaks: data.nQueryPeaks,
            nBgPeaks: data.nBgPeaks,
            results: data.results || [],
            genome: data.genome || null,
            createdAt: new Date().toISOString(),
          }]);
          setLastActiveArtifactId(artifactId);
          setActivePlot({ source: 'artifact', artifactId });
          showToast({
            message: data.results?.length > 0
              ? `TF motif enrichment complete: ${data.results.length} enriched motifs for cluster ${clusterDisplayName}`
              : `No enriched TF motifs found for cluster ${clusterDisplayName}`,
            intent: data.results?.length > 0 ? 'success' : 'warning',
            timeout: 4000,
          });
          if (chatBotRef.current?.addBotMessage) {
            chatBotRef.current.addBotMessage(data.message, data.results?.length > 0 ? 'success' : 'warning');
          }
        } else if (data.type === 'peak_gene_links') {
          // Show peak-gene arc plot for a specific gene
          setIsAnalyzing(false);
          setWorkerStatusMessage('');
          if (!data.links || data.links.length === 0) {
            showToast({ message: data.message || `No links found for ${data.gene}`, intent: 'warning', timeout: 3000 });
            if (chatBotRef.current?.addBotMessage) {
              chatBotRef.current.addBotMessage(data.message || `No significant links found for ${data.gene}.`, 'warning');
            }
          } else {
            const artifactId = `plot_${Date.now()}`;
            const linkArtifact = {
              id: artifactId,
              type: 'peak_gene_links',
              gene: data.gene,
              links: data.links,
              coverageByCluster: data.coverageByCluster || null,
              region: data.region || null,
              peaksOnGene: data.peaksOnGene || null,
              genome: data.genome || null,
              createdAt: new Date().toISOString(),
            };
            setArtifacts(prev => [...prev, linkArtifact]);
            setLastActiveArtifactId(artifactId);
            // Show in ATAC View panel (right panel) for multiome.
            // Use dataInfoRef (not dataInfo) to avoid stale closure, this handler is created once on mount.
            if (dataInfoRef.current?.modality === 'multiome') {
              setAtacActivePlot({ source: 'artifact', artifactId });
            } else {
              setActivePlot({ source: 'artifact', artifactId });
            }

            // For multiome, upgrade to fragment-based coverage (Signac-style 25 bp bins).
            // The peak-matrix coverage above is a fast fallback; replace it once fragments are ready.
            const willQueryLinkFragments =
              data.region &&
              data.cellBarcodes?.length > 0 &&
              data.clusters?.length > 0 &&
              dataPathRef.current &&
              window.electron?.queryAtacFragments;

            if (willQueryLinkFragments) {
              const fragmentsPath = `${dataPathRef.current}/atac_fragments.tsv.gz`;
              const fragmentCacheKey = `links|${fragmentsPath}|${data.region.chrom}|${data.region.start}|${data.region.end}`;
              const cachedCoverage = atacFragmentCoverageCacheRef.current.get(fragmentCacheKey);
              if (cachedCoverage) {
                setArtifacts(prev => prev.map(a =>
                  a.id === artifactId ? { ...a, coverageByCluster: cachedCoverage, fragmentBased: true } : a
                ));
              } else {
                (async () => {
                  try {
                    const barcodeToCluster = {};
                    const numMapped = Math.min(data.cellBarcodes.length, data.clusters.length);
                    for (let i = 0; i < numMapped; i++) {
                      barcodeToCluster[data.cellBarcodes[i]] = data.clusters[i];
                    }
                    const result = await window.electron.queryAtacFragments({
                      fragmentsPath,
                      region: data.region,
                      cellBarcodes: data.cellBarcodes,
                      barcodeToCluster,
                      clusterMeanDepths: data.clusterMeanDepths || null,
                      binSize: 25,
                    });
                    if (result.success && result.coverageByCluster?.length > 0) {
                      atacFragmentCoverageCacheRef.current.set(fragmentCacheKey, result.coverageByCluster);
                      setArtifacts(prev => prev.map(a =>
                        a.id === artifactId
                          ? { ...a, coverageByCluster: result.coverageByCluster, fragmentBased: true }
                          : a
                      ));
                    } else if (!result.success) {
                      console.warn('Peak-gene links fragment query failed:', result.error);
                    }
                  } catch (err) {
                    console.warn('Failed to query fragments for peak-gene links:', err);
                  }
                })();
              }
            }
            showToast({
              message: `Peak–gene links for ${data.gene}: ${data.links.length} link${data.links.length !== 1 ? 's' : ''}`,
              intent: 'success',
              timeout: 3000,
            });
            if (chatBotRef.current?.addBotMessage) {
              chatBotRef.current.addBotMessage(data.message, 'success');
            }
          }
        } else if (data.type === 'region_composition') {
          setPendingGeneColorMap(null);
          setLastActiveArtifactId(null);
          setActivePlot({ source: 'analysis', data });
          const entries = data.entries || [];
          const lines = entries
            .sort((a, b) => b.fraction - a.fraction)
            .map((e) => {
              const label = clusterLabelMap?.[String(e.clusterId)] || `Cluster ${e.clusterId}`;
              return `- **${label}**: ${(e.fraction * 100).toFixed(1)}% (${e.count} cells)`;
            });
          const regionDisplayName = regionLabelMap?.[String(data.regionId)] || `Region ${data.regionId}`;
          const msg =
            `**${regionDisplayName}** contains **${data.totalCells}** cells across **${entries.length}** cluster${entries.length !== 1 ? 's' : ''}:\n` +
            lines.join('\n');
          showToast({
            message: `${regionDisplayName} composition ready (${data.totalCells} cells)`,
            intent: 'success',
            timeout: 3000,
          });
          if (chatBotRef.current) {
            chatBotRef.current.addBotMessage(msg, 'success');
          }
        } else if (data.type === 'cluster_info') {
          // Format cluster info into a human-readable paragraph
          const clusterLabel = clusterLabelMap?.[String(data.cluster)] || `Cluster ${data.cluster}`;
          const cellCount = data.cellCount;
          const totalCells = data.totalCells;
          const percentage = (data.fraction * 100).toFixed(1);
          const topMarkers = data.topMarkers || [];

          // Format top marker genes as a comma-separated list
          const markerGenes = topMarkers.map(m => m.gene).join(', ');

          // Build the human-readable message
          let message = `**${clusterLabel}** contains **${cellCount.toLocaleString()} cells**, which represents **${percentage}%** of the total dataset (${totalCells.toLocaleString()} cells).`;

          if (topMarkers.length > 0) {
            message += `\n\nThe top ${topMarkers.length} marker genes for this cluster are: **${markerGenes}**.`;

            // Add a brief note about the top marker
            const topMarker = topMarkers[0];
            const topPct = (topMarker.pct1 * 100).toFixed(0);
            message += ` The most significant marker is **${topMarker.gene}**, expressed in ${topPct}% of cells in this cluster.`;
          }

          // Add reference to the marker table
          message += `\n\n*Please see all markers for ${clusterLabel} above.*`;

          // Display the marker table in Analysis View (reuse the 'markers' type display)
          // This creates data in the same format as find_markers
          const markerTableData = {
            type: 'markers',
            cluster: data.cluster,
            totalCells: totalCells,
            clusterSize: cellCount,
            otherCells: totalCells - cellCount,
            totalGenes: data.totalGenes,
            method: data.method,
            markers: data.markers,
            availableClusters: data.availableClusters,
          };

          setPendingGeneColorMap(null);
          setLastActiveArtifactId(null);
          setActivePlot({ source: 'analysis', data: markerTableData });

          // Also show a toast
          showToast({
            message: `Cluster info ready for ${clusterLabel}`,
            intent: 'success',
            timeout: 2000,
          });

          // Send the formatted message to the chatbot
          if (chatBotRef.current?.addBotMessage) {
            chatBotRef.current.addBotMessage(message, 'info');
          }
          if (data.requestAnnotation && chatBotRef.current?.annotateClusterResult) {
            chatBotRef.current.annotateClusterResult({
              ...data,
              clusterLabel,
            });
          }
        } else if (data.type === 'cell_type_cluster_search') {
          setIsAnalyzing(false);
          setWorkerStatusMessage('');
          setPendingGeneColorMap(null);
          setLastActiveArtifactId(null);
          setActivePlot({ source: 'analysis', data });

          const likely = (data.candidateRankings || []).slice(0, 3);
          const weakTop = (data.rankings || []).slice(0, 3);
          const candidateText = likely.length
            ? likely.map((item, idx) => {
                const label = clusterLabelMap?.[String(item.cluster)] || `Cluster ${item.cluster}`;
                const markerText = (item.markerStats || [])
                  .filter(stat => stat.pctExpressing > 0)
                  .slice(0, 4)
                  .map(stat => `${stat.gene} (${Math.round(stat.pctExpressing * 100)}%)`)
                  .join(', ');
                return `${idx + 1}. **${label}**: score ${item.score.toFixed(2)}, ${item.expressedMarkerCount}/${data.resolvedMarkers.length} markers detected${markerText ? `, ${markerText}` : ''}`;
              }).join('\n')
            : 'No cluster passed the evidence threshold for this cell type.';
          const weakText = !likely.length && weakTop.length
            ? `\n\nHighest weak matches were: ${weakTop.map(item => {
                const label = clusterLabelMap?.[String(item.cluster)] || `Cluster ${item.cluster}`;
                return `${label} (${item.expressedMarkerCount}/${data.resolvedMarkers.length} markers, strongest marker in ${Math.round((item.strongestPct || 0) * 100)}% of cells)`;
              }).join('; ')}.`
            : '';
          const missingText = data.missingMarkers?.length
            ? `\n\nMarkers not found in this dataset: ${data.missingMarkers.join(', ')}.`
            : '';
          const sourceText = data.markerSource === 'llm'
            ? 'I used LLM-suggested marker genes, then scored their actual expression in this dataset. The LLM did not decide which cluster exists.'
            : 'I used the marker genes provided in the request and scored their actual expression in this dataset.';
          const rationaleText = data.markerRationale
            ? `\n\nMarker panel note: ${data.markerRationale}`
            : '';
          const msg =
            `I scored clusters for **${data.interpretedCellType || data.requestedCellType}** using marker expression. ${sourceText}\n\n` +
            `Resolved markers: **${(data.resolvedMarkers || []).join(', ')}**.${missingText}${rationaleText}\n\n` +
            `**Most likely candidate cluster${likely.length > 1 ? 's' : ''}:**\n${candidateText}\n\n` +
            (likely.length
              ? `This is marker-based ranking, not a definitive annotation. You can validate by plotting the listed markers or asking me to annotate the candidate clusters.`
              : `I would not call any cluster **${data.interpretedCellType || data.requestedCellType}** from these markers in this dataset.${weakText}`);

          showToast({
            message: `Cluster search complete for ${data.interpretedCellType || data.requestedCellType}`,
            intent: likely.length ? 'success' : 'warning',
            timeout: 3000,
          });
          if (chatBotRef.current?.addBotMessage) {
            chatBotRef.current.addBotMessage(msg, likely.length ? 'success' : 'warning');
          }
        } else if (data.type === 'parameters') {
          // Format parameters into a readable message for the chatbot
          const params = data.parameters;
          const step = data.step;

          // Create appropriate header based on whether showing all or specific step
          let message = '';
          if (step) {
            const stepNames = {
              umap: 'UMAP',
              clustering: 'Clustering',
              pca: 'PCA',
              featureSelection: 'Variable Genes',
              cellFiltering: 'Cell Filtering',
              geneFiltering: 'Gene Filtering'
            };
            message = `Here are the ${stepNames[step] || step} parameters:\n\n`;
          } else {
            message = 'Here are the current analysis parameters:\n\n';
          }

          if (params.cellFiltering && Object.keys(params.cellFiltering).length > 0) {
            message += '- Cell Filtering:\n';
            if (params.cellFiltering.minGenes !== 'N/A') message += `  - Min genes per cell: ${params.cellFiltering.minGenes}\n`;
            if (params.cellFiltering.minUMIs !== 'N/A') message += `  - Min UMIs per cell: ${params.cellFiltering.minUMIs}\n`;
            if (params.cellFiltering.maxMito !== 'N/A') message += `  - Max mitochondrial %: ${params.cellFiltering.maxMito}\n`;
            message += '\n';
          }

          if (params.geneFiltering && Object.keys(params.geneFiltering).length > 0) {
            message += '- Gene Filtering:\n';
            if (params.geneFiltering.minCounts !== 'N/A') message += `  - Min counts: ${params.geneFiltering.minCounts}\n`;
            message += '\n';
          }

          if (params.featureSelection && Object.keys(params.featureSelection).length > 0) {
            message += '- Variable Genes:\n';
            if (params.featureSelection.numVariableGenes !== 'N/A') message += `  - Number of variable genes: ${params.featureSelection.numVariableGenes}\n`;
            message += '\n';
          }

          if (params.pca && Object.keys(params.pca).length > 0) {
            message += '- PCA:\n';
            if (params.pca.numPCs !== 'N/A') message += `  - Number of PCs: ${params.pca.numPCs}\n`;
            message += '\n';
          }

          if (params.clustering && Object.keys(params.clustering).length > 0) {
            message += '- Clustering:\n';
            if (params.clustering.algorithm !== 'N/A') message += `  - Algorithm: ${params.clustering.algorithm}\n`;
            if (params.clustering.resolution !== 'N/A') message += `  - Resolution: ${params.clustering.resolution}\n`;
            message += '\n';
          }

          if (params.umap && Object.keys(params.umap).length > 0) {
            message += '- UMAP:\n';
            if (params.umap.minDist !== 'N/A') message += `  - Min distance: ${params.umap.minDist}\n`;
            if (params.umap.numNeighbors !== 'N/A') message += `  - Number of neighbors: ${params.umap.numNeighbors}\n`;
          }

          message += '\nYou can adjust any of these parameters and I will reanalyze the data!';

          // Send message to chatbot
          if (chatBotRef.current) {
            chatBotRef.current.addBotMessage(message, 'success');
          }
        } else {
          setActivePlot({ source: 'analysis', data });
          setLastActiveArtifactId(null);
          showToast({
            message: `${data.type} analysis complete!`,
            intent: 'success',
            timeout: 2000,
          });
        }
        // Analysis finished. Re-enable chat input (keep disabled if multiome gene plot is still waiting for ATAC).
        if (!pendingMultiomeGenePlotRef.current) {
          setIsAnalyzing(false);
          setWorkerStatusMessage('');
        }
      } else if (type === 'LINK_PEAKS_REQUIRED') {
        const reminder = message || 'Please perform "link peaks to genes" first.';
        if (chatBotRef.current?.addBotMessage) {
          chatBotRef.current.addBotMessage(reminder, 'info');
        }
        if (multiomeGenePlotTimeoutRef.current) {
          clearTimeout(multiomeGenePlotTimeoutRef.current);
          multiomeGenePlotTimeoutRef.current = null;
        }
        pendingMultiomeGenePlotRef.current = false;
        setIsAnalyzing(false);
        setWorkerStatusMessage('');
      } else if (type === 'ANALYSIS_ERROR') {
        console.error('Analysis error:', error);
        chatBotRef.current?.handleAnalysisResultForAgent?.({ error: error || 'Analysis error' });
        const isWasmOOM = typeof error === 'string' && /out of memory|WASM|WebAssembly/i.test(error);
        showToast({
          message: error || 'Analysis error',
          intent: 'danger',
          timeout: isWasmOOM ? 15000 : 5000,
        });
        // For WASM OOM, also send to chatbot for visibility
        if (isWasmOOM && chatBotRef.current?.addBotMessage) {
          chatBotRef.current.addBotMessage(error, 'error');
        }
        if (event.data?.lsiRnaRefused && error && chatBotRef.current?.addBotMessage) {
          chatBotRef.current.addBotMessage(error, 'info');
        }
        if (multiomeGenePlotTimeoutRef.current) {
          clearTimeout(multiomeGenePlotTimeoutRef.current);
          multiomeGenePlotTimeoutRef.current = null;
        }
        pendingMultiomeGenePlotRef.current = false;
        // Analysis failed. Re-enable chat input.
        setIsAnalyzing(false);
        setWorkerStatusMessage('');
      } else if (type === 'STATUS_UPDATE') {
        const statusMessage = message ?? data?.message ?? data;
        setWorkerStatusMessage(typeof statusMessage === 'string' ? statusMessage : '');
      } else if (type === 'PARAMETERS_UPDATED') {
        const summary = data?.summary || 'Analysis parameters updated.';
        showToast({
          message: summary,
          intent: 'primary',
          timeout: 2500,
        });
      }
    };

    analysisWorker.onerror = (error) => {
      console.error('Worker error:', error);
      console.error('Worker error details:', {
        message: error.message,
        filename: error.filename,
        lineno: error.lineno,
        colno: error.colno,
      });
      // Null the worker so subsequent data loads don't silently send to a dead worker.
      setWorker(null);
      // Detect WASM OOM / abort errors and show a clearer message
      const msg = error.message || '';
      const isWasmOOM = /Aborted\(\)|out of memory|RuntimeError/i.test(msg);
      showToast({
        message: isWasmOOM
          ? 'Out of memory: dataset too large for the analysis engine (WASM 4 GB limit). ' +
            'Please subsample your dataset to ~200K cells or fewer before loading.'
          : `Worker error: ${msg || 'Unknown error'}`,
        intent: 'danger',
        timeout: isWasmOOM ? 10000 : 5000,
      });
      // Ensure UI is not stuck in analyzing state after a fatal worker error
      setIsAnalyzing(false);
      setWorkerStatusMessage('');
    };

    // Initialize the worker
    analysisWorker.postMessage({ type: 'INIT' });
    
    setWorker(analysisWorker);

    return () => {
      analysisWorker.terminate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount. Do NOT recreate worker when color maps change.

  // Returns the folder to check/save results in (null = skip for this modality).
  // For integration we use the first dataset's path (same as dataPath) so check and save use the same folder.
  const getResultsFolder = (path, info) => {
    if (!path || !window.electron?.checkCellpilotResults) return null;
    // Integration: we save to the first dataset's path (path passed here); use it for check too so Load Previous works
    if (info?.integrationDatasets?.length > 0) return path;
    if (info?.atacIntegrationDatasets?.length > 0) return path;
    if (info?.xeniumIntegrationDatasets?.length > 0) return path;
    if (info?.visiumHDIntegrationDatasets?.length > 0) return path;
    // For H5 files, use the parent directory
    if (/\.(h5|hdf5)$/i.test(path)) {
      const sep = path.includes('\\') ? '\\' : '/';
      const dir = path.substring(0, path.lastIndexOf(sep));
      return dir || null;
    }
    return path;
  };

  // Called when user picks "Load Previous" or "New Analysis" from the dialog
  const handlePreviousResultsChoice = async (usePrevious) => {
    if (!previousResultsDialog) return;
    const { path, info, savedResults } = previousResultsDialog;
    setPreviousResultsDialog(null);
    await doHandleDataLoaded(path, info, usePrevious ? savedResults : null);
  };

  // Main entry point called by FileLoader, checks for saved results first
  const handleDataLoaded = async (path, info) => {
    const resultsFolder = getResultsFolder(path, info);
    if (resultsFolder) {
      try {
        const checkResult = await window.electron.checkCellpilotResults(resultsFolder);
        if (checkResult.success && checkResult.results?.umapCoordinates?.length > 0) {
          // Only offer Load Previous if saved modality matches (e.g. don't load single-sample results when loading integration)
          const savedModality = checkResult.results?.modality;
          const currentModality = info?.modality;
          if (savedModality && currentModality && savedModality !== currentModality) {
            // Mismatch: e.g. file is from single-sample, we're loading integration, skip dialog
          } else {
            setPreviousResultsDialog({ path, info, savedResults: checkResult.results });
            return; // Wait for the user's dialog choice
          }
        }
      } catch (e) {
        console.warn('CellPilot: could not check for previous results:', e);
      }
    }
    await doHandleDataLoaded(path, info, null);
  };

  // Actual data loading logic (previousResults = saved JSON or null for fresh analysis)
  const doHandleDataLoaded = async (path, info, previousResults) => {
    setDataPath(path);
    // Reset pending save data so old results are not overwritten
    pendingSaveDataRef.current = null;
    // Mark analysis as loading by using non-numeric placeholders
    setDataInfo({
      ...info,
      cells: 'Loading...',
      genes: 'Loading...',
      rawCells: null,
      rawGenes: null,
      spatialCoordinates: info.spatialCoordinates || null,
      spatialExtent: info.spatialExtent || null,
      spatialIndex: info.spatialIndex || null,
      spatialReady: info.modality === 'spatial' ? false : info?.spatialReady || false,
    });
    setArtifacts([]);
    setLastActiveArtifactId(null);
    setActivePlot(null);
    setPendingGeneColorMap(null);
    setAutoClusterIssued(false);
    setClusterPlot(null);
    setRegionPlot(null);
    setPeakViewPlot(null);
    setClusterLabelMap({});
    setRegionLabelMap({});
    lastSavedPayloadHashRef.current = null; // Allow next save after load
    // Reset multiome-specific state
    setAtacClusterPlot(null);
    setAtacActivePlot(null);
    setAtacClusterLabelMap({});
    setAtacClusterColorOverrides({});
    setAtacSelectedClusters(new Set());
    setRnaClusterHighlightOnAtac(null);
    setAtacClusterHighlightOnRna(null);
    setWnnRnaPlot(null);
    setWnnAtacPlot(null);
    setWnnActive(false);
    setWnnClusterLabelMap({});
    setWnnClusterColorOverrides({});
    setWnnCrossHighlight(null);

    if (worker && window.electron) {
      try {
        let result;
        
        // Handle different data modalities
        if (info.modality === 'integration' && info.integrationDatasets) {
          // Integration: files already loaded in FileLoader; build payload and send
          const convertToUint8Array = (value, label) => {
            if (!value) throw new Error(`${label} data is missing`);
            if (value instanceof Uint8Array) return value;
            if (ArrayBuffer.isView && ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            if (value instanceof ArrayBuffer) return new Uint8Array(value);
            if (Array.isArray(value)) return new Uint8Array(value);
            if (value?.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || value.buffer.byteLength);
            if (value && typeof value === 'object') {
              const keys = Object.keys(value);
              if (keys.length && keys.every((k) => !Number.isNaN(Number(k)))) {
                const arr = new Uint8Array(keys.length);
                keys.forEach((k, i) => { arr[i] = value[k]; });
                return arr;
              }
            }
            throw new Error(`Unsupported type for ${label}: ${typeof value}`);
          };
          const payload = { type: 'LOAD_DATA', modality: 'integration', path: path, info: { ...info }, datasets: [] };
          const transferables = [];
          for (const ds of info.integrationDatasets) {
            const entry = { name: ds.name, path: ds.path, info: ds.info || { format: '10X HDF5' }, files: {} };
            const f = ds.files || {};
            if (f.h5) {
              const h5Data = convertToUint8Array(f.h5.data, 'HDF5');
              const buf = h5Data.slice().buffer;
              entry.files.h5 = { name: f.h5.name || 'data.h5', data: buf };
              transferables.push(buf);
            } else if (f.matrix && f.features && f.barcodes) {
              const matrixData = convertToUint8Array(f.matrix.data, 'matrix');
              const featuresData = convertToUint8Array(f.features.data, 'features');
              const barcodesData = convertToUint8Array(f.barcodes.data, 'barcodes');
              const mb = matrixData.slice().buffer, fb = featuresData.slice().buffer, bb = barcodesData.slice().buffer;
              entry.files.matrix = { name: f.matrix.name, data: mb };
              entry.files.features = { name: f.features.name, data: fb };
              entry.files.barcodes = { name: f.barcodes.name, data: bb };
              transferables.push(mb, fb, bb);
            } else {
              throw new Error(`Dataset "${ds.name}": missing HDF5 or matrix/features/barcodes files.`);
            }
            payload.datasets.push(entry);
          }
          if (previousResults) payload.previousResults = previousResults;
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous integration results...' : 'Loading integration...');
          worker.postMessage(payload, transferables);
          return;
        }
        if (info.modality === 'atac-integration' && info.atacIntegrationDatasets) {
          // ATAC Integration: files already loaded in FileLoader; build payload and send
          const payload = { type: 'LOAD_DATA', modality: 'atac-integration', path, info: { ...info }, atacDatasets: [] };
          const transferables = [];
          for (const ds of info.atacIntegrationDatasets) {
            const f = ds.files || {};
            let matrixBuffer;
            if (f.matrix?.data) {
              // Matrix data assembled in FileLoader (either small or large-but-pre-fetched)
              const raw = f.matrix.data;
              let u8;
              if (raw instanceof Uint8Array) u8 = raw;
              else if (raw instanceof ArrayBuffer) u8 = new Uint8Array(raw);
              else if (Array.isArray(raw)) u8 = new Uint8Array(raw);
              else u8 = new Uint8Array(0);
              matrixBuffer = u8.buffer.byteLength === u8.byteLength && u8.byteOffset === 0
                ? u8.buffer
                : u8.slice().buffer;
              transferables.push(matrixBuffer);
            } else {
              throw new Error(`ATAC sample "${ds.name}": matrix data missing (was the file loaded correctly?)`);
            }
            // Include peak annotation if available (for gene-lookup in worker)
            let peakAnnotationBuffer = null;
            if (f.peakAnnotation?.data) {
              const raw = f.peakAnnotation.data;
              let u8;
              if (raw instanceof Uint8Array) u8 = raw;
              else if (raw instanceof ArrayBuffer) u8 = new Uint8Array(raw);
              else if (Array.isArray(raw)) u8 = new Uint8Array(raw);
              else u8 = new Uint8Array(0);
              if (u8.byteLength > 0) {
                peakAnnotationBuffer = u8.buffer.byteLength === u8.byteLength && u8.byteOffset === 0
                  ? u8.buffer
                  : u8.slice().buffer;
                transferables.push(peakAnnotationBuffer);
              }
            }
            payload.atacDatasets.push({
              name: ds.name,
              matrixBuffer,
              peakNames: Array.isArray(f.peaks) ? f.peaks : [],
              barcodes: Array.isArray(ds.cellBarcodes) ? ds.cellBarcodes : [],
              peakAnnotationBuffer,
            });
          }
          if (previousResults) payload.previousResults = previousResults;
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous ATAC integration results...' : 'Loading ATAC integration...');
          worker.postMessage(payload, transferables);
          return;
        }
        if (info.modality === 'xenium-integration' && info.xeniumIntegrationDatasets) {
          // Xenium Integration: 2 Xenium datasets, MNN batch correction
          const convertToUint8Array = (value, label) => {
            if (!value) throw new Error(`${label} data is missing`);
            if (value instanceof Uint8Array) return value;
            if (ArrayBuffer.isView && ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            if (value instanceof ArrayBuffer) return new Uint8Array(value);
            if (Array.isArray(value)) return new Uint8Array(value);
            if (value && typeof value === 'object') {
              const keys = Object.keys(value);
              if (keys.length && keys.every((k) => !Number.isNaN(Number(k)))) {
                const arr = new Uint8Array(keys.length);
                keys.forEach((k, i) => { arr[i] = value[k]; });
                return arr;
              }
            }
            throw new Error(`Unsupported type for ${label}: ${typeof value}`);
          };
          const payload = {
            type: 'LOAD_DATA',
            modality: 'xenium-integration',
            path,
            info: { ...info },
            xeniumDatasets: [],
          };
          const transferables = [];
          // Per-sample spatial data (cells, coordinates) saved for later rendering
          const perSampleSpatialInfo = [];
          for (const ds of info.xeniumIntegrationDatasets) {
            const f = ds.files || {};
            const entry = { name: ds.name, path: ds.path, files: {} };
            // cell_feature_matrix: either HDF5 or MatrixMarket
            const cfm = f.cellFeatureMatrix;
            if (cfm?.h5) {
              const h5Data = convertToUint8Array(cfm.h5.data, `${ds.name} HDF5`);
              const buf = h5Data.slice().buffer;
              entry.files.h5 = { name: cfm.h5.name || 'cell_feature_matrix.h5', data: buf };
              transferables.push(buf);
            } else if (cfm?.matrix && cfm?.features && cfm?.barcodes) {
              const matrixData = convertToUint8Array(cfm.matrix.data, `${ds.name} matrix`);
              const featuresData = convertToUint8Array(cfm.features.data, `${ds.name} features`);
              const barcodesData = convertToUint8Array(cfm.barcodes.data, `${ds.name} barcodes`);
              const mb = matrixData.slice().buffer, fb = featuresData.slice().buffer, bb = barcodesData.slice().buffer;
              entry.files.matrix = { name: cfm.matrix.name, data: mb };
              entry.files.features = { name: cfm.features.name, data: fb };
              entry.files.barcodes = { name: cfm.barcodes.name, data: bb };
              transferables.push(mb, fb, bb);
            } else {
              throw new Error(`Xenium sample "${ds.name}": cell feature matrix missing.`);
            }
            // Pass cells data for spatial coordinates (parsed by worker)
            if (f.cells?.data) {
              const cellsData = convertToUint8Array(f.cells.data, `${ds.name} cells`);
              const cellsBuf = cellsData.slice().buffer;
              entry.files.cells = { name: f.cells.name, data: cellsBuf };
              transferables.push(cellsBuf);
            }
            // Save spatial info for rendering
            perSampleSpatialInfo.push({
              name: ds.name,
              metadata: ds.metadata,
              files: { analysis: f.analysis },
            });
            payload.xeniumDatasets.push(entry);
          }
          // Store per-sample spatial info on dataInfo for rendering later
          payload.perSampleSpatialInfo = perSampleSpatialInfo;
          if (previousResults) payload.previousResults = previousResults;
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous Xenium integration results...' : 'Loading Xenium integration...');
          worker.postMessage(payload, transferables);
          return;
        }
        if (info.modality === 'visium-hd-integration' && info.visiumHDIntegrationDatasets) {
          // Visium HD Integration: 2 Visium HD datasets, MNN batch correction
          const convertToUint8Array = (value, label) => {
            if (!value) throw new Error(`${label} data is missing`);
            if (value instanceof Uint8Array) return value;
            if (ArrayBuffer.isView && ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            if (value instanceof ArrayBuffer) return new Uint8Array(value);
            if (Array.isArray(value)) return new Uint8Array(value);
            if (value && typeof value === 'object') {
              const keys = Object.keys(value);
              if (keys.length && keys.every((k) => !Number.isNaN(Number(k)))) {
                const arr = new Uint8Array(keys.length);
                keys.forEach((k, i) => { arr[i] = value[k]; });
                return arr;
              }
            }
            throw new Error(`Unsupported type for ${label}: ${typeof value}`);
          };
          const hdPayload = {
            type: 'LOAD_DATA',
            modality: 'visium-hd-integration',
            path,
            info: { ...info },
            visiumHDDatasets: [],
          };
          const hdTransferables = [];
          const hdPerSampleSpatialInfo = [];
          for (const ds of info.visiumHDIntegrationDatasets) {
            const f = ds.files || {};
            const entry = { name: ds.name, path: ds.path, files: {} };
            // cell_feature_matrix: either HDF5 or MatrixMarket
            const cfm = f.cellFeatureMatrix;
            if (cfm?.h5) {
              const h5Data = convertToUint8Array(cfm.h5.data, `${ds.name} HDF5`);
              const buf = h5Data.slice().buffer;
              entry.files.h5 = { name: cfm.h5.name || 'filtered_feature_cell_matrix.h5', data: buf };
              hdTransferables.push(buf);
            } else if (cfm?.matrix && cfm?.features && cfm?.barcodes) {
              const matrixData = convertToUint8Array(cfm.matrix.data, `${ds.name} matrix`);
              const featuresData = convertToUint8Array(cfm.features.data, `${ds.name} features`);
              const barcodesData = convertToUint8Array(cfm.barcodes.data, `${ds.name} barcodes`);
              const mb = matrixData.slice().buffer, fb = featuresData.slice().buffer, bb = barcodesData.slice().buffer;
              entry.files.matrix = { name: cfm.matrix.name, data: mb };
              entry.files.features = { name: cfm.features.name, data: fb };
              entry.files.barcodes = { name: cfm.barcodes.name, data: bb };
              hdTransferables.push(mb, fb, bb);
            } else {
              throw new Error(`Visium HD sample "${ds.name}": cell feature matrix missing.`);
            }
            // Pass cellSegmentation GeoJSON for spatial coordinates (segmented data)
            if (f.cellSegmentation?.data) {
              const segData = convertToUint8Array(f.cellSegmentation.data, `${ds.name} cellSegmentation`);
              const segBuf = segData.slice().buffer;
              entry.files.cellSegmentation = { name: f.cellSegmentation.name || 'cell_segmentations.geojson', data: segBuf };
              hdTransferables.push(segBuf);
            }
            // Pass tissuePositions for spatial coordinates (binned data fallback)
            if (!f.cellSegmentation?.data && f.tissuePositions?.data) {
              const tpData = convertToUint8Array(f.tissuePositions.data, `${ds.name} tissuePositions`);
              const tpBuf = tpData.slice().buffer;
              entry.files.tissuePositions = { name: f.tissuePositions.name || 'spatial/tissue_positions.csv', data: tpBuf, format: f.tissuePositions.format || 'csv' };
              hdTransferables.push(tpBuf);
            }
            hdPerSampleSpatialInfo.push({
              name: ds.name,
              metadata: ds.metadata,
              dataType: ds.dataType,
            });
            hdPayload.visiumHDDatasets.push(entry);
          }
          hdPayload.perSampleSpatialInfo = hdPerSampleSpatialInfo;
          if (previousResults) hdPayload.previousResults = previousResults;
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous Visium HD integration results...' : 'Loading Visium HD integration...');
          worker.postMessage(hdPayload, hdTransferables);
          return;
        }
        if (info.modality === 'merfish-integration' && info.merfishIntegrationDatasets) {
          // MERFISH Integration: 2 MERFISH datasets, MNN batch correction
          const convertToUint8Array = (value, label) => {
            if (!value) throw new Error(`${label} data is missing`);
            if (value instanceof Uint8Array) return value;
            if (ArrayBuffer.isView && ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            if (value instanceof ArrayBuffer) return new Uint8Array(value);
            if (Array.isArray(value)) return new Uint8Array(value);
            if (value && typeof value === 'object') {
              const keys = Object.keys(value);
              if (keys.length && keys.every((k) => !Number.isNaN(Number(k)))) {
                const arr = new Uint8Array(keys.length);
                keys.forEach((k, i) => { arr[i] = value[k]; });
                return arr;
              }
            }
            throw new Error(`Unsupported type for ${label}: ${typeof value}`);
          };
          const merfishPayload = {
            type: 'LOAD_DATA',
            modality: 'merfish-integration',
            path,
            info: { ...info },
            merfishDatasets: [],
          };
          const merfishTransferables = [];
          const merfishPerSampleSpatialInfo = [];
          for (const ds of info.merfishIntegrationDatasets) {
            const f = ds.files || {};
            const entry = { name: ds.name, path: ds.path, files: {} };
            // counts (cell_by_gene.csv): required
            if (f.counts?.data) {
              const countsData = convertToUint8Array(f.counts.data, `${ds.name} counts`);
              const countsBuf = countsData.slice().buffer;
              entry.files.counts = { name: f.counts.name, data: countsBuf };
              merfishTransferables.push(countsBuf);
            } else {
              throw new Error(`MERFISH sample "${ds.name}": cell_by_gene.csv missing.`);
            }
            // spatial (cell_metadata.csv): required
            if (f.spatial?.data) {
              const spatialData = convertToUint8Array(f.spatial.data, `${ds.name} spatial`);
              const spatialBuf = spatialData.slice().buffer;
              entry.files.spatial = { name: f.spatial.name, data: spatialBuf };
              merfishTransferables.push(spatialBuf);
            } else {
              throw new Error(`MERFISH sample "${ds.name}": cell_metadata.csv missing.`);
            }
            merfishPerSampleSpatialInfo.push({
              name: ds.name,
              metadata: ds.metadata,
            });
            merfishPayload.merfishDatasets.push(entry);
          }
          merfishPayload.perSampleSpatialInfo = merfishPerSampleSpatialInfo;
          if (previousResults) merfishPayload.previousResults = previousResults;
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous MERFISH integration results...' : 'Loading MERFISH integration...');
          worker.postMessage(merfishPayload, merfishTransferables);
          return;
        }
        if (info.modality === 'spatial') {
          // For Xenium data, files are already loaded in FileLoader
          result = {
            success: true,
            format: info.format,
            modality: 'spatial',
            files: info.files,
            metadata: info.metadata,
          };
        } else if (info.modality === 'multiome' && info.files) {
          // scMultiome: files already loaded in FileLoader via readMultiomeFiles
          result = {
            success: true,
            format: '10X Multiome',
            modality: 'multiome',
            files: info.files,
            precomputed: info.precomputed,
            cellBarcodes: info.cellBarcodes,
          };
        } else if (info.modality === 'atac' && info.files) {
          // scATAC-seq: files already loaded in FileLoader via read10xAtacFiles
          result = {
            success: true,
            format: '10X ATAC',
            modality: 'atac',
            files: info.files,
            cellBarcodes: info.cellBarcodes,
          };
        } else {
          // For single-cell data, read files using existing method
          result = await window.electron.read10xFiles(path, {
            format: info.format,
            h5FileName: info.h5FileName,
          });
        }
        
        if (!result.success) {
          throw new Error(result.error);
        }
        

        const convertToUint8Array = (value, label) => {
          if (!value) {
            throw new Error(`${label} data is missing`);
          }
          if (value instanceof Uint8Array) {
            return value;
          }
          if (ArrayBuffer.isView && ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          }
          if (value instanceof ArrayBuffer) {
            return new Uint8Array(value);
          }
          if (Array.isArray(value)) {
            return new Uint8Array(value);
          }
          if (value && typeof value === 'object') {
            if (value.buffer instanceof ArrayBuffer) {
              const byteOffset = value.byteOffset || 0;
              const byteLength = value.byteLength || value.buffer.byteLength;
              return new Uint8Array(value.buffer, byteOffset, byteLength);
            }

            const keys = Object.keys(value);
            if (keys.length && keys.every((key) => !Number.isNaN(Number(key)))) {
              const sortedKeys = keys.map(Number).sort((a, b) => a - b);
              const arr = new Uint8Array(sortedKeys.length);
              sortedKeys.forEach((key, index) => {
                arr[index] = value[key];
              });
              return arr;
            }
          }
          throw new Error(`Unsupported data type for ${label}: ${typeof value}`);
        };

        const payload = {
          type: 'LOAD_DATA',
          path: path,
          info: info,
          files: {},
        };
        const transferables = [];

        // For MERFISH data, handle custom CSV format
        if (info.modality === 'spatial' && info.format === 'MERFISH') {

          // Prepare MERFISH files for transfer to worker
          const countsData = convertToUint8Array(result.files.counts?.data, 'counts');
          const spatialData = convertToUint8Array(result.files.spatial?.data, 'spatial');

          if (countsData.length === 0) {
            throw new Error('MERFISH counts file (cell_by_gene.csv) is empty');
          }
          if (spatialData.length === 0) {
            throw new Error('MERFISH spatial file (cell_metadata.csv) is empty');
          }

          const countsBuffer = countsData.slice().buffer;
          const spatialBuffer = spatialData.slice().buffer;

          // Prepare MERFISH-specific payload
          payload.files.merfishCounts = {
            name: result.files.counts.name,
            data: countsBuffer,
          };
          payload.files.merfishSpatial = {
            name: result.files.spatial.name,
            data: spatialBuffer,
          };

          transferables.push(countsBuffer, spatialBuffer);

          // Handle optional clustering file
          if (result.files.clusters?.data) {
            const clustersData = convertToUint8Array(result.files.clusters.data, 'clusters');
            const clustersBuffer = clustersData.slice().buffer;
            payload.files.merfishClusters = {
              name: result.files.clusters.name,
              data: clustersBuffer,
            };
            transferables.push(clustersBuffer);
          }

          // Handle optional UMAP file
          if (result.files.umap?.data) {
            const umapData = convertToUint8Array(result.files.umap.data, 'umap');
            const umapBuffer = umapData.slice().buffer;
            payload.files.merfishUmap = {
              name: result.files.umap.name,
              data: umapBuffer,
            };
            transferables.push(umapBuffer);
          }

          payload.info = { ...info, format: 'MERFISH' };

        // For CosMX data, handle custom CSV format (similar to MERFISH)
        } else if (info.modality === 'spatial' && info.format === 'CosMX') {

          const preparsedUrls = result.files.counts?.preparsedUrls;

          if (preparsedUrls) {
            // Large expression file was stream-parsed; data is served at URLs (avoids huge IPC payload)
            payload.files.cosmxCounts = {
              name: result.files.counts.name,
              preparsedUrls,
            };
          } else {
            // Small expression file: pass raw CSV data for worker to parse
            const countsData = convertToUint8Array(result.files.counts?.data, 'counts');
            if (countsData.length === 0) {
              throw new Error('CosMX expression matrix file (*_exprMat_file.csv) is empty');
            }
            const countsBuffer = countsData.slice().buffer;
            payload.files.cosmxCounts = { name: result.files.counts.name, data: countsBuffer };
            transferables.push(countsBuffer);
          }

          const spatialData = convertToUint8Array(result.files.spatial?.data, 'spatial');
          if (spatialData.length === 0) {
            throw new Error('CosMX metadata file (*_metadata_file.csv) is empty');
          }
          const spatialBuffer = spatialData.slice().buffer;
          payload.files.cosmxSpatial = {
            name: result.files.spatial.name,
            data: spatialBuffer,
          };
          transferables.push(spatialBuffer);

          payload.info = { ...info, format: 'CosMX' };

        // For spatial data (Xenium or Visium HD), we need to handle cell_feature_matrix
        } else if (info.modality === 'spatial' && result.files.cellFeatureMatrix) {
          
          const cfm = result.files.cellFeatureMatrix;
          
          // Check if it's HDF5 format (h5 file) or MatrixMarket format
          if (cfm.h5) {
            // HDF5 format: use h5 file
            const h5Data = convertToUint8Array(cfm.h5.data, 'HDF5');
            if (h5Data.length === 0) {
              throw new Error('HDF5 cell feature matrix file is empty');
            }
            
            const h5Buffer = h5Data.slice().buffer;
            payload.files.h5 = {
              name: cfm.h5.name || 'cell_feature_matrix.h5',
              data: h5Buffer,
            };
            payload.info = { ...info, format: '10X HDF5' };
            transferables.push(h5Buffer);
          } else {
            // MatrixMarket format: use matrix/features/barcodes files
            const matrixData = convertToUint8Array(cfm.matrix?.data, 'matrix');
            const featuresData = convertToUint8Array(cfm.features?.data, 'features');
            const barcodesData = convertToUint8Array(cfm.barcodes?.data, 'barcodes');

            if (matrixData.length === 0 || featuresData.length === 0 || barcodesData.length === 0) {
              throw new Error('One or more cell feature matrix files are empty');
            }

            const matrixBuffer = matrixData.slice().buffer;
            const featuresBuffer = featuresData.slice().buffer;
            const barcodesBuffer = barcodesData.slice().buffer;

            // For worker simplicity, mimic MatrixMarket naming
            payload.files.matrix = {
              name: cfm.matrix.name,
              data: matrixBuffer,
            };
            payload.files.features = {
              name: cfm.features.name,
              data: featuresBuffer,
            };
            payload.files.barcodes = {
              name: cfm.barcodes.name,
              data: barcodesBuffer,
            };
            // Force format field so worker recognizes MatrixMarket pathway
            // Keep original format name for identification but use compatible format
            payload.info = { ...info, format: info.format === '10X Visium HD' ? '10X Xenium' : '10X Xenium' };

            transferables.push(matrixBuffer, featuresBuffer, barcodesBuffer);
          }
          
          // Also pass spatial metadata (for both HDF5 and MatrixMarket formats)

          // Handle different spatial data formats
          let cellsForWorker = null;
          let cellSegmentationForWorker = null;

          // For Xenium: cells data from cells.csv
          if (result.files.cells?.data) {
            try {
              const cellsData = convertToUint8Array(result.files.cells.data, 'cells');
              cellsForWorker = {
                name: result.files.cells.name,
                data: cellsData,
              };
            } catch (e) {
              console.error('Failed to convert cells data:', e);
            }
          }

          // For Visium HD: cell segmentation from GeoJSON
          if (result.files.cellSegmentation?.data) {
            try {
              const segData = convertToUint8Array(result.files.cellSegmentation.data, 'cellSegmentation');
              cellSegmentationForWorker = {
                name: result.files.cellSegmentation.name,
                data: segData,
              };
            } catch (e) {
              console.error('Failed to convert cellSegmentation data:', e);
            }
          }

          // For Visium HD binned outputs: tissue positions for spatial coordinates
          let tissuePositionsForWorker = null;
          if (result.files.tissuePositions?.data) {
            try {
              const posData = convertToUint8Array(result.files.tissuePositions.data, 'tissuePositions');
              tissuePositionsForWorker = {
                name: result.files.tissuePositions.name,
                data: posData,
                format: result.files.tissuePositions.format,
              };
            } catch (e) {
              console.error('Failed to convert tissuePositions data:', e);
            }
          }

          // For Visium HD: barcode_mappings.parquet as alternative source of spatial coordinates
          let barcodeMappingsForWorker = null;
          if (result.files.barcodeMappings?.data) {
            try {
              const mappingsData = convertToUint8Array(result.files.barcodeMappings.data, 'barcodeMappings');
              barcodeMappingsForWorker = {
                name: result.files.barcodeMappings.name,
                data: mappingsData,
                format: result.files.barcodeMappings.format,
              };
            } catch (e) {
              console.error('Failed to convert barcodeMappings data:', e);
            }
          }

          payload.spatialInfo = {
            cells: cellsForWorker,
            cellSegmentation: cellSegmentationForWorker,
            tissuePositions: tissuePositionsForWorker,
            barcodeMappings: barcodeMappingsForWorker,
            analysis: result.files.analysis,
            metadata: result.metadata,
            dataType: info.dataType, // 'segmented' or 'binned' for Visium HD
          };

          
        } else if (info.format === '10X Multiome' || result.format === '10X Multiome') {
          // Multiome: H5 file + optional peak annotation + precomputed analysis
          const h5File = result.files?.h5;
          if (!h5File) {
            throw new Error('Multiome HDF5 file payload missing from result');
          }
          const h5Data = convertToUint8Array(h5File.data, 'HDF5');
          if (h5Data.length === 0) {
            throw new Error('Multiome HDF5 file is empty');
          }
          const h5Buffer = h5Data.slice().buffer;
          payload.files.h5 = {
            name: h5File.name || 'filtered_feature_bc_matrix.h5',
            data: h5Buffer,
          };
          transferables.push(h5Buffer);

          // Peak annotation (optional)
          if (result.files?.peakAnnotation) {
            const peakAnnoData = convertToUint8Array(result.files.peakAnnotation.data, 'peakAnnotation');
            const peakAnnoBuffer = peakAnnoData.slice().buffer;
            payload.files.peakAnnotation = {
              name: result.files.peakAnnotation.name || 'atac_peak_annotation.tsv',
              data: peakAnnoBuffer,
            };
            transferables.push(peakAnnoBuffer);
          }

          // Pass precomputed analysis as text (not transferable, small strings)
          payload.precomputed = result.precomputed || {};
          payload.info = { ...info, format: '10X Multiome', modality: 'multiome' };
        } else if (info.format === '10X ATAC' || result.format === '10X ATAC') {
          const matrixFile = result.files?.matrix;
          if (!matrixFile) {
            throw new Error('ATAC matrix.mtx payload missing from result (same as scATAC pipeline)');
          }
          const useStreamedMatrix = matrixFile._chunkKey != null && matrixFile._matrixSize != null;
          if (useStreamedMatrix) {
            payload.files.matrix = {
              name: matrixFile.name || 'matrix.mtx',
              _chunkKey: matrixFile._chunkKey,
              _matrixSize: matrixFile._matrixSize,
            };
          } else {
            if (!matrixFile.data) {
              throw new Error('ATAC matrix.mtx payload missing from result (same as scATAC pipeline)');
            }
            const matrixData = convertToUint8Array(matrixFile.data, 'matrix');
            if (matrixData.length === 0) {
              throw new Error('ATAC matrix.mtx is empty');
            }
            const singleBuffer = matrixData.slice().buffer;
            payload.files.matrix = {
              name: matrixFile.name || 'matrix.mtx',
              data: singleBuffer,
            };
            transferables.push(singleBuffer);
          }
          payload.files.barcodes = result.files?.barcodes || info.cellBarcodes || [];
          payload.files.peaks = result.files?.peaks || [];
          if (result.files?.peakAnnotation?.data) {
            const peakAnnoData = convertToUint8Array(result.files.peakAnnotation.data, 'peakAnnotation');
            payload.files.peakAnnotation = {
              name: result.files.peakAnnotation.name || 'peak_annotation.tsv',
              data: peakAnnoData.slice().buffer,
            };
            transferables.push(payload.files.peakAnnotation.data);
          }
          payload.info = { ...info, format: '10X ATAC', modality: 'atac', cellBarcodes: payload.files.barcodes };
        } else if (info.format === '10X HDF5') {
          const h5File = result.files?.h5;
          if (!h5File) {
            throw new Error('HDF5 file payload missing from result');
          }

          if (h5File.h5Url) {
            // Large file (≥2 GiB): worker streams data via HTTP Range requests:
            // no binary IPC transfer needed.
            payload.files.h5 = {
              name: h5File.name || info.h5FileName || 'dataset.h5',
              h5Url: h5File.h5Url,
              size: h5File.size,
              isLargeFile: true,
            };
          } else {
            const h5Data = convertToUint8Array(h5File.data, 'HDF5');
            if (h5Data.length === 0) {
              throw new Error('HDF5 file is empty');
            }
            const h5Buffer = h5Data.slice().buffer;
            payload.files.h5 = {
              name: h5File.name || info.h5FileName || 'dataset.h5',
              data: h5Buffer,
            };
            transferables.push(h5Buffer);
          }
        } else {
          const matrixData = convertToUint8Array(result.files.matrix?.data, 'matrix');
          const featuresData = convertToUint8Array(result.files.features?.data, 'features');
          const barcodesData = convertToUint8Array(result.files.barcodes?.data, 'barcodes');

          if (matrixData.length === 0 || featuresData.length === 0 || barcodesData.length === 0) {
            throw new Error('One or more files are empty');
          }

          const matrixBuffer = matrixData.slice().buffer;
          const featuresBuffer = featuresData.slice().buffer;
          const barcodesBuffer = barcodesData.slice().buffer;

          payload.files.matrix = {
            name: result.files.matrix.name,
            data: matrixBuffer,
          };
          payload.files.features = {
            name: result.files.features.name,
            data: featuresBuffer,
          };
          payload.files.barcodes = {
            name: result.files.barcodes.name,
            data: barcodesBuffer,
          };

          transferables.push(matrixBuffer, featuresBuffer, barcodesBuffer);
        }

        // Attach previous results so the worker can restore them instead of running full analysis
        if (previousResults) {
          payload.previousResults = previousResults;
        }
        if (payload.info?.format === '10X ATAC' || payload.info?.modality === 'atac') {
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous scATAC results...' : 'Loading scATAC-seq...');
        }
        worker.postMessage(payload, transferables);

        // Stream large ATAC matrix in chunks so renderer never holds full 1.4GB (avoids postMessage OOM)
        const matrixFile = payload.files?.matrix;
        if (matrixFile?._chunkKey != null && matrixFile?._matrixSize != null && window.electron) {
          const CHUNK_SIZE = 80 * 1024 * 1024; // 80 MB per message
          const totalSize = matrixFile._matrixSize;
          const chunkKey = matrixFile._chunkKey;
          for (let offset = 0; offset < totalSize; offset += CHUNK_SIZE) {
            const length = Math.min(CHUNK_SIZE, totalSize - offset);
            const chunk = await window.electron.getAtacMatrixChunk(chunkKey, offset, length);
            if (!chunk || (chunk.byteLength ?? chunk.length ?? 0) === 0) break;
            const transferable = chunk instanceof ArrayBuffer ? chunk : (chunk.buffer || chunk);
            worker.postMessage({ type: 'ATAC_MATRIX_CHUNK', offset, chunk }, [transferable]);
          }
          try {
            window.electron.releaseAtacMatrixBuffer(chunkKey);
          } catch (e) {
            console.warn('[App] releaseAtacMatrixBuffer:', e);
          }
        }

      } catch (error) {
        console.error('Failed to read files:', error);
        console.error('Error stack:', error.stack);
        setDataInfo(prev => ({ ...prev, cells: 'Error', genes: 'Error' }));
        setIsAnalyzing(false);
        setWorkerStatusMessage('');
        showToast({
          message: `Failed to read files: ${error.message}`,
          intent: 'danger',
          timeout: 5000,
        });
      }
    }
  };

  // Listen for data loaded from worker
  // This is already being handled in the main worker listener (lines 233-460)
  // Just noting that DATA_LOADED updates will come through that handler

  const handleAnalysisRequest = (command) => {
    // Handle rename actions separately: they don't require the worker
    if (command.action === 'rename_cluster') {
      return handleRenameCluster(command);
    }
    if (command.action === 'rename_region') {
      return handleRenameRegion(command);
    }

    if (command.action === 'show_annotation_table') {
      const rows = Array.isArray(command.params?.rows) ? command.params.rows : [];
      setAgentAnnotationRows(rows);
      setActivePlot({ source: 'analysis', data: { type: 'cluster_annotation', ...command.params } });
      if (pendingSaveDataRef.current || clusterPlotRef.current?.data) {
        pendingSaveDataRef.current = {
          ...(pendingSaveDataRef.current || {}),
          umapData: pendingSaveDataRef.current?.umapData || clusterPlotRef.current?.data,
        };
        scheduleResultsSave();
      }
      return { success: true };
    }

    if (command.action === 'plot_gene_expression' && command.params?.gene && !dataPath) {
      return { error: 'Please load data first before plotting gene expression.' };
    }

    // SpaGE gene imputation: read scRNA reference files then post to worker
    if (command.action === 'impute_gene') {
      if (!dataPath || !worker) {
        return { error: 'No spatial data loaded or analysis engine not ready' };
      }
      const scrnaPath = command.params?.scrnaPath;
      if (!scrnaPath) {
        return { error: 'No scRNA-seq reference path provided' };
      }
      setIsAnalyzing(true);
      // Read files asynchronously, then post to worker
      (async () => {
        try {
          const fileData = await window.electron.read10xFiles(scrnaPath);
          if (!fileData || fileData.error) {
            showToast({ message: `Failed to read scRNA reference: ${fileData?.error || 'unknown error'}`, intent: 'danger' });
            setIsAnalyzing(false);
            return;
          }
          worker.postMessage({
            type: 'RUN_ANALYSIS',
            command: command,
            scrnaFiles: fileData,
            dataPath: dataPath,
          });
        } catch (err) {
          showToast({ message: `Error loading scRNA reference: ${err.message}`, intent: 'danger' });
          setIsAnalyzing(false);
        }
      })();
      return { success: true };
    }

    if (!dataPath || !worker) {
      return { error: 'No data loaded or analysis engine not ready' };
    }

    if (command.action === 'plot_gene_expression') {
      const requestedColor = command.params?.colorMap || defaultColorMap;
      setDefaultColorMap(requestedColor);
      setPendingGeneColorMap(requestedColor);
      setLastActiveArtifactId(null);
      pendingShowPeakViewRef.current = !!command.params?.showPeakView;
      pendingMultiomeGenePlotRef.current = dataInfo?.modality === 'multiome';
      setIsAnalyzing(true);
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: command,
        dataPath: dataPath,
      });

      return {
        success: true,
        message: command.params?.showPeakView
          ? `Showing coverage plot for ${command.params.gene}`
          : `Plotting ${command.params.gene} expression (${describeColorMap(requestedColor)})`,
      };
    }

    if (command.action === 'plot_gene_violin') {
      setPendingGeneColorMap(null);
      setLastActiveArtifactId(null);
      pendingMultiomeGenePlotRef.current = dataInfo?.modality === 'multiome';
      setIsAnalyzing(true);
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: command,
        dataPath: dataPath,
        clusterLabelMap: clusterLabelMap,
      });

      return {
        success: true,
        message: `Generating violin plot for ${command.params.gene} across clusters`,
      };
    }

    if (command.action === 'plot_gene_dotplot') {

      const requestedColor = command.params?.colorMap || defaultColorMap;
      setDefaultColorMap(requestedColor);
      setPendingGeneColorMap(requestedColor);
      setLastActiveArtifactId(null);
      pendingMultiomeGenePlotRef.current = dataInfo?.modality === 'multiome';
      setIsAnalyzing(true);

      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: command,
        dataPath: dataPath,
        clusterLabelMap: clusterLabelMap,
      });

      const genes = command.params?.genes || [];
      const geneLabel = Array.isArray(genes) && genes.length
        ? genes.join(', ')
        : (command.params?.gene || 'selected genes');

      return {
        success: true,
        message: `Generating dot plot for ${geneLabel}`,
      };
    }

    const parameterActions = new Set([
      'update_cell_filtering',
      'update_gene_filtering',
      'update_variable_genes',
      'update_clustering_resolution',
      'update_pca_for_umap',
      'update_umap_parameters',
    ]);

    if (parameterActions.has(command.action)) {
      const message = {
        type: 'RUN_ANALYSIS',
        command: command,
        dataPath: dataPath,
      };

      // Include clusterLabelMap for UMAP updates to preserve cluster merges
      if (command.action === 'update_umap_parameters') {
        message.clusterLabelMap = clusterLabelMap;
      }

      setIsAnalyzing(true);
      worker.postMessage(message);

      return {
        success: true,
        message: 'Updating analysis parameters...',
      };
    }

    // Handle cluster info request
    if (command.action === 'cluster_info') {
      const clusterLabel = clusterLabelMap?.[String(command.params?.cluster)] || command.params?.cluster;
      setIsAnalyzing(true);
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: command,
        dataPath: dataPath,
      });

      return {
        success: true,
        message: `Getting information about cluster ${clusterLabel}...`,
      };
    }

    if (command.action === 'identify_cell_type_clusters') {
      const cellType = command.params?.cellType || command.params?.cell_type || 'requested cell type';
      setIsAnalyzing(true);
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command,
        dataPath,
      });

      return {
        success: true,
        message: `Scoring clusters for ${cellType}...`,
      };
    }

    // DEG between two samples within a cluster (integration)
    if (command.action === 'deg_between_samples') {
      const s1 = command.params?.sample1 ?? 'sample1';
      const s2 = command.params?.sample2 ?? 'sample2';
      const c = command.params?.cluster ?? '';
      setIsAnalyzing(true);
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: command,
        dataPath: dataPath,
      });
      return {
        success: true,
        message: `Computing differential genes for cluster ${c} between ${s1} and ${s2}...`,
      };
    }

    // Cell fraction / proportion per sample (integration)
    if (command.action === 'plot_cell_fraction') {
      setIsAnalyzing(true);
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: command,
        dataPath: dataPath,
      });
      return {
        success: true,
        message: 'Computing cell fraction per cluster per sample...',
      };
    }

    // Show regions: display UMAP/spatial colored by BANKSY regions (no worker call needed)
    if (command.action === 'show_regions') {
      if (!regionPlot) {
        return {
          error: 'No region segmentation data available yet. Please run BANKSY region segmentation first.\n\n' +
            'You can say: **"segment regions"**, **"run BANKSY"**, or **"identify spatial regions"** to get started.',
        };
      }
      setActivePlot(regionPlot);
      setLastActiveArtifactId(null);
      const nRegions = regionPlot.data?.nClusters ?? 'multiple';
      showToast({
        message: `Showing ${nRegions} spatial regions`,
        intent: 'success',
        timeout: 2000,
      });
      return {
        success: true,
        message: `Displaying UMAP and spatial view colored by **${nRegions} BANKSY regions**.`,
      };
    }

    // Region composition: cell type breakdown within a BANKSY spatial region
    if (command.action === 'region_composition') {
      if (!regionPlot) {
        return {
          error: 'No region segmentation data available yet. Please run BANKSY region segmentation first.\n\n' +
            'You can say: **"segment regions"**, **"run BANKSY"**, or **"identify spatial regions"** to get started.',
        };
      }
      setIsAnalyzing(true);
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: command,
        dataPath: dataPath,
      });
      const rId = command.params?.regionId ?? '';
      const rDisplayName = regionLabelMap?.[String(rId)] || `region ${rId}`;
      return {
        success: true,
        message: `Computing cell type composition for ${rDisplayName}...`,
      };
    }

    if (command.action === 'spatial_region_markers') {
      const selectedCellIndices = command.params?.selectedCellIndices || spatialSelection?.globalIndices;
      if (!Array.isArray(selectedCellIndices) || selectedCellIndices.length < 3) {
        return {
          error: 'No spatial region is selected yet. Use the rectangle or freehand selection tool in Spatial View, then ask “what is this area?”',
        };
      }
      setIsAnalyzing(true);
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: {
          ...command,
          params: {
            ...command.params,
            selectedCellIndices,
            regionCellCount: selectedCellIndices.length,
            regionFormat: spatialSelection?.format || dataInfo?.format || dataInfo?.modality || 'spatial',
            hasHistologyImage: !!spatialSelection?.hasHistologyImage,
            suppressNeutralSummary: !!command.params?.suppressNeutralSummary,
          },
        },
        dataPath: dataPath,
      });
      return {
        success: true,
        message: `Finding markers for the selected spatial region (${selectedCellIndices.length.toLocaleString()} cells) versus all other cells...`,
      };
    }

    if (command.action === 'spatial_cell_interaction') {
      const selectedRegions = Array.isArray(spatialSelection?.regions) ? spatialSelection.regions : [];
      const commandRegions = Array.isArray(command.params?.regions) ? command.params.regions : null;
      const regionsForAnalysis = commandRegions?.length
        ? commandRegions.map((region, idx) => ({
            id: region.id || `Region ${idx + 1}`,
            globalIndices: region.selectedCellIndices || region.globalIndices || region.indices || [],
          }))
        : selectedRegions;
      if (regionsForAnalysis.length < 2) {
        return {
          error: 'Cell-cell interaction analysis needs at least two selected spatial areas. Please select two regions in Spatial View, then ask again.',
        };
      }
      if (regionsForAnalysis.some(region => !Array.isArray(region.globalIndices) || region.globalIndices.length < 3)) {
        return {
          error: 'Each selected area needs at least 3 cells for ligand-receptor analysis. Please select larger regions.',
        };
      }
      setIsAnalyzing(true);
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: {
          ...command,
          params: {
            ...command.params,
            regions: regionsForAnalysis.map((region, idx) => ({
              id: region.id || `Region ${idx + 1}`,
              selectedCellIndices: region.globalIndices,
            })),
            regionFormat: spatialSelection?.format || dataInfo?.format || dataInfo?.modality || 'spatial',
          },
        },
        dataPath: dataPath,
      });
      const regionLabel = regionsForAnalysis
        .map(region => `${region.id} (${region.globalIndices.length.toLocaleString()} cells)`)
        .join(', ');
      return {
        success: true,
        message: `Running ligand-receptor analysis across ${regionsForAnalysis.length} selected spatial regions: ${regionLabel}...`,
      };
    }

    // WNN integration: combine RNA and ATAC into a co-embedding UMAP
    if (command.action === 'wnn_integrate') {
      if (dataInfo?.modality !== 'multiome') {
        return { error: 'WNN integration requires multiome (RNA + ATAC) data.' };
      }
      setIsAnalyzing(true);
      // Don't clear WNN panels immediately, keep them visible during recomputation.
      // wnn-individual and wnn messages will update them as they arrive.
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: command,
        dataPath: dataPath,
      });
      return { success: true, message: 'Running WNN integration (RNA + ATAC co-embedding)...' };
    }

    // Resolve named cluster label → numeric ID(s) for TF motif analysis
    if (command.action === 'tf_motif_analysis') {
      const clusterParam = command.params?.cluster;
      // If ChatBot already resolved multiple IDs for a merged label, use them all
      const preResolvedClusters = command.params?.clusters;
      if (Array.isArray(preResolvedClusters) && preResolvedClusters.length > 1) {
        const displayName = clusterLabelMap?.[String(preResolvedClusters[0])] || `Clusters [${preResolvedClusters.join(', ')}]`;
        setIsAnalyzing(true);
        worker.postMessage({
          type: 'RUN_ANALYSIS',
          command: { ...command, params: { ...command.params, clusters: preResolvedClusters } },
          dataPath: dataPath,
        });
        return { success: true, message: `Running TF motif enrichment for ${displayName}...` };
      }
      // Single cluster, resolve label to numeric ID
      const resolved = (() => {
        if (typeof clusterParam === 'number' && !Number.isNaN(clusterParam)) return clusterParam;
        const str = String(clusterParam).trim();
        const asNum = parseInt(str, 10);
        if (!Number.isNaN(asNum)) return asNum;
        const entry = Object.entries(clusterLabelMap).find(
          ([, label]) => String(label).toLowerCase() === str.toLowerCase()
        );
        return entry ? parseInt(entry[0], 10) : null;
      })();
      if (resolved === null) {
        return { error: `Cluster "${clusterParam}" not found. Check the cluster name and try again.` };
      }
      const displayName = clusterLabelMap?.[String(resolved)] || `Cluster ${resolved}`;
      setIsAnalyzing(true);
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: { ...command, params: { ...command.params, cluster: resolved } },
        dataPath: dataPath,
      });
      return { success: true, message: `Running TF motif enrichment for ${displayName}...` };
    }

    // Send analysis request to worker
    setIsAnalyzing(true);
    worker.postMessage({
      type: 'RUN_ANALYSIS',
      command: command,
      dataPath: dataPath,
    });

    return { success: true, message: 'Analysis started...' };
  };

  const handleHighlightRnaClusterOnAtac = (clusterParam) => {
    if (clusterParam === null || clusterParam === undefined || clusterParam === '') {
      setRnaClusterHighlightOnAtac(null);
      return true;
    }
    // Resolve label to cluster ID (e.g. "PT" -> 1) using RNA clusterLabelMap
    const resolved = (() => {
      if (typeof clusterParam === 'number' && !Number.isNaN(clusterParam)) return clusterParam;
      const str = String(clusterParam).trim();
      const asNum = parseInt(str, 10);
      if (!Number.isNaN(asNum)) return asNum;
      const entry = Object.entries(clusterLabelMap).find(
        ([, label]) => String(label).toLowerCase() === str.toLowerCase()
      );
      return entry ? parseInt(entry[0], 10) : null;
    })();
    if (resolved === null) return false;
    setRnaClusterHighlightOnAtac(resolved);
    setAtacClusterHighlightOnRna(null); // only one cross-highlight at a time; RNA→ATAC takes precedence
    return true;
  };

  const handleHighlightAtacClusterOnRna = (clusterParam) => {
    if (clusterParam === null || clusterParam === undefined || clusterParam === '') {
      setAtacClusterHighlightOnRna(null);
      return true;
    }
    // Resolve label to cluster ID using ATAC clusterLabelMap
    const resolved = (() => {
      if (typeof clusterParam === 'number' && !Number.isNaN(clusterParam)) return clusterParam;
      const str = String(clusterParam).trim();
      const asNum = parseInt(str, 10);
      if (!Number.isNaN(asNum)) return asNum;
      const entry = Object.entries(atacClusterLabelMap).find(
        ([, label]) => String(label).toLowerCase() === str.toLowerCase()
      );
      return entry ? parseInt(entry[0], 10) : null;
    })();
    if (resolved === null) return false;
    setAtacClusterHighlightOnRna(resolved);
    setRnaClusterHighlightOnAtac(null); // only one cross-highlight at a time; ATAC→RNA takes precedence
    return true;
  };

  const handleColorMapChange = (map) => {
    const newMap = map || defaultColorMap;
    setDefaultColorMap(newMap);
    if (!artifacts.length) {
      showToast({
        message: 'No recent plot to recolor. Please create a plot first.',
        intent: 'warning',
        timeout: 3000,
      });
      return false;
    }

    // First try to find the last active artifact (either gene_expression or gene_dotplot)
    let targetIndex = artifacts.findIndex(
      (artifact) => artifact.id === lastActiveArtifactId && 
                    (artifact.type === 'gene_expression' || artifact.type === 'gene_dotplot')
    );

    // If no match, find the most recent colorable artifact (gene_expression or gene_dotplot)
    if (targetIndex === -1) {
      for (let i = artifacts.length - 1; i >= 0; i--) {
        if (artifacts[i].type === 'gene_expression' || artifacts[i].type === 'gene_dotplot') {
          targetIndex = i;
          break;
        }
      }
    }

    if (targetIndex === -1) {
      showToast({
        message: 'No plot found to recolor. Please generate a gene expression or dot plot first.',
        intent: 'warning',
        timeout: 3000,
      });
      return false;
    }

    const targetArtifact = artifacts[targetIndex];
    const updatedArtifact = {
      ...targetArtifact,
      colorMap: newMap,
      updatedAt: new Date().toISOString(),
    };
    const updatedArtifacts = [...artifacts];
    updatedArtifacts[targetIndex] = updatedArtifact;

    // If this is a dotplot with a linked spatial artifact, update that too
    let spatialArtifactId = null;
    if (targetArtifact.type === 'gene_dotplot') {
      // Find the spatial gene expression artifact created at the same time
      // It should have been created right after the dotplot
      const spatialArtifactIndex = artifacts.findIndex(
        (artifact, idx) =>
          artifact.type === 'gene_expression' &&
          idx === targetIndex + 1 && // Created right after the dotplot
          artifact.geneName === targetArtifact.geneNames?.[0]
      );

      if (spatialArtifactIndex !== -1) {
        spatialArtifactId = artifacts[spatialArtifactIndex].id;
        const updatedSpatialArtifact = {
          ...artifacts[spatialArtifactIndex],
          colorMap: newMap,
          updatedAt: new Date().toISOString(),
        };
        updatedArtifacts[spatialArtifactIndex] = updatedSpatialArtifact;
      }
    }

    // Multiome: when recoloring a gene expression plot, update both RNA and ATAC artifacts for the same gene
    if (dataInfo?.modality === 'multiome' && targetArtifact.type === 'gene_expression' && targetArtifact.geneName) {
      const pairedIndex = artifacts.findIndex(
        (artifact) =>
          artifact.type === 'gene_expression' &&
          artifact.geneName === targetArtifact.geneName &&
          Boolean(artifact.isAtac) !== Boolean(targetArtifact.isAtac)
      );
      if (pairedIndex !== -1) {
        updatedArtifacts[pairedIndex] = {
          ...artifacts[pairedIndex],
          colorMap: newMap,
          updatedAt: new Date().toISOString(),
        };
      }
    }

    // Multiome: when recoloring a dot plot, update both RNA and ATAC dot plot artifacts for the same genes
    if (dataInfo?.modality === 'multiome' && targetArtifact.type === 'gene_dotplot' && Array.isArray(targetArtifact.geneNames) && targetArtifact.geneNames.length > 0) {
      const targetGeneKey = targetArtifact.geneNames.join(',');
      const pairedIndex = artifacts.findIndex(
        (artifact) =>
          artifact.type === 'gene_dotplot' &&
          Array.isArray(artifact.geneNames) &&
          artifact.geneNames.length === targetArtifact.geneNames.length &&
          artifact.geneNames.join(',') === targetGeneKey &&
          Boolean(artifact.isAtac) !== Boolean(targetArtifact.isAtac)
      );
      if (pairedIndex !== -1) {
        updatedArtifacts[pairedIndex] = {
          ...artifacts[pairedIndex],
          colorMap: newMap,
          updatedAt: new Date().toISOString(),
        };
      }
    }

    setArtifacts(updatedArtifacts);
    setLastActiveArtifactId(updatedArtifact.id);

    // Preserve the spatialArtifactId link when updating activePlot
    const newActivePlot = { source: 'artifact', artifactId: updatedArtifact.id };
    if (spatialArtifactId) {
      newActivePlot.spatialArtifactId = spatialArtifactId;
    }
    setActivePlot(newActivePlot);
    
    // Generate appropriate message based on plot type
    let plotDescription = '';
    if (targetArtifact.type === 'gene_expression') {
      plotDescription = targetArtifact.geneName || 'gene expression plot';
    } else if (targetArtifact.type === 'gene_dotplot') {
      const geneCount = targetArtifact.geneNames?.length || 0;
      plotDescription = geneCount === 1 
        ? `dot plot (${targetArtifact.geneNames[0]})` 
        : `dot plot (${geneCount} genes)`;
    }
    
    showToast({
      message: `Recolored ${plotDescription} using ${describeColorMap(newMap)}.`,
      intent: 'success',
      timeout: 2000,
    });
    return true;
  };

  const handleSetClusterColorFromChat = ({ cluster, color, multiomeTarget } = {}) => {
    const clusterId = String(cluster ?? '').trim().replace(/^cluster\s*/i, '');
    if (!clusterId) {
      return { success: false, error: 'Please specify which cluster color to change.' };
    }

    const nextColor = color ? String(color).trim() : null;
    const update = (setter) => {
      setter((prev) => {
        const next = { ...prev };
        if (!nextColor) {
          delete next[clusterId];
        } else {
          next[clusterId] = nextColor;
        }
        return next;
      });
    };

    const isMultiome = dataInfo?.modality === 'multiome';
    if (multiomeTarget === 'atac') {
      update(setAtacClusterColorOverrides);
      return { success: true, target: 'ATAC' };
    }
    if (multiomeTarget === 'wnn') {
      update(setWnnClusterColorOverrides);
      return { success: true, target: 'WNN' };
    }
    if (multiomeTarget === 'rna') {
      update(setClusterColorOverrides);
      return { success: true, target: isMultiome ? 'RNA' : '' };
    }

    update(setClusterColorOverrides);
    if (isMultiome && wnnActive) {
      update(setAtacClusterColorOverrides);
      update(setWnnClusterColorOverrides);
      return { success: true, target: 'RNA, ATAC, and WNN' };
    }
    return { success: true, target: '' };
  };

  const handleRenameCluster = (command) => {
    const { oldLabel, newLabel, multiomeTarget } = command.params || {};

    if (!oldLabel || !newLabel) {
      return { error: 'Please specify both the cluster to rename and the new name.' };
    }

    // Normalize the old label to string for consistent lookup
    const oldKey = String(oldLabel).trim();
    const newName = String(newLabel).trim();

    if (!newName) {
      return { error: 'New cluster name cannot be empty.' };
    }

    // Determine which label map and color overrides to use based on multiome target
    const isAtac = multiomeTarget === 'atac';
    const isWnn = multiomeTarget === 'wnn';
    const activeLabelMap = isAtac ? atacClusterLabelMap : isWnn ? wnnClusterLabelMap : clusterLabelMap;
    const setActiveLabelMap = isAtac ? setAtacClusterLabelMap : isWnn ? setWnnClusterLabelMap : setClusterLabelMap;
    const activeColorOverrides = isAtac ? atacClusterColorOverrides : isWnn ? wnnClusterColorOverrides : clusterColorOverrides;
    const setActiveColorOverrides = isAtac ? setAtacClusterColorOverrides : isWnn ? setWnnClusterColorOverrides : setClusterColorOverrides;
    const modalityLabel = isAtac ? 'ATAC' : isWnn ? 'WNN' : 'RNA';

    // Check if the new name already exists in the cluster label map
    // If so, this is a merge operation
    const existingClustersWithSameName = Object.entries(activeLabelMap)
      .filter(([key, value]) => value === newName && key !== oldKey)
      .map(([key]) => key);

    if (existingClustersWithSameName.length > 0) {
      // This is a merge! The user is renaming a cluster to match an existing cluster name

      // Find the target cluster ID (the first one with this name)
      const targetClusterId = parseInt(existingClustersWithSameName[0]);
      const sourceClusterId = parseInt(oldKey);

      if (isNaN(targetClusterId) || isNaN(sourceClusterId)) {
        return { error: 'Cluster merging requires numeric cluster IDs.' };
      }

      // Trigger cluster merge in the worker
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: {
          action: 'merge_clusters',
          params: {
            sourceClusterIds: [sourceClusterId],
            targetClusterId: targetClusterId,
            multiomeTarget: multiomeTarget,
          }
        },
        dataPath: dataPath,
      });

      // Update the cluster label map. KEEP both cluster entries with the same merged name
      // This allows us to find all cells from both original clusters when looking up the label
      setActiveLabelMap(prev => {
        const updated = { ...prev };
        // IMPORTANT: Keep the source cluster entry with the merged name (don't delete it!)
        // This allows "find markers for PT" to find cells from BOTH original clusters
        updated[oldKey] = newName;
        // Ensure the target cluster also has the merged name
        updated[String(targetClusterId)] = newName;
        return updated;
      });

      // Make merged clusters use the same color (the target cluster's color)
      const targetColor = activeColorOverrides[String(targetClusterId)];
      if (targetColor) {
        setActiveColorOverrides(prev => ({
          ...prev,
          [String(sourceClusterId)]: targetColor,
        }));
      }

      showToast({
        message: `${modalityLabel}: Merging cluster ${oldKey} into "${newName}" (cluster ${targetClusterId})...`,
        intent: 'primary',
        timeout: 3000,
      });

      return { success: true, message: `${modalityLabel}: Merging cluster ${oldKey} with cluster ${targetClusterId} under name "${newName}". The clusters will share the same color and be treated as one in all analyses.` };
    }

    // Normal rename (no merge)
    setActiveLabelMap(prev => ({
      ...prev,
      [oldKey]: newName,
    }));

    showToast({
      message: `${modalityLabel}: Renamed cluster ${oldKey} to "${newName}"`,
      intent: 'success',
      timeout: 2000,
    });

    return { success: true, message: `${modalityLabel}: Cluster ${oldKey} has been renamed to "${newName}". All visualizations will now use this new label.` };
  };

  const handleRenameRegion = (command) => {
    const { oldLabel, newLabel } = command.params || {};

    if (!oldLabel || !newLabel) {
      return { error: 'Please specify both the region to rename and the new name. Example: **rename region 6 to Pod**' };
    }

    if (!regionPlot) {
      return {
        error: 'No region segmentation data available. Please run BANKSY region segmentation first.\n\n' +
          'You can say: **"segment regions"** or **"run BANKSY"** to get started.',
      };
    }

    const oldKey = String(oldLabel).trim();
    const newName = String(newLabel).trim();

    if (!newName) {
      return { error: 'New region name cannot be empty.' };
    }

    setRegionLabelMap(prev => ({
      ...prev,
      [oldKey]: newName,
    }));

    showToast({
      message: `Renamed region ${oldKey} to "${newName}"`,
      intent: 'success',
      timeout: 2000,
    });

    return { success: true, message: `Region ${oldKey} has been renamed to "${newName}". All region visualizations will now use this new label.` };
  };

  useEffect(() => {
    const loaded = Number.isFinite(dataInfo?.cells) && Number.isFinite(dataInfo?.genes);
    if (!loaded || !worker || !dataPath || autoClusterIssued) {
      return;
    }
    if (dataInfo?.modality === 'integration' || dataInfo?.modality === 'atac-integration' || dataInfo?.modality === 'xenium-integration' || dataInfo?.modality === 'visium-hd-integration' || dataInfo?.modality === 'merfish-integration') {
      return;
    }

    const command = {
      action: 'cluster_and_visualize',
      params: { method: 'umap' },
    };

    worker.postMessage({
      type: 'RUN_ANALYSIS',
      command,
      dataPath,
    });

    setAutoClusterIssued(true);
    showToast({
      message: 'Running clustering and UMAP automatically...',
      intent: 'primary',
      timeout: 2500,
    });
  }, [autoClusterIssued, dataInfo, worker, dataPath, showToast]);

  return (
    <div className="app">
      <div className="app-header">
        <h1>
          <CellPilotLogo size={28} /> CellPilot
          <span className="subtitle">
            AI-Powered Single-Cell and Spatial Analysis · Developed by{' '}
            <a 
              className="subtitle-link" 
              href="https://humphreyslab.com/" 
              target="_blank" 
              rel="noreferrer"
            >
              Humphreys Lab
            </a>
          </span>
        </h1>
        <div className="app-header-links">
          <Tooltip content="Capture high-res screenshot" position={Position.BOTTOM}>
            <button
              className="app-header-icon-link"
              aria-label="Screenshot"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              onClick={async (e) => {
                if (!window.electron?.captureScreenshot) {
                  showToast({ message: 'Screenshot only available in Electron', intent: 'warning' });
                  return;
                }
                // Dismiss tooltip and any toasts before capture
                e.currentTarget.blur();
                toasterRef.current?.clear();
                // Wait for tooltip/toast to disappear
                await new Promise(r => setTimeout(r, 300));
                const result = await window.electron.captureScreenshot();
                if (result.success) {
                  showToast({ message: `Saved ${result.width}×${result.height} screenshot`, intent: 'success', timeout: 3000 });
                } else if (result.error !== 'Save cancelled') {
                  showToast({ message: `Screenshot failed: ${result.error}`, intent: 'danger' });
                }
              }}
            >
              <Icon icon="camera" size={22} color="white" />
            </button>
          </Tooltip>
          <Tooltip content={isRecording ? 'Stop recording' : 'Record screen'} position={Position.BOTTOM}>
            <button
              className="app-header-icon-link"
              aria-label="Record"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              onClick={async () => {
                if (isRecording) {
                  mediaRecorderRef.current?.stop();
                } else {
                  try {
                    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
                    recordedChunksRef.current = [];
                    // Prefer MP4/H.264 (opens natively on macOS), fall back to WebM
                    const mp4Mime = 'video/mp4;codecs=avc1';
                    const mimeType = MediaRecorder.isTypeSupported(mp4Mime) ? mp4Mime : 'video/webm;codecs=vp9';
                    const fileExt = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
                    const recorder = new MediaRecorder(stream, { mimeType });
                    recorder.ondataavailable = (e) => {
                      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
                    };
                    recorder.onstop = async () => {
                      stream.getTracks().forEach(t => t.stop());
                      setIsRecording(false);
                      const blob = new Blob(recordedChunksRef.current, { type: mimeType });
                      const arrayBuffer = await blob.arrayBuffer();
                      if (window.electron?.saveRecording) {
                        const result = await window.electron.saveRecording(arrayBuffer, fileExt);
                        if (result.success) {
                          showToast({ message: 'Recording saved', intent: 'success', timeout: 3000 });
                        } else if (result.error !== 'Save cancelled') {
                          showToast({ message: `Recording failed: ${result.error}`, intent: 'danger' });
                        }
                      }
                    };
                    // Also stop recording if the user ends the stream via OS controls
                    stream.getVideoTracks()[0].onended = () => mediaRecorderRef.current?.stop();
                    recorder.start();
                    mediaRecorderRef.current = recorder;
                    setIsRecording(true);
                    showToast({ message: 'Recording started', intent: 'primary', timeout: 2000 });
                  } catch (err) {
                    // Ignore user-cancelled or permission-denied, main process already showed a dialog
                    if (err.name !== 'AbortError' && err.name !== 'NotAllowedError' && !err.message?.includes('no video stream')) {
                      showToast({ message: `Recording error: ${err.message}`, intent: 'danger' });
                    }
                  }
                }
              }}
            >
              {isRecording ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22 }}>
                  <span style={{ width: 14, height: 14, background: '#ff4444', borderRadius: 2, display: 'block', animation: 'recording-blink 1s step-start infinite' }} />
                </span>
              ) : (
                <Icon icon="mobile-video" size={22} color="white" />
              )}
            </button>
          </Tooltip>
          <Tooltip content="Tutorial" position={Position.BOTTOM}>
            <a
              href="https://cellpilot.humphreyslab.com"
              target="_blank"
              rel="noreferrer"
              className="app-header-icon-link"
              aria-label="Tutorial"
            >
              <Icon icon="learning" size={22} color="white" />
            </a>
          </Tooltip>
          <Tooltip content="GitHub" position={Position.BOTTOM}>
            <a
              href="https://github.com/TheHumphreysLab/CellPilot"
              target="_blank"
              rel="noreferrer"
              className="app-header-icon-link"
              aria-label="GitHub"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
            </a>
          </Tooltip>
          <Tooltip content="X (Twitter)" position={Position.BOTTOM}>
            <a
              href="https://x.com/HumphreysLab"
              target="_blank"
              rel="noreferrer"
              className="app-header-icon-link"
              aria-label="X (Twitter)"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          </Tooltip>
        </div>
      </div>

      <div className="main-content" ref={mainContentRef}>
        <div
          className="visualization-panel"
          style={{ flex: `${layout.topHeight} 1 0%` }}
        >
          <div className="visualization-row" ref={visualRowRef}>
            {(dataInfo?.modality === 'integration' || dataInfo?.modality === 'atac-integration' || dataInfo?.modality === 'xenium-integration' || dataInfo?.modality === 'visium-hd-integration' || dataInfo?.modality === 'merfish-integration') && (dataInfo.datasetNames?.length === 2 || dataInfo.datasetNames?.length === 3) ? (
              (() => {
                // For integrated scRNA-seq or scATAC-seq (2–3 samples), show one UMAP per sample.
                // Gene expression uses a shared color scale across all per-sample views:
                // 1. Find the most recent RNA gene_expression artifact.
                // 2. Compute its global min/max expression.
                // 3. Pass per-sample geneExpression objects with:
                // expression subset for that sample's cells,
                // shared globalMinExp/globalMaxExp so UmapDeckView uses a common legend.
                const latestGeneExpr = (() => {
                  if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
                  const isAtacInteg = dataInfo?.modality === 'atac-integration';
                  const rnaArtifacts = artifacts.filter((a) => a.type === 'gene_expression' && (isAtacInteg ? a.isAtac : !a.isAtac));
                  if (!rnaArtifacts.length) return null;
                  return rnaArtifacts[rnaArtifacts.length - 1];
                })();

                let globalMinExp = null;
                let globalMaxExp = null;
                if (latestGeneExpr && latestGeneExpr.expression && latestGeneExpr.expression.length > 0) {
                  const expr = latestGeneExpr.expression;
                  let minVal = Infinity;
                  let maxVal = -Infinity;
                  for (let i = 0; i < expr.length; i++) {
                    const v = expr[i];
                    if (!Number.isFinite(v)) continue;
                    if (v < minVal) minVal = v;
                    if (v > maxVal) maxVal = v;
                  }
                  if (Number.isFinite(minVal) && Number.isFinite(maxVal)) {
                    globalMinExp = minVal;
                    globalMaxExp = maxVal;
                  }
                }

                // atac-integration: normalize so every view has the same set of clusters (union + empty tracks for missing)
                const normalizedViewCoverageByCluster = (() => {
                  const vc = latestGeneExpr?.viewCoverageByCluster;
                  if (!vc || typeof vc !== 'object' || Array.isArray(vc)) return vc ?? {};
                  const allIds = new Set();
                  for (const viewName of Object.keys(vc)) {
                    const cov = vc[viewName];
                    if (!Array.isArray(cov)) continue;
                    for (const c of cov) allIds.add(c.clusterId);
                  }
                  const sorted = Array.from(allIds).sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
                  let templateSignal = null;
                  for (const viewName of Object.keys(vc)) {
                    const cov = vc[viewName];
                    if (Array.isArray(cov) && cov.length > 0 && cov[0].signal?.length) {
                      templateSignal = cov[0].signal.map((p) => ({ start: p.start, end: p.end, value: 0 }));
                      break;
                    }
                  }
                  if (!templateSignal) return vc;
                  const out = {};
                  for (const viewName of Object.keys(vc)) {
                    const cov = vc[viewName];
                    if (!Array.isArray(cov)) { out[viewName] = cov; continue; }
                    const byId = new Map();
                    for (const c of cov) byId.set(c.clusterId, c);
                    const filled = [];
                    for (const cid of sorted) {
                      if (byId.has(cid)) filled.push(byId.get(cid));
                      else filled.push({ clusterId: cid, label: String(cid), cellCount: 0, signal: templateSignal.map((p) => ({ ...p, value: 0 })) });
                    }
                    out[viewName] = filled;
                  }
                  return out;
                })();

                // atac-integration: shared y-axis max across all sample coverage plots (0 to same max for comparison)
                // Problem: tiny clusters have inflated Signac-normalized signals because the formula
                // raw_sum / (meanDepth * nCells) blows up when nCells is very small, setting yMax too high
                // and making all other (abundant) clusters appear flat.
                // Fix: compute per-cluster peak maximum, exclude clusters below a cell-count threshold,
                // then use the max of the qualifying clusters. Fall back to all clusters if none qualify.
                const viewCoverageGlobalYMax = (() => {
                  const vc = normalizedViewCoverageByCluster && Object.keys(normalizedViewCoverageByCluster).length > 0 ? normalizedViewCoverageByCluster : latestGeneExpr?.viewCoverageByCluster;
                  if (!vc || typeof vc !== 'object' || Array.isArray(vc)) return null;
                  const MIN_CELLS_FOR_YMAX = 10;
                  // Collect the peak-maximum signal for each (sample × cluster) entry
                  let qualifiedMax = 0;   // max among clusters with enough cells
                  let fallbackMax = 0;    // max among all clusters (used only if no cluster qualifies)
                  let anyQualified = false;
                  for (const viewName of Object.keys(vc)) {
                    const cov = vc[viewName];
                    if (!Array.isArray(cov)) continue;
                    for (const c of cov) {
                      const cellCount = c.cellCount || 0;
                      let clusterPeakMax = 0;
                      for (const s of c.signal || []) {
                        const v = Number(s.value) || 0;
                        if (v > clusterPeakMax) clusterPeakMax = v;
                      }
                      if (clusterPeakMax > fallbackMax) fallbackMax = clusterPeakMax;
                      if (cellCount >= MIN_CELLS_FOR_YMAX) {
                        anyQualified = true;
                        if (clusterPeakMax > qualifiedMax) qualifiedMax = clusterPeakMax;
                      }
                    }
                  }
                  const ymax = anyQualified ? qualifiedMax : fallbackMax;
                  return ymax > 0 ? parseFloat(ymax.toPrecision(2)) : null;
                })();

                // When active plot is integration violin or dotplot, show per-view violin/dotplot in each card
                const integrationViolinOrDotplotArtifact = (() => {
                  if (activePlot?.source !== 'artifact') return null;
                  const art = artifacts.find((a) => a.id === activePlot.artifactId);
                  if (!art || (art.type !== 'gene_violin' && art.type !== 'gene_dotplot') || !art.integrationViews) return null;
                  return art;
                })();

                // When DEG (or markers) result is showing, upper panel shows only the Analysis View (DEG table + volcano), not sample UMAPs.
                const showAnalysisResultOnly = activePlot?.source === 'analysis' &&
                  (activePlot?.data?.type === 'deg_between_samples' || activePlot?.data?.type === 'markers' || activePlot?.data?.type === 'cell_fraction' || activePlot?.data?.type === 'region_composition' || activePlot?.data?.type === 'spatial_cell_interaction' || activePlot?.data?.type === 'cluster_annotation');

                if (showAnalysisResultOnly) {
                  return (
                    <div
                      className="visualization-card interaction-card"
                      style={{ flex: '1 1 100%', minWidth: 0 }}
                    >
                      <div className="visualization-card-header">
                        <Icon icon="chart" size={18} />
                        <span>Analysis View</span>
                      </div>
                      <div className="visualization-card-body">
                        <PlotView
                          activePlot={activePlot}
                          artifacts={artifacts}
                          dataInfo={dataInfo}
                          clusterColorOverrides={clusterColorOverrides}
                          clusterLabelMap={clusterLabelMap}
                          viewModality="integration"
                        />
                      </div>
                    </div>
                  );
                }

                // Xenium integration: per-sample spatial views + integrated UMAP
                if (dataInfo?.modality === 'xenium-integration') {
                  // Whether gene expression should be shown (user plotted a gene and hasn't switched back to cluster-only)
                  const xeniumShowGeneExpr = latestGeneExpr && !integrationViolinOrDotplotArtifact && activePlot != null && !integrationShowClustersOnly;
                  // Full-dataset gene expression for the integrated UMAP
                  const xeniumIntegratedGeneExpression = xeniumShowGeneExpr ? {
                    source: 'analysis',
                    data: {
                      type: 'gene_expression',
                      coordinates: clusterPlot?.data?.coordinates ?? [],
                      expression: latestGeneExpr.expression,
                      geneName: latestGeneExpr.geneName,
                      colorMap: latestGeneExpr.colorMap,
                      globalMinExp,
                      globalMaxExp,
                    },
                  } : null;
                  return (
                    <>
                      {(dataInfo.datasetNames || []).map((viewName) => {
                        const indices = clusterPlot?.data?.integrationViews?.[viewName]?.indices;
                        const nClusters = clusterPlot?.data?.nClusters ?? 0;
                        const sampleSpatial = dataInfo.perSampleSpatial?.[viewName];
                        // Build per-sample spatial dataInfo for SpatialPlotView
                        const sampleDataInfo = sampleSpatial ? {
                          ...dataInfo,
                          modality: 'spatial',
                          format: '10X Xenium',
                          spatialCoordinates: sampleSpatial.spatialCoordinates,
                          spatialExtent: sampleSpatial.spatialExtent,
                          spatialIndex: sampleSpatial.spatialIndex,
                          spatialReady: !!(sampleSpatial.spatialIndex),
                          spatialScaleFactor: 0.2125,
                          histologyPrealigned: false,
                          metadata: sampleSpatial.metadata,
                        } : null;
                        // Per-sample cluster plot for spatial view: map cluster IDs to spatial coords
                        const sampleClusterPlot = sampleDataInfo && clusterPlot?.data && Array.isArray(indices) ? {
                          source: 'analysis',
                          data: {
                            type: 'umap',
                            coordinates: sampleSpatial.spatialCoordinates,
                            clusters: indices.map((i) => clusterPlot.data.clusters[i]),
                            nClusters,
                            nCells: indices.length,
                            clusterColorDomain: nClusters > 0 ? Array.from({ length: nClusters }, (_, i) => i) : undefined,
                          },
                        } : null;
                        // Per-sample gene expression activePlot: subset full expression by sample indices
                        const sampleGeneExprActivePlot = xeniumShowGeneExpr && sampleDataInfo && Array.isArray(indices) ? {
                          source: 'analysis',
                          data: {
                            type: 'gene_expression',
                            expression: indices.map((i) => latestGeneExpr.expression[i] ?? 0),
                            geneName: latestGeneExpr.geneName,
                            colorMap: latestGeneExpr.colorMap,
                          },
                        } : null;

                        // When a violin/dotplot is active, show PlotView per sample instead of SpatialPlotView
                        const xeniumSampleActivePlot = integrationViolinOrDotplotArtifact
                          ? { source: 'artifact', artifactId: integrationViolinOrDotplotArtifact.id, viewName }
                          : null;

                        return (
                          <div
                            key={viewName}
                            className="visualization-card interaction-card"
                            style={{ flex: 1, minWidth: 0 }}
                          >
                            <div className="visualization-card-header">
                              <Icon icon={xeniumSampleActivePlot ? 'timeline-line-chart' : 'map'} size={18} />
                              <span>{viewName} Xenium{Array.isArray(indices) ? (
                                <> ({<span style={{ color: 'darkgreen', fontWeight: 600 }}>{indices.length.toLocaleString()}</span>} cells)</>
                              ) : ''}</span>
                            </div>
                            <div className="visualization-card-body">
                              {xeniumSampleActivePlot ? (
                                <PlotView
                                  activePlot={xeniumSampleActivePlot}
                                  geneExpression={null}
                                  artifacts={artifacts}
                                  dataInfo={dataInfo}
                                  clusterColorOverrides={clusterColorOverrides}
                                  clusterLabelMap={clusterLabelMap}
                                  viewModality="integration"
                                  legendHighlightSelection={legendHighlightSelection?.modality === 'integration' ? legendHighlightSelection : null}
                                  onLegendClusterClick={(_, clusterId, colorRgba, ctrlKey) => handleLegendClusterClick('integration', clusterId, colorRgba, ctrlKey)}
                                  onClearLegendHighlight={clearLegendHighlight}
                                />
                              ) : sampleDataInfo ? (
                                <SpatialPlotView
                                  activePlot={sampleGeneExprActivePlot}
                                  clusterPlot={sampleClusterPlot}
                                  artifacts={artifacts}
                                  dataInfo={sampleDataInfo}
                                  selectedClusters={selectedClusters}
                                  clusterColorOverrides={clusterColorOverrides}
                                  clusterLabelMap={clusterLabelMap}
                                  legendHighlightSelection={legendHighlightSelection?.modality === 'integration' ? legendHighlightSelection : null}
                                  maxSamplePoints={400000}
                                  cellIndexMap={indices}
                                  onSpatialRegionSelected={setSpatialSelection}
                                />
                              ) : (
                                <div className="plot-placeholder">
                                  <Icon icon="map" size={48} color="#ccc" />
                                  <p>Loading spatial data for {viewName}...</p>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {/* Integrated UMAP / violin / dotplot card */}
                      <div
                        className="visualization-card interaction-card"
                        style={{ flex: 1, minWidth: 0 }}
                      >
                        <div className="visualization-card-header">
                          <Icon icon="timeline-line-chart" size={18} />
                          <span>Integrated UMAP{clusterPlot?.data?.nCells ? (
                            <> ({<span style={{ color: 'darkgreen', fontWeight: 600 }}>{clusterPlot.data.nCells.toLocaleString()}</span>} cells)</>
                          ) : ''}</span>
                        </div>
                        <div className="visualization-card-body">
                          <PlotView
                            activePlot={integrationViolinOrDotplotArtifact
                              ? { source: 'artifact', artifactId: integrationViolinOrDotplotArtifact.id }
                              : clusterPlot}
                            geneExpression={integrationViolinOrDotplotArtifact ? null : xeniumIntegratedGeneExpression}
                            artifacts={artifacts}
                            dataInfo={dataInfo}
                            clusterColorOverrides={clusterColorOverrides}
                            clusterLabelMap={clusterLabelMap}
                            viewModality="integration"
                            legendHighlightSelection={legendHighlightSelection?.modality === 'integration' ? legendHighlightSelection : null}
                            onLegendClusterClick={(_, clusterId, colorRgba, ctrlKey) => handleLegendClusterClick('integration', clusterId, colorRgba, ctrlKey)}
                            onClearLegendHighlight={clearLegendHighlight}
                            onChangeClusterColor={(clusterId, color) => {
                              setClusterColorOverrides((prev) => {
                                const key = String(clusterId);
                                const next = { ...prev };
                                if (!color) {
                                  delete next[key];
                                } else {
                                  next[key] = color;
                                }
                                return next;
                              });
                            }}
                          />
                        </div>
                      </div>
                    </>
                  );
                }

                // MERFISH integration: per-sample spatial views + integrated UMAP
                if (dataInfo?.modality === 'merfish-integration') {
                  const merfishShowGeneExpr = latestGeneExpr && !integrationViolinOrDotplotArtifact && activePlot != null && !integrationShowClustersOnly;
                  const merfishIntegratedGeneExpression = merfishShowGeneExpr ? {
                    source: 'analysis',
                    data: {
                      type: 'gene_expression',
                      coordinates: clusterPlot?.data?.coordinates ?? [],
                      expression: latestGeneExpr.expression,
                      geneName: latestGeneExpr.geneName,
                      colorMap: latestGeneExpr.colorMap,
                      globalMinExp,
                      globalMaxExp,
                    },
                  } : null;
                  return (
                    <>
                      {(dataInfo.datasetNames || []).map((viewName) => {
                        const indices = clusterPlot?.data?.integrationViews?.[viewName]?.indices;
                        const nClusters = clusterPlot?.data?.nClusters ?? 0;
                        const sampleSpatial = dataInfo.perSampleSpatial?.[viewName];
                        const sampleDataInfo = sampleSpatial ? {
                          ...dataInfo,
                          modality: 'spatial',
                          format: 'MERFISH',
                          spatialCoordinates: sampleSpatial.spatialCoordinates,
                          spatialExtent: sampleSpatial.spatialExtent,
                          spatialIndex: sampleSpatial.spatialIndex,
                          spatialReady: !!(sampleSpatial.spatialIndex),
                          spatialScaleFactor: 1.0,
                          histologyPrealigned: false,
                          metadata: sampleSpatial.metadata,
                        } : null;
                        const sampleClusterPlot = sampleDataInfo && clusterPlot?.data && Array.isArray(indices) ? {
                          source: 'analysis',
                          data: {
                            type: 'umap',
                            coordinates: sampleSpatial.spatialCoordinates,
                            clusters: indices.map((i) => clusterPlot.data.clusters[i]),
                            nClusters,
                            nCells: indices.length,
                            clusterColorDomain: nClusters > 0 ? Array.from({ length: nClusters }, (_, i) => i) : undefined,
                          },
                        } : null;
                        const sampleGeneExprActivePlot = merfishShowGeneExpr && sampleDataInfo && Array.isArray(indices) ? {
                          source: 'analysis',
                          data: {
                            type: 'gene_expression',
                            expression: indices.map((i) => latestGeneExpr.expression[i] ?? 0),
                            geneName: latestGeneExpr.geneName,
                            colorMap: latestGeneExpr.colorMap,
                          },
                        } : null;
                        const merfishSampleActivePlot = integrationViolinOrDotplotArtifact
                          ? { source: 'artifact', artifactId: integrationViolinOrDotplotArtifact.id, viewName }
                          : null;
                        return (
                          <div
                            key={viewName}
                            className="visualization-card interaction-card"
                            style={{ flex: 1, minWidth: 0 }}
                          >
                            <div className="visualization-card-header">
                              <Icon icon={merfishSampleActivePlot ? 'timeline-line-chart' : 'map'} size={18} />
                              <span>{viewName} MERFISH{Array.isArray(indices) ? (
                                <> ({<span style={{ color: 'darkgreen', fontWeight: 600 }}>{indices.length.toLocaleString()}</span>} cells)</>
                              ) : ''}</span>
                            </div>
                            <div className="visualization-card-body">
                              {merfishSampleActivePlot ? (
                                <PlotView
                                  activePlot={merfishSampleActivePlot}
                                  geneExpression={null}
                                  artifacts={artifacts}
                                  dataInfo={dataInfo}
                                  clusterColorOverrides={clusterColorOverrides}
                                  clusterLabelMap={clusterLabelMap}
                                  viewModality="merfish-integration"
                                  legendHighlightSelection={legendHighlightSelection?.modality === 'merfish-integration' ? legendHighlightSelection : null}
                                  onLegendClusterClick={(_, clusterId, colorRgba, ctrlKey) => handleLegendClusterClick('merfish-integration', clusterId, colorRgba, ctrlKey)}
                                  onClearLegendHighlight={clearLegendHighlight}
                                />
                              ) : sampleDataInfo ? (
                                <SpatialPlotView
                                  activePlot={sampleGeneExprActivePlot}
                                  clusterPlot={sampleClusterPlot}
                                  artifacts={artifacts}
                                  dataInfo={sampleDataInfo}
                                  selectedClusters={selectedClusters}
                                  clusterColorOverrides={clusterColorOverrides}
                                  clusterLabelMap={clusterLabelMap}
                                  legendHighlightSelection={legendHighlightSelection?.modality === 'merfish-integration' ? legendHighlightSelection : null}
                                  maxSamplePoints={400000}
                                  cellIndexMap={indices}
                                  onSpatialRegionSelected={setSpatialSelection}
                                />
                              ) : (
                                <div className="plot-placeholder">
                                  <Icon icon="map" size={48} color="#ccc" />
                                  <p>Loading spatial data for {viewName}...</p>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {/* Integrated UMAP / violin / dotplot card */}
                      <div
                        className="visualization-card interaction-card"
                        style={{ flex: 1, minWidth: 0 }}
                      >
                        <div className="visualization-card-header">
                          <Icon icon="timeline-line-chart" size={18} />
                          <span>Integrated UMAP{clusterPlot?.data?.nCells ? (
                            <> ({<span style={{ color: 'darkgreen', fontWeight: 600 }}>{clusterPlot.data.nCells.toLocaleString()}</span>} cells)</>
                          ) : ''}</span>
                        </div>
                        <div className="visualization-card-body">
                          <PlotView
                            activePlot={integrationViolinOrDotplotArtifact
                              ? { source: 'artifact', artifactId: integrationViolinOrDotplotArtifact.id }
                              : clusterPlot}
                            geneExpression={integrationViolinOrDotplotArtifact ? null : merfishIntegratedGeneExpression}
                            artifacts={artifacts}
                            dataInfo={dataInfo}
                            clusterColorOverrides={clusterColorOverrides}
                            clusterLabelMap={clusterLabelMap}
                            viewModality="merfish-integration"
                            legendHighlightSelection={legendHighlightSelection?.modality === 'merfish-integration' ? legendHighlightSelection : null}
                            onLegendClusterClick={(_, clusterId, colorRgba, ctrlKey) => handleLegendClusterClick('merfish-integration', clusterId, colorRgba, ctrlKey)}
                            onClearLegendHighlight={clearLegendHighlight}
                            onChangeClusterColor={(clusterId, color) => {
                              setClusterColorOverrides((prev) => {
                                const key = String(clusterId);
                                const next = { ...prev };
                                if (!color) {
                                  delete next[key];
                                } else {
                                  next[key] = color;
                                }
                                return next;
                              });
                            }}
                          />
                        </div>
                      </div>
                    </>
                  );
                }

                // Visium HD integration: per-sample spatial views + integrated UMAP
                if (dataInfo?.modality === 'visium-hd-integration') {
                  const hdShowGeneExpr = latestGeneExpr && !integrationViolinOrDotplotArtifact && activePlot != null && !integrationShowClustersOnly;
                  const hdIntegratedGeneExpression = hdShowGeneExpr ? {
                    source: 'analysis',
                    data: {
                      type: 'gene_expression',
                      coordinates: clusterPlot?.data?.coordinates ?? [],
                      expression: latestGeneExpr.expression,
                      geneName: latestGeneExpr.geneName,
                      colorMap: latestGeneExpr.colorMap,
                      globalMinExp,
                      globalMaxExp,
                    },
                  } : null;
                  return (
                    <>
                      {(dataInfo.datasetNames || []).map((viewName) => {
                        const indices = clusterPlot?.data?.integrationViews?.[viewName]?.indices;
                        const nClusters = clusterPlot?.data?.nClusters ?? 0;
                        const sampleSpatial = dataInfo.perSampleSpatial?.[viewName];
                        const sampleDataInfo = sampleSpatial ? {
                          ...dataInfo,
                          modality: 'spatial',
                          format: '10X Visium HD',
                          spatialCoordinates: sampleSpatial.spatialCoordinates,
                          spatialExtent: sampleSpatial.spatialExtent,
                          spatialIndex: sampleSpatial.spatialIndex,
                          spatialReady: !!(sampleSpatial.spatialIndex),
                          spatialScaleFactor: 1.0,
                          histologyPrealigned: true,
                          metadata: sampleSpatial.metadata,
                        } : null;
                        const sampleClusterPlot = sampleDataInfo && clusterPlot?.data && Array.isArray(indices) ? {
                          source: 'analysis',
                          data: {
                            type: 'umap',
                            coordinates: sampleSpatial.spatialCoordinates,
                            clusters: indices.map((i) => clusterPlot.data.clusters[i]),
                            nClusters,
                            nCells: indices.length,
                            clusterColorDomain: nClusters > 0 ? Array.from({ length: nClusters }, (_, i) => i) : undefined,
                          },
                        } : null;
                        const sampleGeneExprActivePlot = hdShowGeneExpr && sampleDataInfo && Array.isArray(indices) ? {
                          source: 'analysis',
                          data: {
                            type: 'gene_expression',
                            expression: indices.map((i) => latestGeneExpr.expression[i] ?? 0),
                            geneName: latestGeneExpr.geneName,
                            colorMap: latestGeneExpr.colorMap,
                          },
                        } : null;
                        const hdSampleActivePlot = integrationViolinOrDotplotArtifact
                          ? { source: 'artifact', artifactId: integrationViolinOrDotplotArtifact.id, viewName }
                          : null;
                        return (
                          <div
                            key={viewName}
                            className="visualization-card interaction-card"
                            style={{ flex: 1, minWidth: 0 }}
                          >
                            <div className="visualization-card-header">
                              <Icon icon={hdSampleActivePlot ? 'timeline-line-chart' : 'map'} size={18} />
                              <span>{viewName} Visium HD{Array.isArray(indices) ? (
                                <> ({<span style={{ color: 'darkgreen', fontWeight: 600 }}>{indices.length.toLocaleString()}</span>} cells)</>
                              ) : ''}</span>
                            </div>
                            <div className="visualization-card-body">
                              {hdSampleActivePlot ? (
                                <PlotView
                                  activePlot={hdSampleActivePlot}
                                  geneExpression={null}
                                  artifacts={artifacts}
                                  dataInfo={dataInfo}
                                  clusterColorOverrides={clusterColorOverrides}
                                  clusterLabelMap={clusterLabelMap}
                                  viewModality="visium-hd-integration"
                                  legendHighlightSelection={legendHighlightSelection?.modality === 'visium-hd-integration' ? legendHighlightSelection : null}
                                  onLegendClusterClick={(_, clusterId, colorRgba, ctrlKey) => handleLegendClusterClick('visium-hd-integration', clusterId, colorRgba, ctrlKey)}
                                  onClearLegendHighlight={clearLegendHighlight}
                                />
                              ) : sampleDataInfo ? (
                                <SpatialPlotView
                                  activePlot={sampleGeneExprActivePlot}
                                  clusterPlot={sampleClusterPlot}
                                  artifacts={artifacts}
                                  dataInfo={sampleDataInfo}
                                  selectedClusters={selectedClusters}
                                  clusterColorOverrides={clusterColorOverrides}
                                  clusterLabelMap={clusterLabelMap}
                                  legendHighlightSelection={legendHighlightSelection?.modality === 'visium-hd-integration' ? legendHighlightSelection : null}
                                  maxSamplePoints={400000}
                                  cellIndexMap={indices}
                                  onSpatialRegionSelected={setSpatialSelection}
                                />
                              ) : (
                                <div className="plot-placeholder">
                                  <Icon icon="map" size={48} color="#ccc" />
                                  <p>Loading spatial data for {viewName}...</p>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {/* Integrated UMAP / violin / dotplot card */}
                      <div
                        className="visualization-card interaction-card"
                        style={{ flex: 1, minWidth: 0 }}
                      >
                        <div className="visualization-card-header">
                          <Icon icon="timeline-line-chart" size={18} />
                          <span>Integrated UMAP{clusterPlot?.data?.nCells ? (
                            <> ({<span style={{ color: 'darkgreen', fontWeight: 600 }}>{clusterPlot.data.nCells.toLocaleString()}</span>} cells)</>
                          ) : ''}</span>
                        </div>
                        <div className="visualization-card-body">
                          <PlotView
                            activePlot={integrationViolinOrDotplotArtifact
                              ? { source: 'artifact', artifactId: integrationViolinOrDotplotArtifact.id }
                              : clusterPlot}
                            geneExpression={integrationViolinOrDotplotArtifact ? null : hdIntegratedGeneExpression}
                            artifacts={artifacts}
                            dataInfo={dataInfo}
                            clusterColorOverrides={clusterColorOverrides}
                            clusterLabelMap={clusterLabelMap}
                            viewModality="visium-hd-integration"
                            legendHighlightSelection={legendHighlightSelection?.modality === 'visium-hd-integration' ? legendHighlightSelection : null}
                            onLegendClusterClick={(_, clusterId, colorRgba, ctrlKey) => handleLegendClusterClick('visium-hd-integration', clusterId, colorRgba, ctrlKey)}
                            onClearLegendHighlight={clearLegendHighlight}
                            onChangeClusterColor={(clusterId, color) => {
                              setClusterColorOverrides((prev) => {
                                const key = String(clusterId);
                                const next = { ...prev };
                                if (!color) {
                                  delete next[key];
                                } else {
                                  next[key] = color;
                                }
                                return next;
                              });
                            }}
                          />
                        </div>
                      </div>
                    </>
                  );
                }

                return (
                  <>
                    {(dataInfo.datasetNames || []).map((viewName, coverageScrollIndex) => {
                      const indices = clusterPlot?.data?.integrationViews?.[viewName]?.indices;
                      const nClusters = clusterPlot?.data?.nClusters ?? 0;
                      const subsetPlot = clusterPlot?.data && Array.isArray(indices) ? {
                        source: 'analysis',
                        data: {
                          type: 'umap',
                          coordinates: indices.map((i) => clusterPlot.data.coordinates[i]),
                          clusters: indices.map((i) => clusterPlot.data.clusters[i]),
                          nClusters,
                          nCells: indices.length,
                          clusterColorDomain: nClusters > 0 ? Array.from({ length: nClusters }, (_, i) => i) : undefined,
                        },
                      } : clusterPlot;

                      const viewGeneExpression = (() => {
                        if (!latestGeneExpr || !Array.isArray(indices) || !latestGeneExpr.expression) {
                          return null;
                        }
                        const fullExpr = latestGeneExpr.expression;
                        const subsetExpr = indices.map((i) => fullExpr[i] ?? 0);
                        const geneName = latestGeneExpr.geneName;
                        const colorMap = latestGeneExpr.colorMap;
                        return {
                          source: 'analysis',
                          data: {
                            type: 'gene_expression',
                            coordinates: indices.map((i) => clusterPlot.data.coordinates[i]),
                            expression: subsetExpr,
                            geneName,
                            colorMap,
                            globalMinExp,
                            globalMaxExp,
                            // Share the percentile-based color range across all per-sample views
                            // so expressing cells use the same scale in Sham and Day14 panels.
                            expressionRange: latestGeneExpr.expressionRange ?? null,
                          },
                        };
                      })();

                      // atac-integration: check if the active gene artifact has showPeakViewAsPrimary
                      // ("coverage plot [gene]" → show only peak coverage, no gene activity UMAP)
                      const isPeakViewOnly = (() => {
                        if (dataInfo?.modality !== 'atac-integration') return false;
                        if (!activePlot || activePlot.source !== 'artifact') return false;
                        const art = artifacts.find((a) => a.id === activePlot.artifactId);
                        return !!(art?.showPeakViewAsPrimary);
                      })();

                      const activePlotForView = integrationViolinOrDotplotArtifact
                        ? { source: 'artifact', artifactId: integrationViolinOrDotplotArtifact.id, viewName }
                        : isPeakViewOnly ? subsetPlot   // show cluster UMAP only (no gene overlay)
                        : subsetPlot;
                      // When activePlot is null we're showing UMAP-by-cluster only (e.g. after "plot umap"); don't overlay last gene
                      // When isPeakViewOnly we also skip gene overlay (coverage-only mode like single-sample Peak View)
                      const geneExpressionForView = (activePlot == null || integrationViolinOrDotplotArtifact || isPeakViewOnly) ? null : viewGeneExpression;

                      return (
                        <div
                          key={viewName}
                          className="visualization-card interaction-card"
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          <div className="visualization-card-header">
                            <Icon icon="timeline-line-chart" size={18} />
                            <span>{isPeakViewOnly ? `${viewName} Peak View` : `${viewName} view`}{Array.isArray(indices) ? (
                              <> ({<span style={{ color: 'darkgreen', fontWeight: 600 }}>{indices.length.toLocaleString()}</span>} cells)</>
                            ) : ''}</span>
                          </div>
                          <div className="visualization-card-body">
                            {isPeakViewOnly ? (
                              // Peak-view-only mode: show only the coverage plot (same as single-sample scATAC Peak View)
                              (() => {
                                const viewCoverage = normalizedViewCoverageByCluster?.[viewName] ?? latestGeneExpr?.viewCoverageByCluster?.[viewName];
                                const region = latestGeneExpr?.region;
                                if (!viewCoverage || !region) {
                                  const isLoading = region && dataInfo?.modality === 'atac-integration' && !latestGeneExpr?.viewFragmentBased;
                                  return (
                                    <div className="plot-placeholder">
                                      <Icon icon="chart" size={48} color="#ccc" />
                                      <p>{isLoading ? 'Loading peak coverage...' : 'No peak coverage data for this sample.'}</p>
                                    </div>
                                  );
                                }
                                return (
                                  <div
                                    className="peaks-on-gene-scroll-wrapper"
                                    ref={(el) => {
                                      const group = coverageScrollSyncRef.current;
                                      const i = coverageScrollIndex;
                                      if (el) {
                                        group.containers[i] = el;
                                        const handler = () => {
                                          if (group.syncing) return;
                                          group.syncing = true;
                                          const left = el.scrollLeft;
                                          const top = el.scrollTop;
                                          requestAnimationFrame(() => {
                                            for (const k of Object.keys(group.containers)) {
                                              if (Number(k) !== i) {
                                                const other = group.containers[k];
                                                if (other) {
                                                  other.scrollLeft = left;
                                                  other.scrollTop = top;
                                                }
                                              }
                                            }
                                            requestAnimationFrame(() => { group.syncing = false; });
                                          });
                                        };
                                        group.handlers[i] = handler;
                                        el.addEventListener('scroll', handler, { passive: true });
                                      } else {
                                        const elem = group.containers[i];
                                        if (elem && group.handlers[i]) {
                                          elem.removeEventListener('scroll', group.handlers[i]);
                                        }
                                        delete group.containers[i];
                                        delete group.handlers[i];
                                      }
                                    }}
                                  >
                                    <CoveragePlot
                                      region={region}
                                      coverageByCluster={viewCoverage}
                                      peaksOnGene={latestGeneExpr.peaksOnGene || []}
                                      geneName={latestGeneExpr.geneName || ''}
                                      genome={latestGeneExpr.genome}
                                      clusterLabelMap={clusterLabelMap}
                                      clusterColorOverrides={clusterColorOverrides}
                                      globalYMax={viewCoverageGlobalYMax}
                                      sortClustersByAbundance={false}
                                      maxClusters={10000}
                                    />
                                  </div>
                                );
                              })()
                            ) : (
                              <>
                            <PlotView
                              activePlot={activePlotForView}
                              geneExpression={geneExpressionForView}
                              artifacts={artifacts}
                              dataInfo={dataInfo}
                              clusterColorOverrides={clusterColorOverrides}
                              clusterLabelMap={clusterLabelMap}
                              viewModality="integration"
                              legendHighlightSelection={legendHighlightSelection?.modality === 'integration' ? legendHighlightSelection : null}
                              onLegendClusterClick={(_, clusterId, colorRgba, ctrlKey) => handleLegendClusterClick('integration', clusterId, colorRgba, ctrlKey)}
                              onClearLegendHighlight={clearLegendHighlight}
                              onChangeClusterColor={(clusterId, color) => {
                                setClusterColorOverrides((prev) => {
                                  const key = String(clusterId);
                                  const next = { ...prev };
                                  if (!color) { delete next[key]; } else { next[key] = color; }
                                  return next;
                                });
                              }}
                            />
                            {(() => {
                              // atac-integration: show per-sample coverage plot when a gene is active (not when user said "plot umap" only)
                              if (dataInfo?.modality !== 'atac-integration') return null;
                              if (integrationShowClustersOnly) return null;
                              const viewCoverageForPlot = normalizedViewCoverageByCluster?.[viewName] ?? latestGeneExpr?.viewCoverageByCluster?.[viewName];
                              if (!viewCoverageForPlot || !latestGeneExpr.region) return null;
                              return (
                                <div style={{ height: 220, flexShrink: 0 }}>
                                  <CoveragePlot
                                    region={latestGeneExpr.region}
                                    coverageByCluster={viewCoverageForPlot}
                                    peaksOnGene={latestGeneExpr.peaksOnGene || []}
                                    geneName={latestGeneExpr.geneName || ''}
                                    genome={latestGeneExpr.genome}
                                    clusterLabelMap={clusterLabelMap}
                                    clusterColorOverrides={clusterColorOverrides}
                                    globalYMax={viewCoverageGlobalYMax}
                                    sortClustersByAbundance={false}
                                    scrollSyncGroupRef={coverageScrollSyncRef}
                                    scrollSyncIndex={coverageScrollIndex}
                                    maxClusters={10000}
                                  />
                                </div>
                              );
                            })()}
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </>
                );
              })()
            ) : (
            <>
            {/* WNN 3-panel layout: RNA individual | ATAC individual | WNN integrated */}
            {wnnActive && wnnRnaPlot && wnnAtacPlot && dataInfo?.modality === 'multiome' ? (
              <>
                {/* Panel 1: RNA individual clustering */}
                <div className="visualization-card interaction-card" style={{ flex: '1 1 0%', minWidth: 0 }}>
                  <div className="visualization-card-header">
                    <Icon icon="timeline-line-chart" size={18} />
                    <span>{(() => {
                      if (activePlot?.source === 'artifact') {
                        const art = artifacts.find(a => a.id === activePlot.artifactId);
                        if (art?.type === 'gene_expression' && !art.isAtac) return `RNA View, ${art.geneName}`;
                        if (art?.type === 'tf_motif_enrichment') return `TF Prioritization, Cluster ${art.cluster}`;
                        if (art?.type === 'gene_dotplot') return `Dot Plot`;
                      }
                      return 'RNA View';
                    })()}</span>
                  </div>
                  <div className="visualization-card-body">
                    <PlotView
                      activePlot={(() => {
                        // TF motif / dotplot artifacts are RNA-based: show in RNA panel
                        if (activePlot?.source === 'artifact') {
                          const art = artifacts.find(a => a.id === activePlot.artifactId);
                          if (art?.type === 'tf_motif_enrichment' || art?.type === 'gene_dotplot') return activePlot;
                        }
                        return wnnRnaPlot;
                      })()}
                      geneExpression={(() => {
                        // Show RNA gene expression overlay when a gene has been plotted
                        if (activePlot?.source === 'artifact') {
                          const art = artifacts.find(a => a.id === activePlot.artifactId);
                          if (art?.type === 'gene_expression' && !art.isAtac) return activePlot;
                        }
                        return null;
                      })()}
                      artifacts={artifacts}
                      dataInfo={dataInfo}
                      clusterColorOverrides={clusterColorOverrides}
                      clusterLabelMap={clusterLabelMap}
                      onChangeClusterColor={(clusterId, color) => setClusterColorOverrides(prev => {
                        const next = { ...prev };
                        if (!color) { delete next[String(clusterId)]; } else { next[String(clusterId)] = color; }
                        return next;
                      })}
                      viewModality="wnn-rna"
                      onLegendClusterClick={handleWnnLegendClick}
                      onClearLegendHighlight={() => setWnnCrossHighlight(null)}
                      highlightCellMask={wnnHighlightMask}
                    />
                  </div>
                </div>
                <div className="resize-handle vertical-resize-handle visualization-resize-handle" style={{ cursor: 'default' }} />
                {/* Panel 2: ATAC individual clustering */}
                <div className="visualization-card interaction-card" style={{ flex: '1 1 0%', minWidth: 0 }}>
                  <div className="visualization-card-header">
                    <Icon icon="chart" size={18} />
                    <span>{(() => {
                      if (atacActivePlot?.source === 'artifact') {
                        const art = artifacts.find(a => a.id === atacActivePlot.artifactId);
                        if (art?.type === 'gene_expression' && art.isAtac) return `ATAC View, ${art.geneName} activity`;
                        if (art?.type === 'peak_gene_links') return `Links, ${art.gene}`;
                      }
                      return 'ATAC View';
                    })()}</span>
                  </div>
                  <div className="visualization-card-body">
                    <PlotView
                      activePlot={(() => {
                        // Peak-gene links: show in ATAC panel
                        if (atacActivePlot?.source === 'artifact') {
                          const art = artifacts.find(a => a.id === atacActivePlot.artifactId);
                          if (art?.type === 'peak_gene_links') return atacActivePlot;
                        }
                        return wnnAtacPlot;
                      })()}
                      geneExpression={(() => {
                        // Show ATAC gene activity overlay when a gene has been plotted
                        if (atacActivePlot?.source === 'artifact') {
                          const art = artifacts.find(a => a.id === atacActivePlot.artifactId);
                          if (art?.type === 'gene_expression' && art.isAtac) return atacActivePlot;
                        }
                        return null;
                      })()}
                      artifacts={artifacts}
                      dataInfo={dataInfo}
                      clusterColorOverrides={atacClusterColorOverrides}
                      clusterLabelMap={atacClusterLabelMap}
                      onChangeClusterColor={(clusterId, color) => setAtacClusterColorOverrides(prev => {
                        const next = { ...prev };
                        if (!color) { delete next[String(clusterId)]; } else { next[String(clusterId)] = color; }
                        return next;
                      })}
                      viewModality="wnn-atac"
                      onLegendClusterClick={handleWnnLegendClick}
                      onClearLegendHighlight={() => setWnnCrossHighlight(null)}
                      highlightCellMask={wnnHighlightMask}
                    />
                  </div>
                </div>
                <div className="resize-handle vertical-resize-handle visualization-resize-handle" style={{ cursor: 'default' }} />
                {/* Panel 3: WNN integrated co-embedding */}
                <div className="visualization-card interaction-card" style={{ flex: '1 1 0%', minWidth: 0 }}>
                  <div className="visualization-card-header">
                    <Icon icon="merge-links" size={18} />
                    <span>{(() => {
                      if (activePlot?.source === 'artifact') {
                        const art = artifacts.find(a => a.id === activePlot.artifactId);
                        if (art?.type === 'gene_expression' && !art.isAtac) return `WNN View, ${art.geneName}`;
                      }
                      return 'WNN View';
                    })()}</span>
                  </div>
                  <div className="visualization-card-body">
                    <PlotView
                      activePlot={clusterPlot}
                      geneExpression={(() => {
                        // Show RNA gene expression overlay on WNN co-embedding (same expression values, different coordinates)
                        if (activePlot?.source === 'artifact') {
                          const art = artifacts.find(a => a.id === activePlot.artifactId);
                          if (art?.type === 'gene_expression' && !art.isAtac) return activePlot;
                        }
                        return null;
                      })()}
                      artifacts={artifacts}
                      dataInfo={dataInfo}
                      clusterColorOverrides={wnnClusterColorOverrides}
                      clusterLabelMap={wnnClusterLabelMap}
                      onChangeClusterColor={(clusterId, color) => setWnnClusterColorOverrides(prev => {
                        const next = { ...prev };
                        if (!color) { delete next[String(clusterId)]; } else { next[String(clusterId)] = color; }
                        return next;
                      })}
                      viewModality="wnn-integrated"
                      onLegendClusterClick={handleWnnLegendClick}
                      onClearLegendHighlight={() => setWnnCrossHighlight(null)}
                      highlightCellMask={wnnHighlightMask}
                    />
                  </div>
                </div>
              </>
            ) : (
            <>
            <div
              className="visualization-card interaction-card"
              style={{ flex: `${layout.umapWidth} 1 0%`, minWidth: 0 }}
            >
              <div className="visualization-card-header">
                <Icon icon="timeline-line-chart" size={18} />
                <span>{(() => {
                  // Multiome + coverage plot: left panel shows ATAC clusters (same as Peak view) so users can match clusters
                  if (dataInfo?.modality === 'multiome' && atacActivePlot?.source === 'artifact') {
                    const atacArt = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                    if (atacArt?.showPeakViewAsPrimary) return 'ATAC clusters';
                  }
                  return dataInfo?.modality === 'multiome' ? 'RNA View' : 'UMAP View';
                })()}</span>
              </div>
              <div className="visualization-card-body">
                <PlotView
                  activePlot={(() => {
                    // Multiome + "highlight RNA cluster on ATAC": from side (RNA view) always shows cluster UMAP
                    if (dataInfo?.modality === 'multiome' && rnaClusterHighlightOnAtac != null) {
                      return clusterPlot;
                    }
                    // Multiome + coverage plot: show ATAC UMAP (clusters) in left panel so it matches Peak view clusters
                    if (dataInfo?.modality === 'multiome' && atacActivePlot?.source === 'artifact') {
                      const atacArt = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                      if (atacArt?.showPeakViewAsPrimary) return atacClusterPlot;
                    }
                    // Multiome: pass dotplot or TF motif artifact directly (replaces UMAP)
                    if (dataInfo?.modality === 'multiome' && activePlot?.source === 'artifact') {
                      const art = artifacts.find((a) => a.id === activePlot.artifactId);
                      if (art?.type === 'gene_dotplot' || art?.type === 'tf_motif_enrichment') return activePlot;
                    }
                    // Multiome: pass violin plot directly (replaces UMAP)
                    if (dataInfo?.modality === 'multiome' && activePlot?.source === 'analysis' && activePlot?.data?.type === 'gene_violin') {
                      return activePlot;
                    }
                    // Multiome: pass marker table directly (replaces UMAP)
                    if (dataInfo?.modality === 'multiome' && activePlot?.source === 'analysis' && activePlot?.data?.type === 'markers') {
                      return activePlot;
                    }
                    // scATAC: prefer activePlot when it's UMAP (from "plot clusters") so UMAP View updates
                    if (dataInfo?.modality === 'atac' && activePlot?.data?.type === 'umap') {
                      return activePlot;
                    }
                    // scATAC: dotplot/violin replace the UMAP View (left panel)
                    if (dataInfo?.modality === 'atac' && activePlot?.source === 'artifact') {
                      const art = artifacts.find((a) => a.id === activePlot.artifactId);
                      if (art?.type === 'gene_dotplot') return activePlot;
                    }
                    if (dataInfo?.modality === 'atac' && activePlot?.source === 'analysis' && activePlot?.data?.type === 'gene_violin') {
                      return activePlot;
                    }
                    return dataInfo?.modality === 'spatial' ? (activePlot || clusterPlot) : clusterPlot;
                  })()}
                  geneExpression={(() => {
                    // Multiome + "highlight RNA cluster on ATAC": from side shows cluster UMAP only (no gene overlay)
                    if (dataInfo?.modality === 'multiome' && rnaClusterHighlightOnAtac != null) {
                      return null;
                    }
                    // Multiome + coverage plot: no gene overlay on left panel (we show ATAC clusters only)
                    if (dataInfo?.modality === 'multiome' && atacActivePlot?.source === 'artifact') {
                      const atacArt = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                      if (atacArt?.showPeakViewAsPrimary) return null;
                    }
                    // Multiome RNA: pass gene expression overlay to RNA UMAP view
                    if (dataInfo?.modality === 'multiome' && activePlot?.source === 'artifact') {
                      const art = artifacts.find((a) => a.id === activePlot.artifactId);
                      if (art?.type === 'gene_expression' && !art.isAtac) return activePlot;
                    }
                    // ATAC: pass gene expression so UMAP view shows gene activity overlay
                    if (dataInfo?.modality === 'atac' && activePlot?.source === 'artifact') {
                      const art = artifacts.find((a) => a.id === activePlot.artifactId);
                      if (art?.type === 'gene_expression') return activePlot;
                    }
                    // Spatial: pass gene expression to UMAP view when activePlot is gene_expression
                    if (dataInfo?.modality !== 'spatial' || !activePlot) {
                      return null;
                    }

                    // For violin/dotplot: check if activePlot has a spatialArtifactId
                    if (activePlot.spatialArtifactId) {
                      const result = { source: 'artifact', artifactId: activePlot.spatialArtifactId };
                      const artifact = artifacts.find(a => a.id === activePlot.spatialArtifactId);
                      return result;
                    }

                    // Check if activePlot is a gene_expression artifact
                    if (activePlot.source === 'artifact') {
                      const artifact = artifacts.find(a => a.id === activePlot.artifactId);
                      if (artifact && artifact.type === 'gene_expression') {
                        return activePlot;
                      }
                    } else if (activePlot.source === 'analysis' && activePlot.data?.type === 'gene_expression') {
                      return activePlot;
                    }
                    return null;
                  })()}
                  artifacts={artifacts}
                  dataInfo={dataInfo}
                  selectedClusters={(() => {
                    // Multiome + coverage plot: use ATAC cluster selection so left panel matches Peak view
                    if (dataInfo?.modality === 'multiome' && atacActivePlot?.source === 'artifact') {
                      const atacArt = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                      if (atacArt?.showPeakViewAsPrimary) return atacSelectedClusters;
                    }
                    return selectedClusters;
                  })()}
                  onSelectClusters={(() => {
                    if (dataInfo?.modality === 'multiome' && atacActivePlot?.source === 'artifact') {
                      const atacArt = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                      if (atacArt?.showPeakViewAsPrimary) return setAtacSelectedClusters;
                    }
                    return setSelectedClusters;
                  })()}
                  clusterColorOverrides={(() => {
                    if (dataInfo?.modality === 'multiome' && atacActivePlot?.source === 'artifact') {
                      const atacArt = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                      if (atacArt?.showPeakViewAsPrimary) return atacClusterColorOverrides;
                    }
                    return clusterColorOverrides;
                  })()}
                  clusterLabelMap={(() => {
                    if (dataInfo?.modality === 'multiome' && atacActivePlot?.source === 'artifact') {
                      const atacArt = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                      if (atacArt?.showPeakViewAsPrimary) return atacClusterLabelMap;
                    }
                    // When showing BANKSY regions in the UMAP view, use regionLabelMap
                    const ap = dataInfo?.modality === 'spatial' ? (activePlot || clusterPlot) : clusterPlot;
                    if (ap?.data?.source === 'banksy' && Object.keys(regionLabelMap).length > 0) {
                      return regionLabelMap;
                    }
                    return clusterLabelMap;
                  })()}
                  onChangeClusterColor={(clusterId, color) => {
                    const setOverrides = (dataInfo?.modality === 'multiome' && atacActivePlot?.source === 'artifact' && artifacts.find((a) => a.id === atacActivePlot.artifactId)?.showPeakViewAsPrimary)
                      ? setAtacClusterColorOverrides
                      : setClusterColorOverrides;
                    setOverrides((prev) => {
                      const key = String(clusterId);
                      const next = { ...prev };
                      if (!color) {
                        delete next[key];
                      } else {
                        next[key] = color;
                      }
                      return next;
                    });
                  }}
                  atacClustersForRnaHighlight={
                    dataInfo?.modality === 'multiome' && rnaClusterHighlightOnAtac == null && atacClusterPlot?.source === 'analysis'
                      ? atacClusterPlot.data?.clusters
                      : null
                  }
                  atacClusterHighlightOnRna={rnaClusterHighlightOnAtac == null ? atacClusterHighlightOnRna : null}
                  legendHighlightSelection={dataInfo?.modality === 'multiome' ? legendHighlightSelection : null}
                  onLegendClusterClick={dataInfo?.modality === 'multiome' ? handleLegendClusterClick : null}
                  onClearLegendHighlight={dataInfo?.modality === 'multiome' ? clearLegendHighlight : null}
                  viewModality={dataInfo?.modality === 'multiome' ? 'rna' : null}
                  otherModalityClusters={dataInfo?.modality === 'multiome' && atacClusterPlot?.source === 'analysis' ? atacClusterPlot.data?.clusters : null}
                  cellBarcodes={dataInfo?.modality === 'multiome' && clusterPlot?.source === 'analysis' ? clusterPlot.data?.cellBarcodes : null}
                  otherModalityCellBarcodes={dataInfo?.modality === 'multiome' && atacClusterPlot?.source === 'analysis' ? atacClusterPlot.data?.cellBarcodes : null}
                />
              </div>
            </div>
            <div
              className={`resize-handle vertical-resize-handle visualization-resize-handle${activeHandle === 'umapSpatial' ? ' is-active' : ''}`}
              onMouseDown={startResize('umapSpatial')}
              onTouchStart={startResize('umapSpatial')}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize visualization panels"
            />
            <div
              className="visualization-card interaction-card"
              style={{ flex: `${100 - layout.umapWidth} 1 0%`, minWidth: 0 }}
            >
              <div className="visualization-card-header">
                {dataInfo?.modality === 'spatial' ? (
                  <>
                    <img src={spatialIcon} alt="Spatial view" className="visualization-card-icon" />
                    <span>Spatial View</span>
                  </>
                ) : dataInfo?.modality === 'atac' ? (
                  <>
                    <Icon icon="chart" size={18} />
                    <span>Peak View</span>
                  </>
                ) : dataInfo?.modality === 'multiome' ? (
                  <>
                    <Icon icon="chart" size={18} />
                    <span>{(() => {
                      if (atacActivePlot?.source === 'artifact') {
                        const art = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                        if (art?.showPeakViewAsPrimary) return 'Peak View';
                        if (art?.type === 'peak_gene_links') return `Links, ${art.gene}`;
                      }
                      return 'ATAC View';
                    })()}</span>
                  </>
                ) : (
                  <>
                    <Icon icon="chart" size={18} />
                    <span>Analysis View</span>
                  </>
                )}
              </div>
              <div className="visualization-card-body">
                {dataInfo?.modality === 'spatial' ? (
                  <SpatialPlotView
                    activePlot={activePlot}
                    clusterPlot={clusterPlot}
                    regionPlot={regionPlot}
                    artifacts={artifacts}
                    dataInfo={dataInfo}
                    selectedClusters={selectedClusters}
                    clusterColorOverrides={clusterColorOverrides}
                    clusterLabelMap={clusterLabelMap}
                    regionLabelMap={regionLabelMap}
                    onSpatialRegionSelected={setSpatialSelection}
                  />
                ) : dataInfo?.modality === 'multiome' ? (
                  <PlotView
                    activePlot={(() => {
                      // Multiome + "highlight ATAC cluster on RNA": from side (ATAC view) always shows cluster UMAP
                      if (dataInfo?.modality === 'multiome' && atacClusterHighlightOnRna != null) {
                        return atacClusterPlot;
                      }
                      // "Coverage plot [gene]": show Peak View (CoveragePlot) as main content
                      if (atacActivePlot?.source === 'artifact') {
                        const art = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                        if (art?.type === 'gene_expression' && art?.showPeakViewAsPrimary) {
                          return atacActivePlot;
                        }
                        // Peak-gene links: pass through directly (replaces ATAC UMAP)
                        if (art?.type === 'peak_gene_links') {
                          return atacActivePlot;
                        }
                        // Dotplot: pass through directly (replaces ATAC UMAP)
                        if (art?.type === 'gene_dotplot') {
                          return atacActivePlot;
                        }
                      }
                      // Violin: pass through directly (replaces ATAC UMAP)
                      if (atacActivePlot?.source === 'analysis' && atacActivePlot?.data?.type === 'gene_violin') {
                        return atacActivePlot;
                      }
                      // Markers: pass through directly (replaces ATAC UMAP)
                      if (atacActivePlot?.source === 'analysis' && atacActivePlot?.data?.type === 'markers') {
                        return atacActivePlot;
                      }
                      return atacClusterPlot;
                    })()}
                    geneExpression={(() => {
                      // Multiome + "highlight ATAC cluster on RNA": from side shows cluster UMAP only (no gene overlay)
                      if (dataInfo?.modality === 'multiome' && atacClusterHighlightOnRna != null) {
                        return null;
                      }
                      // Multiome ATAC: pass ATAC gene activity overlay on UMAP (when main content is cluster UMAP)
                      if (atacActivePlot?.source === 'artifact') {
                        const art = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                        if (art?.type === 'gene_expression') return atacActivePlot;
                      }
                      return null;
                    })()}
                    artifacts={artifacts}
                    dataInfo={dataInfo}
                    selectedClusters={atacSelectedClusters}
                    onSelectClusters={setAtacSelectedClusters}
                    clusterColorOverrides={atacClusterColorOverrides}
                    clusterLabelMap={atacClusterLabelMap}
                    onChangeClusterColor={(clusterId, color) => {
                      setAtacClusterColorOverrides((prev) => {
                        const key = String(clusterId);
                        const next = { ...prev };
                        if (!color) {
                          delete next[key];
                        } else {
                          next[key] = color;
                        }
                        return next;
                      });
                    }}
                    rnaClustersForAtacHighlight={
                      dataInfo?.modality === 'multiome' && atacClusterHighlightOnRna == null && clusterPlot?.source === 'analysis'
                        ? clusterPlot.data?.clusters
                        : null
                    }
                    rnaClusterHighlightOnAtac={atacClusterHighlightOnRna == null ? rnaClusterHighlightOnAtac : null}
                    legendHighlightSelection={dataInfo?.modality === 'multiome' ? legendHighlightSelection : null}
                    onLegendClusterClick={dataInfo?.modality === 'multiome' ? handleLegendClusterClick : null}
                    onClearLegendHighlight={dataInfo?.modality === 'multiome' ? clearLegendHighlight : null}
                    viewModality={dataInfo?.modality === 'multiome' ? 'atac' : null}
                    otherModalityClusters={dataInfo?.modality === 'multiome' && clusterPlot?.source === 'analysis' ? clusterPlot.data?.clusters : null}
                    cellBarcodes={dataInfo?.modality === 'multiome' && atacClusterPlot?.source === 'analysis' ? atacClusterPlot.data?.cellBarcodes : null}
                    otherModalityCellBarcodes={dataInfo?.modality === 'multiome' && clusterPlot?.source === 'analysis' ? clusterPlot.data?.cellBarcodes : null}
                  />
                ) : dataInfo?.modality === 'atac' ? (
                  <PlotView
                    activePlot={(() => {
                      // Peak View: use peakViewPlot (gene/coverage) so it stays when user says "plot clusters"
                      if (peakViewPlot) return peakViewPlot;
                      if (!activePlot || activePlot.source !== 'artifact') return null;
                      const art = artifacts.find((a) => a.id === activePlot.artifactId);
                      return art?.type === 'gene_expression' ? activePlot : null;
                    })()}
                    artifacts={artifacts}
                    dataInfo={dataInfo}
                    clusterColorOverrides={clusterColorOverrides}
                    clusterLabelMap={clusterLabelMap}
                  />
                ) : (
                  <PlotView
                    activePlot={activePlot}
                    artifacts={artifacts}
                    dataInfo={dataInfo}
                    clusterColorOverrides={clusterColorOverrides}
                    clusterLabelMap={clusterLabelMap}
                  />
                )}
              </div>
            </div>
            </>
            )}
            </>
            )}
          </div>
        </div>

        <div
          className={`resize-handle horizontal-resize-handle${activeHandle === 'mainSplit' ? ' is-active' : ''}`}
          onMouseDown={startResize('mainSplit')}
          onTouchStart={startResize('mainSplit')}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize top and bottom panels"
        />

        <div
          className="interaction-panel"
          style={{ flex: `${bottomHeight} 1 0%` }}
          ref={interactionRowRef}
        >
          <div
            className="interaction-guide interaction-card"
            style={{ flex: `${layout.guideWidth} 1 0%`, minWidth: 0 }}
          >
            <div className="interaction-guide-header">
              <Icon icon="learning" size={18} />
              <span>How to use CellPilot</span>
            </div>
            <div className="interaction-guide-body">
              <p className="interaction-guide-welcome">Welcome to CellPilot! 👋</p>
              <ol>
                <li>Load your data using the <span style={{color: 'darkgreen', fontWeight: 600}}>Browse</span> button.</li>
                <li>(Optional) Select an <span style={{color: 'darkgreen', fontWeight: 600}}>API</span> with your API key, or download a <span style={{color: 'darkgreen', fontWeight: 600}}>local model</span>.</li>
                <li>Ask me to analyze your data!</li>
              </ol>
              <p className="interaction-guide-subtitle" style={{color: 'darkgreen'}}>Try commands like:</p>
              <ul>
                {getTutorialCommands(dataInfo).map((command) => (
                  <li key={command}>"{command}"</li>
                ))}
              </ul>
            </div>
          </div>

          <div
            className={`resize-handle vertical-resize-handle interaction-resize-handle${activeHandle === 'guideChat' ? ' is-active' : ''}`}
            onMouseDown={startResize('guideChat')}
            onTouchStart={startResize('guideChat')}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize instructions and chat panels"
          />

          <div
            className="interaction-chat interaction-card"
            style={{ flex: `${chatWidth} 1 0%`, minWidth: 0 }}
          >
            <ChatBot
              ref={chatBotRef}
              // Only allow chat commands once worker has finished initial pipeline
              dataLoaded={Number.isFinite(dataInfo?.cells) && Number.isFinite(dataInfo?.genes)}
              dataInfo={dataInfo}
              selectedModel={selectedModel}
              clusterLabelMap={clusterLabelMap}
              atacClusterLabelMap={atacClusterLabelMap}
              wnnActive={wnnActive}
              wnnClusterLabelMap={wnnClusterLabelMap}
              spatialSelection={spatialSelection}
              rnaClusters={clusterPlot?.source === 'analysis' ? clusterPlot.data?.clusters : null}
              atacClusters={atacClusterPlot?.source === 'analysis' ? atacClusterPlot.data?.clusters : null}
              wnnClusters={wnnActive && clusterPlot?.source === 'analysis' ? clusterPlot.data?.clusters : null}
              isAnalyzing={isAnalyzing}
              analysisStatusMessage={workerStatusMessage}
              onAnalysisRequest={handleAnalysisRequest}
              onSetColorMap={handleColorMapChange}
              onSetClusterColor={handleSetClusterColorFromChat}
              onHighlightRnaClusterOnAtac={handleHighlightRnaClusterOnAtac}
              onHighlightAtacClusterOnRna={handleHighlightAtacClusterOnRna}
            />
          </div>

          <div
            className={`resize-handle vertical-resize-handle interaction-resize-handle${activeHandle === 'chatLoader' ? ' is-active' : ''}`}
            onMouseDown={startResize('chatLoader')}
            onTouchStart={startResize('chatLoader')}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat and data panels"
          />

          <div
            className="interaction-loader interaction-card"
            style={{ flex: `${layout.loaderWidth} 1 0%`, minWidth: 0 }}
          >
            <div className="interaction-loader-header">
              <Icon icon="array" size={18} />
              <span>Data Loader & Model</span>
            </div>
            <div className="interaction-loader-body">
              <FileLoader onDataLoaded={handleDataLoaded} dataInfo={dataInfo} />
              <ModelSelector
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                onModelLoaded={(modelId) => {
                  toasterRef.current?.show({
                    message: `Intent model loaded: ${modelId}`,
                    intent: 'success',
                    icon: 'tick-circle',
                  });
                }}
                selectedChatModel={selectedChatModel}
                onChatModelChange={setSelectedChatModel}
                onChatModelLoaded={(modelId) => {
                  toasterRef.current?.show({
                    message: `Chat model loaded: ${modelId}. CellPilot can now answer general questions!`,
                    intent: 'success',
                    icon: 'chat',
                  });
                }}
              />
            </div>
          </div>
        </div>
      </div>
      <Toaster position={Position.TOP} ref={toasterRef} />
      {previousResultsDialog && (
        <PreviousResultsDialog
          previousResults={previousResultsDialog.savedResults}
          onChoice={handlePreviousResultsChoice}
        />
      )}
    </div>
  );
}

export default App;
