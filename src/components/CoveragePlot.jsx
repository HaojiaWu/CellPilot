import React, { useEffect, useRef, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import { formatGeneNameForDisplay } from '../utils/geneNameFormat';
import './CoveragePlot.css';

const basePalette = [
  ...d3.schemeCategory10,
  ...(d3.schemeSet3 || []),
  ...(d3.schemePaired || []),
  ...(d3.schemeDark2 || []),
  ...(d3.schemePastel1 || []),
  ...(d3.schemePastel2 || []),
];

const ensurePaletteLength = (targetSize) => {
  if (targetSize <= basePalette.length) return basePalette.slice(0, targetSize);
  const palette = basePalette.slice();
  const needed = targetSize - palette.length;
  const extras = d3.quantize(d3.interpolateTurbo, needed + 2).slice(1, needed + 1);
  return palette.concat(extras);
};

const formatLabel = (label, clusterId, clusterLabelMap = {}) => {
  const key = String(clusterId ?? label).trim();
  if (clusterLabelMap[key]) return clusterLabelMap[key];
  const numericMatch = String(label).match(/-?\d+(?:\.\d+)?/);
  return numericMatch ? numericMatch[0] : (label || key).replace(/^cluster\s*/i, '').trim() || key;
};

const CoveragePlot = ({
  region,
  coverageByCluster = [],
  peaksOnGene = [],
  geneName = 'gene',
  genome,
  clusterColorOverrides = {},
  clusterLabelMap = {},
  maxClusters = 20,
  globalYMax: externalGlobalYMax = null,
  sortClustersByAbundance = true,
  scrollSyncGroupRef = null,
  scrollSyncIndex = null,
}) => {
  const wrapperRef = useRef(null);
  const headerRef = useRef(null);
  const bodyRef = useRef(null);

  useEffect(() => {
    if (scrollSyncGroupRef == null || scrollSyncIndex == null) return;
    const el = bodyRef.current;
    if (!el) return;
    const group = scrollSyncGroupRef.current;
    if (!group || !group.containers) return;
    group.containers[scrollSyncIndex] = el;
    const handleScroll = () => {
      if (group.syncing) return;
      group.syncing = true;
      const left = el.scrollLeft;
      const top = el.scrollTop;
      requestAnimationFrame(() => {
        for (const key of Object.keys(group.containers)) {
          if (Number(key) !== scrollSyncIndex) {
            const other = group.containers[key];
            if (other && other !== el) {
              other.scrollLeft = left;
              other.scrollTop = top;
            }
          }
        }
        requestAnimationFrame(() => { group.syncing = false; });
      });
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      delete group.containers[scrollSyncIndex];
    };
  }, [scrollSyncGroupRef, scrollSyncIndex, coverageByCluster?.length]);

  const { sortedClusters, globalMax } = useMemo(() => {
    if (!coverageByCluster?.length) return { sortedClusters: [], globalMax: 1 };

    const labelGroups = new Map();
    for (const cluster of coverageByCluster) {
      const displayLabel = formatLabel(cluster.label, cluster.clusterId, clusterLabelMap);
      if (!labelGroups.has(displayLabel)) labelGroups.set(displayLabel, []);
      labelGroups.get(displayLabel).push(cluster);
    }

    const baseClusters = [];
    for (const [displayLabel, group] of labelGroups) {
      if (group.length === 1) {
        baseClusters.push(group[0]);
      } else {
        const totalCells = group.reduce((sum, c) => sum + (c.cellCount || 0), 0);
        const signalLength = group[0].signal?.length || 0;
        const mergedSignal = [];
        for (let i = 0; i < signalLength; i++) {
          const ref = group[0].signal[i];
          let weightedSum = 0;
          for (const c of group) {
            weightedSum += (Number(c.signal?.[i]?.value) || 0) * (c.cellCount || 0);
          }
          mergedSignal.push({
            start: ref.start,
            end: ref.end,
            value: totalCells > 0 ? weightedSum / totalCells : 0,
          });
        }
        baseClusters.push({
          clusterId: group[0].clusterId,
          label: displayLabel,
          cellCount: totalCells,
          signal: mergedSignal,
        });
      }
    }

    const clustersWithTotal = baseClusters.map(cluster => {
      const signal = cluster.signal || [];
      const totalSignal = signal.reduce((sum, s) => sum + (Number(s.value) || 0), 0);
      return { ...cluster, totalSignal };
    });

    let yMax = 1;
    if (externalGlobalYMax != null && Number(externalGlobalYMax) > 0) {
      yMax = Number(externalGlobalYMax);
    } else {
      const allValues = [];
      for (const cluster of clustersWithTotal) {
        for (const s of cluster.signal || []) {
          const v = Number(s.value) || 0;
          if (v > 0) allValues.push(v);
        }
      }
      allValues.sort((a, b) => a - b);
      const rawMax = allValues.length > 0 ? allValues[allValues.length - 1] : 1;
      yMax = rawMax > 0 ? parseFloat(rawMax.toPrecision(2)) : 1;
    }

    for (const cluster of clustersWithTotal) {
      for (const s of cluster.signal || []) {
        const v = Number(s.value) || 0;
        if (v > yMax) s.value = yMax;
      }
    }

    const sorted = [...clustersWithTotal]
      .sort((a, b) => {
        if (sortClustersByAbundance) return b.totalSignal - a.totalSignal;
        const idA = a.clusterId;
        const idB = b.clusterId;
        const numA = Number(idA);
        const numB = Number(idB);
        if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
        return String(idA).localeCompare(String(idB));
      })
      .slice(0, maxClusters);

    return {
      sortedClusters: sorted,
      globalMax: yMax
    };
  }, [coverageByCluster, maxClusters, clusterLabelMap, externalGlobalYMax, sortClustersByAbundance]);

  const colorScale = useMemo(() => {
    if (!sortedClusters.length) return null;
    const allClusterIds = coverageByCluster.map(c => c.clusterId);
    const sortedIds = [...new Set(allClusterIds)].sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
      return String(a).localeCompare(String(b));
    });
    const palette = ensurePaletteLength(sortedIds.length);
    return d3.scaleOrdinal(palette).domain(sortedIds.map(String));
  }, [coverageByCluster, sortedClusters]);

  const getColor = useCallback(
    (clusterId) => clusterColorOverrides[String(clusterId)] || (colorScale ? colorScale(String(clusterId)) : '#5c7080'),
    [clusterColorOverrides, colorScale]
  );

  const displayGeneName = useMemo(
    () => formatGeneNameForDisplay(geneName, genome),
    [geneName, genome]
  );

  useEffect(() => {
    const headerEl = headerRef.current;
    const bodyEl = bodyRef.current;
    const wrapperEl = wrapperRef.current;
    if (!headerEl || !bodyEl || !wrapperEl || !region?.chrom || !sortedClusters.length) return;

    d3.select(headerEl).selectAll('*').remove();
    d3.select(bodyEl).selectAll('*').remove();

    const chrom = String(region.chrom);
    const regionStart = Number(region.start) || 0;
    const regionEnd = Number(region.end) || regionStart + 1;

    const margin = { top: 50, right: 20, bottom: 20, left: 60 };
    const trackHeight = 45;
    const trackSpacing = 2;
    const geneTrackHeight = 30;
    const peakTrackHeight = 20;
    const numTracks = sortedClusters.length;
    const totalTrackHeight = numTracks * (trackHeight + trackSpacing);
    const minPlotWidth = 1000;
    const width = Math.max(wrapperEl.clientWidth || 700, minPlotWidth, 700);

    const xScale = d3.scaleLinear()
      .domain([regionStart, regionEnd])
      .range([margin.left, width - margin.right]);

    const trackLabelWidth = 52;
    const headerTop = 8;
    const xAxisY = headerTop + 18;
    const peakTrackY = xAxisY + 14;
    const geneTrackY = peakTrackY + peakTrackHeight + 6;
    const headerHeight = geneTrackY + geneTrackHeight + 12;

    const headerSvg = d3.select(headerEl)
      .append('svg')
      .attr('width', width)
      .attr('height', headerHeight)
      .attr('class', 'coverage-plot-svg coverage-plot-header-svg');

    const coordLabel = `${chrom.toUpperCase().replace(/^CHR/i, 'CHR')}_${regionStart}_${regionEnd}`;

    const xAxis = d3.axisTop(xScale)
      .ticks(6)
      .tickFormat((d) => `${(d / 1000000).toFixed(2)} Mb`);
    headerSvg.append('g')
      .attr('transform', `translate(0, ${xAxisY})`)
      .attr('class', 'x-axis-top')
      .call(xAxis)
      .selectAll('text')
      .attr('font-size', '9px')
      .attr('fill', '#555');

    headerSvg.append('rect')
      .attr('x', 4)
      .attr('y', peakTrackY - 2)
      .attr('width', trackLabelWidth)
      .attr('height', peakTrackHeight + 4)
      .attr('fill', '#e8ecf0')
      .attr('stroke', '#c5cdd9')
      .attr('stroke-width', 0.5);
    headerSvg.append('text')
      .attr('x', 4 + trackLabelWidth / 2)
      .attr('y', peakTrackY + peakTrackHeight / 2)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', '10px')
      .attr('font-weight', '600')
      .attr('fill', '#333')
      .text('PEAKS');

    headerSvg.append('rect')
      .attr('x', margin.left)
      .attr('y', peakTrackY)
      .attr('width', width - margin.left - margin.right)
      .attr('height', peakTrackHeight)
      .attr('fill', '#fff')
      .attr('stroke', '#dee2e6')
      .attr('stroke-width', 0.5);

    if (peaksOnGene && peaksOnGene.length > 0) {
      peaksOnGene.forEach(peak => {
        const peakStart = Number(peak.start);
        const peakEnd = Number(peak.end);
        if (peakStart >= regionStart && peakEnd <= regionEnd) {
          headerSvg.append('rect')
            .attr('x', xScale(peakStart))
            .attr('y', peakTrackY + 3)
            .attr('width', Math.max(xScale(peakEnd) - xScale(peakStart), 2))
            .attr('height', peakTrackHeight - 6)
            .attr('fill', '#1e3a5f')
            .attr('rx', 1);
        }
      });
    }

    headerSvg.append('rect')
      .attr('x', 4)
      .attr('y', geneTrackY - 2)
      .attr('width', trackLabelWidth)
      .attr('height', geneTrackHeight + 4)
      .attr('fill', '#e8ecf0')
      .attr('stroke', '#c5cdd9')
      .attr('stroke-width', 0.5);
    headerSvg.append('text')
      .attr('x', 4 + trackLabelWidth / 2)
      .attr('y', geneTrackY + geneTrackHeight / 2)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', '9px')
      .attr('font-weight', '600')
      .attr('fill', '#333')
      .text('Gene');

    headerSvg.append('rect')
      .attr('x', margin.left)
      .attr('y', geneTrackY)
      .attr('width', width - margin.left - margin.right)
      .attr('height', geneTrackHeight)
      .attr('fill', '#f8f9fa')
      .attr('stroke', '#dee2e6')
      .attr('stroke-width', 0.5);

    const geneBodyY = geneTrackY + geneTrackHeight / 2;
    headerSvg.append('text')
      .attr('x', margin.left + 8)
      .attr('y', geneBodyY)
      .attr('dominant-baseline', 'middle')
      .attr('font-size', '11px')
      .attr('font-weight', '600')
      .attr('fill', '#1e3a5f')
      .text(`${displayGeneName}  ${coordLabel}`);

    const bodyMarginTop = 0;
    const bodyHeight = bodyMarginTop + totalTrackHeight + margin.bottom;
    const bodySvg = d3.select(bodyEl)
      .append('svg')
      .attr('width', width)
      .attr('height', bodyHeight)
      .attr('class', 'coverage-plot-svg coverage-plot-body-svg');

    const yMax = globalMax;
    const tracksStartY = bodyMarginTop;

    sortedClusters.forEach((cluster, idx) => {
      const trackY = tracksStartY + idx * (trackHeight + trackSpacing);
      const color = getColor(cluster.clusterId);
      const label = formatLabel(cluster.label, cluster.clusterId, clusterLabelMap);

      const yScale = d3.scaleLinear()
        .domain([0, yMax])
        .range([trackY + trackHeight, trackY]);

      const bgColor = d3.color(color);
      if (bgColor) bgColor.opacity = 0.05;

      bodySvg.append('rect')
        .attr('x', margin.left)
        .attr('y', trackY)
        .attr('width', width - margin.left - margin.right)
        .attr('height', trackHeight)
        .attr('fill', bgColor ? bgColor.toString() : '#fafafa')
        .attr('stroke', '#e5e7eb')
        .attr('stroke-width', 0.5);

      const sortedSignal = [...(cluster.signal || [])].sort((a, b) => a.start - b.start);
      if (sortedSignal.length > 0) {
        const areaData = sortedSignal.map((d) => ({
          x: (d.start + d.end) / 2,
          y: Math.min(Number(d.value) || 0, yMax),
        }));

        const clipId = `clip-track-${idx}`;
        bodySvg.append('defs').append('clipPath')
          .attr('id', clipId)
          .append('rect')
          .attr('x', margin.left)
          .attr('y', trackY)
          .attr('width', width - margin.left - margin.right)
          .attr('height', trackHeight);

        const areaGen = d3.area()
          .x((d) => xScale(d.x))
          .y0(trackY + trackHeight)
          .y1((d) => yScale(Math.max(d.y, 0)))
          .curve(d3.curveBasis);

        bodySvg.append('path')
          .datum(areaData)
          .attr('d', areaGen)
          .attr('fill', color)
          .attr('opacity', 0.85)
          .attr('clip-path', `url(#${clipId})`);
      }

      const yMaxLabel = yMax >= 1 ? Math.round(yMax) : yMax.toFixed(2);
      bodySvg.append('text')
        .attr('x', margin.left - 3)
        .attr('y', trackY + 8)
        .attr('text-anchor', 'end')
        .attr('font-size', '8px')
        .attr('fill', '#9ca3af')
        .text(yMaxLabel);
      bodySvg.append('text')
        .attr('x', margin.left - 3)
        .attr('y', trackY + trackHeight - 2)
        .attr('text-anchor', 'end')
        .attr('font-size', '8px')
        .attr('fill', '#9ca3af')
        .text('0');

      const labelBoxWidth = 45;
      const labelBoxHeight = 20;
      const labelBoxX = 5;
      const labelBoxY = trackY + (trackHeight - labelBoxHeight) / 2;

      bodySvg.append('rect')
        .attr('x', labelBoxX)
        .attr('y', labelBoxY)
        .attr('width', labelBoxWidth)
        .attr('height', labelBoxHeight)
        .attr('fill', color)
        .attr('rx', 3);
      bodySvg.append('text')
        .attr('x', labelBoxX + labelBoxWidth / 2)
        .attr('y', labelBoxY + labelBoxHeight / 2)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('font-size', '11px')
        .attr('font-weight', '600')
        .attr('fill', '#fff')
        .text(label);
    });

    bodyEl.scrollTop = 0;
  }, [region, sortedClusters, peaksOnGene, displayGeneName, clusterLabelMap, colorScale, getColor, globalMax]);

  const handleExport = useCallback(() => {
    const headerSvg = headerRef.current?.querySelector('svg');
    const bodySvg = bodyRef.current?.querySelector('svg');
    if (!headerSvg || !bodySvg) return;

    const headerW = +headerSvg.getAttribute('width');
    const headerH = +headerSvg.getAttribute('height');
    const bodyW = +bodySvg.getAttribute('width');
    const bodyH = +bodySvg.getAttribute('height');

    const totalW = Math.max(headerW, bodyW);
    const titleBlockH = 60;
    const totalH = titleBlockH + headerH + bodyH;

    const canvas = document.createElement('canvas');
    const scale = 2;
    canvas.width = totalW * scale;
    canvas.height = totalH * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, totalW, totalH);

    const gLabel = (genome && String(genome).trim()) || 'hg38';
    ctx.fillStyle = '#333';
    ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(`${displayGeneName} Peak Coverage`, 12, 24);
    ctx.fillStyle = '#666';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(
      `${gLabel} · ${sortedClusters.length} clusters · normalized per cell · sorted by specificity · range 0–${globalMax >= 1 ? Math.round(globalMax) : globalMax.toFixed(2)}`,
      12, 44
    );

    const drawSvg = (svgEl, yOffset) => new Promise((resolve) => {
      const clone = svgEl.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, yOffset);
        URL.revokeObjectURL(url);
        resolve();
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      img.src = url;
    });

    drawSvg(headerSvg, titleBlockH)
      .then(() => drawSvg(bodySvg, titleBlockH + headerH))
      .then(() => {
        canvas.toBlob((blob) => {
          if (!blob) return;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${displayGeneName}_coverage.png`;
          a.click();
          URL.revokeObjectURL(a.href);
        }, 'image/png');
      });
  }, [displayGeneName, genome, sortedClusters.length, globalMax]);

  if (!region?.chrom || !sortedClusters.length) {
    return null;
  }

  const genomeLabel = (genome && String(genome).trim()) || 'hg38';

  const minPlotWidth = 1000;
  return (
    <div ref={wrapperRef} className="coverage-plot-wrapper" style={{ minWidth: minPlotWidth }}>
      <div className="coverage-plot-header">
        <h3>
          {displayGeneName} Peak Coverage
          <button
            className="coverage-export-btn"
            onClick={handleExport}
            title="Export as PNG"
          >
            ⬇ Export
          </button>
        </h3>
        <p className="coverage-plot-subtitle">
          {genomeLabel} · {sortedClusters.length} clusters · normalized per cell · sorted by specificity · range 0–{globalMax >= 1 ? Math.round(globalMax) : globalMax.toFixed(2)}
        </p>
      </div>
      <div ref={headerRef} className="coverage-plot-header-tracks" />
      <div ref={bodyRef} className="coverage-plot-container" />
    </div>
  );
};

export default CoveragePlot;
