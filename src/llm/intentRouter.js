/**
 * Intent Router: Confidence-based routing system for CellPilot
 *
 * This module implements a confidence-first approach where:
 * 1. Rules and intent models both produce confidence scores
 * 2. A type classifier gates commands vs questions
 * 3. The router picks the winner based on confidence thresholds
 * 4. Low-confidence actions trigger clarification
 * 5. Rules act as validators/shortcuts, not primary router
 */

// Confidence thresholds
const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.75,      // Execute immediately
  MEDIUM: 0.5,    // Execute but log
  LOW: 0.3,       // Ask for clarification
};

// Input types for classification
export const INPUT_TYPES = {
  COMMAND: 'command',      // User wants app to do something
  QUESTION: 'question',    // Biology question, interpretation question
  NAVIGATION: 'navigation', // Help, meta, navigation
  UNKNOWN: 'unknown'
};

/**
 * Classify input type: command vs question vs navigation
 * This acts as a gate to prevent rules from misfiring on questions
 */
export function classifyInputType(userMessage) {
  const lower = userMessage.toLowerCase().trim();

  // Navigation/meta patterns (high confidence)
  const navigationPatterns = [
    /^(help|what can you do|commands|menu|options)$/i,
    /^(show|list)\s+(?:me\s+)?(?:the\s+)?(?:available\s+)?(?:commands?|options?|features?|capabilities?)/i,
    /^(\?|h\?|help\?)$/i,
  ];

  for (const pattern of navigationPatterns) {
    if (pattern.test(lower)) {
      return { type: INPUT_TYPES.NAVIGATION, confidence: 0.95 };
    }
  }

  // Question patterns (high confidence)
  // NOTE: "what about cluster X" should be treated as a command (cluster_info), not a question
  const questionPatterns = [
    // Biology questions (but not "what about cluster X")
    /^(what|how|why|when|where)\s+(?:is|are|does|do|can|will|would)(?!\s+about\s+cluster)/i,
    /^(can\s+you\s+)?(?:tell|explain|describe)\s+(?:me\s+)?(?:about|what|how)(?!\s+cluster)/i,
    /^(?:what|which)\s+(?:is|are)\s+(?:the\s+)?(?:meaning|definition|purpose|role|function)/i,
    /^(?:do\s+you\s+)?know\s+(?:about|what|how)(?!\s+cluster)/i,
    /^(?:is|are)\s+(?:there|this|that)\s+(?:a|any)/i,
    // Interpretation questions
    /^(?:what|how)\s+(?:does|do)\s+(?:this|that|it|the)/i,
    /^(?:what|how)\s+(?:can|should)\s+(?:i|we)/i,
    /^(?:what|which)\s+(?:does|do)\s+(?:this|that|it)\s+(?:mean|indicate|show)/i,
    // "what about" but NOT about clusters (those are commands)
    /^what\s+about\s+(?!cluster)/i,
  ];

  for (const pattern of questionPatterns) {
    if (pattern.test(lower)) {
      return { type: INPUT_TYPES.QUESTION, confidence: 0.85 };
    }
  }

  // Command patterns (medium confidence, need more context)
  // "what about cluster X" is a command (cluster_info), not a question
  const commandPatterns = [
    /^(plot|show|display|visualize|create|run|execute|find|get|set|change|update|rename)/i,
    /^(?:please\s+)?(?:can\s+you\s+)?(?:plot|show|display|run|find|get)/i,
    /^(?:i\s+)?(?:want|would like|need)\s+(?:to\s+)?(?:plot|show|see|run|find|get)/i,
    /^what\s+about\s+cluster/i,  // "what about cluster X" is a command
    /^do\s+you\s+know\s+(?:anything\s+)?about\s+cluster/i,  // "do you know anything about cluster X" is a command
  ];

  for (const pattern of commandPatterns) {
    if (pattern.test(lower)) {
      return { type: INPUT_TYPES.COMMAND, confidence: 0.6 };
    }
  }

  // Default: unknown (let intent model decide)
  return { type: INPUT_TYPES.UNKNOWN, confidence: 0.3 };
}

/**
 * Router result structure
 */
export class RouterResult {
  constructor(action, params = {}, confidence = 0.5, source = 'unknown', explanation = '') {
    this.action = action;
    this.params = params;
    this.confidence = confidence;
    this.source = source; // 'rule', 'intent_model', 'fallback'
    this.explanation = explanation;
    this.needsClarification = confidence < CONFIDENCE_THRESHOLDS.HIGH;
    this.topK = []; // For top-K intents
  }

  static none(explanation = 'No confident match found') {
    return new RouterResult('NONE', {}, 0, 'none', explanation);
  }

  static askClarify(options = [], explanation = 'Please clarify your request') {
    return new RouterResult('ASK_CLARIFY', { options }, 0.3, 'router', explanation);
  }
}

/**
 * Main router function: confidence-based decision making
 */
export async function routeIntent(userMessage, dataContext, options = {}) {
  const {
    intentClassifier = null,
    inputTypeClassifier = classifyInputType,
    minConfidence = CONFIDENCE_THRESHOLDS.MEDIUM,
    enableClarification = true,
  } = options;

  // Step 1: Classify input type (command vs question vs navigation)
  const typeResult = inputTypeClassifier(userMessage);

  // Step 2: Get intent model result (if classifier provided)
  let intentResult = null;
  if (intentClassifier) {
    try {
      const intentMatch = await intentClassifier(userMessage, dataContext);
      if (intentMatch) {
        // Intent model should return confidence, but if not, estimate it
        const confidence = intentMatch.confidence ||
          (intentMatch.action === 'unknown' ? 0.1 : 0.6);

        intentResult = new RouterResult(
          intentMatch.action,
          intentMatch.params || {},
          confidence,
          'intent_model',
          `Intent model classified with confidence ${confidence.toFixed(2)}`
        );

        // Support top-K intents if provided
        if (intentMatch.topK && Array.isArray(intentMatch.topK)) {
          intentResult.topK = intentMatch.topK.map(item => ({
            action: item.action,
            params: item.params || {},
            confidence: item.confidence || 0.5
          }));
        }
      }
    } catch (error) {
      console.warn('Intent classifier error:', error);
    }
  }

  // Step 3: Decision logic: confidence-based routing (intent-based only)
  if (!intentResult) {
    return RouterResult.none('No intent classifier available');
  }

  const best = intentResult;

  // Special handling for NONE/ASK_CLARIFY/unknown
  // Also check if intent model suggested chaining
  if (best.action === 'NONE' || best.action === 'ASK_CLARIFY' || best.action === 'unknown') {
    if (best.action === 'unknown') {
      // Convert 'unknown' to 'NONE' for consistency
      return RouterResult.none('Intent model returned unknown');
    }
    // If intent model detected chaining, return a special flag
    if (intentResult && intentResult.params && intentResult.params._suggestChaining) {
      return RouterResult.none('Intent model detected chained commands - use chaining handler');
    }

    // If we have NONE but enableClarification is true, provide helpful suggestions
    if (enableClarification && best.action === 'NONE') {
      // Check if this is completely unrelated input (very low confidence, no meaningful patterns)
      const isUnrelatedInput = best.confidence < 0.3 &&
                               (!best.topK || best.topK.length === 0 || best.topK[0].confidence < 0.3);

      // Also check input type: if it's UNKNOWN and confidence is very low, it's probably unrelated
      const typeResult = inputTypeClassifier(userMessage);
      const isTrulyUnrelated = isUnrelatedInput ||
                               (typeResult.type === INPUT_TYPES.UNKNOWN && best.confidence < 0.3);

      if (isTrulyUnrelated) {
        // Show general guidance instead of specific action options
        const generalGuidance = `I'm not sure how to help with that. Here's what I can do:\n\n` +
          `**Common Commands:**\n` +
          `• Plot gene expression: "show me gene NPHS2 expression" or "plot gene SLC5A2"\n` +
          `• Cluster cells: "cluster the cells" or "run clustering"\n` +
          `• Find markers: "find markers for cluster 1" or "show markers for cluster PT"\n` +
          `• Get cluster info: "tell me about cluster 1" or "what is cluster PT"\n` +
          `• Rename clusters: "rename cluster 1 to PT" or "rename cluster 3 to Podocytes"\n` +
          `• Run UMAP: "run umap" or "create umap plot"\n` +
          `• Adjust parameters: "recluster with resolution = 1" or "run umap with min dist = 0.4"\n\n` +
          `**Questions:**\n` +
          `• Ask about genes: "what is NPHS2?" or "tell me about SLC5A2"\n` +
          `• Ask about clusters: "what about cluster 1?" or "do you know anything about cluster PT?"\n\n` +
          `Try rephrasing your request using one of these patterns.`;

        return RouterResult.none(generalGuidance);
      }

      // If we have top-K from intent model with reasonable confidence, use those
      if (best.topK && best.topK.length > 0 && best.topK[0].confidence >= 0.3) {
        const options = best.topK.slice(0, 3).map(item => ({
          action: item.action,
          params: item.params,
          label: generateActionLabel(item.action, item.params)
        }));
        return RouterResult.askClarify(
          options,
          `I'm not entirely sure what you want. Here are some options that might match:`
        );
      }

      // Fallback to common options (only if input seems somewhat related)
      const fallbackOptions = [
        { action: 'cluster_and_visualize', params: {}, label: 'Cluster the cells and visualize' },
        { action: 'run_umap', params: {}, label: 'Run UMAP dimensionality reduction' },
        { action: 'show_parameters', params: {}, label: 'Show current analysis parameters' }
      ];

      return RouterResult.askClarify(
        fallbackOptions,
        `I'm not entirely sure what you want. Here are some common options:`
      );
    }

    return best;
  }

  // If best confidence is below threshold, ask for clarification
  if (best.confidence < minConfidence && enableClarification) {
    // Check if this is completely unrelated input (very low confidence)
    const isUnrelatedInput = best.confidence < 0.3;
    const typeResult = inputTypeClassifier(userMessage);
    const isTrulyUnrelated = isUnrelatedInput &&
                             (typeResult.type === INPUT_TYPES.UNKNOWN ||
                              (!best.topK || best.topK.length === 0 || (best.topK[0] && best.topK[0].confidence < 0.3)));

    if (isTrulyUnrelated) {
      // Show general guidance instead of specific action options
      const generalGuidance = `I'm not sure how to help with that. Here's what I can do:\n\n` +
        `**Common Commands:**\n` +
        `• Plot gene expression: "show me gene NPHS2 expression" or "plot gene SLC5A2"\n` +
        `• Cluster cells: "cluster the cells" or "run clustering"\n` +
        `• Find markers: "find markers for cluster 1" or "show markers for cluster PT"\n` +
        `• Get cluster info: "tell me about cluster 1" or "what is cluster PT"\n` +
        `• Rename clusters: "rename cluster 1 to PT" or "rename cluster 3 to Podocytes"\n` +
        `• Run UMAP: "run umap" or "create umap plot"\n` +
        `• Adjust parameters: "recluster with resolution = 1" or "run umap with min dist = 0.4"\n\n` +
        `**Questions:**\n` +
        `• Ask about genes: "what is NPHS2?" or "tell me about SLC5A2"\n` +
        `• Ask about clusters: "what about cluster 1?" or "do you know anything about cluster PT?"\n\n` +
        `Try rephrasing your request using one of these patterns.`;

      return RouterResult.askClarify(
        [],
        generalGuidance
      );
    }

    // Try to extract missing parameters from the original user message
    // This helps when the intent model classified correctly but didn't extract params
    const extractMissingParams = (action, params, userMessage) => {
      const enhancedParams = { ...params };

      // For gene-related actions, try to extract gene name or peak ID if missing
      if (['plot_gene_expression', 'plot_gene_violin'].includes(action) && !params.gene) {
        const genePatterns = [
          /(?:coverage\s+plot|plot\s+coverage)\s+(?:for\s+)?([A-Za-z0-9-]+)/i,
          /(?:plot|show)\s+(?:me\s+)?(?:gene\s+)?(chr\w+:\d+-\d+)/i,  // ATAC peak: "plot chr18:73073416-73074285"
          /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,
          /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+([A-Za-z0-9-]+)/i,  // "plot gene activity ms4a1"
          /(?:plot|show)\s+(?:me\s+)?gene\s+([A-Za-z0-9-]+)/i,
          /(?:show|plot)\s+me\s+([A-Za-z0-9-]+)/i,  // "show me NPHS2"
          /(?:show|plot)\s+([A-Za-z0-9-]+)(?:\s|$|\.|,)/i,  // "show NPHS2" or "plot NPHS2" (same as "show me geneName")
          /(?:plot|show)\s+(?:me\s+)?(?:gene\s+)?([A-Za-z0-9-]+)\s+(?:expression|on\s+umap)/i,
          /^(?:plot|show)\s+(?:me\s+)?([A-Za-z0-9-]+)\s*$/i,  // "plot ms4a1"
          /what\s+is\s+(?:the\s+)?(?:gene\s+)?expression\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,  // "what is the gene expression for NPHS2"
          /gene\s+expression\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,
          /(?:expression|gene)\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,
          /([A-Za-z0-9-]+)\s+expression(?:\s+plot)?/i,  // "NPHS2 expression" or "NPHS2 expression plot"
          /expression\s+([A-Za-z0-9-]+)/i,
          /gene\s+([A-Za-z0-9-]+)/i,
        ];

        const stopwords = new Set(['gene', 'genes', 'expression', 'cells', 'umap', 'show', 'plot', 'me', 'the', 'for', 'of', 'activity', 'coverage']);

        for (const pattern of genePatterns) {
          const match = userMessage.match(pattern);
          if (match && match[1] && !stopwords.has(match[1].toLowerCase()) && match[1].length >= 2) {
            enhancedParams.gene = match[1];
            break;
          }
        }
      }

      // For cluster-related actions, try to extract cluster number if missing
      if (['find_markers', 'cluster_info', 'rename_cluster'].includes(action) && (params.cluster === null || params.cluster === undefined)) {
        const clusterMatch = userMessage.match(/cluster\s+(\d+)/i);
        if (clusterMatch && clusterMatch[1]) {
          enhancedParams.cluster = parseInt(clusterMatch[1]);
        }
      }

      return enhancedParams;
    };

    // Generate clarification options from top-K if available
    const options = [];

    // Always include the best match as the first option, with enhanced params
    const bestParams = extractMissingParams(best.action, best.params, userMessage);
    options.push({
      action: best.action,
      params: bestParams,
      label: generateActionLabel(best.action, bestParams)
    });

    // Add top-K alternatives (excluding the best one if it's already in topK)
    if (best.topK && best.topK.length > 0) {
      const seenActions = new Set([best.action]);
      for (const item of best.topK) {
        if (item.action !== best.action && !seenActions.has(item.action) && options.length < 4) {
          const itemParams = extractMissingParams(item.action, item.params, userMessage);
          options.push({
            action: item.action,
            params: itemParams,
            label: generateActionLabel(item.action, itemParams)
          });
          seenActions.add(item.action);
        }
      }
    }

    // If we still don't have enough options, add from top-K alternatives
    if (options.length < 3 && best.topK && best.topK.length > 1) {
      const seenActions = new Set(options.map(opt => opt.action));
      for (const item of best.topK.slice(1)) {
        if (!seenActions.has(item.action) && options.length < 4) {
          const itemParams = extractMissingParams(item.action, item.params, userMessage);
          options.push({
            action: item.action,
            params: itemParams,
            label: generateActionLabel(item.action, itemParams)
          });
          seenActions.add(item.action);
        }
      }
    }

    // Generate contextual explanation
    const explanation = options.length > 1
      ? `I'm not entirely sure what you want. Here are some options that might match:`
      : `I'm not entirely sure what you want. Did you mean: ${generateActionLabel(best.action, bestParams)}?`;

    return RouterResult.askClarify(
      options,
      explanation
    );
  }

  // Return the intent model result
  return best;
}

/**
 * Generate a human-readable label for an action
 */
function generateActionLabel(action, params = {}) {
  const labels = {
    'plot_gene_expression': `Plot expression for ${params.gene || 'gene'}`,
    'plot_gene_violin': `Create violin plot for ${params.gene || 'gene'}`,
    'plot_gene_dotplot': `Create dot plot for ${params.genes ? params.genes.join(', ') : 'genes'}`,
    'find_markers': `Find markers for ${params.cluster !== null && params.cluster !== undefined ? `cluster ${params.cluster}` : 'clusters'}`,
    'deg_between_samples': `DEG for cluster ${params.cluster ?? '?'} between ${params.sample1 ?? 'sample1'} vs ${params.sample2 ?? 'sample2'}`,
    'plot_cell_fraction': 'Plot cell fraction / proportion per cluster per sample',
    'cluster_info': `Get info about ${params.cluster !== null && params.cluster !== undefined ? `cluster ${params.cluster}` : 'cluster'}`,
    'run_umap': 'Run UMAP dimensionality reduction',
    'cluster_and_visualize': 'Cluster cells and visualize',
    'run_qc': 'Run quality control',
    'rename_cluster': `Rename cluster ${params.oldLabel || ''} to ${params.newLabel || ''}`,
    'show_parameters': 'Show analysis parameters',
    'gene_info': `Get information about ${params.gene || 'gene'}`,
    'set_colormap': `Change color map${params.colorMap ? ` to ${params.colorMap.name || 'custom'}` : ''}`,
    'highlight_rna_cluster_on_atac': `Highlight RNA cluster ${params.cluster !== null && params.cluster !== undefined ? params.cluster : ''} on ATAC view`,
    'clear_rna_highlight_on_atac': 'Clear RNA cluster highlight on ATAC view',
    'highlight_atac_cluster_on_rna': `Highlight ATAC cluster ${params.cluster !== null && params.cluster !== undefined ? params.cluster : ''} on RNA view`,
    'clear_atac_highlight_on_rna': 'Clear ATAC cluster highlight on RNA view',
    'update_cell_filtering': `Update cell filtering${params.detected_threshold ? ` (min genes: ${params.detected_threshold})` : ''}`,
    'update_variable_genes': `Set variable genes to ${params.num_hvgs || 'N'}`,
    'update_clustering_resolution': `Set clustering resolution to ${params.resolution || 'N'}`,
    'update_pca_for_umap': `Set PCA components to ${params.num_pcs || 'N'}`,
    'update_umap_parameters': 'Update UMAP parameters',
    'region_segmentation': `Run BANKSY spatial region segmentation${params.resolution !== undefined ? ` (resolution=${params.resolution})` : ''}${params.lambda !== undefined ? `, lambda=${params.lambda}` : ''}`,
    'impute_gene': `Impute${params.gene ? ` gene ${params.gene}` : ' gene'} expression using SpaGE (scRNA-seq reference required)`,
    'link_peaks': `Find peak–gene links${params.gene ? ` for gene ${params.gene}` : ' (scMultiome LinkPeaks)'}`,
    'show_peak_gene_links': `Show peak–gene arc plot for ${params.gene || 'gene'}`,
  };

  return labels[action] || action;
}

/**
 * Validate that required parameters are present
 */
export function validateActionParams(action, params = {}) {
  const requiredParams = {
    'plot_gene_expression': ['gene'],
    'plot_gene_violin': ['gene'],
    'plot_gene_dotplot': ['genes'],
    'find_markers': [], // cluster is optional
    'deg_between_samples': [], // cluster, sample1, sample2 optional (can use dataset names)
    'plot_cell_fraction': [],
    'cluster_info': [], // cluster is optional
    'rename_cluster': ['oldLabel', 'newLabel'],
    'set_colormap': ['colorMap'],
    'highlight_rna_cluster_on_atac': [], // cluster optional (number or label)
    'clear_rna_highlight_on_atac': [],
    'highlight_atac_cluster_on_rna': [], // cluster optional (number or label)
    'clear_atac_highlight_on_rna': [],
    'update_cell_filtering': [], // at least one of detected_threshold, sum_threshold, mito_threshold
    'update_variable_genes': ['num_hvgs'],
    'update_clustering_resolution': ['resolution'],
    'update_pca_for_umap': ['num_pcs'],
    'update_umap_parameters': [], // at least one of min_dist, num_neighbors
    'region_segmentation': [],
    'impute_gene': [],
    'link_peaks': [],           // gene is optional, runs genome-wide if omitted
    'show_peak_gene_links': ['gene'],
  };

  const required = requiredParams[action] || [];
  const missing = required.filter(param => !params[param]);

  if (missing.length > 0) {
    return {
      valid: false,
      missing,
      message: `Missing required parameters: ${missing.join(', ')}`
    };
  }

  return { valid: true };
}
