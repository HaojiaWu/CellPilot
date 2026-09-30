import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { ScreenGridLayer } from '@deck.gl/aggregation-layers';
import { Icon, Spinner, Button, ButtonGroup } from '@blueprintjs/core';
import * as d3 from 'd3';
import OpenSeadragon from 'openseadragon';
import { gatherDensitySample, gatherSamplesForViewport } from '../utils/spatialIndex';
import { createBlankTileSource } from '../utils/blankTileSource';
import HistologyImageDialog from './HistologyImageDialog';
import OSDWebGLOverlay from '../utils/osdWebGLOverlay';
import './PlotView.css';

const BASE_COLOR = [102, 126, 234, 200];
const MAX_SAMPLE_POINTS = 200_000;
const VISIUM_HD_SEGMENTED_MAX_SAMPLE_POINTS = 400_000;
const VISIUM_HD_BINNED_MAX_SAMPLE_POINTS = 800_000;
const DENSITY_THRESHOLD = 2_500_000;
const INITIAL_MIN_ZOOM_PAD = 20;
const INITIAL_MAX_ZOOM_PAD = 24;
const ZOOM_SCALE_PER_LEVEL = 1.5;
const MIN_ZOOM_SCALE = 0.3;
const MAX_ZOOM_SCALE = 12;
const XENIUM_ZOOM_SCALE_PER_LEVEL = 1.25;
const XENIUM_MAX_ZOOM_SCALE = 6;

const DENSITY_COLOR_RANGE = [
  [255, 255, 255, 0],
  [198, 219, 239, 70],
  [158, 202, 225, 120],
  [107, 174, 214, 170],
  [49, 130, 189, 220],
  [8, 81, 156, 255],
];

const ROI_SELECTION_FILL = 'rgba(17, 24, 39, 0.06)';

const interpolateMap = {
  viridis: d3.interpolateViridis,
  magma: d3.interpolateMagma,
  inferno: d3.interpolateInferno,
  plasma: d3.interpolatePlasma,
  cividis: d3.interpolateCividis,
  turbo: d3.interpolateTurbo,
  cubehelix: d3.interpolateCubehelixDefault,
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const baseClusterPalette = [
  ...d3.schemeCategory10,
  ...(d3.schemeSet3 || []),
  ...(d3.schemePaired || []),
  ...(d3.schemeDark2 || []),
];

const ensurePaletteLength = (targetSize) => {
  if (targetSize <= baseClusterPalette.length) {
    return baseClusterPalette.slice(0, targetSize);
  }
  const palette = baseClusterPalette.slice();
  const needed = targetSize - palette.length;
  const extras = d3.quantize(d3.interpolateTurbo, needed + 2).slice(1, needed + 1);
  return palette.concat(extras);
};

const sortClusterIds = (ids) =>
  ids
    .slice()
    .sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      const validA = !Number.isNaN(numA);
      const validB = !Number.isNaN(numB);
      if (validA && validB) {
        return numA - numB;
      }
      return String(a).localeCompare(String(b));
    });

const createClusterColorScale = (clusterIds) => {
  if (!Array.isArray(clusterIds) || clusterIds.length === 0) {
    return null;
  }
  const sortedIds = sortClusterIds(clusterIds);
  const domain = sortedIds.map((id) => String(id));
  const palette = ensurePaletteLength(domain.length);
  return d3.scaleOrdinal(palette).domain(domain);
};

const createColorFunction = (colorDef, minExp, maxExp) => {
  const clamp01 = (value) => Math.max(0, Math.min(1, value));
  const safeRange = maxExp - minExp || 1;

  if (colorDef?.type === 'custom' && Array.isArray(colorDef.colors) && colorDef.colors.length >= 2) {
    const colors = colorDef.colors;
    const steps = colors.length - 1;
    const domain = colors.map((_, idx) => minExp + (safeRange * idx) / steps);
    const scale = d3.scaleLinear().domain(domain).range(colors);
    return (value) => scale(value);
  }

  if (colorDef?.type === 'scheme' && colorDef?.name) {
    const name = colorDef.name.toLowerCase();
    const interpolator = interpolateMap[name] || d3.interpolateViridis;
    return (value) => interpolator(clamp01((value - minExp) / safeRange));
  }

  const defaultColors = ['lightgray', 'orange', 'red'];
  const steps = defaultColors.length - 1;
  const domain = defaultColors.map((_, idx) => minExp + (safeRange * idx) / steps);
  const scale = d3.scaleLinear().domain(domain).range(defaultColors);
  return (value) => scale(value);
};

const colorToRgba = (value, fallback = BASE_COLOR) => {
  if (!value) {
    return fallback;
  }

  if (Array.isArray(value) && value.length >= 3) {
    const alpha = value.length > 3 ? value[3] : 255;
    return [value[0], value[1], value[2], alpha];
  }

  if (typeof value === 'string' && value.toLowerCase().trim() === 'transparent') {
    return [0, 0, 0, 0];
  }

  const parsed = d3.color(value);
  if (!parsed) {
    return fallback;
  }
  return [
    parsed.r,
    parsed.g,
    parsed.b,
    Math.round((parsed.opacity ?? 1) * 255),
  ];
};

const formatClusterLabel = (label, labelMap = {}) => {
  if (label == null) {
    return '';
  }
  const key = String(label).trim();
  
  if (labelMap && labelMap[key]) {
    return labelMap[key];
  }
  
  const numericMatch = key.match(/-?\d+(?:\.\d+)?/);
  if (numericMatch) {
    return numericMatch[0];
  }
  const stripped = key.replace(/^cluster\s*/i, '').trim();
  return stripped || key;
};

const computeViewBounds = (view, width, height) => {
  if (!view) {
    return null;
  }
  const viewportWidth = width || view.width || 1;
  const viewportHeight = height || view.height || 1;
  const scale = Math.pow(2, view.zoom || 0);
  const halfWidth = viewportWidth / scale / 2;
  const halfHeight = viewportHeight / scale / 2;

  return {
    xMin: view.target[0] - halfWidth,
    xMax: view.target[0] + halfWidth,
    yMin: view.target[1] - halfHeight,
    yMax: view.target[1] + halfHeight,
  };
};

const SpatialPlotView = ({ activePlot, clusterPlot, regionPlot, artifacts, dataInfo, selectedClusters = new Set(), clusterColorOverrides = {}, clusterLabelMap = {}, regionLabelMap = {}, legendHighlightSelection = null, maxSamplePoints = null, cellIndexMap = null, onSpatialRegionSelected = null }) => {
  const containerRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [viewState, setViewState] = useState(null);
  const [imageInfo, setImageInfo] = useState(null);
  const showBackgroundImage = false;
  const [histologyImage, setHistologyImage] = useState(null);
  const [transformationMatrix, setTransformationMatrix] = useState(null);
  const [histologyImageBounds, setHistologyImageBounds] = useState(null);
  const [loadingHistology, setLoadingHistology] = useState(false);
  const [showHistologyDialog, setShowHistologyDialog] = useState(false);

  const osdContainerRef = useRef(null);
  const osdViewerRef = useRef(null);
  const osdSizeRef = useRef(null);
  const isSyncingRef = useRef(false);
  const osdWebGLOverlayRef = useRef(null);
  const [imageOpacity] = useState(0.8);
  const [osdViewerReady, setOsdViewerReady] = useState(false);
  const [overlayReady, setOverlayReady] = useState(false);

  const [osdViewState, setOsdViewState] = useState(null);
  const osdViewStateRef = useRef(null);
  const isUpdatingFromOsdRef = useRef(false);

  const spatialReady = dataInfo?.spatialReady;
  const spatialIndex = spatialReady ? dataInfo?.spatialIndex : null;
  const totalCells = spatialIndex?.pointCount || 0;
  const hasCoordinates = Boolean(spatialReady && spatialIndex && totalCells > 0);

  const spatialScaleFactor = dataInfo?.spatialScaleFactor ?? 0.2125;
  const histologyPrealigned = dataInfo?.histologyPrealigned ?? false;
  const needsScaling = spatialScaleFactor !== 1.0;

  const isVisiumHD = dataInfo?.format === '10X Visium HD';

  const hasPolygons = dataInfo?.hasPolygons || false;
  const polygonData = hasPolygons ? dataInfo?.polygons : null;

  useEffect(() => {
    if (hasPolygons && polygonData) {
      console.log('SpatialPlotView: Visium HD polygon data available', {
        hasPolygons,
        polygonCount: polygonData?.length || 0,
        samplePolygon: polygonData?.[0] || null,
      });
    }
  }, [hasPolygons, polygonData]);

  const [baseZoom, setBaseZoom] = useState(null);
  const [samplingViewState, setSamplingViewState] = useState(null);
  const samplingRafRef = useRef(null);
  const [isHovering, setIsHovering] = useState(false);
  const [selectionMode, setSelectionMode] = useState(null);
  const [selectionDraft, setSelectionDraft] = useState(null);
  const [selectedRegions, setSelectedRegions] = useState([]);
  const selectionDragRef = useRef(null);

  useEffect(() => {
    if (selectedClusters.size === 0) {
      setIsHovering(false);
    }
  }, [selectedClusters.size]);

  const resolvedResults = useMemo(() => {
    if (activePlot) {
      if (activePlot.source === 'analysis' && activePlot.data?.type === 'gene_violin' && activePlot.spatialArtifactId) {
        const artifact = artifacts.find((artifact) => artifact.id === activePlot.spatialArtifactId) || null;
        console.log('SpatialPlotView resolvedResults: Using spatial artifact for violin plot', artifact?.type);
        return artifact;
      }
      if (activePlot.source === 'artifact' && activePlot.spatialArtifactId) {
        const artifact = artifacts.find((artifact) => artifact.id === activePlot.spatialArtifactId) || null;
        console.log('SpatialPlotView resolvedResults: Using spatial artifact for dotplot', artifact?.type);
        return artifact;
      }
      if (activePlot.source === 'artifact') {
        const artifact = artifacts.find((artifact) => artifact.id === activePlot.artifactId) || null;
        console.log('SpatialPlotView resolvedResults: Using artifact', {
          type: artifact?.type,
          geneName: artifact?.geneName,
          hasColorMap: !!artifact?.colorMap,
          colorMap: artifact?.colorMap,
        });
        return artifact;
      }
      if (activePlot.source === 'analysis' && activePlot.data) {
        const spatialCompatibleTypes = ['gene_expression', 'gene_violin'];
        if (spatialCompatibleTypes.includes(activePlot.data.type)) {
          console.log('SpatialPlotView resolvedResults: Using activePlot (spatial-compatible)', activePlot.data.type);
          return activePlot.data;
        }
        console.log('SpatialPlotView resolvedResults: Ignoring non-spatial activePlot type', activePlot.data.type);
      }
    }

    const isRegionFocused = activePlot?.data?.source === 'banksy' || activePlot?.data?.type === 'region_composition';
    if (isRegionFocused && regionPlot && regionPlot.source === 'analysis') {
      console.log('SpatialPlotView resolvedResults: Using regionPlot (BANKSY)', regionPlot.data?.type, 'regions:', regionPlot.data?.nClusters);
      return regionPlot.data || null;
    }

    if (clusterPlot && clusterPlot.source === 'analysis') {
      console.log('SpatialPlotView resolvedResults: Using clusterPlot', clusterPlot.data?.type, 'clusters:', clusterPlot.data?.clusters?.length);
      return clusterPlot.data || null;
    }

    console.log('SpatialPlotView resolvedResults: No plot data, returning null');
    return null;
  }, [activePlot, clusterPlot, regionPlot, artifacts]);

  useEffect(() => {
    if (!spatialReady) {
      setImageInfo(null);
      return;
    }
    const overviewUrl = dataInfo?.metadata?.images?.overview?.url;
    if (!overviewUrl) {
      setImageInfo(null);
      return;
    }

    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) {
        setImageInfo({
          url: overviewUrl,
          width: image.naturalWidth || image.width,
          height: image.naturalHeight || image.height,
          name: dataInfo?.metadata?.images?.overview?.name || '',
        });
      }
    };
    image.onerror = () => {
      if (!cancelled) {
        setImageInfo(null);
      }
    };
    image.src = overviewUrl;

    return () => {
      cancelled = true;
    };
  }, [dataInfo?.metadata?.images?.overview?.url, dataInfo?.metadata?.images?.overview?.name, spatialReady]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const updateDimensions = () => {
      if (!containerRef.current) {
        return;
      }
      const { clientWidth = 0, clientHeight = 0 } = containerRef.current || {};
      setDimensions({
        width: clientWidth,
        height: clientHeight,
      });
    };

    updateDimensions();
    resizeObserverRef.current = new ResizeObserver(updateDimensions);
    resizeObserverRef.current.observe(containerRef.current);

    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
    };
  }, []);

  const bounds = useMemo(() => {
    if (!spatialIndex) {
      return null;
    }
    const { xMin, xMax, yMin, yMax } = spatialIndex.bounds;
    return {
      xMin,
      xMax,
      yMin,
      yMax,
      width: xMax - xMin || 1,
      height: yMax - yMin || 1,
    };
  }, [spatialIndex]);

  useEffect(() => {
    if (!bounds || !dimensions.width || !dimensions.height) {
      return;
    }

    const centerX = (bounds.xMin + bounds.xMax) / 2;
    const centerY = (bounds.yMin + bounds.yMax) / 2;
    const scaleX = dimensions.width / bounds.width;
    const scaleY = dimensions.height / bounds.height;
    const scale = Math.max(Math.min(scaleX, scaleY), 1e-6);
    const zoom = Math.log2(scale);

    setViewState((prev) => {
      if (!prev || typeof prev.zoom !== 'number') {
        return {
          ...prev,
          target: [centerX, centerY, 0],
          zoom,
          width: dimensions.width,
          height: dimensions.height,
          minZoom: zoom - INITIAL_MIN_ZOOM_PAD,
          maxZoom: zoom + INITIAL_MAX_ZOOM_PAD,
        };
      }
      return {
        ...prev,
        width: dimensions.width,
        height: dimensions.height,
      };
    });
  }, [bounds, dimensions.width, dimensions.height]);

  useEffect(() => {
    if (baseZoom == null && typeof viewState?.zoom === 'number') {
      setBaseZoom(viewState.zoom);
    }
  }, [viewState?.zoom, baseZoom]);

  const initialSamplingRef = useRef(false);

  useEffect(() => {
    if (!viewState) {
      return () => {};
    }
    if (!initialSamplingRef.current) {
      setSamplingViewState(viewState);
      initialSamplingRef.current = true;
    }
    if (samplingRafRef.current) {
      cancelAnimationFrame(samplingRafRef.current);
    }
    const pendingView = viewState;
    samplingRafRef.current = requestAnimationFrame(() => {
      setSamplingViewState(pendingView);
    });
    return () => {
      if (samplingRafRef.current) {
        cancelAnimationFrame(samplingRafRef.current);
        samplingRafRef.current = null;
      }
    };
  }, [viewState]);

  const downloadCanvasImage = useCallback((name = 'spatial') => {
    try {
      const container = containerRef.current;
      if (!container) return;
      const canvas = container.querySelector('canvas');
      if (!canvas) return;
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `${name}-${ts}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Export failed', err);
      // eslint-disable-next-line no-alert
      alert('Unable to export image. This may happen if the canvas is tainted by cross-origin resources.');
    }
  }, []);

  const handleContextMenu = useCallback((event) => {
    event.preventDefault();
    downloadCanvasImage('spatial');
  }, [downloadCanvasImage]);

  const handleAddImage = useCallback(() => {
    if (!window.electron) {
      alert('File selection requires Electron. Please use the desktop app.');
      return;
    }
    setShowHistologyDialog(true);
  }, []);

  const handleHistologyImageLoaded = useCallback((imageData) => {
    console.log('Histology image loaded from dialog:', imageData);
    
    const fileName = imageData.imagePath ? imageData.imagePath.split(/[/\\]/).pop() : 'histology_image';
    setHistologyImage({
      dziUrl: imageData.dziUrl,
      fileName,
      width: imageData.width,
      height: imageData.height,
    });

    if (imageData.transformMatrix) {
      setTransformationMatrix(imageData.transformMatrix);
      console.log('Transformation matrix set:', imageData.transformMatrix);
    } else {
      setTransformationMatrix(null);
    }

    setLoadingHistology(false);
    setShowHistologyDialog(false);
  }, []);

  const handleCloseHistologyDialog = useCallback(() => {
    setShowHistologyDialog(false);
    setLoadingHistology(false);
  }, []);

  const normalizeCluster = useCallback((c) => {
    if (c == null) return '0';
    const s = String(c).trim().toLowerCase();
    if (s === 'null' || s === '' || s === 'nan' || s === 'na' || s === 'undefined') return '0';
    return String(c);
  }, []);

  const highlightedRegionId = activePlot?.data?.type === 'region_composition'
    ? String(activePlot.data.regionId)
    : null;

  const colorState = useMemo(() => {
    if (!resolvedResults) {
      console.log('SpatialPlotView colorState: No resolvedResults, using constant color');
      return {
        mode: 'constant',
        getColor: () => BASE_COLOR,
        legend: null,
        trigger: 'constant',
      };
    }

    console.log('SpatialPlotView colorState: Checking resolvedResults', {
      type: resolvedResults.type,
      hasExpression: !!resolvedResults.expression,
      expressionLength: resolvedResults.expression?.length,
      expressionType: resolvedResults.expression?.constructor?.name,
      isArray: Array.isArray(resolvedResults.expression),
      isTypedArray: ArrayBuffer.isView(resolvedResults.expression),
    });

    if (resolvedResults.type === 'umap' && Array.isArray(resolvedResults.clusters)) {
      const clustersRaw = resolvedResults.clusters;
      const clusters = clustersRaw.map(normalizeCluster);
      const clusterColorDomain = Array.isArray(resolvedResults.clusterColorDomain) && resolvedResults.clusterColorDomain.length > 0
        ? resolvedResults.clusterColorDomain
        : null;
      const useGlobalDomain = !!clusterColorDomain;
      const uniqueClusters = useGlobalDomain
        ? Array.from(new Set([...(clusterColorDomain || []), ...clusters]))
        : Array.from(new Set(clusters));
      console.log('SpatialPlotView colorState: Processing UMAP clusters', {
        totalCells: clusters.length,
        uniqueClusters: uniqueClusters.length,
        useGlobalDomain,
        clusterIds: uniqueClusters.slice(0, 10),
      });

      const isRegionData = resolvedResults?.source === 'banksy';
      const effectiveLabelMap = isRegionData && Object.keys(regionLabelMap).length > 0 ? regionLabelMap : clusterLabelMap;

      const clusterIdToLabel = {};
      uniqueClusters.forEach((clusterId) => {
        const key = String(clusterId);
        let label = formatClusterLabel(clusterId, effectiveLabelMap);
        if (/^null$/i.test(label) || label === '') label = key;
        clusterIdToLabel[key] = label;
      });
      const labelToClusterIds = {};
      Object.entries(clusterIdToLabel).forEach(([clusterId, label]) => {
        if (!labelToClusterIds[label]) labelToClusterIds[label] = [];
        labelToClusterIds[label].push(clusterId);
      });

      const uniqueLabelsInOrder = useGlobalDomain
        ? (() => {
            const seen = new Set();
            const out = [];
            sortClusterIds(clusterColorDomain).forEach((id) => {
              const label = clusterIdToLabel[String(id)] ?? String(id);
              if (!seen.has(label)) {
                seen.add(label);
                out.push(label);
              }
            });
            return out;
          })()
        : Array.from(new Set(Object.values(clusterIdToLabel)));
      const scaleDomain = useGlobalDomain ? uniqueLabelsInOrder : Array.from(new Set(Object.values(clusterIdToLabel)));
      const scale = createClusterColorScale(scaleDomain);
      if (!scale) {
        console.log('SpatialPlotView colorState: Failed to create cluster color scale');
        return {
          mode: 'constant',
          getColor: () => BASE_COLOR,
          legend: null,
          trigger: 'constant',
        };
      }

      const sorted = useGlobalDomain ? uniqueLabelsInOrder : sortClusterIds(uniqueClusters);
      const entries = [];
      const seenLabels = new Set();
      sorted.forEach((clusterIdOrLabel) => {
        const label = useGlobalDomain ? clusterIdOrLabel : (clusterIdToLabel[String(clusterIdOrLabel)] ?? String(clusterIdOrLabel));
        if (seenLabels.has(label)) return;
        seenLabels.add(label);
        const firstClusterId = labelToClusterIds[label] ? labelToClusterIds[label][0] : String(clusterIdOrLabel);
        const override = clusterColorOverrides?.[firstClusterId];
        const baseColor = override || scale(label);
        entries.push({ id: firstClusterId, label, color: colorToRgba(baseColor) });
      });

      console.log('SpatialPlotView colorState: Created cluster colors', {
        mode: 'clusters',
        numEntries: entries.length,
        useGlobalDomain,
        firstFewEntries: entries.slice(0, 5),
      });

      const DIMMED_COLOR = [160, 174, 192, 180];

      const getColor = (index) => {
        const clusterValue = String(clusters?.[index]);
        const label = clusterIdToLabel[clusterValue] ?? clusterValue;
        const override = clusterColorOverrides?.[clusterValue];
        const colorValue = override || scale(label);

        if (legendHighlightSelection && legendHighlightSelection.clusterIds) {
          if (legendHighlightSelection.clusterIds.has(clusterValue)) {
            return colorToRgba(colorValue);
          }
          return isHovering ? [0, 0, 0, 0] : DIMMED_COLOR;
        }

        if (highlightedRegionId != null) {
          return clusterValue === highlightedRegionId
            ? colorToRgba(colorValue)
            : DIMMED_COLOR;
        }

        if (selectedClusters.size === 0) {
          return colorToRgba(colorValue);
        }
        if (isHovering && !selectedClusters.has(clusterValue)) {
          return [0, 0, 0, 0];
        }
        return selectedClusters.has(clusterValue)
          ? colorToRgba(colorValue)
          : DIMMED_COLOR;
      };

      return {
        mode: 'clusters',
        getColor,
        legend: {
          title: 'Clusters',
          entries,
        },
        trigger: [clusters, selectedClusters, legendHighlightSelection, highlightedRegionId, clusterColorOverrides, clusterLabelMap, isHovering],
      };
    }

    const hasExpressionArray = resolvedResults.type === 'gene_expression' &&
                               (Array.isArray(resolvedResults.expression) || ArrayBuffer.isView(resolvedResults.expression));

    if (hasExpressionArray) {
      const expression = resolvedResults.expression;

      if (expression.length === 0) {
        console.warn('SpatialPlotView: Expression array is empty');
        return {
          mode: 'constant',
          getColor: () => BASE_COLOR,
          legend: null,
          trigger: 'constant',
        };
      }
      
      
      const expressionExtent = d3.extent(expression);
      let [minExp, maxExp] = expressionExtent;
      if (resolvedResults.expressionRange && Array.isArray(resolvedResults.expressionRange) &&
          resolvedResults.expressionRange.length >= 2 &&
          Number.isFinite(resolvedResults.expressionRange[0]) && Number.isFinite(resolvedResults.expressionRange[1])) {
        minExp = resolvedResults.expressionRange[0];
        maxExp = resolvedResults.expressionRange[1];
      }
      if (!Number.isFinite(minExp) || !Number.isFinite(maxExp)) {
        console.warn('SpatialPlotView: Invalid expression extent, using defaults', expressionExtent);
        minExp = 0;
        maxExp = 1;
      } else if (minExp === maxExp) {
        maxExp = minExp + 1e-6;
      }
      const colorFn = createColorFunction(resolvedResults.colorMap, minExp, maxExp);

      console.log('SpatialPlotView colorState: Created gene expression color function', {
        minExp,
        maxExp,
        expressionSample: expression.slice(0, 5),
        colorMap: resolvedResults.colorMap,
        geneName: resolvedResults.geneName,
      });

      return {
        mode: 'expression',
        getColor: (index) => {
          if (index < 0 || index >= expression.length) {
            return BASE_COLOR;
          }
          const value = expression[index];
          if (!Number.isFinite(value)) {
            return BASE_COLOR;
          }
          return colorToRgba(colorFn(value));
        },
        legend: {
          title: resolvedResults.geneName || 'Gene Expression',
          min: minExp,
          max: maxExp,
          colorFn,
        },
        trigger: [resolvedResults.colorMap, minExp, maxExp, expression],
      };
    }

    return {
      mode: 'constant',
      getColor: () => BASE_COLOR,
      legend: null,
      trigger: 'constant',
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedResults, selectedClusters, legendHighlightSelection, highlightedRegionId, clusterColorOverrides, clusterLabelMap, regionLabelMap, isHovering, normalizeCluster]);

  const isMERFISH = dataInfo?.format === 'MERFISH';
  const isXenium = dataInfo?.format === '10X Xenium' || dataInfo?.modality === 'xenium-integration';
  const radiusPixels = useMemo(() => {
    if (isMERFISH) {
      if (totalCells > 200000) return 4.0;
      if (totalCells > 100000) return 5.0;
      if (totalCells > 50000)  return 6.0;
      return 7.0;
    }
    if (totalCells > 500000) {
      return 2.0;
    } else if (totalCells > 200000) {
      return 2.5;
    } else if (totalCells > 50000) {
      return 3.0;
    } else {
      return 3.5;
    }
  }, [totalCells, isMERFISH]);

  const colorBuffer = useMemo(() => {
    if (!spatialIndex) {
      console.log('SpatialPlotView colorBuffer: No spatialIndex, returning null');
      return null;
    }
    const { pointCount } = spatialIndex;
    const palette = new Uint8Array(pointCount * 4);
    for (let i = 0; i < pointCount; i += 1) {
      const rgba = colorState.getColor(i);
      palette[i * 4] = rgba[0];
      palette[i * 4 + 1] = rgba[1];
      palette[i * 4 + 2] = rgba[2];
      palette[i * 4 + 3] = rgba[3];
    }
    console.log('SpatialPlotView colorBuffer: Created color buffer', {
      pointCount,
      colorMode: colorState.mode,
      firstColor: [palette[0], palette[1], palette[2], palette[3]],
      lastColor: [palette[(pointCount-1)*4], palette[(pointCount-1)*4+1], palette[(pointCount-1)*4+2], palette[(pointCount-1)*4+3]],
    });
    return palette;
  }, [spatialIndex, colorState]);

  const tileCacheRef = useRef(new Map());

  useEffect(() => {
    tileCacheRef.current.clear();
  }, [spatialIndex, colorBuffer]);

  const transformedSpatialData = useMemo(() => {
    if (!spatialIndex) {
      return null;
    }

    const imgW = histologyImage?.width || osdSizeRef.current?.x;
    const imgH = histologyImage?.height || osdSizeRef.current?.y;

    if (!imgW || !imgH || imgW <= 0 || imgH <= 0) {
      console.log('transformedSpatialData: Image size not available yet', { imgW, imgH, hasHistologyImage: !!histologyImage?.dziUrl });
      return null;
    }

    const isBlankTileSource = !histologyImage?.dziUrl;

    const { xMin: spatialXMin, xMax: spatialXMax, yMin: spatialYMin, yMax: spatialYMax } = spatialIndex.bounds;
    const spatialWidth = spatialXMax - spatialXMin;
    const spatialHeight = spatialYMax - spatialYMin;
    if (spatialWidth <= 0 || spatialHeight <= 0) {
      return null;
    }

    const buildAffine = (A, B, TX, C, D, TY, label) => {
      const det = A * D - B * C;
      if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
      const invA = D / det;
      const invB = -B / det;
      const invC = -C / det;
      const invD = A / det;
      const invTx = -(invA * TX + invB * TY);
      const invTy = -(invC * TX + invD * TY);
      return {
        label,
        toSpatialFromImage: (ix, iy) => [A * ix + B * iy + TX, C * ix + D * iy + TY],
        toImageFromSpatial: (sx, sy) => [invA * sx + invB * sy + invTx, invC * sx + invD * sy + invTy],
        params: { A, B, TX, C, D, TY, invA, invB, invC, invD, invTx, invTy },
      };
    };

    const evaluateCandidate = (cand) => {
      if (!cand) return { score: 0 };
      const xs = spatialIndex.xs;
      const ys = spatialIndex.ys;
      const n = Math.min(1000, xs.length);
      let inside = 0;
      const step = Math.max(1, Math.floor(xs.length / n));
      for (let i = 0; i < xs.length && inside < n; i += step) {
        const scaledX = needsScaling ? xs[i] / spatialScaleFactor : xs[i];
        const scaledY = needsScaling ? ys[i] / spatialScaleFactor : ys[i];
        const [ix, iy] = cand.toImageFromSpatial(scaledX, scaledY);
        if (Number.isFinite(ix) && Number.isFinite(iy) && ix >= -imgW * 0.25 && ix <= imgW * 1.25 && iy >= -imgH * 0.25 && iy <= imgH * 1.25) {
          inside += 1;
        }
      }
      return { score: inside, cand };
    };

    let solution = null;
    
    if (isBlankTileSource) {
      const toImageFromSpatial = (sx, sy) => {
        return [sx - spatialXMin, spatialYMax - sy];
      };
      const toSpatialFromImage = (ix, iy) => {
        return [ix + spatialXMin, spatialYMax - iy];
      };

      solution = {
        label: 'blank-tile-source-yflip',
        toImageFromSpatial,
        toSpatialFromImage,
        params: {
          A: 1, B: 0, TX: -spatialXMin,
          C: 0, D: -1, TY: spatialYMax,
          invA: 1, invB: 0, invTx: spatialXMin,
          invC: 0, invD: -1, invTy: spatialYMax,
        },
      };
      console.log('Created Y-flip transformation for blank tile source');
    } else if (histologyPrealigned && !transformationMatrix) {
      const toImageFromSpatial = (sx, sy) => {
        return [sx, sy];
      };
      const toSpatialFromImage = (ix, iy) => {
        return [ix, iy];
      };

      solution = {
        label: 'prealigned-histology-identity',
        toImageFromSpatial,
        toSpatialFromImage,
        params: {
          A: 1, B: 0, TX: 0,
          C: 0, D: 1, TY: 0,
          invA: 1, invB: 0, invTx: 0,
          invC: 0, invD: 1, invTy: 0,
        },
      };
      console.log('Created identity transformation for pre-aligned histology (format:', dataInfo?.format, ')');
    } else if (transformationMatrix && Array.isArray(transformationMatrix) && transformationMatrix.length >= 2) {
      const a = Number(transformationMatrix[0][0]);
      const b = Number(transformationMatrix[0][1]);
      const tx = Number(transformationMatrix[0][2] || 0);
      const c = Number(transformationMatrix[1][0]);
      const d = Number(transformationMatrix[1][1]);
      const ty = Number(transformationMatrix[1][2] || 0);

      const candRowHistToSpatial = buildAffine(a, b, tx, c, d, ty, 'row-major hist->spatial');
      const candColHistToSpatial = buildAffine(a, c, tx, b, d, ty, 'col-major hist->spatial');
      const candRowSpatialToHist = candRowHistToSpatial
        ? {
            label: 'row-major spatial->hist',
            toSpatialFromImage: (ix, iy) => {
              const p = candRowHistToSpatial.params;
              const A2 = p.invA, B2 = p.invB, TX2 = p.invTx, C2 = p.invC, D2 = p.invD, TY2 = p.invTy;
              return [A2 * ix + B2 * iy + TX2, C2 * ix + D2 * iy + TY2];
            },
            toImageFromSpatial: (sx, sy) => [a * sx + b * sy + tx, c * sx + d * sy + ty],
            params: candRowHistToSpatial.params,
          }
        : null;
      const candColSpatialToHist = candColHistToSpatial
        ? {
            label: 'col-major spatial->hist',
            toSpatialFromImage: (ix, iy) => {
              const p = candColHistToSpatial.params;
              const A2 = p.invA, B2 = p.invB, TX2 = p.invTx, C2 = p.invC, D2 = p.invD, TY2 = p.invTy;
              return [A2 * ix + B2 * iy + TX2, C2 * ix + D2 * iy + TY2];
            },
            toImageFromSpatial: (sx, sy) => [a * sx + c * sy + tx, b * sx + d * sy + ty],
            params: candColHistToSpatial.params,
          }
        : null;

      const candidates = [candRowHistToSpatial, candColHistToSpatial, candRowSpatialToHist, candColSpatialToHist]
        .filter(Boolean);
      const scored = candidates.map(evaluateCandidate);
      scored.sort((u, v) => v.score - u.score);
      solution = scored[0]?.cand || null;
      console.log('Transform selection scores:', scored.map(s => ({ label: s.cand.label, score: s.score })));
    }

    if (solution) {
      const p = solution.params;
      const scaleX = Math.hypot(p.A, p.C);
      const scaleY = Math.hypot(p.B, p.D);
      const scaleU = (scaleX + scaleY) / 2;
      const angleDeg = (Math.atan2(p.C, p.A) * 180) / Math.PI;
      console.log('Selected transform:', solution.label, solution.params);
      
      const xs = spatialIndex.xs;
      const ys = spatialIndex.ys;
      
      console.log('=== BEFORE Transformation - Spatial Coordinates ===');
      console.log('Format:', dataInfo?.format, '| Scale factor:', spatialScaleFactor, '| Needs scaling:', needsScaling);
      console.log('xMin:', spatialXMin, 'xMax:', spatialXMax, 'xRange:', spatialXMax - spatialXMin);
      console.log('yMin:', spatialYMin, 'yMax:', spatialYMax, 'yRange:', spatialYMax - spatialYMin);
      if (needsScaling) {
        console.log('Scaled xMin:', spatialXMin / spatialScaleFactor, 'Scaled xMax:', spatialXMax / spatialScaleFactor);
        console.log('Scaled yMin:', spatialYMin / spatialScaleFactor, 'Scaled yMax:', spatialYMax / spatialScaleFactor);
      }
      console.log('Point count:', xs.length);
      
      let imageXMin = Number.POSITIVE_INFINITY;
      let imageXMax = Number.NEGATIVE_INFINITY;
      let imageYMin = Number.POSITIVE_INFINITY;
      let imageYMax = Number.NEGATIVE_INFINITY;
      
      for (let i = 0; i < xs.length; i++) {
        let scaledX, scaledY;
        if (isBlankTileSource || !needsScaling) {
          scaledX = xs[i];
          scaledY = ys[i];
        } else {
          scaledX = xs[i] / spatialScaleFactor;
          scaledY = ys[i] / spatialScaleFactor;
        }
        const [imgX, imgY] = solution.toImageFromSpatial(scaledX, scaledY);
        if (Number.isFinite(imgX) && Number.isFinite(imgY)) {
          imageXMin = Math.min(imageXMin, imgX);
          imageXMax = Math.max(imageXMax, imgX);
          imageYMin = Math.min(imageYMin, imgY);
          imageYMax = Math.max(imageYMax, imgY);
        }
      }
      
      console.log('=== AFTER Transformation - Image Pixel Coordinates ===');
      console.log('xMin:', imageXMin, 'xMax:', imageXMax, 'xRange:', imageXMax - imageXMin);
      console.log('yMin:', imageYMin, 'yMax:', imageYMax, 'yRange:', imageYMax - imageYMin);
      console.log('Image size: width =', imgW, 'height =', imgH);
      console.log('Point count:', xs.length);
      console.log('Transformed coordinates within image bounds?', 
        imageXMin >= 0 && imageXMax <= imgW && imageYMin >= 0 && imageYMax <= imgH);
      console.log('Transformed coordinate offset from origin:', {
        offsetX: imageXMin,
        offsetY: imageYMin,
        note: 'These offsets show how far the transformed coordinates are from (0,0)'
      });
      
      return {
        hasMatrix: true,
        imgW,
        imgH,
        imageXMin,
        imageXMax,
        imageYMin,
        imageYMax,
        toImageFromSpatial: solution.toImageFromSpatial,
        toSpatialFromImage: solution.toSpatialFromImage,
        imageToSpatialLinear: { A: p.A, B: p.B, C: p.C, D: p.D, TX: p.TX, TY: p.TY },
        spatialToImageLinear: { A: p.invA, B: p.invB, C: p.invC, D: p.invD, TX: p.invTx, TY: p.invTy },
        scaleX,
        scaleY,
        scaleU,
        angleDeg,
        label: solution.label,
      };
    }

    console.log('Using simple bounding box fit for spatial-to-image mapping');
    const scaleX = imgW / spatialWidth;
    const scaleY = imgH / spatialHeight;
    const offsetX = -spatialXMin * scaleX;
    const offsetY = -spatialYMin * scaleY;

    console.log('=== BEFORE Transformation - Spatial Coordinates (Proportional Mapping) ===');
    console.log('xMin:', spatialXMin, 'xMax:', spatialXMax, 'xRange:', spatialWidth);
    console.log('yMin:', spatialYMin, 'yMax:', spatialYMax, 'yRange:', spatialHeight);
    console.log('Point count:', spatialIndex.pointCount);

    const imageXMin = 0;
    const imageXMax = imgW;
    const imageYMin = 0;
    const imageYMax = imgH;

    console.log('=== AFTER Transformation - Image Pixel Coordinates (Proportional Mapping) ===');
    console.log('xMin:', imageXMin, 'xMax:', imageXMax, 'xRange:', imageXMax - imageXMin);
    console.log('yMin:', imageYMin, 'yMax:', imageYMax, 'yRange:', imageYMax - imageYMin);
    console.log('Image size: width =', imgW, 'height =', imgH);
    console.log('Point count:', spatialIndex.pointCount);

    return {
      hasMatrix: false,
      scaleX,
      scaleY,
      offsetX,
      offsetY,
      imgW,
      imgH,
      toImageFromSpatial: (sx, sy) => [sx * scaleX + offsetX, sy * scaleY + offsetY],
      toSpatialFromImage: (ix, iy) => [ix / scaleX - offsetX / scaleX, iy / scaleY - offsetY / scaleY],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spatialIndex, histologyImage?.dziUrl, histologyImage?.width, histologyImage?.height, transformationMatrix]);

  const activeViewForSampling = osdViewState ?? viewState ?? samplingViewState;

  const currentViewBounds = useMemo(() => {
    if (!activeViewForSampling) {
      return null;
    }
    
    let bounds = computeViewBounds(activeViewForSampling, dimensions.width, dimensions.height);
    
    if (transformedSpatialData && bounds && spatialIndex) {
      const imageBounds = {
        xMin: bounds.xMin,
        xMax: bounds.xMax,
        yMin: bounds.yMin,
        yMax: bounds.yMax,
      };

      const isBlankTileSource = !histologyImage?.dziUrl;
      const toSpatial = (x, y) => {
        const [sx, sy] = transformedSpatialData.toSpatialFromImage(x, y);
        if (isBlankTileSource || !needsScaling) {
          return [sx, sy];
        } else {
          return [sx * spatialScaleFactor, sy * spatialScaleFactor];
        }
      };

      const cornersImg = [
        [imageBounds.xMin, imageBounds.yMin],
        [imageBounds.xMax, imageBounds.yMin],
        [imageBounds.xMax, imageBounds.yMax],
        [imageBounds.xMin, imageBounds.yMax],
      ];

      let xMinS = Infinity, xMaxS = -Infinity, yMinS = Infinity, yMaxS = -Infinity;
      for (const [ix, iy] of cornersImg) {
        const [sx, sy] = toSpatial(ix, iy);
        if (Number.isFinite(sx) && Number.isFinite(sy)) {
          xMinS = Math.min(xMinS, sx);
          xMaxS = Math.max(xMaxS, sx);
          yMinS = Math.min(yMinS, sy);
          yMaxS = Math.max(yMaxS, sy);
        }
      }

      const { xMin: spatialXMin, xMax: spatialXMax, yMin: spatialYMin, yMax: spatialYMax } = spatialIndex.bounds;

      if (!Number.isFinite(xMinS) || !Number.isFinite(xMaxS) || !Number.isFinite(yMinS) || !Number.isFinite(yMaxS)) {
        console.warn('Viewport bounds transformation produced invalid values, using full spatial bounds');
        bounds = {
          xMin: spatialXMin,
          xMax: spatialXMax,
          yMin: spatialYMin,
          yMax: spatialYMax,
        };
      } else if (xMaxS < spatialXMin || xMinS > spatialXMax || yMaxS < spatialYMin || yMinS > spatialYMax) {
        console.warn('Viewport is outside spatial data bounds, returning empty bounds');
        bounds = {
          xMin: spatialXMin,
          xMax: spatialXMin,
          yMin: spatialYMin,
          yMax: spatialYMin,
        };
      } else {
        const widthS = xMaxS - xMinS || (spatialXMax - spatialXMin);
        const heightS = yMaxS - yMinS || (spatialYMax - spatialYMin);
        const bufferX = Math.max(widthS * 0.3, (spatialXMax - spatialXMin) * 0.1);
        const bufferY = Math.max(heightS * 0.3, (spatialYMax - spatialYMin) * 0.1);

        bounds = {
          xMin: Math.max(spatialXMin, xMinS - bufferX),
          xMax: Math.min(spatialXMax, xMaxS + bufferX),
          yMin: Math.max(spatialYMin, yMinS - bufferY),
          yMax: Math.min(spatialYMax, yMaxS + bufferY),
        };
      }

      console.log('=== Converted viewport bounds (image coords) to spatial bounds for sampling ===');
      console.log('Image viewport bounds:', {
        xMin: imageBounds.xMin,
        xMax: imageBounds.xMax,
        yMin: imageBounds.yMin,
        yMax: imageBounds.yMax,
        width: imageBounds.xMax - imageBounds.xMin,
        height: imageBounds.yMax - imageBounds.yMin,
      });
      console.log('Computed spatial bounds for sampling:', {
        xMin: bounds.xMin,
        xMax: bounds.xMax,
        yMin: bounds.yMin,
        yMax: bounds.yMax,
        width: bounds.xMax - bounds.xMin,
        height: bounds.yMax - bounds.yMin,
      });
      console.log('Spatial domain (full data bounds):', {
        xMin: spatialXMin,
        xMax: spatialXMax,
        yMin: spatialYMin,
        yMax: spatialYMax,
        width: spatialXMax - spatialXMin,
        height: spatialYMax - spatialYMin,
      });
      console.log('Bounds overlap?', {
        xOverlap: !(bounds.xMax < spatialXMin || bounds.xMin > spatialXMax),
        yOverlap: !(bounds.yMax < spatialYMin || bounds.yMin > spatialYMax),
      });
    }

    return bounds;
  }, [activeViewForSampling, dimensions.width, dimensions.height, histologyImage?.dziUrl, histologyImage?.width, histologyImage?.height, transformedSpatialData, spatialIndex, needsScaling, spatialScaleFactor]);

  const renderState = useMemo(() => {
    if (!spatialIndex || !currentViewBounds) {
      console.log('renderState: Missing dependencies', {
        hasSpatialIndex: !!spatialIndex,
        hasCurrentViewBounds: !!currentViewBounds,
        currentViewBounds,
        activeViewForSampling,
      });
      return {
        mode: 'idle',
        tiles: [],
        density: null,
        totalVisible: 0,
        sampleVisible: 0,
        level: null,
      };
    }
    
    console.log('renderState: Computing with bounds', {
      currentViewBounds,
      activeViewForSampling,
      spatialBounds: spatialIndex.bounds,
      hasImage: !!histologyImage?.dziUrl,
      hasTransformation: !!transformationMatrix,
    });

    let samplingBounds = currentViewBounds;

    if (histologyImage?.dziUrl && transformedSpatialData) {
      samplingBounds = spatialIndex.bounds;
      console.log('renderState: Using FULL spatial bounds for WebGL overlay (no viewport culling)');
    }

    const maxSamples = maxSamplePoints != null
      ? maxSamplePoints
      : isVisiumHD
        ? (dataInfo?.dataType === 'binned' ? VISIUM_HD_BINNED_MAX_SAMPLE_POINTS : VISIUM_HD_SEGMENTED_MAX_SAMPLE_POINTS)
        : MAX_SAMPLE_POINTS;
    const sampleInfo = gatherSamplesForViewport(spatialIndex, samplingBounds, {
      maxSamples,
      merge: false,
    });

    console.log('renderState: Sample info', {
      sampleCount: sampleInfo?.sampleCount,
      totalCount: sampleInfo?.totalCount,
      level: sampleInfo?.level,
      bounds: samplingBounds,
      usedFullBounds: histologyImage?.dziUrl && !transformationMatrix,
    });

    if (!sampleInfo || sampleInfo.sampleCount === 0) {
      console.warn('renderState: No points found in viewport', {
        samplingBounds,
        spatialBounds: spatialIndex.bounds,
        hasImage: !!histologyImage?.dziUrl,
      });
      return {
        mode: 'idle',
        tiles: [],
        density: null,
        totalVisible: 0,
        sampleVisible: 0,
        level: sampleInfo ? sampleInfo.level : null,
      };
    }

    const totalVisible = sampleInfo.totalCount;
    if (totalVisible > DENSITY_THRESHOLD) {
      const densityBounds = histologyImage?.dziUrl && !transformationMatrix 
        ? spatialIndex.bounds 
        : currentViewBounds;
      const density = gatherDensitySample(spatialIndex, densityBounds, {
        level: Math.max(sampleInfo.level - 1, 0),
      });
      return {
        mode: 'density',
        tiles: [],
        density,
        totalVisible,
        sampleVisible: density?.data?.length || 0,
        level: sampleInfo.level,
      };
    }

    const xs = spatialIndex.xs;
    const ys = spatialIndex.ys;
    const baseColor = BASE_COLOR;
    const tiles = [];
    const matches = sampleInfo.tiles || [];

    for (const tile of matches) {
      const tileKey = `${tile.tileX}/${tile.tileY}`;
      const cacheKey = `${sampleInfo.level}:${tileKey}`;
      let cache = tileCacheRef.current.get(cacheKey);
      if (!cache) {
        const indices = tile.indices;
        const length = indices.length;
        const positions = new Float32Array(length * 2);
        const colors = new Uint8Array(length * 4);
        for (let i = 0; i < length; i += 1) {
          const idx = indices[i];
          positions[i * 2] = xs[idx];
          positions[i * 2 + 1] = ys[idx];
          if (colorBuffer) {
            const offset = idx * 4;
            colors[i * 4] = colorBuffer[offset];
            colors[i * 4 + 1] = colorBuffer[offset + 1];
            colors[i * 4 + 2] = colorBuffer[offset + 2];
            colors[i * 4 + 3] = colorBuffer[offset + 3];
          } else {
            colors[i * 4] = baseColor[0];
            colors[i * 4 + 1] = baseColor[1];
            colors[i * 4 + 2] = baseColor[2];
            colors[i * 4 + 3] = baseColor[3];
          }
        }
        cache = {
          key: tileKey,
          positions,
          colors,
          length,
        };
        tileCacheRef.current.set(cacheKey, cache);
      }
      tiles.push(cache);
    }

    const sampleVisible = tiles.reduce((acc, entry) => acc + entry.length, 0);
    const combinedPositions = new Float32Array(sampleVisible * 2);
    const combinedColors = new Uint8Array(sampleVisible * 4);
    const indexArray = new Uint32Array(sampleVisible);
    let writeOffset = 0;
    for (let tileIdx = 0; tileIdx < tiles.length; tileIdx++) {
      const entry = tiles[tileIdx];
      const tile = matches[tileIdx];
      combinedPositions.set(entry.positions, writeOffset * 2);
      combinedColors.set(entry.colors, writeOffset * 4);
      const tileIndices = tile.indices;
      for (let i = 0; i < entry.length; i += 1) {
        indexArray[writeOffset + i] = tileIndices[i];
      }
      writeOffset += entry.length;
    }

    return {
      mode: 'points',
      tiles,
      points: {
        positions: combinedPositions,
        colors: combinedColors,
        length: sampleVisible,
        indices: indexArray,
      },
      density: null,
      totalVisible,
      sampleVisible,
      level: sampleInfo.level,
    };
  }, [spatialIndex, currentViewBounds, colorBuffer, histologyImage?.dziUrl, transformationMatrix, transformedSpatialData, activeViewForSampling, dataInfo?.format, dataInfo?.dataType, isVisiumHD, maxSamplePoints]);

  useEffect(() => {
    console.log('WebGL overlay update effect triggered:', {
      hasOverlay: !!osdWebGLOverlayRef.current,
      renderMode: renderState?.mode,
      hasPoints: !!renderState?.points,
      hasSpatialIndex: !!spatialIndex,
    });

    if (!osdWebGLOverlayRef.current) {
      console.log('WebGL overlay update: No overlay ref, skipping');
      return;
    }

    if (renderState.mode !== 'points' || !renderState.points || !spatialIndex) {
      console.log('WebGL overlay update: Clearing points (mode=' + renderState?.mode + ')');
      osdWebGLOverlayRef.current.setPointData(null);
      return;
    }

    console.log('WebGL overlay update: Processing points', {
      pointCount: renderState.points.length,
      mode: renderState.mode,
    });

    const pointCount = renderState.points.length;
    
    const imgW = transformedSpatialData?.imgW || histologyImage?.width || osdSizeRef.current?.x;
    const imgH = transformedSpatialData?.imgH || histologyImage?.height || osdSizeRef.current?.y;
    
    const validPoints = [];
    const validColors = [];
    
    let rawMinX = Infinity, rawMaxX = -Infinity, rawMinY = Infinity, rawMaxY = -Infinity;
    let pointsOutsideBounds = 0;
    const rawPoints = [];

    for (let i = 0; i < pointCount; i++) {
      const idx = renderState.points.indices[i];
      const spatialX = spatialIndex.xs[idx];
      const spatialY = spatialIndex.ys[idx];

      let imgX, imgY;

      if (transformedSpatialData) {
        const isBlankTileSource = !histologyImage?.dziUrl;
        let scaledX, scaledY;
        if (isBlankTileSource || !needsScaling) {
          scaledX = spatialX;
          scaledY = spatialY;
        } else {
          scaledX = spatialX / spatialScaleFactor;
          scaledY = spatialY / spatialScaleFactor;
        }
        [imgX, imgY] = transformedSpatialData.toImageFromSpatial(scaledX, scaledY);

        const margin = 10;
        if (imgW && imgH && (imgX < -margin || imgX > imgW + margin || imgY < -margin || imgY > imgH + margin)) {
          pointsOutsideBounds++;
          continue;
        }
      } else {
        const { xMin, yMin } = spatialIndex.bounds;
        imgX = spatialX - xMin;
        imgY = spatialY - yMin;
      }

      rawPoints.push({ imgX, imgY, colorOffset: i * 4, spatialIdx: idx });
      rawMinX = Math.min(rawMinX, imgX);
      rawMaxX = Math.max(rawMaxX, imgX);
      rawMinY = Math.min(rawMinY, imgY);
      rawMaxY = Math.max(rawMaxY, imgY);
    }
    
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let pointsInTopHalf = 0;
    let pointsInBottomHalf = 0;

    for (const { imgX, imgY, colorOffset, spatialIdx } of rawPoints) {
      
      validPoints.push(imgX, imgY);
      
      if (colorBuffer && spatialIdx !== undefined) {
        const bufferOffset = spatialIdx * 4;
        validColors.push(
          colorBuffer[bufferOffset],
          colorBuffer[bufferOffset + 1],
          colorBuffer[bufferOffset + 2],
          colorBuffer[bufferOffset + 3]
        );
      } else {
        validColors.push(
          renderState.points.colors[colorOffset],
          renderState.points.colors[colorOffset + 1],
          renderState.points.colors[colorOffset + 2],
          renderState.points.colors[colorOffset + 3]
        );
      }

      minX = Math.min(minX, imgX);
      maxX = Math.max(maxX, imgX);
      minY = Math.min(minY, imgY);
      maxY = Math.max(maxY, imgY);
      
      if (imgY < imgH / 2) {
        pointsInTopHalf++;
      } else {
        pointsInBottomHalf++;
      }
    }
    
    const validPointCount = validPoints.length / 2;
    const positions = new Float32Array(validPoints);
    const colors = new Uint8Array(validColors);

    const imageAspectRatio = imgW && imgH ? imgW / imgH : null;
    const scatterPlotAspectRatio = (maxX - minX) > 0 && (maxY - minY) > 0 
      ? (maxX - minX) / (maxY - minY) 
      : null;
    
    console.log('WebGL Overlay - Transformed point bounds (image pixel coordinates):', {
      imagePixelBounds: {
        minX: minX.toFixed(2), maxX: maxX.toFixed(2), 
        minY: minY.toFixed(2), maxY: maxY.toFixed(2),
        rangeX: (maxX - minX).toFixed(2),
        rangeY: (maxY - minY).toFixed(2),
        note: 'Using image pixel coordinates directly (not normalized). Matrix will transform to clip space.',
      },
      rawImageBounds: {
        minX: rawMinX.toFixed(2), maxX: rawMaxX.toFixed(2),
        minY: rawMinY.toFixed(2), maxY: rawMaxY.toFixed(2),
        width: (rawMaxX - rawMinX).toFixed(2),
        height: (rawMaxY - rawMinY).toFixed(2),
        aspectRatio: ((rawMaxX - rawMinX) / (rawMaxY - rawMinY)).toFixed(4),
        note: 'Raw transformed coordinates in image pixel space',
      },
      coordinateSystem: {
        method: 'Image pixel coordinates (NOT normalized)',
        imageWidth: imgW.toFixed(0),
        imageHeight: imgH.toFixed(0),
        imageAspectRatio: imageAspectRatio ? imageAspectRatio.toFixed(4) : 'N/A',
        dataWidth: (rawMaxX - rawMinX).toFixed(2),
        dataHeight: (rawMaxY - rawMinY).toFixed(2),
        dataAspectRatio: ((rawMaxX - rawMinX) / (rawMaxY - rawMinY)).toFixed(4),
        dataCoverageX: ((rawMaxX - rawMinX) / imgW * 100).toFixed(1) + '%',
        dataCoverageY: ((rawMaxY - rawMinY) / imgH * 100).toFixed(1) + '%',
        note: 'Using image pixel coordinates directly. WebGL matrix transforms from image pixels to clip space (like working version).',
      },
      imageSize: transformedSpatialData ? [transformedSpatialData.imgW, transformedSpatialData.imgH] : 'N/A',
      imageAspectRatio: imageAspectRatio ? imageAspectRatio.toFixed(4) : 'N/A',
      scatterPlotAspectRatio: scatterPlotAspectRatio ? scatterPlotAspectRatio.toFixed(4) : 'N/A',
      aspectRatioMatch: imageAspectRatio && scatterPlotAspectRatio 
        ? (Math.abs(imageAspectRatio - scatterPlotAspectRatio) < 0.01 ? '✓ MATCH' : '✗ MISMATCH')
        : 'N/A',
      centerX: ((minX + maxX) / 2).toFixed(4),
      centerY: ((minY + maxY) / 2).toFixed(4),
      originalPointCount: pointCount,
      validPointCount: validPointCount,
      filteredOut: pointsOutsideBounds,
      distribution: {
        topHalf: pointsInTopHalf,
        bottomHalf: pointsInBottomHalf,
        ratio: validPointCount > 0 ? (pointsInTopHalf / validPointCount).toFixed(3) : 'N/A',
        note: 'If ratio is close to 1.0, all points are in top half (this is the bug!)',
      },
      coverage: {
        xCoverage: ((maxX - minX) * 100).toFixed(1) + '%',
        yCoverage: ((maxY - minY) * 100).toFixed(1) + '%',
        note: 'Should be close to 100% for full coverage. Values are in normalized [0,1] coordinates.',
      },
      note: 'Using image pixel coordinates directly (NOT normalized). This matches the working implementation.',
    });

    console.log('First 5 points (image pixel coords):', Array.from({length: Math.min(5, validPointCount)}, (_, i) => ({
      x: positions[i * 2],
      y: positions[i * 2 + 1],
    })));

    osdWebGLOverlayRef.current.setPointData({
      positions,
      colors,
      count: validPointCount,
    });

    console.log('WebGL overlay updated with', validPointCount, 'points (filtered from', pointCount, 'total)');
  }, [renderState, spatialIndex, transformedSpatialData, histologyImage?.dziUrl, histologyImage?.width, histologyImage?.height, colorBuffer, overlayReady, needsScaling, spatialScaleFactor]);

  const zoom = viewState?.zoom;
  const currentZoom = zoom ?? 0;
  const zoomReference = baseZoom ?? currentZoom;
  const zoomDelta = currentZoom - zoomReference;
  const pointZoomScalePerLevel = isXenium ? XENIUM_ZOOM_SCALE_PER_LEVEL : ZOOM_SCALE_PER_LEVEL;
  const pointMaxZoomScale = isXenium ? XENIUM_MAX_ZOOM_SCALE : MAX_ZOOM_SCALE;
  const zoomScale = clamp(
    Math.pow(pointZoomScalePerLevel, zoomDelta),
    MIN_ZOOM_SCALE,
    pointMaxZoomScale
  );

  useEffect(() => {
    if (baseZoom == null && typeof zoom === 'number' && Number.isFinite(zoom)) {
      setBaseZoom(zoom);
    }
  }, [zoom, baseZoom]);

  useEffect(() => {
    console.log('OpenSeadragon initialization effect triggered:', {
      hasContainer: !!osdContainerRef.current,
      hasSpatialIndex: !!spatialIndex,
      hasBounds: !!bounds,
      hasHistologyImage: !!histologyImage?.dziUrl
    });

    if (!osdContainerRef.current || !spatialIndex || !bounds ||
        !Number.isFinite(bounds.xMin) || !Number.isFinite(bounds.xMax) ||
        !Number.isFinite(bounds.yMin) || !Number.isFinite(bounds.yMax)) {
      console.log('OpenSeadragon initialization skipped - prerequisites not met');
      setOsdViewerReady(false);
      if (osdViewerRef.current) {
        try {
          osdViewerRef.current.destroy();
        } catch (e) {
          console.error('Error destroying OpenSeadragon viewer:', e);
        }
        osdViewerRef.current = null;
      }
      return;
    }

    if (osdViewerRef.current) {
      try {
        osdViewerRef.current.destroy();
      } catch (e) {
      }
      osdViewerRef.current = null;
    }

    try {
      const width = Math.max(100, Math.ceil(bounds.xMax - bounds.xMin));
      const height = Math.max(100, Math.ceil(bounds.yMax - bounds.yMin));
      const tileSource = histologyImage?.dziUrl || createBlankTileSource(width, height);

      const tileSourceRef = tileSource;

      console.log('Initializing OpenSeadragon viewer with', histologyImage?.dziUrl ? 'DZI URL:' : 'blank tile source', histologyImage?.dziUrl || 'custom');
      console.log('Tile source:', tileSource);
      if (!histologyImage?.dziUrl && tileSource) {
        console.log('Blank tile source dimensions:', { width: tileSource.width, height: tileSource.height });
      }
      const viewer = OpenSeadragon({
        element: osdContainerRef.current,
        tileSources: tileSource,
        prefixUrl: 'https://openseadragon.github.io/openseadragon/images/',
        showNavigator: false,
        showNavigationControl: !histologyImage?.dziUrl,
        gestureSettingsMouse: {
          clickToZoom: true,
          dblClickToZoom: true,
          scrollToZoom: true,
          flickEnabled: true,
          pinchToZoom: true,
        },
        gestureSettingsTouch: {
          clickToZoom: true,
          dblClickToZoom: true,
          scrollToZoom: true,
          flickEnabled: true,
          pinchToZoom: true,
        },
        gestureSettingsPen: {
          clickToZoom: true,
          dblClickToZoom: true,
          scrollToZoom: true,
          flickEnabled: true,
          pinchToZoom: true,
        },
        animationTime: 0.2,
        immediateRender: true,
        defaultZoomLevel: 0,
        constrainDuringPan: false,
        visibilityRatio: 0,
        wrapHorizontal: false,
        wrapVertical: false,
        minZoomLevel: null,
        maxZoomLevel: null,
        minZoomImageRatio: 0,
        maxZoomPixelRatio: 10,
        homeFillsViewer: false,
      });

      osdViewerRef.current = viewer;

      if (!histologyImage?.dziUrl && tileSourceRef && typeof tileSourceRef === 'object' && tileSourceRef.width && tileSourceRef.height) {
        osdSizeRef.current = { x: tileSourceRef.width, y: tileSourceRef.height };
        console.log('Pre-initializing OSD size for custom tile source:', tileSourceRef.width, tileSourceRef.height);
      }

      viewer.addHandler('open', () => {
        console.log('OpenSeadragon "open" event fired');
        try {
          const item = viewer.world.getItemAt(0);
          let sizeSet = false;

          if (item) {
            const size = item.getContentSize();
            console.log('OpenSeadragon getContentSize() returned:', size);

            if (size?.x && size?.y && size.x > 1 && size.y > 1) {
              osdSizeRef.current = { x: size.x, y: size.y };
              console.log('OpenSeadragon content size from item:', size.x, size.y);
              sizeSet = true;

              if (osdWebGLOverlayRef.current) {
                osdWebGLOverlayRef.current.setImageSize({ x: size.x, y: size.y });
              }

              if (spatialIndex) {
                osdViewStateRef.current = null;
                setOsdViewState(null);
              }
            }
          }

          if (!sizeSet && !histologyImage?.dziUrl && tileSourceRef && typeof tileSourceRef === 'object' && tileSourceRef.width && tileSourceRef.height) {
            osdSizeRef.current = { x: tileSourceRef.width, y: tileSourceRef.height };
            console.log('OpenSeadragon using custom tile source size (fallback):', tileSourceRef.width, tileSourceRef.height);
            sizeSet = true;

            if (osdWebGLOverlayRef.current) {
              osdWebGLOverlayRef.current.setImageSize({ x: tileSourceRef.width, y: tileSourceRef.height });
            }
          }

          console.log('OpenSeadragon viewer ready. Final osdSizeRef:', osdSizeRef.current);
          setOsdViewerReady(true);
        } catch (e) {
          console.error('Failed to read OpenSeadragon content size:', e);
        }
      });

      console.log('OpenSeadragon viewer initialized successfully');
    } catch (error) {
      console.error('Error initializing OpenSeadragon:', error);
    }

    return () => {
      setOsdViewerReady(false);
      if (osdViewerRef.current) {
        try {
          osdViewerRef.current.destroy();
        } catch (e) {
          console.error('Error destroying OpenSeadragon viewer:', e);
        }
        osdViewerRef.current = null;
      }
    };
  }, [histologyImage?.dziUrl, spatialIndex, bounds]);

  useEffect(() => {
    if (!osdViewerReady) {
      if (osdWebGLOverlayRef.current) {
        osdWebGLOverlayRef.current.destroy();
        osdWebGLOverlayRef.current = null;
      }
      return;
    }

    const initOverlay = async () => {
      try {
        const basePointSize = radiusPixels || 1.5;
        const overlay = new OSDWebGLOverlay(osdViewerRef.current, {
          pointSize: basePointSize,
          zoomScalePerLevel: pointZoomScalePerLevel,
          minZoomScale: MIN_ZOOM_SCALE,
          maxZoomScale: pointMaxZoomScale,
        });
        await overlay.init();
        osdWebGLOverlayRef.current = overlay;
        setOverlayReady(true);

        const viewer = osdViewerRef.current;
        const tiledImage = viewer?.world?.getItemAt(0);
        console.log('WebGL overlay initialized successfully. Viewer state:', {
          hasViewer: !!viewer,
          hasWorld: !!viewer?.world,
          worldItemCount: viewer?.world?.getItemCount(),
          hasTiledImage: !!tiledImage,
          tiledImageDetails: tiledImage ? {
            hasSource: !!tiledImage.source,
            contentSize: tiledImage.getContentSize(),
          } : null,
        });
      } catch (error) {
        console.error('Failed to initialize WebGL overlay:', error);
      }
    };

    initOverlay();

    return () => {
      setOverlayReady(false);
      if (osdWebGLOverlayRef.current) {
        osdWebGLOverlayRef.current.destroy();
        osdWebGLOverlayRef.current = null;
      }
    };
  }, [osdViewerReady, histologyImage?.dziUrl, spatialIndex, bounds, radiusPixels, pointZoomScalePerLevel, pointMaxZoomScale]);

  useEffect(() => {
    console.log('osdViewState initialization effect triggered:', {
      hasSpatialIndex: !!spatialIndex,
      osdViewerReady,
      hasOsdSize: !!osdSizeRef.current,
      histologyImage: !!histologyImage?.dziUrl
    });

    if (!spatialIndex || !osdViewerReady) {
      if (osdViewStateRef.current) {
        osdViewStateRef.current = null;
        setOsdViewState(null);
      }
      return;
    }

    const imgW = histologyImage?.width || osdSizeRef.current?.x;
    const imgH = histologyImage?.height || osdSizeRef.current?.y;

    const { xMin, xMax, yMin, yMax } = spatialIndex.bounds;
    const spatialWidth = xMax - xMin;
    const spatialHeight = yMax - yMin;

    if (spatialWidth <= 0 || spatialHeight <= 0) {
      return;
    }

    let centerX, centerY, worldWidth, worldHeight;

    if (imgW && imgH) {
      centerX = imgW / 2;
      centerY = imgH / 2;
      worldWidth = imgW;
      worldHeight = imgH;

      console.log('Using image coordinate system (always, matching histology image approach)');
    } else {
      centerX = (xMin + xMax) / 2;
      centerY = (yMin + yMax) / 2;
      worldWidth = spatialWidth;
      worldHeight = spatialHeight;

      console.log('Using spatial coordinate system (fallback - image size not available)');
    }

    const viewportWidth = dimensions.width || 800;
    const viewportHeight = dimensions.height || 600;
    const scaleX = viewportWidth / worldWidth;
    const scaleY = viewportHeight / worldHeight;
    const scale = Math.min(scaleX, scaleY) * 0.95;
    
    const defaultZoom = Math.log2(scale);

    const clampedZoom = Math.max(-10, Math.min(20, defaultZoom));
    
    const testScale = Math.pow(2, clampedZoom);
    const testWorldWidth = viewportWidth / testScale;
    const testWorldHeight = viewportHeight / testScale;
    
    let finalZoom = clampedZoom;
    let finalCenterX = centerX;
    let finalCenterY = centerY;
    
    if (imgW && imgH) {
      if (testWorldWidth > imgW * 1.5 || testWorldHeight > imgH * 1.5) {
        const fitScaleX = viewportWidth / imgW;
        const fitScaleY = viewportHeight / imgH;
        const fitScale = Math.min(fitScaleX, fitScaleY) * 0.95;
        finalZoom = Math.log2(fitScale);
        finalCenterX = imgW / 2;
        finalCenterY = imgH / 2;
        console.warn('Initial zoom too negative, recalculating to fit image:', {
          originalZoom: clampedZoom,
          originalWorldSize: { w: testWorldWidth, h: testWorldHeight },
          imageSize: { w: imgW, h: imgH },
          newZoom: finalZoom,
        });
      }
    }

    const newViewState = {
      target: [finalCenterX, finalCenterY, 0],
      zoom: finalZoom,
      minZoom: -10,
      maxZoom: 20,
    };

    osdViewStateRef.current = newViewState;
    setOsdViewState(newViewState);

    console.log('Initialized osdViewState:', {
      hasImageSize: !!(imgW && imgH),
      hasTransformationMatrix: !!transformationMatrix,
      center: [centerX, centerY],
      zoom: newViewState.zoom,
      worldWidth,
      worldHeight,
      dimensions: { width: dimensions.width, height: dimensions.height },
    });
  }, [histologyImage?.dziUrl, histologyImage?.width, histologyImage?.height, spatialIndex, dimensions.width, dimensions.height, transformationMatrix, osdViewerReady]);

  useEffect(() => {
    if (!osdViewerRef.current || !spatialIndex) {
      return;
    }
    
    const viewer = osdViewerRef.current;
    if (!viewer || !viewer.viewport) {
      return;
    }

    const imgW = histologyImage?.width || osdSizeRef.current?.x || 1;
    const imgH = histologyImage?.height || osdSizeRef.current?.y || 1;

    if (!imgW || !imgH || imgW <= 0 || imgH <= 0) {
      return;
    }

    const { xMin: spatialXMin, xMax: spatialXMax, yMin: spatialYMin, yMax: spatialYMax } = spatialIndex.bounds;
    const spatialWidth = spatialXMax - spatialXMin;
    const spatialHeight = spatialYMax - spatialYMin;

    if (spatialWidth <= 0 || spatialHeight <= 0) {
      return;
    }

    const updateDeckGLViewState = () => {
      if (!viewer.viewport) return;

      isUpdatingFromOsdRef.current = true;

      try {
        const viewport = viewer.viewport;
        const tiledImage = viewer.world.getItemAt(0);
        
        if (!tiledImage) {
          return;
        }

        const bounds = viewport.getBounds();
        
        const topLeftViewport = new OpenSeadragon.Point(bounds.x, bounds.y);
        const bottomRightViewport = new OpenSeadragon.Point(bounds.x + bounds.width, bounds.y + bounds.height);
        
        const topLeftImg = tiledImage.viewportToImageCoordinates(topLeftViewport);
        const bottomRightImg = tiledImage.viewportToImageCoordinates(bottomRightViewport);
        
        const viewLeftImg = topLeftImg.x;
        const viewTopImg = topLeftImg.y;
        const viewRightImg = bottomRightImg.x;
        const viewBottomImg = bottomRightImg.y;
        const viewWidthImg = viewRightImg - viewLeftImg;
        const viewHeightImg = viewBottomImg - viewTopImg;

        let centerX, centerYDeck, worldWidth, worldHeight, zoom;

        console.log('OSD->DeckGL sync:', {
          hasTransformationMatrix: !!transformationMatrix,
          hasTransformedSpatialData: !!transformedSpatialData,
          viewportBounds: bounds,
          imageViewport: { viewLeftImg, viewTopImg, viewRightImg, viewBottomImg, viewWidthImg, viewHeightImg },
          imgW,
          imgH,
        });

        if (transformedSpatialData && imgW && imgH) {
          centerX = (viewLeftImg + viewRightImg) / 2;
          const centerYImage = (viewTopImg + viewBottomImg) / 2;
          centerYDeck = centerYImage;
          worldWidth = viewWidthImg;
          worldHeight = viewHeightImg;

          console.log('OSD->DeckGL sync (with transform - direct image coords, NO clamping):', {
            osdBounds: bounds,
            imageViewport: { viewLeftImg, viewTopImg, viewWidthImg, viewHeightImg },
            center: [centerX, centerYDeck],
            worldWidth,
            worldHeight,
            imageSize: { imgW, imgH },
            note: 'No clamping - allows viewing outside image bounds',
          });
        } else if (!transformationMatrix && spatialIndex) {
          const { xMin: spatialXMin, yMin: spatialYMin } = spatialIndex.bounds;
          const centerXImage = viewLeftImg + viewWidthImg / 2;
          const centerYImage = viewTopImg + viewHeightImg / 2;
          centerX = centerXImage + spatialXMin;
          centerYDeck = centerYImage + spatialYMin;
          worldWidth = viewWidthImg;
          worldHeight = viewHeightImg;
          
          console.log('OSD->DeckGL sync (no transform - direct image coords, converted to spatial):', {
            osdBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
            imageViewport: { viewLeftImg, viewTopImg, viewWidthImg, viewHeightImg },
            imageCenter: [centerXImage, centerYImage],
            spatialCenter: [centerX, centerYDeck],
            worldWidth,
            worldHeight,
            spatialOffset: { xMin: spatialXMin, yMin: spatialYMin },
            note: 'Image coords [0,imgW] map to spatial coords [xMin,xMax] by adding offset',
          });
        } else {
          const { xMin: spatialXMin, xMax: spatialXMax, yMin: spatialYMin, yMax: spatialYMax } = spatialIndex.bounds;
          const spatialWidth = spatialXMax - spatialXMin;
          const spatialHeight = spatialYMax - spatialYMin;
          
          const viewLeftSpatial = (viewLeftImg / imgW) * spatialWidth + spatialXMin;
          const viewTopSpatial = (viewTopImg / imgH) * spatialHeight + spatialYMin;
          const viewWidthSpatial = (viewWidthImg / imgW) * spatialWidth;
          const viewHeightSpatial = (viewHeightImg / imgH) * spatialHeight;
          
          centerX = viewLeftSpatial + viewWidthSpatial / 2;
          centerYDeck = viewTopSpatial + viewHeightSpatial / 2;
          worldWidth = viewWidthSpatial;
          worldHeight = viewHeightSpatial;
        }
        
        const viewportWidth = dimensions.width;
        const viewportHeight = dimensions.height;
        const scaleX = viewportWidth / worldWidth;
        const scaleY = viewportHeight / worldHeight;
        const scale = Math.min(scaleX, scaleY);
        zoom = Math.log2(scale);
        
        const newViewState = {
          target: [centerX, centerYDeck, 0],
          zoom: zoom,
          minZoom: -10,
          maxZoom: 20,
        };
        
        console.log('Updated DeckGL viewState from OSD (final):', {
          newViewState,
          worldWidth,
          viewportWidth,
          zoom,
        });
        
        osdViewStateRef.current = newViewState;
        setOsdViewState(newViewState);
      } catch (e) {
        console.error('Error updating DeckGL viewState from OSD:', e);
      } finally {
        setTimeout(() => {
          isUpdatingFromOsdRef.current = false;
        }, 100);
      }
    };

    const updateHandler = () => {
      if (!isUpdatingFromOsdRef.current) {
        updateDeckGLViewState();
      }
    };

    viewer.addHandler('animation', updateHandler);
    viewer.addHandler('zoom', updateHandler);
    viewer.addHandler('pan', updateHandler);
    viewer.addHandler('resize', updateHandler);
    viewer.addHandler('update-viewport', updateHandler);

    const tryUpdate = () => {
      if (viewer.viewport && viewer.viewport.getBounds) {
        updateDeckGLViewState();
      } else {
        setTimeout(tryUpdate, 100);
      }
    };
    
    tryUpdate();
    
    viewer.addHandler('open', () => {
      setTimeout(tryUpdate, 100);
    });

    return () => {
      if (viewer && viewer.removeHandler) {
        viewer.removeHandler('animation', updateHandler);
        viewer.removeHandler('zoom', updateHandler);
        viewer.removeHandler('pan', updateHandler);
        viewer.removeHandler('resize', updateHandler);
        viewer.removeHandler('update-viewport', updateHandler);
      }
    };
  }, [spatialIndex, dimensions.width, dimensions.height, transformationMatrix, transformedSpatialData, histologyImage?.width, histologyImage?.height, osdViewerReady]);

  useEffect(() => {
    if (true) {
      return;
    }
    if (!osdViewerRef.current || !viewState || !histologyImage?.dziUrl || !transformationMatrix || isSyncingRef.current) {
      return;
    }

    try {
      const viewer = osdViewerRef.current;
      if (!viewer.viewport) {
        return;
      }

      const spatialCenterX = viewState.target[0];
      const spatialCenterY = viewState.target[1];

      
      const imgW = osdSizeRef.current?.x || histologyImage?.width || 1;
      const imgH = osdSizeRef.current?.y || histologyImage?.height || 1;

      const totalMegapixels = ((histologyImage?.width || 0) * (histologyImage?.height || 0)) / 1000000;
      const affineWasApplied = totalMegapixels <= 200 && histologyImage?.scale && Math.abs(histologyImage?.scale - 1) > 0.01;
      
      let imgCenterX, imgCenterY, viewportWidthImage, osdZoom;
      
      if (affineWasApplied) {
        const tx = histologyImage?.offset?.tx || transformationMatrix[0][2] || 0;
        const ty = histologyImage?.offset?.ty || transformationMatrix[1][2] || 0;
        const scale = histologyImage?.scale || 1;
        
        const spatialMinusTx = spatialCenterX - tx;
        const spatialMinusTy = spatialCenterY - ty;
        imgCenterX = spatialMinusTx / scale;
        imgCenterY = spatialMinusTy / scale;
        
        const deckglZoom = viewState.zoom || 0;
        const deckglScale = Math.pow(2, deckglZoom);
        const viewportWidthSpatial = dimensions.width / deckglScale;
        viewportWidthImage = viewportWidthSpatial / scale;
        osdZoom = imgW / viewportWidthImage;
      } else {
        const a = transformationMatrix[0][0];
        const b = transformationMatrix[0][1];
        const c = transformationMatrix[1][0];
        const d = transformationMatrix[1][1];
        const tx = transformationMatrix[0][2] || 0;
        const ty = transformationMatrix[1][2] || 0;

        const det = a * d - b * c;
        if (Math.abs(det) < 1e-10) {
          console.warn('Transformation matrix is singular');
          return;
        }

        const invA = d / det;
        const invB = -b / det;
        const invC = -c / det;
        const invD = a / det;

        const spatialMinusTx = spatialCenterX - tx;
        const spatialMinusTy = spatialCenterY - ty;
        imgCenterX = invA * spatialMinusTx + invB * spatialMinusTy;
        imgCenterY = invC * spatialMinusTx + invD * spatialMinusTy;
        
        const deckglZoom = viewState.zoom || 0;
        const deckglScale = Math.pow(2, deckglZoom);
        const viewportWidthSpatial = dimensions.width / deckglScale;
        const scale = Math.sqrt(a * a + c * c);
        viewportWidthImage = viewportWidthSpatial / scale;
        osdZoom = imgW / viewportWidthImage;
      }

      const normalizedX = imgCenterX / imgW;
      const normalizedY = imgCenterY / imgH;

      const clampedX = Math.max(0, Math.min(1, normalizedX));
      const clampedY = Math.max(0, Math.min(1, normalizedY));
      const minZoom = viewer.viewport.getMinZoom();
      const maxZoom = viewer.viewport.getMaxZoom();
      const clampedZoom = Math.max(minZoom, Math.min(maxZoom, osdZoom));

      const centerPoint = new OpenSeadragon.Point(clampedX, clampedY);
      viewer.viewport.panTo(centerPoint, false);
      viewer.viewport.zoomTo(clampedZoom, null, false);
    } catch (error) {
      console.error('Error syncing OpenSeadragon viewport:', error);
    }
  }, [viewState, histologyImage, transformationMatrix, dimensions.width, dimensions.height]);

  const activeViewState = osdViewState || viewState;

  const clientPointToSpatial = useCallback((clientX, clientY) => {
    const container = containerRef.current;
    const activeView = osdViewState || viewState;
    if (!container || !activeView || !dimensions.width || !dimensions.height) return null;
    const rect = container.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const scale = Math.pow(2, activeView.zoom || 0);
    const worldX = activeView.target[0] + (px - dimensions.width / 2) / scale;
    const worldY = activeView.target[1] + (py - dimensions.height / 2) / scale;

    if (transformedSpatialData) {
      const [sx, sy] = transformedSpatialData.toSpatialFromImage(worldX, worldY);
      const isBlankTileSource = !histologyImage?.dziUrl;
      if (isBlankTileSource || !needsScaling) return [sx, sy];
      return [sx * spatialScaleFactor, sy * spatialScaleFactor];
    }
    return [worldX, worldY];
  }, [dimensions.width, dimensions.height, histologyImage?.dziUrl, needsScaling, osdViewState, spatialScaleFactor, transformedSpatialData, viewState]);

  const spatialPointToScreen = useCallback((sx, sy) => {
    const activeView = osdViewState || viewState;
    if (!activeView || !dimensions.width || !dimensions.height) return null;
    let wx = sx;
    let wy = sy;
    if (transformedSpatialData) {
      const isBlankTileSource = !histologyImage?.dziUrl;
      const scaledX = isBlankTileSource || !needsScaling ? sx : sx / spatialScaleFactor;
      const scaledY = isBlankTileSource || !needsScaling ? sy : sy / spatialScaleFactor;
      [wx, wy] = transformedSpatialData.toImageFromSpatial(scaledX, scaledY);
    }
    const scale = Math.pow(2, activeView.zoom || 0);
    return [
      (wx - activeView.target[0]) * scale + dimensions.width / 2,
      (wy - activeView.target[1]) * scale + dimensions.height / 2,
    ];
  }, [dimensions.width, dimensions.height, histologyImage?.dziUrl, needsScaling, osdViewState, spatialScaleFactor, transformedSpatialData, viewState]);

  const pointInPolygon = useCallback((x, y, polygon) => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1];
      const xj = polygon[j][0], yj = polygon[j][1];
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }, []);

  const captureRegionImage = useCallback((polygon) => {
    if (!histologyImage?.dziUrl || !containerRef.current || !Array.isArray(polygon) || polygon.length < 3) {
      return null;
    }
    try {
      const root = containerRef.current.querySelector('.plot-view-content') || containerRef.current;
      const rootRect = root.getBoundingClientRect();
      const screenPoints = polygon.map(([x, y]) => spatialPointToScreen(x, y)).filter(Boolean);
      if (screenPoints.length < 3) return null;

      const pad = 32;
      const xs = screenPoints.map((p) => p[0]);
      const ys = screenPoints.map((p) => p[1]);
      const left = Math.max(0, Math.floor(Math.min(...xs) - pad));
      const top = Math.max(0, Math.floor(Math.min(...ys) - pad));
      const right = Math.min(dimensions.width, Math.ceil(Math.max(...xs) + pad));
      const bottom = Math.min(dimensions.height, Math.ceil(Math.max(...ys) + pad));
      const cropWidth = right - left;
      const cropHeight = bottom - top;
      if (cropWidth < 20 || cropHeight < 20) return null;

      const maxSide = 768;
      const scale = Math.min(1, maxSide / Math.max(cropWidth, cropHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(cropWidth * scale));
      canvas.height = Math.max(1, Math.round(cropHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const sourceCanvases = Array.from(root.querySelectorAll('canvas'));
      sourceCanvases.forEach((sourceCanvas) => {
        const rect = sourceCanvas.getBoundingClientRect();
        const canvasLeft = rect.left - rootRect.left;
        const canvasTop = rect.top - rootRect.top;
        const overlapLeft = Math.max(left, canvasLeft);
        const overlapTop = Math.max(top, canvasTop);
        const overlapRight = Math.min(right, canvasLeft + rect.width);
        const overlapBottom = Math.min(bottom, canvasTop + rect.height);
        if (overlapRight <= overlapLeft || overlapBottom <= overlapTop || !rect.width || !rect.height) return;

        const sx = (overlapLeft - canvasLeft) * (sourceCanvas.width / rect.width);
        const sy = (overlapTop - canvasTop) * (sourceCanvas.height / rect.height);
        const sw = (overlapRight - overlapLeft) * (sourceCanvas.width / rect.width);
        const sh = (overlapBottom - overlapTop) * (sourceCanvas.height / rect.height);
        const dx = (overlapLeft - left) * scale;
        const dy = (overlapTop - top) * scale;
        const dw = (overlapRight - overlapLeft) * scale;
        const dh = (overlapBottom - overlapTop) * scale;
        ctx.drawImage(sourceCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
      });

      ctx.save();
      ctx.beginPath();
      screenPoints.forEach(([x, y], idx) => {
        const px = (x - left) * scale;
        const py = (y - top) * scale;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = ROI_SELECTION_FILL;
      ctx.fill();
      ctx.setLineDash([8 * scale, 5 * scale]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = Math.max(9, 9 * scale);
      ctx.stroke();
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = Math.max(5, 5 * scale);
      ctx.stroke();
      ctx.restore();

      return canvas.toDataURL('image/jpeg', 0.86);
    } catch (error) {
      console.warn('Could not capture spatial ROI image for vision model:', error);
      return null;
    }
  }, [dimensions.height, dimensions.width, histologyImage?.dziUrl, spatialPointToScreen]);

  const finishSelection = useCallback((draft) => {
    if (!draft || !spatialIndex || !onSpatialRegionSelected) return;
    let polygon = [];
    if (draft.mode === 'rectangle' && draft.start && draft.end) {
      const x1 = draft.start[0], y1 = draft.start[1];
      const x2 = draft.end[0], y2 = draft.end[1];
      polygon = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    } else if (draft.mode === 'freehand' && draft.points?.length >= 3) {
      polygon = draft.points;
    }
    if (polygon.length < 3) return;

    const xs = spatialIndex.xs;
    const ys = spatialIndex.ys;
    const xVals = polygon.map((p) => p[0]);
    const yVals = polygon.map((p) => p[1]);
    const xMin = Math.min(...xVals);
    const xMax = Math.max(...xVals);
    const yMin = Math.min(...yVals);
    const yMax = Math.max(...yVals);
    const localIndices = [];
    const globalIndices = [];
    for (let i = 0; i < spatialIndex.pointCount; i += 1) {
      const x = xs[i];
      const y = ys[i];
      if (x < xMin || x > xMax || y < yMin || y > yMax) continue;
      if (pointInPolygon(x, y, polygon)) {
        localIndices.push(i);
        globalIndices.push(Array.isArray(cellIndexMap) ? (cellIndexMap[i] ?? i) : i);
      }
    }

    const nextRegionBase = {
      mode: draft.mode,
      polygon,
      localIndices,
      globalIndices,
      cellCount: globalIndices.length,
      format: dataInfo?.format || dataInfo?.modality || 'spatial',
      hasHistologyImage: !!histologyImage?.dziUrl,
      roiImageDataUrl: captureRegionImage(polygon),
    };
    setSelectedRegions((prev) => {
      const nextRegion = {
        ...nextRegionBase,
        id: `Region ${prev.length + 1}`,
      };
      const nextRegions = [...prev, nextRegion].map((region, index) => ({
        ...region,
        id: `Region ${index + 1}`,
      }));
      const activeRegion = nextRegions[nextRegions.length - 1];
      const payload = {
        ...activeRegion,
        regions: nextRegions,
        cellCount: activeRegion?.cellCount || 0,
        format: activeRegion?.format || dataInfo?.format || dataInfo?.modality || 'spatial',
      };
      onSpatialRegionSelected(payload);
      return nextRegions;
    });
  }, [captureRegionImage, cellIndexMap, dataInfo?.format, dataInfo?.modality, histologyImage?.dziUrl, onSpatialRegionSelected, pointInPolygon, spatialIndex]);

  const handleSelectionPointerDown = useCallback((event) => {
    if (!selectionMode) return;
    event.preventDefault();
    event.stopPropagation();
    const point = clientPointToSpatial(event.clientX, event.clientY);
    if (!point) return;
    const draft = selectionMode === 'rectangle'
      ? { mode: selectionMode, start: point, end: point }
      : { mode: selectionMode, points: [point] };
    selectionDragRef.current = draft;
    setSelectionDraft(draft);
  }, [clientPointToSpatial, selectionMode]);

  const handleSelectionPointerMove = useCallback((event) => {
    const draft = selectionDragRef.current;
    if (!draft) return;
    event.preventDefault();
    event.stopPropagation();
    const point = clientPointToSpatial(event.clientX, event.clientY);
    if (!point) return;
    const nextDraft = draft.mode === 'rectangle'
      ? { ...draft, end: point }
      : { ...draft, points: [...draft.points, point] };
    selectionDragRef.current = nextDraft;
    setSelectionDraft(nextDraft);
  }, [clientPointToSpatial]);

  const handleSelectionPointerUp = useCallback((event) => {
    const draft = selectionDragRef.current;
    if (!draft) return;
    event.preventDefault();
    event.stopPropagation();
    selectionDragRef.current = null;
    setSelectionDraft(null);
    finishSelection(draft);
  }, [finishSelection]);

  const regionPaths = useMemo(() => {
    return selectedRegions.map((region) => {
      const polygon = region?.polygon || [];
      const screenPoints = polygon.map(([x, y]) => spatialPointToScreen(x, y)).filter(Boolean);
      if (!screenPoints.length) return null;
      return {
        id: region.id,
        cellCount: region.cellCount || 0,
        d: screenPoints.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ') + (screenPoints.length > 2 ? ' Z' : ''),
      };
    }).filter(Boolean);
  }, [selectedRegions, spatialPointToScreen]);

  const selectionPath = useMemo(() => {
    const draft = selectionDraft;
    if (!draft) return null;
    let polygon = [];
    if (draft.polygon) {
      polygon = draft.polygon;
    } else if (draft.mode === 'rectangle' && draft.start && draft.end) {
      const [x1, y1] = draft.start;
      const [x2, y2] = draft.end;
      polygon = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    } else if (draft.points?.length) {
      polygon = draft.points;
    }
    const screenPoints = polygon.map(([x, y]) => spatialPointToScreen(x, y)).filter(Boolean);
    if (!screenPoints.length) return null;
    return screenPoints.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ') + (screenPoints.length > 2 ? ' Z' : '');
  }, [selectionDraft, spatialPointToScreen]);

  const layers = useMemo(() => {
    if (!spatialIndex || !currentViewBounds) {
      return [];
    }

    const layerList = [];

    if (histologyImage && !transformationMatrix) {
      if (histologyImage.dziUrl) {
        console.log('Using OpenSeadragon for DZI image');
      } else if (histologyImageBounds) {
        const imageUrl = histologyImage.imageUrl || histologyImage.fileUrl || histologyImage.dataUrl;
        if (imageUrl && histologyImageBounds) {
          const maxTextureSize = 8192;
          const imageWidth = histologyImage.width || 0;
          const imageHeight = histologyImage.height || 0;
          
          if (!imageWidth || !imageHeight || (imageWidth <= maxTextureSize && imageHeight <= maxTextureSize)) {
            try {
              layerList.push(
                new BitmapLayer({
                  id: 'histology-image',
                  image: imageUrl,
                  bounds: [
                    histologyImageBounds.xMin,
                    histologyImageBounds.yMin,
                    histologyImageBounds.xMax,
                    histologyImageBounds.yMax,
                  ],
                  opacity: imageOpacity,
                  desaturate: 0,
                  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
                  // eslint-disable-next-line no-useless-computed-key
                  textureParameters: {
                    10241: 9729,
                    10240: 9729,
                    10242: 33071,
                    10243: 33071,
                  },
                })
              );
            } catch (error) {
              console.warn('Failed to create BitmapLayer for histology image:', error);
            }
          } else {
            console.warn(`Histology image is too large (${imageWidth}x${imageHeight}). Maximum texture size: ${maxTextureSize}x${maxTextureSize}. Please use a TIFF file which will be converted to DZI format automatically.`);
          }
        }
      }
    }

    if (showBackgroundImage && imageInfo && bounds) {
      const maxTextureSize = 8192;
      const imageWidth = imageInfo.width || 0;
      const imageHeight = imageInfo.height || 0;
      
      if (!imageWidth || !imageHeight || (imageWidth <= maxTextureSize && imageHeight <= maxTextureSize)) {
        try {
          layerList.push(
            new BitmapLayer({
              id: 'spatial-histology',
              image: imageInfo.url,
              bounds: [
                bounds.xMin,
                bounds.yMin,
                bounds.xMin + imageInfo.width,
                bounds.yMin + imageInfo.height,
              ],
              opacity: 0.7,
              desaturate: 0,
              coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
              textureParameters: {
                10241: 9729,
                10240: 9729,
                10242: 33071,
                10243: 33071,
              },
            })
          );
        } catch (error) {
          console.warn('Failed to create BitmapLayer for background image:', error);
        }
      } else {
        console.warn(`Background image is too large (${imageWidth}x${imageHeight}). Maximum texture size: ${maxTextureSize}x${maxTextureSize}.`);
      }
    }

    const useImageCoords = !!transformedSpatialData;
    
    if (renderState.mode === 'density' && renderState.density) {
      layerList.push(
        new ScreenGridLayer({
          id: 'spatial-density',
          data: renderState.density.data,
          getPosition: (d) => {
            const x = spatialIndex.xs[d.index];
            const y = spatialIndex.ys[d.index];
            if (useImageCoords && transformedSpatialData) {
              const isBlankTileSource = !histologyImage?.dziUrl;
              let scaledX, scaledY;
              if (isBlankTileSource || !needsScaling) {
                scaledX = x;
                scaledY = y;
              } else {
                scaledX = x / spatialScaleFactor;
                scaledY = y / spatialScaleFactor;
              }
              const [imgX, imgY] = transformedSpatialData.toImageFromSpatial(scaledX, scaledY);
              return [imgX, imgY];
            }
            return [x, y];
          },
          getWeight: (d) => d.weight,
          cellSizePixels: 40,
          colorRange: DENSITY_COLOR_RANGE,
          opacity: 0.9,
          pickable: false,
          aggregation: 'SUM',
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        })
      );
    } else if (renderState.mode === 'points' && renderState.points?.length) {
      const positions = renderState.points.positions;
      const colors = renderState.points.colors;
      
      const sampleCount = renderState.points.indices.length;
      console.log('Creating ScatterplotLayer:', {
        pointCount: sampleCount,
        useImageCoords,
        hasTransformedData: !!transformedSpatialData,
        transformedData: transformedSpatialData,
        spatialIndexBounds: spatialIndex?.bounds,
        currentViewBounds,
        activeViewState,
      });
      
      let renderedXMin = Number.POSITIVE_INFINITY;
      let renderedXMax = Number.NEGATIVE_INFINITY;
      let renderedYMin = Number.POSITIVE_INFINITY;
      let renderedYMax = Number.NEGATIVE_INFINITY;
      let renderedCount = 0;
      
      layerList.push(
        new ScatterplotLayer({
          id: `spatial-cells-${renderState.level}`,
          data: renderState.points.indices,
          getPosition: (_, { index }) => {
            const idx = renderState.points.indices[index];
            const x = spatialIndex.xs[idx];
            const y = spatialIndex.ys[idx];
            if (useImageCoords && transformedSpatialData) {
              const isBlankTileSource = !histologyImage?.dziUrl;
              let scaledX, scaledY;
              if (isBlankTileSource || !needsScaling) {
                scaledX = x;
                scaledY = y;
              } else {
                scaledX = x / spatialScaleFactor;
                scaledY = y / spatialScaleFactor;
              }
              const [imgX, imgY] = transformedSpatialData.toImageFromSpatial(scaledX, scaledY);

              if (Number.isFinite(imgX) && Number.isFinite(imgY)) {
                renderedXMin = Math.min(renderedXMin, imgX);
                renderedXMax = Math.max(renderedXMax, imgX);
                renderedYMin = Math.min(renderedYMin, imgY);
                renderedYMax = Math.max(renderedYMax, imgY);
                renderedCount++;
              }

              if (index < 10) {
                const inBounds = imgX >= 0 && imgX <= transformedSpatialData.imgW &&
                                imgY >= 0 && imgY <= transformedSpatialData.imgH;
                console.log(`Point ${index}:`, {
                  spatial: [x, y],
                  scaledSpatial: [scaledX, scaledY],
                  imagePixel: [imgX, imgY],
                  inImageBounds: inBounds,
                  imageSize: [transformedSpatialData.imgW, transformedSpatialData.imgH],
                  transformUsed: transformedSpatialData.label,
                });
              }

              return [imgX, imgY];
            }
            return [positions[index * 2], positions[index * 2 + 1]];
          },
          getFillColor: (_, { index }) => [
            colors[index * 4],
            colors[index * 4 + 1],
            colors[index * 4 + 2],
            colors[index * 4 + 3],
          ],
          getRadius: () => radiusPixels,
          radiusUnits: 'pixels',
          radiusScale: zoomScale,
          radiusMinPixels: radiusPixels * MIN_ZOOM_SCALE,
          radiusMaxPixels: radiusPixels * pointMaxZoomScale,
          opacity: 1.0,
          stroked: false,
          pickable: true,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          updateTriggers: {
            getPosition: [transformedSpatialData, activeViewState],
            getFillColor: [colorBuffer],
          },
        })
      );
      
      if (useImageCoords && transformedSpatialData && renderedCount > 0) {
        console.log('=== RENDERED Scatter Plot Coordinates (after transformation) ===');
        console.log('Rendered point count:', renderedCount);
        console.log('xMin:', renderedXMin, 'xMax:', renderedXMax, 'xRange:', renderedXMax - renderedXMin);
        console.log('yMin:', renderedYMin, 'yMax:', renderedYMax, 'yRange:', renderedYMax - renderedYMin);
        console.log('Offset from origin:', {
          offsetX: renderedXMin,
          offsetY: renderedYMin,
          note: 'If these are not 0, the scatter plot will be offset from the image origin'
        });
        console.log('Expected range (from transformedSpatialData):', {
          xMin: transformedSpatialData.imageXMin,
          xMax: transformedSpatialData.imageXMax,
          yMin: transformedSpatialData.imageYMin,
          yMax: transformedSpatialData.imageYMax,
        });
        console.log('Image size:', {
          width: transformedSpatialData.imgW,
          height: transformedSpatialData.imgH,
        });
      }
    }

    return layerList;
  }, [
    spatialIndex,
    currentViewBounds,
    renderState,
    radiusPixels,
    pointMaxZoomScale,
    imageInfo,
    bounds,
    showBackgroundImage,
    zoomScale,
    histologyImage,
    histologyImageBounds,
    transformationMatrix,
    transformedSpatialData,
    activeViewState,
    colorBuffer,
    imageOpacity,
    needsScaling,
    spatialScaleFactor,
  ]);

  const ready =
    activeViewState &&
    Number.isFinite(activeViewState.zoom) &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    spatialIndex;
  
  useEffect(() => {
    console.log('Spatial view ready check:', {
      ready,
      hasActiveViewState: !!activeViewState,
      hasOsdViewState: !!osdViewState,
      hasViewState: !!viewState,
      activeViewStateZoom: activeViewState?.zoom,
      viewStateZoom: viewState?.zoom,
      dimensions: { width: dimensions.width, height: dimensions.height },
      hasSpatialIndex: !!spatialIndex,
      layersCount: layers.length,
      hasImage: !!histologyImage?.dziUrl,
      hasTransformationMatrix: !!transformationMatrix,
    });
  }, [ready, activeViewState, osdViewState, viewState, dimensions.width, dimensions.height, spatialIndex, layers.length, histologyImage?.dziUrl, transformationMatrix]);

  if (!hasCoordinates) {
    return (
      <div className="plot-view" ref={containerRef}>
        <div className="plot-view-content">
          <div className="plot-placeholder">
            <Icon icon="map" size={48} color="#ccc" />
            <p>No spatial coordinates available. Load Xenium, Visium HD, MERFISH, or CosMX data to view spatial plots.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
  <div className="plot-view spatial-view" ref={containerRef} onContextMenu={handleContextMenu}>
      <div className="plot-view-content" style={{ position: 'relative' }}>
        <div
          ref={osdContainerRef}
          onMouseEnter={() => {
            setIsHovering(selectedClusters.size > 0 || (legendHighlightSelection?.clusterIds?.size > 0));
          }}
          onMouseLeave={() => {
            setIsHovering(false);
          }}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            opacity: histologyImage?.dziUrl ? imageOpacity : 1,
            pointerEvents: 'auto',
            zIndex: 1,
            visibility: ready ? 'visible' : 'hidden',
          }}
        />
        {!ready && (
          <div className="plot-placeholder">
            <Spinner size={32} />
            <p>Preparing spatial view…</p>
          </div>
        )}
        {ready && (
          <>
            <div className="histology-image-controls">
              <ButtonGroup>
                <Button
                  icon="select"
                  active={selectionMode === 'rectangle'}
                  onClick={() => setSelectionMode((mode) => mode === 'rectangle' ? null : 'rectangle')}
                  title="Rectangle region selection"
                />
                <Button
                  icon="draw"
                  active={selectionMode === 'freehand'}
                  onClick={() => setSelectionMode((mode) => mode === 'freehand' ? null : 'freehand')}
                  title="Freehand region selection"
                />
                {selectedRegions.length > 0 && (
                  <Button
                    icon="small-cross"
                    minimal
                    onClick={() => {
                      setSelectedRegions([]);
                      onSpatialRegionSelected?.(null);
                    }}
                    title="Clear selected regions"
                  />
                )}
              </ButtonGroup>
              <Button
                icon="media"
                text="Add Image"
                onClick={handleAddImage}
                loading={loadingHistology}
                disabled={loadingHistology}
                title="Load histology image with optional transformation matrix"
              />
              {histologyImage && (
                <Button
                  icon="cross"
                  minimal
                  small
                  onClick={() => {
                    setHistologyImage(null);
                    setTransformationMatrix(null);
                    setHistologyImageBounds(null);
                  }}
                  title="Remove histology image"
                />
              )}
            </div>
            <HistologyImageDialog
              isOpen={showHistologyDialog}
              onClose={handleCloseHistologyDialog}
              onImageLoaded={handleHistologyImageLoaded}
              onLoadingChange={setLoadingHistology}
            />
            <svg
              className={`spatial-selection-overlay${selectionMode ? ' is-active' : ''}`}
              width={dimensions.width}
              height={dimensions.height}
              onPointerDown={handleSelectionPointerDown}
              onPointerMove={handleSelectionPointerMove}
              onPointerUp={handleSelectionPointerUp}
              onPointerCancel={handleSelectionPointerUp}
            >
              {regionPaths.map((regionPath, index) => (
                <g key={regionPath.id || index}>
                  <path
                    d={regionPath.d}
                    style={{ fill: ROI_SELECTION_FILL }}
                  />
                  <path
                    className="selection-halo"
                    d={regionPath.d}
                  />
                  <path
                    className="selection-outline"
                    d={regionPath.d}
                  />
                </g>
              ))}
              {selectionPath && (
                <>
                  <path d={selectionPath} style={{ fill: ROI_SELECTION_FILL }} />
                  <path className="selection-halo" d={selectionPath} />
                  <path className="selection-outline" d={selectionPath} />
                </>
              )}
              {selectedRegions.length > 0 && (
                <text x={12} y={24}>
                  {selectedRegions.map((region) => `${region.id}: ${region.cellCount.toLocaleString()}`).join(' · ')}
                </text>
              )}
            </svg>
          </>
        )}
      </div>
    </div>
  );
};

export default SpatialPlotView;
