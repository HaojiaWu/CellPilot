import { pipeline, env } from '@xenova/transformers';
import * as webllm from '@mlc-ai/web-llm';
import { generateApiChatResponse, isApiConfigured } from './apiChatService';
import { extractIntentEntities } from './intentEntities';
import { detectNonCommand, describeNonCommand, isAboutCellPilot } from './intentGate';
import INTENT_MODEL from './intentModel.json';
import {
  parseRename, parseCellFilter, parseHvgCount, parseMinDist, parseParameterStep,
  parseSamplePair, parseHighlightDirection, isChainedRenameLabel,
  parseHighlightRequest, isClusterSummaryQuestion, isOneVsRestComparison, isSettingsQuestion,
} from './intentParams';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;

function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;

  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],
          dp[i][j - 1],
          dp[i - 1][j - 1]
        );
      }
      if (i > 1 && j > 1 && str1[i - 1] === str2[j - 2] && str1[i - 2] === str2[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }

  return dp[m][n];
}

function fuzzyMatch(word, target, maxDistance = null) {
  if (!word || !target) return false;

  const w = word.toLowerCase();
  const t = target.toLowerCase();

  if (w === t) return true;

  if (maxDistance === null) {
    if (t.length < 4) {
      return false;
    } else if (t.length <= 5) {
      maxDistance = 1;
    } else {
      maxDistance = 2;
    }
  }

  if (Math.abs(w.length - t.length) > maxDistance) return false;

  return levenshteinDistance(w, t) <= maxDistance;
}

const FUZZY_KEYWORDS = [
  'cluster', 'clusters', 'violin', 'dotplot', 'umap', 'expression',
  'markers', 'marker', 'rename', 'recluster', 'rerun', 'resolution',
  'parameters', 'parameter', 'settings', 'filtering', 'filter',
  'genes', 'gene', 'plot', 'show', 'find', 'tell', 'about',
  'cell', 'cells', 'color', 'colors', 'min', 'dist', 'list', 'qc',
  'spatial', 'tissue', 'coordinates'
];

const NEVER_CORRECT = new Set([
  'how', 'now', 'low', 'row', 'snow', 'slow', 'shoe', 'shop', 'shot', 'stow',
  'call', 'calls', 'well', 'wells', 'sell', 'sells', 'tells', 'bell', 'bells', 'fell', 'yell', 'tall', 'till', 'toll', 'dell',
  'fine', 'kind', 'mind', 'bind', 'wind', 'fund', 'fond', 'fins', 'gone', 'gent', 'gents',
  'last', 'lost', 'lust', 'mist', 'most', 'must', 'just', 'dust', 'diet', 'disk',
  'issue', 'market', 'special', 'revolution', 'pilot', 'impression',
  'colon', 'filler', 'fitter', 'perimeter', 'perimeters', 'slot', 'blot', 'plod', 'ploy',
]);

export function preprocessUserInput(text) {
  if (!text) return '';

  let processed = text.trim();

  processed = processed.replace(/[,.?!;:]+$/, '');

  processed = processed.replace(/\s+/g, ' ');

  processed = processed
    .replace(/\bvln\s*plots?\b|\bvln\b/gi, 'violin plot')
    .replace(/\bfeature\s*plots?\b/gi, 'feature plot')
    .replace(/\bdot\s*plots?\b/gi, 'dot plot')
    .replace(/\bdim\s*plots?\b/gi, 'umap plot');

  const renameToIdx = processed.search(/(?:rename|change|set|call|label)\s+cluster\s+\S+.*?\s+(?:to|as)\s+/i);
  let labelStartIdx = -1;
  if (renameToIdx !== -1) {
    const afterVerb = processed.slice(renameToIdx);
    const toMatch = afterVerb.match(/\s+(?:to|as)\s+/i);
    if (toMatch) {
      labelStartIdx = renameToIdx + toMatch.index + toMatch[0].length;
    }
  }

  const words = processed.split(' ');
  let charIdx = 0;
  const correctedWords = words.map(word => {
    const wordStart = charIdx;
    charIdx += word.length + 1;

    if (labelStartIdx !== -1 && wordStart >= labelStartIdx) {
      return word;
    }

    if (word.length < 3 || /^\d+$/.test(word) || /[^a-zA-Z]/.test(word)) {
      return word;
    }

    const lowerWord = word.toLowerCase();
    if (NEVER_CORRECT.has(lowerWord)) return word;

    for (const keyword of FUZZY_KEYWORDS) {
      if (lowerWord === keyword) {
        return word;
      }
    }

    for (const keyword of FUZZY_KEYWORDS) {
      if (fuzzyMatch(lowerWord, keyword)) {
        const corrected = word[0] === word[0].toUpperCase()
          ? keyword.charAt(0).toUpperCase() + keyword.slice(1)
          : keyword;
        console.log(`Typo corrected: "${word}" → "${corrected}"`);
        return corrected;
      }
    }

    return word;
  });

  return correctedWords.join(' ');
}

const INTENT_TEMPLATES = {
  find_markers: {
    description: 'Find marker genes for a cluster',
    examples: [
      'find markers for cluster',
      'what are the marker genes for cluster',
      'show me DEGs for cluster',
      'differentially expressed genes',
      'top genes for cluster',
      'what genes define cluster',
      'marker analysis for cluster',
      'find DEGs',
      'show markers',
    ]
  },
  deg_between_samples: {
    description: 'Differential genes for a cluster between two samples (integration)',
    examples: [
      'differential genes for cluster between sample1 and sample2',
      'DEG for cluster 1 between sample1 and sample 2',
      'differentially expressed genes cluster 1 sample1 vs sample2',
    ]
  },
  plot_cell_fraction: {
    description: 'Plot cell fraction or proportion per cluster per sample (integration)',
    examples: [
      'plot cell fraction',
      'plot cell proportion',
      'show cell fraction',
    ]
  },
  cluster_info: {
    description: 'Get information about a cluster',
    examples: [
      'tell me about cluster',
      'what is cluster',
      'describe cluster',
      'information about cluster',
      'details about cluster',
      'what cells are in cluster',
      'cluster information',
      'give me info on cluster',
    ]
  },
  plot_gene_expression: {
    description: 'Plot gene expression on UMAP',
    examples: [
      'plot gene expression',
      'show expression of',
      'visualize gene',
      'display gene on umap',
      'gene expression plot',
      'show me where gene is expressed',
      'color by gene expression',
      'expression pattern of',
    ]
  },
  plot_gene_violin: {
    description: 'Create violin plot for a gene',
    examples: [
      'violin plot for',
      'show violin of',
      'gene violin plot',
      'create violin',
      'violin for gene',
      'distribution of gene',
    ]
  },
  plot_gene_dotplot: {
    description: 'Create dot plot for genes across clusters',
    examples: [
      'dotplot for',
      'dot plot for',
      'create dotplot',
      'show dotplot',
      'gene dotplot',
      'dotplot genes',
      'dot plot genes',
    ]
  },
  run_umap: {
    description: 'Run UMAP dimensionality reduction',
    examples: [
      'run umap',
      'create umap',
      'umap embedding',
      'dimensionality reduction',
      'reduce dimensions',
      'create embedding',
    ]
  },
  cluster_and_visualize: {
    description: 'Cluster cells and show UMAP',
    examples: [
      'cluster the cells',
      'run clustering',
      'analyze cells',
      'find clusters',
      'cluster analysis',
      'cluster and visualize',
      'plot cell clusters',
      'plot umap',
      'plot umap colored by cell type',
      'plot cell types',
      'show cell clusters',
      'show umap',
    ]
  },
  run_qc: {
    description: 'Run quality control',
    examples: [
      'run qc',
      'quality control',
      'check quality',
      'qc analysis',
      'run quality check',
    ]
  },
  rename_cluster: {
    description: 'Rename a cluster',
    examples: [
      'rename cluster',
      'change cluster name',
      'call cluster',
      'name cluster',
      'label cluster as',
      'set cluster name',
    ]
  },
  rename_region: {
    description: 'Rename a BANKSY spatial region',
    examples: [
      'rename region',
      'change region name',
      'call region',
      'name region',
      'label region as',
      'set region name',
    ]
  },
  set_colormap: {
    description: 'Change color map or color scheme',
    examples: [
      'change colors to',
      'set colors to',
      'use colors',
      'change color map',
      'set color map',
      'use color scheme',
      'change colormap',
      'set colormap',
      'switch colors',
      'update colors',
    ]
  },
  highlight_cluster: {
    description: 'Highlight one or more clusters on the current view and dim the rest',
    examples: [
      'highlight cluster 3',
      'only show cluster 5',
      'focus on the PT cluster',
      'isolate cluster 2 on the umap',
    ]
  },
  clear_cluster_highlight: {
    description: 'Clear the cluster highlight so all clusters are shown',
    examples: [
      'clear the highlight',
      'remove the cluster highlight',
      'show all clusters',
      'deselect clusters',
    ]
  },
  highlight_rna_cluster_on_atac: {
    description: 'Highlight cells from an RNA cluster on the ATAC view (multiome)',
    examples: [
      'show the cells in cluster from RNA on ATAC',
      'show cells in cluster from RNA on ATAC',
      'highlight RNA cluster on ATAC',
      'show RNA cluster on ATAC view',
      'highlight cluster from RNA on ATAC',
    ]
  },
  clear_rna_highlight_on_atac: {
    description: 'Clear RNA cluster highlight on ATAC view',
    examples: [
      'clear RNA highlight on ATAC',
      'remove RNA highlight on ATAC',
      'clear highlight on ATAC view',
    ]
  },
  highlight_atac_cluster_on_rna: {
    description: 'Highlight cells from an ATAC cluster on the RNA view (multiome)',
    examples: [
      'show the cells in cluster from ATAC on RNA',
      'show cells in cluster from ATAC on RNA',
      'highlight ATAC cluster on RNA',
      'show ATAC cluster on RNA view',
    ]
  },
  clear_atac_highlight_on_rna: {
    description: 'Clear ATAC cluster highlight on RNA view',
    examples: [
      'clear ATAC highlight on RNA',
      'remove ATAC highlight on RNA',
      'clear ATAC highlight on RNA view',
    ]
  },
  update_cell_filtering: {
    description: 'Update cell filtering parameters',
    examples: [
      'set min genes',
      'filter cells with min genes',
      'update cell filtering',
      'change cell filter',
      'set cell filtering',
      'min genes per cell',
      'filter cells',
      'cell filtering',
      'rerun with min genes',
      'recluster with min genes',
      'reanalyze with min genes',
    ]
  },
  update_variable_genes: {
    description: 'Update number of variable genes',
    examples: [
      'set variable genes',
      'change variable genes',
      'update variable genes',
      'set hvg',
      'change hvg',
      'number of variable genes',
      'highly variable genes',
    ]
  },
  update_clustering_resolution: {
    description: 'Update clustering resolution',
    examples: [
      'set resolution',
      'change resolution',
      'update resolution',
      'recluster with resolution',
      'clustering resolution',
      'change clustering resolution',
      'rerun clustering for RNA with resolution',
      'rerun clustering for ATAC with resolution',
      'recluster RNA with resolution',
      'recluster ATAC with resolution',
      'rerun RNA clustering',
      'rerun ATAC clustering',
    ]
  },
  update_pca_for_umap: {
    description: 'Update PCA components for UMAP',
    examples: [
      'set pca components',
      'change pca',
      'update pca',
      'pca for umap',
      'principal components',
    ]
  },
  update_umap_parameters: {
    description: 'Update UMAP parameters',
    examples: [
      'set umap parameters',
      'change umap',
      'update umap',
      'umap min dist',
      'umap neighbors',
    ]
  },
  show_parameters: {
    description: 'Show current analysis parameters',
    examples: [
      'show parameters',
      'list parameters',
      'current parameters',
      'what parameters',
      'show settings',
      'current settings',
      'display parameters',
      'parameters for cell filtering',
      'parameters for clustering',
      'parameters for umap',
    ]
  },
  region_segmentation: {
    description: 'Run BANKSY spatial region segmentation to identify tissue domains',
    examples: [
      'segment regions',
      'region segmentation',
      'identify regions',
      'spatial region analysis',
      'region analysis',
      'find tissue regions',
      'identify tissue domains',
      'spatial domain detection',
      'run banksy',
      'banksy region segmentation',
      'detect spatial regions',
      'cluster spatial regions',
      'find spatial domains',
      'identify the regions in the dataset',
      'can you identify the regions',
      'segment the tissue regions',
      'spatial region identification',
    ]
  },
  spatial_cell_interaction: {
    description: 'Run ligand-receptor / cell-cell communication analysis across selected spatial regions',
    examples: [
      'cell cell interaction analysis',
      'cell-cell communication between selected areas',
      'ligand receptor analysis for selected regions',
      'run cellchat on the selected spatial areas',
      'compare interactions among selected regions',
    ]
  },
  impute_gene: {
    description: 'Impute / predict unmeasured gene expression in spatial data using SpaGE and a scRNA-seq reference',
    examples: [
      'impute SLC12A3',
      'impute gene NPHS2',
      'predict SLC12A3 expression',
      'predict missing gene UMOD',
      'impute missing gene',
      'spage imputation',
      'run spage for SLC5A2',
      'gene imputation SLC12A3',
      'impute expression of NPHS2',
      'predict gene expression for SLC5A2',
      'can you impute SLC12A3',
      'predict unmeasured gene',
    ]
  },
};

const FOLLOW_UP_EXAMPLES = [
  'what about cluster',
  'how about cluster',
  'same for cluster',
  'same to cluster',
  'same with cluster',
  'and cluster',
  'now cluster',
  'do the same for',
  'do the same to',
  'repeat for cluster',
];

const EMBEDDING_MODEL_MAP = {
  'all-minilm-l6': 'Xenova/all-MiniLM-L6-v2',
  'bge-small': 'Xenova/bge-small-en-v1.5',
  'gte-small': 'Xenova/gte-small',
};

const CHAT_MODEL_MAP = {
  'qwen2.5-1.5b': 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  'qwen2.5-0.5b': 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
  'llama-3.2-1b': 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  'smollm2-360m': 'SmolLM2-360M-Instruct-q4f16_1-MLC',
};

const API_CHAT_MODELS = ['chatgpt', 'claude', 'gemini', 'groq', 'openrouter'];

let currentEmbeddingModelId = null;
let isEmbeddingLoading = false;
let embedder = null;
let intentEmbeddings = null;
let followUpEmbeddings = null;

let currentChatModelId = null;
let isChatLoading = false;
let chatEngine = null;

let lastActionContext = null;

const INTENT_MODEL_EMBEDDER = 'Xenova/all-MiniLM-L6-v2';
const AMBIGUITY_MARGIN = 0.15;
const AMBIGUITY_MAX_TOP = 0.6;

function scoreWithIntentModel(embedding) {
  if (!INTENT_MODEL || EMBEDDING_MODEL_MAP[currentEmbeddingModelId] !== INTENT_MODEL_EMBEDDER) return null;
  if (!embedding || embedding.length !== INTENT_MODEL.dims) return null;
  const { classes, W, b } = INTENT_MODEL;
  const logits = new Array(classes.length);
  let max = -Infinity;
  for (let c = 0; c < classes.length; c++) {
    const w = W[c];
    let z = b[c];
    for (let d = 0; d < embedding.length; d++) z += w[d] * embedding[d];
    logits[c] = z;
    if (z > max) max = z;
  }
  let sum = 0;
  for (let c = 0; c < logits.length; c++) { logits[c] = Math.exp(logits[c] - max); sum += logits[c]; }
  return classes.map((action, c) => ({ action, score: logits[c] / sum }));
}

function cosineSimilarity(a, b) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function setLastActionContext(action, params) {
  lastActionContext = { action, params };
}

export function getLastActionContext() {
  return lastActionContext;
}

export async function checkWebLLMAvailable() {
  try {
    if (typeof window === 'undefined') return false;
    const hasWASM = typeof WebAssembly !== 'undefined';
    return hasWASM;
  } catch (error) {
    console.error('WebLLM availability check failed:', error);
    return false;
  }
}

export async function isModelCached(modelId) {
  try {
    const hfModelId = EMBEDDING_MODEL_MAP[modelId];
    if (!hfModelId) return false;
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      return cacheNames.some(name => name.includes('transformers'));
    }
    return false;
  } catch (error) {
    return false;
  }
}

function yieldToMain() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function precomputeIntentEmbeddings() {
  if (!embedder) return;

  console.log('Pre-computing intent embeddings...');
  intentEmbeddings = {};
  let count = 0;
  const YIELD_EVERY = 5;

  for (const [action, data] of Object.entries(INTENT_TEMPLATES)) {
    intentEmbeddings[action] = [];
    for (const example of data.examples) {
      const result = await embedder(example, { pooling: 'mean', normalize: true });
      intentEmbeddings[action].push(Array.from(result.data));
      count++;
      if (count % YIELD_EVERY === 0) await yieldToMain();
    }
  }

  followUpEmbeddings = [];
  for (const example of FOLLOW_UP_EXAMPLES) {
    const result = await embedder(example, { pooling: 'mean', normalize: true });
    followUpEmbeddings.push(Array.from(result.data));
    count++;
    if (count % YIELD_EVERY === 0) await yieldToMain();
  }

  console.log('Intent embeddings pre-computed successfully');
}

export async function downloadModel(modelId, progressCallback = null) {
  if (isEmbeddingLoading) {
    console.warn('Embedding model download already in progress');
    return false;
  }

  isEmbeddingLoading = true;

  try {
    let hfModelId = EMBEDDING_MODEL_MAP[modelId] || EMBEDDING_MODEL_MAP['all-minilm-l6'];

    console.log(`Downloading embedding model: ${hfModelId}`);

    if (progressCallback) progressCallback(5);

    embedder = await pipeline('feature-extraction', hfModelId, {
      progress_callback: (progress) => {
        if (progressCallback && progress.progress) {
          const scaled = 5 + (progress.progress * 0.7);
          progressCallback(Math.round(scaled));
        }
      },
      quantized: true,
    });

    if (progressCallback) progressCallback(80);

    await precomputeIntentEmbeddings();

    currentEmbeddingModelId = modelId;

    if (progressCallback) progressCallback(100);

    console.log(`Model ${hfModelId} loaded and ready!`);
    return true;

  } catch (error) {
    console.error('Model download failed:', error);
    return false;
  } finally {
    isEmbeddingLoading = false;
  }
}

export function getCurrentModel() {
  return currentEmbeddingModelId;
}

export function isModelLoaded() {
  return embedder !== null && intentEmbeddings !== null;
}

export function getAvailableChatModels() {
  return Object.entries(CHAT_MODEL_MAP).map(([id, mlcId]) => ({
    id,
    mlcId,
    name: id.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
  }));
}

export async function checkWebGPUAvailable() {
  try {
    if (typeof navigator === 'undefined') return false;
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch (error) {
    console.error('WebGPU check failed:', error);
    return false;
  }
}

export async function downloadChatModel(modelId, progressCallback = null) {
  if (isChatLoading) {
    console.warn('Chat model download already in progress');
    return false;
  }

  if (API_CHAT_MODELS.includes(modelId)) {
    isChatLoading = true;

    try {
      if (progressCallback) progressCallback(50);

      if (!isApiConfigured(modelId)) {
        console.error(`${modelId} API key not configured`);
        if (progressCallback) progressCallback(0);
        return false;
      }

      if (progressCallback) progressCallback(100);
      currentChatModelId = modelId;
      console.log(`API chat model ${modelId} ready!`);
      return true;
    } catch (error) {
      console.error('API chat model setup failed:', error);
      return false;
    } finally {
      isChatLoading = false;
    }
  }

  const hasWebGPU = await checkWebGPUAvailable();
  if (!hasWebGPU) {
    console.error('WebGPU not available - local chat model requires WebGPU');
    return false;
  }

  isChatLoading = true;

  try {
    const mlcModelId = CHAT_MODEL_MAP[modelId] || CHAT_MODEL_MAP['qwen2.5-1.5b'];
    console.log(`Downloading chat model: ${mlcModelId}`);

    if (progressCallback) progressCallback(1);

    chatEngine = await webllm.CreateMLCEngine(mlcModelId, {
      initProgressCallback: (progress) => {
        if (progressCallback) {
          const percent = Math.round((progress.progress || 0) * 100);
          progressCallback(percent);
          console.log(`Chat model loading: ${progress.text || ''} (${percent}%)`);
        }
      },
    });

    currentChatModelId = modelId;
    console.log(`Chat model ${mlcModelId} loaded and ready!`);
    return true;

  } catch (error) {
    console.error('Chat model download failed:', error);
    chatEngine = null;
    return false;
  } finally {
    isChatLoading = false;
  }
}

export function isChatModelLoaded() {
  if (chatEngine !== null) {
    return true;
  }

  if (currentChatModelId && API_CHAT_MODELS.includes(currentChatModelId)) {
    return isApiConfigured(currentChatModelId);
  }

  return false;
}

export function getCurrentChatModel() {
  return currentChatModelId;
}

export async function generateChatResponse(userMessage, context = {}) {
  if (currentChatModelId && API_CHAT_MODELS.includes(currentChatModelId)) {
    try {
      console.log(`Generating chat response using ${currentChatModelId} API`);
      const reply = await generateApiChatResponse(currentChatModelId, userMessage, context);
      console.log('API chat response:', reply);
      return reply;
    } catch (error) {
      console.error('API chat generation failed:', error);
      return null;
    }
  }

  if (!chatEngine) {
    console.warn('No chat model loaded, cannot generate response');
    return null;
  }

  try {
    const systemPrompt = `You are CellPilot, an AI assistant specialized in single-cell RNA sequencing (scRNA-seq) and spatial transcriptomics analysis. You run in a web browser and help researchers analyze their single-cell and spatial data.

Your main capabilities include:
- Clustering cells and running UMAP visualization
- Finding marker genes for clusters (differentially expressed genes)
- Plotting gene expression on UMAP or spatial coordinates
- Creating violin plots and dot plots for genes
- Running quality control (QC) analysis
- Renaming clusters with biological cell type labels
- Adjusting analysis parameters (resolution, HVGs, filtering thresholds)
- Visualizing spatial transcriptomics data (Xenium, Visium)

IMPORTANT: When a user asks for something that sounds like it could be a CellPilot command but you're not sure, try to interpret it as a command and suggest the most likely action. For example:
- "show me nphs2" → likely means "plot gene expression for nphs2"
- "what about cluster 1" → likely means "get information about cluster 1"
- "markers for PT" → likely means "find markers for cluster PT"
- "rerun with resolution 0.8" → likely means "update clustering resolution to 0.8"

You do NOT have access to external databases or the internet. You cannot look up gene functions, pathways, or biological annotations. For questions about gene function, biology, or anything outside your analysis capabilities, acknowledge your limitations and suggest the user consult resources like:
- GeneCards (genecards.org) for gene information
- NCBI Gene database
- UniProt for protein information
- PubMed for literature
- Or a general AI assistant for general questions

Keep responses concise (2-4 sentences) and helpful. If the question is about scRNA-seq analysis that you CAN help with, guide the user on how to phrase their request.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

    if (context.clusters && context.clusters.length > 0) {
      messages[0].content += `\n\nCurrent data context: The user has ${context.totalCells || 'unknown'} cells in ${context.clusters.length} clusters.`;
      if (context.clusterLabels && Object.keys(context.clusterLabels).length > 0) {
        const labels = Object.entries(context.clusterLabels)
          .map(([id, name]) => `${id}: ${name}`)
          .join(', ');
        messages[0].content += ` Cluster labels: ${labels}.`;
      }
    }

    console.log('Generating chat response for:', userMessage);

    const response = await chatEngine.chat.completions.create({
      messages,
      max_tokens: 256,
      temperature: 0.7,
    });

    const reply = response.choices[0]?.message?.content || null;
    console.log('Chat response:', reply);
    return reply;

  } catch (error) {
    console.error('Chat generation failed:', error);
    return null;
  }
}

export async function unloadChatModel() {
  if (chatEngine) {
    try {
      await chatEngine.unload();
    } catch (e) {
      console.warn('Error unloading chat model:', e);
    }
  }
  chatEngine = null;
  currentChatModelId = null;
}

export async function classifyIntent(userMessage, dataContext = {}, options = {}) {
  const { topK = 3 } = options;

  if (!embedder || !intentEmbeddings) {
    console.warn('No model loaded, cannot classify intent');
    return null;
  }

  try {
    const originalMessage = userMessage;
    const entities = extractIntentEntities(originalMessage.trim().replace(/[,.?!;:]+$/, ''), dataContext);

    const nonCommand = detectNonCommand(originalMessage, entities);
    if (nonCommand) {
      console.log(`Not a command (${nonCommand}): "${originalMessage}"`);
      return { action: 'NONE', params: {}, confidence: 0, topK: [], nonCommand, message: describeNonCommand(nonCommand, entities) };
    }

    userMessage = preprocessUserInput(userMessage);
    if (userMessage !== originalMessage) {
      console.log(`Input preprocessed: "${originalMessage}" → "${userMessage}"`);
    }

    if (!isAboutCellPilot(userMessage, entities)) {
      console.log(`Not about CellPilot: "${originalMessage}"`);
      return { action: 'NONE', params: {}, confidence: 0, topK: [], nonCommand: 'offtopic', message: describeNonCommand('offtopic', entities) };
    }

    const embedText = entities.hasGeneList || entities.genes.length > 0 ? preprocessUserInput(entities.masked) : userMessage;
    console.log('WebLLM classifying intent for:', embedText);

    const userEmbeddingResult = await embedder(embedText.toLowerCase(), {
      pooling: 'mean',
      normalize: true
    });
    const userEmbedding = Array.from(userEmbeddingResult.data);

    let maxFollowUpSim = 0;
    for (const followUpEmb of followUpEmbeddings) {
      const sim = cosineSimilarity(userEmbedding, followUpEmb);
      maxFollowUpSim = Math.max(maxFollowUpSim, sim);
    }

    let clusterNum = null;
    let clusterLabel = null;
    const clusterPatterns = [
      /(?:to|for|with)\s+cluster\s+(\d+)/i,
      /cluster\s+(\d+)/i,
      /(\d+)\s*$/i,
      /^(\d+)$/i,
    ];
    for (const pattern of clusterPatterns) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        clusterNum = parseInt(match[1]);
        break;
      }
    }

    if (clusterNum === null) {
      const labelPatterns = [
        /(?:for|to|with|about)\s+cluster\s+([A-Za-z0-9_-]+)/i,
        /(?:for|to|with|about)\s+([A-Za-z][A-Za-z0-9_-]*)/i,
        /cluster\s+([A-Za-z][A-Za-z0-9_-]*)/i,
      ];

      const skipWords = new Set([
        'markers', 'marker', 'genes', 'gene', 'info', 'information', 'about', 'the', 'a', 'an',
        'this', 'that', 'these', 'those', 'all', 'each', 'every', 'some', 'any', 'which',
        'what', 'where', 'when', 'how', 'why', 'show', 'find', 'get', 'tell', 'give'
      ]);

      for (const pattern of labelPatterns) {
        const match = userMessage.match(pattern);
        if (match && match[1]) {
          const candidate = match[1].trim();
          if (!skipWords.has(candidate.toLowerCase()) && candidate.length >= 2) {
            clusterLabel = candidate;
            console.log(`Extracted cluster label: ${clusterLabel}`);
            break;
          }
        }
      }
    }

    let mergedClusterIds = null;
    if (clusterLabel && dataContext?.clusterLabels) {
      const labelMap = dataContext.clusterLabels;
      console.log(`Attempting to resolve cluster label "${clusterLabel}" using label map:`, labelMap);

      const matchingIds = Object.keys(labelMap).filter(
        key => labelMap[key].toLowerCase() === clusterLabel.toLowerCase()
      );

      if (matchingIds.length > 0) {
        clusterNum = parseInt(matchingIds[0]);

        if (matchingIds.length > 1) {
          mergedClusterIds = matchingIds.map(id => parseInt(id));
          console.log(`✓ Resolved MERGED cluster label "${clusterLabel}" to IDs [${mergedClusterIds.join(', ')}]`);
        } else {
          console.log(`✓ Resolved cluster label "${clusterLabel}" to ID ${clusterNum}`);
        }
        clusterLabel = null;
      } else {
        console.log(`✗ Cluster label "${clusterLabel}" not found in label map. Available labels:`, Object.values(labelMap));
      }
    }

    if (clusterNum === null && entities.labels.length > 0) {
      const ids = entities.labels[0].ids;
      clusterNum = ids[0];
      mergedClusterIds = ids.length > 1 ? ids : null;
      clusterLabel = null;
    }

    const showRnaClusterOnAtac = /\b(?:from\s+)?RNA\s+on\s+ATAC\b/i.test(userMessage) ||
      /\bhighlight\s+RNA\s+cluster\b.*\b(?:on\s+)?ATAC\b/i.test(userMessage);
    if (showRnaClusterOnAtac && (clusterNum !== null || clusterLabel)) {
      const clusterParam = clusterNum !== null ? clusterNum : clusterLabel;
      console.log('Detected "highlight RNA cluster on ATAC" request, returning highlight_rna_cluster_on_atac for cluster', clusterParam);
      return {
        action: 'highlight_rna_cluster_on_atac',
        params: { cluster: clusterParam },
        confidence: 0.95,
        topK: []
      };
    }
    if (/\bclear\s+RNA\s+highlight\s+on\s+ATAC\b/i.test(userMessage)) {
      console.log('Detected "clear RNA highlight on ATAC" request');
      return {
        action: 'clear_rna_highlight_on_atac',
        params: {},
        confidence: 0.95,
        topK: []
      };
    }

    const showAtacClusterOnRna = /\b(?:from\s+)?ATAC\s+on\s+RNA\b/i.test(userMessage) ||
      /\bhighlight\s+ATAC\s+cluster\b.*\b(?:on\s+)?RNA\b/i.test(userMessage);
    if (showAtacClusterOnRna && (clusterNum !== null || clusterLabel)) {
      const clusterParam = clusterNum !== null ? clusterNum : clusterLabel;
      console.log('Detected "highlight ATAC cluster on RNA" request, returning highlight_atac_cluster_on_rna for cluster', clusterParam);
      return {
        action: 'highlight_atac_cluster_on_rna',
        params: { cluster: clusterParam },
        confidence: 0.95,
        topK: []
      };
    }
    if (/\bclear\s+ATAC\s+highlight\s+on\s+RNA\b/i.test(userMessage)) {
      console.log('Detected "clear ATAC highlight on RNA" request');
      return {
        action: 'clear_atac_highlight_on_rna',
        params: {},
        confidence: 0.95,
        topK: []
      };
    }

    const asksForPeakMarkers = /\b(?:peaks?|da|differential(?:ly)?\s+accessib\w*|accessibility|chromatin)\b/i.test(userMessage);

    const namesCluster = clusterNum !== null || entities.labels.length > 0;
    const clusterParams = () => (mergedClusterIds ? { cluster: clusterNum, clusters: mergedClusterIds } : { cluster: clusterNum });

    const highlightRequest = parseHighlightRequest(userMessage);
    if (highlightRequest === 'clear') {
      return { action: 'clear_cluster_highlight', params: {}, confidence: 0.95, topK: [] };
    }
    if (highlightRequest === 'highlight' && namesCluster && entities.genes.length === 0) {
      return { action: 'highlight_cluster', params: clusterParams(), confidence: 0.95, topK: [] };
    }

    if (namesCluster && entities.genes.length === 0 && isClusterSummaryQuestion(userMessage)) {
      return { action: 'cluster_info', params: clusterParams(), confidence: 0.95, topK: [] };
    }
    if (namesCluster && isOneVsRestComparison(userMessage)) {
      return { action: 'find_markers', params: { ...clusterParams(), ...(asksForPeakMarkers ? { markerFeature: 'peak' } : {}) }, confidence: 0.95, topK: [] };
    }

    if (isSettingsQuestion(userMessage)) {
      const step = parseParameterStep(userMessage);
      return { action: 'show_parameters', params: step ? { step } : {}, confidence: 0.95, topK: [] };
    }

    const imputeMsg = userMessage.trim();
    const imputeGeneMatch =
      imputeMsg.match(/\bimpute(?:\s+(?:gene|expression\s+of|missing\s+gene))?\s+([A-Za-z0-9_./-]+)/i) ||
      imputeMsg.match(/\bpredict(?:\s+(?:gene|expression\s+of|missing\s+gene))?\s+([A-Za-z0-9_./-]+)\s*(?:expression)?/i) ||
      imputeMsg.match(/\bspage\s+(?:for\s+)?([A-Za-z0-9_./-]+)/i) ||
      imputeMsg.match(/\bgene\s+imputation\s+([A-Za-z0-9_./-]+)/i);
    const isImputeRequest =
      /\bimpute\b/i.test(imputeMsg) ||
      /\bpredict(?:ed)?\s+(?:gene|missing|unmeasured|expression)/i.test(imputeMsg) ||
      /\bspage\b/i.test(imputeMsg) ||
      /\bgene\s+imputation\b/i.test(imputeMsg);
    if (isImputeRequest) {
      const gene = entities.hasGeneList ? (entities.hasGeneList ? (entities.genes[0]?.symbol ?? null) : null) : (imputeGeneMatch ? imputeGeneMatch[1] : null);
      console.log('Detected SpaGE gene imputation request, gene:', gene);
      return {
        action: 'impute_gene',
        params: gene ? { gene } : {},
        confidence: 0.95,
        topK: [],
      };
    }

    const spatialInteractionMsg = userMessage.trim().toLowerCase();
    const isSpatialInteraction =
      /\bcell[\s-]*cell\s+(?:interaction|communication|crosstalk)/i.test(spatialInteractionMsg) ||
      /\bligand[\s-]*receptor\b/i.test(spatialInteractionMsg) ||
      /\bcellchat\b/i.test(spatialInteractionMsg) ||
      /\b(?:interaction|communication)\s+analysis\b/i.test(spatialInteractionMsg);
    if (isSpatialInteraction) {
      console.log('Detected spatial ligand-receptor interaction request (classifyIntent)');
      return { action: 'spatial_cell_interaction', params: {}, confidence: 0.95, topK: [] };
    }

    const banksyMsg = userMessage.trim().toLowerCase();
    const isBanksyRegion =
      /\bbanksy\b/.test(banksyMsg) ||
      /\bregion\s+segment/i.test(banksyMsg) ||
      /\bsegment\s+(?:the\s+)?regions?\b/i.test(banksyMsg) ||
      /\bregion\s+analysis\b/i.test(banksyMsg) ||
      /\bidentify\s+(?:the\s+)?regions?\b/i.test(banksyMsg) ||
      /\bfind\s+(?:tissue\s+)?(?:regions?|domains?)\b/i.test(banksyMsg) ||
      /\bdetect\s+(?:spatial\s+)?(?:regions?|domains?)\b/i.test(banksyMsg) ||
      /\bspatial\s+(?:region|domain)\s+(?:analysis|detection|segmentation|identification)\b/i.test(banksyMsg) ||
      /\btissue\s+(?:region|domain)\b/i.test(banksyMsg) ||
      /\bspatial\s+domain\b/i.test(banksyMsg);
    const isViewRequest = /^(?:please\s+)?(?:show|display|plot|view|see|open|go\s+to|switch\s+to|back\s+to)\b/.test(banksyMsg) &&
      !/\b(?:run|rerun|segment|identify|detect|find|compute|redo)\b/.test(banksyMsg);
    if (isBanksyRegion && isViewRequest) {
      console.log('BANKSY mentioned in a view request - showing existing regions');
      return { action: 'show_regions', params: {}, confidence: 0.95, topK: [] };
    }
    if (isBanksyRegion) {
      console.log('Detected BANKSY region segmentation request (classifyIntent)');
      const banksyParams = {};
      const _parseNum = (pattern) => {
        const m = userMessage.match(pattern);
        return m && m[1] && !Number.isNaN(parseFloat(m[1])) ? parseFloat(m[1]) : null;
      };
      const _resMatch = _parseNum(/resolution\s*(?:=|to|of)?\s*(\d+(?:\.\d+)?)/i) ??
        _parseNum(/(\d+(?:\.\d+)?)\s*resolution/i);
      const _lambdaMatch = _parseNum(/lambda\s*(?:=|to|of)?\s*(\d+(?:\.\d+)?)/i) ??
        _parseNum(/(\d+(?:\.\d+)?)\s*lambda/i);
      const _neighborMatch = _parseNum(/(?:k\s*=\s*|neighbors?\s*(?:=|to|use)?\s*)(\d+(?:\.\d+)?)/i) ??
        _parseNum(/(\d+(?:\.\d+)?)\s*neighbors?/i);
      if (_resMatch !== null) banksyParams.resolution = _resMatch;
      if (_lambdaMatch !== null) banksyParams.lambda = _lambdaMatch;
      if (_neighborMatch !== null) banksyParams.numNeighbors = _neighborMatch;
      return { action: 'region_segmentation', params: banksyParams, confidence: 0.95, topK: [] };
    }

    const showRegionMsg = userMessage.trim().toLowerCase();
    const isShowRegions =
      /\b(?:plot|show|display)\s+(?:the\s+)?(?:umap\s+)?(?:colored?\s+by\s+)?regions?\b/.test(showRegionMsg) ||
      /\bumap\s+(?:colored?\s+)?by\s+region/.test(showRegionMsg) ||
      /\b(?:show|plot|display)\s+(?:me\s+)?(?:the\s+)?regions?\b/.test(showRegionMsg) ||
      /\bwhat\s+regions?\s+(?:are\s+there|do\s+(?:we|i)\s+have|exist)\b/.test(showRegionMsg) ||
      /\bhow\s+many\s+regions?\b/.test(showRegionMsg) ||
      /\bcolor\s+(?:by|with)\s+region/.test(showRegionMsg) ||
      /\bregion\s+(?:plot|view|map|overlay)\b/.test(showRegionMsg);
    if (isShowRegions) {
      console.log('Detected show regions request (classifyIntent)');
      return { action: 'show_regions', params: {}, confidence: 0.95, topK: [] };
    }

    const renameRegionMatch = userMessage.match(/(?:rename|change|set|call|label|name)\s+region\s+(\S+)\s+(?:to|as)\s+["']?([^"'\n]+?)["']?\s*$/i);
    if (renameRegionMatch && renameRegionMatch[1] && renameRegionMatch[2] && !isChainedRenameLabel(renameRegionMatch[2])) {
      console.log('Detected rename region request (classifyIntent)');
      return {
        action: 'rename_region',
        params: {
          oldLabel: renameRegionMatch[1].trim(),
          newLabel: renameRegionMatch[2].trim(),
        },
        confidence: 0.95,
        topK: [],
      };
    }

    const regionCompMsg = userMessage.trim().toLowerCase();
    const regionCompMatch = regionCompMsg.match(
      /(?:what\s+(?:cell\s+)?(?:cluster|type|cell\s*type)s?\s+(?:are\s+)?(?:in|of)\s+region\s*(\d+))|(?:(?:cluster|type|cell\s*type)s?\s+(?:in|of|for)\s+region\s*(\d+))|(?:region\s*(\d+)\s+(?:composition|cell\s*type|cluster|makeup|breakdown))|(?:(?:show|plot|what)\s+(?:is\s+)?(?:the\s+)?(?:composition|cell\s*type|cluster)\s+(?:of|in|for)\s+region\s*(\d+))|(?:(?:composition|cell\s*type|cluster)\s+(?:composition\s+)?(?:of|in|for)\s+region\s*(\d+))/
    );
    if (regionCompMatch) {
      const regionId = Number(regionCompMatch[1] ?? regionCompMatch[2] ?? regionCompMatch[3] ?? regionCompMatch[4] ?? regionCompMatch[5]);
      console.log(`Detected region composition request for region ${regionId} (classifyIntent)`);
      return { action: 'region_composition', params: { regionId }, confidence: 0.95, topK: [] };
    }

    const wnnMsg = userMessage.trim().toLowerCase();
    const isWNNIntegration =
      /\bwnn\b/.test(wnnMsg) ||
      /\bweighted\s+nearest\s+neighbor/.test(wnnMsg) ||
      /integrate\s+(?:the\s+)?rna\s+and\s+atac/i.test(wnnMsg) ||
      /integrate\s+(?:the\s+)?atac\s+and\s+rna/i.test(wnnMsg) ||
      /\brna[\s-]+atac\s+integrat/i.test(wnnMsg) ||
      /\batac[\s-]+rna\s+integrat/i.test(wnnMsg) ||
      /\bmultimodal\s+integrat/i.test(wnnMsg) ||
      /\bco[\s-]?embed/i.test(wnnMsg) ||
      /(?:run|do|perform|compute|create)\s+(?:a\s+)?(?:wnn|weighted\s+nn|joint\s+embedding|multimodal)\b/i.test(wnnMsg) ||
      /\bjoint\s+(?:umap|embedding|analysis)\b/i.test(wnnMsg) ||
      /\bintegrate\s+(?:both\s+)?modalities\b/i.test(wnnMsg);
    if (isWNNIntegration) {
      console.log('Detected WNN integration request (classifyIntent)');
      return { action: 'wnn_integrate', params: {}, confidence: 0.95, topK: [] };
    }

    const cellFracMsg = userMessage.trim().toLowerCase();
    const isPlotShowFraction =
      (cellFracMsg.includes('plot') || cellFracMsg.includes('show')) &&
      (cellFracMsg.includes('cell fraction') ||
        cellFracMsg.includes('cell proportion') ||
        /\b(?:plot|show)\s+(?:cell\s+)?fraction\b/.test(cellFracMsg));
    if (isPlotShowFraction) {
      console.log('Detected plot cell fraction / proportion / fraction (classifyIntent)');
      return { action: 'plot_cell_fraction', params: {}, confidence: 0.92, topK: [] };
    }

    const tfMotifMatch =
      userMessage.match(/\b(?:prioriti[sz]e|rank|score)\s+(?:top\s+)?(?:tf|transcription\s+factors?)\s+(?:for|in|of)\s+cluster\s+([A-Za-z0-9_-]+)/i) ||
      userMessage.match(/\b(?:show|find|get|display|plot|run)\s+(?:me\s+)?(?:top\s+)?(?:tf|transcription\s+factors?|motif(?:s|s\s+analysis)?)\s+(?:for|in|of)\s+cluster\s+([A-Za-z0-9_-]+)/i) ||
      userMessage.match(/\b(?:show|find|get|display|plot)\s+(?:me\s+)?(?:enriched\s+)?(?:tf|transcription\s+factors?)\s+(?:for|in|of)\s+cluster\s+([A-Za-z0-9_-]+)/i) ||
      userMessage.match(/\bmotif\s+(?:analysis|enrichment)\s+(?:for|in|of)\s+cluster\s+([A-Za-z0-9_-]+)/i) ||
      userMessage.match(/\bcluster\s+([A-Za-z0-9_-]+)\s+(?:tf|transcription\s+factors?|motif(?:s)?)/i);
    if (tfMotifMatch) {
      const clusterRaw = tfMotifMatch[1];
      const clusterVal = /^\d+$/.test(clusterRaw) ? parseInt(clusterRaw, 10) : clusterRaw;
      return { action: 'tf_motif_analysis', params: { cluster: clusterVal }, confidence: 0.95, topK: [] };
    }

    const showLinksMatch =
      userMessage.match(/\b(?:show|display|plot)\s+(?:peak[\s-]?(?:to[\s-]?)?gene\s+)?links?\s+for\s+([A-Za-z0-9-]+)/i) ||
      userMessage.match(/\b(?:show|display|plot)\s+(?:peak[\s-]?(?:to[\s-]?)?gene\s+)?links?\s+of\s+([A-Za-z0-9-]+)/i) ||
      userMessage.match(/\bpeak[\s-]?gene\s+links?\s+(?:for|of)\s+([A-Za-z0-9-]+)/i) ||
      userMessage.match(/\b(?:show|display|plot)\s+(?:linked\s+)?peaks?\s+(?:for|of)\s+([A-Za-z0-9-]+)/i) ||
      userMessage.match(/\b(?:show|display|plot)\s+peaks?\s+linked\s+to\s+([A-Za-z0-9-]+)/i);
    if (showLinksMatch) {
      return { action: 'show_peak_gene_links', params: { gene: (entities.hasGeneList ? (entities.genes[0]?.symbol ?? null) : null) ?? showLinksMatch[1] }, confidence: 0.95, topK: [] };
    }

    const linkPeaksLower = userMessage.toLowerCase();
    const isLinkPeaks =
      /\blink\s+peaks?\b/.test(linkPeaksLower) ||
      /\blinkpeaks?\b/.test(linkPeaksLower) ||
      /\bpeak[\s-](?:to[\s-])?gene\s+(?:link|corr|assoc)/.test(linkPeaksLower) ||
      /\bcis[\s-]regulat/.test(linkPeaksLower) ||
      /\bpeak\s+gene\s+(?:link|correlation|association|connect)/.test(linkPeaksLower);
    if (isLinkPeaks) {
      const geneForLink = (entities.hasGeneList ? (entities.genes[0]?.symbol ?? null) : null) ||
        userMessage.match(/\blink\s+peaks?\s+for\s+([A-Za-z0-9-]+)/i)?.[1] ||
        userMessage.match(/\blinkpeaks?\s+for\s+([A-Za-z0-9-]+)/i)?.[1];
      return {
        action: 'link_peaks',
        params: geneForLink ? { gene: geneForLink } : {},
        confidence: 0.95,
        topK: [],
      };
    }

    let geneName = null;
    const genePatterns = [
      /(?:coverage\s+plot|plot\s+coverage)\s+(?:for\s+)?([A-Za-z0-9-]+)/i,
      /(?:show|plot)\s+(?:me\s+)?coverage\s+(?:plot\s+)?(?:for\s+)?([A-Za-z0-9-]+)/i,
      /(?:plot|show)\s+(?:me\s+)?(?:gene\s+)?(chr\w+:\d+-\d+)/i,
      /(?:plot|show)\s+(?:me\s+)?(chr\w+:\d+-\d+)\s*$/i,
      /\b(chr\w+:\d+-\d+)\b/,
      /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,
      /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+([A-Za-z0-9-]+)/i,
      /gene\s+activi?ty\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,
      /(?:show|plot)\s+(?:me\s+)?gene\s+expression\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,
      /gene\s+expression\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,
      /(?:plot|show)\s+(?:me\s+)?gene\s+([A-Za-z0-9-]+)/i,
      /(?:show|plot)\s+me\s+([A-Za-z0-9-]+)/i,
      /(?:show|plot)\s+([A-Za-z0-9-]+)(?:\s|$|\.|,)/i,
      /(?:plot|show)\s+(?:me\s+)?(?:gene\s+)?([A-Za-z0-9-]+)\s+(?:expression|on\s+umap)/i,
      /what\s+is\s+(?:the\s+)?(?:gene\s+)?expression\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,
      /(?:expression|gene)\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,
      /([A-Za-z0-9-]+)\s+expression(?:\s+plot)?/i,
      /expression\s+([A-Za-z0-9-]+)/i,
      /([A-Za-z0-9-]+)\s+on\s+umap/i,
      /^(?:plot|show)\s+(?:me\s+)?([A-Za-z0-9-]+)\s*$/i,
      /gene\s+([A-Za-z0-9-]+)/i,
      /violin\s+(?:plot\s+)?(?:for\s+)?([A-Za-z0-9-]+)/i,
      /([A-Za-z0-9-]+)\s+violin(?:\s+plot)?/i,
      /(?:dotplot|dot\s+plot)\s+(?:for\s+)?([A-Za-z0-9-]+)/i,
      /([A-Za-z0-9-]+)\s+(?:dotplot|dot\s+plot)/i,
      /\b([A-Z][A-Z0-9]+[A-Z0-9]*)\b/,
      /\b([A-Za-z][A-Za-z0-9]+[A-Za-z0-9]*)\b/,
    ];

    const stopwords = new Set([
      'gene', 'genes', 'expression', 'cells', 'cell', 'umap', 'embedding', 'please', 'show', 'plot', 'me', 'the', 'for', 'of', 'color', 'to',
      'dotplot', 'dot', 'cluster', 'clusters', 'qc', 'quality', 'control', 'violin', 'scatter', 'coverage',
      'link', 'links', 'peak', 'peaks', 'linkpeaks', 'regulatory', 'cis',
      'function', 'what', 'is', 'does', 'how', 'why', 'role', 'purpose', 'pathway',
      'involved', 'related', 'associated', 'about', 'tell', 'explain', 'describe', 'information',
      'meaning', 'definition', 'know', 'help', 'can', 'you', 'this', 'that', 'which', 'where', 'when',
      'spatial', 'tissue', 'coordinates', 'fraction', 'proportion'
    ]);

    if (entities.hasGeneList) {
      geneName = entities.genes.length > 0 ? entities.genes[0].symbol : null;
    }
    for (const pattern of entities.hasGeneList ? [] : genePatterns) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].toLowerCase();
        if (!stopwords.has(candidate) && match[1].length >= 2) {
          geneName = match[1];
          console.log(`Extracted gene name: ${geneName} using pattern: ${pattern}`);
          break;
        }
      }
    }

    if (!geneName) {
      console.log('No gene name extracted from:', userMessage);
    }

    const trimmed = userMessage.trim();
    const isCoveragePlotGene = /\b(?:coverage\s+plot|plot\s+coverage)\b/i.test(trimmed) && geneName && !stopwords.has(geneName.toLowerCase());
    if (isCoveragePlotGene) {
      console.log(`Early return: coverage plot command with gene "${geneName}" → plot_gene_expression (showPeakView)`);
      return {
        action: 'plot_gene_expression',
        params: { gene: geneName, showPeakView: true },
        confidence: 0.92,
        topK: []
      };
    }

    const isPlotShowOnly = /^(?:plot|show)\s+(?:me\s+)?(?:gene\s+(?:activi?ty\s+)?(?:for\s+|of\s+)?)?/i.test(trimmed) &&
      !/\b(violin|dotplot|dot\s+plot|marker)\b/i.test(trimmed);
    if (geneName && !stopwords.has(geneName.toLowerCase()) && isPlotShowOnly) {
      console.log(`Early return: plot/show command with gene/peak "${geneName}" → plot_gene_expression (no showPeakView)`);
      return {
        action: 'plot_gene_expression',
        params: { gene: geneName, showPeakView: false },
        confidence: 0.92,
        topK: []
      };
    }

    const isWhatIsGeneExpression = geneName && !stopwords.has(geneName.toLowerCase()) && /what\s+is\s+(?:the\s+)?(?:gene\s+)?expression\s+(?:for|of)\s+/i.test(trimmed);
    if (isWhatIsGeneExpression) {
      console.log(`Early return: what is gene expression for "${geneName}" → plot_gene_expression`);
      return {
        action: 'plot_gene_expression',
        params: { gene: geneName, showPeakView: false },
        confidence: 0.92,
        topK: []
      };
    }

    const isExpressionPlot = geneName && !stopwords.has(geneName.toLowerCase()) && /\bexpression\s+plot\b/i.test(trimmed);
    if (isExpressionPlot) {
      console.log(`Early return: expression plot "${geneName}" → plot_gene_expression`);
      return {
        action: 'plot_gene_expression',
        params: { gene: geneName, showPeakView: false },
        confidence: 0.92,
        topK: []
      };
    }

    const isExplicitClusterInfoQuery = /(?:what\s+(?:is|define|are|about)|tell\s+me\s+about|show\s+me\s+(?:about\s+)?cluster|describe|info|information|know\s+(?:more\s+)?about|do\s+you\s+know)\s+(?:anything\s+)?(?:about\s+)?cluster/i.test(userMessage);

    const isWhatAboutQuestion = /^what\s+about/i.test(userMessage.trim());

    const explicitFollowUpPatterns = [
      /^same\s+(?:to|for|with)\s+cluster/i,
      /^do\s+the\s+same\s+(?:to|for|with)\s+cluster/i,
      /^and\s+cluster/i,
      /^now\s+cluster/i,
    ];
    const isExplicitFollowUp = explicitFollowUpPatterns.some(p => p.test(userMessage.trim()));

    const showMeClusterMatch = userMessage.trim().match(/^show\s+me\s+(?:about\s+)?cluster\s+(\S+)/i);
    if (showMeClusterMatch && showMeClusterMatch[1]) {
      let cid = showMeClusterMatch[1].trim();
      const parsed = parseInt(cid, 10);
      if (!Number.isNaN(parsed)) {
        console.log('Detected "show me cluster" request, returning cluster_info for cluster', parsed);
        return { action: 'cluster_info', params: { cluster: parsed }, confidence: 0.95, topK: [] };
      }
      const labels = dataContext?.clusterLabels || {};
      const resolved = Object.keys(labels).find(k => String(labels[k]).toLowerCase() === cid.toLowerCase());
      if (resolved) {
        console.log('Detected "show me cluster" request, returning cluster_info for cluster', resolved);
        return { action: 'cluster_info', params: { cluster: parseInt(resolved, 10), originalLabel: cid }, confidence: 0.95, topK: [] };
      }
      console.log('Detected "show me cluster" but unknown cluster:', cid);
      return { action: 'cluster_info', params: { cluster: cid, originalLabel: cid }, confidence: 0.95, topK: [] };
    }

    const degBetweenMsg = userMessage.trim().toLowerCase();
    const degBetweenMatchMsg = userMessage.match(/(?:find\s+markers|deg|differential(?:\s+genes?)?|differentially\s+expressed)\s+(?:for\s+)?cluster\s+(\d+)\s+between\s+(.+?)\s+and\s+(.+?)(?=[.?!]?\s*$|$)/i)
      || userMessage.match(/(?:deg|differential(?:\s+genes?)?|differentially\s+expressed)\s+(?:for\s+)?cluster\s+(\d+)\s+between\s+(\S+)\s+and\s+(\S+)/i)
      || userMessage.match(/(?:deg|differential(?:\s+genes?)?)\s+(?:for\s+)?cluster\s+(\d+)\s+(\S+)\s+vs\.?\s+(\S+)/i)
      || userMessage.match(/cluster\s+(\d+)\s+between\s+(.+?)\s+and\s+(.+?)(?=[.?!]?\s*$|$)/i)
      || userMessage.match(/cluster\s+(\d+)\s+between\s+(\S+)\s+and\s+(\S+)/i)
      || userMessage.match(/cluster\s+(\d+)\s+(\S+)\s+vs\.?\s+(\S+)/i);
    if (degBetweenMatchMsg && (degBetweenMsg.includes('between') || degBetweenMsg.includes(' vs ') || degBetweenMsg.includes('deg') || degBetweenMsg.includes('differential') || degBetweenMsg.includes('marker'))) {
      const c = parseInt(degBetweenMatchMsg[1], 10);
      const sa = (degBetweenMatchMsg[2] || '').trim().replace(/[.?!]+$/, '');
      const sb = (degBetweenMatchMsg[3] || '').trim().replace(/[.?!]+$/, '');
      if (sa && sb && !Number.isNaN(c)) {
        console.log('Detected DEG between samples (classifyIntent):', { cluster: c, sample1: sa, sample2: sb });
        return {
          action: 'deg_between_samples',
          params: { cluster: c, sample1: sa, sample2: sb },
          confidence: 0.92,
          topK: []
        };
      }
    }

    if ((maxFollowUpSim > 0.6 || isExplicitFollowUp) && lastActionContext && clusterNum !== null && !isExplicitClusterInfoQuery && !isWhatAboutQuestion) {
      console.log(`Detected follow-up (similarity: ${maxFollowUpSim.toFixed(3)}, explicit: ${isExplicitFollowUp}), repeating: ${lastActionContext.action}`);

      const params = { ...lastActionContext.params, cluster: clusterNum };
      if (lastActionContext.action === 'rename_cluster' && lastActionContext.params.newLabel) {
        params.oldLabel = String(clusterNum);
        params.newLabel = lastActionContext.params.newLabel;
      }

      return {
        action: lastActionContext.action,
        params,
        confidence: 0.8,
        topK: []
      };
    }

    const hasChaining = /,\s*(?:and\s+)?then\s+/i.test(userMessage) ||
                       /(?:rename|change|set|call|label)\s+cluster\s+\d+\s+(?:to|as)\s+[^,]+?\s+and\s+cluster\s+\d+\s+(?:to|as)\s+/i.test(userMessage);

    if (hasChaining) {
      console.log('Intent model detected potential chaining, returning lower confidence to trigger chaining handler');
      return {
        action: 'NONE',
        confidence: 0.2,
        topK: [],
        params: {},
        _suggestChaining: true
      };
    }

    let intentScores = [];
    let ambiguous = false;

    const classifierProbs = scoreWithIntentModel(userEmbedding);
    if (classifierProbs) {
      const ranked = classifierProbs.slice().sort((a, b) => b.score - a.score);
      if (ranked[0].action === 'NONE' && ranked[0].score >= 0.5) {
        console.log(`Intent model: not a command (p=${ranked[0].score.toFixed(2)})`);
        return { action: 'NONE', params: {}, confidence: 0, topK: [] };
      }
      intentScores = ranked.filter((item) => item.action !== 'NONE');
      ambiguous = intentScores.length > 1 &&
        intentScores[0].score < AMBIGUITY_MAX_TOP &&
        intentScores[0].score - intentScores[1].score < AMBIGUITY_MARGIN;
    } else {
      for (const [action, embeddings] of Object.entries(intentEmbeddings)) {
        let maxSim = 0;
        for (const intentEmb of embeddings) {
          const similarity = cosineSimilarity(userEmbedding, intentEmb);
          maxSim = Math.max(maxSim, similarity);
        }
        if (maxSim > 0) {
          intentScores.push({ action, score: maxSim });
        }
      }
      intentScores.sort((a, b) => b.score - a.score);
    }

    let renameOldLabel = null;
    let renameNewLabel = null;
    let renameIsRegion = false;
    const renameRegionMatch2 = userMessage.match(/(?:rename|change|set|call|label|name)\s+region\s+(\S+)\s+(?:to|as)\s+["']?([^"'\n]+?)["']?\s*$/i);
    const renameMatch = userMessage.match(/(?:rename|change|set|call|label)\s+cluster\s+(\S+)(?:\s+(?:in|for|from)\s+(?:rna|atac|gene\s*expression|chromatin))?\s+(?:to|as)\s+["']?([^"'\n]+?)["']?\s*$/i);
    const parsedRename = parseRename(originalMessage, dataContext?.clusterLabels);
    if (parsedRename) {
      renameOldLabel = parsedRename.oldLabel;
      renameNewLabel = parsedRename.newLabel;
      renameIsRegion = parsedRename.kind === 'region';
    } else if (renameRegionMatch2 && renameRegionMatch2[1] && renameRegionMatch2[2]) {
      renameOldLabel = renameRegionMatch2[1].trim();
      renameNewLabel = renameRegionMatch2[2].trim();
      renameIsRegion = true;
    } else if (renameMatch && renameMatch[1] && renameMatch[2]) {
      renameOldLabel = renameMatch[1].trim();
      renameNewLabel = renameMatch[2].trim();
    }
    if (renameNewLabel && isChainedRenameLabel(renameNewLabel)) {
      renameOldLabel = null;
      renameNewLabel = null;
    }

    const parseNumber = (pattern) => {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        const value = parseFloat(match[1]);
        if (!Number.isNaN(value)) {
          return value;
        }
      }
      return null;
    };
    const parseNumberBefore = (pattern) => {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        const value = parseFloat(match[1]);
        if (!Number.isNaN(value)) {
          return value;
        }
      }
      return null;
    };

    const resolutionMatch = parseNumber(/resolution\s*(?:=|to)?\s*(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:resolution)/i);

    const pcaMatch = parseNumber(/(?:pca|principal\s+components?|pcs?)\s*(?:for\s+umap)?\s*(?:=|to|use)?\s*(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:pca|principal\s+components?|pcs?)(?:\s*for\s*umap)?/i);

    const minDistMatch = parseMinDist(userMessage) ?? parseNumber(/min(?:imum)?\s*dist(?:ance)?\s*(?:=|to|use)?\s*(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:min(?:imum)?\s*dist(?:ance)?)/i);
    const neighborMatch = parseNumber(/(?:k\s*=\s*|neighbors?\s*(?:=|to|use)?\s*)(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:neighbors?|nearest\s+neighbors?|k\s*neighbors?)/i);

    const geneThreshold = parseNumber(/(?:min(?:imum)?\s*genes?|genes?\s*detected)\s*(?:=|>=|>|at\s+least|more\s+than|over)?\s*(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:genes?\s*detected|min(?:imum)?\s*genes?)/i);
    const geneThresholdFromFilter = (() => {
      const direct = userMessage.match(/filter\s+cells[^0-9]*(?:>|>=)\s*(\d+(?:\.\d+)?)\s*genes?\s*detected/i);
      if (direct && direct[1]) {
        const value = parseFloat(direct[1]);
        if (!Number.isNaN(value)) {
          return value;
        }
      }
      return null;
    })();
    const parsedFilter = parseCellFilter(userMessage);
    const effectiveGeneThreshold = parsedFilter.detected_threshold ?? geneThreshold ?? geneThresholdFromFilter;
    const umiThreshold = parsedFilter.sum_threshold ?? parseNumber(/(?:umi(?:s)?|counts?)\s*(?:>=|>|at\s+least|more\s+than|over)?\s*(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:umis?|counts?)/i);
    const mitoThreshold = parsedFilter.mito_threshold ?? parseNumber(/mito(?:chondrial)?(?:\s*(?:percent|percentage|fraction))?\s*(?:<=|<|less\s+than|under)?\s*(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:mito(?:chondrial)?(?:\s*(?:percent|percentage|fraction))?)/i);

    let hvgMatch = parseHvgCount(userMessage) ?? parseNumber(/(?:variable\s+genes?|hvg(?:s)?)\s*(?:=|to|of)?\s*(\d+(?:\.\d+)?)/i);
    if (hvgMatch === null) {
      hvgMatch = parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:highly\s+variable\s+genes?|variable\s+genes?|hvg(?:s)?)/i);
    }

    const extractColorDirective = (text) => {
      const lower = text.toLowerCase();
      const knownColorSchemes = ['viridis', 'magma', 'inferno', 'plasma', 'cividis', 'turbo', 'cubehelix'];

      for (const scheme of knownColorSchemes) {
        if (lower.includes(scheme)) {
          return { type: 'scheme', name: scheme };
        }
      }

      let customMatch = text.match(/colou?rs?(?:\s?bar|\s?map)?(?:\s+use|\s+with|\s+to)?\s+([a-zA-Z,\s]+)/i);

      if (!customMatch) {
        customMatch = text.match(/(?:change|set|use|switch|update)\s+colou?rs?(?:\s?bar|\s?map)?\s+to\s+([a-zA-Z,\s]+)/i);
      }

      if (!customMatch) {
        customMatch = text.match(/colou?rs?(?:\s?bar|\s?map)?\s+([a-zA-Z,\s]+?)(?:\s+on|\s+for|\s+to|\s+with|$)/i);
      }

      if (customMatch && customMatch[1]) {
        const colors = customMatch[1]
          .split(/[\s,]+/)
          .map((c) => c.trim())
          .filter((c) => c.length > 0 && c.toLowerCase() !== 'and');
        if (colors.length >= 2) {
          return { type: 'custom', colors };
        }
      }

      if (lower.includes('blue') && lower.includes('white') && lower.includes('red')) {
        return { type: 'custom', colors: ['lightgray', 'orange', 'red'] };
      }

      return null;
    };

    const colorDirective = extractColorDirective(userMessage);

    const topKIntents = intentScores.slice(0, topK).map(item => {
      const params = {};
      if (!/\batac\b/i.test(userMessage)) {
        if (item.action === 'highlight_rna_cluster_on_atac' || item.action === 'highlight_atac_cluster_on_rna') item.action = 'highlight_cluster';
        if (item.action === 'clear_rna_highlight_on_atac' || item.action === 'clear_atac_highlight_on_rna') item.action = 'clear_cluster_highlight';
      }
      if (['find_markers', 'cluster_info', 'rename_cluster', 'highlight_cluster', 'highlight_rna_cluster_on_atac', 'highlight_atac_cluster_on_rna'].includes(item.action)) {
        if (clusterNum !== null) {
          params.cluster = clusterNum;
          if (mergedClusterIds && mergedClusterIds.length > 1 && item.action !== 'highlight_rna_cluster_on_atac' && item.action !== 'highlight_atac_cluster_on_rna') {
            params.clusters = mergedClusterIds;
            console.log(`Passing merged cluster IDs [${mergedClusterIds.join(', ')}] for ${item.action}`);
          }
        } else if (clusterLabel) {
          params.cluster = clusterLabel;
          console.log(`Passing unresolved cluster label "${clusterLabel}" as string parameter`);
        }
      }
      if (item.action === 'find_markers' && asksForPeakMarkers) {
        params.markerFeature = 'peak';
      }
      if (['plot_gene_expression', 'plot_gene_violin', 'impute_gene', 'show_peak_gene_links', 'link_peaks'].includes(item.action)) {
        if (geneName) params.gene = geneName;
      }
      if (item.action === 'plot_gene_dotplot') {
        let extractedGenes = entities.hasGeneList && entities.genes.length > 0
          ? entities.genes.map((g) => g.symbol)
          : null;

        const dotplotMatch = userMessage.match(/(?:dotplot|dot\s+plot)\s+(?:for|of)?\s*(.+)/i);
        if (!entities.hasGeneList && dotplotMatch && dotplotMatch[1]) {
          const afterDotplot = dotplotMatch[1].trim();

          const cleaned = afterDotplot.replace(/^genes?\s+/i, '').trim();

          if (cleaned.includes(',')) {
            const commaGenes = cleaned.split(',')
              .map(g => g.trim())
              .filter(g => g.length > 0 && !stopwords.has(g.toLowerCase()) && g.length >= 2);
            if (commaGenes.length > 0) {
              extractedGenes = commaGenes;
              console.log(`Extracted comma-separated genes for dotplot: ${extractedGenes.join(', ')}`);
            }
          }
          else if (/\s+and\s+/i.test(cleaned)) {
            const andGenes = cleaned.split(/\s+and\s+/i)
              .map(g => g.trim())
              .filter(g => g.length > 0 && !stopwords.has(g.toLowerCase()) && g.length >= 2);
            if (andGenes.length > 0) {
              extractedGenes = andGenes;
              console.log(`Extracted and-separated genes for dotplot: ${extractedGenes.join(', ')}`);
            }
          }
          else {
            const spaceGenes = cleaned.split(/\s+/)
              .map(g => g.trim())
              .filter(g => g.length > 0 && !stopwords.has(g.toLowerCase()) && g.length >= 2);

            if (spaceGenes.length > 1) {
              extractedGenes = spaceGenes;
              console.log(`Extracted space-separated genes for dotplot: ${extractedGenes.join(', ')}`);
            } else if (spaceGenes.length === 1) {
              extractedGenes = spaceGenes;
              console.log(`Extracted single gene for dotplot: ${extractedGenes[0]}`);
            }
          }
        }

        if (!extractedGenes && geneName) {
          extractedGenes = [geneName];
          console.log(`Using geneName fallback for dotplot: ${geneName}`);
        }

        if (extractedGenes && extractedGenes.length > 0) {
          params.genes = extractedGenes;
          console.log(`Final genes for dotplot: ${extractedGenes.join(', ')}`);
        }
      }
      if (item.action === 'rename_cluster' || item.action === 'rename_region') {
        if (renameOldLabel && renameNewLabel) {
          params.oldLabel = renameOldLabel;
          params.newLabel = renameNewLabel;
          if (/^\d+$/.test(renameOldLabel)) params.cluster = Number(renameOldLabel);
          if (renameIsRegion && item.action === 'rename_cluster') {
            item.action = 'rename_region';
          }
          if (!renameIsRegion && item.action === 'rename_region' && !/\bregions?\b/i.test(userMessage)) {
            item.action = 'rename_cluster';
          }
        }
      }
      if (['cluster_and_visualize', 'update_clustering_resolution'].includes(item.action)) {
        if (resolutionMatch !== null) {
          params.resolution = resolutionMatch;
          const lower = userMessage.toLowerCase();
          const usesLeiden = lower.includes('leiden');
          const usesWalktrap = lower.includes('walktrap');
          params.algorithm = usesLeiden ? 'leiden' : usesWalktrap ? 'walktrap' : 'multilevel';
        }
      }
      if (['run_umap', 'cluster_and_visualize'].includes(item.action)) {
        if (pcaMatch !== null) {
          params.num_pcs = pcaMatch;
        }
        if (minDistMatch !== null || neighborMatch !== null) {
          if (minDistMatch !== null) params.min_dist = minDistMatch;
          if (neighborMatch !== null) params.num_neighbors = neighborMatch;
        }
      }
      if (item.action === 'deg_between_samples') {
        if (clusterNum !== null) params.cluster = clusterNum;
        const pair = parseSamplePair(originalMessage, dataContext?.sampleNames);
        if (pair) Object.assign(params, pair);
      }
      if (item.action === 'region_composition') {
        const regionMatch = userMessage.match(/\bregion\s*#?\s*(\d+)/i);
        if (regionMatch) params.regionId = Number(regionMatch[1]);
      }
      if (item.action === 'tf_motif_analysis' && clusterNum !== null) {
        params.cluster = clusterNum;
      }
      if (item.action === 'set_colormap') {
        if (colorDirective) {
          params.colorMap = colorDirective;
        }
      }
      if (['plot_gene_expression', 'plot_gene_dotplot'].includes(item.action) && colorDirective) {
        params.colorMap = colorDirective;
      }
      if (item.action === 'update_cell_filtering') {
        if (effectiveGeneThreshold !== null) {
          params.detected_threshold = effectiveGeneThreshold;
        }
        if (umiThreshold !== null) {
          params.sum_threshold = umiThreshold;
        }
        if (mitoThreshold !== null) {
          params.mito_threshold = mitoThreshold;
        }
      }
      if (item.action === 'update_variable_genes') {
        if (hvgMatch !== null) {
          params.num_hvgs = hvgMatch;
        }
      }
      if (item.action === 'update_pca_for_umap') {
        if (pcaMatch !== null) {
          params.num_pcs = pcaMatch;
        }
      }
      if (item.action === 'update_umap_parameters') {
        if (minDistMatch !== null) {
          params.min_dist = minDistMatch;
        }
        if (neighborMatch !== null) {
          params.num_neighbors = neighborMatch;
        }
      }
      if (item.action === 'region_segmentation') {
        const lambdaMatch = parseNumber(/lambda\s*(?:=|to|of)?\s*(\d+(?:\.\d+)?)/i) ??
          parseNumberBefore(/(\d+(?:\.\d+)?)\s*lambda/i);
        if (resolutionMatch !== null) params.resolution = resolutionMatch;
        if (lambdaMatch !== null) params.lambda = lambdaMatch;
        if (neighborMatch !== null) params.numNeighbors = neighborMatch;
      }
      if (item.action === 'show_parameters') {
        const parsedStep = parseParameterStep(userMessage);
        if (parsedStep) params.step = parsedStep;
        const lower = parsedStep ? '' : userMessage.toLowerCase();
        if (lower.includes('cell filter') || lower.includes('cell quality') || lower.includes('qc')) {
          params.step = 'cellFiltering';
        } else if (lower.includes('gene filter')) {
          params.step = 'geneFiltering';
        } else if (lower.includes('variable gene') || lower.includes('hvg') || lower.includes('feature selection')) {
          params.step = 'featureSelection';
        } else if (lower.includes('pca') || lower.includes('principal component')) {
          params.step = 'pca';
        } else if (lower.includes('cluster') && !lower.includes('umap')) {
          params.step = 'clustering';
        } else if (lower.includes('umap') || lower.includes('embedding')) {
          params.step = 'umap';
        }
      }

      return {
        action: item.action,
        params,
        confidence: item.score
      };
    })
      .filter((item, i, all) => all.findIndex((o) => o.action === item.action) === i);

    if (topKIntents.length === 0) {
      console.log('No intents found, returning NONE');
      return { action: 'NONE', confidence: 0, topK: [] };
    }

    const bestIntent = topKIntents[0];
    console.log(`Best match: ${bestIntent.action} (similarity: ${bestIntent.confidence.toFixed(3)})`);

    if (bestIntent.confidence < 0.3) {
      console.log('Similarity too low (< 0.3), returning NONE');
      return { action: 'NONE', confidence: bestIntent.confidence, topK: topKIntents };
    }

    const requiresGene = ['plot_gene_expression', 'plot_gene_violin'].includes(bestIntent.action);
    if (requiresGene) {
      if (!bestIntent.params.gene) {
        console.log(`Action ${bestIntent.action} requires a gene but none found`);
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        console.log(`Action ${bestIntent.action} has gene parameter (${bestIntent.params.gene}) - boosting confidence`);
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    if (bestIntent.action === 'plot_gene_dotplot') {
      if (!bestIntent.params.genes || !Array.isArray(bestIntent.params.genes) || bestIntent.params.genes.length === 0) {
        console.log(`Action ${bestIntent.action} requires genes but none found`);
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        console.log(`Action ${bestIntent.action} has genes parameter (${bestIntent.params.genes.join(', ')}) - boosting confidence`);
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    if (bestIntent.action === 'rename_cluster' || bestIntent.action === 'rename_region') {
      if (renameIsRegion && bestIntent.action === 'rename_cluster') {
        bestIntent.action = 'rename_region';
      }
      if (!bestIntent.params.oldLabel || !bestIntent.params.newLabel) {
        console.log(`Action ${bestIntent.action} requires oldLabel and newLabel but they were not found`);
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      }
    }

    if (bestIntent.action === 'set_colormap') {
      if (!bestIntent.params.colorMap) {
        console.log(`Action ${bestIntent.action} requires colorMap but none found`);
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        console.log(`Action ${bestIntent.action} has colorMap parameter - boosting confidence`);
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    if (bestIntent.action === 'update_cell_filtering') {
      const hasParams = bestIntent.params.detected_threshold != null ||
                       bestIntent.params.sum_threshold != null ||
                       bestIntent.params.mito_threshold != null;
      if (!hasParams) {
        console.log(`Action ${bestIntent.action} requires at least one filtering parameter but none found`);
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        console.log(`Action ${bestIntent.action} has filtering parameters - boosting confidence`);
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    if (bestIntent.action === 'update_variable_genes') {
      if (bestIntent.params.num_hvgs == null) {
        console.log(`Action ${bestIntent.action} requires num_hvgs but none found`);
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        console.log(`Action ${bestIntent.action} has num_hvgs parameter (${bestIntent.params.num_hvgs}) - boosting confidence`);
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    if (bestIntent.action === 'update_clustering_resolution') {
      if (bestIntent.params.resolution == null) {
        console.log(`Action ${bestIntent.action} requires resolution but none found`);
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        console.log(`Action ${bestIntent.action} has resolution parameter (${bestIntent.params.resolution}) - boosting confidence`);
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    if (bestIntent.action === 'update_pca_for_umap') {
      if (bestIntent.params.num_pcs == null) {
        console.log(`Action ${bestIntent.action} requires num_pcs but none found`);
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        console.log(`Action ${bestIntent.action} has num_pcs parameter (${bestIntent.params.num_pcs}) - boosting confidence`);
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    if (bestIntent.action === 'update_umap_parameters') {
      const hasParams = bestIntent.params.min_dist != null ||
                       bestIntent.params.num_neighbors != null;
      if (!hasParams) {
        console.log(`Action ${bestIntent.action} requires at least one UMAP parameter but none found`);
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        console.log(`Action ${bestIntent.action} has UMAP parameters - boosting confidence`);
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    if (bestIntent.action === 'highlight_rna_cluster_on_atac' || bestIntent.action === 'highlight_atac_cluster_on_rna') {
      const direction = parseHighlightDirection(userMessage);
      if (direction === 'rna_on_atac') bestIntent.action = 'highlight_rna_cluster_on_atac';
      if (direction === 'atac_on_rna') bestIntent.action = 'highlight_atac_cluster_on_rna';
    }

    if ((bestIntent.action === 'region_composition' && bestIntent.params.regionId == null) ||
        (bestIntent.action === 'tf_motif_analysis' && bestIntent.params.cluster == null)) {
      bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
    }

    const hasRerunKeyword = /rerun|re-run|reanalyze|re-analyze|recalculate|re-calculate/i.test(userMessage);
    if (hasRerunKeyword && (effectiveGeneThreshold !== null || umiThreshold !== null || mitoThreshold !== null)) {
      const cellFilteringIntent = topKIntents.find(item => item.action === 'update_cell_filtering');
      if (cellFilteringIntent) {
        console.log('Detected rerun with cell filtering parameters - using update_cell_filtering');
        bestIntent.action = 'update_cell_filtering';
        bestIntent.params = cellFilteringIntent.params;
        bestIntent.confidence = Math.max(cellFilteringIntent.confidence, 0.75);
      }
    }

    if (bestIntent.action === 'cluster_and_visualize' && bestIntent.params.resolution) {
      console.log(`Changing action from cluster_and_visualize to update_clustering_resolution (resolution=${bestIntent.params.resolution})`);
      bestIntent.action = 'update_clustering_resolution';
    }

    if (bestIntent.action === 'cluster_and_visualize') {
      const hasResolutionMention = /resolution\s*(?:=|to)?\s*\d+/i.test(userMessage) || /\d+\s*resolution/i.test(userMessage);
      if (hasResolutionMention && !bestIntent.params.resolution) {
        console.log(`Action ${bestIntent.action} mentions resolution but parameter was not extracted`);
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.4);
      }
    }

    const runnerUp = topKIntents[1];
    if (ambiguous && bestIntent.action === intentScores[0].action && runnerUp &&
        intentScores[0].score - runnerUp.confidence < AMBIGUITY_MARGIN) {
      console.log(`Ambiguous: ${intentScores[0].action} vs ${runnerUp.action} - asking the user`);
      bestIntent.confidence = Math.min(bestIntent.confidence, 0.45);
    }

    return {
      action: bestIntent.confidence < 0.5 ? 'NONE' : bestIntent.action,
      params: bestIntent.params,
      confidence: bestIntent.confidence,
      topK: topKIntents
    };

  } catch (error) {
    console.error('WebLLM classification failed:', error);
    return null;
  }
}

export function classifyIntentSimple(userMessage) {
  userMessage = preprocessUserInput(userMessage);
  const lower = userMessage.toLowerCase();

  const isWNNSimple =
    /\bwnn\b/.test(lower) ||
    /\bweighted\s+nearest\s+neighbor/.test(lower) ||
    /integrate\s+(?:the\s+)?(?:rna\s+and\s+atac|atac\s+and\s+rna)/i.test(lower) ||
    /\bmultimodal\s+integrat/i.test(lower) ||
    /\bco[\s-]?embed/i.test(lower) ||
    /\bjoint\s+(?:umap|embedding|analysis)\b/i.test(lower);
  if (isWNNSimple) {
    return { action: 'wnn_integrate', params: {}, confidence: 0.95, topK: [] };
  }

  const genePatterns = [
    /(?:plot|show)\s+(?:me\s+)?(?:gene\s+)?(chr\w+:\d+-\d+)/i,
    /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,
    /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+([A-Za-z0-9-]+)/i,
    /(?:plot|show)\s+(?:me\s+)?gene\s+([A-Za-z0-9-]+)/i,
    /(?:show|plot)\s+me\s+([A-Za-z0-9-]+)/i,
    /(?:show|plot)\s+([A-Za-z0-9-]+)(?:\s|$|\.|,)/i,
    /what\s+is\s+(?:the\s+)?(?:gene\s+)?expression\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,
    /([A-Za-z0-9-]+)\s+expression\s+plot/i,
    /^(?:plot|show)\s+(?:me\s+)?([A-Za-z0-9-]+)\s*$/i,
    /violin\s+(?:plot\s+)?(?:for\s+)?([A-Za-z0-9-]+)/i,
    /([A-Za-z0-9-]+)\s+violin(?:\s+plot)?/i,
    /(?:dotplot|dot\s+plot)\s+(?:for\s+)?([A-Za-z0-9-]+)/i,
    /([A-Za-z0-9-]+)\s+(?:dotplot|dot\s+plot)/i,
    /gene\s+([A-Za-z0-9-]+)/i,
    /\b([A-Z][a-z0-9]+[A-Z0-9]*[a-z0-9]*)\b/,
    /\b([A-Za-z][A-Za-z0-9]+)\b/,
  ];
  const stopwords = new Set(['gene', 'genes', 'plot', 'violin', 'dotplot', 'dot', 'show', 'me', 'the', 'for', 'of', 'cluster', 'clusters', 'please', 'activity', 'fraction', 'proportion', 'umap', 'embedding', 'cell', 'cells']);
  let geneName = null;
  for (const pattern of genePatterns) {
    const match = userMessage.match(pattern);
    if (match && match[1] && !stopwords.has(match[1].toLowerCase()) && match[1].length >= 2) {
      geneName = match[1];
      break;
    }
  }

  let clusterNum = null;
  const clusterPatterns = [
    /cluster\s+(\d+)/i,
    /(\d+)\s*$/,
    /^(\d+)$/,
    /about\s+(\d+)/i,
    /for\s+(\d+)/i,
  ];

  for (const pattern of clusterPatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      clusterNum = parseInt(match[1]);
      break;
    }
  }

  const followUpPatterns = [
    /^same\s+(?:to|for|with)/i,
    /^do\s+the\s+same\s+(?:to|for|with)/i,
    /^and\s+(?:for\s+)?(?:cluster\s+)?(\d+)/i,
    /^now\s+(?:for\s+)?(?:cluster\s+)?(\d+)/i,
    /^(?:cluster\s+)?(\d+)\??$/i,
    /^what\s+about\s+(?!cluster)/i,
    /^how\s+about\s+(?!cluster)/i,
  ];

  const isFollowUp = followUpPatterns.some(p => p.test(lower));

  const isExplicitClusterInfoQuery = /(?:what\s+(?:is|define|are|about)|tell\s+me\s+about|show\s+me\s+(?:about\s+)?cluster|describe|info|information|know\s+(?:more\s+)?about|do\s+you\s+know)\s+(?:anything\s+)?(?:about\s+)?cluster/i.test(userMessage);

  const isWhatAboutCluster = /^what\s+about\s+cluster/i.test(lower);
  const isShowMeCluster = /^show\s+me\s+(?:about\s+)?cluster/i.test(lower);

  if (isFollowUp && lastActionContext && clusterNum !== null && !isExplicitClusterInfoQuery && !isWhatAboutCluster && !isShowMeCluster) {
    console.log('Detected follow-up question, repeating last action:', lastActionContext.action);

    const params = { ...lastActionContext.params, cluster: clusterNum };
    if (lastActionContext.action === 'rename_cluster' && lastActionContext.params.newLabel) {
      params.oldLabel = String(clusterNum);
      params.newLabel = lastActionContext.params.newLabel;
    }

    return {
      action: lastActionContext.action,
      params
    };
  }

  if ((isWhatAboutCluster || isShowMeCluster) && clusterNum !== null) {
    console.log('Detected cluster info question (what/show cluster), treating as cluster_info');
    return {
      action: 'cluster_info',
      params: { cluster: clusterNum }
    };
  }

  const clearRnaHighlightMatch = /clear\s+RNA\s+highlight\s+on\s+ATAC/i.test(lower);
  if (clearRnaHighlightMatch) {
    return { action: 'clear_rna_highlight_on_atac', params: {} };
  }
  const showRnaClusterOnAtacMatch = lower.match(/show\s+(?:the\s+)?cells\s+in\s+cluster\s+(\S+)\s+from\s+RNA\s+on\s+ATAC/i)
    || lower.match(/highlight\s+RNA\s+cluster\s+(\S+)\s+on\s+ATAC/i)
    || lower.match(/show\s+RNA\s+cluster\s+(\S+)\s+on\s+ATAC/i)
    || lower.match(/highlight\s+cells\s+in\s+cluster\s+(\S+)\s+from\s+RNA\s+on\s+ATAC/i);
  if (showRnaClusterOnAtacMatch && showRnaClusterOnAtacMatch[1]) {
    const clusterParam = showRnaClusterOnAtacMatch[1].trim();
    const asNum = parseInt(clusterParam, 10);
    return {
      action: 'highlight_rna_cluster_on_atac',
      params: { cluster: Number.isNaN(asNum) ? clusterParam : asNum }
    };
  }

  const clearAtacHighlightMatch = /clear\s+ATAC\s+highlight\s+on\s+RNA/i.test(lower);
  if (clearAtacHighlightMatch) {
    return { action: 'clear_atac_highlight_on_rna', params: {} };
  }
  const showAtacClusterOnRnaMatch = lower.match(/show\s+(?:the\s+)?cells\s+in\s+cluster\s+(\S+)\s+from\s+ATAC\s+on\s+RNA/i)
    || lower.match(/highlight\s+ATAC\s+cluster\s+(\S+)\s+on\s+RNA/i)
    || lower.match(/show\s+ATAC\s+cluster\s+(\S+)\s+on\s+RNA/i)
    || lower.match(/highlight\s+cells\s+in\s+cluster\s+(\S+)\s+from\s+ATAC\s+on\s+RNA/i);
  if (showAtacClusterOnRnaMatch && showAtacClusterOnRnaMatch[1]) {
    const clusterParam = showAtacClusterOnRnaMatch[1].trim();
    const asNum = parseInt(clusterParam, 10);
    return {
      action: 'highlight_atac_cluster_on_rna',
      params: { cluster: Number.isNaN(asNum) ? clusterParam : asNum }
    };
  }

  const degBetweenMatch = lower.match(/(?:find\s+markers|deg|differential(?:\s+genes?)?|differentially\s+expressed)\s+(?:for\s+)?cluster\s+(\d+)\s+between\s+(.+?)\s+and\s+(.+?)(?=[.?!]?\s*$|$)/i)
    || lower.match(/(?:deg|differential(?:\s+genes?)?|differentially\s+expressed)\s+(?:for\s+)?cluster\s+(\d+)\s+between\s+(\S+)\s+and\s+(\S+)/i)
    || lower.match(/(?:deg|differential(?:\s+genes?)?)\s+(?:for\s+)?cluster\s+(\d+)\s+(\S+)\s+vs\.?\s+(\S+)/i)
    || lower.match(/cluster\s+(\d+)\s+between\s+(.+?)\s+and\s+(.+?)(?=[.?!]?\s*$|$)/i)
    || lower.match(/cluster\s+(\d+)\s+between\s+(\S+)\s+and\s+(\S+)/i)
    || lower.match(/cluster\s+(\d+)\s+(\S+)\s+vs\.?\s+(\S+)/i);
  if (degBetweenMatch && (lower.includes('between') || lower.includes('vs') || lower.includes('deg') || lower.includes('differential') || lower.includes('marker'))) {
    const c = parseInt(degBetweenMatch[1], 10);
    const sa = (degBetweenMatch[2] || '').trim().replace(/[.?!]+$/, '');
    const sb = (degBetweenMatch[3] || '').trim().replace(/[.?!]+$/, '');
    if (sa && sb) {
      console.log('Detected DEG between samples:', { cluster: c, sample1: sa, sample2: sb });
      return {
        action: 'deg_between_samples',
        params: { cluster: c, sample1: sa, sample2: sb },
        confidence: 0.9,
        topK: []
      };
    }
  }

  if (lower.includes('marker') || lower.includes('top genes') || lower.includes('deg')) {
    return { action: 'find_markers', params: { cluster: clusterNum } };
  }

  if (lower.includes('violin')) {
    return { action: 'plot_gene_violin', params: { gene: geneName } };
  }

  if (lower.includes('dotplot') || lower.includes('dot plot')) {
    if (geneName) {
      return { action: 'plot_gene_dotplot', params: { genes: [geneName] } };
    }
  }

  if ((lower.includes('tell me about') || lower.includes('show me about') || lower.includes('show me cluster') || lower.includes('what is') || lower.includes('what define') || lower.includes('describe')) && clusterNum !== null) {
    return { action: 'cluster_info', params: { cluster: clusterNum } };
  }

  if ((lower.includes('plot') || lower.includes('show')) && (lower.includes('cell fraction') || lower.includes('cell proportion') || /\b(?:plot|show)\s+(?:cell\s+)?fraction\b/.test(lower))) {
    return { action: 'plot_cell_fraction', params: {}, confidence: 0.9, topK: [] };
  }
  if (lower.includes('cell fraction') || lower.includes('cell proportion')) {
    return { action: 'plot_cell_fraction', params: {}, confidence: 0.9, topK: [] };
  }

  if (/\bregions?\b/.test(lower) && (lower.includes('plot') || lower.includes('show') || lower.includes('display') || lower.includes('color') || /\bwhat\s+region/.test(lower) || /\bhow\s+many\s+region/.test(lower))) {
    return { action: 'show_regions', params: {}, confidence: 0.9, topK: [] };
  }

  if (lower.includes('umap') || lower.includes('embedding')) {
    return { action: 'run_umap', params: {} };
  }
  if ((lower.includes('plot') || lower.includes('show')) && (lower.includes('cluster') || lower.includes('cell type') || lower.includes('cell clusters'))) {
    return { action: 'cluster_and_visualize', params: {} };
  }

  if ((lower.includes('expression') || (lower.includes('plot') && !lower.includes('dotplot')) || lower.includes('show'))) {
    if (geneName) {
      return { action: 'plot_gene_expression', params: { gene: geneName, showPeakView: false } };
    }
  }
  if (lower.includes('cluster') && (lower.includes('run') || lower.includes('analyze'))) {
    return { action: 'cluster_and_visualize', params: {} };
  }

  if (lower.includes('qc') || lower.includes('quality')) {
    return { action: 'run_qc', params: {} };
  }

  if (lower.includes('rename') && lower.includes('region')) {
    return { action: 'rename_region', params: { cluster: clusterNum } };
  }
  if (lower.includes('rename')) {
    return { action: 'rename_cluster', params: { cluster: clusterNum } };
  }

  if (lower.includes('parameter') || lower.includes('setting')) {
    let step = null;
    if (lower.includes('cell filter') || lower.includes('cell quality') || lower.includes('qc')) {
      step = 'cellFiltering';
    } else if (lower.includes('gene filter')) {
      step = 'geneFiltering';
    } else if (lower.includes('variable gene') || lower.includes('hvg') || lower.includes('feature selection')) {
      step = 'featureSelection';
    } else if (lower.includes('pca') || lower.includes('principal component')) {
      step = 'pca';
    } else if (lower.includes('cluster') && !lower.includes('umap')) {
      step = 'clustering';
    } else if (lower.includes('umap') || lower.includes('embedding')) {
      step = 'umap';
    }
    return { action: 'show_parameters', params: step ? { step } : {} };
  }

  return { action: 'unknown' };
}

export function getUnknownResponseMessage() {
  return `I'm not sure what you're asking for. Here are some things I can help with:

• **Find markers**: "find markers for cluster 1" or "top genes for cluster 3"
• **Cluster info**: "tell me about cluster 2" or "what is cluster 5"
• **Plot genes**: "plot Cd4 expression" or "show Foxp3"
• **Violin plots**: "violin plot for Gapdh"
• **Clustering**: "cluster the cells" or "run UMAP"
• **Rename clusters**: "rename cluster 1 to T cells"

Try asking in a different way!`;
}

export async function unloadModel() {
  embedder = null;
  intentEmbeddings = null;
  followUpEmbeddings = null;
  currentEmbeddingModelId = null;
}

const webllmService = {
  checkWebLLMAvailable,
  isModelCached,
  downloadModel,
  getCurrentModel,
  isModelLoaded,
  classifyIntent,
  classifyIntentSimple,
  getUnknownResponseMessage,
  unloadModel,
  setLastActionContext,
  getLastActionContext,
  checkWebGPUAvailable,
  getAvailableChatModels,
  downloadChatModel,
  isChatModelLoaded,
  getCurrentChatModel,
  generateChatResponse,
  unloadChatModel,
};

export default webllmService;
