const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.75,
  MEDIUM: 0.5,
  LOW: 0.3,
};

export const INPUT_TYPES = {
  COMMAND: 'command',
  QUESTION: 'question',
  NAVIGATION: 'navigation',
  UNKNOWN: 'unknown'
};

export function classifyInputType(userMessage) {
  const lower = userMessage.toLowerCase().trim();

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

  const questionPatterns = [
    /^(what|how|why|when|where)\s+(?:is|are|does|do|can|will|would)(?!\s+about\s+cluster)/i,
    /^(can\s+you\s+)?(?:tell|explain|describe)\s+(?:me\s+)?(?:about|what|how)(?!\s+cluster)/i,
    /^(?:what|which)\s+(?:is|are)\s+(?:the\s+)?(?:meaning|definition|purpose|role|function)/i,
    /^(?:do\s+you\s+)?know\s+(?:about|what|how)(?!\s+cluster)/i,
    /^(?:is|are)\s+(?:there|this|that)\s+(?:a|any)/i,
    /^(?:what|how)\s+(?:does|do)\s+(?:this|that|it|the)/i,
    /^(?:what|how)\s+(?:can|should)\s+(?:i|we)/i,
    /^(?:what|which)\s+(?:does|do)\s+(?:this|that|it)\s+(?:mean|indicate|show)/i,
    /^what\s+about\s+(?!cluster)/i,
  ];

  for (const pattern of questionPatterns) {
    if (pattern.test(lower)) {
      return { type: INPUT_TYPES.QUESTION, confidence: 0.85 };
    }
  }

  const commandPatterns = [
    /^(plot|show|display|visualize|create|run|execute|find|get|set|change|update|rename)/i,
    /^(?:please\s+)?(?:can\s+you\s+)?(?:plot|show|display|run|find|get)/i,
    /^(?:i\s+)?(?:want|would like|need)\s+(?:to\s+)?(?:plot|show|see|run|find|get)/i,
    /^what\s+about\s+cluster/i,
    /^do\s+you\s+know\s+(?:anything\s+)?about\s+cluster/i,
  ];

  for (const pattern of commandPatterns) {
    if (pattern.test(lower)) {
      return { type: INPUT_TYPES.COMMAND, confidence: 0.6 };
    }
  }

  return { type: INPUT_TYPES.UNKNOWN, confidence: 0.3 };
}

export class RouterResult {
  constructor(action, params = {}, confidence = 0.5, source = 'unknown', explanation = '') {
    this.action = action;
    this.params = params;
    this.confidence = confidence;
    this.source = source;
    this.explanation = explanation;
    this.needsClarification = confidence < CONFIDENCE_THRESHOLDS.HIGH;
    this.topK = [];
  }

  static none(explanation = 'No confident match found') {
    return new RouterResult('NONE', {}, 0, 'none', explanation);
  }

  static askClarify(options = [], explanation = 'Please clarify your request') {
    return new RouterResult('ASK_CLARIFY', { options }, 0.3, 'router', explanation);
  }
}

export async function routeIntent(userMessage, dataContext, options = {}) {
  const {
    intentClassifier = null,
    inputTypeClassifier = classifyInputType,
    minConfidence = CONFIDENCE_THRESHOLDS.MEDIUM,
    enableClarification = true,
  } = options;

  const typeResult = inputTypeClassifier(userMessage);
  console.log('Input type classification:', typeResult);

  let intentResult = null;
  if (intentClassifier) {
    try {
      const intentMatch = await intentClassifier(userMessage, dataContext);
      if (intentMatch) {
        const confidence = intentMatch.confidence ||
          (intentMatch.action === 'unknown' ? 0.1 : 0.6);

        intentResult = new RouterResult(
          intentMatch.action,
          intentMatch.params || {},
          confidence,
          'intent_model',
          `Intent model classified with confidence ${confidence.toFixed(2)}`
        );

        if (intentMatch.nonCommand) {
          intentResult.nonCommand = intentMatch.nonCommand;
          intentResult.nonCommandMessage = intentMatch.message || null;
        }

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

  if (!intentResult) {
    return RouterResult.none('No intent classifier available');
  }

  const best = intentResult;

  if (best.action === 'NONE' || best.action === 'ASK_CLARIFY' || best.action === 'unknown') {
    if (best.action === 'unknown') {
      return RouterResult.none('Intent model returned unknown');
    }
    if (intentResult && intentResult.nonCommand && intentResult.nonCommandMessage) {
      const result = RouterResult.none(intentResult.nonCommandMessage);
      result.params = { nonCommand: intentResult.nonCommand };
      return result;
    }
    if (intentResult && intentResult.params && intentResult.params._suggestChaining) {
      return RouterResult.none('Intent model detected chained commands - use chaining handler');
    }

    if (enableClarification && best.action === 'NONE') {
      const isUnrelatedInput = best.confidence < 0.3 &&
                               (!best.topK || best.topK.length === 0 || best.topK[0].confidence < 0.3);

      const typeResult = inputTypeClassifier(userMessage);
      const isTrulyUnrelated = isUnrelatedInput ||
                               (typeResult.type === INPUT_TYPES.UNKNOWN && best.confidence < 0.3);

      if (isTrulyUnrelated) {
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

  if (best.confidence < minConfidence && enableClarification) {
    const isUnrelatedInput = best.confidence < 0.3;
    const typeResult = inputTypeClassifier(userMessage);
    const isTrulyUnrelated = isUnrelatedInput &&
                             (typeResult.type === INPUT_TYPES.UNKNOWN ||
                              (!best.topK || best.topK.length === 0 || (best.topK[0] && best.topK[0].confidence < 0.3)));

    if (isTrulyUnrelated) {
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

    const extractMissingParams = (action, params, userMessage) => {
      const enhancedParams = { ...params };

      if (['plot_gene_expression', 'plot_gene_violin'].includes(action) && !params.gene) {
        const genePatterns = [
          /(?:coverage\s+plot|plot\s+coverage)\s+(?:for\s+)?([A-Za-z0-9-]+)/i,
          /(?:plot|show)\s+(?:me\s+)?(?:gene\s+)?(chr\w+:\d+-\d+)/i,
          /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,
          /(?:plot|show)\s+(?:me\s+)?gene\s+activi?ty\s+([A-Za-z0-9-]+)/i,
          /(?:plot|show)\s+(?:me\s+)?gene\s+([A-Za-z0-9-]+)/i,
          /(?:show|plot)\s+me\s+([A-Za-z0-9-]+)/i,
          /(?:show|plot)\s+([A-Za-z0-9-]+)(?:\s|$|\.|,)/i,
          /(?:plot|show)\s+(?:me\s+)?(?:gene\s+)?([A-Za-z0-9-]+)\s+(?:expression|on\s+umap)/i,
          /^(?:plot|show)\s+(?:me\s+)?([A-Za-z0-9-]+)\s*$/i,
          /what\s+is\s+(?:the\s+)?(?:gene\s+)?expression\s+(?:for|of)\s+([A-Za-z0-9-]+)/i,
          /gene\s+expression\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,
          /(?:expression|gene)\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,
          /([A-Za-z0-9-]+)\s+expression(?:\s+plot)?/i,
          /expression\s+([A-Za-z0-9-]+)/i,
          /gene\s+([A-Za-z0-9-]+)/i,
        ];

        const stopwords = new Set(['gene', 'genes', 'expression', 'cells', 'umap', 'show', 'plot', 'me', 'the', 'for', 'of', 'activity', 'coverage']);

        for (const pattern of genePatterns) {
          const match = userMessage.match(pattern);
          if (match && match[1] && !stopwords.has(match[1].toLowerCase()) && match[1].length >= 2) {
            enhancedParams.gene = match[1];
            console.log(`Extracted missing gene parameter: ${match[1]}`);
            break;
          }
        }
      }

      if (['find_markers', 'cluster_info', 'rename_cluster'].includes(action) && (params.cluster === null || params.cluster === undefined)) {
        const clusterMatch = userMessage.match(/cluster\s+(\d+)/i);
        if (clusterMatch && clusterMatch[1]) {
          enhancedParams.cluster = parseInt(clusterMatch[1]);
          console.log(`Extracted missing cluster parameter: ${clusterMatch[1]}`);
        }
      }

      return enhancedParams;
    };

    const options = [];

    const bestParams = extractMissingParams(best.action, best.params, userMessage);
    options.push({
      action: best.action,
      params: bestParams,
      label: generateActionLabel(best.action, bestParams)
    });

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

    const explanation = options.length > 1
      ? `I'm not entirely sure what you want. Here are some options that might match:`
      : `I'm not entirely sure what you want. Did you mean: ${generateActionLabel(best.action, bestParams)}?`;

    return RouterResult.askClarify(
      options,
      explanation
    );
  }

  return best;
}

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
    'rename_cluster': params.oldLabel && params.newLabel ? `Rename cluster ${params.oldLabel} to ${params.newLabel}` : 'Rename a cluster (e.g. "rename cluster 3 to PT")',
    'rename_region': params.oldLabel && params.newLabel ? `Rename region ${params.oldLabel} to ${params.newLabel}` : 'Rename a BANKSY region (e.g. "rename region 2 to medulla")',
    'show_parameters': 'Show analysis parameters',
    'gene_info': `Get information about ${params.gene || 'gene'}`,
    'set_colormap': `Change color map${params.colorMap ? ` to ${params.colorMap.name || 'custom'}` : ''}`,
    'highlight_cluster': `Highlight ${params.cluster !== null && params.cluster !== undefined ? `cluster ${params.cluster}` : 'a cluster'}`,
    'clear_cluster_highlight': 'Clear the cluster highlight',
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

export function validateActionParams(action, params = {}) {
  const requiredParams = {
    'plot_gene_expression': ['gene'],
    'plot_gene_violin': ['gene'],
    'plot_gene_dotplot': ['genes'],
    'find_markers': [],
    'deg_between_samples': [],
    'plot_cell_fraction': [],
    'cluster_info': [],
    'rename_cluster': ['oldLabel', 'newLabel'],
    'set_colormap': ['colorMap'],
    'highlight_cluster': [],
    'clear_cluster_highlight': [],
    'highlight_rna_cluster_on_atac': [],
    'clear_rna_highlight_on_atac': [],
    'highlight_atac_cluster_on_rna': [],
    'clear_atac_highlight_on_rna': [],
    'update_cell_filtering': [],
    'update_variable_genes': ['num_hvgs'],
    'update_clustering_resolution': ['resolution'],
    'update_pca_for_umap': ['num_pcs'],
    'update_umap_parameters': [],
    'region_segmentation': [],
    'impute_gene': [],
    'link_peaks': [],
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
