/**
 * Utility functions for loading Visium HD spatial transcriptomics data
 */

import { buildSpatialIndex } from './spatialIndex';

/**
 * Parse CSV data into structured format
 */
const parseCSV = (text) => {
  const lines = text.trim().split('\n');
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const stripQuotes = (value) => {
    if (value == null) {
      return '';
    }
    const trimmed = String(value).trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1);
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };

  const headers = lines[0].split(',').map(stripQuotes);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = stripQuotes(values[idx]);
    });
    rows.push(row);
  }

  return { headers, rows };
};

/**
 * Convert numeric cell ID to Visium HD barcode format
 * Input: 2 (from GeoJSON)
 * Output: "cellid_000000002-1" (to match other files)
 */
export const numericToBarcodeId = (numericId) => {
  const padded = String(numericId).padStart(9, '0');
  return `cellid_${padded}-1`;
};

/**
 * Convert Visium HD barcode format to numeric cell ID
 * Input: "cellid_000000002-1"
 * Output: 2
 */
export const barcodeToNumericId = (barcodeId) => {
  if (!barcodeId) return null;
  const match = barcodeId.match(/cellid_0*(\d+)-\d+/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
};

/**
 * Parse Visium HD cell segmentation GeoJSON
 * Extracts cell polygons and centroids
 * @param {Object} geojson: Parsed GeoJSON object
 * @returns {Object}: Cell data with polygons and centroids
 */
export const parseVisiumHDCellSegmentation = (geojson) => {
  if (!geojson || !geojson.features) {
    throw new Error('Invalid GeoJSON: missing features array');
  }

  const cells = [];
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

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
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    const centroidX = sumX / coordinates.length;
    const centroidY = sumY / coordinates.length;

    cells.push({
      cellId,
      numericId,
      x: centroidX,
      y: centroidY,
      polygon: coordinates,
    });
  }

  if (!cells.length) {
    return {
      cells,
      count: 0,
      spatialExtent: null,
    };
  }

  return {
    cells,
    count: cells.length,
    spatialExtent: {
      xMin,
      xMax,
      yMin,
      yMax,
    },
  };
};

/**
 * Parse UMAP coordinates from Visium HD analysis output
 * Expected CSV format: Barcode, UMAP-1, UMAP-2
 */
export const parseVisiumHDUMAP = (data, filename) => {
  const text = new TextDecoder().decode(data);
  const parsed = parseCSV(text);

  const coordinates = parsed.rows.map(row => {
    const cellId = row['Barcode'] || row['cell_id'] || row[''];
    const umap1 = parseFloat(row['UMAP-1'] || row['umap_1'] || row['0']);
    const umap2 = parseFloat(row['UMAP-2'] || row['umap_2'] || row['1']);

    return {
      cellId,
      umap: [umap1, umap2],
    };
  });

  return {
    coordinates,
    count: coordinates.length,
  };
};

/**
 * Parse clustering results from Visium HD analysis output
 * Expected CSV format: Barcode, Cluster
 */
export const parseVisiumHDClusters = (data, filename) => {
  const text = new TextDecoder().decode(data);
  const parsed = parseCSV(text);

  const clusters = {};

  parsed.rows.forEach(row => {
    const cellId = row['Barcode'] || row['cell_id'] || row[''];
    const cluster = row['Cluster'] || row['cluster'] || row['1'];
    clusters[cellId] = cluster;
  });

  return {
    clusters,
    count: Object.keys(clusters).length,
    uniqueClusters: [...new Set(Object.values(clusters))],
  };
};

/**
 * Load complete Visium HD dataset (segmented outputs)
 * @param {Object} files: Object containing all Visium HD files
 * @param {Object} metadata: Metadata about file formats
 * @returns {Promise<Object>}: Complete Visium HD dataset
 */
export async function loadVisiumHDData(files, metadata) {
  try {
    const result = {
      format: '10X Visium HD',
      modality: 'spatial',
      cells: null,
      polygons: null,
      umap: null,
      clusters: null,
      spatialCoordinates: null,
      cellFeatureMatrix: null,
      spatialIndex: null,
      hasPolygons: false,
    };

    // Load cell segmentation (GeoJSON with polygons)
    if (files.cellSegmentation) {
      const text = new TextDecoder().decode(files.cellSegmentation.data);
      const geojson = JSON.parse(text);
      const cellsData = parseVisiumHDCellSegmentation(geojson);

      result.cells = cellsData.cells;
      result.spatialExtent = cellsData.spatialExtent;
      result.hasPolygons = true;

      // Create polygon lookup by cell ID for efficient access
      const polygonMap = new Map();
      for (const cell of cellsData.cells) {
        polygonMap.set(cell.cellId, cell.polygon);
      }
      result.polygons = polygonMap;

      // Extract spatial coordinates (centroids) for plotting
      result.spatialCoordinates = cellsData.cells.map(cell => [cell.x, cell.y]);

      if (Array.isArray(result.spatialCoordinates) && result.spatialCoordinates.length) {
        result.spatialIndex = buildSpatialIndex(result.spatialCoordinates, {
          maxLevels: 9,
          baseSamplesPerTile: 1600,
          levelSampleMultiplier: 1.8,
          hardSampleCap: 50000,
        });
      }

    }

    // Load UMAP coordinates from analysis
    if (files.analysis && files.analysis.umap) {
      try {
        const umapKeys = Object.keys(files.analysis.umap);
        if (umapKeys.length > 0) {
          const umapFile = files.analysis.umap[umapKeys[0]];
          const umapData = parseVisiumHDUMAP(umapFile.data, umapFile.name);
          result.umap = umapData.coordinates;
        }
      } catch (error) {
        console.warn('Could not load UMAP data:', error.message);
      }
    }

    // Load clustering results
    if (files.analysis && files.analysis.clusters) {
      try {
        const clusterData = parseVisiumHDClusters(
          files.analysis.clusters.data,
          files.analysis.clusters.name
        );
        result.clusters = clusterData.clusters;
        result.uniqueClusters = clusterData.uniqueClusters;
      } catch (error) {
        console.warn('Could not load clustering data:', error.message);
      }
    }

    // Store cell feature matrix files for later processing by bakana
    if (files.cellFeatureMatrix) {
      result.cellFeatureMatrix = files.cellFeatureMatrix;
    }

    return result;

  } catch (error) {
    console.error('Error loading Visium HD data:', error);
    throw error;
  }
}

/**
 * Detect if a path contains Visium HD data
 */
export async function isVisiumHDData(path) {
  if (!window.electron) {
    return false;
  }

  try {
    const result = await window.electron.listDirectory(path);
    if (!result.success) {
      return false;
    }

    const files = result.files.map(f => f.toLowerCase());

    // Check for Visium HD-specific markers
    // Look for outs directory with segmented_outputs or binned_outputs
    return files.includes('outs') ||
           files.includes('segmented_outputs') ||
           files.includes('binned_outputs');
  } catch (error) {
    return false;
  }
}
