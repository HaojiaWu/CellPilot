import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Icon } from '@blueprintjs/core';
import * as d3 from 'd3';
import UmapDeckView from './UmapDeckView';
import CoveragePlot from './CoveragePlot';
import PeakGeneLinkPlot from './PeakGeneLinkPlot';
import TfMotifPlot from './TfMotifPlot';
import { formatGeneNameForDisplay } from '../utils/geneNameFormat';
import './PlotView.css';

const interpolateMap = {
  viridis: d3.interpolateViridis,
  magma: d3.interpolateMagma,
  inferno: d3.interpolateInferno,
  plasma: d3.interpolatePlasma,
  cividis: d3.interpolateCividis,
  turbo: d3.interpolateTurbo,
  cubehelix: d3.interpolateCubehelixDefault,
};

const baseClusterPalette = [
  ...d3.schemeCategory10,
  ...(d3.schemeSet3 || []),
  ...(d3.schemePaired || []),
  ...(d3.schemeDark2 || []),
  ...(d3.schemePastel1 || []),
  ...(d3.schemePastel2 || []),
];

const sortClusterIds = (ids) => {
  return ids.slice().sort((a, b) => {
    const numA = Number(a);
    const numB = Number(b);
    const validA = !Number.isNaN(numA);
    const validB = !Number.isNaN(numB);
    if (validA && validB) {
      return numA - numB;
    }
    return String(a).localeCompare(String(b));
  });
};

const ensurePaletteLength = (targetSize) => {
  if (targetSize <= baseClusterPalette.length) {
    return baseClusterPalette.slice(0, targetSize);
  }
  const palette = baseClusterPalette.slice();
  const needed = targetSize - palette.length;
  const extras = d3.quantize(d3.interpolateTurbo, needed + 2).slice(1, needed + 1);
  return palette.concat(extras);
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

const createClusterColorScale = (clusterIds) => {
  if (!Array.isArray(clusterIds) || clusterIds.length === 0) {
    return null;
  }
  const sortedIds = sortClusterIds(clusterIds);
  const domain = sortedIds.map((id) => String(id));
  const palette = ensurePaletteLength(domain.length);
  return d3.scaleOrdinal(palette).domain(domain);
};

const withOpacity = (color, opacity) => {
  const c = d3.color(color);
  if (!c) {
    return color;
  }
  const cloned = c.copy();
  cloned.opacity = opacity;
  return cloned.toString();
};

const darkenColor = (color, amount = 1) => {
  const c = d3.color(color);
  if (!c) {
    return color;
  }
  return c.darker(amount).formatHex();
};

const PlotView = ({ activePlot, geneExpression = null, artifacts, dataInfo, selectedClusters, onSelectClusters, clusterColorOverrides = {}, clusterLabelMap = {}, onChangeClusterColor = null, rnaClustersForAtacHighlight = null, rnaClusterHighlightOnAtac = null, atacClustersForRnaHighlight = null, atacClusterHighlightOnRna = null, legendHighlightSelection = null, onLegendClusterClick = null, onClearLegendHighlight = null, viewModality = null, otherModalityClusters = null, cellBarcodes = null, otherModalityCellBarcodes = null, highlightCellMask = null }) => {
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const volcanoRef = useRef(null);
  const cellFractionLeftRef = useRef(null);
  const cellFractionRightRef = useRef(null);
  const regionCompositionRef = useRef(null);

  const downloadSvgAsHighResPng = useCallback((svgElement, filename = 'cellpilot-figure', scale = 4) => {
    if (!svgElement) return;

    try {
      const clone = svgElement.cloneNode(true);
      const sourceWidth = Number(svgElement.getAttribute('width')) || svgElement.getBoundingClientRect().width || 900;
      const sourceHeight = Number(svgElement.getAttribute('height')) || svgElement.getBoundingClientRect().height || 600;
      clone.setAttribute('width', String(sourceWidth));
      clone.setAttribute('height', String(sourceHeight));
      clone.setAttribute('viewBox', clone.getAttribute('viewBox') || '0 0 ' + sourceWidth + ' ' + sourceHeight);

      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = `
        .spatial-cci-dotplot { background: #fff; font-family: Arial, Helvetica, sans-serif; }
        .spatial-cci-grid-frame { fill: #fff; stroke: #d1d5db; stroke-width: 1; }
        .spatial-cci-grid-line { stroke: #d1d5db; stroke-width: 1; }
        .spatial-cci-axis-label, .spatial-cci-pair-label, .spatial-cci-legend-label { fill: #111827; font-size: 14px; }
        .spatial-cci-pair-label { font-size: 13px; }
        .spatial-cci-legend-title { fill: #111827; font-size: 13px; font-weight: 700; }
      `;
      clone.insertBefore(style, clone.firstChild);

      const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      background.setAttribute('x', '0');
      background.setAttribute('y', '0');
      background.setAttribute('width', String(sourceWidth));
      background.setAttribute('height', String(sourceHeight));
      background.setAttribute('fill', '#ffffff');
      clone.insertBefore(background, style.nextSibling);

      const svgText = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(sourceWidth * scale);
          canvas.height = Math.round(sourceHeight * scale);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((pngBlob) => {
            URL.revokeObjectURL(url);
            if (!pngBlob) return;
            const pngUrl = URL.createObjectURL(pngBlob);
            const a = document.createElement('a');
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            a.href = pngUrl;
            a.download = filename + '-' + Math.round(sourceWidth * scale) + 'px-' + ts + '.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(pngUrl);
          }, 'image/png');
        } catch (error) {
          URL.revokeObjectURL(url);
          console.error('Failed to export high-resolution PNG:', error);
          alert('Unable to export this figure as a high-resolution PNG.');
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        alert('Unable to render this SVG for PNG export.');
      };
      img.src = url;
    } catch (error) {
      console.error('Failed to export SVG as PNG:', error);
      alert('Unable to export this figure as a high-resolution PNG.');
    }
  }, []);
  const resolvedResults = useMemo(() => {
    if (!activePlot) {
      return null;
    }
    if (activePlot.source === 'analysis') {
      return activePlot.data || null;
    }
    if (activePlot.source === 'artifact') {
      const artifact = artifacts.find((a) => a.id === activePlot.artifactId) || null;
      if (!artifact) return null;
      const viewName = activePlot.viewName;
      if (artifact.integrationViews && artifact.viewData && (artifact.type === 'gene_violin' || artifact.type === 'gene_dotplot')) {
        if (viewName) {
          const viewData = artifact.viewData[viewName];
          if (!viewData) return null;
          if (artifact.type === 'gene_violin') {
            return {
              type: 'gene_violin',
              geneName: artifact.geneName,
              clusterIds: viewData.clusterIds,
              expressionByCluster: viewData.expressionByCluster,
              summary: viewData.summary,
              totalCells: viewData.expressionByCluster?.reduce((sum, arr) => sum + (arr?.length || 0), 0) ?? 0,
              globalExpressionRange: artifact.globalExpressionRange,
            };
          }
          if (artifact.type === 'gene_dotplot') {
            return {
              type: 'gene_dotplot',
              geneNames: artifact.geneNames,
              clusterIds: viewData.clusterIds,
              percentExpressing: viewData.percentExpressing,
              averageExpression: viewData.averageExpression,
              clusterCellCounts: viewData.clusterCellCounts,
              totalCells: viewData.totalCells ?? 0,
              expressionRange: artifact.expressionRange,
              colorMap: artifact.colorMap,
            };
          }
        }

        const allViewData = Object.values(artifact.viewData);
        if (artifact.type === 'gene_violin') {
          const allClusterIds = Array.from(
            new Set(allViewData.flatMap((vd) => vd.clusterIds))
          ).sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
          const mergedExprByCluster = allClusterIds.map((cid) => {
            const parts = allViewData
              .map((vd) => {
                const idx = vd.clusterIds.indexOf(cid);
                return idx >= 0 ? vd.expressionByCluster[idx] : null;
              })
              .filter(Boolean);
            if (parts.length === 0) return new Float32Array(0);
            const totalLen = parts.reduce((s, a) => s + a.length, 0);
            const merged = new Float32Array(totalLen);
            let offset = 0;
            for (const part of parts) { merged.set(part, offset); offset += part.length; }
            return merged;
          });
          const { summarizeDistribution } = (() => {
            const sd = (vals) => {
              const finite = Array.from(vals).filter(Number.isFinite);
              if (!finite.length) return { min: 0, max: 0, mean: 0, median: 0, q1: 0, q3: 0, count: 0 };
              finite.sort((a, b) => a - b);
              const n = finite.length;
              const mean = finite.reduce((s, v) => s + v, 0) / n;
              const median = n % 2 === 0 ? (finite[n / 2 - 1] + finite[n / 2]) / 2 : finite[Math.floor(n / 2)];
              const q1 = finite[Math.floor(n * 0.25)];
              const q3 = finite[Math.floor(n * 0.75)];
              return { min: finite[0], max: finite[n - 1], mean, median, q1, q3, count: n };
            };
            return { summarizeDistribution: sd };
          })();
          const mergedSummary = mergedExprByCluster.map(summarizeDistribution);
          return {
            type: 'gene_violin',
            geneName: artifact.geneName,
            clusterIds: allClusterIds,
            expressionByCluster: mergedExprByCluster,
            summary: mergedSummary,
            totalCells: mergedExprByCluster.reduce((s, a) => s + a.length, 0),
            globalExpressionRange: artifact.globalExpressionRange,
          };
        }
        if (artifact.type === 'gene_dotplot') {
          const nGenes = artifact.geneNames?.length ?? 0;
          const allClusterIds = Array.from(
            new Set(allViewData.flatMap((vd) => vd.clusterIds))
          ).sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
          const mergedCellCounts = new Array(allClusterIds.length).fill(0);
          const mergedPercentExpressing = Array.from({ length: allClusterIds.length }, () => new Float32Array(nGenes));
          const mergedAverageExpression = Array.from({ length: allClusterIds.length }, () => new Float32Array(nGenes));
          const detectedSums = Array.from({ length: allClusterIds.length }, () => new Float32Array(nGenes));
          const expressionSums = Array.from({ length: allClusterIds.length }, () => new Float32Array(nGenes));
          for (const vd of allViewData) {
            for (let vi = 0; vi < vd.clusterIds.length; vi++) {
              const cid = vd.clusterIds[vi];
              const ci = allClusterIds.indexOf(cid);
              if (ci < 0) continue;
              const n = vd.clusterCellCounts[vi];
              mergedCellCounts[ci] += n;
              for (let gi = 0; gi < nGenes; gi++) {
                const pct = vd.percentExpressing[vi][gi];
                const avg = vd.averageExpression[vi][gi];
                const detected = pct * n;
                detectedSums[ci][gi] += detected;
                expressionSums[ci][gi] += avg * detected;
              }
            }
          }
          for (let ci = 0; ci < allClusterIds.length; ci++) {
            const n = mergedCellCounts[ci];
            for (let gi = 0; gi < nGenes; gi++) {
              const detected = detectedSums[ci][gi];
              mergedPercentExpressing[ci][gi] = n > 0 ? detected / n : 0;
              mergedAverageExpression[ci][gi] = detected > 0 ? expressionSums[ci][gi] / detected : 0;
            }
          }
          return {
            type: 'gene_dotplot',
            geneNames: artifact.geneNames,
            clusterIds: allClusterIds,
            percentExpressing: mergedPercentExpressing,
            averageExpression: mergedAverageExpression,
            clusterCellCounts: mergedCellCounts,
            totalCells: mergedCellCounts.reduce((s, n) => s + n, 0),
            expressionRange: artifact.expressionRange,
            colorMap: artifact.colorMap,
          };
        }
      }
      return artifact;
    }
    return null;
  }, [activePlot, artifacts]);

  const resolvedGeneExpression = useMemo(() => {
    if (!geneExpression) {
      console.log('PlotView resolvedGeneExpression: No geneExpression prop');
      return null;
    }
    console.log('PlotView resolvedGeneExpression: Received geneExpression', { geneExpression, source: geneExpression.source });
    if (geneExpression.source === 'analysis') {
      const result = geneExpression.data || null;
      console.log('PlotView resolvedGeneExpression: Analysis source', { hasData: !!result, type: result?.type });
      return result;
    }
    if (geneExpression.source === 'artifact') {
      const result = artifacts.find((artifact) => artifact.id === geneExpression.artifactId) || null;
      console.log('PlotView resolvedGeneExpression: Artifact source', {
        artifactId: geneExpression.artifactId,
        found: !!result,
        type: result?.type,
        hasCoordinates: !!result?.coordinates,
        hasExpression: !!result?.expression,
        coordinatesLength: result?.coordinates?.length,
        expressionLength: result?.expression?.length
      });
      return result;
    }
    console.log('PlotView resolvedGeneExpression: Unknown source, returning null');
    return null;
  }, [geneExpression, artifacts]);

  useEffect(() => {
    if (
      !resolvedResults ||
      resolvedResults.type === 'markers' ||
      resolvedResults.type === 'umap'
    ) {
      if (svgRef.current) {
        d3.select(svgRef.current).selectAll('*').remove();
      }
      return;
    }

    if (svgRef.current) {
      renderPlot(resolvedResults);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedResults, clusterLabelMap]);

  useEffect(() => {
    if (
      !resolvedResults ||
      resolvedResults.type === 'markers' ||
      resolvedResults.type === 'umap'
    ) {
      return;
    }

    const handleResize = () => {
      if (svgRef.current) {
        renderPlot(resolvedResults);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedResults]);

  useEffect(() => {
    if (
      !containerRef.current ||
      !resolvedResults ||
      resolvedResults.type === 'markers' ||
      resolvedResults.type === 'umap'
    ) {
      return;
    }

    let animationFrame = null;
    const observer = new ResizeObserver(() => {
      if (
        !resolvedResults ||
        resolvedResults.type === 'markers' ||
        resolvedResults.type === 'umap'
      ) {
        return;
      }

      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
      }

      animationFrame = requestAnimationFrame(() => {
        if (svgRef.current) {
          renderPlot(resolvedResults);
        }
      });
    });

    observer.observe(containerRef.current);

    return () => {
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
      }
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedResults]);

  const renderPlot = (results) => {
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    if (!results) {
      return;
    }

    if (results.type === 'markers') {
      return;
    }

    if (results.type === 'umap') {
      return;
    }

    const container = containerRef.current;
    const containerWidth = container?.clientWidth || 800;
    const containerHeight = container?.clientHeight || 600;

    const margin = { top: 40, right: 160, bottom: 120, left: 60 };
    if (results.type === 'gene_expression') {
      margin.bottom = 48;
    }
    const width = Math.max(200, containerWidth - margin.left - margin.right);
    const height = Math.max(200, containerHeight - margin.top - margin.bottom);

    const g = svg
      .attr('width', width + margin.left + margin.right)
      .attr('height', height + margin.top + margin.bottom)
      .append('g')
      .attr('transform', `translate(${margin.left}, ${margin.top})`);

    if (results.type === 'gene_expression' && results.expression) {
      renderGeneExpression(g, results, width, height, margin);
    } else if (results.type === 'gene_violin' && results.expressionByCluster) {
      renderGeneViolin(g, results, width, height, margin);
    } else if (results.type === 'gene_dotplot') {
      if (results.percentExpressing && results.averageExpression) {
        renderGeneDotplot(g, results, width, height, margin);
      } else {
        console.warn('Dot plot missing required data arrays');
      }
    } else if (results.type === 'qc' && results.metrics) {
      renderQCPlots(g, results, width - 80, height - 40);
    } else {
      console.warn('Unknown result type or missing data:', results);
    }
  };

  const createColorFunction = (colorDef, minExp, maxExp) => {
    const clamp01 = (value) => Math.max(0, Math.min(1, value));
    const safeRange = maxExp - minExp || 1;

    if (!colorDef || colorDef.type === 'scheme') {
      const name = (colorDef?.name || 'viridis').toLowerCase();
      const interpolator = interpolateMap[name] || d3.interpolateViridis;
      return (value) => interpolator(clamp01((value - minExp) / safeRange));
    }

    if (colorDef.type === 'custom' && Array.isArray(colorDef.colors) && colorDef.colors.length >= 2) {
      const colors = colorDef.colors;
      const steps = colors.length - 1;
      const domain = colors.map((_, idx) => minExp + (safeRange * idx) / steps);
      const scale = d3.scaleLinear().domain(domain).range(colors);
      return (value) => scale(value);
    }

    return (value) => d3.interpolateViridis(clamp01((value - minExp) / safeRange));
  };

  const renderGeneExpression = (g, results, width, height, margin) => {
    const { coordinates: rawCoords, expression: rawExpression, geneName } = results;

    if (!rawExpression || !rawCoords || rawExpression.length !== rawCoords.length) {
      console.warn('Expression length mismatch:', rawExpression?.length, rawCoords?.length);
      return;
    }

    const validData = [];
    for (let i = 0; i < rawCoords.length; i++) {
      const coord = rawCoords[i];
      if (coord && Array.isArray(coord) && coord.length >= 2 &&
          isFinite(coord[0]) && isFinite(coord[1])) {
        validData.push({ coord, expr: rawExpression[i] });
      }
    }

    if (validData.length === 0) {
      console.warn('No valid coordinates for gene expression plot');
      g.append('text')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .text('No valid coordinates available');
      return;
    }

    validData.sort((a, b) => a.expr - b.expr);

    const coordinates = validData.map(d => d.coord);
    const expression = validData.map(d => d.expr);

    console.log(`Gene expression plot: ${validData.length}/${rawCoords.length} cells have valid coordinates`);

    const xExtent = d3.extent(coordinates, d => d[0]);
    const yExtent = d3.extent(coordinates, d => d[1]);

    const dataWidth = xExtent[1] - xExtent[0];
    const dataHeight = yExtent[1] - yExtent[0];
    const dataAspect = dataWidth / dataHeight;
    const plotAspect = width / height;

    let plotWidth = width;
    let plotHeight = height;
    let offsetX = 0;
    let offsetY = 0;

    if (dataAspect > plotAspect) {
      plotHeight = width / dataAspect;
      offsetY = (height - plotHeight) / 2;
    } else {
      plotWidth = height * dataAspect;
      offsetX = (width - plotWidth) / 2;
    }

    const xScale = d3.scaleLinear()
      .domain(xExtent)
      .range([offsetX, offsetX + plotWidth]);

    const yScale = d3.scaleLinear()
      .domain(yExtent)
      .range([offsetY, offsetY + plotHeight]);

    const expressionExtent = d3.extent(expression);
    let [minExp, maxExp] = expressionExtent;
    if (results.expressionRange && Array.isArray(results.expressionRange) && results.expressionRange.length >= 2 &&
        Number.isFinite(results.expressionRange[0]) && Number.isFinite(results.expressionRange[1])) {
      minExp = results.expressionRange[0];
      maxExp = results.expressionRange[1];
    }
    if (!isFinite(minExp) || !isFinite(maxExp)) {
      console.warn('Invalid expression values:', expressionExtent);
      return;
    }
    if (minExp === maxExp) {
      maxExp = minExp + 1e-6;
    }
    const colorDef = results.colorMap || { type: 'custom', colors: ['lightgray', 'orange', 'red'] };
    const colorFn = createColorFunction(colorDef, minExp, maxExp);

    g.selectAll('circle')
      .data(coordinates)
      .enter()
      .append('circle')
      .attr('cx', d => xScale(d[0]))
      .attr('cy', d => yScale(d[1]))
      .attr('r', 1.2)
      .attr('fill', (d, i) => colorFn(expression[i]))
      .attr('opacity', 0.8)
      .attr('stroke', 'none');

    g.append('text')
      .attr('x', width / 2)
      .attr('y', -10)
      .attr('text-anchor', 'middle')
      .style('font-size', '16px')
      .style('font-weight', 'bold')
      .text(`Gene Expression: ${geneName || 'Unknown'}`);

    const legendWidth = 20;
    const legendHeight = height / 2;
    const legend = g.append('g')
      .attr('transform', `translate(${width + 30}, ${height / 4})`);

    const legendScale = d3.scaleLinear()
      .domain([minExp, maxExp])
      .range([legendHeight, 0]);

    const legendAxis = d3.axisRight(legendScale)
      .ticks(5);

    const defs = g.append('defs');
    const gradientId = `expression-gradient-${(geneName || 'gene').replace(/[^a-zA-Z0-9]/g, '-')}`;
    const gradient = defs.append('linearGradient')
      .attr('id', gradientId)
      .attr('x1', '0%')
      .attr('y1', '100%')
      .attr('x2', '0%')
      .attr('y2', '0%');

    const gradientSamples = Array.from({ length: 20 }, (_, idx) => idx / 19);

    gradient.selectAll('stop')
      .data(gradientSamples)
      .enter()
      .append('stop')
      .attr('offset', d => `${d * 100}%`)
      .attr('stop-color', d => colorFn(minExp + d * (maxExp - minExp)));

    legend.append('rect')
      .attr('width', legendWidth)
      .attr('height', legendHeight)
      .style('fill', `url(#${gradientId})`);

    legend.append('g')
      .attr('transform', `translate(${legendWidth}, 0)`)
      .call(legendAxis);
  };

  const renderGeneViolin = (g, results, width, height, margin) => {
    const { clusterIds, expressionByCluster, summary, geneName } = results;

    if (!Array.isArray(clusterIds) || !Array.isArray(expressionByCluster)) {
      console.warn('Invalid violin plot payload:', results);
      return;
    }

    const rawViolinEntries = clusterIds.map((clusterId, idx) => {
      const rawValues = expressionByCluster[idx];
      let values = [];
      if (Array.isArray(rawValues)) {
        values = rawValues.slice();
      } else if (rawValues && typeof rawValues === 'object' && typeof rawValues.length === 'number') {
        values = Array.from(rawValues);
      }

      const finiteValues = values.filter((value) => Number.isFinite(value));
      const nonZeroValues = finiteValues.filter((value) => value !== 0);

      return {
        clusterId,
        values: finiteValues,
        totalCount: finiteValues.length,
        nonZeroCount: nonZeroValues.length,
        summary: summary?.[idx] || null,
      };
    });

    const labelToEntries = new Map();
    for (const entry of rawViolinEntries) {
      const displayLabel = formatClusterLabel(entry.clusterId, clusterLabelMap) || String(entry.clusterId);
      if (!labelToEntries.has(displayLabel)) {
        labelToEntries.set(displayLabel, { clusterId: displayLabel, values: [], totalCount: 0, nonZeroCount: 0, summary: null });
      }
      const merged = labelToEntries.get(displayLabel);
      merged.values = merged.values.concat(entry.values);
      merged.totalCount += entry.totalCount;
      merged.nonZeroCount += entry.nonZeroCount;
    }
    const violinEntries = Array.from(labelToEntries.values());

    if (!violinEntries.length) {
      console.warn('No violin data to render.');
      return;
    }

    const baseAllValues = violinEntries.flatMap((entry) => entry.values);
    const baseExtent = d3.extent(baseAllValues);
    const baseRange = (Number.isFinite(baseExtent[0]) && Number.isFinite(baseExtent[1])) ? (baseExtent[1] - baseExtent[0]) : 0;
    const noiseScale = Math.max(1e-6, (baseRange || 1) * 1e-4);

    violinEntries.forEach((entry) => {
      entry.values = entry.values.map((v) => v + (Math.random() - 0.5) * noiseScale);
    });

    const allValues = violinEntries.flatMap((entry) => entry.values);
    let extent = d3.extent(allValues);
    if (results.globalExpressionRange && Array.isArray(results.globalExpressionRange) && results.globalExpressionRange.length >= 2) {
      const [gMin, gMax] = results.globalExpressionRange;
      if (Number.isFinite(gMin) && Number.isFinite(gMax)) {
        extent = [gMin, gMax];
      }
    }
    if (!extent || !Number.isFinite(extent[0]) || !Number.isFinite(extent[1])) {
      console.warn('Invalid expression extent for violin plot:', extent);
      return;
    }

    const padding = (extent[1] - extent[0]) * 0.05 || 0.25;
    const lowerBound = 0;
    const upperBound = Math.max(extent[1] + padding, lowerBound + 0.5);
    const yScale = d3.scaleLinear()
      .domain([lowerBound, upperBound])
      .range([height, 0])
      .nice();

    const clusterLabels = violinEntries.map((entry) => String(entry.clusterId));
    const clusterColorScale = createClusterColorScale(violinEntries.map((entry) => entry.clusterId));
    const xScale = d3.scaleBand()
      .domain(clusterLabels)
      .range([0, width])
      .paddingInner(0.3)
      .paddingOuter(0.2);

    const bandwidth = Math.max((extent[1] - extent[0]) / 30, 0.1);
    const samplePoints = yScale.ticks(60);

    const estimateDensity = (values) => {
      if (!values.length) {
        return samplePoints.map((value) => [value, 0]);
      }
      return samplePoints.map((value) => {
        let sum = 0;
        for (const val of values) {
          const u = (value - val) / bandwidth;
          if (Math.abs(u) <= 1) {
            sum += 0.75 * (1 - u * u);
          }
        }
        return [value, sum / (values.length * bandwidth)];
      });
    };

    const computeSummary = (values) => {
      if (!values.length) {
        return null;
      }
      const sorted = values.slice().sort((a, b) => a - b);
      const quantile = (q) => {
        const pos = (sorted.length - 1) * q;
        const base = Math.floor(pos);
        const rest = pos - base;
        if (sorted[base + 1] !== undefined) {
          return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
        }
        return sorted[base];
      };
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      return {
        size: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: sum / sorted.length,
        median: quantile(0.5),
        q1: quantile(0.25),
        q3: quantile(0.75),
      };
    };

    const violinData = violinEntries.map((entry) => ({
      clusterId: entry.clusterId,
      values: entry.values,
      summary: entry.summary || computeSummary(entry.values),
      density: estimateDensity(entry.values),
      totalCount: entry.totalCount,
      nonZeroCount: entry.nonZeroCount,
    }));

    const maxDensity = d3.max(violinData, (entry) =>
      d3.max(entry.density, (point) => point[1])
    ) || 0;

    const maxCount = d3.max(violinData, (entry) => entry.values.length) || 1;

    const baseBandwidth = xScale.bandwidth() / 2;
    const halfWidth = Math.max(14, baseBandwidth * 1.1);
    const widthScale = d3.scaleLinear()
      .domain([0, maxDensity || 1])
      .range([0, halfWidth * 1.35]);

    violinData.forEach((entry) => {
      const center = xScale(String(entry.clusterId)) + xScale.bandwidth() / 2;
      const widthMultiplier = Math.max(0.4, Math.sqrt(entry.values.length / maxCount));
      const nonZeroFraction = entry.nonZeroCount / Math.max(1, entry.totalCount);
      const shouldDrawViolin = nonZeroFraction >= 0.2;

      const baseColor = clusterColorScale
        ? clusterColorScale(String(entry.clusterId))
        : '#7e57c2';
      const violinFill = withOpacity(baseColor, 0.85);
      const violinStroke = darkenColor(baseColor, 1);

      g.append('line')
        .attr('x1', center)
        .attr('x2', center)
        .attr('y1', height)
        .attr('y2', 0)
        .attr('stroke', baseColor)
        .attr('stroke-width', shouldDrawViolin ? 1.5 : 0.8)
        .attr('stroke-opacity', shouldDrawViolin ? 0.45 : 0.25);

      if (shouldDrawViolin) {
        const violinArea = d3.area()
          .curve(d3.curveCatmullRom)
          .x0((d) => center - widthScale(d[1]) * widthMultiplier)
          .x1((d) => center + widthScale(d[1]) * widthMultiplier)
          .y((d) => yScale(d[0]));

        g.append('path')
          .datum(entry.density)
          .attr('d', violinArea)
          .attr('fill', violinFill)
          .attr('stroke', violinStroke)
          .attr('stroke-width', 1)
          .attr('opacity', 0.9);
      }

      const bisectY = d3.bisector((d) => d[0]).left;
      const densityAt = (y) => {
        const i = Math.min(Math.max(bisectY(entry.density, y) - 1, 0), entry.density.length - 2);
        const [y0, d0] = entry.density[i];
        const [y1, d1] = entry.density[i + 1];
        const t = (y - y0) / Math.max(1e-12, (y1 - y0));
        return d0 + t * (d1 - d0);
      };

      const maxPointsPerCluster = 3000;
      const pts = entry.values.length > maxPointsPerCluster
        ? d3.shuffle(entry.values.slice()).slice(0, maxPointsPerCluster)
        : entry.values;

      const pointRadius = pts.length > 2000 ? 0.9 : 1.2;

      const scatter = pts.map((v) => {
        const dens = densityAt(v);
        const baseWidth = shouldDrawViolin ? widthScale(dens) * widthMultiplier : halfWidth * 0.3;
        const w = Math.max(1, baseWidth * 0.95);
        const x = center + (Math.random() * 2 - 1) * w;
        return { x, y: yScale(v) };
      });

      g.append('g')
        .attr('fill', '#555555')
        .attr('fill-opacity', 0.5)
        .attr('stroke', 'none')
        .selectAll('circle')
        .data(scatter)
        .enter()
        .append('circle')
        .attr('cx', (d) => d.x)
        .attr('cy', (d) => d.y)
        .attr('r', pointRadius);

    });

    const xAxis = d3.axisBottom(xScale).tickFormat((d) => formatClusterLabel(d, clusterLabelMap));
    g.append('g')
      .attr('transform', `translate(0, ${height})`)
      .call(xAxis)
      .selectAll('text')
      .style('font-size', '12px');

    const yAxis = d3.axisLeft(yScale);
    g.append('g')
      .call(yAxis);

    g.append('text')
      .attr('x', width / 2)
      .attr('y', -10)
      .attr('text-anchor', 'middle')
      .style('font-size', '16px')
      .style('font-weight', 'bold')
      .text(`Violin Plot: ${geneName || 'Unknown Gene'}`);

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -height / 2)
      .attr('y', -40)
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .text('log1p(normalized expression)');

  };

  const renderGeneDotplot = (g, results, width, height, margin) => {
    const {
      geneNames,
      clusterIds,
      percentExpressing,
      averageExpression,
      clusterCellCounts,
      colorMap,
    } = results;

    if (!Array.isArray(geneNames) || !geneNames.length) {
      console.warn('Dot plot requires at least one gene.');
      return;
    }

    if (!Array.isArray(clusterIds) || !clusterIds.length) {
      console.warn('Dot plot requires cluster identifiers.');
      return;
    }

    if (
      !Array.isArray(percentExpressing) ||
      !Array.isArray(averageExpression) ||
      percentExpressing.length !== clusterIds.length ||
      averageExpression.length !== clusterIds.length
    ) {
      console.warn('Dot plot data dimension mismatch.', {
        percentExpressingLength: percentExpressing?.length,
        averageExpressionLength: averageExpression?.length,
        clusterIdsLength: clusterIds?.length,
      });
      return;
    }

    const nGenes = geneNames.length;
    const percentRows = percentExpressing.map((row) => Array.from(row));
    const averageRows = averageExpression.map((row) => Array.from(row));
    const cellCounts = Array.isArray(clusterCellCounts) && clusterCellCounts.length === clusterIds.length
      ? clusterCellCounts
      : clusterIds.map(() => 1);

    const labelToIndices = new Map();
    for (let i = 0; i < clusterIds.length; i++) {
      const displayLabel = formatClusterLabel(clusterIds[i], clusterLabelMap) || String(clusterIds[i]);
      if (!labelToIndices.has(displayLabel)) {
        labelToIndices.set(displayLabel, []);
      }
      labelToIndices.get(displayLabel).push(i);
    }

    const mergedClusterLabels = [];
    const mergedPercentRows = [];
    const mergedAverageRows = [];

    for (const [displayLabel, indices] of labelToIndices) {
      mergedClusterLabels.push(displayLabel);
      const mergedPercent = new Array(nGenes).fill(0);
      const mergedAverage = new Array(nGenes).fill(0);

      let totalCells = 0;
      for (const idx of indices) {
        totalCells += cellCounts[idx] || 0;
      }

      for (let geneIdx = 0; geneIdx < nGenes; geneIdx++) {
        let expressingCells = 0;
        let expressionSum = 0;
        for (const idx of indices) {
          const n = cellCounts[idx] || 0;
          const pct = percentRows[idx][geneIdx] ?? 0;
          const avg = averageRows[idx][geneIdx] ?? 0;
          const nExpr = Math.round(pct * n);
          expressingCells += nExpr;
          expressionSum += avg * nExpr;
        }
        mergedPercent[geneIdx] = totalCells > 0 ? expressingCells / totalCells : 0;
        mergedAverage[geneIdx] = expressingCells > 0 ? expressionSum / expressingCells : 0;
      }
      mergedPercentRows.push(mergedPercent);
      mergedAverageRows.push(mergedAverage);
    }

    const clusterLabels = mergedClusterLabels;
    const geneLabels = geneNames.map((name) => String(name));

    const nClusters = clusterLabels.length;

    const dataMatrixValid = mergedPercentRows.every((row) => row.length === nGenes) &&
      mergedAverageRows.every((row) => row.length === nGenes);

    if (!dataMatrixValid) {
      console.warn('Dot plot row lengths do not match gene count.', {
        nGenes,
        percentRowLengths: mergedPercentRows.map(r => r.length),
        averageRowLengths: mergedAverageRows.map(r => r.length),
      });
      return;
    }

    const scaledByGene = geneLabels.map((_, geneIdx) => {
      const values = clusterLabels.map((__, clusterIdx) => mergedAverageRows[clusterIdx][geneIdx] || 0);
      const finiteValues = values.filter((v) => Number.isFinite(v));
      if (!finiteValues.length) {
        return clusterLabels.map(() => 0);
      }
      const mean = finiteValues.reduce((acc, v) => acc + v, 0) / finiteValues.length;
      let variance = 0;
      for (const v of finiteValues) {
        const diff = v - mean;
        variance += diff * diff;
      }
      const denom = finiteValues.length > 1 ? Math.sqrt(variance / (finiteValues.length - 1)) : 0;
      const safeDenom = denom || 1;
      return values.map((value) => {
        const scaled = (value - mean) / safeDenom;
        if (!Number.isFinite(scaled)) {
          return 0;
        }
        return Math.max(-4, Math.min(4, scaled));
      });
    });

    const records = [];
    for (let clusterIdx = 0; clusterIdx < nClusters; clusterIdx++) {
      for (let geneIdx = 0; geneIdx < nGenes; geneIdx++) {
        const percent = mergedPercentRows[clusterIdx][geneIdx] ?? 0;
        const avgValue = mergedAverageRows[clusterIdx][geneIdx] ?? 0;
        const scaledValue = scaledByGene[geneIdx][clusterIdx] ?? 0;
        records.push({
          cluster: clusterLabels[clusterIdx],
          gene: geneLabels[geneIdx],
          percent: Math.max(0, Math.min(1, percent)),
          avgValue,
          scaledValue,
        });
      }
    }

    if (!records.length) {
      console.warn('No dot plot records to render.');
      return;
    }

    const xScale = d3.scaleBand()
      .domain(geneLabels)
      .range([0, width])
      .paddingInner(0.2)
      .paddingOuter(0.1);

    const yScale = d3.scaleBand()
      .domain(clusterLabels)
      .range([0, height])
      .paddingInner(0.2)
      .paddingOuter(0.1);

    const maxPercent = d3.max(records, (d) => d.percent) || 0;
    const baseRadius = Math.max(4, Math.min(xScale.bandwidth(), yScale.bandwidth()) / 2.2);
    const sizeScale = d3.scaleSqrt()
      .domain([0, Math.max(maxPercent, 1e-4)])
      .range([0, baseRadius]);

    const colorExtent = d3.extent(records, (d) => d.scaledValue);
    const maxAbs = Math.max(
      Math.abs(colorExtent[0] || 0),
      Math.abs(colorExtent[1] || 0),
      1
    );

    const useGlobalRange = results.expressionRange && Array.isArray(results.expressionRange) && results.expressionRange.length >= 2 &&
      Number.isFinite(results.expressionRange[0]) && Number.isFinite(results.expressionRange[1]);
    const [rangeMin, rangeMax] = useGlobalRange ? results.expressionRange : [null, null];
    const displayMin = useGlobalRange && rangeMin >= 0 ? 0 : rangeMin;
    const displayMax = rangeMax;
    const safeRange = useGlobalRange && displayMax > displayMin ? displayMax - displayMin : 1;

    const DEFAULT_DOTPLOT_COLORS = ['#2166ac', '#f7f7f7', '#b2182b'];
    const hasValidCustom = colorMap?.type === 'custom' && Array.isArray(colorMap?.colors) && colorMap.colors.length >= 3;
    const colorDef = hasValidCustom
      ? colorMap
      : (colorMap?.type === 'scheme' && colorMap?.name ? colorMap : { type: 'custom', colors: DEFAULT_DOTPLOT_COLORS });
    let colorScale;

    if (useGlobalRange) {
      const clamp01 = (v) => Math.max(0, Math.min(1, (v - displayMin) / safeRange));
      if (colorDef.type === 'custom' && Array.isArray(colorDef.colors) && colorDef.colors.length >= 3) {
        const nColors = colorDef.colors.length;
        const colorDomain = colorDef.colors.map((_, i) => displayMin + safeRange * i / (nColors - 1));
        const scale = d3.scaleLinear().domain(colorDomain).range(colorDef.colors);
        colorScale = (d) => scale(d.avgValue);
      } else if (colorDef.type === 'scheme' && colorDef.name) {
        const interpolator = interpolateMap[colorDef.name.toLowerCase()] || d3.interpolateViridis;
        colorScale = (d) => interpolator(clamp01(d.avgValue));
      } else {
        const mid = displayMin + safeRange / 2;
        const scale = d3.scaleLinear().domain([displayMin, mid, displayMax]).range(DEFAULT_DOTPLOT_COLORS);
        colorScale = (d) => scale(d.avgValue);
      }
    } else if (colorDef.type === 'scheme') {
      const schemeName = colorDef.name.toLowerCase();
      const divergingSchemes = ['rdbu', 'brbg', 'piyg', 'puor', 'rdgy', 'rdylbu', 'rdylgn', 'spectral'];

      if (divergingSchemes.includes(schemeName)) {
        const interpolator = d3[`interpolate${colorDef.name}`] || d3.interpolateRdBu;
        colorScale = (d) => {
          const normalized = (d.scaledValue + maxAbs) / (2 * maxAbs);
          return interpolator(1 - normalized);
        };
      } else {
        const interpolator = interpolateMap[schemeName] || d3.interpolateViridis;
        colorScale = (d) => {
          const normalized = (d.scaledValue + maxAbs) / (2 * maxAbs);
          return interpolator(normalized);
        };
      }
    } else if (colorDef.type === 'custom' && Array.isArray(colorDef.colors) && colorDef.colors.length >= 3) {
      const colors = colorDef.colors;
      const steps = colors.length - 1;
      const domain = colors.map((_, idx) => -maxAbs + (2 * maxAbs * idx) / steps);
      const scale = d3.scaleLinear().domain(domain).range(colors);
      colorScale = (d) => scale(d.scaledValue);
    } else {
      const scale = d3.scaleLinear()
        .domain([-maxAbs, 0, maxAbs])
        .range(DEFAULT_DOTPLOT_COLORS)
        .clamp(true);
      colorScale = (d) => scale(d.scaledValue);
    }

    g.append('g')
      .attr('class', 'x-axis')
      .attr('transform', `translate(0, ${height})`)
      .call(d3.axisBottom(xScale))
      .selectAll('text')
      .attr('transform', 'rotate(-45)')
      .style('text-anchor', 'end')
      .attr('dx', '-0.6em')
      .attr('dy', '0.2em');

    g.append('g')
      .attr('class', 'y-axis')
      .call(d3.axisLeft(yScale));

    const cellGroups = g.append('g')
      .attr('class', 'dotplot-cells')
      .selectAll('g')
      .data(records)
      .enter()
      .append('g')
      .attr('transform', (d) => {
        const x = xScale(d.gene) + xScale.bandwidth() / 2;
        const y = yScale(d.cluster) + yScale.bandwidth() / 2;
        return `translate(${x}, ${y})`;
      });

    cellGroups.append('circle')
      .attr('r', (d) => sizeScale(d.percent))
      .attr('fill', (d) => colorScale(d))
      .attr('stroke', 'rgba(0,0,0,0.45)')
      .attr('stroke-width', 0.8)
      .attr('opacity', 0.95);

    const percentFormat = d3.format('.0%');
    cellGroups.append('title')
      .text((d) => {
        const percentLabel = percentFormat(d.percent);
        const valueLabel = d.avgValue.toFixed(3);
        return `${d.gene} in cluster ${d.cluster}\nPercent expressing: ${percentLabel}\nAvg log1p expression (expressing cells): ${valueLabel}`;
      });

    const svg = d3.select(svgRef.current);
    const defs = svg.append('defs');
    const gradientId = `dotplot-gradient-${Date.now()}-${Math.round(Math.random() * 1e5)}`;
    const gradient = defs.append('linearGradient')
      .attr('id', gradientId)
      .attr('x1', '0%')
      .attr('y1', '100%')
      .attr('x2', '0%')
      .attr('y2', '0%');

    const gradientSteps = 20;
    for (let i = 0; i <= gradientSteps; i++) {
      const t = i / gradientSteps;
      const d = useGlobalRange
        ? { avgValue: displayMin + t * safeRange, scaledValue: 0 }
        : { scaledValue: -maxAbs + t * (2 * maxAbs), avgValue: 0 };
      gradient.append('stop')
        .attr('offset', `${t * 100}%`)
        .attr('stop-color', colorScale(d));
    }

    const legend = g.append('g')
      .attr('transform', `translate(${width + 40}, 10)`);

    legend.append('text')
      .attr('font-weight', 'bold')
      .attr('font-size', 12)
      .text('Mean');

    const colorLegendHeight = 180;
    legend.append('rect')
      .attr('x', 0)
      .attr('y', 10)
      .attr('width', 18)
      .attr('height', colorLegendHeight)
      .style('fill', `url(#${gradientId})`);

    const colorLegendScale = d3.scaleLinear()
      .domain(useGlobalRange ? [displayMin, displayMax] : [-maxAbs, maxAbs])
      .range([colorLegendHeight, 0]);

    const colorAxis = d3.axisRight(colorLegendScale)
      .ticks(5)
      .tickFormat(d3.format('.1f'));

    legend.append('g')
      .attr('transform', `translate(18, 10)`)
      .call(colorAxis);

    const sizeLegend = legend.append('g')
      .attr('transform', `translate(0, ${colorLegendHeight + 60})`);

    sizeLegend.append('text')
      .attr('font-weight', 'bold')
      .attr('font-size', 12)
      .text('% Cells');

    const sizeValues = [0.25, 0.5, 0.75]
      .filter((v) => v > 0 && v <= maxPercent + 1e-6);

    if (!sizeValues.length && maxPercent > 0) {
      sizeValues.push(Math.min(1, maxPercent));
    }

    sizeValues.forEach((value, idx) => {
      const yOffset = idx * (baseRadius * 1.8) + 22;
      sizeLegend.append('circle')
        .attr('cx', baseRadius + 4)
        .attr('cy', yOffset)
        .attr('r', sizeScale(value))
        .attr('fill', '#8e8e8e')
        .attr('opacity', 0.4);

      sizeLegend.append('text')
        .attr('x', baseRadius * 2 + 12)
        .attr('y', yOffset + 4)
        .attr('font-size', 11)
        .text(percentFormat(value));
    });

    g.append('text')
      .attr('x', width / 2)
      .attr('y', -16)
      .attr('text-anchor', 'middle')
      .style('font-size', '16px')
      .style('font-weight', 'bold')
      .text('Gene Dot Plot');

    g.append('text')
      .attr('x', width / 2)
      .attr('y', height + 60)
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .text('Genes');

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -height / 2)
      .attr('y', -margin.left + 20)
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .text('Clusters');

  };

  const renderQCPlots = (g, results, width, height) => {
    const { metrics, perCell } = results;
    const panels = [
      {
        title: `Genes per cell (median ${metrics.medianGenesPerCell})`,
        values: perCell?.genesPerCell || [],
        color: '#4caf50',
        formatter: d3.format('~s'),
      },
      {
        title: `UMIs per cell (median ${metrics.medianUMIsPerCell})`,
        values: perCell?.umiPerCell || [],
        color: '#2196f3',
        formatter: d3.format('~s'),
      },
      {
        title: `Mitochondrial % (median ${metrics.medianMitoPercent || 'NA'}%)`,
        values: perCell?.mitoPercent || [],
        color: '#ff9800',
        formatter: d => `${d.toFixed(1)}%`,
      },
    ];

    const panelHeight = height / panels.length;

    panels.forEach((panel, idx) => {
      if (!panel.values || panel.values.length === 0) {
        return;
      }

      const panelGroup = g.append('g')
        .attr('transform', `translate(0, ${idx * panelHeight})`);

      const innerHeight = panelHeight - 40;
      const innerWidth = width;

      const sortedValues = panel.values.slice().sort((a, b) => a - b);
      const maxIndex = sortedValues.length - 1;
      const clipIndex = Math.floor(sortedValues.length * 0.95);
      const clipValue = sortedValues[Math.min(clipIndex, maxIndex)];
      const clippedValues = panel.values.filter(v => v <= clipValue);

      const [minVal, maxVal] = d3.extent(clippedValues);
      const xScale = d3.scaleLinear()
        .domain([minVal, maxVal])
        .nice()
        .range([0, innerWidth - 60]);

      const bins = d3.bin()
        .domain(xScale.domain())
        .thresholds(30)(clippedValues);

      const yScale = d3.scaleLinear()
        .domain([0, d3.max(bins, d => d.length)])
        .range([innerHeight, 0]);

      const barGroup = panelGroup.append('g')
        .attr('transform', 'translate(40, 20)');

      barGroup.selectAll('rect')
        .data(bins)
        .enter()
        .append('rect')
        .attr('x', d => xScale(d.x0))
        .attr('y', d => yScale(d.length))
        .attr('width', d => Math.max(0, xScale(d.x1) - xScale(d.x0) - 1))
        .attr('height', d => innerHeight - yScale(d.length))
        .attr('fill', panel.color)
        .attr('opacity', 0.7);

      const xAxis = d3.axisBottom(xScale)
        .ticks(5)
        .tickFormat(panel.formatter);

      barGroup.append('g')
        .attr('transform', `translate(0, ${innerHeight})`)
        .call(xAxis);

      const yAxis = d3.axisLeft(yScale)
        .ticks(4)
        .tickFormat(d3.format('~s'));

      barGroup.append('g')
        .call(yAxis);

      panelGroup.append('text')
        .attr('x', 40)
        .attr('y', 12)
        .attr('font-weight', 'bold')
        .text(panel.title);
    });
  };

  const renderMarkersTable = (results) => {
    if (!results) {
      return null;
    }

    const markers = Array.isArray(results.markers) ? results.markers : [];
    const isPeak = results.featureType === 'peak';
    const clusterId = results.cluster;
    const clusterLabel = clusterLabelMap?.[String(clusterId)] ?? clusterId ?? 'N/A';
    const formatNumber = (value, digits = 2) => {
      if (!Number.isFinite(value)) {
        return 'NA';
      }
      return Number.parseFloat(value).toFixed(digits);
    };
    const formatPercent = (value) => {
      if (!Number.isFinite(value)) {
        return 'NA';
      }
      return `${(value * 100).toFixed(1)}%`;
    };
    const formatPValue = (value) => {
      if (!Number.isFinite(value) || value <= 0) {
        return '<1e-308';
      }
      return value < 1e-4 ? value.toExponential(2) : value.toFixed(4);
    };

    return (
      <div className="markers-table-wrapper">
        <div className="markers-summary">
          <div>
            <h3>Cluster {clusterLabel} marker {isPeak ? 'peaks' : 'genes'}</h3>
            <p className="markers-subtitle">
              {`Cells in cluster: ${
                results.clusterSize?.toLocaleString?.() ?? results.clusterSize ?? 'N/A'
              } · Cells outside: ${
                results.otherCells?.toLocaleString?.() ?? results.otherCells ?? 'N/A'
              } · Total cells: ${
                results.totalCells?.toLocaleString?.() ?? results.totalCells ?? 'N/A'
              }`}
            </p>
          </div>
          <div className="markers-meta">
            <span>
              {`${isPeak ? 'Peaks' : 'Genes'} evaluated: ${
                results.totalGenes?.toLocaleString?.() ?? results.totalGenes ?? 'N/A'
              }`}
            </span>
            <span>{`Test: ${results.method === 'wilcoxon_rank_sum' ? 'Wilcoxon rank-sum' : results.method}`}</span>
          </div>
        </div>

        <div className="markers-table-scroll">
          <table className="markers-table">
            <thead>
              <tr>
                <th>{isPeak ? 'Peak' : 'Gene'}</th>
                <th>p_val</th>
                <th>avg_logFC</th>
                <th>pct.1</th>
                <th>pct.2</th>
                <th>p_val_adj</th>
              </tr>
            </thead>
            <tbody>
              {markers.length ? (
                markers.map((marker, idx) => (
                  <tr key={`${marker.gene}-${idx}`}>
                    <td className="gene-name-cell">{marker.gene}</td>
                    <td>{formatPValue(marker.p_val)}</td>
                    <td>{formatNumber(marker.avg_logFC, 3)}</td>
                    <td>{formatPercent(marker.pct1)}</td>
                    <td>{formatPercent(marker.pct2)}</td>
                    <td>{formatPValue(marker.p_val_adj)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="markers-empty">
                    No marker {isPeak ? 'peaks' : 'genes'} were detected for the selected cluster.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="markers-footnote">
          {isPeak
            ? 'Statistics computed relative to all other clusters. pct.1 and pct.2 indicate the fraction of cells with detectable accessibility inside and outside the target cluster, respectively.'
            : 'Statistics computed relative to all other clusters. pct.1 and pct.2 indicate the fraction of cells with detectable expression inside and outside the target cluster, respectively.'
          }
        </p>
      </div>
    );
  };

  const PCT_EXPRESSION_MIN = 0.2;

  const renderClusterAnnotationTable = (results) => {
    if (!results) return null;
    const rows = Array.isArray(results.rows) ? results.rows : [];
    const successCount = results.successCount ?? rows.filter(r => !r.error).length;
    const totalCount = results.totalCount ?? rows.length;

    const confBadge = (conf) => {
      const styles = {
        high:   { background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' },
        medium: { background: '#fef9c3', color: '#92400e', border: '1px solid #fde047' },
        low:    { background: '#fee2e2', color: '#b91c1c', border: '1px solid #fca5a5' },
      };
      const s = styles[conf] || styles.medium;
      return (
        <span style={{ ...s, padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {conf || 'medium'}
        </span>
      );
    };

    return (
      <div className="markers-table-wrapper">
        <div className="markers-summary">
          <div>
            <h3>Cluster Annotation</h3>
            <p className="markers-subtitle">{successCount} of {totalCount} clusters annotated</p>
          </div>
        </div>
        <div className="markers-table-scroll">
          <table className="markers-table" style={{ minWidth: 560 }}>
            <thead>
              <tr>
                <th style={{ width: 48, textAlign: 'right' }}>#</th>
                <th style={{ width: 80 }}>Label</th>
                <th>Cell type</th>
                <th style={{ width: 100 }}>Confidence</th>
                <th>Top markers</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const label = clusterLabelMap?.[String(r.clusterId)] ?? `Cluster ${r.clusterId}`;
                if (r.error) {
                  return (
                    <tr key={i}>
                      <td style={{ textAlign: 'right', color: '#9ca3af' }}>{r.clusterId}</td>
                      <td colSpan={4} style={{ color: '#9ca3af', fontStyle: 'italic' }}>failed, {r.error}</td>
                    </tr>
                  );
                }
                const topMarkers = (r.markers || '').split(',').slice(0, 3).map(s => s.trim()).filter(Boolean).join(', ');
                return (
                  <tr key={i}>
                    <td style={{ textAlign: 'right', color: '#6b7280', fontVariantNumeric: 'tabular-nums' }}>{r.clusterId}</td>
                    <td className="gene-name-cell" style={{ color: '#1d4ed8' }}>{r.shortName}</td>
                    <td>{r.cellType}</td>
                    <td>{confBadge(r.confidence)}</td>
                    <td style={{ color: '#6b7280', fontStyle: 'italic' }}>{topMarkers || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="markers-footnote">
          Short labels are suggested for UMAP display. Reply "yes" in the chat to rename all clusters.
        </p>
      </div>
    );
  };

  const renderDegBetweenSamples = (results) => {
    if (!results || results.type !== 'deg_between_samples') return null;
    const isPeak = results.featureType === 'peak';
    const s1 = results.sample1 ?? 'sample1';
    const s2 = results.sample2 ?? 'sample2';
    const markers = Array.isArray(results.markers) ? results.markers : [];
    const passesPct = (m) => (m.pct1 ?? 0) > PCT_EXPRESSION_MIN || (m.pct2 ?? 0) > PCT_EXPRESSION_MIN;
    const filteredMarkers = markers.filter(passesPct);
    const formatNumber = (value, digits = 2) => (Number.isFinite(value) ? Number.parseFloat(value).toFixed(digits) : 'NA');
    const formatPercent = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'NA');
    const formatPValue = (value) => {
      if (!Number.isFinite(value) || value <= 0) return '<1e-308';
      return value < 1e-4 ? value.toExponential(2) : value.toFixed(4);
    };
    const featureLabel = isPeak ? 'peaks' : 'genes';
    const titleLabel = isPeak ? 'Differential peaks' : 'DEG';
    return (
      <div className="deg-between-samples-panel">
        <div className="deg-between-samples-left">
          <h3 className="deg-between-samples-title">{titleLabel} between {s1} vs. {s2}</h3>
          <p className="markers-subtitle">
            Cluster {results.cluster} · {results.clusterSizeSample1 ?? '—'} cells ({s1}) · {results.clusterSizeSample2 ?? '—'} cells ({s2}) · showing {featureLabel} with &gt;20% in either sample
          </p>
          <div className="markers-table-scroll">
            <table className="markers-table">
              <thead>
                <tr>
                  <th>{isPeak ? 'Peak' : 'Gene'}</th>
                  <th>p_val</th>
                  <th>avg_logFC</th>
                  <th>pct.1</th>
                  <th>pct.2</th>
                  <th>p_val_adj</th>
                </tr>
              </thead>
              <tbody>
                {filteredMarkers.length ? (
                  filteredMarkers.map((marker, idx) => (
                    <tr key={`${marker.gene}-${idx}`}>
                      <td className="gene-name-cell">{marker.gene}</td>
                      <td>{formatPValue(marker.p_val)}</td>
                      <td>{formatNumber(marker.avg_logFC, 3)}</td>
                      <td>{formatPercent(marker.pct1)}</td>
                      <td>{formatPercent(marker.pct2)}</td>
                      <td>{formatPValue(marker.p_val_adj)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="markers-empty">No differential {featureLabel} with &gt;20% in either sample.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="deg-between-samples-right">
          <h3 className="deg-between-samples-title">Volcano plot {s1} vs. {s2}</h3>
          <div ref={volcanoRef} className="deg-volcano-container" aria-label="Volcano plot" />
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (!resolvedResults || resolvedResults.type !== 'deg_between_samples' || !volcanoRef.current) return;
    const raw = Array.isArray(resolvedResults.allMarkers) ? resolvedResults.allMarkers : resolvedResults.markers || [];
    const all = raw.filter((d) => (d.pct1 ?? 0) > PCT_EXPRESSION_MIN || (d.pct2 ?? 0) > PCT_EXPRESSION_MIN);
    if (!all.length) return;
    const el = volcanoRef.current;
    const width = el.clientWidth || 400;
    const height = el.clientHeight || 320;
    const margin = { top: 24, right: 24, bottom: 36, left: 44 };
    const w = Math.max(100, width - margin.left - margin.right);
    const h = Math.max(100, height - margin.top - margin.bottom);
    const sorted = all.slice().sort((a, b) => (a.avg_logFC || 0) - (b.avg_logFC || 0));
    const top10Down = sorted.slice(0, 10);
    const top10Up = sorted.slice(-10);
    const top10DownSet = new Set(top10Down.map((r) => r.gene));
    const top10UpSet = new Set(top10Up.map((r) => r.gene));
    const xExtent = d3.extent(all, (d) => d.avg_logFC);
    const pad = (xExtent[1] - xExtent[0]) * 0.05 || 0.5;
    const xDomain = [xExtent[0] - pad, xExtent[1] + pad];
    const logP = all.map((d) => {
      const p = d.p_val_adj;
      return p > 0 && Number.isFinite(p) ? -Math.log10(Math.max(p, 1e-320)) : 0;
    });
    const yMax = Math.max(...logP, 1);
    const yDomain = [0, yMax * 1.05];
    const xScale = d3.scaleLinear().domain(xDomain).range([0, w]);
    const yScale = d3.scaleLinear().domain(yDomain).range([h, 0]);
    const getY = (d) => {
      const p = d.p_val_adj;
      const yVal = p > 0 && Number.isFinite(p) ? -Math.log10(Math.max(p, 1e-320)) : 0;
      return yScale(yVal);
    };
    d3.select(el).selectAll('*').remove();
    const svg = d3.select(el).append('svg').attr('width', width).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    g.append('g')
      .attr('transform', `translate(0,${h})`)
      .call(d3.axisBottom(xScale).ticks(8))
      .selectAll('text')
      .attr('font-size', 11);
    g.append('g')
      .call(d3.axisLeft(yScale).ticks(6))
      .selectAll('text')
      .attr('font-size', 11);
    g.append('text')
      .attr('x', w / 2)
      .attr('y', h + margin.bottom - 6)
      .attr('text-anchor', 'middle')
      .attr('font-size', 12)
      .text('avg_logFC (same as table)');
    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -h / 2)
      .attr('y', -margin.left + 12)
      .attr('text-anchor', 'middle')
      .attr('font-size', 12)
      .text('-log10(adj p-value)');
    const gray = g.append('g').attr('class', 'volcano-points-gray');
    const blue = g.append('g').attr('class', 'volcano-points-blue');
    const red = g.append('g').attr('class', 'volcano-points-red');
    all.forEach((d) => {
      const x = xScale(d.avg_logFC);
      const y = getY(d);
      const grp = top10DownSet.has(d.gene) ? blue : top10UpSet.has(d.gene) ? red : gray;
      grp
        .append('circle')
        .attr('cx', x)
        .attr('cy', y)
        .attr('r', top10DownSet.has(d.gene) || top10UpSet.has(d.gene) ? 4 : 2)
        .attr('fill', top10DownSet.has(d.gene) ? '#3182bd' : top10UpSet.has(d.gene) ? '#de2d26' : '#999')
        .attr('opacity', top10DownSet.has(d.gene) || top10UpSet.has(d.gene) ? 1 : 0.6);
    });
    const labelOffset = 8;
    const labelNodes = [...top10Down, ...top10Up].map((d, i) => {
      const isDown = top10DownSet.has(d.gene);
      const anchorX = xScale(d.avg_logFC) + (isDown ? -labelOffset : labelOffset);
      const anchorY = getY(d);
      return {
        ...d,
        index: i,
        isDown,
        fill: isDown ? '#3182bd' : '#de2d26',
        anchorX,
        anchorY,
        x: anchorX,
        y: anchorY,
      };
    });
    if (labelNodes.length > 0 && typeof d3.forceSimulation === 'function') {
      const radius = (node) => Math.max(14, (node.gene?.length ?? 4) * 4);
      const sim = d3.forceSimulation(labelNodes)
        .force('collide', d3.forceCollide(radius).iterations(4))
        .force('x', d3.forceX((d) => d.anchorX).strength(0.12))
        .force('y', d3.forceY((d) => d.anchorY).strength(0.12));
      for (let i = 0; i < 280; i++) sim.tick();
      labelNodes.forEach((node) => {
        node.x = Math.max(0, Math.min(w, node.x));
        node.y = Math.max(0, Math.min(h, node.y));
      });
    }
    const labels = g.append('g').attr('class', 'volcano-labels');
    labelNodes.forEach((node) => {
      labels
        .append('text')
        .attr('x', node.x)
        .attr('y', node.y)
        .attr('text-anchor', node.isDown ? 'end' : 'start')
        .attr('dominant-baseline', 'middle')
        .attr('font-size', 10)
        .attr('font-weight', 600)
        .attr('fill', node.fill)
        .text(node.gene);
    });
  }, [resolvedResults]);

  const renderCellFraction = (results) => {
    if (!results || results.type !== 'cell_fraction') return null;
    const names = Array.isArray(results.datasetNames) ? results.datasetNames : [];
    const perSample = results.perSample || {};
    const sampleNames = names.length >= 2 ? [names[0], names[1]] : names.length === 1 ? [names[0]] : Object.keys(perSample).slice(0, 2);
    return (
      <div className="deg-between-samples-panel cell-fraction-panel">
        <div className="deg-between-samples-left">
          <h3 className="deg-between-samples-title">Cell fraction · {sampleNames[0] || 'Sample 1'}</h3>
          <div ref={cellFractionLeftRef} className="cell-fraction-chart" aria-label={`Cell fraction bar chart ${sampleNames[0] || ''}`} />
        </div>
        <div className="deg-between-samples-right">
          <h3 className="deg-between-samples-title">Cell fraction · {sampleNames[1] || 'Sample 2'}</h3>
          <div ref={cellFractionRightRef} className="cell-fraction-chart" aria-label={`Cell fraction bar chart ${sampleNames[1] || ''}`} />
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (!resolvedResults || resolvedResults.type !== 'cell_fraction') return;
    const perSample = resolvedResults.perSample || {};
    const names = Array.isArray(resolvedResults.datasetNames) ? resolvedResults.datasetNames : Object.keys(perSample);
    const sampleNames = names.length >= 2 ? [names[0], names[1]] : names.length === 1 ? [names[0]] : [];
    const domain = Array.isArray(resolvedResults.clusterColorDomain) ? resolvedResults.clusterColorDomain : [];
    const scale = createClusterColorScale(domain);
    const getBarColor = (clusterId) => {
      const key = String(clusterId);
      const override = clusterColorOverrides?.[key];
      if (override) return typeof override === 'string' ? override : d3.rgb(override[0], override[1], override[2]).formatHex();
      return scale ? scale(key) : '#888';
    };
    [cellFractionLeftRef, cellFractionRightRef].forEach((ref, idx) => {
      const sampleName = sampleNames[idx];
      const el = ref.current;
      if (!el || !sampleName) {
        if (el) d3.select(el).selectAll('*').remove();
        return;
      }
      const data = perSample[sampleName];
      if (!data || !Array.isArray(data.entries) || data.entries.length === 0) {
        d3.select(el).selectAll('*').remove();
        return;
      }
      const total = data.totalCells || 1;
      const entries = data.entries.map((e) => ({
        clusterId: e.clusterId,
        label: formatClusterLabel(e.clusterId, clusterLabelMap) || String(e.clusterId),
        count: e.count,
        pct: (e.count / total) * 100,
      }));
      const width = el.clientWidth || 400;
      const height = el.clientHeight || 320;
      const margin = { top: 16, right: 24, bottom: 80, left: 48 };
      const w = Math.max(100, width - margin.left - margin.right);
      const h = Math.max(120, height - margin.top - margin.bottom);
      const yScale = d3.scaleBand().domain(entries.map((d) => d.label)).range([0, h]).padding(0.25);
      const xMax = Math.max(...entries.map((d) => d.pct), 1);
      const xScale = d3.scaleLinear().domain([0, xMax * 1.05]).range([0, w]);
      d3.select(el).selectAll('*').remove();
      const svg = d3.select(el).append('svg').attr('width', width).attr('height', height);
      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
      g.append('g')
        .attr('transform', `translate(0,${h})`)
        .call(d3.axisBottom(xScale).ticks(6))
        .selectAll('text')
        .attr('font-size', 11);
      g.append('g')
        .call(d3.axisLeft(yScale))
        .selectAll('text')
        .attr('font-size', 10);
      g.selectAll('.bar')
        .data(entries)
        .join('rect')
        .attr('class', 'bar')
        .attr('y', (d) => yScale(d.label))
        .attr('height', yScale.bandwidth())
        .attr('x', 0)
        .attr('width', (d) => xScale(d.pct))
        .attr('fill', (d) => getBarColor(d.clusterId));
      g.append('text')
        .attr('x', w / 2)
        .attr('y', h + margin.bottom - 8)
        .attr('text-anchor', 'middle')
        .attr('font-size', 12)
        .text('% of cells');
    });
  }, [resolvedResults, clusterLabelMap, clusterColorOverrides]);

  const renderRegionComposition = (results) => {
    if (!results || results.type !== 'region_composition') return null;
    return (
      <div className="deg-between-samples-panel cell-fraction-panel" style={{ justifyContent: 'center' }}>
        <div style={{ flex: '1 1 100%', maxWidth: 600 }}>
          <h3 className="deg-between-samples-title">Cell type composition · Region {results.regionId}</h3>
          <div ref={regionCompositionRef} className="cell-fraction-chart" aria-label={`Region ${results.regionId} composition`} />
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (!resolvedResults || resolvedResults.type !== 'region_composition') return;
    const el = regionCompositionRef.current;
    if (!el) return;
    const entries = resolvedResults.entries || [];
    if (entries.length === 0) {
      d3.select(el).selectAll('*').remove();
      return;
    }
    const domain = Array.isArray(resolvedResults.clusterColorDomain) ? resolvedResults.clusterColorDomain : [];
    const scale = createClusterColorScale(domain);
    const getBarColor = (clusterId) => {
      const key = String(clusterId);
      const override = clusterColorOverrides?.[key];
      if (override) return typeof override === 'string' ? override : d3.rgb(override[0], override[1], override[2]).formatHex();
      return scale ? scale(key) : '#888';
    };
    const items = entries.map((e) => ({
      clusterId: e.clusterId,
      label: formatClusterLabel(e.clusterId, clusterLabelMap) || String(e.clusterId),
      count: e.count,
      pct: e.fraction * 100,
    })).sort((a, b) => b.pct - a.pct);

    const width = el.clientWidth || 500;
    const height = Math.max(items.length * 28 + 120, 240);
    const margin = { top: 16, right: 24, bottom: 60, left: 80 };
    const w = Math.max(100, width - margin.left - margin.right);
    const h = Math.max(80, height - margin.top - margin.bottom);
    const yScale = d3.scaleBand().domain(items.map((d) => d.label)).range([0, h]).padding(0.25);
    const xMax = Math.max(...items.map((d) => d.pct), 1);
    const xScale = d3.scaleLinear().domain([0, xMax * 1.05]).range([0, w]);
    d3.select(el).selectAll('*').remove();
    const svg = d3.select(el).append('svg').attr('width', width).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    g.append('g')
      .attr('transform', `translate(0,${h})`)
      .call(d3.axisBottom(xScale).ticks(6))
      .selectAll('text')
      .attr('font-size', 11);
    g.append('g')
      .call(d3.axisLeft(yScale))
      .selectAll('text')
      .attr('font-size', 10);
    g.selectAll('.bar')
      .data(items)
      .join('rect')
      .attr('class', 'bar')
      .attr('y', (d) => yScale(d.label))
      .attr('height', yScale.bandwidth())
      .attr('x', 0)
      .attr('width', (d) => xScale(d.pct))
      .attr('fill', (d) => getBarColor(d.clusterId));
    g.selectAll('.bar-label')
      .data(items)
      .join('text')
      .attr('class', 'bar-label')
      .attr('y', (d) => yScale(d.label) + yScale.bandwidth() / 2)
      .attr('x', (d) => xScale(d.pct) + 4)
      .attr('dy', '0.35em')
      .attr('font-size', 10)
      .attr('fill', '#555')
      .text((d) => `${d.pct.toFixed(1)}%`);
    g.append('text')
      .attr('x', w / 2)
      .attr('y', h + margin.bottom - 12)
      .attr('text-anchor', 'middle')
      .attr('font-size', 12)
      .text('% of cells in region');
  }, [resolvedResults, clusterLabelMap, clusterColorOverrides]);

  const renderPeaksOnGeneTrack = (results) => {
    const coverageByCluster = Array.isArray(results.coverageByCluster) ? results.coverageByCluster : [];
    const hasCoverage = coverageByCluster.length > 0 && results.region;
    if (hasCoverage) {
      return (
        <div className="peaks-on-gene-scroll-wrapper">
          <CoveragePlot
            region={results.region}
            coverageByCluster={coverageByCluster}
            peaksOnGene={Array.isArray(results.peaksOnGene) ? results.peaksOnGene : []}
            geneName={results.geneName || 'gene'}
            genome={results.genome}
            clusterColorOverrides={clusterColorOverrides}
            clusterLabelMap={clusterLabelMap}
          />
        </div>
      );
    }

    const peaks = Array.isArray(results.peaksOnGene) ? results.peaksOnGene : [];
    const geneName = formatGeneNameForDisplay(results.geneName || 'gene', results.genome);
    if (peaks.length === 0) return null;

    if (results.region) {
      return (
        <div className="peaks-on-gene-wrapper peaks-on-gene-loading">
          <div className="peaks-on-gene-header">
            <h3>Peaks on {geneName}</h3>
            <p className="peaks-on-gene-subtitle">
              Computing peak coverage…
            </p>
          </div>
          <div className="peaks-track-loading-placeholder" aria-busy="true">
            <Icon icon="refresh" iconSize={24} />
            <span>Peak coverage plot will show chromosome, gene track, and cluster tracks when ready.</span>
          </div>
        </div>
      );
    }

    const geneNameNoRegion = formatGeneNameForDisplay(results.geneName || 'gene', results.genome);
    return (
      <div className="peaks-on-gene-wrapper peaks-on-gene-loading">
        <div className="peaks-on-gene-header">
          <h3>Peaks on {geneNameNoRegion}</h3>
          <p className="peaks-on-gene-subtitle">
            {peaks.length} peak{peaks.length !== 1 ? 's' : ''} linked to this gene. No region available for coverage plot.
          </p>
        </div>
      </div>
    );
  };

  const renderSpatialCellInteraction = (results) => {
    const interactions = Array.isArray(results.interactions) ? results.interactions : [];
    const regions = Array.isArray(results.regions) ? results.regions : [];
    const dotRows = interactions.slice(0, 20);
    const regionShort = new Map(regions.map((region, idx) => [region.id, `R${idx + 1}`]));
    const routeLabelFor = (item) => `${regionShort.get(item.source) || item.source} -> ${regionShort.get(item.target) || item.target}`;
    const routeLabels = Array.from(new Set(dotRows.map(routeLabelFor))).slice(0, 12);
    const maxProb = d3.max(dotRows, item => item.probability) || 1;
    const minProb = d3.min(dotRows, item => item.probability) || 0;
    const probSpan = Math.max(1e-12, maxProb - minProb);
    const communicationColor = (probability) => {
      const level = Math.max(0, Math.min(1, ((probability || 0) - minProb) / probSpan));
      return d3.interpolateSpectral(1 - level);
    };

    const color = d3.scaleOrdinal(ensurePaletteLength(Math.max(regions.length, 1))).domain(regions.map(r => r.id));
    const regionIndex = new Map(regions.map((region, idx) => [region.id, idx]));
    const strengthMatrix = regions.map(() => regions.map(() => 0));
    interactions.forEach((item) => {
      const sourceIdx = regionIndex.get(item.source);
      const targetIdx = regionIndex.get(item.target);
      if (sourceIdx == null || targetIdx == null) return;
      strengthMatrix[sourceIdx][targetIdx] += Number(item.probability) || 0;
    });
    const maxStrength = d3.max(strengthMatrix.flat()) || 1;
    const networkRadius = regions.length <= 2 ? 132 : 154;
    const networkNodes = regions.map((region, idx) => {
      const angle = (2 * Math.PI * idx) / Math.max(regions.length, 1) - Math.PI / 2;
      const outgoing = d3.sum(strengthMatrix[idx] || []);
      const incoming = strengthMatrix.reduce((sum, row) => sum + (row[idx] || 0), 0);
      return {
        id: region.id,
        index: idx,
        shortLabel: regionShort.get(region.id) || region.id,
        angle,
        x: Math.cos(angle) * networkRadius,
        y: Math.sin(angle) * networkRadius,
        total: incoming + outgoing
      };
    });
    const maxNodeTotal = d3.max(networkNodes, node => node.total) || 1;
    networkNodes.forEach((node) => {
      node.radius = 8 + 12 * Math.sqrt(node.total / maxNodeTotal);
    });
    const networkEdges = [];
    strengthMatrix.forEach((row, sourceIdx) => {
      row.forEach((strength, targetIdx) => {
        if (strength <= 0) return;
        networkEdges.push({
          source: networkNodes[sourceIdx],
          target: networkNodes[targetIdx],
          sourceIdx,
          targetIdx,
          strength,
          level: strength / maxStrength,
          hasReverse: (strengthMatrix[targetIdx]?.[sourceIdx] || 0) > 0
        });
      });
    });
    networkEdges.sort((a, b) => a.strength - b.strength);
    const edgeGeometry = (edge) => {
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / distance;
      const uy = dy / distance;
      const startPad = (edge.source.radius || 12) + 5;
      const endPad = (edge.target.radius || 12) + 7;
      const startX = edge.source.x + ux * startPad;
      const startY = edge.source.y + uy * startPad;
      const tipX = edge.target.x - ux * endPad;
      const tipY = edge.target.y - uy * endPad;
      const pairSign = edge.sourceIdx < edge.targetIdx ? 1 : -1;
      const curve = Math.min(edge.hasReverse ? 72 : 42, distance * (edge.hasReverse ? 0.34 : 0.22));
      const controlX = (startX + tipX) / 2 + (-uy) * curve * pairSign;
      const controlY = (startY + tipY) / 2 + ux * curve * pairSign;
      return { startX, startY, tipX, tipY, controlX, controlY };
    };
    const arrowRibbonPath = (edge) => {
      const { startX, startY, tipX, tipY, controlX, controlY } = edgeGeometry(edge);
      const tangentX = tipX - controlX;
      const tangentY = tipY - controlY;
      const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));
      const tx = tangentX / tangentLength;
      const ty = tangentY / tangentLength;
      const nx = -ty;
      const ny = tx;
      const shaftWidth = 1.8 + 7.6 * Math.sqrt(edge.level);
      const headWidth = shaftWidth + 9;
      const headLength = 11 + 8 * Math.sqrt(edge.level);
      const baseX = tipX - tx * headLength;
      const baseY = tipY - ty * headLength;
      const startLeftX = startX + nx * shaftWidth / 2;
      const startLeftY = startY + ny * shaftWidth / 2;
      const startRightX = startX - nx * shaftWidth / 2;
      const startRightY = startY - ny * shaftWidth / 2;
      const baseLeftX = baseX + nx * shaftWidth / 2;
      const baseLeftY = baseY + ny * shaftWidth / 2;
      const baseRightX = baseX - nx * shaftWidth / 2;
      const baseRightY = baseY - ny * shaftWidth / 2;
      const headLeftX = baseX + nx * headWidth / 2;
      const headLeftY = baseY + ny * headWidth / 2;
      const headRightX = baseX - nx * headWidth / 2;
      const headRightY = baseY - ny * headWidth / 2;
      const controlLeftX = controlX + nx * shaftWidth / 2;
      const controlLeftY = controlY + ny * shaftWidth / 2;
      const controlRightX = controlX - nx * shaftWidth / 2;
      const controlRightY = controlY - ny * shaftWidth / 2;
      return [
        `M ${startLeftX} ${startLeftY}`,
        `Q ${controlLeftX} ${controlLeftY} ${baseLeftX} ${baseLeftY}`,
        `L ${headLeftX} ${headLeftY}`,
        `L ${tipX} ${tipY}`,
        `L ${headRightX} ${headRightY}`,
        `L ${baseRightX} ${baseRightY}`,
        `Q ${controlRightX} ${controlRightY} ${startRightX} ${startRightY}`,
        'Z',
      ].join(' ');
    };
    const dotLeft = 176;
    const dotTop = 96;
    const availableDotWidth = Math.max(560, (containerRef.current?.clientWidth || 900) - 56);
    const colW = routeLabels.length
      ? Math.max(34, Math.min(58, Math.floor((availableDotWidth - dotLeft - 150) / routeLabels.length)))
      : 58;
    const rowH = Math.max(18, Math.min(24, Math.floor((520 - dotTop - 78) / Math.max(dotRows.length, 1))));
    const pValueRadius = (pValue) => {
      const p = Number.isFinite(Number(pValue)) ? Number(pValue) : 1;
      if (p <= 0.01) return Math.max(5.5, Math.min(8.5, rowH * 0.36));
      if (p <= 0.05) return Math.max(4, Math.min(6.5, rowH * 0.28));
      return Math.max(2.2, Math.min(3.5, rowH * 0.15));
    };
    const probGradientId = `spatial-cci-prob-gradient-${Math.round(maxProb * 1e6)}-${routeLabels.length}-${dotRows.length}`;
    const gridWidth = routeLabels.length * colW;
    const gridHeight = dotRows.length * rowH;
    const dotWidth = Math.max(560, dotLeft + routeLabels.length * colW + 150);
    const dotHeight = Math.max(300, dotTop + dotRows.length * rowH + 82);

    return (
      <div className="spatial-cci-results">
        <div className="markers-summary">
          <div>
            <h3>Spatial cell-cell interaction</h3>
            <p className="markers-subtitle">
              {interactions.length} ligand-receptor interactions across {regions.length} selected regions.
            </p>
          </div>
        </div>
        <div className="spatial-cci-scroll">
          <svg
            width={dotWidth}
            height={dotHeight}
            className="spatial-cci-dotplot"
            onContextMenu={(event) => {
              event.preventDefault();
              downloadSvgAsHighResPng(event.currentTarget, 'spatial-cell-cell-interaction-dotplot', 4);
            }}
          >
            <defs>
              <linearGradient id={probGradientId} x1="0%" x2="0%" y1="100%" y2="0%">
                {[0, 0.2, 0.4, 0.6, 0.8, 1].map(level => (
                  <stop
                    key={level}
                    offset={`${level * 100}%`}
                    stopColor={d3.interpolateSpectral(1 - level)}
                  />
                ))}
              </linearGradient>
            </defs>
            <g transform={`translate(${dotLeft},${dotTop})`}>
              <rect
                className="spatial-cci-grid-frame"
                x="0"
                y={-rowH / 2}
                width={gridWidth}
                height={gridHeight}
              />
              {routeLabels.map((label, idx) => (
                <line
                  key={`vgrid-${label}`}
                  className="spatial-cci-grid-line"
                  x1={idx * colW}
                  x2={idx * colW}
                  y1={-rowH / 2}
                  y2={gridHeight - rowH / 2}
                />
              ))}
              <line
                className="spatial-cci-grid-line"
                x1={gridWidth}
                x2={gridWidth}
                y1={-rowH / 2}
                y2={gridHeight - rowH / 2}
              />
              {dotRows.map((item, idx) => (
                <line
                  key={`hgrid-${idx}`}
                  className="spatial-cci-grid-line"
                  x1="0"
                  x2={gridWidth}
                  y1={idx * rowH - rowH / 2}
                  y2={idx * rowH - rowH / 2}
                />
              ))}
              <line
                className="spatial-cci-grid-line"
                x1="0"
                x2={gridWidth}
                y1={gridHeight - rowH / 2}
                y2={gridHeight - rowH / 2}
              />
              {routeLabels.map((label, idx) => (
                <text
                  key={label}
                  className="spatial-cci-axis-label"
                  x={idx * colW + colW / 2}
                  y={-34}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(-45 ${idx * colW + colW / 2} -34)`}
                >
                  {label}
                </text>
              ))}
              {dotRows.map((item, idx) => (
                <text key={`${item.pair}-${idx}`} className="spatial-cci-pair-label" x={-14} y={idx * rowH + 4} textAnchor="end">{item.pair}</text>
              ))}
              {dotRows.map((item, yIdx) => routeLabels.map((route, xIdx) => {
                if (routeLabelFor(item) !== route) return null;
                return (
                  <circle
                    key={`${item.pair}-${route}-${yIdx}`}
                    cx={xIdx * colW + colW / 2}
                    cy={yIdx * rowH}
                    r={pValueRadius(item.p_value)}
                    fill={communicationColor(item.probability)}
                    opacity="0.9"
                  />
                );
              }))}
              <text className="spatial-cci-legend-title" x={routeLabels.length * colW + 18} y={8}>Commun. Prob.</text>
              <rect
                x={routeLabels.length * colW + 24}
                y="26"
                width="12"
                height="74"
                fill={`url(#${probGradientId})`}
                stroke="#d1d5db"
                strokeWidth="0.8"
              />
              <text className="spatial-cci-legend-label" x={routeLabels.length * colW + 46} y={34}>max</text>
              <text className="spatial-cci-legend-label" x={routeLabels.length * colW + 46} y={102}>min</text>
              <text className="spatial-cci-legend-title" x={routeLabels.length * colW + 18} y={134}>p-value</text>
              <circle cx={routeLabels.length * colW + 30} cy={160} r={pValueRadius(0.2)} fill="#111827" />
              <circle cx={routeLabels.length * colW + 30} cy={188} r={pValueRadius(0.01)} fill="#111827" />
              <text className="spatial-cci-legend-label" x={routeLabels.length * colW + 50} y={165}>p &gt; 0.05</text>
              <text className="spatial-cci-legend-label" x={routeLabels.length * colW + 50} y={193}>p ≤ 0.01</text>
            </g>
          </svg>
        </div>
        <div className="spatial-cci-network-wrap">
          <svg width="620" height="500" viewBox="-250 -230 500 430" className="spatial-cci-network">
            <text className="spatial-cci-network-title" x="0" y="-196" textAnchor="middle">
              Interaction weights/strength
            </text>
            {networkEdges.map((edge, idx) => (
              <path
                key={`${edge.source.id}-${edge.target.id}-${idx}`}
                d={arrowRibbonPath(edge)}
                fill={color(edge.source.id)}
                fillOpacity={0.28 + 0.42 * Math.sqrt(edge.level)}
                stroke={color(edge.source.id)}
                strokeOpacity={0.5}
                strokeWidth="0.8"
              />
            ))}
            {networkNodes.map(node => (
              <g key={node.id}>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.radius}
                  fill={color(node.id)}
                  stroke="#fff"
                  strokeWidth="2.5"
                />
                <text
                  className="spatial-cci-network-label"
                  x={Math.cos(node.angle) * (networkRadius + 34)}
                  y={Math.sin(node.angle) * (networkRadius + 34)}
                  textAnchor={Math.cos(node.angle) > 0.2 ? 'start' : Math.cos(node.angle) < -0.2 ? 'end' : 'middle'}
                  dominantBaseline="middle"
                >
                  {node.shortLabel}
                </text>
              </g>
            ))}
            <g transform="translate(128,-168)">
              <text className="spatial-cci-legend-title spatial-cci-strength-legend-title" x="0" y="-12">Strength</text>
              {[0.25, 0.65, 1].map((level, idx) => (
                <line
                  key={level}
                  x1="0"
                  x2="34"
                  y1={idx * 18}
                  y2={idx * 18}
                  stroke="#64748b"
                  strokeLinecap="round"
                  strokeWidth={0.8 + 5.2 * Math.sqrt(level)}
                  opacity={0.24 + 0.46 * Math.sqrt(level)}
                />
              ))}
              <text className="spatial-cci-legend-label spatial-cci-strength-legend-label" x="42" y="4">low</text>
              <text className="spatial-cci-legend-label spatial-cci-strength-legend-label" x="42" y="40">high</text>
            </g>
          </svg>
        </div>
      </div>
    );
  };

  const showPeaksOnGene =
    resolvedResults?.type === 'gene_expression' &&
    Array.isArray(resolvedResults.peaksOnGene) &&
    resolvedResults.peaksOnGene.length > 0;

  const isAtacOrMultiomeGene =
    resolvedResults?.type === 'gene_expression' &&
    (resolvedResults.isAtac === true || resolvedResults.multiomeModality === 'atac');
  const isGeneExpressionWithNoPeaks =
    isAtacOrMultiomeGene &&
    (!Array.isArray(resolvedResults.peaksOnGene) || resolvedResults.peaksOnGene.length === 0);

  const isRnaGeneExpression =
    resolvedResults?.type === 'gene_expression' &&
    Array.isArray(resolvedResults.coordinates) &&
    resolvedResults.coordinates.length > 0 &&
    !resolvedResults.isAtac &&
    resolvedResults.multiomeModality !== 'atac';
  const isSpatialCellInteraction =
    resolvedResults?.type === 'spatial_cell_interaction';

  return (
    <div className="plot-view" ref={containerRef}>
      <div className={`plot-view-content${showPeaksOnGene ? ' plot-view-content-peak-view' : ''}${(resolvedResults?.type === 'umap' || isRnaGeneExpression) ? ' plot-view-content-deck' : ''}${isSpatialCellInteraction ? ' plot-view-content-spatial-cci' : ''}`}>
        {resolvedResults ? (
          resolvedResults.type === 'tf_motif_enrichment' ? (
            <div style={{ overflowY: 'auto', height: '100%', padding: '4px 0' }}>
              <TfMotifPlot
                cluster={resolvedResults.cluster}
                results={resolvedResults.results || []}
                topMarkers={resolvedResults.topMarkers || []}
                nQueryPeaks={resolvedResults.nQueryPeaks || 0}
                nBgPeaks={resolvedResults.nBgPeaks || 0}
                genome={resolvedResults.genome || null}
              />
            </div>
          ) : resolvedResults.type === 'peak_gene_links' ? (
            <div style={{ overflowY: 'auto', overflowX: 'auto', height: '100%' }}>
              <PeakGeneLinkPlot
                gene={resolvedResults.gene}
                links={resolvedResults.links || []}
                coverageByCluster={resolvedResults.coverageByCluster || []}
                region={resolvedResults.region || null}
                peaksOnGene={resolvedResults.peaksOnGene || null}
                genome={resolvedResults.genome || null}
                clusterColorOverrides={clusterColorOverrides}
                clusterLabelMap={clusterLabelMap}
                width={Math.max(600, (containerRef.current?.clientWidth || 800) - 24)}
              />
            </div>
          ) : resolvedResults.type === 'region_composition' ? (
            renderRegionComposition(resolvedResults)
          ) : resolvedResults.type === 'spatial_cell_interaction' ? (
            renderSpatialCellInteraction(resolvedResults)
          ) : resolvedResults.type === 'cell_fraction' ? (
            renderCellFraction(resolvedResults)
          ) : resolvedResults.type === 'deg_between_samples' ? (
            renderDegBetweenSamples(resolvedResults)
          ) : resolvedResults.type === 'markers' ? (
            renderMarkersTable(resolvedResults)
          ) : resolvedResults.type === 'cluster_annotation' ? (
            renderClusterAnnotationTable(resolvedResults)
          ) : resolvedResults.type === 'umap' ? (
            <UmapDeckView
              coordinates={resolvedResults.coordinates}
              clusters={resolvedResults.clusters}
              clusterColorDomain={resolvedResults.clusterColorDomain}
              selectedClusters={selectedClusters}
              onSelectClusters={onSelectClusters}
              clusterColorOverrides={clusterColorOverrides}
              clusterLabelMap={clusterLabelMap}
              onChangeClusterColor={onChangeClusterColor}
              geneExpression={resolvedGeneExpression?.type === 'gene_expression' ? resolvedGeneExpression : null}
              rnaClustersForAtacHighlight={rnaClustersForAtacHighlight}
              rnaClusterHighlightOnAtac={rnaClusterHighlightOnAtac}
              atacClustersForRnaHighlight={atacClustersForRnaHighlight}
              atacClusterHighlightOnRna={atacClusterHighlightOnRna}
              legendHighlightSelection={legendHighlightSelection}
              onLegendClusterClick={onLegendClusterClick}
              onClearLegendHighlight={onClearLegendHighlight}
              viewModality={viewModality}
              otherModalityClusters={otherModalityClusters}
              cellBarcodes={cellBarcodes}
              otherModalityCellBarcodes={otherModalityCellBarcodes}
              highlightCellMask={highlightCellMask}
            />
          ) : showPeaksOnGene ? (
            renderPeaksOnGeneTrack(resolvedResults)
          ) : isGeneExpressionWithNoPeaks ? (
            (() => {
              const emptyGeneDisplay = formatGeneNameForDisplay(resolvedResults.geneName || 'gene', resolvedResults.genome);
              return (
            <div className="peaks-on-gene-wrapper peaks-on-gene-empty">
              <div className="peaks-on-gene-header">
                <h3>Peaks on {emptyGeneDisplay}</h3>
              </div>
              <div className="peaks-on-gene-empty-message">
                <Icon icon="info-sign" size={32} color="#8a9ba8" />
                <p>No peaks linked to <strong>{emptyGeneDisplay}</strong> in the peak annotation.</p>
                <p className="peaks-on-gene-empty-hint">Gene activity is still shown on the UMAP. Peak View requires peaks in <code>peak_annotation.tsv</code> whose <em>gene</em> column matches the gene symbol (e.g. MS4A1).</p>
              </div>
            </div>
              );
            })()
          ) : isRnaGeneExpression ? (
            <UmapDeckView
              coordinates={resolvedResults.coordinates}
              clusters={resolvedResults.clusters || []}
              clusterColorDomain={resolvedResults.clusterColorDomain}
              selectedClusters={selectedClusters}
              onSelectClusters={onSelectClusters}
              clusterColorOverrides={clusterColorOverrides}
              clusterLabelMap={clusterLabelMap}
              onChangeClusterColor={onChangeClusterColor}
              geneExpression={resolvedResults}
              rnaClustersForAtacHighlight={rnaClustersForAtacHighlight}
              rnaClusterHighlightOnAtac={rnaClusterHighlightOnAtac}
              atacClustersForRnaHighlight={atacClustersForRnaHighlight}
              atacClusterHighlightOnRna={atacClusterHighlightOnRna}
              legendHighlightSelection={legendHighlightSelection}
              onLegendClusterClick={onLegendClusterClick}
              onClearLegendHighlight={onClearLegendHighlight}
              viewModality={viewModality}
              otherModalityClusters={otherModalityClusters}
              cellBarcodes={cellBarcodes}
              otherModalityCellBarcodes={otherModalityCellBarcodes}
              highlightCellMask={highlightCellMask}
            />
          ) : (
            <svg ref={svgRef}></svg>
          )
        ) : (
          <div className="plot-placeholder">
            <Icon icon="chart" size={48} color="#ccc" />
            <p>No plot yet. Load data and run analysis to see visualizations here.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default PlotView;
