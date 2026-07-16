const DEFAULT_OPTIONS = {
  fdrThreshold: 0.25,
  maxRawTerms: 80,
  maxThemes: 8,
  redundancyJaccard: 0.45,
  relatedTermLimit: 5,
};

export function summarizePathwayEnrichment(raw = [], metadata = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...metadata };

  if (!raw.length) {
    return {
      available: false,
      reason: 'no_enriched_pathways',
      method: opts.method || null,
      source: opts.source || null,
      queryGenes: opts.queryGenes || [],
      backgroundSize: opts.backgroundSize || null,
      collections: opts.collections || [],
      pathways: [],
      themes: [],
    };
  }

  const adjusted = benjaminiHochberg(raw.map(item => item.pValue));
  const pathways = raw
    .map((item, index) => ({ ...item, adjustedPValue: adjusted[index] }))
    .filter(item => item.adjustedPValue <= opts.fdrThreshold || item.pValue <= 0.01)
    .sort((a, b) => {
      if (a.adjustedPValue !== b.adjustedPValue) return a.adjustedPValue - b.adjustedPValue;
      if (a.pValue !== b.pValue) return a.pValue - b.pValue;
      return b.overlapCount - a.overlapCount;
    })
    .slice(0, opts.maxRawTerms);

  const themes = reduceRedundantPathways(pathways, opts);

  return {
    available: themes.length > 0,
    reason: themes.length ? null : 'no_enriched_pathways_after_filtering',
    method: opts.method || null,
    source: opts.source || null,
    queryGenes: opts.queryGenes || [],
    backgroundSize: opts.backgroundSize || null,
    collections: opts.collections || [],
    pathways,
    themes,
  };
}

function reduceRedundantPathways(pathways, opts) {
  const themes = [];

  for (const pathway of pathways) {
    const representative = themes.find(theme => arePathwaysRedundant(theme, pathway, opts));
    if (representative) {
      representative.relatedTerms = representative.relatedTerms || [];
      if (representative.relatedTerms.length < opts.relatedTermLimit) {
        representative.relatedTerms.push({
          term: pathway.term,
          collection: pathway.collection,
          adjustedPValue: pathway.adjustedPValue,
          overlapGenes: pathway.overlapGenes.slice(0, 12),
        });
      }
      representative.collapsedCount = (representative.collapsedCount || 0) + 1;
      continue;
    }

    themes.push({
      ...pathway,
      collapsedCount: 1,
      relatedTerms: [],
    });

    if (themes.length >= opts.maxThemes) break;
  }

  return themes;
}

function arePathwaysRedundant(a, b, opts) {
  const geneJaccard = jaccard(a.overlapGenes, b.overlapGenes);
  if (geneJaccard >= opts.redundancyJaccard) return true;

  const tokenJaccard = jaccard(termTokens(a.term), termTokens(b.term));
  return tokenJaccard >= 0.55 && geneJaccard >= 0.25;
}

function benjaminiHochberg(pValues) {
  const indexed = pValues.map((pValue, index) => ({ pValue, index }))
    .sort((a, b) => a.pValue - b.pValue);
  const adjusted = new Array(pValues.length).fill(1);
  let runningMin = 1;

  for (let i = indexed.length - 1; i >= 0; i--) {
    const rank = i + 1;
    runningMin = Math.min(runningMin, indexed[i].pValue * indexed.length / rank);
    adjusted[indexed[i].index] = Math.min(1, runningMin);
  }

  return adjusted;
}

function termTokens(term) {
  const stop = new Set([
    'of', 'the', 'to', 'by', 'in', 'via', 'and', 'or', 'positive', 'negative',
    'regulation', 'process', 'pathway', 'signaling', 'cellular',
  ]);

  return String(term || '')
    .replace(/^(HALLMARK|REACTOME|GOBP|GO|KEGG|WP)[_:]/i, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2 && !stop.has(token));
}

function jaccard(a, b) {
  const left = new Set(a || []);
  const right = new Set(b || []);
  if (!left.size || !right.size) return 0;

  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection++;
  }

  return intersection / (left.size + right.size - intersection);
}
