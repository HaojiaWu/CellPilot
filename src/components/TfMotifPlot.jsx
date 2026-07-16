import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';

/**
 * Horizontal bar chart ranking enriched TF motifs using RENIN-inspired scoring.
 * Props:
 *   cluster        string   cluster label
 *   results        Array    [{tfName, negLogP, foldEnrichment, pvalueAdj, queryHits,
 *                             reninScore, meanExprInCluster}]
 *   topMarkers     Array    top marker gene names used as input
 *   nQueryPeaks    number
 *   nBgPeaks       number
 *   genome         string
 */
export default function TfMotifPlot({
  cluster,
  results = [],
  topMarkers = [],
  nQueryPeaks = 0,
  nBgPeaks = 0,
  genome = null,
}) {
  const svgRef = useRef(null);
  const wrapRef = useRef(null);

  // Detect whether RENIN scores are available (any non-zero reninScore)
  const hasRenin = results.some(r => r.reninScore != null && r.reninScore > 0);

  useEffect(() => {
    const svgEl = svgRef.current;
    const container = wrapRef.current;
    if (!svgEl || !container || results.length === 0) return;

    d3.select(svgEl).selectAll('*').remove();

    // Sort by RENIN score if available, otherwise by fold enrichment
    const top = results
      .slice()
      .sort((a, b) => {
        if (hasRenin) return (b.reninScore ?? 0) - (a.reninScore ?? 0);
        return b.foldEnrichment - a.foldEnrichment;
      })
      .slice(0, 25);

    const margin = { top: 14, right: 160, bottom: 38, left: 110 };
    const barH = 18;
    const barGap = 4;
    const w = Math.max(container.clientWidth || 600, 520);
    const innerW = w - margin.left - margin.right;
    const innerH = top.length * (barH + barGap);
    const totalH = innerH + margin.top + margin.bottom;

    d3.select(svgEl).attr('width', w).attr('height', totalH);
    const g = d3.select(svgEl).append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // X scale: RENIN score (or fold enrichment as fallback)
    const xMax = hasRenin
      ? (d3.max(top, d => d.reninScore ?? 0) || 1)
      : (d3.max(top, d => Math.min(d.foldEnrichment, 50)) || 5);
    const xScale = d3.scaleLinear().domain([0, xMax * 1.08]).range([0, innerW]);

    const BAR_COLOR = '#4a90c4';

    // Bars
    top.forEach((d, i) => {
      const y = i * (barH + barGap);
      const barVal = hasRenin ? (d.reninScore ?? 0) : Math.min(d.foldEnrichment, xMax);
      const barW = Math.max(xScale(barVal), 2);

      g.append('rect')
        .attr('x', 0).attr('y', y)
        .attr('width', barW).attr('height', barH)
        .attr('fill', BAR_COLOR)
        .attr('rx', 2);

      // TF name label (left)
      g.append('text')
        .attr('x', -6).attr('y', y + barH / 2)
        .attr('text-anchor', 'end').attr('dominant-baseline', 'middle')
        .attr('font-size', '11px').attr('fill', '#222')
        .attr('font-weight', '400')
        .text(d.tfName);

      // Right-side annotation
      let annotText;
      if (hasRenin) {
        const feStr = d.foldEnrichment < 90 ? d.foldEnrichment.toFixed(1) + '×' : '>90×';
        const corrStr = d.corrSum != null ? d.corrSum.toFixed(2) : '—';
        const exprStr = d.meanExprInCluster != null ? d.meanExprInCluster.toFixed(2) : '—';
        annotText = `FE=${feStr}  Σr=${corrStr}  μ=${exprStr}`;
      } else {
        const negLogPStr = d.negLogP.toFixed(1);
        const adjPStr = d.pvalueAdj < 0.001 ? '<0.001' : d.pvalueAdj.toFixed(3);
        annotText = `−log₁₀p=${negLogPStr}  adj.p=${adjPStr}`;
      }
      g.append('text')
        .attr('x', barW + 5).attr('y', y + barH / 2)
        .attr('dominant-baseline', 'middle').attr('font-size', '9.5px').attr('fill', '#555')
        .text(annotText);
    });

    // X axis
    const xAxis = d3.axisBottom(xScale).ticks(5).tickFormat(d3.format('.2g'));
    g.append('g')
      .attr('transform', `translate(0,${innerH + 4})`)
      .call(xAxis)
      .selectAll('text').attr('font-size', '9px');

    g.append('text')
      .attr('x', innerW / 2).attr('y', innerH + 30)
      .attr('text-anchor', 'middle').attr('font-size', '10px').attr('fill', '#555')
      .text(hasRenin ? 'RENIN score (expr × fold enrichment)' : 'Fold enrichment');


  }, [results, cluster, hasRenin]);

  if (results.length === 0) {
    return (
      <div style={{ padding: 20, color: '#888', fontSize: 13 }}>
        No significantly enriched TF motifs found for cluster <strong>{cluster}</strong>.
      </div>
    );
  }

  const top5 = results.slice(0, 5).map(r => r.tfName).join(', ');

  return (
    <div ref={wrapRef} style={{ width: '100%', fontFamily: 'sans-serif', padding: '4px 8px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2, color: '#111' }}>
        TF Prioritization: Cluster {cluster}
        {genome && <span style={{ fontWeight: 400, color: '#666', marginLeft: 8, fontSize: 11 }}>{genome}</span>}
      </div>
      <div style={{ fontSize: 11, color: '#555', marginBottom: 6 }}>
        {nQueryPeaks} linked peaks vs {nBgPeaks} background peaks ·{' '}
        marker genes: <em>{topMarkers.slice(0, 6).join(', ')}{topMarkers.length > 6 ? '…' : ''}</em>
      </div>
      {hasRenin && (
        <div style={{ fontSize: 10, color: '#2563eb', marginBottom: 4, background: '#eff6ff', borderRadius: 4, padding: '2px 6px', display: 'inline-block' }}>
          Ranked by: log2FC × mean expression × gene correlation
        </div>
      )}
      <div style={{ fontSize: 11, color: '#444', marginBottom: 8, marginTop: hasRenin ? 4 : 0 }}>
        Top TFs: <strong>{top5}</strong>
        {results.length > 5 && <span style={{ color: '#888' }}> + {results.length - 5} more</span>}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg ref={svgRef} />
      </div>
      <div style={{ fontSize: 10, color: '#aaa', marginTop: 4 }}>
        JASPAR CORE vertebrates
        {hasRenin && ' · FE = motif fold enrichment · Σr = sum of positive Pearson corr. with marker genes · μ = mean expr in cluster'}
      </div>
    </div>
  );
}
