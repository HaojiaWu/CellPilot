/**
 * PeakGeneLinkPlot, Signac-style coverage + arc link visualization.
 *
 * Layout (top → bottom):
 *   1. Per-cluster ATAC coverage tracks (smooth area curves, like CoveragePlot)
 *   2. Peaks track, dark bars for each peak in the region
 *   3. Gene track, gene name + region label
 *   4. Links track, arcs from each linked peak to the gene TSS,
 *      coloured by correlation score (gradient purple→blue like Signac)
 *   5. Genomic axis
 *
 * Props:
 *   gene               string    gene name
 *   links              Array     output of linkPeaks() filtered to this gene
 *   coverageByCluster  Array     [{clusterId, label, cellCount, signal:[{start,end,value}]}]
 *   region             object    {chrom, start, end}
 *   peaksOnGene        Array     [{chrom, start, end, peakName}]
 *   genome             string    e.g. 'hg38'
 *   clusterColorOverrides object clusterId → hex color
 *   clusterLabelMap    object    clusterId → display label
 *   width              number    SVG width in px
 */

import React, { useCallback, useEffect, useRef, useMemo } from 'react';
import * as d3 from 'd3';

const basePalette = [
  ...d3.schemeCategory10,
  ...(d3.schemeSet3 || []),
  ...(d3.schemePaired || []),
  ...(d3.schemeDark2 || []),
];

const ensurePaletteLength = (n) => {
  if (n <= basePalette.length) return basePalette.slice(0, n);
  return basePalette.concat(d3.quantize(d3.interpolateTurbo, n - basePalette.length + 2).slice(1));
};


export default function PeakGeneLinkPlot({
  gene,
  links = [],
  coverageByCluster = [],
  region: externalRegion = null,
  peaksOnGene: externalPeaks = null,
  genome = null,
  clusterColorOverrides = {},
  clusterLabelMap = {},
  width: externalWidth = null,
}) {
  const wrapperRef = useRef(null);
  const svgRef = useRef(null);

  // Derive region from links if not provided
  const region = useMemo(() => {
    if (externalRegion) return externalRegion;
    if (!links.length) return null;
    const chr = links[0].chr;
    const tss = links[0].tss;
    const minStart = Math.min(tss, ...links.map(l => l.peakStart));
    const maxEnd = Math.max(tss, ...links.map(l => l.peakEnd));
    return { chrom: chr, start: Math.max(0, minStart - 5000), end: maxEnd + 5000 };
  }, [externalRegion, links]);

  // Filter and sort coverage
  const sortedClusters = useMemo(() => {
    if (!coverageByCluster?.length) return [];
    return [...coverageByCluster]
      .sort((a, b) => (b.cellCount || 0) - (a.cellCount || 0))
      .slice(0, 12);
  }, [coverageByCluster]);

  // Color scale
  const colorScale = useMemo(() => {
    if (!sortedClusters.length) return null;
    const ids = [...new Set(sortedClusters.map(c => c.clusterId))].sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
    return d3.scaleOrdinal(ensurePaletteLength(ids.length)).domain(ids.map(String));
  }, [sortedClusters]);

  const getColor = useCallback(
    (cid) => clusterColorOverrides[String(cid)] || (colorScale ? colorScale(String(cid)) : '#5c7080'),
    [clusterColorOverrides, colorScale]
  );

  const getLabel = useCallback(
    (cluster) => {
      const key = String(cluster.clusterId ?? cluster.label).trim();
      if (clusterLabelMap[key]) return clusterLabelMap[key];
      const m = String(cluster.label).match(/-?\d+(?:\.\d+)?/);
      return m ? m[0] : (cluster.label || key).replace(/^cluster\s*/i, '').trim() || key;
    },
    [clusterLabelMap]
  );

  // Peaks from links or external
  const peaksOnGene = useMemo(() => {
    if (externalPeaks && externalPeaks.length > 0) return externalPeaks;
    return links.map(l => ({
      chrom: l.chr, start: l.peakStart, end: l.peakEnd, peakName: l.peak,
    }));
  }, [externalPeaks, links]);

  // Score range for link color scale
  const scoreExtent = useMemo(() => {
    if (!links.length) return [0, 1];
    const scores = links.map(l => Math.abs(l.score));
    return [0, Math.max(...scores, 0.1)];
  }, [links]);

  useEffect(() => {
    const container = wrapperRef.current;
    const svgEl = svgRef.current;
    if (!container || !svgEl || !region) return;

    d3.select(svgEl).selectAll('*').remove();

    const hasCoverage = sortedClusters.length > 0;
    const margin = { top: 10, right: 20, bottom: 28, left: 60 };
    const trackH = 40;
    const trackGap = 2;
    const peakTrackH = 18;
    const geneTrackH = 20;
    const linkTrackH = 70;
    const axisH = 20;

    const nTracks = sortedClusters.length;
    const coverageTotalH = hasCoverage ? nTracks * (trackH + trackGap) : 0;

    const totalH = margin.top
      + coverageTotalH
      + (hasCoverage ? 6 : 0) // gap after coverage
      + peakTrackH + 4
      + geneTrackH + 4
      + linkTrackH + 4
      + axisH
      + margin.bottom;

    const w = externalWidth || Math.max(container.clientWidth || 700, 600);
    d3.select(svgEl).attr('width', w).attr('height', totalH);

    const regionStart = Number(region.start);
    const regionEnd = Number(region.end);
    const chrom = String(region.chrom);

    const xScale = d3.scaleLinear()
      .domain([regionStart, regionEnd])
      .range([margin.left, w - margin.right]);

    let y = margin.top;

    // Coverage tracks
    if (hasCoverage) {
      let globalMax = 0;
      for (const c of sortedClusters) {
        for (const s of c.signal || []) {
          const v = Number(s.value) || 0;
          if (v > globalMax) globalMax = v;
        }
      }
      if (globalMax <= 0) globalMax = 1;
      const yMaxLabel = globalMax >= 1 ? Math.round(globalMax) : globalMax.toFixed(2);

      sortedClusters.forEach((cluster, idx) => {
        const trackY = y + idx * (trackH + trackGap);
        const color = getColor(cluster.clusterId);
        const label = getLabel(cluster);

        const yScale = d3.scaleLinear()
          .domain([0, globalMax])
          .range([trackY + trackH, trackY]);

        // Background
        const bg = d3.color(color);
        if (bg) bg.opacity = 0.04;
        d3.select(svgEl).append('rect')
          .attr('x', margin.left).attr('y', trackY)
          .attr('width', w - margin.left - margin.right).attr('height', trackH)
          .attr('fill', bg ? bg.toString() : '#fafafa')
          .attr('stroke', '#e5e7eb').attr('stroke-width', 0.5);

        // Area curve
        const sorted = [...(cluster.signal || [])].sort((a, b) => a.start - b.start);
        if (sorted.length > 0) {
          const data = sorted.map(d => ({
            x: (d.start + d.end) / 2,
            y: Math.min(Number(d.value) || 0, globalMax),
          }));
          const clipId = `clip-cov-${idx}`;
          d3.select(svgEl).append('defs').append('clipPath')
            .attr('id', clipId).append('rect')
            .attr('x', margin.left).attr('y', trackY)
            .attr('width', w - margin.left - margin.right).attr('height', trackH);

          const area = d3.area()
            .x(d => xScale(d.x))
            .y0(trackY + trackH)
            .y1(d => yScale(Math.max(d.y, 0)))
            .curve(d3.curveBasis);

          d3.select(svgEl).append('path')
            .datum(data).attr('d', area)
            .attr('fill', color).attr('opacity', 0.85)
            .attr('clip-path', `url(#${clipId})`);
        }

        // Y-axis labels
        if (idx === 0) {
          d3.select(svgEl).append('text')
            .attr('x', margin.left - 3).attr('y', trackY + 9)
            .attr('text-anchor', 'end').attr('font-size', '7px').attr('fill', '#9ca3af')
            .text(yMaxLabel);
        }
        d3.select(svgEl).append('text')
          .attr('x', margin.left - 3).attr('y', trackY + trackH - 2)
          .attr('text-anchor', 'end').attr('font-size', '7px').attr('fill', '#9ca3af')
          .text('0');

        // Cluster label
        const boxW = 42, boxH = 16;
        d3.select(svgEl).append('rect')
          .attr('x', 4).attr('y', trackY + (trackH - boxH) / 2)
          .attr('width', boxW).attr('height', boxH)
          .attr('fill', color).attr('rx', 3);
        d3.select(svgEl).append('text')
          .attr('x', 4 + boxW / 2).attr('y', trackY + trackH / 2)
          .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
          .attr('font-size', '9px').attr('font-weight', '600').attr('fill', '#fff')
          .text(label);
      });

      y += coverageTotalH + 6;
    }

    // Peaks track
    const peakY = y;
    d3.select(svgEl).append('rect')
      .attr('x', margin.left).attr('y', peakY)
      .attr('width', w - margin.left - margin.right).attr('height', peakTrackH)
      .attr('fill', '#fff').attr('stroke', '#dee2e6').attr('stroke-width', 0.5);
    d3.select(svgEl).append('text')
      .attr('x', 4 + 22).attr('y', peakY + peakTrackH / 2)
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
      .attr('font-size', '9px').attr('font-weight', '600').attr('fill', '#333')
      .text('Peaks');

    for (const peak of peaksOnGene) {
      const ps = Number(peak.start), pe = Number(peak.end);
      if (pe < regionStart || ps > regionEnd) continue;
      d3.select(svgEl).append('rect')
        .attr('x', xScale(Math.max(ps, regionStart)))
        .attr('y', peakY + 3)
        .attr('width', Math.max(xScale(Math.min(pe, regionEnd)) - xScale(Math.max(ps, regionStart)), 2))
        .attr('height', peakTrackH - 6)
        .attr('fill', '#1e3a5f').attr('rx', 1);
    }
    y = peakY + peakTrackH + 4;

    // Gene track
    const geneY = y;
    d3.select(svgEl).append('rect')
      .attr('x', margin.left).attr('y', geneY)
      .attr('width', w - margin.left - margin.right).attr('height', geneTrackH)
      .attr('fill', '#f8f9fa').attr('stroke', '#dee2e6').attr('stroke-width', 0.5);
    d3.select(svgEl).append('text')
      .attr('x', 4 + 22).attr('y', geneY + geneTrackH / 2)
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
      .attr('font-size', '9px').attr('font-weight', '600').attr('fill', '#333')
      .text('Gene');

    // Gene body: horizontal line from region start to end + TSS marker
    const tss = links.length > 0 ? links[0].tss : null;
    if (tss != null) {
      const tssX = xScale(tss);
      // Gene body line
      d3.select(svgEl).append('line')
        .attr('x1', margin.left + 4).attr('y1', geneY + geneTrackH / 2)
        .attr('x2', w - margin.right - 4).attr('y2', geneY + geneTrackH / 2)
        .attr('stroke', '#1e3a5f').attr('stroke-width', 1.5);
      // TSS triangle
      const triH = 6;
      d3.select(svgEl).append('polygon')
        .attr('points', `${tssX},${geneY + geneTrackH / 2 - triH} ${tssX - 4},${geneY + geneTrackH / 2 + triH} ${tssX + 4},${geneY + geneTrackH / 2 + triH}`)
        .attr('fill', '#1e3a5f');
      // Gene name
      d3.select(svgEl).append('text')
        .attr('x', tssX + 6).attr('y', geneY + 10)
        .attr('font-size', '10px').attr('font-weight', '600').attr('fill', '#1e3a5f')
        .text(gene);
    }
    y = geneY + geneTrackH + 4;

    // Links track (arcs)
    const linkY = y;
    d3.select(svgEl).append('rect')
      .attr('x', margin.left).attr('y', linkY)
      .attr('width', w - margin.left - margin.right).attr('height', linkTrackH)
      .attr('fill', '#fafafa').attr('stroke', '#dee2e6').attr('stroke-width', 0.5);
    d3.select(svgEl).append('text')
      .attr('x', 4 + 22).attr('y', linkY + linkTrackH / 2)
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
      .attr('font-size', '9px').attr('font-weight', '600').attr('fill', '#333')
      .text('Links');

    // Score color scale for arcs
    const linkColor = d3.scaleSequential(d3.interpolatePurples).domain([0, scoreExtent[1]]);

    if (tss != null) {
      const tssX = xScale(tss);
      // TSS vertical dashed line through links panel
      d3.select(svgEl).append('line')
        .attr('x1', tssX).attr('y1', linkY)
        .attr('x2', tssX).attr('y2', linkY + linkTrackH)
        .attr('stroke', '#999').attr('stroke-width', 0.8).attr('stroke-dasharray', '3,2');

      const sortedLinks = [...links].sort((a, b) => Math.abs(a.score) - Math.abs(b.score));
      for (const link of sortedLinks) {
        const peakMid = (link.peakStart + link.peakEnd) / 2;
        const x1 = xScale(peakMid);
        const x2 = tssX;
        if ((x1 < margin.left && x2 < margin.left) || (x1 > w - margin.right && x2 > w - margin.right)) continue;

        const absR = Math.abs(link.score);
        const strokeW = 1 + absR * 3;
        const arcDepth = 4 + absR * (linkTrackH - 12);
        const mx = (x1 + x2) / 2;
        // Arcs go upward from bottom of link panel
        const baseY = linkY + linkTrackH;
        const cpY = baseY - arcDepth;
        const pathD = `M ${x1} ${baseY} Q ${mx} ${cpY} ${x2} ${baseY}`;
        const arcColor = link.score >= 0 ? linkColor(absR) : '#d6604d';

        d3.select(svgEl).append('path')
          .attr('d', pathD)
          .attr('fill', 'none')
          .attr('stroke', arcColor)
          .attr('stroke-width', strokeW)
          .attr('stroke-opacity', 0.75)
          .attr('stroke-linecap', 'round')
          .append('title')
          .text(`${link.peak}  r=${link.score.toFixed(3)}  z=${link.zscore.toFixed(1)}  p=${link.pvalue.toExponential(1)}`);
      }
    }

    // Score legend (small)
    const legendX = w - margin.right - 80;
    const legendY2 = linkY + 6;
    const legendW = 60, legendH2 = 8;
    const defs = d3.select(svgEl).append('defs');
    const grad = defs.append('linearGradient').attr('id', 'link-score-grad');
    grad.append('stop').attr('offset', '0%').attr('stop-color', linkColor(0));
    grad.append('stop').attr('offset', '100%').attr('stop-color', linkColor(scoreExtent[1]));
    d3.select(svgEl).append('rect')
      .attr('x', legendX).attr('y', legendY2)
      .attr('width', legendW).attr('height', legendH2)
      .attr('fill', 'url(#link-score-grad)').attr('stroke', '#ccc').attr('stroke-width', 0.5);
    d3.select(svgEl).append('text')
      .attr('x', legendX).attr('y', legendY2 + legendH2 + 9)
      .attr('font-size', '7px').attr('fill', '#555').text('0.00');
    d3.select(svgEl).append('text')
      .attr('x', legendX + legendW).attr('y', legendY2 + legendH2 + 9)
      .attr('text-anchor', 'end').attr('font-size', '7px').attr('fill', '#555')
      .text(scoreExtent[1].toFixed(2));
    d3.select(svgEl).append('text')
      .attr('x', legendX + legendW / 2).attr('y', legendY2 - 2)
      .attr('text-anchor', 'middle').attr('font-size', '7px').attr('fill', '#555').text('score');

    y = linkY + linkTrackH + 4;

    // Genomic axis
    const axisY2 = y;
    const xAxis = d3.axisBottom(xScale)
      .ticks(6)
      .tickFormat(d => d >= 1e6 ? `${(d / 1e6).toFixed(1)} Mb` : `${(d / 1e3).toFixed(0)} kb`);
    d3.select(svgEl).append('g')
      .attr('transform', `translate(0, ${axisY2})`)
      .call(xAxis)
      .selectAll('text').attr('font-size', '8px').attr('fill', '#555');
    // Chromosome label
    d3.select(svgEl).append('text')
      .attr('x', (margin.left + w - margin.right) / 2)
      .attr('y', axisY2 + axisH + 2)
      .attr('text-anchor', 'middle').attr('font-size', '9px').attr('fill', '#555')
      .text(chrom);

  }, [region, sortedClusters, links, peaksOnGene, gene, scoreExtent, externalWidth,
      clusterColorOverrides, clusterLabelMap, colorScale, getColor, getLabel]);

  if (!region) {
    return (
      <div style={{ padding: 16, color: '#888', fontSize: 12 }}>
        No peak-gene links available for <strong>{gene}</strong>. Run LinkPeaks first.
      </div>
    );
  }

  return (
    <div ref={wrapperRef} style={{ width: '100%', overflowX: 'auto', fontFamily: 'sans-serif' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, padding: '4px 8px', color: '#222' }}>
        Peak–gene links: <span style={{ color: '#2166ac' }}>{gene}</span>
        <span style={{ fontSize: 10, fontWeight: 400, marginLeft: 8, color: '#777' }}>
          {region.chrom}:{(region.start || 0).toLocaleString()}–{(region.end || 0).toLocaleString()}
          &nbsp;·&nbsp;{links.length} link{links.length !== 1 ? 's' : ''}
        </span>
      </div>
      <svg ref={svgRef} style={{ display: 'block' }} />
      {links.length > 0 && (
        <details style={{ margin: '4px 8px 8px', fontSize: 10 }}>
          <summary style={{ cursor: 'pointer', color: '#555' }}>
            Show link table ({links.length} links)
          </summary>
          <table style={{ fontSize: 10, borderCollapse: 'collapse', marginTop: 4, width: '100%' }}>
            <thead>
              <tr style={{ background: '#f5f5f5' }}>
                {['Peak', 'r', 'z-score', 'p-value', 'Distance'].map(h => (
                  <th key={h} style={{ padding: '2px 6px', textAlign: 'left', borderBottom: '1px solid #ddd' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...links].sort((a, b) => a.pvalue - b.pvalue).map((l, i) => (
                <tr key={i} style={{ background: i % 2 ? '#fafafa' : 'white' }}>
                  <td style={{ padding: '1px 6px', fontFamily: 'monospace' }}>{l.peak}</td>
                  <td style={{ padding: '1px 6px', color: l.score >= 0 ? '#2166ac' : '#d6604d' }}>
                    {l.score.toFixed(3)}
                  </td>
                  <td style={{ padding: '1px 6px' }}>{l.zscore.toFixed(2)}</td>
                  <td style={{ padding: '1px 6px' }}>{l.pvalue.toExponential(2)}</td>
                  <td style={{ padding: '1px 6px' }}>{(l.distance / 1000).toFixed(1)} kb</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
