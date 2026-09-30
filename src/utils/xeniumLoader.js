import { buildSpatialIndex } from './spatialIndex';

const parseParquetOrCSV = (data, filename) => {
  if (filename.endsWith('.csv.gz') || filename.endsWith('.csv')) {
    const text = new TextDecoder().decode(data);
    return parseCSV(text);
  }

  throw new Error('Parquet format not yet supported. Please use CSV format files if available.');
};

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

export const parseXeniumCells = (data, filename) => {
  const parsed = parseParquetOrCSV(data, filename);
  const cells = [];
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const row of parsed.rows) {
    const x = Number.parseFloat(row.x_centroid) / 0.2125;
    const y = Number.parseFloat(row.y_centroid) / 0.2125;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    const cell = {
      cellId: row.cell_id,
      x,
      y,
      transcriptCounts: Number.parseInt(row.transcript_counts, 10),
      cellArea: Number.parseFloat(row.cell_area),
      nucleusArea: Number.parseFloat(row.nucleus_area),
    };
    cells.push(cell);
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
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

export const parseXeniumTranscripts = (data, filename, maxTranscripts = 100000) => {
  const parsed = parseParquetOrCSV(data, filename);

  let rows = parsed.rows;
  if (rows.length > maxTranscripts) {
    const step = Math.floor(rows.length / maxTranscripts);
    rows = rows.filter((_, idx) => idx % step === 0);
  }

  const transcripts = rows.map(row => ({
    transcriptId: row.transcript_id,
    cellId: row.cell_id,
    featureName: row.feature_name,
    x: parseFloat(row.x_location),
    y: parseFloat(row.y_location),
    z: parseFloat(row.z_location || 0),
    qv: parseInt(row.qv, 10),
  }));

  return {
    transcripts,
    count: transcripts.length,
    totalCount: parsed.rows.length,
  };
};

export const parseXeniumUMAP = (data, filename) => {
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

export const parseXeniumClusters = (data, filename) => {
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

export async function loadXeniumData(files, metadata) {
  try {
    console.log('Loading Xenium data...', metadata);

    const result = {
      format: '10X Xenium',
      modality: 'spatial',
      cells: null,
      transcripts: null,
      umap: null,
      clusters: null,
      spatialCoordinates: null,
      cellFeatureMatrix: null,
      spatialIndex: null,
    };

    if (files.cells) {
      const cellsData = parseXeniumCells(files.cells.data, files.cells.name);
      result.cells = cellsData.cells;
      result.spatialExtent = cellsData.spatialExtent;

      result.spatialCoordinates = cellsData.cells.map(cell => [cell.x, cell.y]);
      if (Array.isArray(result.spatialCoordinates) && result.spatialCoordinates.length) {
        result.spatialIndex = buildSpatialIndex(result.spatialCoordinates, {
          maxLevels: 9,
          baseSamplesPerTile: 800,
          levelSampleMultiplier: 1.8,
          hardSampleCap: 25000,
        });
      }

      console.log(`Loaded ${cellsData.count} cells with spatial coordinates`);
    }

    if (files.transcripts) {
      try {
        const transcriptsData = parseXeniumTranscripts(
          files.transcripts.data,
          files.transcripts.name
        );
        result.transcripts = transcriptsData.transcripts;
        console.log(`Loaded ${transcriptsData.count} transcripts (sampled from ${transcriptsData.totalCount})`);
      } catch (error) {
        console.warn('Could not load transcripts data:', error.message);
      }
    }

    if (files.analysis && files.analysis.umap) {
      try {
        const umapKeys = Object.keys(files.analysis.umap);
        if (umapKeys.length > 0) {
          const umapFile = files.analysis.umap[umapKeys[0]];
          const umapData = parseXeniumUMAP(umapFile.data, umapFile.name);
          result.umap = umapData.coordinates;
          console.log(`Loaded UMAP coordinates for ${umapData.count} cells`);
        }
      } catch (error) {
        console.warn('Could not load UMAP data:', error.message);
      }
    }

    if (files.cellFeatureMatrix) {
      result.cellFeatureMatrix = files.cellFeatureMatrix;
      console.log('Cell feature matrix files loaded');
    }

    return result;

  } catch (error) {
    console.error('Error loading Xenium data:', error);
    throw error;
  }
}

export async function isXeniumData(path) {
  if (!window.electron) {
    return false;
  }

  try {
    const result = await window.electron.listDirectory(path);
    if (!result.success) {
      return false;
    }

    const files = result.files.map(f => f.toLowerCase());

    return files.includes('experiment.xenium') ||
           files.includes('cells.parquet') ||
           files.includes('transcripts.parquet');
  } catch (error) {
    return false;
  }
}
