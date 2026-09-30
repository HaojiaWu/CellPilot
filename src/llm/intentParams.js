const clean = (s) => String(s || '').trim().replace(/[.!?;]+$/, '').replace(/\s+/g, ' ');
const stripQuotes = (s) => s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

export function parseRename(text, clusterLabels = {}) {
  let t = clean(text)
    .replace(/^(?:please|pls|can you|could you|would you|let'?s|lets|i want to|i'd like to)\s+/i, '')
    .replace(/\s*,?\s*(?:please\s+|can you\s+|could you\s+)?rename\s+it\b.*$/i, '')
    .replace(/\s+please$/i, '');
  t = t.replace(/^(?:i\s+think|i\s+believe|looks\s+like)\s+/i, '');

  const patterns = [
    /^(?:rename|relabel|call|name|label|mark)\s+(cluster|region)\s+(\S+)\s+(?:(?:to|as|=)\s+)?(.+)$/i,
    /^(?:change|set|update)\s+(?:the\s+)?(?:name|label)\s+(?:of|for)\s+(cluster|region)\s+(\S+)\s+(?:to|as|=)\s+(.+)$/i,
    /^(?:change|set|update)\s+(cluster|region)\s+(\S+)(?:'s)?\s+(?:name|label)\s+(?:to|as|=)\s+(.+)$/i,
    /^(cluster|region)\s+(\d+)\s+(?:is|=|should\s+be(?:\s+(?:named|called|labell?ed))?|will\s+be(?:\s+(?:named|called))?)\s+(.+)$/i,
    /^(?:rename|relabel)\s+()(\d+)\s+(?:to|as)\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const kind = (m[1] || 'cluster').toLowerCase();
      let newLabel = stripQuotes(clean(m[3]));
      if (kind === 'region') newLabel = newLabel.replace(/^the\s+/i, '');
      if (!newLabel || /^(?:it|this|that)$/i.test(newLabel) || isChainedRenameLabel(newLabel)) return null;
      return { kind, oldLabel: m[2], newLabel };
    }
  }

  const m = t.match(/^(?:rename|relabel)\s+(.+?)\s+(?:to|as)\s+(.+)$/i);
  if (m) {
    const old = stripQuotes(m[1]).replace(/^(?:the\s+)?cluster\s+/i, '');
    const known = Object.values(clusterLabels || {}).some((l) => String(l).toLowerCase() === old.toLowerCase());
    const newLabel = stripQuotes(clean(m[2]));
    if (known && !isChainedRenameLabel(newLabel)) return { kind: 'cluster', oldLabel: old, newLabel };
  }
  return null;
}

export function isChainedRenameLabel(label) {
  return /\bthen\b/i.test(label) ||
    /(?:\band\b|,)\s*(?:rename\s+|relabel\s+|call\s+|label\s+|change\s+)?(?:cluster|region)\s+\S+\s+(?:to|as)\b/i.test(label);
}

export function parseCellFilter(text) {
  const t = clean(text).toLowerCase();
  const out = {};
  const num = '(\\d+(?:\\.\\d+)?)';

  const mito =
    t.match(new RegExp(`${num}\\s*(?:%|percent)?\\s*(?:of\\s+)?(?:mito(?:chondrial)?|mt)\\b`)) ||
    t.match(new RegExp(`\\b(?:mito(?:chondrial)?|mt)(?:\\s*(?:percent(?:age)?|fraction|reads|counts|threshold|cutoff))?\\s*(?:<=|<|>|=|to|of|at|above|below|over|under|less\\s+than|more\\s+than)?\\s*${num}`));
  if (mito) out.mito_threshold = parseFloat(mito[1]);

  const notHvg = (m) => m && !/variable|hvg/.test(t.slice(Math.max(0, m.index - 12), m.index + m[0].length));
  const genes = [
    new RegExp(`\\bmin(?:imum)?\\s*(?:detected\\s+)?genes?(?:\\s+per\\s+cell)?\\s*(?:=|>=|>|to|of|at)?\\s*${num}`),
    new RegExp(`\\bgenes?\\s*(?:detected|per\\s+cell)?\\s*(?:cutoff|threshold|filter|minimum)\\s*(?:=|to|of|at)?\\s*${num}`),
    new RegExp(`\\b(?:cutoff|threshold|filter)\\s+(?:of|to|at)\\s+(?:at\\s+least\\s+)?${num}\\s*(?:detected\\s+)?(?:genes?|per\\s+cell)`),
    new RegExp(`${num}\\s*\\+?\\s*(?:or\\s+more\\s+)?(?:detected\\s+)?genes?\\b`),
  ].map((re) => t.match(re)).find(notHvg);
  if (genes) out.detected_threshold = parseFloat(genes[1]);

  const umi = t.match(new RegExp(`${num}\\s*(?:umis?|counts|reads)\\b`)) ||
    t.match(new RegExp(`\\b(?:min(?:imum)?\\s*)?(?:umis?|counts)\\s*(?:=|>=|>|to|of|at)?\\s*${num}`));
  if (umi && !(mito && umi[1] === mito[1])) out.sum_threshold = parseFloat(umi[1]);
  return out;
}

export function parseHvgCount(text) {
  const t = clean(text).toLowerCase();
  const m =
    t.match(/(\d+)\s*(?:highly\s+)?(?:variable|hvgs?)(?:\s+(?:genes?|features?))?/) ||
    t.match(/\b(?:(?:highly\s+)?variable\s+(?:genes?|features?)|hvgs?|features?)\s*(?:=|to|of|,|:)?\s*(?:like\s+)?(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export function parseMinDist(text) {
  const m = clean(text).match(/\bmin(?:imum)?[\s_-]*dist(?:ance)?\s*(?:=|to|of|:)?\s*(\d*\.?\d+)/i) ||
    clean(text).match(/(\d*\.?\d+)\s*min(?:imum)?[\s_-]*dist/i);
  return m ? parseFloat(m[1]) : null;
}

export function parseParameterStep(text) {
  const t = clean(text).toLowerCase();
  if (/\b(?:variable\s+genes?|hvgs?|feature\s+selection|features)\b/.test(t)) return 'featureSelection';
  if (/\bgene\s+filter/.test(t)) return 'geneFiltering';
  if (/\b(?:filter(?:ing)?|thresholds?|qc|quality|min(?:imum)?\s+genes|mito)\b/.test(t)) return 'cellFiltering';
  if (/\b(?:pca|pcs?|principal\s+components?)\b/.test(t)) return 'pca';
  if (/\b(?:umap|embedding|min[\s_]*dist|neighbou?rs)\b/.test(t)) return 'umap';
  if (/\b(?:cluster(?:ing|s)?|resolution)\b/.test(t)) return 'clustering';
  return null;
}

export function parseSamplePair(text, sampleNames = []) {
  const t = clean(text);
  const known = (sampleNames || []).filter(Boolean);
  if (known.length >= 2) {
    const found = known
      .map((name) => ({ name, i: t.toLowerCase().indexOf(String(name).toLowerCase()) }))
      .filter((x) => x.i >= 0)
      .sort((a, b) => a.i - b.i);
    if (found.length >= 2) return { sample1: found[0].name, sample2: found[1].name };
  }
  const m =
    t.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:\s+(?:in|for|within)\s+cluster\b.*)?$/i) ||
    t.match(/\b(sample\s*\d+|\S+)\s+(?:vs\.?|versus)\s+(sample\s*\d+|\S+)/i) ||
    t.match(/\bcompare\s+(\S+)\s+(?:and|with|to)\s+(\S+)\s+(?:in|for|within)\s+cluster\b/i);
  if (!m) return null;
  const tidy = (s) => s.replace(/^(?:the\s+)?/i, '').replace(/\s+(?:in|for)\s+cluster.*$/i, '').trim();
  return { sample1: tidy(m[1]), sample2: tidy(m[2]) };
}

export function parseHighlightDirection(text) {
  const t = clean(text).toLowerCase();
  const src = t.match(/\b(rna|atac)\s+cluster\b/);
  if (src) return src[1] === 'rna' ? 'rna_on_atac' : 'atac_on_rna';
  const onto = t.match(/\b(?:on|onto|in)\s+(?:the\s+)?(rna|atac)\b/);
  if (onto) return onto[1] === 'atac' ? 'rna_on_atac' : 'atac_on_rna';
  return null;
}

export function parseHighlightRequest(text) {
  const t = clean(text).toLowerCase();
  if (/\batac\b/.test(t)) return null;
  const clear =
    /\bun-?highlight\w*|\bde-?select\w*|\bstop\s+highlighting\b/.test(t) ||
    /\b(?:clear|remove|reset|undo|turn\s+off)\s+(?:the\s+|my\s+|this\s+)?(?:cluster\s+)?(?:highlight\w*|selection)\b/.test(t) ||
    /\b(?:show|display|bring\s+back)\s+(?:all|every)\s+(?:the\s+|of\s+the\s+)?clusters?\b/.test(t) ||
    /\bevery\s+cluster\s+(?:is\s+)?visible\b/.test(t);
  if (clear) return /\brna\b/.test(t) ? null : 'clear';
  if (/\b(?:markers?|genes?|degs?|differential\w*|violin|dot\s*plots?|dotplot|express\w*|rename|call|label)\b/.test(t)) return null;
  const highlight =
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:just\s+|only\s+)?(?:highlight|isolate|spotlight|select|focus\s+on)\b/.test(t) ||
    /\b(?:show|display|plot|keep)\s+(?:me\s+)?only\b/.test(t) ||
    /\bonly\s+(?:show|display)\b/.test(t) ||
    /^(?:please\s+)?(?:can\s+you\s+)?just\s+(?:show|display)\b/.test(t);
  return highlight ? 'highlight' : null;
}

export function isClusterSummaryQuestion(text) {
  const t = clean(text).toLowerCase();
  if (/\b(?:markers?|genes?|degs?|differential\w*|rename|call|label|between|vs\.?|versus|disease|control|regions?|resolution|recluster\w*|umap|highlight\w*|motifs?|peaks?)\b/.test(t)) return false;
  return /\b(?:size|how\s+(?:big|large|small)|how\s+many\s+cells|number\s+of\s+cells|cell\s+counts?|summar(?:y|i[sz]e)|overview|what\s+(?:cell\s+)?(?:type|kind\s+of\s+cells?)|which\s+cell\s+type)\b/.test(t);
}

export function isOneVsRestComparison(text) {
  const t = clean(text).toLowerCase();
  return /\b(?:de|degs?|differential\w*|markers?|genes?)\b/.test(t) &&
    /\b(?:vs\.?|versus|against|compared\s+(?:to|with))\s+(?:all\s+)?(?:the\s+)?(?:rest|everything(?:\s+else)?|all(?:\s+(?:other|the\s+other))?(?:\s+(?:cells|clusters))?|other\s+(?:cells|clusters)|others)\b/.test(t);
}

export function isSettingsQuestion(text) {
  const t = clean(text).toLowerCase();
  if (/\d/.test(t) || /\b(?:set|change|update|increase|decrease|lower|raise|rerun|recompute|redo)\b/.test(t)) return false;
  const asksToSee = /\b(?:settings?|parameters?|params)\b/.test(t) ||
    /\b(?:you\s+(?:use|used|using)|are\s+you\s+using|being\s+used|(?:was|were)\s+(?:used|applied)|currently\s+(?:used|using|set))\b/.test(t);
  const settingWords = /\b(?:settings?|parameters?|params|thresholds?|resolution|variable\s+genes|hvgs?|pcs?|principal\s+components?|neighbou?rs|min[\s_]?dist|cutoffs?)\b/.test(t);
  return asksToSee && settingWords;
}
