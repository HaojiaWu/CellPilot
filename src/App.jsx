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
  let lastCommands = [];
  const banksyCommands = [
    'Run BANKSY region segmentation',
    'Show regions',
    'What cell types are in region 1?',
    'Rename region 1 to cortex',
  ];

  if (modality === 'multiome') {
    moduleCommands = [
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
        'Find markers for the selected spatial region',
        'Run cell-cell interaction analysis across selected regions',
        ...banksyCommands,
      ];
      return Array.from(new Set(visiumHdCommands)).slice(0, 15);
    }
    lastCommands = banksyCommands;
    moduleCommands = [
      'Find markers for the selected spatial region',
      'Run cell-cell interaction analysis across selected regions',
    ];
    if (supportsSpatialImputation) {
      moduleCommands.push('Impute NPHS2 expression');
    }
  }

  if (modality === 'multiome') {
    const commands = Array.from(new Set([...moduleCommands, ...commonCommands]));
    return [...commands.slice(0, 15), 'Run WNN analysis'];
  }
  const commands = Array.from(new Set([...moduleCommands, ...commonCommands]));
  return [...commands.slice(0, 15 - lastCommands.length), ...lastCommands];
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
  const [geneNames, setGeneNames] = useState(null);
  const geneNamesReadyRef = useRef(false);
  const [autoClusterIssued, setAutoClusterIssued] = useState(false);
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
  const [integrationShowClustersOnly, setIntegrationShowClustersOnly] = useState(false);
  const [atacClusterPlot, setAtacClusterPlot] = useState(null);
  const [atacActivePlot, setAtacActivePlot] = useState(null);
  const [peakViewPlot, setPeakViewPlot] = useState(null);
  const [atacClusterLabelMap, setAtacClusterLabelMap] = useState({});
  const [atacClusterColorOverrides, setAtacClusterColorOverrides] = useState({});
  const [atacSelectedClusters, setAtacSelectedClusters] = useState(new Set());
  const [selectedClusters, setSelectedClusters] = useState(new Set());
  const [rnaClusterHighlightOnAtac, setRnaClusterHighlightOnAtac] = useState(null);
  const [atacClusterHighlightOnRna, setAtacClusterHighlightOnRna] = useState(null);
  const [legendHighlightSelection, setLegendHighlightSelection] = useState(null);
  const [wnnRnaPlot, setWnnRnaPlot] = useState(null);
  const [wnnAtacPlot, setWnnAtacPlot] = useState(null);
  const [wnnActive, setWnnActive] = useState(false);
  const [wnnClusterLabelMap, setWnnClusterLabelMap] = useState({});
  const [wnnClusterColorOverrides, setWnnClusterColorOverrides] = useState({});
  const [wnnCrossHighlight, setWnnCrossHighlight] = useState(null);
  const [clusterColorOverrides, setClusterColorOverrides] = useState({});
  const [clusterLabelMap, setClusterLabelMap] = useState({});
  const [agentAnnotationRows, setAgentAnnotationRows] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [workerStatusMessage, setWorkerStatusMessage] = useState('');
  const [autoModelLoadAttempted, setAutoModelLoadAttempted] = useState(false);
  const [layout, setLayout] = useState({
    topHeight: 60,
    umapWidth: 50,
    guideWidth: 24,
    loaderWidth: 24,
  });
  const dataInfoRef = useRef(null);
  const dataPathRef = useRef(null);
  const clusterLabelMapRef = useRef({});
  const clusterColorOverridesRef = useRef({});
  const atacClusterLabelMapRef = useRef({});
  const agentAnnotationRowsRef = useRef([]);
  const wnnActiveRef = useRef(false);
  const clusterPlotRef = useRef(null);
  const regionLabelMapRef = useRef({});
  const pendingSaveDataRef = useRef(null);
  const lastSavedPayloadHashRef = useRef(null);
  const pendingShowPeakViewRef = useRef(false);
  const multiomeGenePlotTimeoutRef = useRef(null);
  const pendingMultiomeGenePlotRef = useRef(false);
  const pendingFragmentQueriesRef = useRef(0);
  const atacFragmentCoverageCacheRef = useRef(new Map());
  const coverageScrollSyncRef = useRef({ containers: {}, handlers: {}, syncing: false });

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

  const wnnHighlightMask = useMemo(() => {
    if (!wnnCrossHighlight) return null;
    const { sourceClusters, highlightClusterId, highlightClusterIds } = wnnCrossHighlight;
    if (!Array.isArray(sourceClusters)) return null;
    const ids = new Set((highlightClusterIds || [highlightClusterId]).map(String));
    return sourceClusters.map(c => ids.has(String(c)));
  }, [wnnCrossHighlight]);

  const handleWnnLegendClick = useCallback((viewModality, clusterId) => {
    const sourceClusters =
      viewModality === 'wnn-rna' ? wnnRnaPlot?.data?.clusters :
      viewModality === 'wnn-atac' ? wnnAtacPlot?.data?.clusters :
      clusterPlot?.data?.clusters;
    if (!Array.isArray(sourceClusters)) return;
    const id = String(clusterId);
    setWnnCrossHighlight((prev) => {
      if (prev && prev.sourceModality === viewModality && prev.highlightClusterId === id) {
        return null;
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

  useEffect(() => { clusterLabelMapRef.current = clusterLabelMap; }, [clusterLabelMap]);
  useEffect(() => { clusterColorOverridesRef.current = clusterColorOverrides; }, [clusterColorOverrides]);
  useEffect(() => { atacClusterLabelMapRef.current = atacClusterLabelMap; }, [atacClusterLabelMap]);
  useEffect(() => { agentAnnotationRowsRef.current = agentAnnotationRows; }, [agentAnnotationRows]);
  useEffect(() => { clusterPlotRef.current = clusterPlot; }, [clusterPlot]);
  useEffect(() => { regionLabelMapRef.current = regionLabelMap; }, [regionLabelMap]);
  useEffect(() => { wnnActiveRef.current = wnnActive; }, [wnnActive]);

  const doSaveResults = useCallback(async () => {
    const savePath = dataPathRef.current;
    const saveFolder = /\.(h5|hdf5)$/i.test(savePath || '')
      ? savePath.substring(0, Math.max(savePath.lastIndexOf('/'), savePath.lastIndexOf('\\')))
      : savePath;
    const pending = pendingSaveDataRef.current;
    if (pending && !pending.umapData && pending.regionData && clusterPlotRef.current?.data) {
      pending.umapData = clusterPlotRef.current.data;
      console.log('doSaveResults: populated umapData from clusterPlotRef fallback');
    }
    if (!savePath || !pending?.umapData?.coordinates || !window.electron?.saveCellpilotResults) {
      console.log('CellPilot save skipped:', { savePath: !!savePath, hasUmapData: !!pending?.umapData?.coordinates, hasRegionData: !!pending?.regionData, hasElectron: !!window.electron?.saveCellpilotResults });
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
    if (Array.isArray(pending.peakGeneLinks) && pending.peakGeneLinks.length > 0) {
      results.peakGeneLinks = pending.peakGeneLinks;
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
      console.log('CellPilot: results saved to', savePath, '| wnn:', !!results.wnnActive, '| nCells:', results.nCells, '| nClusters:', results.nClusters,
        '| hasRegionClusters:', !!results.regionClusters, '| regionNclusters:', results.regionNclusters || 0, '| keys:', Object.keys(results).join(','));
    } catch (e) {
      console.warn('CellPilot: failed to save results:', e);
    }
  }, [buildAgentCellAnnotations]);

  const scheduleResultsSave = useCallback(() => {
    if (saveResultsDebounceRef.current) clearTimeout(saveResultsDebounceRef.current);
    saveResultsDebounceRef.current = setTimeout(doSaveResults, 2500);
  }, [doSaveResults]);

  useEffect(() => {
    if (pendingSaveDataRef.current?.umapData || pendingSaveDataRef.current?.regionData) scheduleResultsSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterLabelMap, clusterColorOverrides, atacClusterLabelMap, regionLabelMap, agentAnnotationRows]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      const savePath = dataPathRef.current;
      const saveFolder = /\.(h5|hdf5)$/i.test(savePath || '')
        ? savePath.substring(0, Math.max(savePath.lastIndexOf('/'), savePath.lastIndexOf('\\')))
        : savePath;
      const pending = pendingSaveDataRef.current;
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

  useEffect(() => {
    const autoLoadModel = async () => {
      if (autoModelLoadAttempted) return;

      if (isModelLoaded()) {
        console.log('Embedding model already loaded from cache');
        setAutoModelLoadAttempted(true);
        const currentModel = getCurrentModel();
        if (currentModel) {
          setSelectedModel(currentModel);
        }
        return;
      }

      setAutoModelLoadAttempted(true);

      const firstModelId = 'all-minilm-l6';
      const success = await downloadModel(firstModelId, (progress) => {
        if (progress === 100) {
          console.log('Bundled embedding model loaded successfully');
        }
      });

      if (success) {
        setSelectedModel(firstModelId);
      } else {
        console.warn('Auto-load of embedding model failed');
      }
    };

    autoLoadModel();
  }, [autoModelLoadAttempted]);

  const chatWidth = Math.max(MIN_CHAT_WIDTH, 100 - layout.guideWidth - layout.loaderWidth);
  const bottomHeight = Math.max(0, 100 - layout.topHeight);

  useEffect(() => {
    console.log('Initializing worker... BUILD 2026-0520-V1');
    const analysisWorker = new Worker(
      new URL('./workers/analysis.worker.js', import.meta.url)
    );
    console.log('Worker instance created:', analysisWorker);

    analysisWorker.onmessage = (event) => {
      const { type, data, error, message } = event.data;
      
      console.log('Worker message received:', type, data ?? message);
      
      if (type === 'INIT_SUCCESS') {
        console.log('Analysis worker initialized');
        showToast({
          message: 'Analysis engine ready',
          intent: 'success',
          timeout: 2000,
        });
      } else if (type === 'DATA_LOADED') {
        console.log('Data loaded successfully:', data);

        if (data.modality === 'spatial' && data.spatialCoordinates) {
          console.log('Spatial data with precomputed coordinates detected - disabling auto-clustering');
          setAutoClusterIssued(true);
        }
        if (data.modality === 'atac') {
          console.log('ATAC data - pipeline runs on load, disabling auto-clustering');
          setAutoClusterIssued(true);
        }
        if (data.modality === 'multiome') {
          console.log('Multiome data - precomputed analysis, disabling auto-clustering');
          setAutoClusterIssued(true);
          if (data.peaks) {
            setDataInfo(prev => prev ? { ...prev, peaks: data.peaks } : prev);
          }
        }
        if (data.modality === 'integration' || data.modality === 'atac-integration' || data.modality === 'xenium-integration' || data.modality === 'visium-hd-integration' || data.modality === 'merfish-integration') {
          setAutoClusterIssued(true);
        }

        if (data.hasPolygons) {
          console.log('Visium HD data with polygon boundaries detected:', data.polygons?.length, 'cells');
        }

        setDataInfo(prev => {
          const nextCoords = data.spatialCoordinates || prev?.spatialCoordinates;
          const nextExtent = data.spatialExtent || prev?.spatialExtent;
          const hasSpatialCoords = Array.isArray(nextCoords) && nextCoords.length > 0;
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
                  return prev?.dataType === 'binned'
                    ? { maxLevels: 9, baseSamplesPerTile: 3200, levelSampleMultiplier: 1.8, hardSampleCap: 100000 }
                    : { maxLevels: 9, baseSamplesPerTile: 1600, levelSampleMultiplier: 1.8, hardSampleCap: 50000 };
                })())
              : prev?.spatialIndex,
            spatialReady: prev?.spatialReady || (modality === 'spatial' && hasSpatialCoords),
            modality,
            datasetNames: data.datasetNames || prev?.datasetNames || null,
            perSampleSpatial: data.perSampleSpatial || prev?.perSampleSpatial || null,
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
        console.log('====== ANALYSIS_COMPLETE received ======');
        console.log('Data type:', data.type);
        console.log('Full data:', data);
        if (data.type === 'dataset_list') {
          chatBotRef.current?.handleDatasetListResult?.(data);
          setIsAnalyzing(false);
          return;
        }
        chatBotRef.current?.handleAnalysisResultForAgent?.({ data });
        console.log('Message type check:', {
          isUmap: data.type === 'umap',
          isGeneExpression: data.type === 'gene_expression',
          isGeneViolin: data.type === 'gene_violin',
          isGeneDotplot: data.type === 'gene_dotplot',
          actualType: data.type,
        });
        const modality = dataInfoRef.current?.modality;
        if (data.source === 'precomputed') {
          setAutoClusterIssued(true);
        }
        if (data.type === 'umap' && !geneNamesReadyRef.current) {
          analysisWorker.postMessage({ type: 'GET_GENE_NAMES' });
        }

        if (data.type === 'umap') {
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
            console.log('Reclustering detected - cleared cluster labels, color overrides, region plot, and fragment coverage cache');
          }

          if (modality === 'multiome') {
            setRnaClusterHighlightOnAtac(null);
            setAtacClusterHighlightOnRna(null);
            setLegendHighlightSelection(null);
          }

          if (data.multiomeModality === 'atac') {
            if (data.source === 'wnn-individual') {
              setWnnAtacPlot({ source: 'analysis', data });
              setAtacClusterLabelMap({});
              setAtacClusterColorOverrides({});
              pendingSaveDataRef.current = { ...(pendingSaveDataRef.current || {}), wnnAtacUmapData: data, wnnWasActive: true };
              return;
            }
            const atacPayload = { source: 'analysis', data };
            if (!data.realigned || !wnnActiveRef.current) {
              setAtacClusterPlot(atacPayload);
              setAtacActivePlot(null);
            }
            const isWNN = data.source === 'wnn';
            console.log(isWNN ? 'Set ATAC cluster plot from WNN co-embedding' : 'Set ATAC cluster plot for multiome');
            showToast({
              message: isWNN
                ? 'WNN complete, 3-panel view ready (RNA / ATAC / WNN)'
                : 'ATAC UMAP updated (colored by ATAC clusters)',
              intent: 'success',
              timeout: isWNN ? 4000 : 2000,
            });
            pendingSaveDataRef.current = { ...(pendingSaveDataRef.current || {}), atacUmapData: data };
            scheduleResultsSave();
            if (isWNN) {
              lastSavedPayloadHashRef.current = null;
              doSaveResults();
            }
            if (!pendingMultiomeGenePlotRef.current) {
              setIsAnalyzing(false);
              setWorkerStatusMessage('');
            }
            return;
          }

          if (modality === 'multiome') {
            if (data.source === 'wnn-individual') {
              setWnnRnaPlot({ source: 'analysis', data });
              setClusterLabelMap({});
              setClusterColorOverrides({});
              pendingSaveDataRef.current = { ...(pendingSaveDataRef.current || {}), wnnRnaUmapData: data, wnnWasActive: true };
              return;
            }
            if (data.source === 'wnn') {
              setWnnActive(true);
              setWnnClusterLabelMap({});
              setWnnClusterColorOverrides({});
              setWnnCrossHighlight(null);
            } else if (data.wnnMerged) {
              setWnnCrossHighlight(null);
            } else if (!data.realigned) {
              setWnnActive(false);
            }
            setActivePlot(null);
            setLastActiveArtifactId(null);
          }

          if (data.integrationViews && data.datasetNames) {
            setClusterPlot({ source: 'analysis', data });
            setIntegrationShowClustersOnly(true);
            if (data.source !== 'merged') {
              setActivePlot(null);
              setLastActiveArtifactId(null);
            }
            if (data.restoredClusterLabelMap && Object.keys(data.restoredClusterLabelMap).length > 0) {
              setClusterLabelMap(data.restoredClusterLabelMap);
            }
            if (data.restoredClusterColorOverrides && Object.keys(data.restoredClusterColorOverrides).length > 0) {
              setClusterColorOverrides(data.restoredClusterColorOverrides);
            }
            if (Array.isArray(data.restoredAgentClusterAnnotations) && data.restoredAgentClusterAnnotations.length > 0) {
              setAgentAnnotationRows(data.restoredAgentClusterAnnotations);
            }
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
            pendingSaveDataRef.current = { ...(pendingSaveDataRef.current || {}), umapData: data };
            scheduleResultsSave();
            return;
          }

          const umapPayload = { source: 'analysis', data };

          if (data.source === 'banksy') {
            setRegionPlot(umapPayload);
          } else {
            if (!data.realigned || !wnnActiveRef.current) {
              setClusterPlot(umapPayload);
            }
          }
          if (modality === 'spatial' || modality === 'atac') {
            setActivePlot(umapPayload);
            setLastActiveArtifactId(null);
          }
          if (modality === 'atac') {
            setIsAnalyzing(false);
            setWorkerStatusMessage('');
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
            
            const coords = data.spatialCoordinates || prev.spatialCoordinates;
            const shouldRebuildIndex = data.spatialCoordinates && Array.isArray(coords) && coords.length > 0;
            
            if (data.spatialCoordinates) {
              console.log(`Updating spatial coordinates from reanalysis: ${data.spatialMatched}/${coords.length} matched`);
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
          if (data.restoredClusterLabelMap && Object.keys(data.restoredClusterLabelMap).length > 0) {
            setClusterLabelMap(data.restoredClusterLabelMap);
          }
          if (data.restoredClusterColorOverrides && Object.keys(data.restoredClusterColorOverrides).length > 0) {
            setClusterColorOverrides(data.restoredClusterColorOverrides);
          }
          if (Array.isArray(data.restoredAgentClusterAnnotations) && data.restoredAgentClusterAnnotations.length > 0) {
            setAgentAnnotationRows(data.restoredAgentClusterAnnotations);
          }
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
          if (data.source === 'banksy') {
            const prev = pendingSaveDataRef.current || {};
            if (!prev.umapData && clusterPlotRef.current?.data) {
              prev.umapData = clusterPlotRef.current.data;
              console.log('BANKSY save: populated umapData from clusterPlotRef fallback');
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
            console.log('BANKSY save: regionData set, umapData present:', !!pendingSaveDataRef.current.umapData,
              'regionClusters length:', data.clusters?.length, 'regionNclusters:', data.nClusters);
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
          if (!data.multiomeModality && modality === 'multiome') {
            pendingMultiomeGenePlotRef.current = true;
          }
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

            const currentDataPath = dataPathRef.current;
            const willQueryFragments =
              data.region &&
              data.cellBarcodes?.length > 0 &&
              data.clusters?.length > 0 &&
              currentDataPath &&
              window.electron?.queryAtacFragments;

            console.log(`Multiome ATAC fragment query conditions:
  - hasRegion: ${!!data.region} (${data.region ? `${data.region.chrom}:${data.region.start}-${data.region.end}` : 'null'})
  - cellBarcodesLength: ${data.cellBarcodes?.length ?? 'undefined'}
  - clustersLength: ${data.clusters?.length ?? 'undefined'}
  - currentDataPath: ${currentDataPath ?? 'undefined'}
  - hasQueryAtacFragments: ${!!window.electron?.queryAtacFragments}
  - willQueryFragments: ${willQueryFragments}`);

            if (willQueryFragments) {
              const fragmentsPath = `${currentDataPath}/atac_fragments.tsv.gz`;
              const fragmentCacheKey = `${fragmentsPath}|${data.region.chrom}|${data.region.start}|${data.region.end}`;
              const cachedCoverage = atacFragmentCoverageCacheRef.current.get(fragmentCacheKey);
              if (cachedCoverage) {
                atacArtifact.coverageByCluster = cachedCoverage;
                atacArtifact.fragmentBased = true;
                console.log('Multiome: using cached fragment coverage for', data.geneName);
              } else {
                atacArtifact.coverageByCluster = null;
                runFragmentQuery(async () => {
                  try {
                    console.log('Multiome: querying ATAC fragments from:', fragmentsPath);
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
                });
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
            if (pendingFragmentQueriesRef.current === 0) {
              setIsAnalyzing(false);
              setWorkerStatusMessage('');
            }
            return;
          }

          const appliedColorMap = data.colorMap || pendingGeneColorMap || defaultColorMap;
          setPendingGeneColorMap(null);
          const artifactId = `plot_${Date.now()}`;

          console.log('App.jsx: Creating gene expression artifact', {
            geneName: data.geneName,
            expressionLength: data.expression?.length,
            coordinatesLength: data.coordinates?.length,
            spatialCoordinatesLength: data.spatialCoordinates?.length,
            expressionType: data.expression?.constructor?.name,
            hasExpression: !!data.expression,
            isArray: Array.isArray(data.expression),
            isTypedArray: ArrayBuffer.isView(data.expression),
            hasCoordinates: Array.isArray(data.coordinates),
            hasSpatialCoordinates: Array.isArray(data.spatialCoordinates),
            expressionSample: data.expression ? Array.from(data.expression.slice(0, 5)) : null,
            isAtac: data.isAtac,
            hasCellBarcodes: !!data.cellBarcodes,
            hasClusters: !!data.clusters,
          });

          const currentDataPath = dataPathRef.current;

          const willQueryFragments =
            data.isAtac &&
            data.region &&
            data.cellBarcodes?.length > 0 &&
            data.clusters?.length > 0 &&
            currentDataPath &&
            window.electron?.queryAtacFragments;

          let finalCoverageByCluster = willQueryFragments ? null : data.coverageByCluster;

          console.log(`Fragment query conditions:
  - isAtac: ${data.isAtac}
  - hasRegion: ${!!data.region} (${data.region ? `${data.region.chrom}:${data.region.start}-${data.region.end}` : 'null'})
  - cellBarcodesLength: ${data.cellBarcodes?.length ?? 'undefined'}
  - clustersLength: ${data.clusters?.length ?? 'undefined'}
  - currentDataPath: ${currentDataPath ?? 'undefined'}
  - hasQueryAtacFragments: ${!!window.electron?.queryAtacFragments}
  - willQueryFragments: ${willQueryFragments}`);

          if (willQueryFragments) {
            const fragmentsPath = `${currentDataPath}/fragments.tsv.gz`;
            const fragmentCacheKey = `${fragmentsPath}|${data.region.chrom}|${data.region.start}|${data.region.end}`;
            const cachedCoverage = atacFragmentCoverageCacheRef.current.get(fragmentCacheKey);
            if (cachedCoverage) {
              finalCoverageByCluster = cachedCoverage;
              console.log('Using cached fragment coverage for', data.geneName);
            } else {
              runFragmentQuery(async () => {
                try {
                  console.log('Querying ATAC fragments for region:', data.region, 'from:', fragmentsPath);

                  const barcodeToCluster = {};
                  const numMapped = Math.min(data.cellBarcodes.length, data.clusters.length);
                  for (let i = 0; i < numMapped; i++) {
                    barcodeToCluster[data.cellBarcodes[i]] = data.clusters[i];
                  }
                  console.log('Built barcodeToCluster mapping:', numMapped, 'cells');

                  const result = await window.electron.queryAtacFragments({
                    fragmentsPath,
                    region: data.region,
                    cellBarcodes: data.cellBarcodes,
                    barcodeToCluster,
                    clusterMeanDepths: data.clusterMeanDepths || null,
                    binSize: 25,
                  });

                  if (result.success && result.coverageByCluster?.length > 0) {
                    console.log(`Fragment-based coverage computed: ${result.fragmentCount} fragments, ${result.coverageByCluster.length} clusters`);

                    atacFragmentCoverageCacheRef.current.set(fragmentCacheKey, result.coverageByCluster);

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
                    if (data.coverageByCluster?.length > 0) {
                      setArtifacts(prev => prev.map(a =>
                        a.id === artifactId ? { ...a, coverageByCluster: data.coverageByCluster } : a
                      ));
                    }
                  }
                } catch (err) {
                  console.warn('Failed to query ATAC fragments:', err);
                  if (data.coverageByCluster?.length > 0) {
                    setArtifacts(prev => prev.map(a =>
                      a.id === artifactId ? { ...a, coverageByCluster: data.coverageByCluster } : a
                    ));
                  }
                }
              });
            }
          }

          const isMultiomeRnaMessage = modality === 'multiome' && !data.multiomeModality && !data.isAtac;
          const showPeakViewAsPrimary = isMultiomeRnaMessage ? false : pendingShowPeakViewRef.current;
          if (!isMultiomeRnaMessage && pendingShowPeakViewRef.current) pendingShowPeakViewRef.current = false;

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
            coordinates: data.coordinates,
            spatialCoordinates: data.spatialCoordinates,
            expression: data.expression,
            expressionRange: data.expressionRange,
            colorMap: appliedColorMap,
            peaksOnGene: data.peaksOnGene,
            coverageByCluster: finalCoverageByCluster,
            fragmentBased: !!finalCoverageByCluster,
            region: data.region,
            genome: data.genome,
            isAtac: data.isAtac || false,
            viewCoverageByCluster: initialViewCoverageByCluster,
            showPeakViewAsPrimary: showPeakViewAsPrimary,
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
            const iViews = data.integrationViews;
            const datasetNames = data.datasetNames || dataInfoRef.current?.datasetNames;

            if (iViews && datasetNames) {
              runFragmentQuery(async () => {
                try {
                  const updatedViewCoverage = {};
                  let totalFragments = 0;

                  for (let si = 0; si < integrationDatasets.length; si++) {
                    const ds = integrationDatasets[si];
                    const viewName = datasetNames[si];
                    const viewIndices = iViews[viewName]?.indices;
                    if (!viewName || !Array.isArray(viewIndices) || viewIndices.length === 0) continue;

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

                    const fragmentsPath = `${ds.path}/fragments.tsv.gz`;
                    const cacheKey = `${fragmentsPath}|${region.chrom}|${region.start}|${region.end}`;
                    const cached = atacFragmentCoverageCacheRef.current.get(cacheKey);
                    if (cached) {
                      updatedViewCoverage[viewName] = cached;
                      console.log(`  ${viewName}: using cached fragment coverage`);
                      continue;
                    }

                    try {
                      console.log(`  ${viewName}: querying fragments from ${fragmentsPath}`);
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
                        console.log(`  ${viewName}: ${result.fragmentCount} fragments, ${result.coverageByCluster.length} clusters`);
                      } else {
                        console.warn(`  ${viewName}: fragment query failed or empty, keeping peak-matrix coverage`);
                      }
                    } catch (err) {
                      console.warn(`  ${viewName}: fragment query error:`, err.message);
                    }
                  }

                  if (Object.keys(updatedViewCoverage).length > 0) {
                    setArtifacts(prev => prev.map(a => {
                      if (a.id !== artifactId) return a;
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
              });
            }
          }
          if (pendingMultiomeGenePlotRef.current) {
            if (multiomeGenePlotTimeoutRef.current) clearTimeout(multiomeGenePlotTimeoutRef.current);
            multiomeGenePlotTimeoutRef.current = setTimeout(() => {
              multiomeGenePlotTimeoutRef.current = null;
              pendingMultiomeGenePlotRef.current = false;
              setIsAnalyzing(false);
              setWorkerStatusMessage('');
            }, 60000);
            return;
          }
        } else if (data.type === 'gene_violin') {
          if (!data.multiomeModality && modality === 'multiome') {
            pendingMultiomeGenePlotRef.current = true;
          }

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
            const artifactId = `plot_${Date.now()}`;
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
          }
        } else if (data.type === 'gene_dotplot') {
          console.log('Received dot plot data:', {
            type: data.type,
            geneNames: data.geneNames,
            clusterIds: data.clusterIds,
            percentExpressing: data.percentExpressing,
            averageExpression: data.averageExpression,
            percentExpressingType: data.percentExpressing?.constructor?.name,
            percentExpressingLength: data.percentExpressing?.length,
            firstRowType: data.percentExpressing?.[0]?.constructor?.name,
            hasSpatialGeneExpression: !!data.spatialGeneExpression,
            multiomeModality: data.multiomeModality,
          });

          if (!data.multiomeModality && modality === 'multiome') {
            pendingMultiomeGenePlotRef.current = true;
          }

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

          const appliedColorMap = data.colorMap || pendingGeneColorMap || defaultColorMap;
          setPendingGeneColorMap(null);

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

          let spatialArtifactId = null;
          if (data.spatialGeneExpression && modality === 'spatial') {
            spatialArtifactId = `plot_${Date.now()}_spatial`;
            const umapCoordinates = clusterPlot?.source === 'analysis' ? clusterPlot.data?.coordinates : null;
            const spatialArtifact = {
              id: spatialArtifactId,
              type: 'gene_expression',
              geneName: data.spatialGeneExpression.geneName,
              coordinates: umapCoordinates,
              expression: data.spatialGeneExpression.expression,
              colorMap: appliedColorMap,
              createdAt: new Date().toISOString(),
            };
            console.log('Creating spatial gene expression artifact:', {
              id: spatialArtifactId,
              geneName: spatialArtifact.geneName,
              expressionLength: spatialArtifact.expression?.length,
              expressionType: spatialArtifact.expression?.constructor?.name,
            });
            setArtifacts(prev => [...prev, dotplotArtifact, spatialArtifact]);
            setActivePlot({
              source: 'artifact',
              artifactId,
              spatialArtifactId,
            });
            console.log('Set activePlot with spatialArtifactId:', { artifactId, spatialArtifactId });
          } else {
            console.log('Not creating spatial artifact:', { hasSpatialGeneExpression: !!data.spatialGeneExpression, modality });
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
          }
          }
        } else if (data.type === 'markers') {
          setPendingGeneColorMap(null);
          setLastActiveArtifactId(null);

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
            message: `${isPeakMarkers ? 'Marker peaks' : data.featureSource === 'gene_activity' ? 'Marker (gene activity)' : 'Marker'} table ready for cluster ${data.cluster}. ${summary}`,
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
          if (!data.restored) {
            setIsAnalyzing(false);
            setWorkerStatusMessage('');
          }
          if (data.restored) {
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
            if (dataInfoRef.current?.modality === 'multiome') {
              setAtacActivePlot({ source: 'artifact', artifactId });
            } else {
              setActivePlot({ source: 'artifact', artifactId });
            }

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
          const clusterLabel = clusterLabelMapRef.current?.[String(data.cluster)] || `Cluster ${data.cluster}`;
          const cellCount = data.cellCount;
          const totalCells = data.totalCells;
          const percentage = (data.fraction * 100).toFixed(1);
          const topMarkers = data.topMarkers || [];

          const markerGenes = topMarkers.map(m => m.gene).join(', ');

          let message = `**${clusterLabel}** contains **${cellCount.toLocaleString()} cells**, which represents **${percentage}%** of the total dataset (${totalCells.toLocaleString()} cells).`;

          if (topMarkers.length > 0) {
            message += `\n\nThe top ${topMarkers.length} marker genes for this cluster are: **${markerGenes}**.`;

            const topMarker = topMarkers[0];
            const topPct = (topMarker.pct1 * 100).toFixed(0);
            message += ` The most significant marker is **${topMarker.gene}**, expressed in ${topPct}% of cells in this cluster.`;
          }

          message += `\n\n*Please see all markers for ${clusterLabel} above.*`;

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

          showToast({
            message: `Cluster info ready for ${clusterLabel}`,
            intent: 'success',
            timeout: 2000,
          });

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
          const params = data.parameters;
          const step = data.step;

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
        if (!pendingMultiomeGenePlotRef.current && pendingFragmentQueriesRef.current === 0) {
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
        setIsAnalyzing(false);
        setWorkerStatusMessage('');
      } else if (type === 'STATUS_UPDATE') {
        const statusMessage = message ?? data?.message ?? data;
        console.log('Status:', statusMessage);
        setWorkerStatusMessage(typeof statusMessage === 'string' ? statusMessage : '');
      } else if (type === 'NORMALIZATION_STATE') {
        setIsNormalizing(!!event.data.running);
      } else if (type === 'GENE_NAMES') {
        const names = event.data.names;
        if (Array.isArray(names) && names.length > 0) {
          geneNamesReadyRef.current = true;
          setGeneNames(names);
        }
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
      setWorker(null);
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
      setIsAnalyzing(false);
      setWorkerStatusMessage('');
    };

    analysisWorker.postMessage({ type: 'INIT' });
    
    setWorker(analysisWorker);

    return () => {
      analysisWorker.terminate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getResultsFolder = (path, info) => {
    if (!path || !window.electron?.checkCellpilotResults) return null;
    if (info?.integrationDatasets?.length > 0) return path;
    if (info?.atacIntegrationDatasets?.length > 0) return path;
    if (info?.xeniumIntegrationDatasets?.length > 0) return path;
    if (info?.visiumHDIntegrationDatasets?.length > 0) return path;
    if (/\.(h5|hdf5)$/i.test(path)) {
      const sep = path.includes('\\') ? '\\' : '/';
      const dir = path.substring(0, path.lastIndexOf(sep));
      return dir || null;
    }
    return path;
  };

  const handlePreviousResultsChoice = async (usePrevious) => {
    if (!previousResultsDialog) return;
    const { path, info, savedResults } = previousResultsDialog;
    setPreviousResultsDialog(null);
    await doHandleDataLoaded(path, info, usePrevious ? savedResults : null);
  };

  const handleDataLoaded = async (path, info) => {
    const resultsFolder = getResultsFolder(path, info);
    if (resultsFolder) {
      try {
        const checkResult = await window.electron.checkCellpilotResults(resultsFolder);
        if (checkResult.success && checkResult.results?.umapCoordinates?.length > 0) {
          const savedModality = checkResult.results?.modality;
          const currentModality = info?.modality;
          if (savedModality && currentModality && savedModality !== currentModality) {
          } else {
            setPreviousResultsDialog({ path, info, savedResults: checkResult.results });
            return;
          }
        }
      } catch (e) {
        console.warn('CellPilot: could not check for previous results:', e);
      }
    }
    await doHandleDataLoaded(path, info, null);
  };

  const doHandleDataLoaded = async (path, info, previousResults) => {
    setDataPath(path);
    setGeneNames(null);
    geneNamesReadyRef.current = false;
    pendingSaveDataRef.current = null;
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
    lastSavedPayloadHashRef.current = null;
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
        console.log('Reading data from:', path);
        let result;
        
        if (info.modality === 'integration' && info.integrationDatasets) {
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
          console.log('Sending integration data to worker:', payload.datasets.length, 'datasets');
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous integration results...' : 'Loading integration...');
          worker.postMessage(payload, transferables);
          return;
        }
        if (info.modality === 'atac-integration' && info.atacIntegrationDatasets) {
          const payload = { type: 'LOAD_DATA', modality: 'atac-integration', path, info: { ...info }, atacDatasets: [] };
          const transferables = [];
          for (const ds of info.atacIntegrationDatasets) {
            const f = ds.files || {};
            let matrixBuffer;
            if (f.matrix?.data) {
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
          console.log('Sending ATAC integration data to worker:', payload.atacDatasets.length, 'samples');
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous ATAC integration results...' : 'Loading ATAC integration...');
          worker.postMessage(payload, transferables);
          return;
        }
        if (info.modality === 'xenium-integration' && info.xeniumIntegrationDatasets) {
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
          const perSampleSpatialInfo = [];
          for (const ds of info.xeniumIntegrationDatasets) {
            const f = ds.files || {};
            const entry = { name: ds.name, path: ds.path, files: {} };
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
            if (f.cells?.data) {
              const cellsData = convertToUint8Array(f.cells.data, `${ds.name} cells`);
              const cellsBuf = cellsData.slice().buffer;
              entry.files.cells = { name: f.cells.name, data: cellsBuf };
              transferables.push(cellsBuf);
            }
            perSampleSpatialInfo.push({
              name: ds.name,
              metadata: ds.metadata,
              files: { analysis: f.analysis },
            });
            payload.xeniumDatasets.push(entry);
          }
          payload.perSampleSpatialInfo = perSampleSpatialInfo;
          if (previousResults) payload.previousResults = previousResults;
          console.log('Sending Xenium integration data to worker:', payload.xeniumDatasets.length, 'samples');
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous Xenium integration results...' : 'Loading Xenium integration...');
          worker.postMessage(payload, transferables);
          return;
        }
        if (info.modality === 'visium-hd-integration' && info.visiumHDIntegrationDatasets) {
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
            if (f.cellSegmentation?.data) {
              const segData = convertToUint8Array(f.cellSegmentation.data, `${ds.name} cellSegmentation`);
              const segBuf = segData.slice().buffer;
              entry.files.cellSegmentation = { name: f.cellSegmentation.name || 'cell_segmentations.geojson', data: segBuf };
              hdTransferables.push(segBuf);
            }
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
          console.log('Sending Visium HD integration data to worker:', hdPayload.visiumHDDatasets.length, 'samples');
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous Visium HD integration results...' : 'Loading Visium HD integration...');
          worker.postMessage(hdPayload, hdTransferables);
          return;
        }
        if (info.modality === 'merfish-integration' && info.merfishIntegrationDatasets) {
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
            if (f.counts?.data) {
              const countsData = convertToUint8Array(f.counts.data, `${ds.name} counts`);
              const countsBuf = countsData.slice().buffer;
              entry.files.counts = { name: f.counts.name, data: countsBuf };
              merfishTransferables.push(countsBuf);
            } else {
              throw new Error(`MERFISH sample "${ds.name}": cell_by_gene.csv missing.`);
            }
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
          console.log('Sending MERFISH integration data to worker:', merfishPayload.merfishDatasets.length, 'samples');
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous MERFISH integration results...' : 'Loading MERFISH integration...');
          worker.postMessage(merfishPayload, merfishTransferables);
          return;
        }
        if (info.modality === 'spatial') {
          result = {
            success: true,
            format: info.format,
            modality: 'spatial',
            files: info.files,
            metadata: info.metadata,
          };
        } else if (info.modality === 'multiome' && info.files) {
          result = {
            success: true,
            format: '10X Multiome',
            modality: 'multiome',
            files: info.files,
            precomputed: info.precomputed,
            cellBarcodes: info.cellBarcodes,
          };
        } else if (info.modality === 'atac' && info.files) {
          result = {
            success: true,
            format: '10X ATAC',
            modality: 'atac',
            files: info.files,
            cellBarcodes: info.cellBarcodes,
          };
        } else {
          result = await window.electron.read10xFiles(path, {
            format: info.format,
            h5FileName: info.h5FileName,
          });
        }
        
        if (!result.success) {
          throw new Error(result.error);
        }
        
        console.log('Files read successfully, preparing data transfer...', result.format);

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

        if (info.modality === 'spatial' && info.format === 'MERFISH') {
          console.log('Processing MERFISH data...');

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

          payload.files.merfishCounts = {
            name: result.files.counts.name,
            data: countsBuffer,
          };
          payload.files.merfishSpatial = {
            name: result.files.spatial.name,
            data: spatialBuffer,
          };

          transferables.push(countsBuffer, spatialBuffer);

          if (result.files.clusters?.data) {
            const clustersData = convertToUint8Array(result.files.clusters.data, 'clusters');
            const clustersBuffer = clustersData.slice().buffer;
            payload.files.merfishClusters = {
              name: result.files.clusters.name,
              data: clustersBuffer,
            };
            transferables.push(clustersBuffer);
          }

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
          console.log('MERFISH files prepared for worker:', {
            hasCounts: true,
            hasSpatial: true,
            hasClusters: !!result.files.clusters?.data,
            hasUmap: !!result.files.umap?.data,
          });

        } else if (info.modality === 'spatial' && info.format === 'CosMX') {
          console.log('Processing CosMX data...');

          const preparsedUrls = result.files.counts?.preparsedUrls;

          if (preparsedUrls) {
            payload.files.cosmxCounts = {
              name: result.files.counts.name,
              preparsedUrls,
            };
          } else {
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
          console.log('CosMX files prepared for worker:', {
            hasCounts: true,
            hasSpatial: true,
            preparsedUrls: !!preparsedUrls,
          });

        } else if (info.modality === 'spatial' && result.files.cellFeatureMatrix) {
          console.log(`Processing ${info.format} cell feature matrix...`);
          
          const cfm = result.files.cellFeatureMatrix;
          
          if (cfm.h5) {
            console.log('Using HDF5 format for spatial cell feature matrix');
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
            console.log('Using MatrixMarket format for spatial cell feature matrix');
            const matrixData = convertToUint8Array(cfm.matrix?.data, 'matrix');
            const featuresData = convertToUint8Array(cfm.features?.data, 'features');
            const barcodesData = convertToUint8Array(cfm.barcodes?.data, 'barcodes');

            if (matrixData.length === 0 || featuresData.length === 0 || barcodesData.length === 0) {
              throw new Error('One or more cell feature matrix files are empty');
            }

            const matrixBuffer = matrixData.slice().buffer;
            const featuresBuffer = featuresData.slice().buffer;
            const barcodesBuffer = barcodesData.slice().buffer;

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
            payload.info = { ...info, format: info.format === '10X Visium HD' ? '10X Xenium' : '10X Xenium' };

            transferables.push(matrixBuffer, featuresBuffer, barcodesBuffer);
          }
          
          console.log('Preparing spatialInfo for worker...');

          let cellsForWorker = null;
          let cellSegmentationForWorker = null;

          if (result.files.cells?.data) {
            console.log('result.files.cells:', 'present');
            console.log('cells data type:', result.files.cells?.data?.constructor?.name);
            console.log('cells data length:', result.files.cells?.data?.length || 0);
            try {
              const cellsData = convertToUint8Array(result.files.cells.data, 'cells');
              console.log('Converted cells data to Uint8Array, length:', cellsData.length);
              cellsForWorker = {
                name: result.files.cells.name,
                data: cellsData,
              };
            } catch (e) {
              console.error('Failed to convert cells data:', e);
            }
          }

          if (result.files.cellSegmentation?.data) {
            console.log('result.files.cellSegmentation:', 'present');
            console.log('cellSegmentation data type:', result.files.cellSegmentation?.data?.constructor?.name);
            console.log('cellSegmentation data length:', result.files.cellSegmentation?.data?.length || 0);
            try {
              const segData = convertToUint8Array(result.files.cellSegmentation.data, 'cellSegmentation');
              console.log('Converted cellSegmentation data to Uint8Array, length:', segData.length);
              cellSegmentationForWorker = {
                name: result.files.cellSegmentation.name,
                data: segData,
              };
            } catch (e) {
              console.error('Failed to convert cellSegmentation data:', e);
            }
          }

          let tissuePositionsForWorker = null;
          if (result.files.tissuePositions?.data) {
            console.log('result.files.tissuePositions:', 'present');
            console.log('tissuePositions format:', result.files.tissuePositions?.format);
            console.log('tissuePositions data length:', result.files.tissuePositions?.data?.length || 0);
            try {
              const posData = convertToUint8Array(result.files.tissuePositions.data, 'tissuePositions');
              console.log('Converted tissuePositions data to Uint8Array, length:', posData.length);
              tissuePositionsForWorker = {
                name: result.files.tissuePositions.name,
                data: posData,
                format: result.files.tissuePositions.format,
              };
            } catch (e) {
              console.error('Failed to convert tissuePositions data:', e);
            }
          }

          let barcodeMappingsForWorker = null;
          if (result.files.barcodeMappings?.data) {
            console.log('result.files.barcodeMappings:', 'present');
            console.log('barcodeMappings format:', result.files.barcodeMappings?.format);
            console.log('barcodeMappings data length:', result.files.barcodeMappings?.data?.length || 0);
            try {
              const mappingsData = convertToUint8Array(result.files.barcodeMappings.data, 'barcodeMappings');
              console.log('Converted barcodeMappings data to Uint8Array, length:', mappingsData.length);
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
            dataType: info.dataType,
          };

          console.log('spatialInfo prepared:', {
            hasCells: !!cellsForWorker,
            cellsDataLength: cellsForWorker?.data?.length,
            hasCellSegmentation: !!cellSegmentationForWorker,
            cellSegmentationDataLength: cellSegmentationForWorker?.data?.length,
            hasTissuePositions: !!tissuePositionsForWorker,
            tissuePositionsDataLength: tissuePositionsForWorker?.data?.length,
            hasBarcodeMappings: !!barcodeMappingsForWorker,
            barcodeMappingsDataLength: barcodeMappingsForWorker?.data?.length,
            hasAnalysis: !!result.files.analysis,
            dataType: info.dataType,
          });
          
        } else if (info.format === '10X Multiome' || result.format === '10X Multiome') {
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

          if (result.files?.peakAnnotation) {
            const peakAnnoData = convertToUint8Array(result.files.peakAnnotation.data, 'peakAnnotation');
            const peakAnnoBuffer = peakAnnoData.slice().buffer;
            payload.files.peakAnnotation = {
              name: result.files.peakAnnotation.name || 'atac_peak_annotation.tsv',
              data: peakAnnoBuffer,
            };
            transferables.push(peakAnnoBuffer);
          }

          payload.precomputed = result.precomputed || {};
          payload.info = { ...info, format: '10X Multiome', modality: 'multiome' };
          console.log('[App] Multiome payload prepared:',
            'cellBarcodes:', info.cellBarcodes ? info.cellBarcodes.length : 'null',
            'precomputed keys:', Object.keys(result.precomputed || {}));
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
          console.log('[App] ATAC (scATAC pipeline): matrix', useStreamedMatrix ? `${matrixFile._matrixSize} bytes (streamed)` : matrixFile.data?.byteLength ?? matrixFile.data?.length, 'bytes, barcodes:', payload.files.barcodes.length, 'peaks:', payload.files.peaks.length);
        } else if (info.format === '10X HDF5') {
          const h5File = result.files?.h5;
          if (!h5File) {
            throw new Error('HDF5 file payload missing from result');
          }

          if (h5File.h5Url) {
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

        if (previousResults) {
          payload.previousResults = previousResults;
        }
        console.log('Sending data to worker...');
        if (payload.info?.format === '10X ATAC' || payload.info?.modality === 'atac') {
          setIsAnalyzing(true);
          setWorkerStatusMessage(previousResults ? 'Loading previous scATAC results...' : 'Loading scATAC-seq...');
        }
        worker.postMessage(payload, transferables);

        const matrixFile = payload.files?.matrix;
        if (matrixFile?._chunkKey != null && matrixFile?._matrixSize != null && window.electron) {
          const CHUNK_SIZE = 80 * 1024 * 1024;
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

  const runFragmentQuery = (task) => {
    pendingFragmentQueriesRef.current += 1;
    setIsAnalyzing(true);
    setWorkerStatusMessage('Loading peak coverage from fragments...');
    const timeout = new Promise((resolve) => setTimeout(resolve, 120000));
    Promise.race([Promise.resolve().then(task), timeout]).catch(() => {}).finally(() => {
      pendingFragmentQueriesRef.current = Math.max(0, pendingFragmentQueriesRef.current - 1);
      if (pendingFragmentQueriesRef.current === 0 && !pendingMultiomeGenePlotRef.current) {
        setIsAnalyzing(false);
        setWorkerStatusMessage('');
      }
    });
  };

  const handleAnalysisRequest = (command) => {
    if (command.action === 'rename_cluster') {
      return handleRenameCluster(command);
    }
    if (command.action === 'rename_region') {
      return handleRenameRegion(command);
    }

    if (command.action === 'highlight_cluster' || command.action === 'clear_cluster_highlight') {
      const plot = clusterPlotRef.current;
      if (!plot?.data?.clusters) {
        return { error: 'There are no clusters to highlight yet. Load a dataset and let the analysis finish first.' };
      }
      const showClusterView = () => {
        if (activePlot !== plot) {
          setActivePlot(plot);
          setLastActiveArtifactId(null);
        }
      };
      const wnnLayout = isWnnLayoutShown();
      if (command.action === 'clear_cluster_highlight') {
        if (wnnLayout) setWnnCrossHighlight(null);
        else setSelectedClusters(new Set());
        showClusterView();
        return { success: true, message: 'Cleared the highlight. All clusters are shown.' };
      }
      const labels = (wnnLayout ? wnnClusterLabelMap : clusterLabelMapRef.current) || {};
      const present = new Set(plot.data.clusters.map(String));
      const requested = Array.isArray(command.params?.clusters) && command.params.clusters.length > 0
        ? command.params.clusters
        : [command.params?.cluster];
      const ids = [];
      for (const c of requested) {
        if (c === null || c === undefined || c === '') continue;
        const s = String(c).trim();
        if (present.has(s)) { ids.push(s); continue; }
        const byLabel = Object.keys(labels).filter((k) => String(labels[k]).toLowerCase() === s.toLowerCase() && present.has(k));
        if (byLabel.length === 0) {
          return { error: `Cluster "${s}" was not found. Say a cluster number or a cluster name from the legend.` };
        }
        ids.push(...byLabel);
      }
      if (ids.length === 0) {
        return { error: 'Which cluster do you want to highlight? For example: "highlight cluster 3".' };
      }
      const unique = [...new Set(ids)];
      if (wnnLayout) {
        setWnnCrossHighlight({
          sourceClusters: plot.data.clusters,
          highlightClusterId: unique[0],
          highlightClusterIds: unique,
          sourceModality: 'wnn-integrated',
        });
      } else {
        setSelectedClusters(new Set(unique));
      }
      showClusterView();
      const names = unique.map((id) => (labels[id] ? `${labels[id]} (cluster ${id})` : `cluster ${id}`));
      const where = wnnLayout ? ' of the WNN integrated UMAP, with the same cells on the RNA and ATAC views' : '';
      return { success: true, message: `Highlighting ${names.join(', ')}${where}. Say "clear the highlight" to show all clusters again.` };
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

    if (command.action === 'impute_gene') {
      if (!dataPath || !worker) {
        return { error: 'No spatial data loaded or analysis engine not ready' };
      }
      const scrnaPath = command.params?.scrnaPath;
      if (!scrnaPath) {
        return { error: 'No scRNA-seq reference path provided' };
      }
      setIsAnalyzing(true);
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
      console.log('====== APP: Handling dotplot command ======');
      console.log('Command:', command);
      console.log('Command params:', command.params);

      const requestedColor = command.params?.colorMap || defaultColorMap;
      setDefaultColorMap(requestedColor);
      setPendingGeneColorMap(requestedColor);
      setLastActiveArtifactId(null);
      pendingMultiomeGenePlotRef.current = dataInfo?.modality === 'multiome';
      setIsAnalyzing(true);

      console.log('====== APP: Posting message to worker ======');
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

      console.log('====== APP: Returning success message ======');
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

    if (command.action === 'wnn_integrate') {
      if (dataInfo?.modality !== 'multiome') {
        return { error: 'WNN integration requires multiome (RNA + ATAC) data.' };
      }
      setIsAnalyzing(true);
      worker.postMessage({
        type: 'RUN_ANALYSIS',
        command: command,
        dataPath: dataPath,
      });
      return { success: true, message: 'Running WNN integration (RNA + ATAC co-embedding)...' };
    }

    if (command.action === 'tf_motif_analysis') {
      const clusterParam = command.params?.cluster;
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

    setIsAnalyzing(true);
    worker.postMessage({
      type: 'RUN_ANALYSIS',
      command: command,
      dataPath: dataPath,
    });

    return { success: true, message: 'Analysis started...' };
  };

  const isWnnLayoutShown = () => wnnActive && wnnRnaPlot && wnnAtacPlot && dataInfo?.modality === 'multiome';
  const setWnnHighlightFromChat = (viewModality, clusterId) => {
    const sourceClusters = viewModality === 'wnn-rna' ? wnnRnaPlot?.data?.clusters : wnnAtacPlot?.data?.clusters;
    if (!Array.isArray(sourceClusters)) return false;
    if (!sourceClusters.some(c => String(c) === String(clusterId))) return false;
    setWnnCrossHighlight({ sourceClusters, highlightClusterId: String(clusterId), sourceModality: viewModality });
    return true;
  };

  const handleHighlightRnaClusterOnAtac = (clusterParam) => {
    if (clusterParam === null || clusterParam === undefined || clusterParam === '') {
      setRnaClusterHighlightOnAtac(null);
      if (isWnnLayoutShown()) setWnnCrossHighlight(null);
      return true;
    }
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
    if (isWnnLayoutShown()) return setWnnHighlightFromChat('wnn-rna', resolved);
    setRnaClusterHighlightOnAtac(resolved);
    setAtacClusterHighlightOnRna(null);
    return true;
  };

  const handleHighlightAtacClusterOnRna = (clusterParam) => {
    if (clusterParam === null || clusterParam === undefined || clusterParam === '') {
      setAtacClusterHighlightOnRna(null);
      if (isWnnLayoutShown()) setWnnCrossHighlight(null);
      return true;
    }
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
    if (isWnnLayoutShown()) return setWnnHighlightFromChat('wnn-atac', resolved);
    setAtacClusterHighlightOnRna(resolved);
    setRnaClusterHighlightOnAtac(null);
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

    let targetIndex = artifacts.findIndex(
      (artifact) => artifact.id === lastActiveArtifactId && 
                    (artifact.type === 'gene_expression' || artifact.type === 'gene_dotplot')
    );

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

    let spatialArtifactId = null;
    if (targetArtifact.type === 'gene_dotplot') {
      const spatialArtifactIndex = artifacts.findIndex(
        (artifact, idx) =>
          artifact.type === 'gene_expression' &&
          idx === targetIndex + 1 &&
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
        console.log('Updated linked spatial artifact colorMap:', spatialArtifactId);
      }
    }

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

    const newActivePlot = { source: 'artifact', artifactId: updatedArtifact.id };
    if (spatialArtifactId) {
      newActivePlot.spatialArtifactId = spatialArtifactId;
    }
    setActivePlot(newActivePlot);
    
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

    const oldKey = String(oldLabel).trim();
    const newName = String(newLabel).trim();

    if (!newName) {
      return { error: 'New cluster name cannot be empty.' };
    }

    const isAtac = multiomeTarget === 'atac';
    const isWnn = multiomeTarget === 'wnn';
    const chainMapApplies = wnnActive ? isWnn : (!isAtac && !isWnn);
    const activeLabelMap = {
      ...(isAtac ? atacClusterLabelMap : isWnn ? wnnClusterLabelMap : clusterLabelMap),
      ...(chainMapApplies ? (command._clusterLabelMapForMerge || {}) : {}),
    };
    const setActiveLabelMap = isAtac ? setAtacClusterLabelMap : isWnn ? setWnnClusterLabelMap : setClusterLabelMap;
    const activeColorOverrides = isAtac ? atacClusterColorOverrides : isWnn ? wnnClusterColorOverrides : clusterColorOverrides;
    const setActiveColorOverrides = isAtac ? setAtacClusterColorOverrides : isWnn ? setWnnClusterColorOverrides : setClusterColorOverrides;
    const modalityLabel = isAtac ? 'ATAC' : isWnn ? 'WNN' : 'RNA';

    const existingClustersWithSameName = Object.entries(activeLabelMap)
      .filter(([key, value]) => value === newName && key !== oldKey)
      .map(([key]) => key);

    if (existingClustersWithSameName.length > 0) {
      console.log(`Detected merge (${modalityLabel}): cluster ${oldKey} -> ${newName} (already used by ${existingClustersWithSameName})`);

      const targetClusterId = parseInt(existingClustersWithSameName[0]);
      const sourceClusterId = parseInt(oldKey);

      if (isNaN(targetClusterId) || isNaN(sourceClusterId)) {
        return { error: 'Cluster merging requires numeric cluster IDs.' };
      }

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

      setActiveLabelMap(prev => {
        const updated = { ...prev };
        updated[oldKey] = newName;
        updated[String(targetClusterId)] = newName;
        return updated;
      });

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
                e.currentTarget.blur();
                toasterRef.current?.clear();
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
                    stream.getVideoTracks()[0].onended = () => mediaRecorderRef.current?.stop();
                    recorder.start();
                    mediaRecorderRef.current = recorder;
                    setIsRecording(true);
                    showToast({ message: 'Recording started', intent: 'primary', timeout: 2000 });
                  } catch (err) {
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

                const viewCoverageGlobalYMax = (() => {
                  const vc = normalizedViewCoverageByCluster && Object.keys(normalizedViewCoverageByCluster).length > 0 ? normalizedViewCoverageByCluster : latestGeneExpr?.viewCoverageByCluster;
                  if (!vc || typeof vc !== 'object' || Array.isArray(vc)) return null;
                  const MIN_CELLS_FOR_YMAX = 10;
                  let qualifiedMax = 0;
                  let fallbackMax = 0;
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

                const integrationViolinOrDotplotArtifact = (() => {
                  if (activePlot?.source !== 'artifact') return null;
                  const art = artifacts.find((a) => a.id === activePlot.artifactId);
                  if (!art || (art.type !== 'gene_violin' && art.type !== 'gene_dotplot') || !art.integrationViews) return null;
                  return art;
                })();

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

                if (dataInfo?.modality === 'xenium-integration') {
                  const xeniumShowGeneExpr = latestGeneExpr && !integrationViolinOrDotplotArtifact && activePlot != null && !integrationShowClustersOnly;
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
                        const sampleGeneExprActivePlot = xeniumShowGeneExpr && sampleDataInfo && Array.isArray(indices) ? {
                          source: 'analysis',
                          data: {
                            type: 'gene_expression',
                            expression: indices.map((i) => latestGeneExpr.expression[i] ?? 0),
                            geneName: latestGeneExpr.geneName,
                            colorMap: latestGeneExpr.colorMap,
                          },
                        } : null;

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
                            expressionRange: latestGeneExpr.expressionRange ?? null,
                          },
                        };
                      })();

                      const isPeakViewOnly = (() => {
                        if (dataInfo?.modality !== 'atac-integration') return false;
                        if (!activePlot || activePlot.source !== 'artifact') return false;
                        const art = artifacts.find((a) => a.id === activePlot.artifactId);
                        return !!(art?.showPeakViewAsPrimary);
                      })();

                      const activePlotForView = integrationViolinOrDotplotArtifact
                        ? { source: 'artifact', artifactId: integrationViolinOrDotplotArtifact.id, viewName }
                        : isPeakViewOnly ? subsetPlot
                        : subsetPlot;
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
            {wnnActive && wnnRnaPlot && wnnAtacPlot && dataInfo?.modality === 'multiome' ? (
              <>
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
                        if (activePlot?.source === 'artifact') {
                          const art = artifacts.find(a => a.id === activePlot.artifactId);
                          if (art?.type === 'tf_motif_enrichment' || art?.type === 'gene_dotplot') return activePlot;
                        }
                        return wnnRnaPlot;
                      })()}
                      geneExpression={(() => {
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
                <div className="visualization-card interaction-card" style={{ flex: '1 1 0%', minWidth: 0 }}>
                  <div className="visualization-card-header">
                    <Icon icon="chart" size={18} />
                    <span>{(() => {
                      if (atacActivePlot?.source === 'artifact') {
                        const art = artifacts.find(a => a.id === atacActivePlot.artifactId);
                        if (art?.type === 'gene_expression' && art.isAtac && art.showPeakViewAsPrimary) return `Peak View, ${art.geneName}`;
                        if (art?.type === 'gene_expression' && art.isAtac) return `ATAC View, ${art.geneName} activity`;
                        if (art?.type === 'peak_gene_links') return `Links, ${art.gene}`;
                      }
                      return 'ATAC View';
                    })()}</span>
                  </div>
                  <div className="visualization-card-body">
                    <PlotView
                      activePlot={(() => {
                        if (atacActivePlot?.source === 'artifact') {
                          const art = artifacts.find(a => a.id === atacActivePlot.artifactId);
                          if (art?.type === 'peak_gene_links') return atacActivePlot;
                          if (art?.type === 'gene_expression' && art.showPeakViewAsPrimary) return atacActivePlot;
                        }
                        return wnnAtacPlot;
                      })()}
                      geneExpression={(() => {
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
                    if (dataInfo?.modality === 'multiome' && rnaClusterHighlightOnAtac != null) {
                      return clusterPlot;
                    }
                    if (dataInfo?.modality === 'multiome' && atacActivePlot?.source === 'artifact') {
                      const atacArt = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                      if (atacArt?.showPeakViewAsPrimary) return atacClusterPlot;
                    }
                    if (dataInfo?.modality === 'multiome' && activePlot?.source === 'artifact') {
                      const art = artifacts.find((a) => a.id === activePlot.artifactId);
                      if (art?.type === 'gene_dotplot' || art?.type === 'tf_motif_enrichment') return activePlot;
                    }
                    if (dataInfo?.modality === 'multiome' && activePlot?.source === 'analysis' && activePlot?.data?.type === 'gene_violin') {
                      return activePlot;
                    }
                    if (dataInfo?.modality === 'multiome' && activePlot?.source === 'analysis' && activePlot?.data?.type === 'markers') {
                      return activePlot;
                    }
                    if (dataInfo?.modality === 'atac' && activePlot?.data?.type === 'umap') {
                      return activePlot;
                    }
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
                    if (dataInfo?.modality === 'multiome' && rnaClusterHighlightOnAtac != null) {
                      return null;
                    }
                    if (dataInfo?.modality === 'multiome' && atacActivePlot?.source === 'artifact') {
                      const atacArt = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                      if (atacArt?.showPeakViewAsPrimary) return null;
                    }
                    if (dataInfo?.modality === 'multiome' && activePlot?.source === 'artifact') {
                      const art = artifacts.find((a) => a.id === activePlot.artifactId);
                      if (art?.type === 'gene_expression' && !art.isAtac) return activePlot;
                    }
                    if (dataInfo?.modality === 'atac' && activePlot?.source === 'artifact') {
                      const art = artifacts.find((a) => a.id === activePlot.artifactId);
                      if (art?.type === 'gene_expression') return activePlot;
                    }
                    if (dataInfo?.modality !== 'spatial' || !activePlot) {
                      return null;
                    }

                    if (activePlot.spatialArtifactId) {
                      const result = { source: 'artifact', artifactId: activePlot.spatialArtifactId };
                      console.log('App.jsx geneExpression filter: Found spatialArtifactId', { spatialArtifactId: activePlot.spatialArtifactId, result });
                      const artifact = artifacts.find(a => a.id === activePlot.spatialArtifactId);
                      console.log('App.jsx geneExpression filter: Spatial artifact lookup', {
                        artifactId: activePlot.spatialArtifactId,
                        found: !!artifact,
                        hasCoordinates: !!artifact?.coordinates,
                        hasExpression: !!artifact?.expression,
                        coordinatesLength: artifact?.coordinates?.length
                      });
                      return result;
                    }

                    if (activePlot.source === 'artifact') {
                      const artifact = artifacts.find(a => a.id === activePlot.artifactId);
                      if (artifact && artifact.type === 'gene_expression') {
                        console.log('App.jsx geneExpression filter: Found gene_expression artifact', { artifactId: activePlot.artifactId });
                        return activePlot;
                      }
                    } else if (activePlot.source === 'analysis' && activePlot.data?.type === 'gene_expression') {
                      console.log('App.jsx geneExpression filter: Found analysis gene_expression', { dataType: activePlot.data?.type });
                      return activePlot;
                    }
                    console.log('App.jsx geneExpression filter: No match, returning null', { activePlot });
                    return null;
                  })()}
                  artifacts={artifacts}
                  dataInfo={dataInfo}
                  selectedClusters={(() => {
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
                      if (dataInfo?.modality === 'multiome' && atacClusterHighlightOnRna != null) {
                        return atacClusterPlot;
                      }
                      if (atacActivePlot?.source === 'artifact') {
                        const art = artifacts.find((a) => a.id === atacActivePlot.artifactId);
                        if (art?.type === 'gene_expression' && art?.showPeakViewAsPrimary) {
                          return atacActivePlot;
                        }
                        if (art?.type === 'peak_gene_links') {
                          return atacActivePlot;
                        }
                        if (art?.type === 'gene_dotplot') {
                          return atacActivePlot;
                        }
                      }
                      if (atacActivePlot?.source === 'analysis' && atacActivePlot?.data?.type === 'gene_violin') {
                        return atacActivePlot;
                      }
                      if (atacActivePlot?.source === 'analysis' && atacActivePlot?.data?.type === 'markers') {
                        return atacActivePlot;
                      }
                      return atacClusterPlot;
                    })()}
                    geneExpression={(() => {
                      if (dataInfo?.modality === 'multiome' && atacClusterHighlightOnRna != null) {
                        return null;
                      }
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
                      if (activePlot?.source === 'analysis' && activePlot?.data?.type === 'markers') return activePlot;
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
              dataLoaded={Number.isFinite(dataInfo?.cells) && Number.isFinite(dataInfo?.genes)}
              dataInfo={dataInfo}
              geneNames={geneNames}
              selectedModel={selectedModel}
              clusterLabelMap={clusterLabelMap}
              atacClusterLabelMap={atacClusterLabelMap}
              wnnActive={wnnActive}
              wnnClusterLabelMap={wnnClusterLabelMap}
              spatialSelection={spatialSelection}
              rnaClusters={clusterPlot?.source === 'analysis' ? clusterPlot.data?.clusters : null}
              atacClusters={atacClusterPlot?.source === 'analysis' ? atacClusterPlot.data?.clusters : null}
              wnnClusters={wnnActive && clusterPlot?.source === 'analysis' ? clusterPlot.data?.clusters : null}
              isAnalyzing={isAnalyzing || isNormalizing}
              analysisStatusMessage={workerStatusMessage || (isNormalizing ? 'Normalizing the data... the chat will be ready shortly' : '')}
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
                  console.log('Model loaded:', modelId);
                  toasterRef.current?.show({
                    message: `Intent model loaded: ${modelId}`,
                    intent: 'success',
                    icon: 'tick-circle',
                  });
                }}
                selectedChatModel={selectedChatModel}
                onChatModelChange={setSelectedChatModel}
                onChatModelLoaded={(modelId) => {
                  console.log('Chat model loaded:', modelId);
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
