import React, { useState } from 'react';
import { Button, Icon, Tag, HTMLSelect } from '@blueprintjs/core';
import './FileLoader.css';

const MIN_INTEGRATION_DATASETS = 2;
const MAX_INTEGRATION_DATASETS = 3;
const MAX_XENIUM_INTEGRATION_DATASETS = 2;
const MAX_MERFISH_INTEGRATION_DATASETS = 2;

const FileLoader = ({ onDataLoaded, dataInfo }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dataModality, setDataModality] = useState('single-cell');
  const [spatialModality, setSpatialModality] = useState('xenium');
  const [dragActive, setDragActive] = useState(false);
  // scRNA-seq: single sample (h5/folder) vs multiple samples (integration)
  const [scRnaSampleMode, setScRnaSampleMode] = useState('single');
  const [integrationDatasets, setIntegrationDatasets] = useState([
    { name: '', path: '' },
    { name: '', path: '' },
  ]);
  const [integrationCount, setIntegrationCount] = useState(2);

  // scATAC-seq: single sample vs multiple samples (integration)
  const [atacSampleMode, setAtacSampleMode] = useState('single');
  const [atacIntegrationDatasets, setAtacIntegrationDatasets] = useState([
    { name: '', path: '' },
    { name: '', path: '' },
  ]);
  const [atacIntegrationCount, setAtacIntegrationCount] = useState(2);

  // Xenium spatial: single sample vs 2-sample integration
  const [xeniumSampleMode, setXeniumSampleMode] = useState('single');
  const [xeniumIntegrationDatasets, setXeniumIntegrationDatasets] = useState([
    { name: '', path: '' },
    { name: '', path: '' },
  ]);

  // Visium HD spatial: single sample vs 2-sample integration
  const [visiumHDSampleMode, setVisiumHDSampleMode] = useState('single');
  const [visiumHDIntegrationDatasets, setVisiumHDIntegrationDatasets] = useState([
    { name: '', path: '' },
    { name: '', path: '' },
  ]);

  // MERFISH spatial: single sample vs 2-sample integration
  const [merfishSampleMode, setMerfishSampleMode] = useState('single');
  const [merfishIntegrationDatasets, setMerfishIntegrationDatasets] = useState([
    { name: '', path: '' },
    { name: '', path: '' },
  ]);

  const getEffectiveModality = (override) => {
    if (override) {
      return override;
    }
    if (dataModality === 'spatial') {
      return spatialModality;
    }
    return dataModality;
  };

  const buildPathWithFile = (basePath, fileName) => {
    if (!fileName) {
      return basePath;
    }

    const separator = basePath.includes('\\') ? '\\' : '/';
    const needsSeparator = !basePath.endsWith(separator);
    return `${basePath}${needsSeparator ? separator : ''}${fileName}`;
  };

  const extractFileName = (targetPath) => {
    if (!targetPath) {
      return '';
    }
    const parts = targetPath.split(/[/\\]/);
    return parts[parts.length - 1] || targetPath;
  };

  const isH5Path = (targetPath) => {
    if (!targetPath) {
      return false;
    }
    const lower = targetPath.toLowerCase();
    return lower.endsWith('.h5') || lower.endsWith('.hdf5');
  };

  // central handler for a selected or dropped path
  const processSelectedPath = async (selectedPath, overrideModality) => {
    if (!selectedPath) return;
    setLoading(true);
    setError(null);

    try {
      const effectiveModality = getEffectiveModality(overrideModality);

      if (!effectiveModality) {
        setError('Please choose a spatial data type to continue.');
        return;
      }

      // Handle Xenium data
      if (effectiveModality === 'xenium') {
        if (!window.electron) {
          setError('Xenium import requires the desktop app.');
          return;
        }
        const result = await window.electron.readXeniumFiles(selectedPath);
        if (result.success) {
          const info = {
            path: result.regionPath || selectedPath,
            format: '10X Xenium',
            modality: 'spatial',
            isValid: true,
            files: result.files,
            metadata: result.metadata,
            // Xenium-specific: coordinates need to be divided by 0.2125 for histology alignment
            spatialScaleFactor: 0.2125,
            histologyPrealigned: false, // Xenium requires transformation matrix for histology
          };
          onDataLoaded(result.regionPath || selectedPath, info);
          return;
        }
        setError(result.error || 'Failed to read Xenium data');
        return;
      }

      // Handle Visium HD data
      if (effectiveModality === 'visium-hd') {
        if (!window.electron) {
          setError('Visium HD import requires the desktop app.');
          return;
        }
        const result = await window.electron.readVisiumHDFiles(selectedPath);
        if (result.success) {
          const info = {
            path: result.regionPath || selectedPath,
            format: '10X Visium HD',
            modality: 'spatial',
            dataType: result.dataType,
            isValid: true,
            files: result.files,
            metadata: result.metadata,
            // Visium HD: coordinates are already in pixel space, no scaling needed
            spatialScaleFactor: 1.0,
            histologyPrealigned: true, // Visium HD histology images are pre-aligned
          };
          onDataLoaded(result.regionPath || selectedPath, info);
          return;
        }
        setError(result.error || 'Failed to read Visium HD data');
        return;
      }

      // Handle MERFISH data
      if (effectiveModality === 'merfish') {
        if (!window.electron) {
          setError('MERFISH import requires the desktop app.');
          return;
        }
        const result = await window.electron.readMerfishFiles(selectedPath);
        if (result.success) {
          const info = {
            path: result.regionPath || selectedPath,
            format: 'MERFISH',
            modality: 'spatial',
            isValid: true,
            files: result.files,
            metadata: result.metadata,
            // MERFISH: coordinates are in physical space (microns), no scaling needed
            spatialScaleFactor: 1.0,
            histologyPrealigned: false, // MERFISH typically has no histology image
          };
          onDataLoaded(result.regionPath || selectedPath, info);
          return;
        }
        setError(result.error || 'Failed to read MERFISH data');
        return;
      }

      // Handle CosMX data
      if (effectiveModality === 'cosmx') {
        if (!window.electron) {
          setError('CosMX import requires the desktop app.');
          return;
        }
        const result = await window.electron.readCosmxFiles(selectedPath);
        if (result.success) {
          const info = {
            path: result.regionPath || selectedPath,
            format: 'CosMX',
            modality: 'spatial',
            isValid: true,
            files: result.files,
            metadata: result.metadata,
            // CosMX: coordinates are in pixel space, no scaling needed
            spatialScaleFactor: 1.0,
            histologyPrealigned: false, // CosMX typically has no histology image
          };
          onDataLoaded(result.regionPath || selectedPath, info);
          return;
        }
        setError(result.error || 'Failed to read CosMX data');
        return;
      }

      // scMultiome: 10x Cell Ranger ARC folder (filtered_feature_bc_matrix.h5 + analysis/ + atac_peak_annotation.tsv)
      if (effectiveModality === 'multiome') {
        if (!window.electron) {
          setError('scMultiome import requires the desktop app.');
          return;
        }
        const result = await window.electron.readMultiomeFiles(selectedPath);
        if (result.success) {
          const info = {
            path: result.regionPath || selectedPath,
            format: '10X Multiome',
            modality: 'multiome',
            isValid: true,
            files: result.files,
            precomputed: result.precomputed,
            ...(result.genome && { genome: result.genome }),
            ...(result.cellBarcodes && { cellBarcodes: result.cellBarcodes }),
          };
          onDataLoaded(result.regionPath || selectedPath, info);
          return;
        }
        setError(result.error || 'Failed to read multiome data');
        return;
      }

      // scATAC-seq: 10x Cell Ranger ATAC folder (filtered_peak_bc_matrix.h5 + peak_annotation.tsv)
      if (effectiveModality === 'atac') {
        if (!window.electron) {
          setError('scATAC-seq import requires the desktop app.');
          return;
        }
        const result = await window.electron.read10xAtacFiles(selectedPath);
        if (result.success) {
          let files = result.files;
          // Large matrix: pass chunk key/size so App can stream to worker (never hold full 1.4GB in renderer)
          if (result._matrixChunkKey != null && result._matrixSize != null) {
            files = {
              ...result.files,
              matrix: {
                name: result.files.matrix?.name || 'matrix.mtx',
                _chunkKey: result._matrixChunkKey,
                _matrixSize: result._matrixSize,
              },
            };
          }
          const info = {
            path: result.regionPath || selectedPath,
            format: '10X ATAC',
            modality: 'atac',
            isValid: true,
            files,
            ...(result.genome && { genome: result.genome }),
            ...(result.cellBarcodes && { cellBarcodes: result.cellBarcodes }),
          };
          onDataLoaded(result.regionPath || selectedPath, info);
          return;
        }
        setError(result.error || 'Failed to read 10x ATAC data');
        return;
      }

      // Single-cell H5 direct path
      if (isH5Path(selectedPath)) {
        const fileName = extractFileName(selectedPath);
        const info = {
          path: selectedPath,
          files: [fileName],
          format: '10X HDF5',
          isValid: true,
          h5FileName: fileName,
        };
        onDataLoaded(selectedPath, info);
        return;
      }

      if (!window.electron) {
        setError('File system access requires Electron. Please use the desktop app.');
        return;
      }

      // List files in the directory
      const result = await window.electron.listDirectory(selectedPath);
      if (!result.success) {
        setError(result.error || 'Failed to read directory');
        return;
      }

      const lowerFiles = result.files.map((f) => f.toLowerCase());
      const h5Index = lowerFiles.findIndex((f) => f.endsWith('.h5') || f.endsWith('.hdf5'));
      const hasH5 = h5Index !== -1;
      const h5FileName = hasH5 ? result.files[h5Index] : null;

      const hasMatrix = lowerFiles.some((f) => f.includes('matrix') && (f.endsWith('.mtx') || f.endsWith('.mtx.gz')));
      const hasFeatures = lowerFiles.some((f) => (f.includes('features') || f.includes('genes')) && (f.endsWith('.tsv') || f.endsWith('.tsv.gz')));
      const hasBarcodes = lowerFiles.some((f) => f.includes('barcodes') && (f.endsWith('.tsv') || f.endsWith('.tsv.gz')));

      const isMatrixMarket = hasMatrix && hasFeatures && hasBarcodes;

      const info = {
        path: hasH5 ? buildPathWithFile(selectedPath, h5FileName) : selectedPath,
        files: result.files,
        format: hasH5 ? '10X HDF5' : (isMatrixMarket ? '10X MatrixMarket' : 'Unknown'),
        isValid: hasH5 || isMatrixMarket,
        h5FileName: h5FileName,
      };

      if (info.isValid) {
        onDataLoaded(selectedPath, info);
      } else {
        setError('Invalid 10x data selection. Please choose a folder with matrix, features, and barcodes files or a .h5 file.');
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error loading data:', err);
      setError(err.message || 'An error occurred while loading data');
    } finally {
      setLoading(false);
    }
  };

  const handleBrowse = async () => {
    try {
      setError(null);
      if (!window.electron) {
        setError('File system access requires Electron. Please use the desktop app.');
        return;
      }
      let selectedPath;
      let effectiveModality = getEffectiveModality();

      if (dataModality === 'spatial') {
        // Spatial platform is already selected via the Platform dropdown
        effectiveModality = spatialModality;
        selectedPath = await window.electron.selectFolder();
      } else if (effectiveModality === 'atac') {
        selectedPath = await window.electron.selectFolder();
      } else if (effectiveModality === 'multiome') {
        selectedPath = await window.electron.selectFolder();
      } else if (effectiveModality === 'xenium') {
        selectedPath = await window.electron.selectFolder();
      } else {
        selectedPath = await window.electron.selectPath();
      }
      if (selectedPath) {
        await processSelectedPath(selectedPath, effectiveModality);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error in handleBrowse:', err);
      setError(err.message || 'An error occurred while selecting data');
    }
  };

  return (
    <div className="file-loader">
      {/* Data Type Selection */}
      <div className="file-loader-section">
        <div className="file-loader-row">
          <label className="file-loader-label">
            <Icon icon="database" size={14} />
            <span>Data Type</span>
          </label>
          <div className="file-loader-select-wrapper">
            <HTMLSelect
              value={dataModality}
              onChange={(e) => {
                const nextValue = e.target.value;
                setDataModality(nextValue);
                setError(null);  // Clear error when changing data type so user can retry
                if (nextValue !== 'spatial') {
                  setSpatialModality('xenium');
                }
              }}
              options={[
                { label: 'scRNA-seq', value: 'single-cell' },
                { label: 'scATAC-seq', value: 'atac' },
                { label: 'scMultiome', value: 'multiome' },
                { label: 'Spatial', value: 'spatial' },
              ]}
              disabled={loading}
              fill
            />
            {dataModality === 'atac' && (
              <Tag minimal intent="primary" round>10x ATAC</Tag>
            )}
            {dataModality === 'multiome' && (
              <Tag minimal intent="primary" round>10x Multiome</Tag>
            )}
            {dataModality === 'single-cell' && scRnaSampleMode === 'multiple' && (
              <Tag minimal intent="primary" round>2–3 samples, MNN</Tag>
            )}
            {dataModality === 'spatial' && spatialModality === 'xenium' && xeniumSampleMode === 'multiple' && (
              <Tag minimal intent="primary" round>2 samples, MNN</Tag>
            )}
            {dataModality === 'spatial' && spatialModality === 'visium-hd' && visiumHDSampleMode === 'multiple' && (
              <Tag minimal intent="primary" round>2 samples, MNN</Tag>
            )}
            {dataModality === 'spatial' && spatialModality === 'merfish' && merfishSampleMode === 'multiple' && (
              <Tag minimal intent="primary" round>2 samples, MNN</Tag>
            )}
          </div>
        </div>
      </div>

      {/* Spatial: Platform selector (Xenium, Visium HD, MERFISH, CosMX) */}
      {dataModality === 'spatial' && (
        <div className="file-loader-section">
          <div className="file-loader-row">
            <label className="file-loader-label">
              <Icon icon="map" size={14} />
              <span>Platform</span>
            </label>
            <div className="file-loader-select-wrapper">
              <HTMLSelect
                value={spatialModality}
                onChange={(e) => {
                  setSpatialModality(e.target.value);
                  setXeniumSampleMode('single');
                  setVisiumHDSampleMode('single');
                  setMerfishSampleMode('single');
                  setError(null);
                }}
                options={[
                  { label: '10x Xenium', value: 'xenium' },
                  { label: '10x Visium HD', value: 'visium-hd' },
                  { label: 'MERFISH', value: 'merfish' },
                  { label: 'CosMX', value: 'cosmx' },
                ]}
                disabled={loading}
                fill
              />
            </div>
          </div>
        </div>
      )}

      {/* scRNA-seq: Single sample vs Multiple samples */}
      {dataModality === 'single-cell' && (
        <div className="file-loader-section">
          <div className="file-loader-row">
            <label className="file-loader-label">
              <Icon icon="layers" size={14} />
              <span>Data</span>
            </label>
            <div className="file-loader-select-wrapper">
              <HTMLSelect
                value={scRnaSampleMode}
                onChange={(e) => {
                  setScRnaSampleMode(e.target.value);
                  setError(null);
                }}
                options={[
                  { label: 'Single sample', value: 'single' },
                  { label: 'Multiple samples (2–3)', value: 'multiple' },
                ]}
                disabled={loading}
                fill
              />
            </div>
          </div>
        </div>
      )}

      {/* scATAC-seq: Single sample vs Multiple samples */}
      {dataModality === 'atac' && (
        <div className="file-loader-section">
          <div className="file-loader-row">
            <label className="file-loader-label">
              <Icon icon="layers" size={14} />
              <span>Data</span>
            </label>
            <div className="file-loader-select-wrapper">
              <HTMLSelect
                value={atacSampleMode}
                onChange={(e) => {
                  setAtacSampleMode(e.target.value);
                  setError(null);
                }}
                options={[
                  { label: 'Single sample', value: 'single' },
                  { label: 'Multiple samples (2–3)', value: 'multiple' },
                ]}
                disabled={loading}
                fill
              />
            </div>
          </div>
        </div>
      )}

      {/* Visium HD: Single sample vs 2-sample integration */}
      {dataModality === 'spatial' && spatialModality === 'visium-hd' && (
        <div className="file-loader-section">
          <div className="file-loader-row">
            <label className="file-loader-label">
              <Icon icon="layers" size={14} />
              <span>Data</span>
            </label>
            <div className="file-loader-select-wrapper">
              <HTMLSelect
                value={visiumHDSampleMode}
                onChange={(e) => {
                  setVisiumHDSampleMode(e.target.value);
                  setError(null);
                }}
                options={[
                  { label: 'Single sample', value: 'single' },
                  { label: '2-sample integration', value: 'multiple' },
                ]}
                disabled={loading}
                fill
              />
            </div>
          </div>
        </div>
      )}

      {/* Xenium: Single sample vs 2-sample integration */}
      {dataModality === 'spatial' && spatialModality === 'xenium' && (
        <div className="file-loader-section">
          <div className="file-loader-row">
            <label className="file-loader-label">
              <Icon icon="layers" size={14} />
              <span>Data</span>
            </label>
            <div className="file-loader-select-wrapper">
              <HTMLSelect
                value={xeniumSampleMode}
                onChange={(e) => {
                  setXeniumSampleMode(e.target.value);
                  setError(null);
                }}
                options={[
                  { label: 'Single sample', value: 'single' },
                  { label: '2-sample integration', value: 'multiple' },
                ]}
                disabled={loading}
                fill
              />
            </div>
          </div>
        </div>
      )}

      {/* MERFISH: Single sample vs 2-sample integration */}
      {dataModality === 'spatial' && spatialModality === 'merfish' && (
        <div className="file-loader-section">
          <div className="file-loader-row">
            <label className="file-loader-label">
              <Icon icon="layers" size={14} />
              <span>Data</span>
            </label>
            <div className="file-loader-select-wrapper">
              <HTMLSelect
                value={merfishSampleMode}
                onChange={(e) => {
                  setMerfishSampleMode(e.target.value);
                  setError(null);
                }}
                options={[
                  { label: 'Single sample', value: 'single' },
                  { label: '2-sample integration', value: 'multiple' },
                ]}
                disabled={loading}
                fill
              />
            </div>
          </div>
        </div>
      )}

      {/* ATAC multiple samples: name + path for each (2–3) */}
      {dataModality === 'atac' && atacSampleMode === 'multiple' && (
        <div className="file-loader-section file-loader-integration">
          <label className="file-loader-section-label">
            <Icon icon="layers" size={14} />
            <span>Samples (name + path for each)</span>
          </label>
          <p className="file-loader-hint">Give each sample a short name (e.g. ctrl, treatment) and choose a 10x ATAC folder.</p>
          {dataInfo?.modality === 'atac-integration' && dataInfo?.datasetNames?.length ? (
            <div className="file-info file-info--multiome">
              <div className="file-info-header">
                <Tag intent="success" icon="tick-circle" minimal>ATAC Integration</Tag>
                <div className="data-stats">
                  <span className="stat-item">
                    <Icon icon="cell-tower" size={12} />
                    <strong>{typeof dataInfo.cells === 'number' ? dataInfo.cells.toLocaleString() : dataInfo.cells || '—'}</strong> cells
                  </span>
                  <span className="stat-divider">•</span>
                  <span className="stat-item">{dataInfo.datasetNames.join(', ')}</span>
                </div>
              </div>
            </div>
          ) : (
          <>
          {atacIntegrationDatasets.slice(0, atacIntegrationCount).map((ds, idx) => (
            <div key={idx} className="file-loader-integration-row">
              <input
                type="text"
                className="bp4-input file-loader-integration-name"
                placeholder={`Sample name (e.g. ${['ctrl', 'treatment', 'sample3'][idx]})`}
                value={ds.name}
                onChange={(e) => {
                  const next = [...atacIntegrationDatasets];
                  next[idx] = { ...next[idx], name: e.target.value.trim() };
                  setAtacIntegrationDatasets(next);
                }}
                disabled={loading}
              />
              <div className="file-loader-integration-path">
                <span className="file-loader-integration-path-text" title={ds.path || 'No path'}>
                  {ds.path ? extractFileName(ds.path) || ds.path : 'No path selected'}
                </span>
                <Button
                  small
                  icon="folder-open"
                  text="Browse"
                  onClick={async () => {
                    if (!window.electron) {
                      setError('Integration requires the desktop app.');
                      return;
                    }
                    const selectedPath = await window.electron.selectFolder();
                    if (selectedPath) {
                      const next = [...atacIntegrationDatasets];
                      next[idx] = { ...next[idx], path: selectedPath };
                      setAtacIntegrationDatasets(next);
                      setError(null);
                    }
                  }}
                  disabled={loading}
                />
              </div>
            </div>
          ))}
          <div className="file-loader-integration-actions">
            {atacIntegrationCount < MAX_INTEGRATION_DATASETS && (
              <Button
                small
                icon="plus"
                text="Add sample"
                onClick={() => {
                  setAtacIntegrationCount((c) => Math.min(c + 1, MAX_INTEGRATION_DATASETS));
                  setAtacIntegrationDatasets((prev) => {
                    if (prev.length <= atacIntegrationCount) {
                      return [...prev, { name: '', path: '' }];
                    }
                    return prev;
                  });
                }}
                disabled={loading}
              />
            )}
            {atacIntegrationCount > MIN_INTEGRATION_DATASETS && (
              <Button
                small
                icon="minus"
                text="Remove sample"
                onClick={() => {
                  setAtacIntegrationCount((c) => Math.max(c - 1, MIN_INTEGRATION_DATASETS));
                }}
                disabled={loading}
              />
            )}
          </div>
          </>
          )}
        </div>
      )}

      {/* Multiple samples: name + path for each (2–3) */}
      {dataModality === 'single-cell' && scRnaSampleMode === 'multiple' && (
        <div className="file-loader-section file-loader-integration">
          <label className="file-loader-section-label">
            <Icon icon="layers" size={14} />
            <span>Samples (name + path for each)</span>
          </label>
          <p className="file-loader-hint">Give each sample a short name (e.g. healthy, disease) and choose a 10x folder or .h5 file.</p>
          {dataInfo?.modality === 'integration' && dataInfo?.datasetNames?.length ? (
            <div className="file-info file-info--multiome">
              <div className="file-info-header">
                <Tag intent="success" icon="tick-circle" minimal>Integration</Tag>
                <div className="data-stats">
                  <span className="stat-item">
                    <Icon icon="cell-tower" size={12} />
                    <strong>{typeof dataInfo.cells === 'number' ? dataInfo.cells.toLocaleString() : dataInfo.cells || '—'}</strong> cells
                  </span>
                  <span className="stat-divider">•</span>
                  <span className="stat-item">
                    <Icon icon="dna" size={12} />
                    <strong>{typeof dataInfo.genes === 'number' ? dataInfo.genes.toLocaleString() : dataInfo.genes || '—'}</strong> genes
                  </span>
                  <span className="stat-divider">•</span>
                  <span className="stat-item">{dataInfo.datasetNames.join(', ')}</span>
                </div>
              </div>
            </div>
          ) : (
          <>
          {integrationDatasets.slice(0, integrationCount).map((ds, idx) => (
            <div key={idx} className="file-loader-integration-row">
              <input
                type="text"
                className="bp4-input file-loader-integration-name"
                placeholder={`Sample name (e.g. ${['healthy', 'disease', 'treatment'][idx]})`}
                value={ds.name}
                onChange={(e) => {
                  const next = [...integrationDatasets];
                  next[idx] = { ...next[idx], name: e.target.value.trim() };
                  setIntegrationDatasets(next);
                }}
                disabled={loading}
              />
              <div className="file-loader-integration-path">
                <span className="file-loader-integration-path-text" title={ds.path || 'No path'}>
                  {ds.path ? extractFileName(ds.path) || ds.path : 'No path selected'}
                </span>
                <Button
                  small
                  icon="folder-open"
                  text="Browse"
                  onClick={async () => {
                    if (!window.electron) {
                      setError('Integration requires the desktop app.');
                      return;
                    }
                    const selectedPath = await window.electron.selectPath();
                    if (selectedPath) {
                      const next = [...integrationDatasets];
                      next[idx] = { ...next[idx], path: selectedPath };
                      setIntegrationDatasets(next);
                      setError(null);
                    }
                  }}
                  disabled={loading}
                />
              </div>
            </div>
          ))}
          <div className="file-loader-integration-actions">
            {integrationCount < MAX_INTEGRATION_DATASETS && (
              <Button
                small
                icon="plus"
                text="Add sample"
                onClick={() => {
                  setIntegrationCount((c) => Math.min(c + 1, MAX_INTEGRATION_DATASETS));
                  setIntegrationDatasets((prev) => {
                    if (prev.length <= integrationCount) {
                      return [...prev, { name: '', path: '' }];
                    }
                    return prev;
                  });
                }}
                disabled={loading}
              />
            )}
            {integrationCount > MIN_INTEGRATION_DATASETS && (
              <Button
                small
                icon="minus"
                text="Remove sample"
                onClick={() => {
                  setIntegrationCount((c) => Math.max(c - 1, MIN_INTEGRATION_DATASETS));
                }}
                disabled={loading}
              />
            )}
          </div>
          </>
          )}
        </div>
      )}

      {/* Xenium 2-sample integration: name + path for each */}
      {dataModality === 'spatial' && spatialModality === 'xenium' && xeniumSampleMode === 'multiple' && (
        <div className="file-loader-section file-loader-integration">
          <label className="file-loader-section-label">
            <Icon icon="layers" size={14} />
            <span>Xenium Samples (2 samples)</span>
          </label>
          <p className="file-loader-hint">Give each sample a short name (e.g. ctrl, treatment) and choose a Xenium output folder.</p>
          {dataInfo?.modality === 'xenium-integration' && dataInfo?.datasetNames?.length ? (
            <div className="file-info file-info--multiome">
              <div className="file-info-header">
                <Tag intent="success" icon="tick-circle" minimal>Xenium Integration</Tag>
                <div className="data-stats">
                  <span className="stat-item">
                    <Icon icon="cell-tower" size={12} />
                    <strong>{typeof dataInfo.cells === 'number' ? dataInfo.cells.toLocaleString() : dataInfo.cells || '—'}</strong> cells
                  </span>
                  <span className="stat-divider">•</span>
                  <span className="stat-item">{dataInfo.datasetNames.join(', ')}</span>
                </div>
              </div>
            </div>
          ) : (
          <>
          {xeniumIntegrationDatasets.map((ds, idx) => (
            <div key={idx} className="file-loader-integration-row">
              <input
                type="text"
                className="bp4-input file-loader-integration-name"
                placeholder={`Sample name (e.g. ${['ctrl', 'treatment'][idx]})`}
                value={ds.name}
                onChange={(e) => {
                  const next = [...xeniumIntegrationDatasets];
                  next[idx] = { ...next[idx], name: e.target.value.trim() };
                  setXeniumIntegrationDatasets(next);
                }}
                disabled={loading}
              />
              <div className="file-loader-integration-path">
                <span className="file-loader-integration-path-text" title={ds.path || 'No path'}>
                  {ds.path ? extractFileName(ds.path) || ds.path : 'No path selected'}
                </span>
                <Button
                  small
                  icon="folder-open"
                  text="Browse"
                  onClick={async () => {
                    if (!window.electron) {
                      setError('Xenium integration requires the desktop app.');
                      return;
                    }
                    const selectedPath = await window.electron.selectFolder();
                    if (selectedPath) {
                      const next = [...xeniumIntegrationDatasets];
                      next[idx] = { ...next[idx], path: selectedPath };
                      setXeniumIntegrationDatasets(next);
                      setError(null);
                    }
                  }}
                  disabled={loading}
                />
              </div>
            </div>
          ))}
          </>
          )}
        </div>
      )}

      {/* Visium HD 2-sample integration: name + path for each */}
      {dataModality === 'spatial' && spatialModality === 'visium-hd' && visiumHDSampleMode === 'multiple' && (
        <div className="file-loader-section file-loader-integration">
          <label className="file-loader-section-label">
            <Icon icon="layers" size={14} />
            <span>Visium HD Samples (2 samples)</span>
          </label>
          <p className="file-loader-hint">Give each sample a short name (e.g. ctrl, treatment) and choose a Visium HD output folder.</p>
          {dataInfo?.modality === 'visium-hd-integration' && dataInfo?.datasetNames?.length ? (
            <div className="file-info file-info--multiome">
              <div className="file-info-header">
                <Tag intent="success" icon="tick-circle" minimal>Visium HD Integration</Tag>
                <div className="data-stats">
                  <span className="stat-item">
                    <Icon icon="cell-tower" size={12} />
                    <strong>{typeof dataInfo.cells === 'number' ? dataInfo.cells.toLocaleString() : dataInfo.cells || '—'}</strong> cells
                  </span>
                  <span className="stat-divider">•</span>
                  <span className="stat-item">{dataInfo.datasetNames.join(', ')}</span>
                </div>
              </div>
            </div>
          ) : (
          <>
          {visiumHDIntegrationDatasets.map((ds, idx) => (
            <div key={idx} className="file-loader-integration-row">
              <input
                type="text"
                className="bp4-input file-loader-integration-name"
                placeholder={`Sample name (e.g. ${['ctrl', 'treatment'][idx]})`}
                value={ds.name}
                onChange={(e) => {
                  const next = [...visiumHDIntegrationDatasets];
                  next[idx] = { ...next[idx], name: e.target.value.trim() };
                  setVisiumHDIntegrationDatasets(next);
                }}
                disabled={loading}
              />
              <div className="file-loader-integration-path">
                <span className="file-loader-integration-path-text" title={ds.path || 'No path'}>
                  {ds.path ? extractFileName(ds.path) || ds.path : 'No path selected'}
                </span>
                <Button
                  small
                  icon="folder-open"
                  text="Browse"
                  onClick={async () => {
                    if (!window.electron) {
                      setError('Visium HD integration requires the desktop app.');
                      return;
                    }
                    const selectedPath = await window.electron.selectFolder();
                    if (selectedPath) {
                      const next = [...visiumHDIntegrationDatasets];
                      next[idx] = { ...next[idx], path: selectedPath };
                      setVisiumHDIntegrationDatasets(next);
                      setError(null);
                    }
                  }}
                  disabled={loading}
                />
              </div>
            </div>
          ))}
          </>
          )}
        </div>
      )}

      {/* MERFISH 2-sample integration: name + path for each */}
      {dataModality === 'spatial' && spatialModality === 'merfish' && merfishSampleMode === 'multiple' && (
        <div className="file-loader-section file-loader-integration">
          <label className="file-loader-section-label">
            <Icon icon="layers" size={14} />
            <span>MERFISH Samples (2 samples)</span>
          </label>
          <p className="file-loader-hint">Give each sample a short name (e.g. ctrl, treatment) and choose a MERFISH output folder.</p>
          {dataInfo?.modality === 'merfish-integration' && dataInfo?.datasetNames?.length ? (
            <div className="file-info file-info--multiome">
              <div className="file-info-header">
                <Tag intent="success" icon="tick-circle" minimal>MERFISH Integration</Tag>
                <div className="data-stats">
                  <span className="stat-item">
                    <Icon icon="cell-tower" size={12} />
                    <strong>{typeof dataInfo.cells === 'number' ? dataInfo.cells.toLocaleString() : dataInfo.cells || '—'}</strong> cells
                  </span>
                  <span className="stat-divider">•</span>
                  <span className="stat-item">{dataInfo.datasetNames.join(', ')}</span>
                </div>
              </div>
            </div>
          ) : (
          <>
          {merfishIntegrationDatasets.map((ds, idx) => (
            <div key={idx} className="file-loader-integration-row">
              <input
                type="text"
                className="bp4-input file-loader-integration-name"
                placeholder={`Sample name (e.g. ${['ctrl', 'treatment'][idx]})`}
                value={ds.name}
                onChange={(e) => {
                  const next = [...merfishIntegrationDatasets];
                  next[idx] = { ...next[idx], name: e.target.value.trim() };
                  setMerfishIntegrationDatasets(next);
                }}
                disabled={loading}
              />
              <div className="file-loader-integration-path">
                <span className="file-loader-integration-path-text" title={ds.path || 'No path'}>
                  {ds.path ? extractFileName(ds.path) || ds.path : 'No path selected'}
                </span>
                <Button
                  small
                  icon="folder-open"
                  text="Browse"
                  onClick={async () => {
                    if (!window.electron) {
                      setError('MERFISH integration requires the desktop app.');
                      return;
                    }
                    const selectedPath = await window.electron.selectFolder();
                    if (selectedPath) {
                      const next = [...merfishIntegrationDatasets];
                      next[idx] = { ...next[idx], path: selectedPath };
                      setMerfishIntegrationDatasets(next);
                      setError(null);
                    }
                  }}
                  disabled={loading}
                />
              </div>
            </div>
          ))}
          </>
          )}
        </div>
      )}

      {/* Load Visium HD integration button */}
      {dataModality === 'spatial' && spatialModality === 'visium-hd' && visiumHDSampleMode === 'multiple' && !(dataInfo?.modality === 'visium-hd-integration') && (
        <div className="file-loader-section">
          <Button
            icon="layers"
            text="Load Visium HD integration"
            onClick={async () => {
              const list = visiumHDIntegrationDatasets.slice(0, 2);
              const names = list.map((d) => d.name.trim()).filter(Boolean);
              const paths = list.map((d) => d.path).filter(Boolean);
              if (names.length !== 2 || paths.length !== 2) {
                setError('Please give each of the 2 samples a name and select a Visium HD folder.');
                return;
              }
              if (new Set(names).size !== names.length) {
                setError('Sample names must be unique.');
                return;
              }
              setLoading(true);
              setError(null);
              try {
                if (!window.electron) {
                  setError('Visium HD integration requires the desktop app.');
                  return;
                }
                const visiumHDPayloads = [];
                for (let i = 0; i < list.length; i++) {
                  const { name, path } = list[i];
                  const result = await window.electron.readVisiumHDFiles(path);
                  if (!result.success) {
                    setError(`Failed to read Visium HD sample "${name}": ${result.error || 'Unknown error'}`);
                    return;
                  }
                  visiumHDPayloads.push({
                    name,
                    path: result.regionPath || path,
                    files: result.files,
                    metadata: result.metadata,
                    dataType: result.dataType,
                  });
                }
                const info = {
                  modality: 'visium-hd-integration',
                  format: 'Visium HD Integration',
                  datasetNames: names,
                  visiumHDIntegrationDatasets: visiumHDPayloads,
                  spatialScaleFactor: 1.0,
                  histologyPrealigned: true,
                  isValid: true,
                };
                onDataLoaded(visiumHDPayloads[0].path, info);
              } catch (err) {
                console.error('Visium HD integration load error:', err);
                setError(err.message || 'Failed to load Visium HD integration datasets');
              } finally {
                setLoading(false);
              }
            }}
            loading={loading}
            intent="primary"
            className="file-loader-browse"
            fill
          />
        </div>
      )}

      {/* Load Xenium integration button */}
      {dataModality === 'spatial' && spatialModality === 'xenium' && xeniumSampleMode === 'multiple' && !(dataInfo?.modality === 'xenium-integration') && (
        <div className="file-loader-section">
          <Button
            icon="layers"
            text="Load Xenium integration"
            onClick={async () => {
              const list = xeniumIntegrationDatasets.slice(0, MAX_XENIUM_INTEGRATION_DATASETS);
              const names = list.map((d) => d.name.trim()).filter(Boolean);
              const paths = list.map((d) => d.path).filter(Boolean);
              if (names.length !== MAX_XENIUM_INTEGRATION_DATASETS || paths.length !== MAX_XENIUM_INTEGRATION_DATASETS) {
                setError(`Please give each of the 2 samples a name and select a Xenium folder.`);
                return;
              }
              if (new Set(names).size !== names.length) {
                setError('Sample names must be unique.');
                return;
              }
              setLoading(true);
              setError(null);
              try {
                if (!window.electron) {
                  setError('Xenium integration requires the desktop app.');
                  return;
                }
                const xeniumPayloads = [];
                for (let i = 0; i < list.length; i++) {
                  const { name, path } = list[i];
                  const result = await window.electron.readXeniumFiles(path);
                  if (!result.success) {
                    setError(`Failed to read Xenium sample "${name}": ${result.error || 'Unknown error'}`);
                    return;
                  }
                  xeniumPayloads.push({
                    name,
                    path: result.regionPath || path,
                    files: result.files,
                    metadata: result.metadata,
                  });
                }
                const info = {
                  modality: 'xenium-integration',
                  format: 'Xenium Integration',
                  datasetNames: names,
                  xeniumIntegrationDatasets: xeniumPayloads,
                  spatialScaleFactor: 0.2125,
                  histologyPrealigned: false,
                  isValid: true,
                };
                onDataLoaded(xeniumPayloads[0].path, info);
              } catch (err) {
                console.error('Xenium integration load error:', err);
                setError(err.message || 'Failed to load Xenium integration datasets');
              } finally {
                setLoading(false);
              }
            }}
            loading={loading}
            intent="primary"
            className="file-loader-browse"
            fill
          />
        </div>
      )}

      {/* Load MERFISH integration button */}
      {dataModality === 'spatial' && spatialModality === 'merfish' && merfishSampleMode === 'multiple' && !(dataInfo?.modality === 'merfish-integration') && (
        <div className="file-loader-section">
          <Button
            icon="layers"
            text="Load MERFISH integration"
            onClick={async () => {
              const list = merfishIntegrationDatasets.slice(0, MAX_MERFISH_INTEGRATION_DATASETS);
              const names = list.map((d) => d.name.trim()).filter(Boolean);
              const paths = list.map((d) => d.path).filter(Boolean);
              if (names.length !== MAX_MERFISH_INTEGRATION_DATASETS || paths.length !== MAX_MERFISH_INTEGRATION_DATASETS) {
                setError('Please give each of the 2 samples a name and select a MERFISH folder.');
                return;
              }
              if (new Set(names).size !== names.length) {
                setError('Sample names must be unique.');
                return;
              }
              setLoading(true);
              setError(null);
              try {
                if (!window.electron) {
                  setError('MERFISH integration requires the desktop app.');
                  return;
                }
                const merfishPayloads = [];
                for (let i = 0; i < list.length; i++) {
                  const { name, path } = list[i];
                  const result = await window.electron.readMerfishFiles(path);
                  if (!result.success) {
                    setError(`Failed to read MERFISH sample "${name}": ${result.error || 'Unknown error'}`);
                    return;
                  }
                  merfishPayloads.push({
                    name,
                    path: result.regionPath || path,
                    files: result.files,
                    metadata: result.metadata,
                  });
                }
                const info = {
                  modality: 'merfish-integration',
                  format: 'MERFISH Integration',
                  datasetNames: names,
                  merfishIntegrationDatasets: merfishPayloads,
                  spatialScaleFactor: 1.0,
                  histologyPrealigned: false,
                  isValid: true,
                };
                onDataLoaded(merfishPayloads[0].path, info);
              } catch (err) {
                console.error('MERFISH integration load error:', err);
                setError(err.message || 'Failed to load MERFISH integration datasets');
              } finally {
                setLoading(false);
              }
            }}
            loading={loading}
            intent="primary"
            className="file-loader-browse"
            fill
          />
        </div>
      )}

      {/* Data Folder Section (single path) – for single sample or non–scRNA/ATAC types */}
      {(dataModality !== 'single-cell' || scRnaSampleMode === 'single') && (dataModality !== 'atac' || atacSampleMode === 'single') && !(dataModality === 'spatial' && spatialModality === 'xenium' && xeniumSampleMode === 'multiple') && !(dataModality === 'spatial' && spatialModality === 'visium-hd' && visiumHDSampleMode === 'multiple') && !(dataModality === 'spatial' && spatialModality === 'merfish' && merfishSampleMode === 'multiple') && (
      <div className="file-loader-section">
        <label className="file-loader-section-label">
          <Icon icon="folder-open" size={14} />
          <span>Data Folder</span>
        </label>

        {dataInfo ? (
          <div className={`file-info${dataInfo.modality === 'multiome' ? ' file-info--multiome' : ''}`}>
            <div className="file-info-header">
              <Tag intent="success" icon="tick-circle" minimal>
                {dataInfo.format}
              </Tag>
              <div className="data-stats">
                <span className="stat-item">
                  <Icon icon="cell-tower" size={12} />
                  <strong>
                    {typeof dataInfo.cells === 'number' 
                      ? dataInfo.cells.toLocaleString() 
                      : dataInfo.cells || 'Loading...'}
                  </strong> cells
                </span>
                <span className="stat-divider">•</span>
                <span className="stat-item">
                  <Icon icon="dna" size={12} />
                  <strong>
                    {typeof dataInfo.genes === 'number'
                      ? dataInfo.genes.toLocaleString()
                      : dataInfo.genes || 'Loading...'}
                  </strong> {dataInfo.modality === 'atac' ? 'peaks' : 'genes'}
                </span>
                {dataInfo.modality === 'multiome' && typeof dataInfo.peaks === 'number' && (
                  <>
                    <span className="stat-divider">•</span>
                    <span className="stat-item">
                      <Icon icon="scatter-plot" size={12} />
                      <strong>{dataInfo.peaks.toLocaleString()}</strong> peaks
                    </span>
                  </>
                )}
              </div>
            </div>
            <span className="file-path">{dataInfo.path}</span>
            {(() => {
              const skippedEntries = dataInfo.metadata?.skipped
                ? Object.entries(dataInfo.metadata.skipped).filter(([, v]) => v)
                : [];
              if (!skippedEntries.length) {
                return null;
              }
              return (
                <div className="file-loader-warnings">
                  {skippedEntries.map(([k, v]) => (
                    <div key={k} className="skip-item">
                      <Icon icon="warning-sign" intent="warning" size={12} />
                      <span>{k}: {v}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        ) : (
          <div
              className={`no-data-placeholder${dragActive ? ' drag-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                // Hint copy action to the OS
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                setDragActive(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setDragActive(false);
              }}
              onDrop={async (e) => {
                e.preventDefault();
                setDragActive(false);
                const dt = e.dataTransfer;
                if (!dt) return;
                // Debug context for tricky drag sources (Finder, aliases, etc.)
                try {
                  // eslint-disable-next-line no-console
                  // eslint-disable-next-line no-console
                } catch (_) {}
                const looksLikeAbsolute = (p) => typeof p === 'string' && (
                  p.startsWith('/') || // macOS / Linux
                  /^[a-zA-Z]:\\/.test(p) // Windows C:\
                );

                const files = Array.from(dt.files || []);
                // 1) Try paths from File objects (Electron exposes absolute paths here)
                let candidate = files.map(f => f.path).find(p => looksLikeAbsolute(p));

                // 2) Try text/uri-list
                if (!candidate && dt.getData) {
                  try {
                    const uriList = dt.getData('text/uri-list');
                    try {
                      if (uriList) {
                        // eslint-disable-next-line no-console
                      }
                    } catch (_) {}
                    if (uriList) {
                      const lines = uriList.split(/\r?\n/).filter(Boolean);
                      const fileUri = lines.find(line => line.startsWith('file://'));
                      if (fileUri) {
                        try {
                          const parsed = new URL(fileUri.trim());
                          if (parsed.protocol === 'file:') {
                            let p = decodeURIComponent(parsed.pathname || parsed.href.replace('file://', ''));
                            if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // Windows /C:/...
                            if (looksLikeAbsolute(p)) candidate = p;
                          }
                        } catch (_) { /* ignore */ }
                      }
                    }
                  } catch (_) { /* ignore */ }
                }

                // 3) Try plain text (some apps put the absolute path here)
                if (!candidate && dt.getData) {
                  try {
                    const txt = dt.getData('text/plain') || dt.getData('text');
                    try {
                      if (txt) {
                        // eslint-disable-next-line no-console
                      }
                    } catch (_) {}
                    if (txt) {
                      const firstLine = txt.split(/\r?\n/).find(Boolean) || '';
                      if (firstLine.startsWith('file://')) {
                        try {
                          const parsed = new URL(firstLine.trim());
                          if (parsed.protocol === 'file:') {
                            let p = decodeURIComponent(parsed.pathname || parsed.href.replace('file://', ''));
                            if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
                            if (looksLikeAbsolute(p)) candidate = p;
                          }
                        } catch (_) { /* ignore */ }
                      } else if (looksLikeAbsolute(firstLine.trim())) {
                        candidate = firstLine.trim();
                      }
                    }
                  } catch (_) { /* ignore */ }
                }

                // 4) As a last resort, inspect string DataTransferItem entries
                if (!candidate && dt.items && dt.items.length) {
                  try {
                    // eslint-disable-next-line no-console
                  } catch (_) {}
                  const stringReads = await Promise.all(Array.from(dt.items).map(item => new Promise(resolve => {
                    try {
                      if (item.kind === 'string') {
                        item.getAsString((s) => resolve(s));
                      } else {
                        resolve(null);
                      }
                    } catch (_) { resolve(null); }
                  })));
                  const maybe = stringReads.filter(Boolean).map(s => String(s));
                  for (const s of maybe) {
                    const line = s.split(/\r?\n/).find(Boolean) || '';
                    if (line.startsWith('file://')) {
                      try {
                        const parsed = new URL(line.trim());
                        if (parsed.protocol === 'file:') {
                          let p = decodeURIComponent(parsed.pathname || parsed.href.replace('file://', ''));
                          if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
                          if (looksLikeAbsolute(p)) { candidate = p; break; }
                        }
                      } catch (_) { /* ignore */ }
                    } else if (looksLikeAbsolute(line.trim())) {
                      candidate = line.trim();
                      break;
                    }
                  }
                }

                if (candidate) {
                  await processSelectedPath(candidate);
                } else {
                  try {
                    // eslint-disable-next-line no-console
                  } catch (_) {}
                  setError('Unable to determine full filesystem path from drop. Please use Browse... or drop the folder directly from Finder/Explorer.');
                }
              }}
            >
              <Icon icon="inbox" size={20} color="#cbd5e1" />
              <span>No data loaded</span>
            </div>
        )}

        <Button
          icon="folder-open"
          text="Browse..."
          onClick={handleBrowse}
          loading={loading}
          intent="primary"
          className="file-loader-browse"
          fill
        />
      </div>
      )}

      {/* Load ATAC integration button */}
      {dataModality === 'atac' && atacSampleMode === 'multiple' && (
        <div className="file-loader-section">
          <Button
            icon="layers"
            text="Load ATAC integration"
            onClick={async () => {
              const list = atacIntegrationDatasets.slice(0, atacIntegrationCount);
              const names = list.map((d) => d.name.trim()).filter(Boolean);
              const paths = list.map((d) => d.path).filter(Boolean);
              if (names.length !== atacIntegrationCount || paths.length !== atacIntegrationCount) {
                setError(`Please give each of the ${atacIntegrationCount} samples a name and select a path.`);
                return;
              }
              if (new Set(names).size !== names.length) {
                setError('Sample names must be unique.');
                return;
              }
              setLoading(true);
              setError(null);
              try {
                if (!window.electron) {
                  setError('ATAC integration requires the desktop app.');
                  return;
                }
                const atacIntegrationPayloads = [];
                for (let i = 0; i < list.length; i++) {
                  const { name, path } = list[i];
                  const result = await window.electron.read10xAtacFiles(path);
                  if (!result.success) {
                    setError(`Failed to read ATAC sample "${name}": ${result.error || 'Unknown error'}`);
                    return;
                  }
                  // Large matrix: fetch all chunks NOW before the next read10xAtacFiles call
                  // clears the electron cache (atacMatrixChunkCache.clear() in electron.js).
                  let atacFiles = result.files;
                  if (result._matrixChunkKey != null && result._matrixSize != null) {
                    const INT_CHUNK = 80 * 1024 * 1024;
                    const ck = result._matrixChunkKey;
                    const sz = result._matrixSize;
                    const parts = [];
                    for (let off = 0; off < sz; off += INT_CHUNK) {
                      const len = Math.min(INT_CHUNK, sz - off);
                      const chunk = await window.electron.getAtacMatrixChunk(ck, off, len);
                      if (!chunk || (chunk.byteLength ?? chunk.length ?? 0) === 0) break;
                      parts.push(chunk.slice()); // slice() gives independent buffer
                    }
                    try { window.electron.releaseAtacMatrixBuffer(ck); } catch (e) { /* ignore */ }
                    const totalLen = parts.reduce((s, c) => s + c.byteLength, 0);
                    const merged = new Uint8Array(totalLen);
                    let pos = 0;
                    for (const p of parts) { merged.set(p, pos); pos += p.byteLength; }
                    atacFiles = { ...result.files, matrix: { name: result.files.matrix?.name || 'matrix.mtx', data: merged } };
                  }
                  atacIntegrationPayloads.push({
                    name,
                    path,
                    files: atacFiles,
                    cellBarcodes: result.cellBarcodes,
                    genome: result.genome,
                  });
                }
                const info = {
                  modality: 'atac-integration',
                  format: 'ATAC Integration',
                  datasetNames: names,
                  atacIntegrationDatasets: atacIntegrationPayloads,
                  isValid: true,
                };
                onDataLoaded(atacIntegrationPayloads[0].path, info);
              } catch (err) {
                console.error('ATAC integration load error:', err);
                setError(err.message || 'Failed to load ATAC integration datasets');
              } finally {
                setLoading(false);
              }
            }}
            loading={loading}
            intent="primary"
            className="file-loader-browse"
            fill
          />
        </div>
      )}

      {/* Load integration button (only when Multiple samples and 2–3 datasets filled) */}
      {dataModality === 'single-cell' && scRnaSampleMode === 'multiple' && (
        <div className="file-loader-section">
          <Button
            icon="layers"
            text="Load integration"
            onClick={async () => {
              const list = integrationDatasets.slice(0, integrationCount);
              const names = list.map((d) => d.name.trim()).filter(Boolean);
              const paths = list.map((d) => d.path).filter(Boolean);
              if (names.length !== integrationCount || paths.length !== integrationCount) {
                setError(`Please give each of the ${integrationCount} datasets a name and select a path.`);
                return;
              }
              if (new Set(names).size !== names.length) {
                setError('Dataset names must be unique.');
                return;
              }
              setLoading(true);
              setError(null);
              try {
                if (!window.electron) {
                  setError('Integration requires the desktop app.');
                  return;
                }
                const buildPathWithFile = (basePath, fileName) => {
                  if (!fileName) return basePath;
                  const separator = basePath.includes('\\') ? '\\' : '/';
                  const needsSeparator = !basePath.endsWith(separator);
                  return `${basePath}${needsSeparator ? separator : ''}${fileName}`;
                };
                const isH5 = (p) => (p || '').toLowerCase().endsWith('.h5') || (p || '').toLowerCase().endsWith('.hdf5');
                const integrationPayloads = [];
                for (let i = 0; i < list.length; i++) {
                  const { name, path } = list[i];
                  let result;
                  if (isH5(path)) {
                    const fileName = path.split(/[/\\]/).pop() || path;
                    result = await window.electron.read10xFiles(path, { format: '10X HDF5', h5FileName: fileName });
                  } else {
                    const dirResult = await window.electron.listDirectory(path);
                    if (!dirResult.success) {
                      setError(`Could not read folder for dataset "${name}": ${dirResult.error}`);
                      return;
                    }
                    const lower = dirResult.files.map((f) => f.toLowerCase());
                    const h5Idx = lower.findIndex((f) => f.endsWith('.h5') || f.endsWith('.hdf5'));
                    const hasH5 = h5Idx !== -1;
                    const h5FileName = hasH5 ? dirResult.files[h5Idx] : null;
                    const hasMatrix = lower.some((f) => f.includes('matrix') && (f.endsWith('.mtx') || f.endsWith('.mtx.gz')));
                    const hasFeatures = lower.some((f) => (f.includes('features') || f.includes('genes')) && (f.endsWith('.tsv') || f.endsWith('.tsv.gz')));
                    const hasBarcodes = lower.some((f) => f.includes('barcodes') && (f.endsWith('.tsv') || f.endsWith('.tsv.gz')));
                    const isMatrixMarket = hasMatrix && hasFeatures && hasBarcodes;
                    if (!hasH5 && !isMatrixMarket) {
                      setError(`Dataset "${name}": folder must contain matrix/features/barcodes or an .h5 file.`);
                      return;
                    }
                    const targetPath = hasH5 ? buildPathWithFile(path, h5FileName) : path;
                    result = await window.electron.read10xFiles(targetPath, {
                      format: hasH5 ? '10X HDF5' : '10X MatrixMarket',
                      h5FileName: hasH5 ? h5FileName : null,
                    });
                  }
                  if (!result.success) {
                    setError(`Failed to read dataset "${name}": ${result.error || 'Unknown error'}`);
                    return;
                  }
                  integrationPayloads.push({
                    name,
                    path: list[i].path,
                    info: { format: result.format || '10X HDF5' },
                    files: result.files,
                  });
                }
                const info = {
                  modality: 'integration',
                  datasetNames: names,
                  integrationDatasets: integrationPayloads,
                  isValid: true,
                  format: '10X Integration',
                };
                onDataLoaded(integrationPayloads[0].path, info);
              } catch (err) {
                console.error('Integration load error:', err);
                setError(err.message || 'Failed to load integration datasets');
              } finally {
                setLoading(false);
              }
            }}
            loading={loading}
            intent="primary"
            className="file-loader-browse"
            fill
          />
        </div>
      )}

      {error && (
        <div className="file-loader-error">
          <Icon icon="error" intent="danger" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

export default FileLoader;

