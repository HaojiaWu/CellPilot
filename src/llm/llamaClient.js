export class LlamaClient {
  constructor(modelId) {
    this.modelId = modelId;
    this.model = null;
    this.context = null;
  }

  async initialize() {
    try {
      
      console.log(`Initializing model: ${this.modelId}`);
      
      
      return true;
    } catch (error) {
      console.error('Failed to initialize llama model:', error);
      return false;
    }
  }

  async parseCommand(userMessage, dataInfo, conversationHistory = [], lastPlotContext = null) {
    
    const lower = userMessage.toLowerCase();
    
    const isReferencingPrevious = (
      lower.includes('it') || 
      lower.includes('that') || 
      lower.includes('the plot') ||
      lower.includes('this plot') ||
      lower.includes('same') ||
      (lower.includes('change') && !lower.includes('gene')) ||
      (lower.includes('update') && !lower.includes('gene'))
    );
    
    const colorDirective = this.extractColorDirective(userMessage);
    
    if (isReferencingPrevious && colorDirective && lastPlotContext?.action === 'plot_gene_expression') {
      console.log('LLM: Detected context-aware colormap change for gene:', lastPlotContext.gene);
      return {
        action: 'plot_gene_expression',
        params: { 
          gene: lastPlotContext.gene,
          colorMap: colorDirective
        }
      };
    }
    
    const wantsViolin = lower.includes('violin');

    const stopwords = new Set(['gene','expression','cells','umap','please','show','plot','me','the','for','of','color','colour','to','violin']);
    const genePatterns = [
      /gene\s+expression\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,
      /(?:plot|show)\s+(?:me\s+)?(?:gene\s+)?([A-Za-z0-9-]+)\s+(?:expression|on\s+umap)/i,
      /(?:expression|gene)\s+(?:of|for)\s+([A-Za-z0-9-]+)/i,
      /([A-Za-z0-9-]+)\s+expression/i,
      /expression\s+([A-Za-z0-9-]+)/i,
      /gene\s+([A-Za-z0-9-]+)/i,
      /([A-Za-z0-9-]+)\s+on\s+umap/i,
    ];
    let geneMatch = null;
    for (const pattern of genePatterns) {
      const m = userMessage.match(pattern);
      if (m && m[1] && !stopwords.has(m[1].toLowerCase())) {
        geneMatch = m;
        break;
      }
    }

    if (wantsViolin && !geneMatch) {
      const violinPatterns = [
        /violin\s+plot\s+(?:for\s+)?([A-Za-z0-9-]+)/i,
        /([A-Za-z0-9-]+)\s+violin\s+plot/i,
        /violin\s+([A-Za-z0-9-]+)/i,
      ];
      for (const pattern of violinPatterns) {
        const m = userMessage.match(pattern);
        if (m && m[1] && !stopwords.has(m[1].toLowerCase())) {
          geneMatch = m;
          break;
        }
      }
    }
    
    if (lower.includes('rerun') || lower.includes('re-run') ||
        lower.includes('recluster') || lower.includes('re-cluster') ||
        lower.includes('reanalyze') || lower.includes('re-analyze') ||
        lower.includes('recalculate') || lower.includes('re-calculate') ||
        (lower.includes('run') && lower.includes('again')) ||
        (lower.includes('compute') && lower.includes('again'))) {
      return {
        action: 'force_reanalysis',
        params: { method: 'umap' }
      };
    }

    if (lower.includes('cluster') && (lower.includes('umap') || lower.includes('visualize'))) {
      return {
        action: 'cluster_and_visualize',
        params: { method: 'umap' }
      };
    }
    
    if (lower.includes('umap') || lower.includes('dimension reduction') || lower.includes('embedding')) {
      return {
        action: 'run_umap',
        params: {}
      };
    }
    
    if (wantsViolin && geneMatch) {
      return {
        action: 'plot_gene_violin',
        params: { gene: geneMatch[1] }
      };
    }

    if (geneMatch || lower.includes('expression') || lower.includes('plot gene')) {
      return {
        action: 'plot_gene_expression',
        params: { 
          gene: geneMatch ? geneMatch[1] : null,
          colorMap: colorDirective
        }
      };
    }
    
    if (lower.includes('marker')) {
      const clusterMatch = userMessage.match(/cluster\s+(\d+)/i);
      return {
        action: 'find_markers',
        params: { cluster: clusterMatch ? parseInt(clusterMatch[1]) : null }
      };
    }
    
    if (lower.includes('qc') || lower.includes('quality') || lower.includes('filter')) {
      return {
        action: 'run_qc',
        params: {}
      };
    }
    
    if (lower.includes('pca') || lower.includes('principal component')) {
      return {
        action: 'run_pca',
        params: {}
      };
    }

    if (lower.includes('normalize') || lower.includes('normalization')) {
      return {
        action: 'normalize',
        params: {}
      };
    }

    return {
      action: 'general_analysis',
      params: { query: userMessage }
    };
  }

  extractColorDirective(text) {
    const lower = text.toLowerCase();
    const knownColorSchemes = ['viridis', 'magma', 'inferno', 'plasma', 'cividis', 'turbo', 'cubehelix'];

    for (const scheme of knownColorSchemes) {
      if (lower.includes(scheme)) {
        return { type: 'scheme', name: scheme };
      }
    }

    const customMatch = text.match(/color(?:\s?bar|\s?map)?(?:\s+use|\s+with|\s+to)?\s+([a-zA-Z,\s]+)/i);
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
  }

  async generateResponse(results) {
    
    if (results.type === 'umap') {
      if (results.clusters) {
        const nClusters = new Set(results.clusters).size;
        return `I've created a UMAP visualization showing ${nClusters} clusters in your data. The plot shows cells colored by their cluster assignment.`;
      } else {
        return `I've created a UMAP visualization of your data. This shows the overall structure of your single-cell dataset in 2D space.`;
      }
    }
    
    if (results.type === 'gene_expression') {
      return `I've plotted the expression of ${results.geneName} across your cells on the UMAP. Higher expression is shown in brighter colors.`;
    }
    
    if (results.type === 'markers') {
      const markerList = Array.isArray(results.markers) ? results.markers : [];
      const topGenes = markerList.slice(0, 5).map((entry) => entry.gene).filter(Boolean);
      const summary =
        topGenes.length > 0
          ? `Top genes: ${topGenes.join(', ')}.`
          : `Reported ${markerList.length} marker genes.`;
      return `I've prepared the marker gene table for cluster ${results.cluster}. ${summary}`;
    }
    
    if (results.type === 'qc') {
      return `Quality control metrics:\n- ${results.metrics.nCells} cells\n- ${results.metrics.nGenes} genes\n- Median genes/cell: ${results.metrics.medianGenesPerCell}\n- Median UMIs/cell: ${results.metrics.medianUMIsPerCell}`;
    }
    
    return 'Analysis complete!';
  }

  static async downloadModel(modelId, progressCallback) {
    
    console.log(`Downloading model: ${modelId}`);
    
    for (let i = 0; i <= 100; i += 10) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (progressCallback) {
        progressCallback(i);
      }
    }
    
    return true;
  }

  static getAvailableModels() {
    return [
      {
        id: 'llama-3.2-1b-instruct',
        name: 'Llama 3.2 1B Instruct',
        size: '~1.3GB',
        description: 'Fast, compact model',
      },
      {
        id: 'llama-3.2-3b-instruct',
        name: 'Llama 3.2 3B Instruct',
        size: '~3.2GB',
        description: 'Balanced performance',
      },
      {
        id: 'llama-3.1-8b-instruct',
        name: 'Llama 3.1 8B Instruct',
        size: '~8GB',
        description: 'High accuracy',
      },
    ];
  }
}

export default LlamaClient;

