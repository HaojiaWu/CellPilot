const SOCIAL = /^(?:hi|hello|hey|yo|hiya|thanks?|thank\s+you|thx|ty|ok(?:ay)?|cool|great|nice|awesome|perfect|good\s+(?:morning|afternoon|evening|night)|bye|goodbye|see\s+you|sorry|help|i\s*(?:am|'m)\s+(?:confused|lost|stuck))\b/;
const GENERAL_CHAT = /\b(?:joke|weather|poem|story|email|e-mail|what\s+time\s+is\s+it|who\s+(?:made|built|created|wrote)|your\s+name)\b/;

const UNSUPPORTED = [
  [/\b(?:trajector(?:y|ies)|pseudo-?time|lineage|monocle|slingshot|paga|palantir|cellrank)\b/, 'run trajectory or pseudotime analysis'],
  [/\b(?:rna\s+velocity|velocity|scvelo|velocyto)\b/, 'estimate RNA velocity'],
  [/\b(?:go\s+(?:enrichment|terms?|analysis)|gene\s+ontology|kegg|reactome|gsea|pathway\s+(?:enrichment|analysis))\b/, 'run GO or pathway enrichment'],
  [/\b(?:export|download)\b|\bsave\b.*\b(?:as|to)\b|\b(?:csv|pdf|png|svg|tiff?|xlsx|excel|h5ad|rds|loom)\b/, 'export or save files'],
  [/\b(?:doublets?|scrublet|doubletfinder)\b/, 'detect doublets'],
  [/\bcell[\s-]*cycle\b|\bs[\s-]*phase\b|\bg2m?\b/, 'score the cell cycle'],
  [/\b(?:infercnv|copy[\s-]*number|cnvs?)\b/, 'infer copy-number changes (CNV)'],
  [/\b(?:deconvol\w*|cell2location|rctd|spotlight|cibersort)\b/, 'deconvolute spots'],
  [/\b(?:harmony|scvi|bbknn|combat|scanorama|batch[\s-]*(?:correct\w*|effects?|integration|removal))\b|\bintegrat\w*\s+(?:the\s+|all\s+|across\s+(?:the\s+)?)?samples\b/, 'batch-correct or integrate samples from chat (WNN joins RNA and ATAC, not samples)'],
  [/\b(?:azimuth|singler|celltypist|scanvi|label\s+transfer|cell\s+atlas|reference\s+(?:atlas|mapping|annotation)|predict\s+(?:the\s+)?cell\s+types?)\b/, 'annotate cells automatically with a reference atlas'],
];

const GENE_SHAPED = /\b[A-Za-z]{2,}\d+[A-Za-z0-9]*\b/;
const mentionsGene = (text, entities) =>
  Boolean(entities.genes?.length) || (!entities.hasGeneList && GENE_SHAPED.test(text));

const GENE_KNOWLEDGE = /\b(?:role|roles|function|functions|involved|disease|diseases|disorders?|mutations?|variants?|associated|literature|papers?|publications?|known\s+for|biology|regulates?|what\s+does\s+\S+\s+do)\b/;
const GENERAL_TRUTH = /\b(?:normally|usually|typically|generally|in\s+general|commonly|known\s+to\s+be)\b/;
const OWN_DATA = /\b(?:plot|show|display|visuali[sz]e|violin|dot\s*plot|dotplot|umap|my|this|our|here|cluster\s*\d+)\b/;
const LOOKS_AT_DATA = /\b(?:express\w*|levels?|plot|show|display|visuali[sz]e|violin|dot\s*plot|dotplot|umap|where|distribut\w*|markers?)\b/;

const QUESTION_START = /^(?:what|what's|whats|how|why|who|where|which|is|are|does|do\s+(?:you|i|we|they|these|those|the|this|cells|genes)|should|could\s+you\s+explain|can\s+you\s+explain|explain|define|tell\s+me\s+what)\b/;

const EMBEDDED_REQUEST = /(?:^|[?.!,;]\s*|\b(?:and|then|please)\s+)(?:please\s+)?(?:show|plot|run|find|give|list|make|draw|display|rename|compute|calculate|recluster|rerun|redo|highlight|impute|segment|annotate|compare)\b/;

const DATA_OBJECT = /\b(?:cluster|clusters|region|regions|sample|samples)\s*#?\s*\d+\b|\b(?:selected|selection|selections|my\s+(?:area|areas|region|regions|roi)|between\s+the\s+samples|across\s+(?:the\s+)?samples|per\s+sample)\b/;
const EXPRESSION_WORDS = /\b(?:express(?:ed|es|ion|ing)?|levels?|distribut(?:ed|ion)|linked|links?|peaks?)\b/;
const SETTINGS_QUESTION = /\b(?:you\s+(?:use|used|using)|are\s+you\s+using|being\s+used|(?:was|were)\s+(?:used|applied)|applied|current(?:ly)?|right\s+now|at\s+the\s+moment)\b/;
const SETTINGS_WORDS = /\b(?:settings?|parameters?|thresholds?|resolution|variable\s+genes|hvgs?|pcs?|principal\s+components?|neighbou?rs|min[\s_]?dist|filter(?:ing)?|cutoffs?)\b/;

export function detectNonCommand(text, entities = { genes: [], labels: [] }) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?,;:]+$/, '').replace(/\s+/g, ' ');
  if (!t) return 'empty';

  for (const [re, topic] of UNSUPPORTED) {
    if (re.test(t)) return `unsupported:${topic}`;
  }
  if (mentionsGene(t, entities) && GENE_KNOWLEDGE.test(t) && !LOOKS_AT_DATA.test(t)) {
    return 'gene knowledge';
  }
  if (mentionsGene(t, entities) && GENERAL_TRUTH.test(t) && !OWN_DATA.test(t)) return 'gene knowledge';

  const words = t.split(' ').length;
  if (SOCIAL.test(t) && words <= 6 && !EMBEDDED_REQUEST.test(t)) return 'small talk';
  if (GENERAL_CHAT.test(t)) return 'general chat';

  if (!QUESTION_START.test(t)) return null;
  if (EMBEDDED_REQUEST.test(t)) return null;

  if (SETTINGS_QUESTION.test(t) && SETTINGS_WORDS.test(t)) return null;

  if (/^(?:why|should)\b/.test(t)) return 'question';
  const cellsInCluster = /^how\s+many\s+cells\b/.test(t) && (DATA_OBJECT.test(t) || entities.labels?.length > 0);
  if (/^how\s+many\s+(?:cells|genes|clusters|samples)\b/.test(t) && !cellsInCluster) return 'question';
  if (/^(?:how|where)\s+(?:do|can|should)\s+i\b/.test(t)) return 'how-to question';

  if (DATA_OBJECT.test(t) || (entities.labels && entities.labels.length > 0)) return null;
  if (mentionsGene(t, entities) && EXPRESSION_WORDS.test(t)) return null;

  return 'question';
}

const CELLPILOT_VOCABULARY = new RegExp('\\b(?:' + [
  'umap', 'tsne', 'embedding', 'dimension\\w*', 'reduction', 'clusters?', 'clustering', 'recluster\\w*', 'cells?', 'genes?',
  'markers?', 'degs?', 'differential\\w*', 'upregulated', 'enriched', 'express\\w*', 'violins?', 'dot\\s*plots?', 'dotplots?',
  'bubble', 'plot\\w*', 'visuali[sz]\\w*', 'feature\\s+plot', 'qc', 'quality', 'mito\\w*', 'mt', 'umis?', 'counts?', 'filter\\w*', 'thresholds?',
  'cutoffs?', 'resolution', 'leiden', 'louvain', 'pca', 'pcs?', 'principal', 'components?', 'hvgs?', 'variable', 'features?',
  'neighbou?rs?', 'min[\\s_-]*dist\\w*', 'spread', 'parameters?', 'settings?', 'rename', 'relabel', 'labels?', 'annotat\\w*',
  'banksy', 'regions?', 'domains?', 'niches?', 'tissue', 'spatial\\w*', 'segment\\w*', 'composition', 'fractions?',
  'proportions?', 'samples?', 'control', 'disease', 'atac', 'rna', 'wnn', 'multiome', 'modalit\\w*', 'integrat\\w*',
  'peaks?', 'links?', 'linked', 'linkpeaks', 'motifs?', 'tfs?', 'transcription', 'imput\\w*', 'spage', 'cellchat',
  'ligand\\w*', 'receptors?', 'interactions?', 'communicat\\w*', 'crosstalk', 'highlight\\w*', 'un-?highlight\\w*', 'de-?select\\w*', 'selection', 'selected',
  'selections', 'roi', 'colou?rs?', 'colormap', 'viridis', 'magma', 'plasma', 'inferno', 'dataset', 'data',
].join('|') + ')\\b', 'i');

export function isAboutCellPilot(text, entities = { genes: [], labels: [] }) {
  if (entities.genes?.length || entities.labels?.length) return true;
  if (mentionsGene(text, entities)) return true;
  if (/\b(?:cluster|region|sample)\s*#?\s*\d+\b/i.test(text)) return true;
  return CELLPILOT_VOCABULARY.test(text);
}

const CAN_DO = 'Things I can do: plot a gene ("plot NPHS2"), violin or dot plots, find markers ("markers for cluster 3"), ' +
  'describe or rename clusters, recluster ("resolution 1.2"), rerun UMAP, QC plots, and (for spatial data) BANKSY regions and cell-cell interactions.';

export function describeNonCommand(reason, entities = { genes: [] }) {
  if (!reason) return null;
  if (reason.startsWith('unsupported:')) {
    const topic = reason.slice('unsupported:'.length);
    const extra = topic === 'export or save files'
      ? ' Your UMAP, clusters and labels are saved automatically to cellpilot_results.json in the data folder, and the screenshot button in the toolbar saves a high-resolution image of the current view.'
      : '';
    return `CellPilot can't ${topic} yet, so I didn't run anything.${extra}\n\n${CAN_DO}`;
  }
  if (reason === 'offtopic') {
    return "That doesn't look like something I can help with. I work with the single-cell or spatial data loaded in CellPilot.\n\n" +
      'You could ask, for example: "plot NPHS2", "find markers for cluster 3", "violin plot UMOD", ' +
      '"rename cluster 2 to PT", "recluster with resolution 1.2", "plot qc" or "tell me about cluster 5".';
  }
  if (reason === 'gene knowledge') {
    const gene = entities.genes?.[0]?.symbol || 'a gene';
    return `Intent mode can't look up what a gene does, but I can show where ${gene} is expressed in your data: try "plot ${gene}" or "violin plot ${gene}". ` +
      'For background on a gene, switch to agent mode ("switch to agent mode") or load a local chat model.';
  }
  return null;
}
