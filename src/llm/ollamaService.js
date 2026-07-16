/**
 * OllamaService: Local Ollama integration for intent classification
 *
 * This service is used as a FALLBACK when keyword matching doesn't find a match.
 * It uses a local Ollama instance to classify user intent into predefined actions.
 */

// Default Ollama endpoint
const OLLAMA_BASE_URL = 'http://localhost:11434';

// Default model: small and fast
const DEFAULT_MODEL = 'llama3.2:3b';

// Available actions that CellPilot can perform
const AVAILABLE_ACTIONS = [
  { action: 'find_markers', description: 'Find marker genes for a cluster', examples: ['top genes for cluster 1', 'what genes define cluster 3', 'show markers', 'differentially expressed genes'] },
  { action: 'cluster_info', description: 'Get information about a cluster', examples: ['tell me about cluster 1', 'what is cluster 2', 'describe cluster 5', 'cluster 3 info'] },
  { action: 'plot_gene_expression', description: 'Plot gene expression on UMAP', examples: ['show Cd4 expression', 'plot gene Foxp3', 'visualize Gapdh'] },
  { action: 'plot_gene_violin', description: 'Create violin plot for a gene', examples: ['violin plot for Cd8a', 'show Cd4 violin'] },
  { action: 'run_umap', description: 'Run UMAP dimensionality reduction', examples: ['show umap', 'run dimensionality reduction', 'create embedding'] },
  { action: 'cluster_and_visualize', description: 'Cluster cells and show UMAP', examples: ['cluster the cells', 'run clustering', 'analyze my data'] },
  { action: 'run_qc', description: 'Run quality control', examples: ['show qc metrics', 'quality control', 'check data quality'] },
  { action: 'rename_cluster', description: 'Rename a cluster', examples: ['rename cluster 1 to T cells', 'call cluster 2 B cells'] },
  { action: 'rename_region', description: 'Rename a BANKSY spatial region', examples: ['rename region 1 to Cortex', 'call region 3 Medulla'] },
  { action: 'show_parameters', description: 'Show analysis parameters', examples: ['show parameters', 'what settings are used', 'current parameters'] },
  { action: 'wnn_integrate', description: 'Run WNN (Weighted Nearest Neighbor) integration to combine RNA and ATAC into a co-embedding UMAP', examples: ['integrate RNA and ATAC', 'run WNN', 'create joint UMAP', 'co-embed RNA and ATAC'] },
  { action: 'show_regions', description: 'Show UMAP/spatial view colored by BANKSY spatial regions', examples: ['show regions', 'plot umap colored by region', 'what regions are there'] },
  { action: 'region_composition', description: 'Show cell type/cluster composition of a BANKSY spatial region', examples: ['what clusters are in region 1', 'cell types in region 0', 'region 2 composition'] },
  { action: 'unknown', description: 'Cannot understand or not related to single-cell analysis', examples: [] },
];

// Build the system prompt
function buildSystemPrompt(dataContext = {}) {
  const actionsDescription = AVAILABLE_ACTIONS
    .filter(a => a.action !== 'unknown')
    .map(a => `- "${a.action}": ${a.description}. Examples: ${a.examples.slice(0, 2).join(', ')}`)
    .join('\n');

  let contextInfo = '';
  if (dataContext.clusters && dataContext.clusters.length > 0) {
    contextInfo += `\nAvailable clusters: ${dataContext.clusters.join(', ')}`;
  }
  if (dataContext.totalCells) {
    contextInfo += `\nTotal cells: ${dataContext.totalCells}`;
  }

  return `You are an intent classifier for CellPilot, a single-cell RNA sequencing analysis tool.
Your job is to understand what the user wants and return a JSON command.

Available actions:
${actionsDescription}

${contextInfo ? `Current data context:${contextInfo}` : ''}

RULES:
1. Return ONLY valid JSON, no explanation
2. Extract parameters like cluster numbers or gene names from the user's message
3. If asking about a specific cluster (number or name), extract it as "cluster" parameter
4. If asking about a gene, extract it as "gene" parameter
5. If you cannot understand or it's unrelated to single-cell analysis, return {"action": "unknown"}
6. Be flexible with phrasing - "top genes", "marker genes", "differentially expressed" all mean find_markers
7. "tell me about", "what is", "describe", "info about" a cluster means cluster_info

Response format:
{"action": "action_name", "params": {"param1": "value1"}}

Examples:
User: "show me the top genes for cluster 1"
{"action": "find_markers", "params": {"cluster": 1}}

User: "what is cluster 5?"
{"action": "cluster_info", "params": {"cluster": 5}}

User: "plot Cd4"
{"action": "plot_gene_expression", "params": {"gene": "Cd4"}}

User: "hello how are you"
{"action": "unknown"}`;
}

/**
 * Check if Ollama is available
 */
export async function checkOllamaAvailable() {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000), // 2 second timeout
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * Get list of available models from Ollama
 */
export async function getAvailableModels() {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.models || [];
  } catch (error) {
    console.error('Failed to get Ollama models:', error);
    return [];
  }
}

/**
 * Classify user intent using Ollama
 * @param {string} userMessage: The user's message
 * @param {object} dataContext: Current data context (clusters, etc.)
 * @param {string} model: Model to use (default: llama3.2:3b)
 * @returns {Promise<object|null>}: Parsed command or null if failed
 */
export async function classifyIntent(userMessage, dataContext = {}, model = DEFAULT_MODEL) {
  try {
    const systemPrompt = buildSystemPrompt(dataContext);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        prompt: `${systemPrompt}\n\nUser: "${userMessage}"\n`,
        stream: false,
        options: {
          temperature: 0.1, // Low temperature for consistent classification
          num_predict: 100, // Short response expected
        },
      }),
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      console.error('Ollama request failed:', response.status);
      return null;
    }

    const data = await response.json();
    const responseText = data.response?.trim();


    // Try to parse JSON from response
    // Sometimes LLMs add extra text, so we try to extract JSON
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('No JSON found in Ollama response');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate the response
    if (!parsed.action) {
      console.warn('Invalid response - no action field');
      return null;
    }

    // Check if action is valid
    const validActions = AVAILABLE_ACTIONS.map(a => a.action);
    if (!validActions.includes(parsed.action)) {
      console.warn('Invalid action:', parsed.action);
      return { action: 'unknown' };
    }

    return parsed;

  } catch (error) {
    console.error('Ollama classification failed:', error);
    return null;
  }
}

/**
 * Format a friendly "I don't understand" message with suggestions
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

const ollamaService = {
  checkOllamaAvailable,
  getAvailableModels,
  classifyIntent,
  getUnknownResponseMessage,
};

export default ollamaService;
