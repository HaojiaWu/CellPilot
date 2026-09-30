const ENGLISH_WORD_GENES = new Set([
  'ace', 'ache', 'ado', 'ar', 'arc', 'bad', 'bid', 'camp', 'cast', 'cat', 'chat', 'clock', 'coil',
  'cope', 'fry', 'gal', 'gale', 'gem', 'hunk', 'ilk', 'impact', 'itch', 'kin', 'kit', 'mag', 'mall',
  'max', 'met', 'mice', 'musk', 'numb', 'oaf', 'oat', 'palm', 'pip', 'plat', 'pole', 'poll', 'pomp',
  'prep', 'pry', 'ran', 'reck', 'rest', 'sag', 'sell', 'set', 'she', 'si', 'ski', 'son', 'star',
  'strap', 'sync', 'tank', 'tat', 'th', 'timeless', 'trio', 'tub', 'was',
  'mars', 'grasp', 'sis', 'lars', 'tars', 'wap',
  'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'is',
  'are', 'be', 'me', 'my', 'we', 'us', 'you', 'it', 'its', 'this', 'that', 'near', 'all', 'any', 'can', 'do',
  'does', 'how', 'what', 'why', 'who', 'which', 'where', 'when', 'top', 'per', 'up', 'out', 'not', 'no', 'yes',
  'new', 'old', 'one', 'two', 'use', 'get', 'show', 'plot', 'run', 'find', 'make', 'give', 'let', 'see',
]);

const TECHNICAL_WORD_GENES = new Set(['tf', 'pc', 'ids', 'pdf']);

const GENE_CUE_BEFORE = /\b(?:plot|show|visuali[sz]e|display|violin(?:\s+plot)?|dot\s*plot|impute|predict|expression\s+(?:of|for)|gene|genes|feature\s+plot|overlay|color(?:\s+\w+)?\s+by|links?\s+(?:for|to|of))\s*$/i;

const PEAK_RE = /^chr[0-9A-Za-z]+[:_-]\d+[-_]\d+$/i;
const GENE_SHAPED_RE = /^[A-Za-z]{2,}\d+[A-Za-z0-9]*$/;
const TOKEN_RE = /chr[0-9A-Za-z]+[:_-]\d+[-_]\d+|[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]|[A-Za-z0-9]/g;

const geneIndexCache = new WeakMap();

function getGeneIndex(geneNames) {
  if (!Array.isArray(geneNames) || geneNames.length === 0) return null;
  let index = geneIndexCache.get(geneNames);
  if (!index) {
    index = new Map();
    for (const name of geneNames) {
      if (typeof name !== 'string' || !name) continue;
      const key = name.toUpperCase();
      if (!index.has(key)) index.set(key, name);
    }
    geneIndexCache.set(geneNames, index);
  }
  return index;
}

function isMostlyUppercase(text) {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (!letters) return false;
  return letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8;
}

export function extractIntentEntities(text, dataContext = {}) {
  const geneIndex = getGeneIndex(dataContext?.geneNames);
  const labelIndex = new Map();
  for (const [id, label] of Object.entries(dataContext?.clusterLabels || {})) {
    if (label == null) continue;
    const key = String(label).toLowerCase();
    if (!labelIndex.has(key)) labelIndex.set(key, []);
    labelIndex.get(key).push(parseInt(id, 10));
  }

  const shouting = isMostlyUppercase(text);
  const genes = [];
  const labels = [];

  for (const m of text.matchAll(TOKEN_RE)) {
    const tok = m[0];
    const start = m.index;
    const end = start + tok.length;
    const lower = tok.toLowerCase();
    const before = text.slice(Math.max(0, start - 40), start);

    if (PEAK_RE.test(tok)) {
      genes.push({ text: tok, symbol: tok, start, end });
      continue;
    }

    const labelIds = labelIndex.get(lower);
    const geneSymbol = geneIndex ? geneIndex.get(tok.toUpperCase()) : null;
    if (labelIds && !(geneSymbol && GENE_CUE_BEFORE.test(before))) {
      labels.push({ text: tok, ids: labelIds, start, end });
      continue;
    }

    if (!geneIndex && !labelIds && GENE_SHAPED_RE.test(tok)) {
      genes.push({ text: tok, symbol: tok, start, end, guessed: true });
      continue;
    }
    if (!geneSymbol || /^\d+(?:\.\d+)?$/.test(tok)) continue;
    const explicitGene = /\bgenes?\s*$/i.test(before);
    if (tok.length === 1 && !explicitGene) continue;
    if (TECHNICAL_WORD_GENES.has(lower) && !explicitGene) continue;
    if (ENGLISH_WORD_GENES.has(lower)) {
      const typedInCaps = tok === tok.toUpperCase() && !shouting;
      if (!typedInCaps && !explicitGene) continue;
    }
    genes.push({ text: tok, symbol: geneSymbol, start, end });
  }

  const spans = [
    ...genes.map((g) => ({ ...g, word: 'gene' })),
    ...labels.map((l) => ({ ...l, word: 'cluster' })),
  ].sort((a, b) => a.start - b.start);
  let masked = '';
  let pos = 0;
  for (const s of spans) {
    masked += text.slice(pos, s.start) + s.word;
    pos = s.end;
  }
  masked += text.slice(pos);
  masked = masked.replace(/\b(gene|cluster)(?:\s*(?:,|and|&)?\s*\1\b)+/gi, '$1');

  return { hasGeneList: Boolean(geneIndex), genes, labels, masked };
}
