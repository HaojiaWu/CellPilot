import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import DeckGL from '@deck.gl/react';
import {
  OrthographicController,
  OrthographicView,
  COORDINATE_SYSTEM,
} from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { ScreenGridLayer } from '@deck.gl/aggregation-layers';
import { TextLayer } from '@deck.gl/layers';
import { Spinner, Icon } from '@blueprintjs/core';
import * as d3 from 'd3';
import {
  buildSpatialIndex,
  gatherDensitySample,
  gatherSamplesForViewport,
} from '../utils/spatialIndex';

const UMAP_BASE_COLOR = [102, 126, 234, 200];
const UMAP_DENSITY_COLOR_RANGE = [
  [255, 255, 255, 0],
  [198, 219, 239, 70],
  [158, 202, 225, 120],
  [107, 174, 214, 170],
  [49, 130, 189, 220],
  [8, 81, 156, 255],
];
const UMAP_MAX_SAMPLE_POINTS = 500_000;
const UMAP_DENSITY_THRESHOLD = 2_500_000;
const UMAP_INITIAL_MIN_ZOOM_PAD = 20;
const UMAP_INITIAL_MAX_ZOOM_PAD = 24;
const UMAP_ZOOM_SCALE_PER_LEVEL = 1.5;
const UMAP_MIN_ZOOM_SCALE = 0.3;
const UMAP_MAX_ZOOM_SCALE = 12;

const baseClusterPalette = [
  ...d3.schemeCategory10,
  ...(d3.schemeSet3 || []),
  ...(d3.schemePaired || []),
  ...(d3.schemeDark2 || []),
  ...(d3.schemePastel1 || []),
  ...(d3.schemePastel2 || []),
];

const ensurePaletteLength = (targetSize) => {
  if (targetSize <= baseClusterPalette.length) {
    return baseClusterPalette.slice(0, targetSize);
  }
  const palette = baseClusterPalette.slice();
  const needed = targetSize - palette.length;
  const extras = d3
    .quantize(d3.interpolateTurbo, needed + 2)
    .slice(1, needed + 1);
  return palette.concat(extras);
};

const sortClusterIds = (ids) =>
  ids.slice().sort((a, b) => {
    const numA = Number(a);
    const numB = Number(b);
    const validA = !Number.isNaN(numA);
    const validB = !Number.isNaN(numB);
    if (validA && validB) {
      return numA - numB;
    }
    return String(a).localeCompare(String(b));
  });

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

const createClusterColorScale = (clusterIds) => {
  if (!Array.isArray(clusterIds) || clusterIds.length === 0) {
    return null;
  }
  const sortedIds = sortClusterIds(clusterIds);
  const domain = sortedIds.map((id) => String(id));
  const palette = ensurePaletteLength(domain.length);
  return d3.scaleOrdinal(palette).domain(domain);
};

const colorArrayToCss = (rgba) => {
  if (!Array.isArray(rgba) || rgba.length < 3) {
    return 'rgba(102, 126, 234, 0.78)';
  }
  const alpha = rgba.length > 3 ? rgba[3] / 255 : 1;
  return `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${alpha})`;
};

const valueToRgba = (value, fallback = UMAP_BASE_COLOR) => {
  if (!value) {
    return fallback;
  }
  if (Array.isArray(value) && value.length >= 3) {
    const alpha = value.length > 3 ? value[3] : 255;
    return [value[0], value[1], value[2], alpha];
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

const computeOrthoViewBounds = (view, width, height) => {
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

const determineUmapPointRadius = (totalCells) => {
  if (!Number.isFinite(totalCells)) {
    return 0.9;
  }
  if (totalCells <= 10000) {
    return 1.5;
  }
  if (totalCells <= 100000) {
    return 1.1;
  }
  if (totalCells <= 500000) {
    return 0.8;
  }
  return 0.5;
};

const UmapDeckView = ({
  coordinates = [],
  clusters = [],
  clusterColorDomain = null,
  selectedClusters = new Set(),
  onSelectClusters = null,
  clusterColorOverrides = {},
  clusterLabelMap = {},
  onChangeClusterColor = null,
  geneExpression = null,
  rnaClustersForAtacHighlight = null,
  rnaClusterHighlightOnAtac = null,
  atacClustersForRnaHighlight = null,
  atacClusterHighlightOnRna = null,
  legendHighlightSelection = null,
  onLegendClusterClick = null,
  onClearLegendHighlight = null,
  viewModality = null,
  otherModalityClusters = null,
  cellBarcodes = null,
  highlightCellMask = null,
}) => {
  const containerRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [viewState, setViewState] = useState(null);
  const [baseZoom, setBaseZoom] = useState(null);
  const [samplingViewState, setSamplingViewState] = useState(null);
  const samplingRafRef = useRef(null);
  const initialSamplingRef = useRef(false);
  const [isHovering, setIsHovering] = useState(false);

  const spatialIndex = useMemo(() => {
    if (!coordinates.length) {
      return null;
    }
    return buildSpatialIndex(coordinates, {
      maxLevels: 11,
      baseSamplesPerTile: 2000,
      levelSampleMultiplier: 2.0,
      hardSampleCap: 50000,
    });
  }, [coordinates]);

  const totalPoints = spatialIndex?.pointCount || 0;
  const radiusPixels = useMemo(
    () => determineUmapPointRadius(totalPoints),
    [totalPoints]
  );

  const normalizeCluster = useCallback((c) => {
    if (c == null) return '0';
    const s = String(c).trim().toLowerCase();
    if (s === 'null' || s === '' || s === 'nan' || s === 'na' || s === 'undefined') return '0';
    return String(c);
  }, []);

  const normalizedClusters = useMemo(() => (
    Array.isArray(clusters) ? clusters.map(normalizeCluster) : []
  ), [clusters, normalizeCluster]);

  const otherNormalizedClusters = useMemo(() => (
    Array.isArray(otherModalityClusters) ? otherModalityClusters.map(normalizeCluster) : []
  ), [otherModalityClusters, normalizeCluster]);

  const normalizedCellBarcodes = useMemo(() => (
    Array.isArray(cellBarcodes) ? cellBarcodes.map((barcode) => String(barcode ?? '').trim()) : []
  ), [cellBarcodes]);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const updateDimensions = () => {
      if (!containerRef.current) {
        return;
      }
      const { clientWidth = 0, clientHeight = 0 } = containerRef.current;
      setDimensions({
        width: clientWidth,
        height: clientHeight,
      });
    };

    updateDimensions();
    const observer = new ResizeObserver(updateDimensions);
    observer.observe(containerRef.current);

    return () => observer.disconnect();
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

    setViewState((prev) => ({
      ...prev,
      target: [centerX, centerY, 0],
      zoom,
      width: dimensions.width,
      height: dimensions.height,
      minZoom: zoom - UMAP_INITIAL_MIN_ZOOM_PAD,
      maxZoom: zoom + UMAP_INITIAL_MAX_ZOOM_PAD,
    }));
  }, [bounds, dimensions.width, dimensions.height]);

  useEffect(() => {
    if (
      baseZoom == null &&
      typeof viewState?.zoom === 'number' &&
      Number.isFinite(viewState?.zoom)
    ) {
      setBaseZoom(viewState.zoom);
    }
  }, [viewState?.zoom, baseZoom]);

  useEffect(() => {
    if (!viewState) {
      return undefined;
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

  const handleViewStateChange = useCallback(
    ({ viewState: nextViewState }) => {
      setViewState((prev) => {
        const nextZoom =
          typeof nextViewState.zoom === 'number'
            ? nextViewState.zoom
            : prev?.zoom ?? baseZoom ?? 0;

        let minZoom =
          prev?.minZoom ??
          (baseZoom ?? nextZoom) - UMAP_INITIAL_MIN_ZOOM_PAD;
        let maxZoom =
          prev?.maxZoom ??
          (baseZoom ?? nextZoom) + UMAP_INITIAL_MAX_ZOOM_PAD;

        if (nextZoom >= maxZoom - 1) {
          maxZoom = nextZoom + UMAP_INITIAL_MAX_ZOOM_PAD;
        }
        if (nextZoom <= minZoom + 1) {
          minZoom = nextZoom - UMAP_INITIAL_MIN_ZOOM_PAD;
        }

        return {
          ...prev,
          ...nextViewState,
          width: dimensions.width,
          height: dimensions.height,
          minZoom,
          maxZoom,
        };
      });
    },
    [dimensions.width, dimensions.height, baseZoom]
  );

  const handleZoomIn = useCallback(() => {
    setViewState((prev) => {
      if (!prev) return prev;
      const currentZoom = prev.zoom ?? 0;
      const maxZoom = prev.maxZoom ?? currentZoom + UMAP_INITIAL_MAX_ZOOM_PAD;
      const newZoom = Math.min(currentZoom + 0.2, maxZoom);
      return { ...prev, zoom: newZoom };
    });
  }, []);

  const handleZoomOut = useCallback(() => {
    setViewState((prev) => {
      if (!prev) return prev;
      const currentZoom = prev.zoom ?? 0;
      const minZoom = prev.minZoom ?? currentZoom - UMAP_INITIAL_MIN_ZOOM_PAD;
      const newZoom = Math.max(currentZoom - 0.2, minZoom);
      return { ...prev, zoom: newZoom };
    });
  }, []);

  const colorState = useMemo(() => {
    if (geneExpression && geneExpression.expression && geneExpression.coordinates) {
      const expression = geneExpression.expression;

      let minExp = undefined;
      let maxExp = undefined;
      if (Array.isArray(geneExpression.expressionRange) && geneExpression.expressionRange.length >= 2 &&
          Number.isFinite(geneExpression.expressionRange[0]) && Number.isFinite(geneExpression.expressionRange[1])) {
        minExp = geneExpression.expressionRange[0];
        maxExp = geneExpression.expressionRange[1];
      }
      if (minExp === undefined || maxExp === undefined) {
        minExp = Number.isFinite(geneExpression.globalMinExp) ? geneExpression.globalMinExp : undefined;
        maxExp = Number.isFinite(geneExpression.globalMaxExp) ? geneExpression.globalMaxExp : undefined;
      }
      if (minExp === undefined || maxExp === undefined) {
        const expressionExtent = d3.extent(expression);
        [minExp, maxExp] = expressionExtent;
      }

      if (!isFinite(minExp) || !isFinite(maxExp)) {
        console.warn('Invalid expression values for UMAP coloring:', { minExp, maxExp });
        return { getColor: () => UMAP_BASE_COLOR, legendEntries: null, isGeneExpression: true };
      }
      if (minExp === maxExp) {
        maxExp = minExp + 1e-6;
      }

      const colorDef = geneExpression.colorMap || { type: 'custom', colors: ['lightgray', 'orange', 'red'] };
      const safeRange = maxExp - minExp || 1;

      let colorFn;
      if (colorDef?.type === 'custom' && Array.isArray(colorDef.colors) && colorDef.colors.length >= 2) {
        const colors = colorDef.colors;
        const steps = colors.length - 1;
        const domain = colors.map((_, idx) => minExp + (safeRange * idx) / steps);
        const scale = d3.scaleLinear().domain(domain).range(colors).clamp(true);
        colorFn = (value) => scale(value);
      } else {
        const defaultColors = ['lightgray', 'orange', 'red'];
        const steps = defaultColors.length - 1;
        const domain = defaultColors.map((_, idx) => minExp + (safeRange * idx) / steps);
        const scale = d3.scaleLinear().domain(domain).range(defaultColors).clamp(true);
        colorFn = (value) => scale(value);
      }

      const colorToRgba = (color) => {
        if (typeof color === 'string' && color.toLowerCase().trim() === 'transparent') {
          return [0, 0, 0, 0];
        }
        const parsed = d3.color(color);
        if (!parsed) {
          return UMAP_BASE_COLOR;
        }
        return [
          parsed.r,
          parsed.g,
          parsed.b,
          Math.round((parsed.opacity ?? 1) * 255),
        ];
      };

      const hasRnaHighlightGene =
        rnaClusterHighlightOnAtac != null &&
        Array.isArray(rnaClustersForAtacHighlight) &&
        rnaClustersForAtacHighlight.length === expression.length;
      const hasAtacHighlightGene =
        atacClusterHighlightOnRna != null &&
        Array.isArray(atacClustersForRnaHighlight) &&
        atacClustersForRnaHighlight.length === expression.length;
      const getColor = (index) => {
        if (hasRnaHighlightGene && index < rnaClustersForAtacHighlight.length) {
          const rnaCluster = rnaClustersForAtacHighlight[index];
          const match =
            Number(rnaCluster) === Number(rnaClusterHighlightOnAtac) ||
            String(rnaCluster).trim() === String(rnaClusterHighlightOnAtac).trim();
          if (match) return [255, 0, 0, 255];
        }
        if (hasAtacHighlightGene && index < atacClustersForRnaHighlight.length) {
          const atacCluster = atacClustersForRnaHighlight[index];
          const match =
            Number(atacCluster) === Number(atacClusterHighlightOnRna) ||
            String(atacCluster).trim() === String(atacClusterHighlightOnRna).trim();
          if (match) return [255, 0, 0, 255];
        }
        if (index >= expression.length) {
          return UMAP_BASE_COLOR;
        }
        const value = expression[index];
        const color = colorFn(value);
        return colorToRgba(color);
      };

      let legendGradient = 'linear-gradient(to top, lightgray, orange, red)';
      if (colorDef?.type === 'custom' && Array.isArray(colorDef.colors) && colorDef.colors.length >= 2) {
        legendGradient = `linear-gradient(to top, ${colorDef.colors.join(', ')})`;
      } else if (colorDef?.type === 'scheme' && colorDef?.name) {
        const interpolateMap = {
          viridis: d3.interpolateViridis,
          magma: d3.interpolateMagma,
          inferno: d3.interpolateInferno,
          plasma: d3.interpolatePlasma,
          cividis: d3.interpolateCividis,
          turbo: d3.interpolateTurbo,
          cubehelix: d3.interpolateCubehelixDefault,
        };
        const interpolator = interpolateMap[colorDef.name.toLowerCase()] || d3.interpolateViridis;
        const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => interpolator(t));
        legendGradient = `linear-gradient(to top, ${stops.join(', ')})`;
      }

      return {
        getColor,
        legendEntries: null,
        isGeneExpression: true,
        geneName: geneExpression.geneName,
        minExp,
        maxExp,
        colorFn: colorToRgba,
        legendGradient,
      };
    }

    const useGlobalDomain = Array.isArray(clusterColorDomain) && clusterColorDomain.length > 0;
    const hasClusterData = Array.isArray(normalizedClusters) && normalizedClusters.length > 0;
    if (!useGlobalDomain && !hasClusterData) {
      return { getColor: () => UMAP_BASE_COLOR, legendEntries: null };
    }

    const uniqueClusters = useGlobalDomain
      ? Array.from(new Set([...clusterColorDomain, ...(normalizedClusters || [])]))
      : Array.from(new Set(normalizedClusters));

    const clusterIdToLabel = {};
    uniqueClusters.forEach((clusterId) => {
      const key = String(clusterId);
      let label = formatClusterLabel(clusterId, clusterLabelMap);
      if (/^null$/i.test(label) || label === '') label = key;
      clusterIdToLabel[key] = label;
    });

    const labelToClusterIds = {};
    Object.entries(clusterIdToLabel).forEach(([clusterId, label]) => {
      if (!labelToClusterIds[label]) {
        labelToClusterIds[label] = [];
      }
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
      return { getColor: () => UMAP_BASE_COLOR, legendEntries: null };
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
      entries.push({ id: firstClusterId, label, color: valueToRgba(baseColor) });
    });

    const DIMMED_COLOR = [160, 174, 192, 180];
    const RNA_HIGHLIGHT_RED = [255, 0, 0, 255];
    const hasRnaHighlight =
      rnaClusterHighlightOnAtac != null &&
      Array.isArray(rnaClustersForAtacHighlight) &&
      rnaClustersForAtacHighlight.length === normalizedClusters.length;
    const hasAtacHighlight =
      atacClusterHighlightOnRna != null &&
      Array.isArray(atacClustersForRnaHighlight) &&
      atacClustersForRnaHighlight.length === normalizedClusters.length;
    const getColor = (index) => {
      if (highlightCellMask !== null) {
        const clusterValue = String(normalizedClusters[index]);
        const label = clusterIdToLabel[clusterValue];
        const override = clusterColorOverrides?.[clusterValue];
        const colorValue = override || scale(label ?? clusterValue);
        if (highlightCellMask[index]) return valueToRgba(colorValue);
        return [160, 174, 192, 80];
      }
      if (legendHighlightSelection && viewModality) {
        const sel = legendHighlightSelection;
        if (sel.selectedBarcodes instanceof Set && sel.selectedBarcodes.size > 0 && normalizedCellBarcodes.length === normalizedClusters.length) {
          const barcode = normalizedCellBarcodes[index];
          if (sel.selectedBarcodes.has(barcode)) {
            return sel.color || [255, 127, 14, 255];
          }
          return DIMMED_COLOR;
        }
        const cid = sel.modality === viewModality
          ? String(normalizedClusters[index] ?? '')
          : String(otherNormalizedClusters[index] ?? '');
        if (sel.clusterIds.has(cid) && sel.clusterIdToColor[cid]) {
          return sel.clusterIdToColor[cid];
        }
        return DIMMED_COLOR;
      }
      if (hasRnaHighlight) {
        const rnaCluster = rnaClustersForAtacHighlight[index];
        const match =
          Number(rnaCluster) === Number(rnaClusterHighlightOnAtac) ||
          String(rnaCluster).trim() === String(rnaClusterHighlightOnAtac).trim();
        if (match) return RNA_HIGHLIGHT_RED;
        return [160, 174, 192, 120];
      }
      if (hasAtacHighlight) {
        const atacCluster = atacClustersForRnaHighlight[index];
        const match =
          Number(atacCluster) === Number(atacClusterHighlightOnRna) ||
          String(atacCluster).trim() === String(atacClusterHighlightOnRna).trim();
        if (match) return RNA_HIGHLIGHT_RED;
        return [160, 174, 192, 120];
      }
      const clusterValue = String(normalizedClusters[index]);
      const label = clusterIdToLabel[clusterValue];
      const override = clusterColorOverrides?.[clusterValue];
      const colorValue = override || scale(label ?? clusterValue);
      if (selectedClusters.size === 0) {
        return valueToRgba(colorValue);
      }
      if (isHovering && !selectedClusters.has(clusterValue)) {
        return [0, 0, 0, 0];
      }
      return selectedClusters.has(clusterValue)
        ? valueToRgba(colorValue)
        : DIMMED_COLOR;
    };
    return { getColor, legendEntries: entries, scale };
  }, [normalizedClusters, otherNormalizedClusters, normalizedCellBarcodes, selectedClusters, clusterColorOverrides, clusterLabelMap, clusterColorDomain, isHovering, geneExpression, rnaClustersForAtacHighlight, rnaClusterHighlightOnAtac, atacClustersForRnaHighlight, atacClusterHighlightOnRna, legendHighlightSelection, viewModality, highlightCellMask]);

  const colorBuffer = useMemo(() => {
    if (!spatialIndex) {
      return null;
    }
    const { pointCount } = spatialIndex;
    const buffer = new Uint8Array(pointCount * 4);
    for (let i = 0; i < pointCount; i += 1) {
      const rgba = colorState.getColor(i) || UMAP_BASE_COLOR;
      buffer[i * 4] = rgba[0];
      buffer[i * 4 + 1] = rgba[1];
      buffer[i * 4 + 2] = rgba[2];
      buffer[i * 4 + 3] = rgba[3];
    }
    return buffer;
  }, [spatialIndex, colorState]);

  const clusterLabels = useMemo(() => {
    if (!spatialIndex || !Array.isArray(normalizedClusters) || normalizedClusters.length === 0) {
      return [];
    }

    const labelCentroids = new Map();
    const labelCounts = new Map();

    for (let i = 0; i < spatialIndex.pointCount; i += 1) {
      const clusterId = String(normalizedClusters[i]);
      const label = formatClusterLabel(clusterId, clusterLabelMap) || clusterId;

      if (!labelCentroids.has(label)) {
        labelCentroids.set(label, { x: 0, y: 0 });
        labelCounts.set(label, 0);
      }
      const centroid = labelCentroids.get(label);
      centroid.x += spatialIndex.xs[i];
      centroid.y += spatialIndex.ys[i];
      labelCounts.set(label, labelCounts.get(label) + 1);
    }

    const labels = [];
    for (const [label, centroid] of labelCentroids.entries()) {
      const count = labelCounts.get(label);
      if (count > 0) {
        labels.push({
          id: label,
          position: [centroid.x / count, centroid.y / count],
          text: label,
        });
      }
    }

    return labels;
  }, [spatialIndex, normalizedClusters, clusterLabelMap]);

  const activeView = samplingViewState ?? viewState;
  const currentViewBounds = useMemo(
    () =>
      computeOrthoViewBounds(
        activeView,
        dimensions.width,
        dimensions.height
      ),
    [activeView, dimensions.width, dimensions.height]
  );

  const renderState = useMemo(() => {
    if (!spatialIndex || !currentViewBounds) {
      return {
        mode: 'idle',
        totalVisible: 0,
        sampleVisible: 0,
        density: null,
        points: null,
        level: null,
      };
    }

    const sampleInfo = gatherSamplesForViewport(spatialIndex, currentViewBounds, {
      maxSamples: UMAP_MAX_SAMPLE_POINTS,
      merge: true,
    });

    if (!sampleInfo || sampleInfo.sampleCount === 0) {
      return {
        mode: 'idle',
        totalVisible: 0,
        sampleVisible: 0,
        density: null,
        points: null,
        level: sampleInfo ? sampleInfo.level : null,
      };
    }

    const totalVisible = sampleInfo.totalCount;
    if (totalVisible > UMAP_DENSITY_THRESHOLD) {
      const density = gatherDensitySample(spatialIndex, currentViewBounds, {
        level: Math.max(sampleInfo.level - 1, 0),
      });
      return {
        mode: 'density',
        density,
        totalVisible,
        sampleVisible: density?.data?.length || 0,
        points: null,
        level: sampleInfo.level,
      };
    }

    const xs = spatialIndex.xs;
    const ys = spatialIndex.ys;
    const indices = sampleInfo.indices || new Uint32Array(0);
    const sampleVisible = indices.length;
    const positions = new Float32Array(sampleVisible * 2);
    const colors = new Uint8Array(sampleVisible * 4);

    for (let i = 0; i < sampleVisible; i += 1) {
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
        colors[i * 4] = UMAP_BASE_COLOR[0];
        colors[i * 4 + 1] = UMAP_BASE_COLOR[1];
        colors[i * 4 + 2] = UMAP_BASE_COLOR[2];
        colors[i * 4 + 3] = UMAP_BASE_COLOR[3];
      }
    }

    return {
      mode: 'points',
      density: null,
      totalVisible,
      sampleVisible,
      points: {
        positions,
        colors,
        indices,
        length: sampleVisible,
      },
      level: sampleInfo.level,
    };
  }, [spatialIndex, currentViewBounds, colorBuffer]);

  const downloadCanvasImage = useCallback((name = 'umap') => {
    try {
      const container = containerRef.current;
      if (!container) return;
      const canvas = container.querySelector('canvas');
      if (!canvas) {
        return;
      }
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
    downloadCanvasImage('umap');
  }, [downloadCanvasImage]);

  const orthographicView = useMemo(
    () =>
      new OrthographicView({
        id: 'umap-ortho',
        flipY: true,
      }),
    []
  );

  const currentZoom = viewState?.zoom ?? 0;
  const zoomReference = baseZoom ?? currentZoom;
  const zoomDelta = currentZoom - zoomReference;
  const zoomScale = Math.min(
    Math.max(Math.pow(UMAP_ZOOM_SCALE_PER_LEVEL, zoomDelta), UMAP_MIN_ZOOM_SCALE),
    UMAP_MAX_ZOOM_SCALE
  );

  const layers = useMemo(() => {
    if (!spatialIndex || !currentViewBounds) {
      return [];
    }

    const layerList = [];

    if (renderState.mode === 'density' && renderState.density) {
      layerList.push(
        new ScreenGridLayer({
          id: 'umap-density',
          data: renderState.density.data,
          getPosition: (d) => [spatialIndex.xs[d.index], spatialIndex.ys[d.index]],
          getWeight: (d) => d.weight,
          cellSizePixels: 30,
          colorRange: UMAP_DENSITY_COLOR_RANGE,
          opacity: 0.9,
          pickable: false,
          aggregation: 'SUM',
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        })
      );
    }

    if (renderState.mode === 'points' && renderState.points) {
      const { positions, colors, indices } = renderState.points;
      layerList.push(
        new ScatterplotLayer({
          id: `umap-points-${renderState.level}`,
          data: indices,
          getPosition: (_, { index }) => [
            positions[index * 2],
            positions[index * 2 + 1],
          ],
          getFillColor: (_, { index }) => [
            colors[index * 4],
            colors[index * 4 + 1],
            colors[index * 4 + 2],
            colors[index * 4 + 3],
          ],
          getRadius: () => radiusPixels,
          radiusUnits: 'pixels',
          radiusScale: zoomScale,
          radiusMinPixels: radiusPixels * UMAP_MIN_ZOOM_SCALE,
          radiusMaxPixels: radiusPixels * UMAP_MAX_ZOOM_SCALE,
          opacity: 0.9,
          stroked: false,
          pickable: true,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        })
      );
    }

    const clusterLabelSize = (() => {
      const f = Math.exp(-Math.pow(Math.log(Math.max(zoomScale, 0.1)), 2) / 2);
      return Math.round(14 + 8 * (1 - f));
    })();
    if (clusterLabels.length > 0) {
      layerList.push(
        new TextLayer({
          id: 'umap-cluster-labels',
          data: clusterLabels,
          getPosition: (d) => d.position,
          getText: (d) => d.text,
          getSize: clusterLabelSize,
          getColor: [0, 0, 0, 255],
          getAngle: 0,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          fontFamily: 'Arial, sans-serif',
          fontWeight: 'bold',
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          billboard: true,
        })
      );
    }

    return layerList;
  }, [
    spatialIndex,
    currentViewBounds,
    renderState,
    radiusPixels,
    zoomScale,
    clusterLabels,
  ]);

  const ready =
    viewState &&
    Number.isFinite(viewState.zoom) &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    layers.length > 0;

  const legendEntries = colorState.legendEntries;
  const [colorMenu, setColorMenu] = useState({ open: false, x: 0, y: 0, clusterId: null, value: '#000000' });
  const [legendVisible, setLegendVisible] = useState(true);

  return (
  <div className="deck-scatter-container" ref={containerRef} onContextMenu={handleContextMenu}>
      {!ready && (
        <div className="plot-placeholder">
          <Spinner size={24} />
          <p>Preparing UMAP view…</p>
        </div>
      )}
      {ready && (
        <>
          <DeckGL
            width={dimensions.width}
            height={dimensions.height}
            controller={{
              type: OrthographicController,
              dragPan: true,
              dragRotate: false,
              scrollZoom: { speedMultiplier: 0.9 },
              doubleClickZoom: false,
              touchZoom: true,
              keyboard: false,
              inertia: false,
              dragMode: 'pan',
              minZoom:
                viewState?.minZoom ??
                (baseZoom ?? currentZoom) - UMAP_INITIAL_MIN_ZOOM_PAD,
              maxZoom:
                viewState?.maxZoom ??
                (baseZoom ?? currentZoom) + UMAP_INITIAL_MAX_ZOOM_PAD,
            }}
            views={orthographicView}
            viewState={viewState}
            onViewStateChange={handleViewStateChange}
            onHover={(info) => {
              setIsHovering(info.layer && selectedClusters.size > 0);
            }}
            layers={layers}
            glOptions={{
              webgl2: true,
              powerPreference: 'high-performance',
              antialias: false,
              preserveDrawingBuffer: true,
            }}
            parameters={{
              depthTest: false,
              clearColor: [1, 1, 1, 1],
            }}
          />
          <div className="zoom-controls">
            <button
              className="zoom-button zoom-in"
              onClick={handleZoomIn}
              title="Zoom In"
            >
              +
            </button>
            <button
              className="zoom-button zoom-out"
              onClick={handleZoomOut}
              title="Zoom Out"
            >
              −
            </button>
            {((legendEntries && legendEntries.length > 0) || colorState.isGeneExpression) && (
              <button
                className="zoom-button legend-toggle"
                onClick={() => setLegendVisible(!legendVisible)}
                title={legendVisible ? "Hide Legend" : "Show Legend"}
              >
                <Icon icon={legendVisible ? "eye-off" : "eye-open"} size={16} />
              </button>
            )}
          </div>
          {legendVisible && colorState.isGeneExpression && (
              <div className="spatial-overlay umap-overlay" style={{ width: 'auto' }}>
                <div className="spatial-overlay-section" style={{ padding: '8px 12px' }}>
                  <span className="spatial-overlay-label">{colorState.geneName || 'Unknown'}</span>
                  <div className="gene-expression-legend" style={{ marginTop: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{
                        width: '18px',
                        height: '100px',
                        background: colorState.legendGradient || 'linear-gradient(to top, lightgray, orange, red)'
                      }}></div>
                      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '100px', fontSize: '10px' }}>
                        <span>{colorState.maxExp.toFixed(2)}</span>
                        <span>{((colorState.maxExp + colorState.minExp) / 2).toFixed(2)}</span>
                        <span>{colorState.minExp.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
          )}
          {legendVisible && legendEntries && legendEntries.length > 0 && (
            <div 
              className="spatial-overlay umap-overlay"
              onClick={(e) => {
                if (e.target.classList.contains('spatial-overlay') || 
                    e.target.classList.contains('spatial-overlay-section') ||
                    e.target.classList.contains('umap-legend-columns') ||
                    e.target.classList.contains('umap-legend-column')) {
                  if (onClearLegendHighlight) {
                    onClearLegendHighlight();
                  }
                  if (onSelectClusters) {
                    onSelectClusters(new Set());
                  }
                  setColorMenu({ open: false, x: 0, y: 0, clusterId: null, value: '#000000' });
                }
              }}
              onContextMenu={(e) => {
                if (e.target.classList.contains('spatial-overlay') || 
                    e.target.classList.contains('spatial-overlay-section') ||
                    e.target.classList.contains('umap-legend-columns') ||
                    e.target.classList.contains('umap-legend-column')) {
                  setColorMenu({ open: false, x: 0, y: 0, clusterId: null, value: '#000000' });
                }
              }}
            >
              <div className="spatial-overlay-section">
                <span className="spatial-overlay-label">Clusters</span>
                {(() => {
                  const ordered = legendEntries.slice();
                  const firstColumnCount = Math.ceil(ordered.length / 2);
                  const firstCol = ordered.slice(0, firstColumnCount);
                  const secondCol = ordered.slice(firstColumnCount);
                  
                  const handleLegendClick = (entry, event) => {
                    event.stopPropagation();
                    const clusterId = entry.id;
                    const ctrlKey = event.ctrlKey || event.metaKey;

                    if (onLegendClusterClick && viewModality) {
                      onLegendClusterClick(viewModality, clusterId, entry.color, ctrlKey);
                      return;
                    }

                    if (onSelectClusters) {
                      const newSelection = new Set(selectedClusters);
                      if (ctrlKey) {
                        if (newSelection.has(clusterId)) {
                          newSelection.delete(clusterId);
                        } else {
                          newSelection.add(clusterId);
                        }
                      } else {
                        if (newSelection.size === 1 && newSelection.has(clusterId)) {
                          newSelection.clear();
                        } else {
                          newSelection.clear();
                          newSelection.add(clusterId);
                        }
                      }
                      onSelectClusters(newSelection);
                    }
                  };

                  const handleLegendContextMenu = (entry, event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const key = String(entry.id ?? entry.label);
                    const override = clusterColorOverrides?.[key];
                    let current = override;
                    if (!current && Array.isArray(entry.color)) {
                      const [r, g, b] = entry.color;
                      const toHex = (v) => `00${Number(v).toString(16)}`.slice(-2);
                      current = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
                    }
                    if (!current) {
                      current = '#000000';
                    }
                    setColorMenu({ open: true, x: event.clientX, y: event.clientY, clusterId: key, value: current });
                  };
                  
                  return (
                    <div className="umap-legend-columns">
                      <div className="umap-legend-column">
                        {firstCol.map((entry) => {
                          const isLegendHighlightSelected = legendHighlightSelection && viewModality === legendHighlightSelection.modality && legendHighlightSelection.clusterIds.has(entry.id);
                          const isSelected = isLegendHighlightSelected || (!legendHighlightSelection && selectedClusters.has(entry.id));
                          return (
                          <div
                            className={`spatial-legend-item${isSelected ? ' legend-item-selected' : ''}`}
                            key={`umap-legend-${entry.id}`}
                            onClick={(e) => handleLegendClick(entry, e)}
                            style={{ cursor: (onLegendClusterClick || onSelectClusters) ? 'pointer' : 'default' }}
                          >
                            <span
                              className="spatial-legend-swatch"
                              style={{ background: colorArrayToCss(entry.color) }}
                              onContextMenu={(e) => handleLegendContextMenu(entry, e)}
                            />
                            <span className="spatial-legend-text umap-legend-text">
                              {entry.label}
                            </span>
                          </div>
                        ); })}
                      </div>
                      <div className="umap-legend-column">
                        {secondCol.map((entry) => {
                          const isLegendHighlightSelected = legendHighlightSelection && viewModality === legendHighlightSelection.modality && legendHighlightSelection.clusterIds.has(entry.id);
                          const isSelected = isLegendHighlightSelected || (!legendHighlightSelection && selectedClusters.has(entry.id));
                          return (
                          <div
                            className={`spatial-legend-item${isSelected ? ' legend-item-selected' : ''}`}
                            key={`umap-legend-${entry.id}`}
                            onClick={(e) => handleLegendClick(entry, e)}
                            style={{ cursor: (onLegendClusterClick || onSelectClusters) ? 'pointer' : 'default' }}
                          >
                            <span
                              className="spatial-legend-swatch"
                              style={{ background: colorArrayToCss(entry.color) }}
                              onContextMenu={(e) => handleLegendContextMenu(entry, e)}
                            />
                            <span className="spatial-legend-text umap-legend-text">
                              {entry.label}
                            </span>
                          </div>
                        ); })}
                      </div>
                    </div>
                  );
                })()}
              </div>
              {colorMenu.open && (
                <div
                  className="legend-color-menu"
                  style={{ position: 'fixed', top: colorMenu.y, left: colorMenu.x }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="legend-color-menu-row">
                    <label>Cluster {colorMenu.clusterId}</label>
                  </div>
                  <div className="legend-color-menu-row">
                    <input
                      type="color"
                      value={colorMenu.value}
                      onChange={(e) => {
                        const next = e.target.value;
                        setColorMenu((prev) => ({ ...prev, value: next }));
                        if (onChangeClusterColor && colorMenu.clusterId) {
                          onChangeClusterColor(colorMenu.clusterId, next);
                        }
                      }}
                    />
                    <button
                      className="legend-color-menu-reset"
                      onClick={() => {
                        if (onChangeClusterColor && colorMenu.clusterId) {
                          onChangeClusterColor(colorMenu.clusterId, null);
                        }
                        setColorMenu({ open: false, x: 0, y: 0, clusterId: null, value: '#000000' });
                      }}
                    >
                      Reset
                    </button>
                  </div>
                  <div className="legend-color-menu-row">
                    <button
                      className="legend-color-menu-close"
                      onClick={() => setColorMenu({ open: false, x: 0, y: 0, clusterId: null, value: '#000000' })}
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default UmapDeckView;
