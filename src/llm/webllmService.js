/**
 * WebLLM Service: Browser-based LLM for intent classification and chat
 *
 * Uses @xenova/transformers with semantic similarity for intent classification.
 * Uses @mlc-ai/web-llm for generative chat responses (Qwen2.5-1.5B).
 * This hybrid approach provides fast intent matching + conversational fallback.
 */

import { pipeline, env } from '@xenova/transformers';
import * as webllm from '@mlc-ai/web-llm';
import { generateApiChatResponse, isApiConfigured } from './apiChatService';

// Configure transformers.js to use local cache
env.allowLocalModels = false;
env.useBrowserCache = true;
// Force single-threaded ONNX, multi-threaded blob workers crash in Electron
// with COEP headers set (ReferenceError: B is not defined in blob:file:/// workers).
env.backends.onnx.wasm.numThreads = 1;

// ============================================================================
// TYPO TOLERANCE UTILITIES
// ============================================================================

/**
 * Levenshtein distance: measures edit distance between two strings
 * Used for fuzzy matching keywords
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;

  // Create a 2D array to store distances
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  // Initialize first row and column
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill the rest of the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        );
      }
    }
  }

  return dp[m][n];
}

/**
 * Check if a word fuzzy-matches a target keyword
 * Allows up to maxDistance edits based on word length:
 * Words < 4 chars: no fuzzy matching (exact only)
 * Words 4-5 chars: allow 1 edit
 * Words >= 6 chars: allow 2 edits
 */
function fuzzyMatch(word, target, maxDistance = null) {
  if (!word || !target) return false;

  const w = word.toLowerCase();
  const t = target.toLowerCase();

  // Exact match
  if (w === t) return true;

  // Calculate max allowed distance based on word length if not specified
  if (maxDistance === null) {
    // Be stricter for short words to avoid false positives (e.g., "cell" → "tell")
    if (t.length < 4) {
      return false; // No fuzzy matching for very short keywords
    } else if (t.length <= 5) {
      maxDistance = 1;
    } else {
      maxDistance = 2;
    }
  }

  // Skip if lengths are too different
  if (Math.abs(w.length - t.length) > maxDistance) return false;

  return levenshteinDistance(w, t) <= maxDistance;
}

/**
 * Keywords that should be fuzzy-matched in user input
 */
const FUZZY_KEYWORDS = [
  'cluster', 'clusters', 'violin', 'dotplot', 'umap', 'expression',
  'markers', 'marker', 'rename', 'recluster', 'rerun', 'resolution',
  'parameters', 'parameter', 'settings', 'filtering', 'filter',
  'genes', 'gene', 'plot', 'show', 'find', 'tell', 'about',
  'cell', 'cells', 'color', 'colors', 'min', 'dist', 'list', 'qc',
  'spatial', 'tissue', 'coordinates'
];

/**
 * Pre-process user input for better matching:
 * 1. Strip trailing punctuation
 * 2. Normalize whitespace
 * 3. Fix common typos using fuzzy matching
 */
function preprocessUserInput(text) {
  if (!text) return '';

  let processed = text.trim();

  // Strip trailing punctuation (but keep internal punctuation like hyphens in gene names)
  processed = processed.replace(/[,.?!;:]+$/, '');

  // Normalize multiple spaces to single space
  processed = processed.replace(/\s+/g, ' ');

  // Fix typos in keywords using fuzzy matching
  // For rename commands, skip typo correction on the new label (text after "to"/"as")
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
    charIdx += word.length + 1; // +1 for the space separator

    // Skip typo correction for the new label portion of rename commands
    if (labelStartIdx !== -1 && wordStart >= labelStartIdx) {
      return word;
    }

    // Skip short words, numbers, and words with special characters
    if (word.length < 3 || /^\d+$/.test(word) || /[^a-zA-Z]/.test(word)) {
      return word;
    }

    const lowerWord = word.toLowerCase();

    // FIRST: Check ALL keywords for exact match (prevents "cell" → "tell" issue)
    for (const keyword of FUZZY_KEYWORDS) {
      if (lowerWord === keyword) {
        // Exact match, no correction needed
        return word;
      }
    }

    // THEN: Check for fuzzy matches (only if no exact match found)
    for (const keyword of FUZZY_KEYWORDS) {
      if (fuzzyMatch(lowerWord, keyword)) {
        // Typo detected, replace with correct keyword (preserve case of first letter)
        const corrected = word[0] === word[0].toUpperCase()
          ? keyword.charAt(0).toUpperCase() + keyword.slice(1)
          : keyword;
        return corrected;
      }
    }

    return word;
  });

  return correctedWords.join(' ');
}

// Intent templates with example phrases for each action
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

// Follow-up patterns
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

// Embedding model options: using sentence transformers that work well
const EMBEDDING_MODEL_MAP = {
  'all-minilm-l6': 'Xenova/all-MiniLM-L6-v2',  // 22MB, fast, good quality
  'bge-small': 'Xenova/bge-small-en-v1.5',     // 33MB, better quality
  'gte-small': 'Xenova/gte-small',              // 33MB, excellent quality
};

// Chat model options: using MLC WebLLM for generative responses
const CHAT_MODEL_MAP = {
  'qwen2.5-1.5b': 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',  // ~1GB, good quality
  'qwen2.5-0.5b': 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',  // ~0.5GB, faster
  'llama-3.2-1b': 'Llama-3.2-1B-Instruct-q4f16_1-MLC',  // ~0.7GB, good quality
  'smollm2-360m': 'SmolLM2-360M-Instruct-q4f16_1-MLC',  // ~360MB, fast
};

// API-based chat models (no local download required)
const API_CHAT_MODELS = ['chatgpt', 'claude', 'gemini', 'groq', 'openrouter'];

// State management: Embedding model (for intent classification)
let currentEmbeddingModelId = null;
let isEmbeddingLoading = false;
let embedder = null;
let intentEmbeddings = null;  // Pre-computed embeddings for intents
let followUpEmbeddings = null;  // Pre-computed embeddings for follow-up patterns

// State management: Chat model (for conversational responses)
let currentChatModelId = null;
let isChatLoading = false;
let chatEngine = null;

// Store last action context for follow-up questions
let lastActionContext = null;

/**
 * Compute cosine similarity between two vectors
 */
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

/**
 * Update the last action context (call this after successful command execution)
 */
export function setLastActionContext(action, params) {
  lastActionContext = { action, params };
}

/**
 * Get the last action context
 */
export function getLastActionContext() {
  return lastActionContext;
}

/**
 * Check if WebLLM is available (browser supports WebGPU/WASM)
 */
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

/**
 * Check if an embedding model is already downloaded/cached
 */
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

/** Yield to main thread so UI can update (avoids "frozen" during pre-compute) */
function yieldToMain() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Pre-compute embeddings for all intent examples.
 * Yields to the main thread periodically so the UI stays responsive.
 */
async function precomputeIntentEmbeddings() {
  if (!embedder) return;

  intentEmbeddings = {};
  let count = 0;
  const YIELD_EVERY = 5; // yield every N examples so UI doesn't freeze

  for (const [action, data] of Object.entries(INTENT_TEMPLATES)) {
    intentEmbeddings[action] = [];
    for (const example of data.examples) {
      const result = await embedder(example, { pooling: 'mean', normalize: true });
      intentEmbeddings[action].push(Array.from(result.data));
      count++;
      if (count % YIELD_EVERY === 0) await yieldToMain();
    }
  }

  // Also compute follow-up embeddings
  followUpEmbeddings = [];
  for (const example of FOLLOW_UP_EXAMPLES) {
    const result = await embedder(example, { pooling: 'mean', normalize: true });
    followUpEmbeddings.push(Array.from(result.data));
    count++;
    if (count % YIELD_EVERY === 0) await yieldToMain();
  }

}

/**
 * Download and initialize an embedding model (for intent classification)
 */
export async function downloadModel(modelId, progressCallback = null) {
  if (isEmbeddingLoading) {
    console.warn('Embedding model download already in progress');
    return false;
  }

  isEmbeddingLoading = true;

  try {
    // Default to the smallest, fastest model
    let hfModelId = EMBEDDING_MODEL_MAP[modelId] || EMBEDDING_MODEL_MAP['all-minilm-l6'];


    if (progressCallback) progressCallback(5);

    // Create feature extraction (sentence embedding) pipeline
    embedder = await pipeline('feature-extraction', hfModelId, {
      progress_callback: (progress) => {
        if (progressCallback && progress.progress) {
          const scaled = 5 + (progress.progress * 0.7);  // 5-75%
          progressCallback(Math.round(scaled));
        }
      },
      quantized: true,
    });

    if (progressCallback) progressCallback(80);

    // Pre-compute intent embeddings
    await precomputeIntentEmbeddings();

    currentEmbeddingModelId = modelId;

    if (progressCallback) progressCallback(100);

    return true;

  } catch (error) {
    console.error('Model download failed:', error);
    return false;
  } finally {
    isEmbeddingLoading = false;
  }
}

/**
 * Get the currently loaded embedding model ID
 */
export function getCurrentModel() {
  return currentEmbeddingModelId;
}

/**
 * Check if embedding model is loaded and ready
 */
export function isModelLoaded() {
  return embedder !== null && intentEmbeddings !== null;
}

// ============================================================================
// CHAT MODEL FUNCTIONS (for conversational responses)
// ============================================================================

/**
 * Get available chat models
 */
export function getAvailableChatModels() {
  return Object.entries(CHAT_MODEL_MAP).map(([id, mlcId]) => ({
    id,
    mlcId,
    name: id.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
  }));
}

/**
 * Check if WebGPU is available (required for chat models)
 */
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

/**
 * Download and initialize a chat model (for conversational responses)
 * Supports both local WebLLM models and API-based models
 */
export async function downloadChatModel(modelId, progressCallback = null) {
  if (isChatLoading) {
    console.warn('Chat model download already in progress');
    return false;
  }

  // Check if this is an API-based model
  if (API_CHAT_MODELS.includes(modelId)) {
    // API models don't need downloading, just check if configured
    isChatLoading = true;

    try {
      if (progressCallback) progressCallback(50);

      // Check if API is configured
      if (!isApiConfigured(modelId)) {
        console.error(`${modelId} API key not configured`);
        if (progressCallback) progressCallback(0);
        return false;
      }

      if (progressCallback) progressCallback(100);
      currentChatModelId = modelId;
      return true;
    } catch (error) {
      console.error('API chat model setup failed:', error);
      return false;
    } finally {
      isChatLoading = false;
    }
  }

  // Local WebLLM model: requires WebGPU
  const hasWebGPU = await checkWebGPUAvailable();
  if (!hasWebGPU) {
    console.error('WebGPU not available - local chat model requires WebGPU');
    return false;
  }

  isChatLoading = true;

  try {
    const mlcModelId = CHAT_MODEL_MAP[modelId] || CHAT_MODEL_MAP['qwen2.5-1.5b'];

    if (progressCallback) progressCallback(1);

    // Create the MLC engine with progress callback
    chatEngine = await webllm.CreateMLCEngine(mlcModelId, {
      initProgressCallback: (progress) => {
        if (progressCallback) {
          // progress.progress is 0-1, convert to percentage
          const percent = Math.round((progress.progress || 0) * 100);
          progressCallback(percent);
        }
      },
    });

    currentChatModelId = modelId;
    return true;

  } catch (error) {
    console.error('Chat model download failed:', error);
    chatEngine = null;
    return false;
  } finally {
    isChatLoading = false;
  }
}

/**
 * Check if chat model is loaded and ready
 * Returns true for both local WebLLM models and configured API models
 */
export function isChatModelLoaded() {
  // Check local WebLLM model
  if (chatEngine !== null) {
    return true;
  }

  // Check API models
  if (currentChatModelId && API_CHAT_MODELS.includes(currentChatModelId)) {
    return isApiConfigured(currentChatModelId);
  }

  return false;
}

/**
 * Get the currently loaded chat model ID
 */
export function getCurrentChatModel() {
  return currentChatModelId;
}

/**
 * Generate a conversational response using the chat model
 * This is used for out-of-scope queries that don't match any CellPilot intents
 * Supports both local WebLLM models and API-based models
 */
export async function generateChatResponse(userMessage, context = {}) {
  // Check if using API-based model
  if (currentChatModelId && API_CHAT_MODELS.includes(currentChatModelId)) {
    try {
      const reply = await generateApiChatResponse(currentChatModelId, userMessage, context);
      return reply;
    } catch (error) {
      console.error('API chat generation failed:', error);
      return null;
    }
  }

  // Use local WebLLM model
  if (!chatEngine) {
    console.warn('No chat model loaded, cannot generate response');
    return null;
  }

  try {
    // Build a system prompt that explains CellPilot's capabilities and limitations
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
- Or AI assistants like Claude, ChatGPT, or Gemini for general questions

Keep responses concise (2-4 sentences) and helpful. If the question is about scRNA-seq analysis that you CAN help with, guide the user on how to phrase their request.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

    // Add data context if available
    if (context.clusters && context.clusters.length > 0) {
      messages[0].content += `\n\nCurrent data context: The user has ${context.totalCells || 'unknown'} cells in ${context.clusters.length} clusters.`;
      if (context.clusterLabels && Object.keys(context.clusterLabels).length > 0) {
        const labels = Object.entries(context.clusterLabels)
          .map(([id, name]) => `${id}: ${name}`)
          .join(', ');
        messages[0].content += ` Cluster labels: ${labels}.`;
      }
    }


    const response = await chatEngine.chat.completions.create({
      messages,
      max_tokens: 256,
      temperature: 0.7,
    });

    const reply = response.choices[0]?.message?.content || null;
    return reply;

  } catch (error) {
    console.error('Chat generation failed:', error);
    return null;
  }
}

/**
 * Unload the chat model to free memory
 * For API models, this just clears the current model ID
 */
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

/**
 * Classify user intent using semantic similarity
 * Returns confidence scores and supports top-K intents
 */
export async function classifyIntent(userMessage, dataContext = {}, options = {}) {
  const { topK = 3 } = options;

  if (!embedder || !intentEmbeddings) {
    console.warn('No model loaded, cannot classify intent');
    return null;
  }

  try {
    // Pre-process input: strip punctuation, fix typos
    const originalMessage = userMessage;
    userMessage = preprocessUserInput(userMessage);
    if (userMessage !== originalMessage) {
    }


    // Get embedding for user message
    const userEmbeddingResult = await embedder(userMessage.toLowerCase(), {
      pooling: 'mean',
      normalize: true
    });
    const userEmbedding = Array.from(userEmbeddingResult.data);

    // Check if this is a follow-up question
    let maxFollowUpSim = 0;
    for (const followUpEmb of followUpEmbeddings) {
      const sim = cosineSimilarity(userEmbedding, followUpEmb);
      maxFollowUpSim = Math.max(maxFollowUpSim, sim);
    }

    // Extract cluster identifier from message (can be number or text label)
    // Try more specific patterns first, then fall back to general pattern
    let clusterNum = null;
    let clusterLabel = null;
    const clusterPatterns = [
      /(?:to|for|with)\s+cluster\s+(\d+)/i,  // "same to cluster 1", "same for cluster 2"
      /cluster\s+(\d+)/i,  // "cluster 1"
      /(\d+)\s*$/i,  // "1" at end
      /^(\d+)$/i,  // Just "1"
    ];
    for (const pattern of clusterPatterns) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        clusterNum = parseInt(match[1]);
        break;
      }
    }

    // If no numeric cluster found, try to extract text label (e.g., "PT", "Podocytes")
    // Pattern: "for PT", "for cluster PT", "markers for PT", etc.
    if (clusterNum === null) {
      const labelPatterns = [
        /(?:for|to|with|about)\s+cluster\s+([A-Za-z0-9_-]+)/i,  // "for cluster PT", "to cluster Podocytes"
        /(?:for|to|with|about)\s+([A-Za-z][A-Za-z0-9_-]*)/i,  // "for PT", "markers for Podocytes"
        /cluster\s+([A-Za-z][A-Za-z0-9_-]*)/i,  // "cluster PT"
      ];

      // Skip common words that shouldn't be treated as cluster labels
      const skipWords = new Set([
        'markers', 'marker', 'genes', 'gene', 'info', 'information', 'about', 'the', 'a', 'an',
        'this', 'that', 'these', 'those', 'all', 'each', 'every', 'some', 'any', 'which',
        'what', 'where', 'when', 'how', 'why', 'show', 'find', 'get', 'tell', 'give'
      ]);

      for (const pattern of labelPatterns) {
        const match = userMessage.match(pattern);
        if (match && match[1]) {
          const candidate = match[1].trim();
          // Skip if it's a stopword or very short
          if (!skipWords.has(candidate.toLowerCase()) && candidate.length >= 2) {
            clusterLabel = candidate;
            break;
          }
        }
      }
    }

    // Resolve cluster label to numeric ID if we have clusterLabels in dataContext
    // Store multiple matching IDs for merged clusters
    let mergedClusterIds = null;
    if (clusterLabel && dataContext?.clusterLabels) {
      const labelMap = dataContext.clusterLabels;

      // Find all cluster IDs that have this label
      const matchingIds = Object.keys(labelMap).filter(
        key => labelMap[key].toLowerCase() === clusterLabel.toLowerCase()
      );

      if (matchingIds.length > 0) {
        // Use the first one for backward compatibility
        clusterNum = parseInt(matchingIds[0]);

        // If multiple clusters share the same label (merged), store all IDs
        if (matchingIds.length > 1) {
          mergedClusterIds = matchingIds.map(id => parseInt(id));
        } else {
        }
        clusterLabel = null; // Clear label since we resolved it
      } else {
      }
    }

    // Early return: "show cells in cluster X from RNA on ATAC" / "highlight RNA cluster X on ATAC" (multiome)
    // Must run BEFORE gene extraction so "RNA" in "from RNA on ATAC" is not parsed as a gene name.
    // Require explicit "RNA on ATAC" so "from ATAC on RNA" is not mistaken for RNA→ATAC.
    const showRnaClusterOnAtac = /\b(?:from\s+)?RNA\s+on\s+ATAC\b/i.test(userMessage) ||
      /\bhighlight\s+RNA\s+cluster\b.*\b(?:on\s+)?ATAC\b/i.test(userMessage);
    if (showRnaClusterOnAtac && (clusterNum !== null || clusterLabel)) {
      const clusterParam = clusterNum !== null ? clusterNum : clusterLabel;
      return {
        action: 'highlight_rna_cluster_on_atac',
        params: { cluster: clusterParam },
        confidence: 0.95,
        topK: []
      };
    }
    if (/\bclear\s+RNA\s+highlight\s+on\s+ATAC\b/i.test(userMessage)) {
      return {
        action: 'clear_rna_highlight_on_atac',
        params: {},
        confidence: 0.95,
        topK: []
      };
    }

    // Early return: "show cells in cluster X from ATAC on RNA" / "highlight ATAC cluster X on RNA" (multiome)
    // Require explicit "ATAC on RNA" so we only highlight ATAC cluster on the RNA view.
    const showAtacClusterOnRna = /\b(?:from\s+)?ATAC\s+on\s+RNA\b/i.test(userMessage) ||
      /\bhighlight\s+ATAC\s+cluster\b.*\b(?:on\s+)?RNA\b/i.test(userMessage);
    if (showAtacClusterOnRna && (clusterNum !== null || clusterLabel)) {
      const clusterParam = clusterNum !== null ? clusterNum : clusterLabel;
      return {
        action: 'highlight_atac_cluster_on_rna',
        params: { cluster: clusterParam },
        confidence: 0.95,
        topK: []
      };
    }
    if (/\bclear\s+ATAC\s+highlight\s+on\s+RNA\b/i.test(userMessage)) {
      return {
        action: 'clear_atac_highlight_on_rna',
        params: {},
        confidence: 0.95,
        topK: []
      };
    }

    // SpaGE gene imputation: "impute GENE", "predict GENE expression", etc.
    // Must run before general gene-plot detection to avoid treating "impute X" as plot X.
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
      const gene = imputeGeneMatch ? imputeGeneMatch[1] : null;
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
      return { action: 'spatial_cell_interaction', params: {}, confidence: 0.95, topK: [] };
    }

    // BANKSY region segmentation: "segment regions", "region analysis", "identify regions", etc.
    // MUST run before gene extraction to prevent keywords being parsed as gene names.
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
    if (isBanksyRegion) {
      // Extract inline parameters: resolution, lambda, neighbors
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

    // Show regions: "plot umap colored by region", "show regions", "plot region", "what regions are there", etc.
    // MUST run after BANKSY detection and before region composition (which requires a region number).
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
      return { action: 'show_regions', params: {}, confidence: 0.95, topK: [] };
    }

    // Rename region: "rename region 6 to Pod", "call region 3 Cortex", etc.
    // MUST run after BANKSY detection and show_regions but before region composition.
    const renameRegionMatch = userMessage.match(/(?:rename|change|set|call|label|name)\s+region\s+(\S+)\s+(?:to|as)\s+["']?([^"'\n]+?)["']?\s*$/i);
    if (renameRegionMatch && renameRegionMatch[1] && renameRegionMatch[2]) {
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

    // Region composition: "what clusters in region 1", "cell types in region 0", "region 2 composition", etc.
    // MUST run after BANKSY detection and show_regions (to avoid stealing "show regions") and before gene extraction.
    const regionCompMsg = userMessage.trim().toLowerCase();
    const regionCompMatch = regionCompMsg.match(
      /(?:what\s+(?:cell\s+)?(?:cluster|type|cell\s*type)s?\s+(?:are\s+)?(?:in|of)\s+region\s*(\d+))|(?:(?:cluster|type|cell\s*type)s?\s+(?:in|of|for)\s+region\s*(\d+))|(?:region\s*(\d+)\s+(?:composition|cell\s*type|cluster|makeup|breakdown))|(?:(?:show|plot|what)\s+(?:is\s+)?(?:the\s+)?(?:composition|cell\s*type|cluster)\s+(?:of|in|for)\s+region\s*(\d+))|(?:(?:composition|cell\s*type|cluster)\s+(?:composition\s+)?(?:of|in|for)\s+region\s*(\d+))/
    );
    if (regionCompMatch) {
      const regionId = Number(regionCompMatch[1] ?? regionCompMatch[2] ?? regionCompMatch[3] ?? regionCompMatch[4] ?? regionCompMatch[5]);
      return { action: 'region_composition', params: { regionId }, confidence: 0.95, topK: [] };
    }

    // WNN integration: "integrate RNA and ATAC", "run WNN", "WNN co-embedding", "multimodal integration", etc.
    // MUST run before gene extraction to prevent "integrate" being parsed as a gene name.
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
      return { action: 'wnn_integrate', params: {}, confidence: 0.95, topK: [] };
    }

    // Cell fraction / proportion: MUST run BEFORE gene extraction so "plot fraction" is not parsed as gene "fraction"
    const cellFracMsg = userMessage.trim().toLowerCase();
    const isPlotShowFraction =
      (cellFracMsg.includes('plot') || cellFracMsg.includes('show')) &&
      (cellFracMsg.includes('cell fraction') ||
        cellFracMsg.includes('cell proportion') ||
        /\b(?:plot|show)\s+(?:cell\s+)?fraction\b/.test(cellFracMsg));
    if (isPlotShowFraction) {
      return { action: 'plot_cell_fraction', params: {}, confidence: 0.92, topK: [] };
    }

    // Peak-gene link actions: MUST run BEFORE gene extraction so "links" is never treated as a gene name

    // "show top TF for cluster N/PT" / "motif analysis for cluster PT" → tf_motif_analysis
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

    // "show links for GENE" / "show peaks for GENE" / "show peak gene links for GENE" → show_peak_gene_links
    const showLinksMatch =
      userMessage.match(/\b(?:show|display|plot)\s+(?:peak[\s-]?(?:to[\s-]?)?gene\s+)?links?\s+for\s+([A-Za-z0-9-]+)/i) ||
      userMessage.match(/\b(?:show|display|plot)\s+(?:peak[\s-]?(?:to[\s-]?)?gene\s+)?links?\s+of\s+([A-Za-z0-9-]+)/i) ||
      userMessage.match(/\bpeak[\s-]?gene\s+links?\s+(?:for|of)\s+([A-Za-z0-9-]+)/i) ||
      userMessage.match(/\b(?:show|display|plot)\s+(?:linked\s+)?peaks?\s+(?:for|of)\s+([A-Za-z0-9-]+)/i) ||
      userMessage.match(/\b(?:show|display|plot)\s+peaks?\s+linked\s+to\s+([A-Za-z0-9-]+)/i);
    if (showLinksMatch) {
      return { action: 'show_peak_gene_links', params: { gene: showLinksMatch[1] }, confidence: 0.95, topK: [] };
    }

    // "link peaks (to genes)" / "run linkpeaks" / "peak-to-gene correlation" / "cis-regulatory" → link_peaks
    const linkPeaksLower = userMessage.toLowerCase();
    const isLinkPeaks =
      /\blink\s+peaks?\b/.test(linkPeaksLower) ||
      /\blinkpeaks?\b/.test(linkPeaksLower) ||
      /\bpeak[\s-](?:to[\s-])?gene\s+(?:link|corr|assoc)/.test(linkPeaksLower) ||
      /\bcis[\s-]regulat/.test(linkPeaksLower) ||
      /\bpeak\s+gene\s+(?:link|correlation|association|connect)/.test(linkPeaksLower);
    if (isLinkPeaks) {
      const geneForLink =
        userMessage.match(/\blink\s+peaks?\s+for\s+([A-Za-z0-9-]+)/i)?.[1] ||
        userMessage.match(/\blinkpeaks?\s+for\s+([A-Za-z0-9-]+)/i)?.[1];
      return {
        action: 'link_peaks',
        params: geneForLink ? { gene: geneForLink } : {},
        confidence: 0.95,
        topK: [],
      };
    }

    // Extract gene name: use multiple patterns to catch various formats
    // Gene names can be: all caps (NPHS2), mixed case (Nphs2), lowercase (nphs2), or ATAC peak coordinates (chr6:88141558-88142467)
    // Order matters: more specific patterns first
    let geneName = null;
    const genePatterns = [
      // Coverage plot + gene (multiome/scATAC: RNA view = expression, ATAC view = peak coverage)
      /(?:coverage\s+plot|plot\s+coverage)\s+(?:for\s+)?([A-Za-z0-9-]+)/i,
      /(?:show|plot)\s+(?:me\s+)?coverage\s+(?:plot\s+)?(?:for\s+)?([A-Za-z0-9-]+)/i,
      // ATAC peak coordinates (chrN:start-end): must come before generic gene patterns
      /(?:plot|show)\s+(?:me\s+)?(?:gene\s+)?(chr\w+:\d+-\d+)/i,  // "plot chr6:88141558-88142467"
      /(?:plot|show)\s+(?:me\s+)?(chr\w+:\d+-\d+)\s*$/i,  // "plot chr6:88141558-88142467" (end of string)
      /\b(chr\w+:\d+-\d+)\b/,  // peak ID anywhere (e.g. after "plot" or "show")
      // Gene activity (ATAC): "plot gene activity for CD4" or "plot gene activity ms4a1" (no for/of)
      /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,
      /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+([A-Za-z0-9-]+)/i,
      /gene\s+activi?ty\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,
      // Most specific patterns first (gene symbols)
      /(?:show|plot)\s+(?:me\s+)?gene\s+expression\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,  // "show me gene expression of Nphs2"
      /gene\s+expression\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,  // "gene expression of Nphs2"
      /(?:plot|show)\s+(?:me\s+)?gene\s+([A-Za-z0-9-]+)/i,  // "show me gene NPHS2"
      /(?:show|plot)\s+me\s+([A-Za-z0-9-]+)/i,  // "show me NPHS2" (no "gene" word)
      /(?:show|plot)\s+([A-Za-z0-9-]+)(?:\s|$|\.|,)/i,  // "show NPHS2" or "plot NPHS2" (same as "show me geneName")
      /(?:plot|show)\s+(?:me\s+)?(?:gene\s+)?([A-Za-z0-9-]+)\s+(?:expression|on\s+umap)/i,  // "show me gene NPHS2 expression"
      /what\s+is\s+(?:the\s+)?(?:gene\s+)?expression\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,  // "what is the gene expression for NPHS2"
      /(?:expression|gene)\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,  // "expression of NPHS2"
      /([A-Za-z0-9-]+)\s+expression(?:\s+plot)?/i,  // "NPHS2 expression" or "NPHS2 expression plot"
      /expression\s+([A-Za-z0-9-]+)/i,  // "expression NPHS2"
      /([A-Za-z0-9-]+)\s+on\s+umap/i,  // "NPHS2 on umap"
      /^(?:plot|show)\s+(?:me\s+)?([A-Za-z0-9-]+)\s*$/i,  // "plot NPHS2" (whole string)
      /gene\s+([A-Za-z0-9-]+)/i,  // "gene NPHS2": fallback
      /violin\s+(?:plot\s+)?(?:for\s+)?([A-Za-z0-9-]+)/i,  // "violin plot slc5a2", "violin slc5a2"
      /([A-Za-z0-9-]+)\s+violin(?:\s+plot)?/i,  // "slc5a2 violin plot"
      /(?:dotplot|dot\s+plot)\s+(?:for\s+)?([A-Za-z0-9-]+)/i,  // "dotplot slc5a2", "dot plot for slc5a2"
      /([A-Za-z0-9-]+)\s+(?:dotplot|dot\s+plot)/i,  // "slc5a2 dotplot"
      /\b([A-Z][A-Z0-9]+[A-Z0-9]*)\b/,  // All caps gene names like NPHS2, SLC5A2
      /\b([A-Za-z][A-Za-z0-9]+[A-Za-z0-9]*)\b/,  // Any alphanumeric gene name (case-insensitive fallback)
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

    for (const pattern of genePatterns) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].toLowerCase();
        // Skip stopwords and very short matches
        if (!stopwords.has(candidate) && match[1].length >= 2) {
          geneName = match[1]; // Keep original case
          break;
        }
      }
    }

    if (!geneName) {
    }

    // Early return: "coverage plot [gene]" → plot_gene_expression (RNA view = expression, ATAC view = peak coverage)
    const trimmed = userMessage.trim();
    const isCoveragePlotGene = /\b(?:coverage\s+plot|plot\s+coverage)\b/i.test(trimmed) && geneName && !stopwords.has(geneName.toLowerCase());
    if (isCoveragePlotGene) {
      return {
        action: 'plot_gene_expression',
        params: { gene: geneName, showPeakView: true },
        confidence: 0.92,
        topK: []
      };
    }

    // Early return: "plot/show [gene]" (no "coverage") → plot_gene_expression without showPeakView.
    // In multiome: RNA view = gene expression, ATAC view = gene activity. Only "coverage plot [gene]" sets showPeakView.
    const isPlotShowOnly = /^(?:plot|show)\s+(?:me\s+)?(?:gene\s+(?:activi?ty\s+)?(?:for\s+|of\s+)?)?/i.test(trimmed) &&
      !/\b(violin|dotplot|dot\s+plot|marker)\b/i.test(trimmed);
    if (geneName && !stopwords.has(geneName.toLowerCase()) && isPlotShowOnly) {
      return {
        action: 'plot_gene_expression',
        params: { gene: geneName, showPeakView: false },
        confidence: 0.92,
        topK: []
      };
    }

    // "what is the gene expression for X" / "what is gene expression for X" → plot gene
    const isWhatIsGeneExpression = geneName && !stopwords.has(geneName.toLowerCase()) && /what\s+is\s+(?:the\s+)?(?:gene\s+)?expression\s+(?:for|of)\s+/i.test(trimmed);
    if (isWhatIsGeneExpression) {
      return {
        action: 'plot_gene_expression',
        params: { gene: geneName, showPeakView: false },
        confidence: 0.92,
        topK: []
      };
    }

    // "geneName expression plot" → plot gene
    const isExpressionPlot = geneName && !stopwords.has(geneName.toLowerCase()) && /\bexpression\s+plot\b/i.test(trimmed);
    if (isExpressionPlot) {
      return {
        action: 'plot_gene_expression',
        params: { gene: geneName, showPeakView: false },
        confidence: 0.92,
        topK: []
      };
    }

    // If high follow-up similarity and we have context, repeat last action
    // BUT: Don't treat explicit cluster info queries as follow-ups
    // "What about cluster X", "show me about cluster X", "show me cluster X" should be NEW questions, not follow-ups
    const isExplicitClusterInfoQuery = /(?:what\s+(?:is|define|are|about)|tell\s+me\s+about|show\s+me\s+(?:about\s+)?cluster|describe|info|information|know\s+(?:more\s+)?about|do\s+you\s+know)\s+(?:anything\s+)?(?:about\s+)?cluster/i.test(userMessage);

    // Also check if "what about" is being used: this is usually a new question, not a follow-up
    const isWhatAboutQuestion = /^what\s+about/i.test(userMessage.trim());

    // Check for explicit follow-up patterns like "same to", "same for", etc.
    const explicitFollowUpPatterns = [
      /^same\s+(?:to|for|with)\s+cluster/i,
      /^do\s+the\s+same\s+(?:to|for|with)\s+cluster/i,
      /^and\s+cluster/i,
      /^now\s+cluster/i,
    ];
    const isExplicitFollowUp = explicitFollowUpPatterns.some(p => p.test(userMessage.trim()));

    // Explicit "show me [about] cluster X" → always cluster_info, never follow-up
    const showMeClusterMatch = userMessage.trim().match(/^show\s+me\s+(?:about\s+)?cluster\s+(\S+)/i);
    if (showMeClusterMatch && showMeClusterMatch[1]) {
      let cid = showMeClusterMatch[1].trim();
      const parsed = parseInt(cid, 10);
      if (!Number.isNaN(parsed)) {
        return { action: 'cluster_info', params: { cluster: parsed }, confidence: 0.95, topK: [] };
      }
      const labels = dataContext?.clusterLabels || {};
      const resolved = Object.keys(labels).find(k => String(labels[k]).toLowerCase() === cid.toLowerCase());
      if (resolved) {
        return { action: 'cluster_info', params: { cluster: parseInt(resolved, 10), originalLabel: cid }, confidence: 0.95, topK: [] };
      }
      return { action: 'cluster_info', params: { cluster: cid, originalLabel: cid }, confidence: 0.95, topK: [] };
    }

    // DEG between two samples within a cluster (integration / xenium integration)
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
        return {
          action: 'deg_between_samples',
          params: { cluster: c, sample1: sa, sample2: sb },
          confidence: 0.92,
          topK: []
        };
      }
    }

    // Only treat as follow-up if:
    // 1. High similarity to follow-up patterns OR explicit follow-up pattern matched
    // 2. Has last action context
    // 3. Has a cluster number
    // 4. NOT an explicit cluster info query
    // 5. NOT a "what about" question (these are new questions)
    if ((maxFollowUpSim > 0.6 || isExplicitFollowUp) && lastActionContext && clusterNum !== null && !isExplicitClusterInfoQuery && !isWhatAboutQuestion) {

      // For rename_cluster, preserve newLabel from previous action
      // For other actions (find_markers, cluster_info, etc.), just update the cluster parameter
      const params = { ...lastActionContext.params, cluster: clusterNum };
      if (lastActionContext.action === 'rename_cluster' && lastActionContext.params.newLabel) {
        // Use the new cluster number as oldLabel, and preserve newLabel
        params.oldLabel = String(clusterNum);
        params.newLabel = lastActionContext.params.newLabel;
      }
      // For other actions, the spread operator above already updates the cluster parameter

      return {
        action: lastActionContext.action,
        params,
        confidence: 0.8, // High confidence for follow-ups
        topK: []
      };
    }

    // Check for chained commands FIRST: if detected, return a special indicator
    // This allows the router to handle chaining intelligently
    const hasChaining = /,\s*(?:and\s+)?then\s+/i.test(userMessage) ||
                       /(?:rename|change|set|call|label)\s+cluster\s+\d+\s+(?:to|as)\s+[^,]+?\s+and\s+cluster\s+\d+\s+(?:to|as)\s+/i.test(userMessage);

    if (hasChaining) {
      // Return low confidence so router falls back to chaining handler
      return {
        action: 'NONE',
        confidence: 0.2,
        topK: [],
        params: {},
        _suggestChaining: true // Flag for router
      };
    }

    // Find top-K matching intents with scores
    const intentScores = [];

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

    // Sort by score (highest first)
    intentScores.sort((a, b) => b.score - a.score);

    // Extract rename cluster params (oldLabel and newLabel) if present
    let renameOldLabel = null;
    let renameNewLabel = null;
    let renameIsRegion = false;
    const renameRegionMatch2 = userMessage.match(/(?:rename|change|set|call|label|name)\s+region\s+(\S+)\s+(?:to|as)\s+["']?([^"'\n]+?)["']?\s*$/i);
    const renameMatch = userMessage.match(/(?:rename|change|set|call|label)\s+cluster\s+(\S+)(?:\s+(?:in|for|from)\s+(?:rna|atac|gene\s*expression|chromatin))?\s+(?:to|as)\s+["']?([^"'\n]+?)["']?\s*$/i);
    if (renameRegionMatch2 && renameRegionMatch2[1] && renameRegionMatch2[2]) {
      renameOldLabel = renameRegionMatch2[1].trim();
      renameNewLabel = renameRegionMatch2[2].trim();
      renameIsRegion = true;
    } else if (renameMatch && renameMatch[1] && renameMatch[2]) {
      renameOldLabel = renameMatch[1].trim();
      renameNewLabel = renameMatch[2].trim();
    }

    // Extract resolution parameter if present
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

    // Extract other parameters
    const pcaMatch = parseNumber(/(?:pca|principal\s+components?|pcs?)\s*(?:for\s+umap)?\s*(?:=|to|use)?\s*(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:pca|principal\s+components?|pcs?)(?:\s*for\s*umap)?/i);

    const minDistMatch = parseNumber(/min(?:imum)?\s*dist(?:ance)?\s*(?:=|to|use)?\s*(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:min(?:imum)?\s*dist(?:ance)?)/i);
    const neighborMatch = parseNumber(/(?:k\s*=\s*|neighbors?\s*(?:=|to|use)?\s*)(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:neighbors?|nearest\s+neighbors?|k\s*neighbors?)/i);

    // Extract cell filtering parameters
    // Note: Include "=" in the pattern to match "min genes= 500" or "min genes = 500"
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
    const effectiveGeneThreshold = geneThreshold ?? geneThresholdFromFilter;
    const umiThreshold = parseNumber(/(?:umi(?:s)?|counts?)\s*(?:>=|>|at\s+least|more\s+than|over)?\s*(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:umis?|counts?)/i);
    const mitoThreshold = parseNumber(/mito(?:chondrial)?(?:\s*(?:percent|percentage|fraction))?\s*(?:<=|<|less\s+than|under)?\s*(\d+(?:\.\d+)?)/i) ??
      parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:mito(?:chondrial)?(?:\s*(?:percent|percentage|fraction))?)/i);

    // Extract variable genes parameter
    let hvgMatch = parseNumber(/(?:variable\s+genes?|hvg(?:s)?)\s*(?:=|to|of)?\s*(\d+(?:\.\d+)?)/i);
    if (hvgMatch === null) {
      hvgMatch = parseNumberBefore(/(\d+(?:\.\d+)?)\s*(?:highly\s+variable\s+genes?|variable\s+genes?|hvg(?:s)?)/i);
    }

    // Extract color directive
    const extractColorDirective = (text) => {
      const lower = text.toLowerCase();
      const knownColorSchemes = ['viridis', 'magma', 'inferno', 'plasma', 'cividis', 'turbo', 'cubehelix'];

      for (const scheme of knownColorSchemes) {
        if (lower.includes(scheme)) {
          return { type: 'scheme', name: scheme };
        }
      }

      // Try multiple patterns to extract custom colors
      // Pattern 1: "color to X Y Z" or "colors to X Y Z"
      let customMatch = text.match(/colou?rs?(?:\s?bar|\s?map)?(?:\s+use|\s+with|\s+to)?\s+([a-zA-Z,\s]+)/i);

      // Pattern 2: "change color to X Y Z" or "set color to X Y Z"
      if (!customMatch) {
        customMatch = text.match(/(?:change|set|use|switch|update)\s+colou?rs?(?:\s?bar|\s?map)?\s+to\s+([a-zA-Z,\s]+)/i);
      }

      // Pattern 3: "color X Y Z" (without "to")
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

    // Get top-K intents
    const topKIntents = intentScores.slice(0, topK).map(item => {
      const params = {};
      if (['find_markers', 'cluster_info', 'rename_cluster', 'highlight_rna_cluster_on_atac', 'highlight_atac_cluster_on_rna'].includes(item.action)) {
        if (clusterNum !== null) {
          params.cluster = clusterNum;
          // If this is a merged cluster (multiple IDs with same label), pass all IDs
          if (mergedClusterIds && mergedClusterIds.length > 1 && item.action !== 'highlight_rna_cluster_on_atac' && item.action !== 'highlight_atac_cluster_on_rna') {
            params.clusters = mergedClusterIds;
          }
        } else if (clusterLabel) {
          // If we have a label but couldn't resolve it, pass it as string
          // ChatBot will try to resolve it using the clusterLabelMap
          params.cluster = clusterLabel;
        }
      }
      if (['plot_gene_expression', 'plot_gene_violin'].includes(item.action)) {
        if (geneName) params.gene = geneName;
      }
      // For plot_gene_dotplot, extract genes (can be single or multiple)
      if (item.action === 'plot_gene_dotplot') {
        let extractedGenes = null;

        // First, try to extract ALL genes from text after "dotplot" or "dot plot"
        // This handles: "dotplot for UMOD, nphs2" or "dotplot for UMOD and nphs2" or "dotplot for genes slc5a12 umod nphs2"
        const dotplotMatch = userMessage.match(/(?:dotplot|dot\s+plot)\s+(?:for|of)?\s*(.+)/i);
        if (dotplotMatch && dotplotMatch[1]) {
          const afterDotplot = dotplotMatch[1].trim();

          // Remove "gene" or "genes" if present
          const cleaned = afterDotplot.replace(/^genes?\s+/i, '').trim();

          // Check for comma-separated genes: "UMOD, nphs2" or "UMOD, nphs2, slc5a2"
          if (cleaned.includes(',')) {
            const commaGenes = cleaned.split(',')
              .map(g => g.trim())
              .filter(g => g.length > 0 && !stopwords.has(g.toLowerCase()) && g.length >= 2);
            if (commaGenes.length > 0) {
              extractedGenes = commaGenes;
            }
          }
          // Check for "and"-separated genes: "UMOD and nphs2"
          else if (/\s+and\s+/i.test(cleaned)) {
            const andGenes = cleaned.split(/\s+and\s+/i)
              .map(g => g.trim())
              .filter(g => g.length > 0 && !stopwords.has(g.toLowerCase()) && g.length >= 2);
            if (andGenes.length > 0) {
              extractedGenes = andGenes;
            }
          }
          // Check for space-separated genes: "slc5a12 umod nphs2" (multiple genes separated by spaces)
          else {
            const spaceGenes = cleaned.split(/\s+/)
              .map(g => g.trim())
              .filter(g => g.length > 0 && !stopwords.has(g.toLowerCase()) && g.length >= 2);

            if (spaceGenes.length > 1) {
              // Multiple space-separated genes
              extractedGenes = spaceGenes;
            } else if (spaceGenes.length === 1) {
              // Single gene
              extractedGenes = spaceGenes;
            }
          }
        }

        // Fallback to geneName if we have it but didn't extract from dotplot patterns
        if (!extractedGenes && geneName) {
          extractedGenes = [geneName];
        }

        if (extractedGenes && extractedGenes.length > 0) {
          params.genes = extractedGenes;
        }
      }
      // For rename_cluster / rename_region, extract oldLabel and newLabel
      if (item.action === 'rename_cluster' || item.action === 'rename_region') {
        if (renameOldLabel && renameNewLabel) {
          params.oldLabel = renameOldLabel;
          params.newLabel = renameNewLabel;
          // If user said "region", override action to rename_region
          if (renameIsRegion && item.action === 'rename_cluster') {
            item.action = 'rename_region';
          }
        }
      }
      // For clustering actions, extract resolution if present
      if (['cluster_and_visualize', 'update_clustering_resolution'].includes(item.action)) {
        if (resolutionMatch !== null) {
          params.resolution = resolutionMatch;
          // Detect algorithm
          const lower = userMessage.toLowerCase();
          const usesLeiden = lower.includes('leiden');
          const usesWalktrap = lower.includes('walktrap');
          params.algorithm = usesLeiden ? 'leiden' : usesWalktrap ? 'walktrap' : 'multilevel';
        }
      }
      // For UMAP actions, extract PCA and UMAP parameters
      if (['run_umap', 'cluster_and_visualize'].includes(item.action)) {
        if (pcaMatch !== null) {
          params.num_pcs = pcaMatch;
        }
        if (minDistMatch !== null || neighborMatch !== null) {
          if (minDistMatch !== null) params.min_dist = minDistMatch;
          if (neighborMatch !== null) params.num_neighbors = neighborMatch;
        }
      }
      // For set_colormap, extract color directive
      if (item.action === 'set_colormap') {
        if (colorDirective) {
          params.colorMap = colorDirective;
        }
      }
      // For gene plotting actions, include color directive if present
      if (['plot_gene_expression', 'plot_gene_dotplot'].includes(item.action) && colorDirective) {
        params.colorMap = colorDirective;
      }
      // For update_cell_filtering, extract cell filtering parameters
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
      // For update_variable_genes, extract HVG count
      if (item.action === 'update_variable_genes') {
        if (hvgMatch !== null) {
          params.num_hvgs = hvgMatch;
        }
      }
      // For update_pca_for_umap, extract PCA components
      if (item.action === 'update_pca_for_umap') {
        if (pcaMatch !== null) {
          params.num_pcs = pcaMatch;
        }
      }
      // For update_umap_parameters, extract UMAP parameters
      if (item.action === 'update_umap_parameters') {
        if (minDistMatch !== null) {
          params.min_dist = minDistMatch;
        }
        if (neighborMatch !== null) {
          params.num_neighbors = neighborMatch;
        }
      }
      // For region_segmentation, extract BANKSY parameters
      if (item.action === 'region_segmentation') {
        const lambdaMatch = parseNumber(/lambda\s*(?:=|to|of)?\s*(\d+(?:\.\d+)?)/i) ??
          parseNumberBefore(/(\d+(?:\.\d+)?)\s*lambda/i);
        if (resolutionMatch !== null) params.resolution = resolutionMatch;
        if (lambdaMatch !== null) params.lambda = lambdaMatch;
        if (neighborMatch !== null) params.numNeighbors = neighborMatch;
      }
      // For show_parameters, extract the step/category filter
      if (item.action === 'show_parameters') {
        const lower = userMessage.toLowerCase();
        // Map user-friendly names to internal step names
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
        // If no specific step found, params.step remains undefined and all parameters are shown
      }

      return {
        action: item.action,
        params,
        confidence: item.score
      };
    });

    if (topKIntents.length === 0) {
      return { action: 'NONE', confidence: 0, topK: [] };
    }

    const bestIntent = topKIntents[0];

    // If best score is very low, return NONE instead of unknown
    if (bestIntent.confidence < 0.3) {
      return { action: 'NONE', confidence: bestIntent.confidence, topK: topKIntents };
    }

    // Additional validation: if the action requires a parameter but none was found,
    // lower confidence or return NONE
    // BUT: if parameter IS found, boost confidence (clear commands should execute immediately)
    const requiresGene = ['plot_gene_expression', 'plot_gene_violin'].includes(bestIntent.action);
    if (requiresGene) {
      if (!bestIntent.params.gene) {
        // Lower confidence significantly
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        // Gene was successfully extracted: this is a clear, unambiguous command
        // Boost confidence to ensure it executes immediately without clarification
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75); // High confidence for clear commands
      }
    }

    // For plot_gene_dotplot, require genes array
    if (bestIntent.action === 'plot_gene_dotplot') {
      if (!bestIntent.params.genes || !Array.isArray(bestIntent.params.genes) || bestIntent.params.genes.length === 0) {
        // Lower confidence significantly
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        // Genes were successfully extracted: this is a clear, unambiguous command
        // Boost confidence to ensure it executes immediately without clarification
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75); // High confidence for clear commands
      }
    }

    // For rename_cluster / rename_region, require oldLabel and newLabel
    if (bestIntent.action === 'rename_cluster' || bestIntent.action === 'rename_region') {
      // If user said "region", override action even at the best-intent level
      if (renameIsRegion && bestIntent.action === 'rename_cluster') {
        bestIntent.action = 'rename_region';
      }
      if (!bestIntent.params.oldLabel || !bestIntent.params.newLabel) {
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      }
    }

    // For set_colormap, require colorMap parameter
    if (bestIntent.action === 'set_colormap') {
      if (!bestIntent.params.colorMap) {
        // Lower confidence significantly: missing required parameters
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        // Color directive was successfully extracted: this is a clear command
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75); // High confidence for clear commands
      }
    }

    // For update_cell_filtering, check if any filtering parameter was extracted
    if (bestIntent.action === 'update_cell_filtering') {
      const hasParams = bestIntent.params.detected_threshold != null ||
                       bestIntent.params.sum_threshold != null ||
                       bestIntent.params.mito_threshold != null;
      if (!hasParams) {
        // Lower confidence: missing required parameters
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        // Parameters were successfully extracted: this is a clear command
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    // For update_variable_genes, require num_hvgs parameter
    if (bestIntent.action === 'update_variable_genes') {
      if (bestIntent.params.num_hvgs == null) {
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    // For update_clustering_resolution, require resolution parameter
    if (bestIntent.action === 'update_clustering_resolution') {
      if (bestIntent.params.resolution == null) {
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    // For update_pca_for_umap, require num_pcs parameter
    if (bestIntent.action === 'update_pca_for_umap') {
      if (bestIntent.params.num_pcs == null) {
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    // For update_umap_parameters, require at least one UMAP parameter
    if (bestIntent.action === 'update_umap_parameters') {
      const hasParams = bestIntent.params.min_dist != null ||
                       bestIntent.params.num_neighbors != null;
      if (!hasParams) {
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.3);
      } else {
        bestIntent.confidence = Math.max(bestIntent.confidence, 0.75);
      }
    }

    // Special handling: If user says "rerun" with filtering parameters, prioritize update_cell_filtering
    const hasRerunKeyword = /rerun|re-run|reanalyze|re-analyze|recalculate|re-calculate/i.test(userMessage);
    if (hasRerunKeyword && (effectiveGeneThreshold !== null || umiThreshold !== null || mitoThreshold !== null)) {
      // Check if update_cell_filtering is in top-K intents
      const cellFilteringIntent = topKIntents.find(item => item.action === 'update_cell_filtering');
      if (cellFilteringIntent) {
        bestIntent.action = 'update_cell_filtering';
        bestIntent.params = cellFilteringIntent.params;
        bestIntent.confidence = Math.max(cellFilteringIntent.confidence, 0.75);
      }
    }

    // For cluster_and_visualize, if resolution is extracted, change action to update_clustering_resolution
    if (bestIntent.action === 'cluster_and_visualize' && bestIntent.params.resolution) {
      bestIntent.action = 'update_clustering_resolution';
    }

    // For cluster_and_visualize, if resolution is mentioned but not extracted, lower confidence
    // This helps the router ask for clarification
    if (bestIntent.action === 'cluster_and_visualize') {
      const hasResolutionMention = /resolution\s*(?:=|to)?\s*\d+/i.test(userMessage) || /\d+\s*resolution/i.test(userMessage);
      if (hasResolutionMention && !bestIntent.params.resolution) {
        // Lower confidence to trigger clarification
        bestIntent.confidence = Math.min(bestIntent.confidence, 0.4);
      }
    }

    // Return with confidence and top-K
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

/**
 * Simple fallback classifier for when LLM fails (legacy: kept for compatibility)
 * Note: This is a basic pattern matcher, not used in the main flow
 */
export function classifyIntentSimple(userMessage) {
  // Pre-process input: strip punctuation, fix typos
  userMessage = preprocessUserInput(userMessage);
  const lower = userMessage.toLowerCase();

  // WNN integration detection (before gene extraction)
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

  // Extract potential gene name or peak ID (case-insensitive)
  // Try multiple patterns, prioritizing more specific ones
  const genePatterns = [
    /(?:plot|show)\s+(?:me\s+)?(?:gene\s+)?(chr\w+:\d+-\d+)/i,  // "plot chr18:73073416-73074285" (ATAC peak)
    /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,  // "plot gene activity for ms4a1"
    /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+([A-Za-z0-9-]+)/i,  // "plot gene activity ms4a1"
    /(?:plot|show)\s+(?:me\s+)?gene\s+([A-Za-z0-9-]+)/i,  // "plot gene ms4a1"
    /(?:show|plot)\s+me\s+([A-Za-z0-9-]+)/i,  // "show me NPHS2"
    /(?:show|plot)\s+([A-Za-z0-9-]+)(?:\s|$|\.|,)/i,  // "show NPHS2" or "plot NPHS2" (same as "show me geneName")
    /what\s+is\s+(?:the\s+)?(?:gene\s+)?expression\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,  // "what is the gene expression for NPHS2"
    /([A-Za-z0-9-]+)\s+expression\s+plot/i,  // "NPHS2 expression plot"
    /^(?:plot|show)\s+(?:me\s+)?([A-Za-z0-9-]+)\s*$/i,  // "plot ms4a1" or "show ms4a1" (single token)
    /violin\s+(?:plot\s+)?(?:for\s+)?([A-Za-z0-9-]+)/i,  // "violin plot slc5a2"
    /([A-Za-z0-9-]+)\s+violin(?:\s+plot)?/i,  // "slc5a2 violin plot"
    /(?:dotplot|dot\s+plot)\s+(?:for\s+)?([A-Za-z0-9-]+)/i,  // "dotplot slc5a2"
    /([A-Za-z0-9-]+)\s+(?:dotplot|dot\s+plot)/i,  // "slc5a2 dotplot"
    /gene\s+([A-Za-z0-9-]+)/i,  // "gene slc5a2"
    /\b([A-Z][a-z0-9]+[A-Z0-9]*[a-z0-9]*)\b/,  // Mixed case like Nphs2
    /\b([A-Za-z][A-Za-z0-9]+)\b/,  // Any alphanumeric (case-insensitive fallback)
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

  // Extract cluster number
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

  // Check for follow-up patterns
  // NOTE: "what about cluster X" should be treated as a NEW question, not a follow-up
  const followUpPatterns = [
    /^same\s+(?:to|for|with)/i,
    /^do\s+the\s+same\s+(?:to|for|with)/i,
    /^and\s+(?:for\s+)?(?:cluster\s+)?(\d+)/i,
    /^now\s+(?:for\s+)?(?:cluster\s+)?(\d+)/i,
    /^(?:cluster\s+)?(\d+)\??$/i,
    // Only treat "what about" as follow-up if it's NOT asking about a cluster
    /^what\s+about\s+(?!cluster)/i,
    /^how\s+about\s+(?!cluster)/i,
  ];

  const isFollowUp = followUpPatterns.some(p => p.test(lower));

  // Don't treat explicit cluster info queries as follow-ups
  // "what about cluster X", "show me about cluster X", "show me cluster X" should be cluster_info, not follow-ups
  const isExplicitClusterInfoQuery = /(?:what\s+(?:is|define|are|about)|tell\s+me\s+about|show\s+me\s+(?:about\s+)?cluster|describe|info|information|know\s+(?:more\s+)?about|do\s+you\s+know)\s+(?:anything\s+)?(?:about\s+)?cluster/i.test(userMessage);

  // "What about cluster X" and "show me [about] cluster X" are always new questions, not follow-ups
  const isWhatAboutCluster = /^what\s+about\s+cluster/i.test(lower);
  const isShowMeCluster = /^show\s+me\s+(?:about\s+)?cluster/i.test(lower);

  if (isFollowUp && lastActionContext && clusterNum !== null && !isExplicitClusterInfoQuery && !isWhatAboutCluster && !isShowMeCluster) {

    // For rename_cluster, preserve newLabel from previous action
    const params = { ...lastActionContext.params, cluster: clusterNum };
    if (lastActionContext.action === 'rename_cluster' && lastActionContext.params.newLabel) {
      // Use the new cluster number as oldLabel, and preserve newLabel
      params.oldLabel = String(clusterNum);
      params.newLabel = lastActionContext.params.newLabel;
    }

    return {
      action: lastActionContext.action,
      params
    };
  }

  // If "what about cluster X" or "show me [about] cluster X", treat as cluster_info request
  if ((isWhatAboutCluster || isShowMeCluster) && clusterNum !== null) {
    return {
      action: 'cluster_info',
      params: { cluster: clusterNum }
    };
  }

  // Multiome: show cells from RNA cluster X on ATAC view (highlight in red)
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

  // Multiome: show cells from ATAC cluster X on RNA view (highlight in red)
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

  // DEG between two samples within a cluster (integration / xenium integration): "find markers for cluster 21 between sample 1 and sample 2"
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
      return {
        action: 'deg_between_samples',
        params: { cluster: c, sample1: sa, sample2: sb },
        confidence: 0.9,
        topK: []
      };
    }
  }

  // Check for each action
  if (lower.includes('marker') || lower.includes('top genes') || lower.includes('deg')) {
    return { action: 'find_markers', params: { cluster: clusterNum } };
  }

  if (lower.includes('violin')) {
    return { action: 'plot_gene_violin', params: { gene: geneName } };
  }

  // Check for dotplot BEFORE general plot check (since "dotplot" contains "plot")
  if (lower.includes('dotplot') || lower.includes('dot plot')) {
    if (geneName) {
      return { action: 'plot_gene_dotplot', params: { genes: [geneName] } };
    }
  }

  if ((lower.includes('tell me about') || lower.includes('show me about') || lower.includes('show me cluster') || lower.includes('what is') || lower.includes('what define') || lower.includes('describe')) && clusterNum !== null) {
    return { action: 'cluster_info', params: { cluster: clusterNum } };
  }

  // Cell fraction / proportion (integration): MUST run before plot_gene_expression so "plot fraction" is not parsed as gene "fraction"
  if ((lower.includes('plot') || lower.includes('show')) && (lower.includes('cell fraction') || lower.includes('cell proportion') || /\b(?:plot|show)\s+(?:cell\s+)?fraction\b/.test(lower))) {
    return { action: 'plot_cell_fraction', params: {}, confidence: 0.9, topK: [] };
  }
  if (lower.includes('cell fraction') || lower.includes('cell proportion')) {
    return { action: 'plot_cell_fraction', params: {}, confidence: 0.9, topK: [] };
  }

  // "show region", "plot region", "what regions" → show UMAP/spatial colored by BANKSY regions
  if (/\bregions?\b/.test(lower) && (lower.includes('plot') || lower.includes('show') || lower.includes('display') || lower.includes('color') || /\bwhat\s+region/.test(lower) || /\bhow\s+many\s+region/.test(lower))) {
    return { action: 'show_regions', params: {}, confidence: 0.9, topK: [] };
  }

  // "plot/show umap" or "plot/show cell clusters/cell types" → show UMAP colored by clusters (BEFORE plot_gene_expression so "umap"/"clusters"/"cell" are not treated as genes)
  if (lower.includes('umap') || lower.includes('embedding')) {
    return { action: 'run_umap', params: {} };
  }
  if ((lower.includes('plot') || lower.includes('show')) && (lower.includes('cluster') || lower.includes('cell type') || lower.includes('cell clusters'))) {
    return { action: 'cluster_and_visualize', params: {} };
  }

  // General plot/expression check: but exclude "dotplot" which was handled above (no coverage → showPeakView: false for multiome)
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
    // Extract step/category filter
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

/**
 * Format a friendly "I don't understand" message
 */
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

/**
 * Unload the embedding model to free memory
 */
export async function unloadModel() {
  embedder = null;
  intentEmbeddings = null;
  followUpEmbeddings = null;
  currentEmbeddingModelId = null;
}

const webllmService = {
  // Embedding model (intent classification)
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
  // Chat model (conversational responses)
  checkWebGPUAvailable,
  getAvailableChatModels,
  downloadChatModel,
  isChatModelLoaded,
  getCurrentChatModel,
  generateChatResponse,
  unloadChatModel,
};

export default webllmService;
