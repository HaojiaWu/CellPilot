import React, { useEffect, useRef, useMemo } from 'react';
import * as d3 from 'd3';
import { formatGeneNameForDisplay } from '../utils/geneNameFormat';
import './IgvBrowser.css';

function getIgvApi(mod) {
  if (!mod) return null;
  const candidates = [mod, mod.default];
  for (const c of candidates) {
    if (c && typeof c.createBrowser === 'function') return c;
  }
  if (mod.default && typeof mod.default.createBrowser === 'function') return mod.default;
  return mod.default || mod;
}

const basePalette = [
  ...d3.schemeCategory10,
  ...(d3.schemeSet3 || []),
  ...(d3.schemePaired || []),
  ...(d3.schemeDark2 || []),
];

const sortClusterIds = (ids) =>
  ids.slice().sort((a, b) => {
    const numA = Number(a);
    const numB = Number(b);
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
    return String(a).localeCompare(String(b));
  });

const ensurePaletteLength = (targetSize) => {
  if (targetSize <= basePalette.length) return basePalette.slice(0, targetSize);
  const palette = basePalette.slice();
  const needed = targetSize - palette.length;
  const extras = d3.quantize(d3.interpolateTurbo, needed + 2).slice(1, needed + 1);
  return palette.concat(extras);
};

const createClusterColorScale = (clusterIds) => {
  if (!Array.isArray(clusterIds) || clusterIds.length === 0) return null;
  const domain = sortClusterIds(clusterIds).map((id) => String(id));
  const palette = ensurePaletteLength(domain.length);
  return d3.scaleOrdinal(palette).domain(domain);
};

const formatLabel = (label, clusterId, clusterLabelMap = {}) => {
  const key = String(clusterId ?? label).trim();
  if (clusterLabelMap[key]) return clusterLabelMap[key];
  const numericMatch = String(label).match(/-?\d+(?:\.\d+)?/);
  return numericMatch ? numericMatch[0] : (label || key).replace(/^cluster\s*/i, '').trim() || key;
};

/**
 * IGV.js browser for ATAC coverage-by-cluster and peaks. Uses in-memory features
 * (wig + annotation) so no blob URLs are required.
 */
const IgvBrowser = ({
  region,
  coverageByCluster = [],
  peaksOnGene = [],
  geneName = 'gene',
  genome: genomeProp,
  clusterColorOverrides = {},
  clusterLabelMap = {},
}) => {
  const containerRef = useRef(null);
  const browserRef = useRef(null);
  const displayGeneName = useMemo(
    () => formatGeneNameForDisplay(geneName, genomeProp),
    [geneName, genomeProp]
  );

  useEffect(() => {
    const div = containerRef.current;
    if (!div || !region?.chrom || coverageByCluster.length === 0) return;

    const chrom = String(region.chrom);
    const start = Number(region.start) ?? 0;
    const end = Number(region.end) ?? start + 1;
    const locus = `${chrom}:${start}-${end}`;

    const clusterIds = coverageByCluster.map((c) => c.clusterId);
    const colorScale = createClusterColorScale(clusterIds);
    const getColor = (clusterId) =>
      clusterColorOverrides[String(clusterId)] || (colorScale ? colorScale(String(clusterId)) : '#5c7080');

    const tracks = [];

    coverageByCluster.forEach(({ clusterId, label, signal }) => {
      const features = (signal || []).map(({ start: s, end: e, value }) => ({
        chr: chrom,
        start: Number(s) ?? 0,
        end: Number(e) ?? 0,
        value: Number(value) ?? 0,
      }));
      const displayName = formatLabel(label, clusterId, clusterLabelMap);
      const color = getColor(clusterId);
      tracks.push({
        type: 'wig',
        name: (displayName || '').toUpperCase(),
        features,
        color,
        height: 50, // Taller tracks for better visualization (like Signac CoveragePlot)
        autoscale: false,
        min: 0,
        max: 1,
        graphType: 'bar',
      });
    });

    const peakFeatures = peaksOnGene
      .filter((p) => String(p.chrom || '') === chrom)
      .map((p) => ({
        chr: String(p.chrom),
        start: Number(p.start) ?? 0,
        end: Number(p.end) ?? 0,
        name: (p.peakName || `${p.chrom}:${p.start}-${p.end}`).toUpperCase(),
      }));
    if (peakFeatures.length > 0) {
      tracks.push({
        type: 'annotation',
        name: 'PEAKS',
        features: peakFeatures,
        height: 32,
        displayMode: 'EXPANDED',
      });
    }

    const genome = (genomeProp && String(genomeProp).trim()) || 'hg38';
    const options = {
      genome,
      locus,
      tracks,
    };

    let cancelled = false;
    let igvApi = null;
    const duplicateRemovalTimeouts = [];

    import(/* webpackChunkName: "igv" */ 'igv')
      .then((mod) => {
        igvApi = getIgvApi(mod);
        if (!igvApi || typeof igvApi.createBrowser !== 'function') {
          throw new Error('IGV createBrowser not found. Keys: ' + (mod ? Object.keys(mod).join(', ') : 'null'));
        }
        return igvApi.createBrowser(div, options);
      })
      .then((browser) => {
        if (cancelled) {
          if (igvApi && typeof igvApi.removeBrowser === 'function') igvApi.removeBrowser(browser);
          return;
        }
        browserRef.current = browser;

        const removeDuplicateRefSeq = () => {
          if (cancelled || !browserRef.current) return;
          const b = browserRef.current;
          if (typeof b.findTracks !== 'function') return;
          const refseqTracks = b.findTracks((t) => t.name && /refseq/i.test(String(t.name)));
          for (let i = 1; i < refseqTracks.length; i++) {
            try {
              b.removeTrack(refseqTracks[i]);
            } catch (e) {
              console.warn('IGV removeTrack failed:', e);
            }
          }
        };

        removeDuplicateRefSeq();
        duplicateRemovalTimeouts.push(setTimeout(removeDuplicateRefSeq, 400));
        duplicateRemovalTimeouts.push(setTimeout(removeDuplicateRefSeq, 1200));
      })
      .catch((err) => {
        console.error('IGV createBrowser failed:', err);
      });

    return () => {
      cancelled = true;
      duplicateRemovalTimeouts.forEach(clearTimeout);
      if (browserRef.current) {
        const b = browserRef.current;
        browserRef.current = null;
        import('igv').then((mod) => {
          const api = getIgvApi(mod);
          if (api && typeof api.removeBrowser === 'function') api.removeBrowser(b);
        });
      }
    };
  }, [region, coverageByCluster, peaksOnGene, geneName, genomeProp, clusterColorOverrides, clusterLabelMap]);

  if (!region?.chrom || coverageByCluster.length === 0) return null;

  const chromLabel = region?.chrom ? String(region.chrom) : '';
  const genomeLabel = (genomeProp && String(genomeProp).trim()) || 'hg38';

  return (
    <div className="igv-browser-wrapper">
      <div className="igv-browser-header">
        <h3>Peaks on {displayGeneName}</h3>
        <p className="igv-browser-chromosome">
          Chromosome: <strong>{chromLabel}</strong>
          {chromLabel && genomeLabel && ' · '}
          {chromLabel && genomeLabel && <span className="igv-browser-genome">Genome: {genomeLabel}</span>}
        </p>
        <p className="igv-browser-subtitle">
          {Number(region.start).toLocaleString()}–{Number(region.end).toLocaleString()} bp · top {coverageByCluster.length} clusters
        </p>
      </div>
      <div ref={containerRef} className="igv-browser-container" />
      <p className="igv-browser-footnote">
        Normalized signal per cluster and peak regions for {displayGeneName}. Use the locus bar or scroll inside the viewer to zoom and pan; scroll the panel if the right side is cut off.
      </p>
    </div>
  );
};

export default IgvBrowser;
