import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { Button, InputGroup, Icon, Tag } from '@blueprintjs/core';
import ReactMarkdown from 'react-markdown';
import './ChatBot.css';
import chatbotIcon from '../assets/chatbot.png';
import {
  classifyIntent,
  isModelLoaded,
  getUnknownResponseMessage,
  setLastActionContext,
  getLastActionContext,
  isChatModelLoaded,
  getCurrentChatModel,
  generateChatResponse
} from '../llm/webllmService';
import {
  routeIntent
} from '../llm/intentRouter';
import {
  fetchProviderModels,
  getApiConfig,
  getFallbackProviderModels,
  setApiKey,
  setApiModel
} from '../llm/apiChatService';
import {
  AGENT_PROVIDERS,
  generateCellTypeMarkers,
  generateClusterAnnotation,
  generateBulkClusterAnnotation,
  generateAgentPlan,
  generateAgentResultSummary,
  getConfiguredAgentProvider,
  maskApiKey
} from '../llm/agentService';

const OBVIOUS_NON_GENES = new Set([
  'you', 'me', 'the', 'a', 'an', 'it', 'is', 'are', 'do', 'can', 'we', 'they', 'he', 'she',
  'their', 'our', 'your', 'my', 'i', 'us', 'him', 'her', 'them', 'this', 'that', 'these', 'those'
]);
const API_CHAT_MODEL_IDS = new Set(['chatgpt', 'claude', 'gemini', 'groq', 'openrouter']);
const AGENT_TOOL_TIMEOUT_MS = 120000;
const SPATIAL_REGION_MARKER_TIMEOUT_MS = 10 * 60 * 1000;
const SPATIAL_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

const ChatBot = forwardRef(({ dataLoaded, dataInfo, selectedModel, clusterLabelMap, atacClusterLabelMap, wnnActive, wnnClusterLabelMap, spatialSelection, rnaClusters, atacClusters, wnnClusters, isAnalyzing, analysisStatusMessage, onAnalysisRequest, onSetColorMap, onSetClusterColor, onHighlightRnaClusterOnAtac, onHighlightAtacClusterOnRna }, ref) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastPlotContext, setLastPlotContext] = useState(null); // Stores info about the last plot
  const [llmAvailable, setLlmAvailable] = useState(false); // Track embedding model availability
  const [pendingClarificationOptions, setPendingClarificationOptions] = useState(null); // Store clarification options for user selection
  const [agentMode, setAgentMode] = useState(false);
  const [localChatMode, setLocalChatMode] = useState(false);
  const [agentProvider, setAgentProvider] = useState(null);
  const [awaitingAgentProvider, setAwaitingAgentProvider] = useState(false);
  const [awaitingAgentApiKey, setAwaitingAgentApiKey] = useState(false);
  const [awaitingAgentModel, setAwaitingAgentModel] = useState(false);
  const [agentModelOptions, setAgentModelOptions] = useState([]);
  const [pendingAgentConfirmation, setPendingAgentConfirmation] = useState(null);
  const [awaitingChatModeChoice, setAwaitingChatModeChoice] = useState(false);
  const [chatModePreference, setChatModePreference] = useState(null);
  const [tissueContext, setTissueContext] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null); // Reference to the input field
  const annotateClusterResultRef = useRef(null);
  const pendingAgentToolResultsRef = useRef([]);
  const pendingDatasetListRef = useRef(null);

  const AGENT_WAIT_FOR_RESULT_ACTIONS = new Set([
    'plot_gene_expression',
    'plot_spatial_gene',
    'plot_gene_violin',
    'plot_gene_dotplot',
    'find_markers',
    'spatial_region_markers',
    'spatial_cell_interaction',
    'cluster_info',
    'identify_cell_type_clusters',
    'show_parameters',
    'deg_between_samples',
    'plot_cell_fraction',
    'tf_motif_analysis',
    'show_peak_gene_links',
    'link_peaks',
  ]);

  // Check model availability on mount and periodically
  useEffect(() => {
    const checkModels = () => {
      const embeddingAvailable = isModelLoaded();
      const chatLoaded = isChatModelLoaded();
      const currentChatModel = getCurrentChatModel();
      setLlmAvailable(embeddingAvailable);
      setLocalChatMode(chatLoaded && currentChatModel && !API_CHAT_MODEL_IDS.has(currentChatModel));
    };
    checkModels();

    // Re-check periodically in case models load
    const interval = setInterval(checkModels, 2000);
    return () => clearInterval(interval);
  }, []);

  const effectiveLocalChatMode = !agentMode && chatModePreference !== 'intent' && (
    chatModePreference === 'local' || localChatMode
  );

  useEffect(() => {
    // Welcome message
    addBotMessage(
      'Hey, I am CellPilot from Humphreys Lab. What can I help you today?'
    );
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Keep focus in chat input after the bot responds so the user can type the next message immediately
  useEffect(() => {
    if (!isProcessing && !isAnalyzing) {
      inputRef.current?.focus();
    }
  }, [isProcessing, isAnalyzing]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const addUserMessage = (text) => {
    setMessages(prev => [...prev, { type: 'user', text, timestamp: new Date() }]);
  };

  const addBotMessage = (text, intent = 'none') => {
    setMessages(prev => [...prev, { type: 'bot', text, timestamp: new Date(), intent }]);
  };

  const handleAnalysisResultForAgent = (payload) => {
    const pending = pendingAgentToolResultsRef.current.shift();
    if (pending) {
      pending.resolve(payload);
    }
  };

  const detectDatasetListRequest = (text) => {
    const lower = (text || '').toLowerCase().trim();
    const explicitlyLists = /\blist\b/.test(lower);
    const asksForDatasetList = explicitlyLists ||
      /\b(show|display)\s+(?:me\s+)?(?:the\s+)?(?:all\s+|available\s+|dataset\s+)?(?:genes|features|peaks|cells|cell\s+ids|cell\s+names|barcodes)\b/.test(lower) ||
      /\b(show|display)\s+(?:me\s+)?(?:the\s+)?(?:first\s+|top\s+)?\d{1,6}\s+(?:genes|features|peaks|cells|cell\s+ids|cell\s+names|barcodes)\b/.test(lower) ||
      /\b(?:genes|features|peaks|cells|cell\s+ids|cell\s+names|barcodes)\s+(?:of|in|from)\s+(?:this\s+)?dataset\b/.test(lower);
    if (!asksForDatasetList) return null;
    const countMatch = lower.match(/\b(?:list|show|display)\s+(?:me\s+)?(?:the\s+)?(?:first\s+|top\s+)?(\d{1,6})\s+(?:genes|features|peaks|cells|cell\s+ids|cell\s+names|barcodes)\b/) ||
      lower.match(/\b(?:genes|features|peaks|cells|cell\s+ids|cell\s+names|barcodes)\s+(?:limit|count|number)?\s*(?:of\s+)?(\d{1,6})\b/);
    const requestedCount = countMatch ? Math.max(1, parseInt(countMatch[1], 10)) : null;
    const initialLimit = requestedCount ? Math.min(100, requestedCount) : (/\ball\b/.test(lower) ? 100 : 50);
    const remainingAfterFirstPage = requestedCount ? Math.max(0, requestedCount - initialLimit) : null;
    if (/\b(cells|cell\s+ids|cell\s+names|barcodes)\b/.test(lower)) {
      return { kind: 'cells', initialLimit, remainingAfterFirstPage };
    }
    if (/\b(genes|features|peaks)\b/.test(lower)) {
      return { kind: 'genes', initialLimit, remainingAfterFirstPage };
    }
    return null;
  };

  const requestDatasetListPage = (kind, offset = 0, limit = 50, options = {}) => {
    const result = onAnalysisRequest?.({
      action: 'list_dataset_items',
      params: { kind, offset, limit: Math.min(100, limit) },
    });
    if (result?.error) {
      pendingDatasetListRef.current = null;
      addBotMessage(result.error, 'warning');
      return false;
    }
    pendingDatasetListRef.current = {
      kind,
      offset,
      limit: Math.min(100, limit),
      requestedRemaining: Number.isFinite(options.requestedRemaining) ? Math.max(0, options.requestedRemaining) : null,
    };
    return true;
  };

  const handleDatasetListResult = (data) => {
    const pendingRequest = pendingDatasetListRef.current;
    const kind = data?.kind === 'cells' ? 'cells' : 'genes';
    const label = data?.itemLabel || kind;
    const items = Array.isArray(data?.items) ? data.items : [];
    const total = Number.isFinite(data?.total) ? data.total : items.length;
    const start = (Number.isFinite(data?.offset) ? data.offset : 0) + 1;
    const end = (Number.isFinite(data?.offset) ? data.offset : 0) + items.length;

    if (!items.length) {
      pendingDatasetListRef.current = null;
      addBotMessage(`I could not find any ${label} for this dataset.`, 'warning');
      return;
    }

    const listText = items.map((item, idx) => `${start + idx}. ${item}`).join('\n');
    const requestedRemaining = Number.isFinite(pendingRequest?.requestedRemaining)
      ? Math.max(0, pendingRequest.requestedRemaining)
      : null;
    const nextRequestedRemaining = requestedRemaining == null ? null : requestedRemaining;
    const canShowMore = data?.hasMore && (nextRequestedRemaining == null || nextRequestedRemaining > 0);
    const moreText = canShowMore
      ? `\n\nDo you want to see more ${label}?`
      : data?.hasMore
        ? `\n\nListed the requested number of ${label}.`
        : `\n\nThat is the end of the ${label} list.`;

    addBotMessage(`**${label[0].toUpperCase()}${label.slice(1)} ${start}-${end} of ${total.toLocaleString()}:**\n\n${listText}${moreText}`, 'info');
    pendingDatasetListRef.current = canShowMore
      ? { kind, offset: data.nextOffset, limit: Math.min(100, nextRequestedRemaining ?? 100), requestedRemaining: nextRequestedRemaining }
      : null;
  };

  const createAgentToolResultWait = (timeoutMs = AGENT_TOOL_TIMEOUT_MS) => {
    const entry = {
      resolve: (payload) => {
        clearTimeout(entry.timeout);
        entry.done = true;
        entry._resolve(payload);
      },
      cancel: () => {
        clearTimeout(entry.timeout);
        pendingAgentToolResultsRef.current = pendingAgentToolResultsRef.current.filter(item => item !== entry);
        if (!entry.done) {
          entry.done = true;
          entry._resolve(null);
        }
      },
      timeout: null,
      done: false,
      _resolve: null,
    };
    const promise = new Promise(resolve => {
      entry._resolve = resolve;
    });
    entry.timeout = setTimeout(() => {
      pendingAgentToolResultsRef.current = pendingAgentToolResultsRef.current.filter(item => item !== entry);
      if (!entry.done) {
        entry.done = true;
        entry._resolve(null);
      }
    }, timeoutMs);
    pendingAgentToolResultsRef.current.push(entry);
    return { promise, cancel: entry.cancel };
  };

  // Expose addBotMessage to parent component via ref
  useImperativeHandle(ref, () => ({
    addBotMessage,
    annotateClusterResult: (...args) => annotateClusterResultRef.current?.(...args),
    handleAnalysisResultForAgent,
    handleDatasetListResult,
  }));

  /**
   * Detect and split chained commands
   * Smart detection that only splits when "and" or ", then" clearly separates commands,
   * not when they specify parameters (e.g., multiple genes in one plot)
   *
   * Examples that SHOULD be chained:
   * "rename cluster 15 to Pod, then cluster 16 to EC"
   * "rename cluster 1 to A and cluster 2 to B"
   * "rerun umap, then plot gene slc5a2"
   *
   * Examples that should NOT be chained:
   * "plot genes nphs2 and slc5a2" (single command with multiple genes)
   * "dotplot for slc5a2 and nphs2" (single command with multiple genes)
   */
  const splitChainedCommands = (text) => {
    // First, check for patterns that should NEVER be split (parameter lists)
    // These patterns use "and" to specify multiple parameters, not multiple commands

    // Pattern: "plot genes X and Y" or "plot gene X and Y" (with optional prefix like "can you")
    const multiGenePlotPattern = /(?:^|^can\s+you\s+)(?:plot|show|display)\s+(?:genes?|gene\s+expression)\s+[A-Za-z0-9-]+\s+and\s+[A-Za-z0-9-]+/i;
    if (multiGenePlotPattern.test(text)) {
      return [text];
    }

    // Pattern: "dotplot for X and Y" or "dot plot for X and Y"
    const multiGeneDotplotPattern = /(?:^|^can\s+you\s+)(?:dotplot|dot\s+plot)\s+(?:for|of)\s+[A-Za-z0-9-]+\s+and\s+[A-Za-z0-9-]+/i;
    if (multiGeneDotplotPattern.test(text)) {
      return [text];
    }

    // Pattern: "plot X and Y" (when X and Y look like gene names)
    // This catches "plot nphs2 and slc5a2" or "can you plot nphs2 and slc5a2"
    const plotAndMatch = text.match(/(?:^|^can\s+you\s+)(?:plot|show|display)\s+([A-Za-z0-9-]+)\s+and\s+([A-Za-z0-9-]+)/i);
    if (plotAndMatch && plotAndMatch[1] && plotAndMatch[2]) {
      const part1 = plotAndMatch[1];
      const part2 = plotAndMatch[2];
      // Check if both parts look like gene names (alphanumeric, not just numbers, not "cluster")
      // Gene names are typically alphanumeric and not common words
      const isGeneName = (str) => {
        return str.length >= 2 &&
               /^[A-Za-z0-9-]+$/.test(str) &&
               !str.match(/^\d+$/) &&
               !['cluster', 'gene', 'genes', 'plot', 'show', 'display'].includes(str.toLowerCase());
      };

      if (isGeneName(part1) && isGeneName(part2)) {
        return [text];
      }
    }

    // Now check for patterns that SHOULD be chained

    // Pattern 1: ", then" or ", and then" is almost always chaining
    // "rerun umap, then plot gene X" or "rerun umap, and then plot gene X"
    // "rename X to Y, then rename Z to W" or "rename X to Y, then cluster Z to W"
    // "rename cluster 1 and cluster 3 to PT, then cluster 4 to gEC"
    const thenPattern = /,\s*(?:and\s+)?then\s+/i;
    if (thenPattern.test(text)) {
      // Split by ", then" or ", and then"
      const parts = text.split(/,\s*(?:and\s+)?then\s+/i);
      if (parts.length > 1) {
        // Extract verb from first part for reuse
        const firstPart = parts[0].trim();
        const firstVerbMatch = firstPart.match(/(?:^|^can\s+you\s+|please\s+)(rename|change|set|call|label|plot|show|run|execute|find|get|update|create|display|visualize|cluster|analyze|rerun)/i);
        const firstVerb = firstVerbMatch ? firstVerbMatch[1] : null;

        // Process each part and expand multi-cluster renames
        const allCommands = [];

        for (let idx = 0; idx < parts.length; idx++) {
          let trimmed = parts[idx].trim();
          const cleaned = trimmed.replace(/^(?:can\s+you\s+|please\s+)/i, '');

          // For parts after the first, add verb if needed
          if (idx > 0 && firstVerb) {
            if (/^cluster\s+\d+\s+(?:to|as)\s+/i.test(cleaned) && ['rename', 'change', 'set', 'call', 'label'].includes(firstVerb)) {
              trimmed = `${firstVerb} ${cleaned}`;
            } else if (!/^(?:plot|show|rename|change|run|find|get|set|update|create|display|visualize|execute|analyze|rerun)/i.test(cleaned)) {
              if (cleaned.length > 5) {
                trimmed = `${firstVerb} ${cleaned}`;
              }
            }
          }

          // Check if this part contains multiple clusters being renamed to the same label
          // Pattern: "rename cluster X and cluster Y to Z" or "rename cluster X, cluster Y, and cluster Z to W"
          // Also: "rename cluster X and Y to Z" (missing "cluster" before Y)
          const verbMatch = trimmed.match(/(?:^|^can\s+you\s+|please\s+)?(rename|change|set|call|label)/i);
          const verb = verbMatch ? verbMatch[1] : firstVerb || 'rename';

          // Extract the section between verb and "to/as" to find all cluster numbers
          const sectionMatch = trimmed.match(/(?:^|^can\s+you\s+|please\s+)?(?:rename|change|set|call|label)\s+(.+?)\s+(?:to|as)\s+([^,]+?)(?:\s*,\s*then|$)/i);

          if (sectionMatch) {
            const clusterSection = sectionMatch[1]; // e.g., "cluster 1 and 3" or "cluster 1 and cluster 3"
            const label = sectionMatch[2].trim();

            // Extract all numbers from the cluster section
            // Handles: "cluster 1 and cluster 3", "cluster 1 and 3", "cluster 1, 2, and 3", etc.
            // Simple approach: find all numbers in the section (they're all cluster numbers)
            const clusters = [];

            // Match first cluster explicitly
            const firstMatch = clusterSection.match(/^cluster\s+(\d+)/i);
            if (firstMatch) {
              clusters.push(firstMatch[1]);
            }

            // Then find all other numbers (after comma or "and")
            // Pattern: ", 2" or "and 3" or "and cluster 3"
            const restMatches = clusterSection.matchAll(/(?:,|and)\s+(?:cluster\s+)?(\d+)/gi);
            for (const match of restMatches) {
              if (!clusters.includes(match[1])) {
                clusters.push(match[1]);
              }
            }

            // Fallback: if we didn't find any, try extracting all numbers (less safe but catches edge cases)
            if (clusters.length === 0) {
              const allNumbers = clusterSection.match(/\d+/g);
              if (allNumbers) {
                clusters.push(...allNumbers);
              }
            }

            if (clusters.length > 1 && label) {
              // Expand into separate commands for each cluster
              clusters.forEach(clusterNum => {
                allCommands.push(`${verb} cluster ${clusterNum} to ${label}`);
              });
            } else {
              // Single command
              allCommands.push(trimmed);
            }
          } else {
            // Single command
            allCommands.push(trimmed);
          }
        }

        // Filter to only valid commands
        const validParts = allCommands.filter(part => {
          const trimmed = part.trim();
          const cleaned = trimmed.replace(/^(?:can\s+you\s+|please\s+)/i, '');
          return cleaned.length > 5 && /^(?:plot|show|rename|change|run|find|get|set|update|create|display|visualize|execute|cluster|analyze|rerun)/i.test(cleaned);
        });

        if (validParts.length > 1) {
          return validParts;
        }
      }
    }

    // Pattern 2: Multiple clusters renamed to the same label (without ", then")
    // "rename cluster 1 and cluster 3 to PT" or "rename cluster 1 and 3 to PT" or "rename cluster 1, 2, and 3 to PT"
    const multiClusterSameLabelPattern = /(?:^|^can\s+you\s+)(?:rename|change|set|call|label)\s+(?:cluster\s+\d+(?:\s*(?:,|and)\s+(?:cluster\s+)?\d+)+)\s+(?:to|as)\s+[^,]+$/i;
    if (multiClusterSameLabelPattern.test(text)) {
      const verbMatch = text.match(/(?:^|^can\s+you\s+)(rename|change|set|call|label)/i);
      const verb = verbMatch ? verbMatch[1] : 'rename';

      // Extract all cluster numbers: "cluster N" or ", N" / "and N" / ", cluster N" / "and cluster N"
      const clusterMatches = Array.from(text.matchAll(/(?:cluster\s+|(?:,|and)\s+(?:cluster\s+)?)(\d+)/gi));
      const clusters = clusterMatches.map(m => m[1]);

      // Extract the label
      const labelMatch = text.match(/(?:to|as)\s+([^,]+?)$/i);
      const label = labelMatch ? labelMatch[1].trim() : null;

      if (clusters.length > 1 && label) {
        // Expand into separate commands
        const commands = clusters.map(clusterNum => `${verb} cluster ${clusterNum} to ${label}`);
        return commands;
      }
    }

    // Pattern 3: Chained rename commands with "and" (different labels)
    // "rename cluster X to Y and cluster Z to W"
    // "rename cluster X to Y, and cluster Z to W" (with comma)
    // "rename cluster 1 and 3 to PT, and cluster 16 to EC" (first part has multiple clusters)
    const chainedRenameAndPattern = /(?:^|^can\s+you\s+)(?:rename|change|set|call|label)\s+.*?\s+(?:to|as)\s+[^,]+?(?:,\s*)?\s+and\s+cluster\s+\d+\s+(?:to|as)\s+/i;
    if (chainedRenameAndPattern.test(text)) {
      const commands = [];
      const verbMatch = text.match(/(?:^|^can\s+you\s+)(rename|change|set|call|label)/i);
      const verb = verbMatch ? verbMatch[1] : 'rename';

      // Split by ", and cluster" or " and cluster" to separate the parts
      // This handles: "rename cluster 1 and 3 to PT, and cluster 16 to EC"
      const parts = text.split(/(?:,\s*)?\s+and\s+cluster\s+/i);

      if (parts.length > 1) {
        // Process first part, which might have multiple clusters
        const firstPart = parts[0].trim();
        const firstSectionMatch = firstPart.match(/(?:^|^can\s+you\s+)?(?:rename|change|set|call|label)\s+(.+?)\s+(?:to|as)\s+([^,]+?)$/i);

        if (firstSectionMatch) {
          const clusterSection = firstSectionMatch[1]; // e.g., "cluster 1 and 3"
          const label = firstSectionMatch[2].trim();

          // Extract all cluster numbers from first part
          const firstClusters = [];
          const firstMatch = clusterSection.match(/^cluster\s+(\d+)/i);
          if (firstMatch) {
            firstClusters.push(firstMatch[1]);
          }
          const restMatches = clusterSection.matchAll(/(?:,|and)\s+(?:cluster\s+)?(\d+)/gi);
          for (const match of restMatches) {
            if (!firstClusters.includes(match[1])) {
              firstClusters.push(match[1]);
            }
          }

          // Add commands for all clusters in first part
          firstClusters.forEach(clusterNum => {
            commands.push(`${verb} cluster ${clusterNum} to ${label}`);
          });
        }

        // Process remaining parts: each should be "cluster X to Y"
        for (let i = 1; i < parts.length; i++) {
          const part = `cluster ${parts[i].trim()}`;
          const partMatch = part.match(/cluster\s+(\d+)\s+(?:to|as)\s+([^,]+?)$/i);
          if (partMatch) {
            const clusterNum = partMatch[1];
            const label = partMatch[2].trim();
            commands.push(`${verb} cluster ${clusterNum} to ${label}`);
          }
        }
      } else {
        // Fallback: try the original pattern matching approach
        const clusterPattern = /cluster\s+(\d+)\s+(?:to|as)\s+([^,]+?)(?=\s*(?:,\s*)?\s+and\s+cluster|$)/gi;
        let match;
        while ((match = clusterPattern.exec(text)) !== null) {
          const clusterNum = match[1];
          const label = match[2].trim();
          commands.push(`${verb} cluster ${clusterNum} to ${label}`);
        }
      }

      if (commands.length > 1) {
        return commands;
      }
    }

    // Pattern 3: "and" between clearly different command types
    // "rerun umap and plot gene X": these are different actions, so likely chaining.
    // Be careful: "plot gene X and Y" should NOT be split.
    const differentActionPattern = /\b(?:rerun|run|execute|update|change|set|find|get|create|cluster|analyze)\s+[^and]+?\s+and\s+(?:plot|show|display|visualize|rename|change|set|find|get)/i;
    if (differentActionPattern.test(text) && !multiGenePlotPattern.test(text) && !multiGeneDotplotPattern.test(text)) {
      // Split by " and " but only if it's between different action types
      const parts = text.split(/\s+and\s+(?=(?:plot|show|display|visualize|rename|change|set|find|get|run|execute|update|create|cluster|analyze))/i);
      if (parts.length > 1) {
        const validParts = parts.filter(part => {
          const trimmed = part.trim();
          return trimmed.length > 5;
        });

        if (validParts.length > 1) {
          return validParts;
        }
      }
    }

    return [text]; // No chaining detected, return single command
  };

  /**
   * Check if user input is selecting a clarification option
   * Returns the selected option index (0-based) or null
   */
  const parseOptionSelection = (text, options) => {
    if (!options || options.length === 0) return null;

    const lower = text.toLowerCase().trim();

    // Patterns: "option 1", "1", "first", "first one", "the first one", etc.
    const patterns = [
      /^option\s+(\d+)$/i,
      /^(\d+)$/,
      /^the\s+(\d+)(?:st|nd|rd|th)?\s+one$/i,
      /^(\d+)(?:st|nd|rd|th)?\s+one$/i,
      /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/i,
      /^the\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/i,
    ];

    const numberWords = {
      'first': 1, 'second': 2, 'third': 3, 'fourth': 4, 'fifth': 5,
      'sixth': 6, 'seventh': 7, 'eighth': 8, 'ninth': 9, 'tenth': 10
    };

    for (const pattern of patterns) {
      const match = lower.match(pattern);
      if (match) {
        let num = null;
        if (match[1]) {
          // Try to parse as number
          const parsed = parseInt(match[1]);
          if (!isNaN(parsed)) {
            num = parsed;
          } else if (numberWords[match[1].toLowerCase()]) {
            num = numberWords[match[1].toLowerCase()];
          }
        }

        if (num !== null && num >= 1 && num <= options.length) {
          return num - 1; // Convert to 0-based index
        }
      }
    }

    return null;
  };

  const isAgentModeRequest = (text) => {
    return /\b(agent\s*mode|autopilot|agentic\s*mode|switch\s+(?:me\s+)?to\s+agent|use\s+(?:an\s+)?agent)\b/i.test(text);
  };

  const isAgentExitRequest = (text) => {
    return /\b(exit|leave|disable|turn\s+off|switch\s+off|stop)\s+(?:agent\s*)?mode\b|\bback\s+to\s+(?:normal|default|intent)\s*mode\b/i.test(text);
  };

  const isChatModeSwitchRequest = (text) => {
    return /\b(switch|change|choose|select|set)\s+(?:chat\s+)?mode\b|\bchat\s+mode\b/i.test(String(text || ''));
  };

  const parseChatModeChoice = (text) => {
    const lower = String(text || '').trim().toLowerCase();
    if (/^(1|intent|intent\s*mode|default|default\s*mode)$/i.test(lower) || /\bswitch\s+(?:to\s+)?intent\s*mode\b/i.test(lower)) {
      return 'intent';
    }
    if (/^(2|local|local\s*ai|local\s*mode)$/i.test(lower) || /\bswitch\s+(?:to\s+)?local(?:\s+ai)?\s*mode\b/i.test(lower)) {
      return 'local';
    }
    if (/^(3|agent|agent\s*mode)$/i.test(lower) || /\bswitch\s+(?:to\s+)?agent\s*mode\b/i.test(lower)) {
      return 'agent';
    }
    return null;
  };

  const resetAgentSetupState = () => {
    setAwaitingAgentProvider(false);
    setAwaitingAgentApiKey(false);
    setAwaitingAgentModel(false);
    setAgentModelOptions([]);
    setPendingAgentConfirmation(null);
  };

  const switchToIntentMode = () => {
    setAgentMode(false);
    setChatModePreference('intent');
    resetAgentSetupState();
    addBotMessage('Switched to **Intent** mode. I will use CellPilot command routing without agent judgement.', 'success');
  };

  const switchToLocalMode = () => {
    const currentChatModel = getCurrentChatModel();
    if (!isChatModelLoaded() || API_CHAT_MODEL_IDS.has(currentChatModel)) {
      addBotMessage('Local AI mode needs a downloaded local chat model first. Please use the Model panel to download one.', 'warning');
      return;
    }
    setAgentMode(false);
    setChatModePreference('local');
    resetAgentSetupState();
    addBotMessage(`Switched to **Local AI** mode using **${currentChatModel}**.`, 'success');
  };

  const promptForChatMode = () => {
    setAwaitingChatModeChoice(true);
    addBotMessage(
      'Which chat mode do you want?\n\n1. **Intent**, fast CellPilot command routing\n2. **Local AI**, local chat model, if downloaded\n3. **Agent**, API LLM agent with multi-step reasoning\n\nReply with `Intent`, `Local`, or `Agent`.',
      'info'
    );
  };

  const isAgentProviderSwitchRequest = (text) => {
    const lower = String(text || '').toLowerCase();
    const provider = parseAgentProviderChoice(lower);
    if (!provider) return null;
    const asksToSwitch = /\b(switch|change|set|use|move|go)\b/.test(lower);
    const mentionsAgentProvider = /\b(api|agent|llm|model|provider|chatgpt|openai|gpt|claude|anthropic|gemini|germini|google|groq|openrouter|openrouter\.ai)\b/.test(lower);
    return asksToSwitch && mentionsAgentProvider ? provider : null;
  };

  const isAmbiguousAgentProviderSwitchRequest = (text) => {
    const lower = String(text || '').toLowerCase();
    if (parseAgentProviderChoice(lower)) return false;
    const asksToSwitch = /\b(switch|change|choose|select|pick|set|use|try|move|go)\b/.test(lower);
    const asksForOther = /\b(other|another|different|new)\b/.test(lower);
    const mentionsProvider = /\b(api|company|provider|llm|agent\s+provider|ai\s+provider)\b/.test(lower);
    return asksToSwitch && mentionsProvider && (asksForOther || /\bprovider\b|\bcompany\b|\bapi\b/.test(lower));
  };

  const isAgentModelSwitchRequest = (text) => {
    const lower = String(text || '').toLowerCase();
    const asksToChange = /\b(change|switch|select|choose|pick|set|try|use)\b/.test(lower);
    const mentionsModel = /\b(?:llm\s*)?models?\b/.test(lower);
    const wantsAnother = /\banother\s+(?:llm\s*)?models?\b/.test(lower);
    const modelNotGood = /\bmodels?\b.*\b(?:not\s+good|bad|poor|weak|wrong|slow)\b|\b(?:not\s+good|bad|poor|weak|wrong|slow)\b.*\bmodels?\b/.test(lower);
    return (asksToChange && mentionsModel) || wantsAnother || modelNotGood;
  };

  const parseAgentProviderChoice = (text) => {
    const lower = String(text || '').trim().toLowerCase();
    if (/\b(openrouter|openrouter\.ai)\b/.test(lower) || lower.startsWith('sk-or-')) return 'openrouter';
    if (/\b(chatgpt|openai|gpt)\b/.test(lower)) return 'chatgpt';
    if (/\b(claude|anthropic)\b/.test(lower)) return 'claude';
    if (/\b(gemini|germini|google)\b/.test(lower)) return 'gemini';
    if (/\b(groq)\b/.test(lower)) return 'groq';
    if (lower === '1') return 'gemini';
    if (lower === '2') return 'chatgpt';
    if (lower === '3') return 'claude';
    if (lower === '4') return 'groq';
    if (lower === '5') return 'openrouter';
    return null;
  };

  const promptForAgentProvider = () => {
    setAwaitingAgentProvider(true);
    setAwaitingAgentApiKey(false);
    setAwaitingAgentModel(false);
    addBotMessage(
      'Which LLM do you want to use for agent mode?\n\n1. Gemini\n2. ChatGPT\n3. Claude\n4. Groq\n5. OpenRouter\n\nReply with `Gemini`, `ChatGPT`, `Claude`, `Groq`, or `OpenRouter`.',
      'info'
    );
  };

  const promptForAgentApiKey = (provider) => {
    setAgentProvider(provider);
    setAwaitingAgentProvider(false);
    setAwaitingAgentApiKey(true);
    setAwaitingAgentModel(false);
    addBotMessage(
      `Please paste your ${AGENT_PROVIDERS[provider]} API key. I will hide it in the chat and keep it only in memory for this app session.`,
      'info'
    );
  };

  const parseAgentModelChoice = (text, options) => {
    const value = String(text || '').trim();
    if (!value) return null;
    const selectedIndex = parseInt(value, 10);
    if (!Number.isNaN(selectedIndex) && selectedIndex >= 1 && selectedIndex <= options.length) {
      return options[selectedIndex - 1].id;
    }
    const lower = value.toLowerCase();
    const exact = options.find(option =>
      option.id.toLowerCase() === lower ||
      String(option.label || '').toLowerCase() === lower
    );
    return exact ? exact.id : value;
  };

  const promptForAgentModel = async (provider, apiKey = null) => {
    setAgentProvider(provider);
    setAwaitingAgentProvider(false);
    setAwaitingAgentApiKey(false);
    setAwaitingAgentModel(true);

    let models = getFallbackProviderModels(provider);
    let liveStatus = 'I could not refresh the live list, so I am showing documented defaults.';
    try {
      const config = getApiConfig();
      const key = apiKey || config[provider]?.apiKey;
      const liveModels = await fetchProviderModels(provider, key);
      if (liveModels?.length) {
        models = liveModels;
        liveStatus = 'Refreshed from the provider model API using your key.';
      }
    } catch (error) {
      console.warn('Could not fetch live provider models:', error);
      liveStatus = `Could not refresh the live list (${error.message}). Showing documented defaults.`;
    }

    setAgentModelOptions(models);
    const optionsText = models
      .slice(0, 30)
      .map((model, index) => `${index + 1}. ${model.label || model.id} (${model.id})`)
      .join('\n');
    addBotMessage(
      `Which ${AGENT_PROVIDERS[provider]} model should CellPilot Agent use?\n\n${liveStatus}\n\n${optionsText}\n\nReply with a number or paste a model ID.`,
      'info'
    );
  };

  const enableAgentMode = async (requestedProvider = null) => {
    const provider = requestedProvider || agentProvider || getConfiguredAgentProvider();
    if (!provider) {
      setAgentMode(true);
      setChatModePreference('agent');
      promptForAgentProvider();
      return;
    }

    const config = getApiConfig();
    const savedKey = config[provider]?.apiKey;
    setAgentProvider(provider);
    setChatModePreference('agent');
    if (savedKey) {
      if (config[provider]?.model) {
        setAgentMode(true);
        setAwaitingAgentProvider(false);
        setAwaitingAgentApiKey(false);
        setAwaitingAgentModel(false);
        addBotMessage(`Switched to **Agent** mode with ${AGENT_PROVIDERS[provider]} using **${config[provider].model}**.`, 'success');
      } else {
        setAgentMode(true);
        addBotMessage(`Agent mode will use ${AGENT_PROVIDERS[provider]}. Checking available models now...`, 'info');
        await promptForAgentModel(provider, savedKey);
      }
    } else {
      setAgentMode(true);
      promptForAgentApiKey(provider);
    }
  };

  const getUniqueClusterIds = (values) => {
    if (!Array.isArray(values)) return [];
    return Array.from(new Set(values.map(value => String(value))))
      .sort((a, b) => {
        const an = Number(a);
        const bn = Number(b);
        if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
        return a.localeCompare(b);
      });
  };

  const buildClusterContext = () => {
    const fallbackClusters = Array.isArray(dataInfo?.clusters)
      ? dataInfo.clusters.map(value => String(value))
      : [];
    const rnaIds = getUniqueClusterIds(rnaClusters).length
      ? getUniqueClusterIds(rnaClusters)
      : fallbackClusters;
    const atacIds = getUniqueClusterIds(atacClusters);
    const wnnIds = getUniqueClusterIds(wnnClusters);

    return {
      default_cluster_ids: rnaIds,
      rna_cluster_ids: rnaIds,
      atac_cluster_ids: atacIds,
      wnn_cluster_ids: wnnIds,
      labels_by_view: {
        rna: clusterLabelMap || {},
        atac: atacClusterLabelMap || {},
        wnn: wnnClusterLabelMap || {},
      },
    };
  };

  const extractCellTypeClusterSearch = (text) => {
    const lower = String(text || '').toLowerCase();
    const asksForCluster = /\b(which|what|find|identify|show|rank|candidate|might|likely)\b/.test(lower) && /\bclusters?\b/.test(lower);
    if (!asksForCluster) return null;
    const patterns = [
      /(?:which|what)\s+clusters?\s+(?:might\s+be|may\s+be|are|is|look(?:s)?\s+like|could\s+be)\s+(.+?)(?:\?|$)/i,
      /(?:which|what)\s+clusters?\s+(?:are\s+)?(?:most\s+likely\s+)?(.+?)(?:\?|$)/i,
      /(?:find|identify|rank|show)\s+(.+?)\s+clusters?(?:\?|$)/i,
      /do\s+you\s+know\s+which\s+clusters?\s+(?:might\s+be|may\s+be|are|is)\s+(.+?)(?:\?|$)/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        const cellType = match[1]
          .replace(/\bcell\s*type\b/ig, '')
          .replace(/\bcells?\b$/ig, '')
          .trim();
        if (cellType.length >= 3) return cellType;
      }
    }
    return null;
  };

  const buildAgentContext = () => {
    const isSpatial = dataInfo?.modality === 'spatial' ||
      dataInfo?.modality === 'visium' ||
      dataInfo?.modality === 'visium-hd' ||
      dataInfo?.modality === 'xenium' ||
      dataInfo?.modality === 'merfish' ||
      dataInfo?.spatialCoordinates?.length > 0;

    const clusterContext = buildClusterContext();

    return {
      dataset_loaded: !!dataLoaded,
      dataset_type: dataInfo?.modality || dataInfo?.format || 'unknown',
      format: dataInfo?.format || null,
      species: dataInfo?.species || dataInfo?.genome || null,
      tissue: tissueContext || dataInfo?.tissue || dataInfo?.organ || null,
      n_cells: dataInfo?.cells || null,
      n_genes: dataInfo?.genes || null,
      clusters: clusterContext.default_cluster_ids,
      cluster_ids: clusterContext.default_cluster_ids,
      rna_cluster_ids: clusterContext.rna_cluster_ids,
      atac_cluster_ids: clusterContext.atac_cluster_ids,
      wnn_cluster_ids: clusterContext.wnn_cluster_ids,
      cluster_labels: clusterLabelMap || {},
      cluster_labels_by_view: clusterContext.labels_by_view,
      has_spatial_coordinates: !!isSpatial,
      selected_spatial_region: spatialSelection?.cellCount > 0 ? {
        cell_count: spatialSelection.cellCount,
        format: spatialSelection.format || null,
        histology_image_loaded: !!spatialSelection.hasHistologyImage,
        roi_image_available: !!spatialSelection.roiImageDataUrl,
      } : null,
      selected_spatial_regions: Array.isArray(spatialSelection?.regions)
        ? spatialSelection.regions.map((region, index) => ({
            id: region.id || `Region ${index + 1}`,
            cell_count: region.cellCount || 0,
            format: region.format || null,
          }))
        : [],
      is_multiome: dataInfo?.modality === 'multiome',
      wnn_active: !!wnnActive,
      last_plot: lastPlotContext,
      last_action: getLastActionContext(),
    };
  };

  const extractTissueContextDirective = (text) => {
    const source = String(text || '').trim();
    const lower = source.toLowerCase();
    if (/^(clear|remove|reset)\s+(?:the\s+)?(?:tissue|organ)\s+(?:context|info|information)?$/i.test(source)) {
      return { clear: true };
    }
    const match =
      source.match(/^(?:this|the)\s+(?:sample|dataset|tissue|organ|section)\s+(?:is|comes\s+from|came\s+from)\s+(.+?)(?:[.?!])?$/i) ||
      source.match(/^set\s+(?:the\s+)?(?:tissue|organ)\s+(?:context\s+)?(?:to|as)\s+(.+?)(?:[.?!])?$/i) ||
      source.match(/^tissue\s*(?:=|:)\s*(.+?)(?:[.?!])?$/i) ||
      source.match(/^organ\s*(?:=|:)\s*(.+?)(?:[.?!])?$/i);
    if (!match?.[1]) return null;
    const tissue = match[1].trim().replace(/^a\s+|^an\s+|^the\s+/i, '').replace(/[.?!]+$/, '');
    if (!tissue || tissue.length > 80) return null;
    if (['what tissue', 'which tissue', 'unknown'].includes(lower)) return null;
    return { tissue };
  };

  const annotateClusterResult = async (clusterData) => {
    const provider = agentProvider || getConfiguredAgentProvider();
    if (!provider) {
      addBotMessage('I found the markers, but agent annotation needs an API provider. Switch to agent mode and add an API key first.', 'warning');
      return;
    }

    try {
      const clusterLabel = clusterData.clusterLabel || `Cluster ${clusterData.cluster}`;
      addBotMessage(`Interpreting **${clusterLabel}** marker genes for likely cell type...`, 'info');
      const annotation = await generateClusterAnnotation(provider, clusterData, buildAgentContext());
      if (annotation) {
        addBotMessage(`**Likely annotation for ${clusterLabel}:**\n\n${annotation}`, 'success');
        const shortName = annotation.match(/\*\*Short name:\*\*\s*(\S+)/)?.[1]?.trim();
        if (shortName) {
          setPendingAgentConfirmation({
            type: 'single_rename',
            clusterId: clusterData.cluster,
            clusterLabel,
            shortName,
          });
          addBotMessage(`Do you want me to rename this cluster to **${shortName}**?`, 'warning');
        }
      } else {
        addBotMessage(`I could not generate a confident annotation for ${clusterLabel}. The marker table is still available for manual review.`, 'warning');
      }
    } catch (error) {
      console.error('Cluster annotation failed:', error);
      addBotMessage(`Cluster annotation failed: ${error.message}`, 'warning');
    }
  };

  annotateClusterResultRef.current = annotateClusterResult;

  const executeAgentSteps = async (steps, userMessage, dataContext) => {
    const wantsAnnotation = /\b(annotate|annotation|identify|cell\s*type|what\s+(?:is|are)|which\s+cell)\b/i.test(userMessage || '');
    const provider = agentProvider || getConfiguredAgentProvider();
    const shouldUseNativeClusterInfoOnly =
      steps.length === 1 &&
      steps[0]?.action === 'cluster_info' &&
      !wantsAnnotation;
    const toolHistory = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let stepParams = {
        ...(step.params || {}),
        ...(wantsAnnotation && step.action === 'cluster_info' ? { annotateCellType: true } : {})
      };
      const needsMarkerPanel = step.action === 'identify_cell_type_clusters' &&
        !Array.isArray(stepParams.markerGenes) &&
        !Array.isArray(stepParams.markers);

      if (needsMarkerPanel && provider) {
        const requestedCellType = stepParams.cellType || stepParams.cell_type || stepParams.query || 'requested cell type';
        addBotMessage(`Asking ${AGENT_PROVIDERS[provider]} for a focused marker panel for **${requestedCellType}**...`, 'info');
        const markerInfo = await generateCellTypeMarkers(provider, requestedCellType, buildAgentContext());
        stepParams = {
          ...stepParams,
          cellType: markerInfo.cellType || requestedCellType,
          markerGenes: markerInfo.markers,
          markerSource: 'llm',
          markerRationale: markerInfo.rationale,
        };
        const excludedText = markerInfo.excludedMarkers?.length
          ? ` Excluded less-specific or alternative-lineage markers: ${markerInfo.excludedMarkers.join(', ')}.`
          : '';
        addBotMessage(
          `I will score the real dataset using these ${AGENT_PROVIDERS[provider]}-suggested markers for **${stepParams.cellType}**: ${markerInfo.markers.join(', ')}.${excludedText}`,
          'info'
        );
      }
      if (!shouldUseNativeClusterInfoOnly) {
        addBotMessage(`Agent step ${i + 1}/${steps.length}: ${step.reason || step.action}`, 'info');
      }
      const waitsForResult = AGENT_WAIT_FOR_RESULT_ACTIONS.has(step.action);
      const resultWait = waitsForResult
        ? createAgentToolResultWait(step.action === 'spatial_cell_interaction'
          ? SPATIAL_INTERACTION_TIMEOUT_MS
          : step.action === 'spatial_region_markers'
            ? SPATIAL_REGION_MARKER_TIMEOUT_MS
            : AGENT_TOOL_TIMEOUT_MS)
        : null;
      const execution = await processSingleCommand({
        action: step.action,
        params: stepParams,
        confidence: 0.95,
        source: shouldUseNativeClusterInfoOnly ? 'agent_silent' : 'agent',
        explanation: step.reason || 'Planned by CellPilot Agent'
      }, userMessage, dataContext);

      if (execution?.error) {
        resultWait?.cancel();
        toolHistory.push({
          action: step.action,
          parameters: stepParams,
          error: execution.error,
        });
        break;
      }

      if (execution?.success && waitsForResult) {
        const resultPayload = await resultWait.promise;
        if (resultPayload?.error) {
          toolHistory.push({
            action: step.action,
            parameters: stepParams,
            error: resultPayload.error,
          });
          break;
        }
        if (resultPayload?.data) {
          toolHistory.push({
            action: step.action,
            parameters: stepParams,
            result: resultPayload.data,
            roiImageDataUrl: step.action === 'spatial_region_markers' ? (spatialSelection?.roiImageDataUrl || null) : null,
          });
        }
      } else if (execution) {
        toolHistory.push({
          action: step.action,
          parameters: stepParams,
          result: execution,
        });
      }

      if (i < steps.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (shouldUseNativeClusterInfoOnly) {
      return;
    }

    if (provider && toolHistory.some(item => item.result || item.error)) {
      try {
        const finalAnswer = await generateAgentResultSummary(provider, userMessage, buildAgentContext(), toolHistory);
        if (finalAnswer) {
          addBotMessage(finalAnswer, 'success');
        }
      } catch (summaryError) {
        console.warn('Agent result summary failed:', summaryError);
      }
    }
  };

  const isSelectedSpatialRegionQuestion = (text) => {
    const lower = String(text || '').toLowerCase();
    return spatialSelection?.cellCount > 0 &&
      /\b(this|selected|drawn|region|area|roi)\b/.test(lower) &&
      /\b(what|identify|annotate|marker|markers|cell\s*type|cells|area|region)\b/.test(lower);
  };

  const isSpatialCellInteractionRequest = (text) => {
    const lower = String(text || '').toLowerCase();
    return /\bcell[\s-]*cell\s+(?:interaction|communication|crosstalk)/i.test(lower) ||
      /\bligand[\s-]*receptor\b/i.test(lower) ||
      /\bcellchat\b/i.test(lower) ||
      /\b(?:interaction|communication)\s+analysis\b/i.test(lower);
  };

  const isBulkAnnotationRequest = (text) => {
    const lower = String(text || '').toLowerCase();
    return /\b(annotate|identify|label|name|classify)\b/.test(lower) &&
      /\b(all|every|each)\b/.test(lower) &&
      /\bcluster/.test(lower);
  };

  const runBulkClusterAnnotation = async (userMessage, dataContext) => {
    const provider = agentProvider || getConfiguredAgentProvider();
    if (!provider) {
      promptForAgentProvider();
      return;
    }

    const ctx = buildAgentContext();
    const clusterIds = ctx.cluster_ids || ctx.clusters || [];
    if (!clusterIds.length) {
      addBotMessage('No clusters found. Please run clustering first.', 'warning');
      return;
    }

    addBotMessage(
      `Finding markers for all ${clusterIds.length} clusters…`,
      'info'
    );

    // Phase 1: collect marker data for every cluster (tool calls, no LLM cost)
    const markerResults = [];
    for (let i = 0; i < clusterIds.length; i++) {
      const clusterId = clusterIds[i];
      const clusterLabel = clusterLabelMap?.[String(clusterId)] || `Cluster ${clusterId}`;

      const resultWait = createAgentToolResultWait(AGENT_TOOL_TIMEOUT_MS);
      const execution = await processSingleCommand({
        action: 'find_markers',
        params: { cluster: clusterId },
        confidence: 0.95,
        source: 'agent_silent',
        explanation: `Finding markers for ${clusterLabel}`,
      }, userMessage, dataContext);

      if (execution?.error) {
        resultWait.cancel();
        markerResults.push({ clusterId, clusterLabel, error: execution.error });
        continue;
      }

      const resultPayload = await resultWait.promise;
      if (!resultPayload?.data?.markers?.length) {
        markerResults.push({ clusterId, clusterLabel, error: 'No markers returned' });
        continue;
      }

      const md = resultPayload.data;
      markerResults.push({
        clusterId,
        clusterLabel,
        cluster: clusterId,
        markers: md.markers,
        cellCount: md.clusterSize,
        totalCells: md.totalCells || ctx.n_cells,
        fraction: md.clusterSize && md.totalCells ? md.clusterSize / md.totalCells : null,
      });

      if (i < clusterIds.length - 1) await new Promise(r => setTimeout(r, 80));
    }

    const annotatable = markerResults.filter(r => !r.error);
    if (!annotatable.length) {
      addBotMessage('Could not retrieve markers for any cluster.', 'danger');
      return;
    }

    // Phase 2: single LLM call for all clusters
    addBotMessage(
      `Markers ready. Annotating all ${annotatable.length} clusters using ${AGENT_PROVIDERS[provider]}…`,
      'info'
    );

    let annotations = [];
    try {
      annotations = await generateBulkClusterAnnotation(provider, annotatable, buildAgentContext());
    } catch (err) {
      addBotMessage(`Bulk annotation failed: ${err.message}`, 'danger');
      return;
    }

    // Merge annotation results back onto markerResults
    const results = markerResults.map((mr, idx) => {
      if (mr.error) return { ...mr };
      const ann = annotations.find(a => {
        if (a.clusterId !== null && a.clusterId !== undefined) {
          return String(a.clusterId) === String(mr.clusterId);
        }
        return annotations.indexOf(a) === annotatable.indexOf(mr);
      }) || annotations[annotatable.indexOf(mr)];
      if (!ann) return { ...mr, error: 'No annotation returned' };
      return {
        ...mr,
        cellType: ann.cellType || '-',
        shortName: ann.shortName || ann.cellType || '-',
        confidence: ann.confidence || '',
        markers: ann.markers || '',
        rationale: ann.rationale || '',
      };
    });

    const successCount = results.filter(r => !r.error).length;

    onAnalysisRequest({
      action: 'show_annotation_table',
      params: { rows: results, successCount, totalCount: clusterIds.length },
    });

    addBotMessage(
      `**Annotation complete, ${successCount}/${clusterIds.length} clusters labelled.** See the Analysis View for the full table.`,
      'success'
    );

    const renames = results.filter(r => !r.error && r.shortName && r.shortName !== '-');
    if (renames.length > 0) {
      setPendingAgentConfirmation({ type: 'bulk_rename', renames, userMessage, dataContext });
      addBotMessage('Do you want me to rename the clusters with these cell type names?', 'warning');
    }
  };

  const runSelectedSpatialCellInteractionAgent = async (userMessage, dataContext) => {
    const regions = Array.isArray(spatialSelection?.regions) ? spatialSelection.regions : [];
    if (regions.length < 2) {
      addBotMessage('Cell-cell interaction analysis needs at least two selected spatial areas. Please draw/select two regions in Spatial View, then ask again.', 'warning');
      return;
    }
    await executeAgentSteps([{
      action: 'spatial_cell_interaction',
      params: {},
      reason: `Run ligand-receptor communication analysis across ${regions.length} selected spatial regions`,
    }], userMessage, dataContext);
  };

  const runSelectedSpatialRegionAgent = async (userMessage, dataContext) => {
    const provider = agentProvider || getConfiguredAgentProvider();
    const selectedCellIndices = spatialSelection?.globalIndices || [];
    addBotMessage(`Agent step 1/1: compare the selected spatial region against the rest of the tissue`, 'info');
    const resultWait = createAgentToolResultWait(SPATIAL_REGION_MARKER_TIMEOUT_MS);
    const execution = await processSingleCommand({
      action: 'spatial_region_markers',
      params: { selectedCellIndices, suppressNeutralSummary: true },
      confidence: 0.98,
      source: 'spatial_roi',
      explanation: 'User asked about the currently selected spatial region',
    }, userMessage, dataContext);
    if (execution?.error) {
      resultWait.cancel();
      return;
    }
    const resultPayload = await resultWait.promise;
    if (resultPayload?.error) {
      addBotMessage(`Error: ${resultPayload.error}`, 'danger');
      return;
    }
    if (!resultPayload?.data) {
      addBotMessage('The selected-region marker table is ready, but I did not receive the result payload for agent interpretation. Please ask again and I will retry the interpretation.', 'warning');
      return;
    }
    if (provider && resultPayload?.data) {
      try {
        const finalAnswer = await generateAgentResultSummary(provider, userMessage, buildAgentContext(), [{
          action: 'spatial_region_markers',
          parameters: { selectedCellCount: selectedCellIndices.length },
          result: resultPayload.data,
          roiImageDataUrl: spatialSelection?.roiImageDataUrl || null,
        }]);
        if (finalAnswer) {
          addBotMessage(finalAnswer, 'success');
        }
      } catch (summaryError) {
        console.warn('Spatial region summary failed:', summaryError);
        addBotMessage(`I found the selected-region markers, but the agent interpretation failed: ${summaryError.message}`, 'warning');
      }
    } else {
      addBotMessage('I found the selected-region markers, but agent interpretation needs an API provider. Please switch to an API provider in agent mode.', 'warning');
    }
  };

  const handleAgentMessage = async (userMessage, dataContext) => {
    const provider = agentProvider || getConfiguredAgentProvider();
    if (!provider) {
      promptForAgentProvider();
      return;
    }

    if (isSpatialCellInteractionRequest(userMessage)) {
      await runSelectedSpatialCellInteractionAgent(userMessage, dataContext);
      return;
    }

    if (isBulkAnnotationRequest(userMessage)) {
      await runBulkClusterAnnotation(userMessage, dataContext);
      return;
    }

    const plan = await generateAgentPlan(provider, userMessage, buildAgentContext());

    if (plan.mode === 'answer' || plan.mode === 'clarify') {
      addBotMessage(plan.message || 'I need a little more detail before I can act.', 'info');
      return;
    }

    if (!plan.steps.length) {
      addBotMessage(plan.message || 'I could not map that to an available CellPilot action.', 'warning');
      return;
    }

    setAgentProvider(provider);
    const nativeClusterInfoOnly =
      plan.steps.length === 1 &&
      plan.steps[0]?.action === 'cluster_info' &&
      !/\b(annotate|annotation|identify|cell\s*type|what\s+(?:is|are)|which\s+cell)\b/i.test(userMessage || '');
    if (!nativeClusterInfoOnly) {
      const model = getApiConfig()[provider]?.model;
      addBotMessage(`Agent mode is planning with ${AGENT_PROVIDERS[provider]}${model ? ` (${model})` : ''}...`, 'info');
    }

    const needsConfirmation = plan.steps.some(step => step.requiresConfirmation);
    if (needsConfirmation) {
      setPendingAgentConfirmation({ steps: plan.steps, userMessage, dataContext });
      const summary = plan.steps.map((step, idx) => `${idx + 1}. ${step.action}: ${step.reason || 'planned action'}`).join('\n');
      addBotMessage(
        `${plan.message || 'I can do that, but I want your confirmation first.'}\n\n${summary}\n\nReply \`yes\` to run these steps, or \`no\` to cancel.`,
        'warning'
      );
      return;
    }

    if (plan.message && !nativeClusterInfoOnly) {
      addBotMessage(plan.message, 'info');
    }
    await executeAgentSteps(plan.steps, userMessage, dataContext);
  };

  const handleSend = async () => {
    if (!inputValue.trim()) return;

    const userMessage = inputValue.trim();
    setInputValue('');

    if (awaitingAgentProvider) {
      addUserMessage(userMessage);
      const provider = parseAgentProviderChoice(userMessage);
      if (!provider) {
        addBotMessage('Please choose `OpenRouter`, `Gemini`, `ChatGPT`, `Claude`, or `Groq` for agent mode.', 'warning');
        return;
      }
      promptForAgentApiKey(provider);
      return;
    }

    if (awaitingAgentApiKey) {
      addUserMessage('[API key hidden]');
      const provider = agentProvider;
      const apiKey = userMessage.trim();
      if (!provider) {
        addBotMessage('Please choose an LLM first: `OpenRouter`, `Gemini`, `ChatGPT`, `Claude`, or `Groq`.', 'warning');
        setAwaitingAgentApiKey(false);
        setAwaitingAgentProvider(true);
        return;
      }
      if (!apiKey) {
        addBotMessage(`Please paste your ${AGENT_PROVIDERS[provider]} API key.`, 'warning');
        return;
      }
      setApiKey(provider, apiKey);
      setAgentProvider(provider);
      addBotMessage(`Got the ${AGENT_PROVIDERS[provider]} key (${maskApiKey(apiKey)}). Checking available models now...`, 'info');
      await promptForAgentModel(provider, apiKey);
      return;
    }

    if (awaitingAgentModel) {
      addUserMessage(userMessage);
      const provider = agentProvider;
      if (!provider) {
        addBotMessage('Please choose an LLM first: `OpenRouter`, `Gemini`, `ChatGPT`, `Claude`, or `Groq`.', 'warning');
        setAwaitingAgentModel(false);
        setAwaitingAgentProvider(true);
        return;
      }
      const model = parseAgentModelChoice(userMessage, agentModelOptions);
      if (!model) {
        addBotMessage('Please choose a model by number or paste a model ID.', 'warning');
        return;
      }
      setApiModel(provider, model);
      setAgentMode(true);
      setChatModePreference('agent');
      setAwaitingAgentApiKey(false);
      setAwaitingAgentModel(false);
      setAgentModelOptions([]);
      addBotMessage(`Agent mode enabled with ${AGENT_PROVIDERS[provider]} using **${model}**. You can now ask multi-step analysis questions.`, 'success');
      return;
    }

    if (awaitingChatModeChoice) {
      addUserMessage(userMessage);
      const choice = parseChatModeChoice(userMessage);
      if (!choice) {
        addBotMessage('Please choose `Intent`, `Local`, or `Agent`.', 'warning');
        return;
      }
      setAwaitingChatModeChoice(false);
      if (choice === 'intent') {
        switchToIntentMode();
        return;
      }
      if (choice === 'local') {
        switchToLocalMode();
        return;
      }
      await enableAgentMode();
      return;
    }

    if (pendingAgentConfirmation) {
      addUserMessage(userMessage);
      const lower = userMessage.toLowerCase();
      if (/^(yes\s*please|please|yes|y|sure|ok|okay|confirm|run|go ahead|continue|do it)$/i.test(lower)) {
        const pending = pendingAgentConfirmation;
        setPendingAgentConfirmation(null);
        setIsProcessing(true);
        try {
          if (pending.type === 'bulk_rename') {
            for (const r of pending.renames) {
              await processSingleCommand({
                action: 'rename_cluster',
                params: { oldLabel: String(r.clusterId), newLabel: r.shortName },
                confidence: 0.95,
                source: 'agent',
                explanation: `Rename ${r.clusterLabel} to ${r.cellType}`,
              }, pending.userMessage, pending.dataContext);
              await new Promise(resolve => setTimeout(resolve, 80));
            }
            addBotMessage(
              `All ${pending.renames.length} clusters have been renamed. The UMAP, dot plots, violin plots, and all other views will now use the new cell type labels.`,
              'success'
            );
          } else if (pending.type === 'single_rename') {
            await processSingleCommand({
              action: 'rename_cluster',
              params: { oldLabel: String(pending.clusterId), newLabel: pending.shortName },
              confidence: 0.95,
              source: 'agent',
              explanation: `Rename ${pending.clusterLabel} to ${pending.shortName}`,
            }, '', {});
            addBotMessage(`Renamed **${pending.clusterLabel}** to **${pending.shortName}**.`, 'success');
          } else {
            await executeAgentSteps(pending.steps, pending.userMessage, pending.dataContext);
          }
        } catch (error) {
          console.error('Error executing confirmed agent plan:', error);
          addBotMessage(`Agent plan failed: ${error.message}`, 'danger');
        } finally {
          setIsProcessing(false);
        }
        return;
      }
      if (/^(no|n|cancel|stop|never mind)$/i.test(lower)) {
        setPendingAgentConfirmation(null);
        addBotMessage('Canceled the agent plan.', 'info');
        return;
      }
      addBotMessage('Please reply `yes` to run the agent plan, or `no` to cancel it.', 'info');
      return;
    }

    const requestedChatMode = parseChatModeChoice(userMessage);
    if (requestedChatMode === 'intent' && /\b(switch|change|set|go|back|return)\b/i.test(userMessage)) {
      addUserMessage(userMessage);
      switchToIntentMode();
      return;
    }
    if (requestedChatMode === 'local' && /\b(switch|change|set|go|back|return)\b/i.test(userMessage)) {
      addUserMessage(userMessage);
      switchToLocalMode();
      return;
    }
    if (isChatModeSwitchRequest(userMessage) && !requestedChatMode) {
      addUserMessage(userMessage);
      promptForChatMode();
      return;
    }
    if (requestedChatMode === 'agent' && /\b(switch|change|set|go|back|return)\b/i.test(userMessage)) {
      addUserMessage(userMessage);
      await enableAgentMode(parseAgentProviderChoice(userMessage));
      return;
    }

    const requestedAgentProvider = isAgentProviderSwitchRequest(userMessage);
    if (isAmbiguousAgentProviderSwitchRequest(userMessage)) {
      addUserMessage(userMessage);
      setPendingAgentConfirmation(null);
      setAgentMode(true);
      setChatModePreference('agent');
      promptForAgentProvider();
      return;
    }

    if (isAgentModelSwitchRequest(userMessage)) {
      addUserMessage(userMessage);
      setPendingAgentConfirmation(null);
      const config = getApiConfig();
      const provider = requestedAgentProvider || agentProvider || getConfiguredAgentProvider();
      if (!provider) {
        addBotMessage('Which LLM do you want to choose a model for?', 'info');
        promptForAgentProvider();
        return;
      }
      const savedKey = config[provider]?.apiKey;
      if (savedKey) {
        addBotMessage(`Checking available ${AGENT_PROVIDERS[provider]} models now...`, 'info');
        await promptForAgentModel(provider, savedKey);
      } else {
        setAgentMode(true);
        setChatModePreference('agent');
        promptForAgentApiKey(provider);
      }
      return;
    }

    if (requestedAgentProvider) {
      addUserMessage(userMessage);
      setPendingAgentConfirmation(null);
      const currentProvider = agentProvider || getConfiguredAgentProvider();
      if (currentProvider === requestedAgentProvider && agentMode) {
        addBotMessage(`Agent mode is already using ${AGENT_PROVIDERS[requestedAgentProvider]}.`, 'info');
        return;
      }

      const config = getApiConfig();
      const savedKey = config[requestedAgentProvider]?.apiKey;
      if (savedKey) {
        setAgentProvider(requestedAgentProvider);
        setAwaitingAgentProvider(false);
        setAwaitingAgentApiKey(false);
        if (config[requestedAgentProvider]?.model) {
          setAgentMode(true);
          setChatModePreference('agent');
          setAwaitingAgentModel(false);
          addBotMessage(`Switched agent mode to ${AGENT_PROVIDERS[requestedAgentProvider]} using **${config[requestedAgentProvider].model}**.`, 'success');
        } else {
          addBotMessage(`Switching to ${AGENT_PROVIDERS[requestedAgentProvider]}. Checking available models now...`, 'info');
          await promptForAgentModel(requestedAgentProvider, savedKey);
        }
      } else {
        setAgentMode(true);
        setChatModePreference('agent');
        promptForAgentApiKey(requestedAgentProvider);
      }
      return;
    }

    if (isAgentModeRequest(userMessage)) {
      addUserMessage(userMessage);
      const requestedProvider = parseAgentProviderChoice(userMessage);
      if (requestedProvider) {
        const config = getApiConfig();
        if (config[requestedProvider]?.apiKey) {
          setAgentProvider(requestedProvider);
          if (config[requestedProvider]?.model) {
            setAgentMode(true);
            setChatModePreference('agent');
            addBotMessage(`Agent mode enabled with ${AGENT_PROVIDERS[requestedProvider]} using **${config[requestedProvider].model}**.`, 'success');
          } else {
            addBotMessage(`Agent mode will use ${AGENT_PROVIDERS[requestedProvider]}. Checking available models now...`, 'info');
            await promptForAgentModel(requestedProvider, config[requestedProvider].apiKey);
          }
        } else {
          setAgentMode(true);
          setChatModePreference('agent');
          promptForAgentApiKey(requestedProvider);
        }
        return;
      }
      const configuredProvider = getConfiguredAgentProvider();
      if (configuredProvider) {
        setAgentProvider(configuredProvider);
        const config = getApiConfig();
        if (config[configuredProvider]?.model) {
            setAgentMode(true);
            setChatModePreference('agent');
            addBotMessage(`Agent mode enabled with ${AGENT_PROVIDERS[configuredProvider]} using **${config[configuredProvider].model}**.`, 'success');
        } else {
          addBotMessage(`Agent mode will use ${AGENT_PROVIDERS[configuredProvider]}. Checking available models now...`, 'info');
          await promptForAgentModel(configuredProvider, config[configuredProvider]?.apiKey);
        }
      } else {
        promptForAgentProvider();
      }
      return;
    }

    if (agentMode && isAgentExitRequest(userMessage)) {
      addUserMessage(userMessage);
      switchToIntentMode();
      return;
    }

    // Check if user is selecting a clarification option
    if (pendingClarificationOptions && pendingClarificationOptions.length > 0) {
      const selectedIndex = parseOptionSelection(userMessage, pendingClarificationOptions);
      if (selectedIndex !== null) {
        // User selected an option; execute it
        const selectedOption = pendingClarificationOptions[selectedIndex];
        setPendingClarificationOptions(null); // Clear pending options

        addUserMessage(userMessage);
        addBotMessage(`Selected: ${selectedOption.label || selectedOption.action}`, 'info');

        // Create a router result from the selected option and process it
        const routerResult = {
          action: selectedOption.action,
          params: selectedOption.params || {},
          confidence: 0.9, // High confidence since user explicitly selected it
          source: 'user_selection',
          explanation: `User selected option ${selectedIndex + 1}`
        };

        setIsProcessing(true);
        try {
          const clusterContext = buildClusterContext();
          await processSingleCommand(routerResult, userMessage, {
            clusters: clusterContext.default_cluster_ids,
            totalCells: dataInfo?.cells || 0,
            clusterLabels: wnnActive
              ? { ...(clusterLabelMap || {}), ...(atacClusterLabelMap || {}), ...(wnnClusterLabelMap || {}) }
              : (clusterLabelMap || {}),
          });
        } catch (error) {
          console.error('Error processing selected option:', error);
          addBotMessage('Sorry, I encountered an error processing your selection.', 'error');
          setIsProcessing(false);
        }
        return;
      }
    }

    // Clear pending clarification options if user is entering a new command (not selecting an option)
    if (pendingClarificationOptions) {
      setPendingClarificationOptions(null);
    }

    addUserMessage(userMessage);

    const pendingDatasetList = pendingDatasetListRef.current;
    if (pendingDatasetList && /^(yes\s*please|yes|y|sure|ok|okay|continue|more|show\s+more|next)$/i.test(userMessage.toLowerCase())) {
      if (!dataLoaded) {
        pendingDatasetListRef.current = null;
        addBotMessage('Please load data first using the Browse button.', 'warning');
        return;
      }
      setIsProcessing(true);
      const nextLimit = Math.min(100, pendingDatasetList.requestedRemaining ?? 100);
      const requestedRemaining = Number.isFinite(pendingDatasetList.requestedRemaining)
        ? Math.max(0, pendingDatasetList.requestedRemaining - nextLimit)
        : null;
      requestDatasetListPage(pendingDatasetList.kind, pendingDatasetList.offset, nextLimit, { requestedRemaining });
      setIsProcessing(false);
      return;
    }
    if (pendingDatasetList && /^(no|n|stop|cancel|enough|nope)$/i.test(userMessage.toLowerCase())) {
      pendingDatasetListRef.current = null;
      addBotMessage('Okay, I will stop listing items here.', 'info');
      return;
    }

    const datasetListRequest = detectDatasetListRequest(userMessage);
    if (datasetListRequest) {
      if (!dataLoaded) {
        addBotMessage('Please load data first using the Browse button.', 'warning');
        return;
      }
      setIsProcessing(true);
      requestDatasetListPage(datasetListRequest.kind, 0, datasetListRequest.initialLimit, {
        requestedRemaining: datasetListRequest.remainingAfterFirstPage,
      });
      setIsProcessing(false);
      return;
    }

    const tissueDirective = extractTissueContextDirective(userMessage);
    if (tissueDirective) {
      if (tissueDirective.clear) {
        setTissueContext('');
        addBotMessage('Cleared the tissue/organ context for agent reasoning.', 'success');
      } else {
        setTissueContext(tissueDirective.tissue);
        addBotMessage(`Got it. I will use **${tissueDirective.tissue}** as the tissue/organ context for marker and ROI interpretation.`, 'success');
      }
      return;
    }

    if (agentMode && !dataLoaded) {
      setIsProcessing(true);
      try {
        await handleAgentMessage(userMessage, { clusters: [], totalCells: 0, clusterLabels: {} });
      } catch (error) {
        console.error('Agent mode error:', error);
        addBotMessage(`Agent mode failed: ${error.message}`, 'danger');
      } finally {
        setIsProcessing(false);
      }
      return;
    }

    if (!dataLoaded) {
      addBotMessage('Please load data first using the Browse button.', 'warning');
      return;
    }

    setIsProcessing(true);

    try {
      // Build data context for routing
      // When WNN is active, merge all three label maps so intent resolution sees renamed clusters
      // from any view. RNA labels take lowest priority; WNN and ATAC labels override.
      const mergedClusterLabels = wnnActive
        ? { ...(clusterLabelMap || {}), ...(atacClusterLabelMap || {}), ...(wnnClusterLabelMap || {}) }
        : (clusterLabelMap || {});
      const clusterContext = buildClusterContext();
      const dataContext = {
        clusters: clusterContext.default_cluster_ids,
        totalCells: dataInfo?.cells || 0,
        clusterLabels: mergedClusterLabels,
        clusterIdsByView: {
          rna: clusterContext.rna_cluster_ids,
          atac: clusterContext.atac_cluster_ids,
          wnn: clusterContext.wnn_cluster_ids,
        },
      };

      const clusterColorDirective = extractClusterColorDirective(userMessage);
      if (clusterColorDirective) {
        const result = onSetClusterColor?.(clusterColorDirective);
        if (result?.success) {
          const targetText = result.target ? ` ${result.target}` : '';
          addBotMessage(
            clusterColorDirective.color
              ? `Updated${targetText} cluster ${clusterColorDirective.cluster} color to ${clusterColorDirective.color}.`
              : `Reset${targetText} cluster ${clusterColorDirective.cluster} color.`,
            'success'
          );
        } else {
          addBotMessage(result?.error || 'I could not update that cluster color.', 'warning');
        }
        setIsProcessing(false);
        return;
      }

      const requestedCellTypeSearch = extractCellTypeClusterSearch(userMessage);
      if (requestedCellTypeSearch) {
        let markerInfo = null;
        const provider = agentMode ? (agentProvider || getConfiguredAgentProvider()) : null;
        if (provider) {
          try {
            addBotMessage(`Asking ${AGENT_PROVIDERS[provider]} for a focused marker panel for **${requestedCellTypeSearch}**...`, 'info');
            markerInfo = await generateCellTypeMarkers(provider, requestedCellTypeSearch, buildAgentContext());
            const markerList = markerInfo.markers.join(', ');
            const excludedText = markerInfo.excludedMarkers?.length
              ? `\n\nExcluded less-specific or alternative-lineage markers: ${markerInfo.excludedMarkers.join(', ')}.`
              : '';
            const ambiguityText = markerInfo.ambiguity ? `\n\nNote: ${markerInfo.ambiguity}` : '';
            addBotMessage(
              `I will score the real dataset using these ${AGENT_PROVIDERS[provider]}-suggested markers for **${markerInfo.cellType}**: ${markerList}.${excludedText}${ambiguityText}`,
              'info'
            );
          } catch (markerError) {
            console.warn('Agent marker selection failed:', markerError);
            addBotMessage(`I could not get an LLM marker panel (${markerError.message}). Please try again or provide marker genes directly.`, 'warning');
            setIsProcessing(false);
            return;
          }
        }

        if (!markerInfo) {
          addBotMessage('Cell-type cluster search needs an LLM marker panel. Please switch to agent mode first, or provide marker genes directly.', 'warning');
          setIsProcessing(false);
          return;
        }

        await processSingleCommand({
          action: 'identify_cell_type_clusters',
          params: markerInfo
            ? {
                cellType: markerInfo.cellType || requestedCellTypeSearch,
                markerGenes: markerInfo.markers,
                markerSource: 'llm',
                markerRationale: markerInfo.rationale,
              }
            : { cellType: requestedCellTypeSearch },
          confidence: 0.95,
          source: 'cell_type_search',
          explanation: `User asked which cluster might be ${requestedCellTypeSearch}`
        }, userMessage, dataContext);
        setIsProcessing(false);
        return;
      }

      if (agentMode) {
        if (isSelectedSpatialRegionQuestion(userMessage)) {
          await runSelectedSpatialRegionAgent(userMessage, dataContext);
          setIsProcessing(false);
          return;
        }
        await handleAgentMessage(userMessage, dataContext);
        setIsProcessing(false);
        return;
      }

      if (isSelectedSpatialRegionQuestion(userMessage)) {
        await processSingleCommand({
          action: 'spatial_region_markers',
          params: {
            selectedCellIndices: spatialSelection?.globalIndices || [],
            suppressNeutralSummary: false,
          },
          confidence: 0.98,
          source: effectiveLocalChatMode ? 'local_ai_spatial_roi' : 'intent_spatial_roi',
          explanation: 'User asked about the currently selected spatial region',
        }, userMessage, dataContext);
        setIsProcessing(false);
        return;
      }

      // Step 0: Always check for chained commands first (e.g. "rename X to Y, and cluster Z to W")
      // This must run before intent routing so we never parse the full string as a single rename
      const chainedCommands = splitChainedCommands(userMessage);
      if (chainedCommands.length > 1) {
        let chainClusterLabelMap = { ...clusterLabelMap };
        for (let i = 0; i < chainedCommands.length; i++) {
          const cmd = chainedCommands[i];
          const chainDataContext = { ...dataContext, clusterLabels: chainClusterLabelMap, chainClusterLabelMap };
          const cmdRouterResult = await routeIntent(
            cmd,
            chainDataContext,
            {
              ruleParser: null, // No rule-based parsing
              intentClassifier: llmAvailable ? classifyIntent : null,
              minConfidence: 0.3,
              enableClarification: true
            }
          );
          await processSingleCommand(cmdRouterResult, cmd, chainDataContext);
          if (cmdRouterResult?.action === 'rename_cluster' && cmdRouterResult?.params?.oldLabel != null && cmdRouterResult?.params?.newLabel != null) {
            const oldKey = String(cmdRouterResult.params.oldLabel).trim();
            const newName = String(cmdRouterResult.params.newLabel).trim();
            // Always keep the cluster entry with its new name (even if merging)
            // This allows "find markers for PT" to find cells from ALL merged clusters
            chainClusterLabelMap[oldKey] = newName;
          }
          if (i < chainedCommands.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        setIsProcessing(false);
        return;
      }

      // Step 0.5: Check for color map changes first (before intent routing)
      // This ensures color changes work even if intent model doesn't match perfectly
      const colorDirective = extractColorDirective(userMessage);
      if (colorDirective && (userMessage.toLowerCase().includes('color') || userMessage.toLowerCase().includes('colour'))) {
        const handled = onSetColorMap(colorDirective);
        if (handled) {
          const desc = describeColorSelection(colorDirective) || 'new colors';
          addBotMessage(`Updated color map to ${desc}.`, 'success');
          setIsProcessing(false);
          return;
        } else {
          addBotMessage('I do not have a recent gene expression plot to recolor. Please plot a gene first.', 'warning');
          setIsProcessing(false);
          return;
        }
      }

      // Step 1: Try intent model first (primary mechanism)
      let routerResult = null;
      if (llmAvailable) {
        routerResult = await routeIntent(
          userMessage,
          dataContext,
          {
            ruleParser: null, // No rule-based parsing
            intentClassifier: classifyIntent,
            minConfidence: 0.3, // Lower threshold to handle more cases
            enableClarification: true
          }
        );
      }

      // Step 2: If no intent model or result is NONE/unknown, use chat model
      if (!routerResult || routerResult.action === 'NONE' || routerResult.action === 'unknown') {
        if (effectiveLocalChatMode && isChatModelLoaded()) {
          // Use chat model to intelligently handle the request
          addBotMessage('_Thinking..._', 'info');
          try {
            const chatResponse = await generateChatResponse(userMessage, dataContext);
            setMessages(prev => prev.slice(0, -1));
            if (chatResponse) {
              addBotMessage(chatResponse, 'info');
            } else {
              addBotMessage(
                "I'm not sure how to help with that. Could you try rephrasing your request? " +
                "I can help with single-cell and spatial transcriptomics analysis tasks like plotting genes, finding markers, clustering, and more.",
                'info'
              );
            }
            setIsProcessing(false);
            return;
          } catch (chatError) {
            console.warn('Chat model response failed:', chatError);
            setMessages(prev => prev.slice(0, -1));
            addBotMessage(
              "I'm not sure how to help with that. Could you try rephrasing your request? " +
              "I can help with single-cell and spatial transcriptomics analysis tasks like plotting genes, finding markers, clustering, and more.",
              'info'
            );
            setIsProcessing(false);
            return;
          }
        } else {
          // No chat model available; provide helpful guidance
          if (routerResult && routerResult.explanation) {
            addBotMessage(routerResult.explanation, 'info');
          } else {
            addBotMessage(
              "I'm not sure how to help with that. Here's what I can do:\n\n" +
              "**Common Commands:**\n" +
              "• Plot gene expression: \"show me gene NPHS2 expression\" or \"plot gene SLC5A2\"\n" +
              "• Cluster cells: \"cluster the cells\" or \"run clustering\"\n" +
              "• Find markers: \"find markers for cluster 1\" or \"show markers for cluster PT\"\n" +
              "• Get cluster info: \"tell me about cluster 1\" or \"what is cluster PT\"\n" +
              "• Rename clusters: \"rename cluster 1 to PT\" or \"rename cluster 3 to Podocytes\"\n" +
              "• Run UMAP: \"run umap\" or \"create umap plot\"\n" +
              "• Adjust parameters: \"recluster with resolution = 1\" or \"run umap with min dist = 0.4\"\n\n" +
              "**Spatial Data:**\n" +
              "• View tissue coordinates: \"show spatial view\" or \"display tissue\"\n" +
              "• Plot gene in tissue: \"show gene NPHS2 on tissue\"\n\n" +
              "**Tip:** Configure a Chat Model (local model in the Model section) to get smarter responses for general questions!",
              'info'
            );
          }
          setIsProcessing(false);
          return;
        }
      }

      // Process the command
      await processSingleCommand(routerResult, userMessage, dataContext);

    } catch (error) {
      console.error('Error processing command:', error);
      addBotMessage(`Error: ${error.message}`, 'danger');
      setIsProcessing(false);
    }
  };

  /**
   * Process a single command from router result
   */
  const processSingleCommand = async (routerResult, originalMessage, dataContext) => {
    try {

      // ATAC: answer "what genome / reference build?" with dataset genome when available
      const askedAboutGenome = /what\s+(?:genome|reference|build)|genome\s+build|reference\s+genome|which\s+genome|what\s+build|(?:genome|reference)\s+(?:is|does|used)|(?:is|does)\s+this\s+(?:use|have)\s+(?:a\s+)?(?:genome|reference)/i.test(originalMessage || '');
      if ((dataInfo?.modality === 'atac' || dataInfo?.modality === 'multiome') && askedAboutGenome) {
        const genome = dataInfo?.genome;
        const dataType = dataInfo?.modality === 'multiome' ? '10x Multiome' : 'scATAC-seq';
        if (genome) {
          const label = genome === 'hg38' ? 'Human (hg38/GRCh38)' : genome === 'hg19' ? 'Human (hg19/GRCh37)' : genome === 'mm10' ? 'Mouse (mm10/GRCm38)' : genome === 'mm39' ? 'Mouse (mm39/GRCm39)' : genome;
          addBotMessage(`This ${dataType} dataset uses the **${label}** reference genome.`, 'info');
        } else {
          addBotMessage(`Genome build was not detected for this dataset. The app reads it from **summary.csv** in the ATAC folder (or in outs/ or atacseq/). You can still plot gene activity; IGV will default to **hg38**.`, 'info');
        }
        setIsProcessing(false);
        return;
      }

      // Handle NONE/ASK_CLARIFY results (we don't understand or need clarification)
      if (routerResult.action === 'NONE' || routerResult.action === 'ASK_CLARIFY') {
        const fallbackMessage = routerResult.explanation || getUnknownResponseMessage();

        if (effectiveLocalChatMode && isChatModelLoaded()) {
          // When we don't understand: always use chat model to answer the user's question
          addBotMessage('_Thinking..._', 'info');
          try {
            const chatResponse = await generateChatResponse(originalMessage, dataContext);
            setMessages(prev => prev.slice(0, -1));
            if (chatResponse) {
              addBotMessage(chatResponse, 'info');
            } else {
              addBotMessage(fallbackMessage, 'info');
            }
          } catch (chatError) {
            console.warn('Chat model response failed:', chatError);
            setMessages(prev => prev.slice(0, -1));
            addBotMessage(fallbackMessage, 'info');
          }
        } else {
          // No chat model: show options (if any) or static guidance
          if (routerResult.action === 'ASK_CLARIFY' && routerResult.params.options?.length > 0) {
            const options = routerResult.params.options;
            setPendingClarificationOptions(options);
            const optionsText = options.map((opt, idx) =>
              `${idx + 1}. ${opt.label || opt.action}`
            ).join('\n');
            addBotMessage(
              `${routerResult.explanation}\n\n**Options:**\n${optionsText}\n\nPlease select an option by number (e.g., "1", "option 1", or "first") or rephrase your request.`,
              'info'
            );
          } else {
            addBotMessage(fallbackMessage, 'info');
          }
        }
        setIsProcessing(false);
        return;
      }

      // Convert router result to command format
      let command = {
        action: routerResult.action,
        params: routerResult.params || {}
      };

      // Default gene visualization is scatter (UMAP). Only use dotplot/violin when user says so explicitly.
      const lowerMessage = (originalMessage || '').toLowerCase();
      const askedForDotplot = lowerMessage.includes('dotplot') || lowerMessage.includes('dot plot');
      const askedForViolin = lowerMessage.includes('violin');
      if (command.action === 'plot_gene_dotplot' && !askedForDotplot) {
        const genes = command.params?.genes;
        const gene = command.params?.gene;
        const singleGene = Array.isArray(genes) && genes.length === 1 ? genes[0] : (!genes || !genes.length) && gene ? gene : null;
        if (singleGene) {
          command = { action: 'plot_gene_expression', params: { gene: singleGene, colorMap: command.params?.colorMap, showPeakView: false } };
        }
        // multi-gene "plot X and Y" without "dotplot" → show scatter for first gene (default)
        if (Array.isArray(genes) && genes.length > 1 && !singleGene) {
          command = { action: 'plot_gene_expression', params: { gene: genes[0], colorMap: command.params?.colorMap, showPeakView: false } };
        }
      }
      if (command.action === 'plot_gene_violin' && !askedForViolin) {
        const gene = command.params?.gene;
        if (gene) {
          command = { action: 'plot_gene_expression', params: { gene, colorMap: command.params?.colorMap, showPeakView: false } };
        }
      }


      // Multiome modality disambiguation: for actions that apply to either RNA or ATAC,
      // check whether the user specified which modality. If not, ask them to choose.
      // BANKSY region segmentation: requires spatial data
      if (command.action === 'region_segmentation') {
        const isSpatial = dataInfo?.modality === 'spatial' ||
          dataInfo?.modality === 'visium' ||
          dataInfo?.modality === 'visium-hd' ||
          dataInfo?.modality === 'xenium' ||
          dataInfo?.modality === 'merfish' ||
          dataInfo?.spatialCoordinates?.length > 0;
        if (!isSpatial) {
          addBotMessage(
            'BANKSY region segmentation requires a spatial dataset with tissue coordinates.\n\n' +
            'Please load a spatial dataset (Visium, Xenium, MERFISH, or similar) first.',
            'warning'
          );
          setIsProcessing(false);
          return;
        }
        const lambda = command.params?.lambda ?? 0.3;
        const resolution = command.params?.resolution ?? 0.3;
        addBotMessage(
          `Running **BANKSY spatial region segmentation** (lambda=${lambda}, resolution=${resolution}).\n\n` +
          'BANKSY combines each cell\'s own gene expression with a weighted average of its spatial neighbors ' +
          'to identify coherent tissue regions.\n\n' +
          '- **lambda** controls spatial vs transcriptomic balance: `0` = purely transcriptomic, `1` = purely spatial averaging.\n' +
          '- **resolution** controls region granularity: lower = fewer larger regions, higher = more fine-grained regions.\n\n' +
          'Results will appear on the spatial tissue view with cells colored by region. This may take a minute...',
          'info'
        );
        const result = onAnalysisRequest(command);
        if (result?.error) {
          addBotMessage(`Error: ${result.error}`, 'danger');
        }
        setIsProcessing(false);
        return;
      }

      // SpaGE gene imputation: only for Xenium, MERFISH, CosMX (and their integrations)
      if (command.action === 'impute_gene') {
        const allowedFormats = ['10X Xenium', 'MERFISH', 'CosMX'];
        const allowedModalities = [
          'xenium-integration', 'merfish-integration', 'cosmx-integration',
        ];
        const isSupportedSpatial =
          (dataInfo?.modality === 'spatial' && allowedFormats.includes(dataInfo?.format)) ||
          allowedModalities.includes(dataInfo?.modality);
        if (!isSupportedSpatial) {
          addBotMessage(
            'Gene imputation is for Xenium, MERFISH and CosMX only.',
            'info'
          );
          setIsProcessing(false);
          return;
        }
        const geneName = command.params?.gene;
        const geneLabel = geneName ? `**${geneName}**` : 'the requested gene(s)';
        // Add message with a button to select scRNA reference
        setMessages(prev => [...prev, {
          type: 'bot',
          text: `To impute ${geneLabel} using **SpaGE**, I need a scRNA-seq reference dataset.\n\nThis should be the same type of scRNA-seq data you would load into the scRNA module, either a **10x HDF5 (.h5)** file or a **10x folder** containing matrix.mtx + features.tsv + barcodes.tsv.\n\nPlease click the button below to select the scRNA-seq reference path:`,
          timestamp: new Date(),
          intent: 'info',
          imputeAction: { gene: geneName, genes: command.params?.genes },
        }]);
        setIsProcessing(false);
        return;
      }

      // WNN integration: no modality disambiguation needed, it always uses both
      if (command.action === 'wnn_integrate') {
        if (dataInfo?.modality !== 'multiome') {
          addBotMessage('WNN integration requires multiome (RNA + ATAC) data. Please load a multiome dataset first.', 'warning');
          setIsProcessing(false);
          return;
        }
        addBotMessage(
          'Running **WNN (Weighted Nearest Neighbor) integration**, combining RNA and ATAC into a unified co-embedding UMAP.\n\n' +
          'This may take a few minutes depending on dataset size. Both the RNA view and ATAC view will show the integrated co-embedding when complete.',
          'info'
        );
        const result = onAnalysisRequest(command);
        if (result?.error) {
          addBotMessage(`Error: ${result.error}`, 'danger');
        }
        setIsProcessing(false);
        return;
      }

      if (dataInfo?.modality === 'multiome') {
        const analysisActions = ['run_umap', 'cluster_and_visualize', 'update_clustering_resolution', 'update_umap_parameters', 'update_pca_for_umap', 'force_reanalysis'];
        const clusterActions = ['find_markers', 'cluster_info', 'rename_cluster'];
        const ambiguousActions = [...clusterActions, ...analysisActions];
        if (ambiguousActions.includes(command.action) && !command.params?.multiomeTarget) {
          if (!command.params) command.params = {};
          const lowerMsg = (originalMessage || '').toLowerCase();
          const mentionsRna = /\brna\b|\bgene\s*expression\b|\bgex\b|\btranscript/.test(lowerMsg);
          const mentionsAtac = /\batac\b|\bchromatin\b|\bpeak/.test(lowerMsg);
          const mentionsLsi = /\blsi\b/.test(lowerMsg);

          // In WNN mode, rename_cluster always needs explicit disambiguation, the three cluster
          // sets are independent so we never auto-assign even if user mentions "RNA"/"ATAC".
          const forcePrompt = wnnActive && command.action === 'rename_cluster';

          if (!forcePrompt && mentionsRna && !mentionsAtac) {
            command.params.multiomeTarget = 'rna';
          } else if (!forcePrompt && mentionsAtac && !mentionsRna) {
            command.params.multiomeTarget = 'atac';
            if (mentionsLsi) command.params.atacMethod = 'lsi';
          } else {
            // Ambiguous (or forced prompt in WNN rename) – present options to the user
            const isFullPipeline = command.action === 'force_reanalysis';
            const isClusterAction = clusterActions.includes(command.action);
            const options = [
              { label: 'RNA (Gene Expression)', action: command.action, params: { ...command.params, multiomeTarget: 'rna', ...(mentionsLsi ? { atacMethod: 'lsi' } : {}) } },
              { label: 'ATAC (Chromatin Accessibility)', action: command.action, params: { ...command.params, multiomeTarget: 'atac', ...(mentionsLsi ? { atacMethod: 'lsi' } : {}) } },
            ];
            // Add WNN option for cluster actions (rename, find markers, etc.) when WNN 3-panel is active
            if (isClusterAction && wnnActive) {
              options.push({ label: 'WNN (Integrated)', action: command.action, params: { ...command.params, multiomeTarget: 'wnn' } });
            }
            setPendingClarificationOptions(options);
            const optionsText = options.map((opt, idx) => `${idx + 1}. ${opt.label}`).join('\n');
            const numOptions = options.length;
            const message = forcePrompt
              ? `Which cluster set do you want to rename? Each view has its own independent cluster labels.\n\n**Options:**\n${optionsText}\n\nPlease select an option by number (e.g., "1", "2", or "3").`
              : isFullPipeline
                ? `This is multiome data. Which dataset do you want to run the full analysis on (cell filtering → normalization → UMAP → clustering)?\n\nIf cells are filtered during reanalysis, the other modality will be filtered to the same cells so **both RNA and ATAC views always show the same cells**.\n\n**Options:**\n${optionsText}\n\nPlease select an option by number (e.g., "1" or "2").`
                : `This is multiome data with separate RNA and ATAC analyses${wnnActive && isClusterAction ? ' and a WNN integrated view' : ''}. Which modality do you mean?\n\n**Options:**\n${optionsText}\n\nPlease select an option by number (e.g., "1"${numOptions > 2 ? ` or "${numOptions}"` : ' or "2"'}).`;
            addBotMessage(message, 'info');
            setIsProcessing(false);
            return;
          }
        }
      }

      // Handle chat_question: route directly to chat model
      if (command.action === 'chat_question') {

        if (effectiveLocalChatMode && isChatModelLoaded()) {
          addBotMessage('_Thinking..._', 'info');

          try {
            const chatResponse = await generateChatResponse(command.params.query || originalMessage, dataContext);

            // Remove "Thinking..." message
            setMessages(prev => prev.slice(0, -1));

            if (chatResponse) {
              addBotMessage(chatResponse, 'info');
            } else {
              addBotMessage(getUnknownResponseMessage(), 'info');
            }
          } catch (chatError) {
            console.warn('Chat model response failed:', chatError);
            setMessages(prev => prev.slice(0, -1));

            // Show user-friendly error message for API errors
            let errorMessage = getUnknownResponseMessage();
            if (chatError.message) {
              if (chatError.message.includes('quota') || chatError.message.includes('Quota exceeded')) {
                errorMessage = `**API Quota Exceeded**\n\n${chatError.message}\n\n` +
                  `You can:\n` +
                  `- Wait a few minutes and try again\n` +
                  `- Check your API usage at https://ai.dev/rate-limit\n` +
                  `- Consider upgrading your API plan\n` +
                  `- Or switch to ChatGPT API if you have an OpenAI account`;
              } else if (chatError.message.includes('API key')) {
                errorMessage = `**API Configuration Error**\n\n${chatError.message}\n\n` +
                  `Please check your API key in the Model section.`;
              } else if (chatError.message.includes('API error')) {
                errorMessage = `**API Error**\n\n${chatError.message}\n\n` +
                  `Please check your API key and try again.`;
              }
            }
            addBotMessage(errorMessage, 'warning');
          }
        } else {
          // No chat model available; explain this is outside CellPilot's scope
          addBotMessage(
            "That's a great question about biology, but it's outside what I can help with directly. " +
            "I'm designed for single-cell and spatial transcriptomics data analysis tasks like plotting genes, finding markers, and clustering. " +
            "For general biology questions, I recommend checking resources like GeneCards, UniProt, or asking Claude/ChatGPT.\n\n" +
            "**Tip:** Configure a Chat Model (ChatGPT/Gemini API or local model in the Model section) to get conversational responses for general questions!",
            'info'
          );
        }

        return; // Don't set setIsProcessing(false) here; let caller handle it
      }

      // Step 2a: If detected as gene_info request, do BOTH: plot the gene AND get chat explanation
      if (command.action === 'gene_info') {
        const geneName = command.params.gene;

        // First, plot the gene expression
        addBotMessage(`Plotting expression for gene ${geneName} and getting information...`, 'info');

        // Execute the plot command
        const plotCommand = {
          action: 'plot_gene_expression',
          params: { gene: geneName }
        };
        const plotResult = onAnalysisRequest(plotCommand);

        if (plotResult.error) {
          addBotMessage(`Error plotting gene: ${plotResult.error}`, 'danger');
        }

        // Update last plot context
        setLastPlotContext({
          action: 'plot_gene_expression',
          gene: geneName,
          timestamp: new Date(),
        });

        // Now get chat explanation if chat model is loaded
        if (effectiveLocalChatMode && isChatModelLoaded()) {
          try {
            const dataContext = {
              clusters: dataInfo?.clusters || [],
              totalCells: dataInfo?.cells || 0,
              clusterLabels: clusterLabelMap || {},
            };

            // Ask specifically about the gene
            const geneQuery = `What is the gene ${geneName}? What is its function and what cell types typically express it?`;
            const chatResponse = await generateChatResponse(geneQuery, dataContext);

            if (chatResponse) {
              addBotMessage(`**About ${geneName}:**\n\n${chatResponse}`, 'info');
            }
          } catch (chatError) {
            console.warn('Chat explanation failed:', chatError);
            // Still succeeded with plot, just no explanation
            addBotMessage(
              `Gene ${geneName} plotted successfully. Configure a Chat Model (ChatGPT/Gemini API or local model) for gene function information, ` +
              `or check GeneCards (genecards.org) for details about this gene.`,
              'info'
            );
          }
        } else {
          // No chat model: suggest resources
          addBotMessage(
            `Gene ${geneName} plotted on UMAP. For information about this gene's function, ` +
            `configure a Chat Model (ChatGPT/Gemini API or local model) or check resources like GeneCards (genecards.org) or NCBI Gene.`,
            'info'
          );
        }

        return; // Don't set setIsProcessing(false) here; let caller handle it
      }

      // Handle cluster name resolution for router results
      const resolveLabelMap = dataContext?.chainClusterLabelMap ?? clusterLabelMap;
      if (command.params.cluster !== undefined && resolveLabelMap) {
        const clusterParam = command.params.cluster;
        // If it's a string label, try to resolve to cluster ID(s)
        if (typeof clusterParam === 'string' && isNaN(parseInt(clusterParam))) {
          // Find ALL cluster IDs that have been renamed to this label (for merged clusters)
          const matchingIds = Object.keys(resolveLabelMap).filter(
            key => resolveLabelMap[key].toLowerCase() === clusterParam.toLowerCase()
          );

          if (matchingIds.length > 1) {
            // Multiple clusters merged to the same label: pass as array
            command.params.clusters = matchingIds.map(id => parseInt(id));
            command.params.cluster = parseInt(matchingIds[0]); // Keep single for backward compatibility
          } else if (matchingIds.length === 1) {
            command.params.cluster = parseInt(matchingIds[0]);
          }
        }
      }


      if (command.action === 'set_colormap') {
        const map = command.params?.colorMap;
        const desc = describeColorSelection(map) || 'new colors';
        const handled = onSetColorMap(map);
        if (handled) {
          addBotMessage(`Updated color map to ${desc}.`, 'success');
        } else {
          addBotMessage('I do not have a recent gene expression plot to recolor. Please plot a gene first.', 'warning');
        }
        return; // Don't set setIsProcessing(false) here; let caller handle it
      }

      if ((command.action === 'highlight_rna_cluster_on_atac' || command.action === 'clear_rna_highlight_on_atac') && dataInfo?.modality === 'multiome' && onHighlightRnaClusterOnAtac) {
        const clusterParam = command.params?.cluster;
        const clear = command.action === 'clear_rna_highlight_on_atac' || clusterParam == null;
        const handled = onHighlightRnaClusterOnAtac(clear ? null : clusterParam);
        if (handled) {
          const label = clusterParam != null ? (clusterLabelMap?.[String(clusterParam)] ?? clusterParam) : '';
          addBotMessage(clear
            ? 'Cleared RNA cluster highlight on ATAC view.'
            : `Highlighting cells from RNA cluster ${label} on the ATAC view in red.`, 'success');
        } else {
          addBotMessage('Could not resolve that cluster. Try a cluster number or a renamed label (e.g. "cluster 10" or "cluster PT").', 'warning');
        }
        setIsProcessing(false);
        return;
      }

      if ((command.action === 'highlight_atac_cluster_on_rna' || command.action === 'clear_atac_highlight_on_rna') && dataInfo?.modality === 'multiome' && onHighlightAtacClusterOnRna) {
        const clusterParam = command.params?.cluster;
        const clear = command.action === 'clear_atac_highlight_on_rna' || clusterParam == null;
        const handled = onHighlightAtacClusterOnRna(clear ? null : clusterParam);
        if (handled) {
          const label = clusterParam != null ? (atacClusterLabelMap?.[String(clusterParam)] ?? clusterParam) : '';
          addBotMessage(clear
            ? 'Cleared ATAC cluster highlight on RNA view.'
            : `Highlighting cells from ATAC cluster ${label} on the RNA view in red.`, 'success');
        } else {
          addBotMessage('Could not resolve that cluster. Try a cluster number or a renamed label (e.g. "cluster 11" or the ATAC cluster name).', 'warning');
        }
        setIsProcessing(false);
        return;
      }

      if (command.action === 'plot_gene_expression') {
        const askedForGeneActivity = /gene\s+activi?ty|activi?ty\s+for|plot\s+.*activi?ty/i.test(originalMessage || '');
        const hasAtac = dataInfo?.modality === 'atac' || dataInfo?.modality === 'multiome';
        if (askedForGeneActivity && !hasAtac) {
          const dataType = dataInfo?.modality === 'spatial' ? 'spatial' : 'scRNA-seq';
          addBotMessage(
            `Gene activity (peak) plotting is only available for **scATAC-seq** data. Your current dataset is **${dataType}**. Load scATAC-seq data (e.g. Cell Ranger ATAC output) to plot gene activity and view peaks on the genome. For this dataset you can use "plot gene [name]" to show gene expression on the UMAP.`,
            'warning'
          );
          setIsProcessing(false);
          return;
        }
        if (!command.params?.gene) {
          addBotMessage('Error: Gene name is required for plotting gene expression. Please specify a gene name.', 'error');
          setIsProcessing(false);
          return;
        }
        const isPeakPlot = /^chr\w+:\d+-\d+$/i.test(String(command.params.gene || '').trim());
        if (!isPeakPlot && OBVIOUS_NON_GENES.has(String(command.params.gene).toLowerCase().trim())) {
          addBotMessage(
            `"${command.params.gene}" doesn't look like a gene name. Try a gene from your dataset (e.g. use "find markers" to see top genes per cluster).`,
            'warning'
          );
          setIsProcessing(false);
          return;
        }
        const colorDesc = describeColorSelection(command.params?.colorMap);
        const suffix = colorDesc ? ` using ${colorDesc}` : '';
        addBotMessage(isPeakPlot
          ? `Plotting peak accessibility for ${command.params.gene}${suffix}…`
          : `Plotting expression for gene ${command.params.gene}${suffix}…`, 'info');

        // Update last plot context
        setLastPlotContext({
          action: 'plot_gene_expression',
          gene: command.params.gene,
          colorMap: command.params.colorMap,
          timestamp: new Date(),
        });
      }

      if (command.action === 'plot_gene_violin' && command.params?.gene) {
        const isPeakViolin = /^chr\w+:\d+-\d+$/i.test(String(command.params.gene || '').trim());
        if (!isPeakViolin && OBVIOUS_NON_GENES.has(String(command.params.gene).toLowerCase().trim())) {
          addBotMessage(
            `"${command.params.gene}" doesn't look like a gene name. Try a gene from your dataset (e.g. use "find markers" to see top genes per cluster).`,
            'warning'
          );
          setIsProcessing(false);
          return;
        }
        addBotMessage(isPeakViolin
          ? `Generating violin plot for peak ${command.params.gene}…`
          : `Generating violin plot for gene ${command.params.gene}…`, 'info');
      }

      if (command.action === 'plot_gene_dotplot') {
        const geneList = command.params?.genes;
        let label = 'selected genes';
        if (Array.isArray(geneList) && geneList.length) {
          label = geneList.join(', ');
        } else if (command.params?.gene) {
          label = command.params.gene;
        }
        const peakIdRegex = /^chr\w+:\d+-\d+$/i;
        const allPeaks = Array.isArray(geneList) && geneList.length && geneList.every(g => peakIdRegex.test(g.trim()));
        addBotMessage(allPeaks
          ? `Generating dot plot for peaks ${label}…`
          : `Generating dot plot for ${label}…`, 'info');
      }

      if (command.action === 'update_cell_filtering') {
        addBotMessage('Updating cell filtering thresholds and rerunning analysis…', 'info');
      }

      if (command.action === 'update_gene_filtering') {
        addBotMessage('Applying gene filtering request…', 'info');
      }

      if (command.action === 'update_variable_genes') {
        addBotMessage(`Setting number of variable genes to ${command.params?.num_hvgs} and reclustering…`, 'info');
      }

      if (command.action === 'update_clustering_resolution') {
        const targetNote = dataInfo?.modality === 'multiome' && command.params?.multiomeTarget
          ? ` for ${String(command.params.multiomeTarget).toUpperCase()}`
          : '';
        addBotMessage(`Updating clustering resolution${targetNote} to ${command.params?.resolution}…`, 'info');
      }

      if (command.action === 'update_pca_for_umap') {
        addBotMessage(`Using ${command.params?.num_pcs} principal components and rerunning UMAP…`, 'info');
      }

      if (command.action === 'update_umap_parameters') {
        addBotMessage('Updating UMAP parameters…', 'info');
      }

      if (command.action === 'show_parameters') {
        addBotMessage('Retrieving analysis parameters…', 'info');
      }

      if (command.action === 'cluster_info') {
        const labelMap = dataContext?.chainClusterLabelMap ?? clusterLabelMap;
        const clusterLabel = labelMap?.[String(command.params?.cluster)] || command.params?.cluster;
        const modalitySuffix = command.params?.multiomeTarget ? ` (${command.params.multiomeTarget.toUpperCase()} clusters)` : '';
        if (routerResult.source !== 'agent_silent') {
          addBotMessage(`Getting information about cluster ${clusterLabel}${modalitySuffix}…`, 'info');
        }
      }

      if (command.action === 'identify_cell_type_clusters') {
        const cellType = command.params?.cellType || command.params?.cell_type || 'the requested cell type';
        addBotMessage(`Scoring clusters for **${cellType}** marker expression…`, 'info');
      }

      if (command.action === 'deg_between_samples') {
        const c = command.params?.cluster ?? '?';
        const s1 = command.params?.sample1 ?? 'sample1';
        const s2 = command.params?.sample2 ?? 'sample2';
        const isAtacIntegration = dataInfo?.modality === 'atac-integration';
        const userSaidGene = /differential\s+gene(s)?\s+(analysis|for|between)?/i.test(originalMessage || '');
        if (isAtacIntegration && userSaidGene) {
          addBotMessage('Interpreting as **differential peak analysis** (scATAC-seq).', 'info');
        }
        addBotMessage(
          isAtacIntegration
            ? `Computing differential peaks (scATAC-seq) for cluster ${c} between **${s1}** and **${s2}**…`
            : `Computing differential genes for cluster ${c} between **${s1}** and **${s2}**…`,
          'info'
        );
      }

      if (command.action === 'plot_cell_fraction') {
        addBotMessage('Computing cell fraction per cluster per sample…', 'info');
      }

      if (command.action === 'rename_cluster') {
        addBotMessage(`Renaming cluster ${command.params?.oldLabel} to "${command.params?.newLabel}"…`, 'info');
      }

      // For chained renames, pass the accumulated cluster label map so merge detection
      // uses it instead of App state (which may not have updated yet from the previous rename).
      if (command.action === 'rename_cluster' && dataContext?.chainClusterLabelMap) {
        command._clusterLabelMapForMerge = dataContext.chainClusterLabelMap;
      }

      // Handle spatial-specific commands
      if (command.action === 'show_spatial' || command.action === 'spatial_view') {
        addBotMessage('Switching to spatial tissue view…', 'info');
      }

      if (command.action === 'plot_spatial_gene') {
        const geneName = command.params?.gene;
        addBotMessage(`Plotting gene ${geneName} on tissue coordinates…`, 'info');
      }

      if (command.action === 'spatial_region_markers') {
        const n = command.params?.selectedCellIndices?.length || spatialSelection?.cellCount || 0;
        addBotMessage(
          `Finding marker genes for the selected spatial region (${n.toLocaleString()} cells) versus all other cells…`,
          'info'
        );
      }

      if (command.action === 'spatial_cell_interaction') {
        const regions = Array.isArray(spatialSelection?.regions) ? spatialSelection.regions : [];
        if (regions.length < 2) {
          addBotMessage('Cell-cell interaction analysis needs at least two selected spatial areas. Please draw/select two regions in Spatial View, then ask again.', 'warning');
        } else {
          addBotMessage(`Running ligand-receptor communication analysis across **${regions.length} selected spatial regions**…`, 'info');
        }
      }

      // TF motif analysis: inform user which cluster set is used (always RNA)
      if (command.action === 'tf_motif_analysis') {
        const clusterParam = command.params?.cluster;
        const displayName = clusterLabelMap?.[String(clusterParam)] ?? clusterParam;
        const wnnNote = wnnActive
          ? ' Since you have three views active (RNA, ATAC, WNN), this analysis always uses **RNA clusters**, TF prioritization ranks factors by RNA expression and peak-gene links, so RNA clusters are the most meaningful input. Results will appear in the **RNA panel**.'
          : '';
        addBotMessage(
          `Running TF motif enrichment for cluster **${displayName}** using linked peaks and marker genes.${wnnNote}`,
          'info'
        );
      }

      // If user said "LSI" and command targets ATAC, use TF-IDF/LSI backup pipeline
      const msgLower = (originalMessage || '').toLowerCase();
      if (/\blsi\b/.test(msgLower) && (command.params?.multiomeTarget === 'atac' || dataInfo?.modality === 'atac')) {
        if (!command.params) command.params = {};
        command.params.atacMethod = 'lsi';
      }

      // Execute analysis
      const result = onAnalysisRequest(command) || {};

      if (result.error) {
        addBotMessage(`Error: ${result.error}`, 'danger');
        setIsProcessing(false); // Reset processing state on error
        return { success: false, error: result.error, command };
      } else {
        // For async operations (like plot_gene_expression), the worker will send results later
        // Reset processing state immediately after sending the command
        // The isAnalyzing state (from App.jsx) will track the actual analysis progress
        setIsProcessing(false);

        if (result.message) {
          // Only add message if we didn't already show one for this action
          // (plot_gene_expression and deg_between_samples already show a message above)
          if (command.action !== 'plot_gene_expression' && command.action !== 'deg_between_samples' && command.action !== 'plot_cell_fraction' && command.action !== 'plot_gene_dotplot' && command.action !== 'plot_gene_violin' && command.action !== 'tf_motif_analysis' && command.action !== 'spatial_region_markers' && command.action !== 'spatial_cell_interaction' && command.action !== 'cluster_info' && routerResult.source !== 'agent_silent') {
            addBotMessage(result.message || 'Analysis started...', 'success');
          }
        }
        // Store action context for follow-up questions
        setLastActionContext(command.action, command.params);
        return { success: true, command, message: result.message || null };
      }

    } catch (error) {
      console.error('Error processing message:', error);
      addBotMessage(`Sorry, I encountered an error: ${error.message}`, 'danger');
      setIsProcessing(false); // Always reset processing state on error
      throw error; // Re-throw so caller can handle it
    } finally {
      // Ensure processing state is reset even if something goes wrong
      // For async operations, we reset it after sending the command above
      // This is a safety net
    }
  };

  const knownColorSchemes = ['viridis', 'magma', 'inferno', 'plasma', 'cividis', 'turbo', 'cubehelix'];

  const extractClusterColorDirective = (text) => {
    const source = String(text || '').trim();
    const lower = source.toLowerCase();
    if (!/\bclusters?\b/.test(lower) || !/\bcolou?r\b/.test(lower)) return null;

    const clusterMatch =
      source.match(/\bclusters?\s+([A-Za-z0-9_.-]+)/i) ||
      source.match(/\b([A-Za-z0-9_.-]+)\s+clusters?\b/i);
    if (!clusterMatch?.[1]) return null;

    const reset = /\b(reset|clear|remove|default)\b/.test(lower);
    let color = null;
    if (!reset) {
      const colorMatch =
        source.match(/\bcolou?r\s+(?:to|as|=)\s*([#A-Za-z0-9(),.%\s-]+?)(?:\s+(?:for|on|in)\b|$)/i) ||
        source.match(/\b(?:to|as|=)\s*([#A-Za-z0-9(),.%\s-]+?)\s+colou?r\b/i);
      color = colorMatch?.[1]?.trim().replace(/[.?!,;:]+$/, '');
      if (!color) return null;
    }

    let multiomeTarget = null;
    if (/\bATAC\b/i.test(source)) multiomeTarget = 'atac';
    if (/\bRNA\b/i.test(source)) multiomeTarget = 'rna';
    if (/\bWNN\b/i.test(source)) multiomeTarget = 'wnn';

    return {
      cluster: clusterMatch[1],
      color,
      reset,
      multiomeTarget,
    };
  };

  const extractColorDirective = (text) => {
    const lower = text.toLowerCase();

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

const describeColorSelection = (map) => {
  if (!map) return null;
  if (map.type === 'scheme') {
    return map.name;
  }
  if (map.type === 'custom' && Array.isArray(map.colors)) {
    return map.colors.join(' → ');
  }
  return null;
};

  /**
   * Handle scRNA reference path selection for SpaGE imputation.
   * Opens the Electron path selector, then fires the impute_gene analysis request.
   */
  const handleSelectScrnaReference = async (imputeAction) => {
    if (!window.electron?.selectPath) {
      addBotMessage('File selection is not available in this environment.', 'danger');
      return;
    }
    try {
      const scrnaPath = await window.electron.selectPath();
      if (!scrnaPath) return; // user cancelled
      addBotMessage(`scRNA-seq reference selected: \`${scrnaPath}\`\n\nRunning SpaGE imputation, this may take a minute...`, 'info');
      const result = onAnalysisRequest({
        action: 'impute_gene',
        params: {
          gene: imputeAction?.gene,
          genes: imputeAction?.genes,
          scrnaPath,
        },
      });
      if (result?.error) {
        addBotMessage(`Error starting imputation: ${result.error}`, 'danger');
      }
    } catch (err) {
      addBotMessage(`Error selecting scRNA-seq reference: ${err.message}`, 'danger');
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const assistantModeLabel = agentMode ? 'Agent' : effectiveLocalChatMode ? 'Local AI' : 'Intent';
  const assistantModeIntent = agentMode ? 'success' : effectiveLocalChatMode ? 'primary' : 'none';

  return (
    <div className="chatbot">
      <div className="chatbot-header">
        <div className="chatbot-header-title">
          <Icon icon="chat" size={16} />
          <span>AI Assistant</span>
        </div>
        <Tag className="assistant-mode-tag" minimal intent={assistantModeIntent}>
          Chat mode: {assistantModeLabel}
        </Tag>
        {!dataLoaded && (
          <Tag minimal intent="warning">No data loaded</Tag>
        )}
      </div>

      <div className="chatbot-messages">
        {messages.map((msg, idx) => (
          <div key={idx} className={`message message-${msg.type}`}>
            <div className="message-header">
              <span className="message-sender">
                {msg.type === 'user' ? (
                  <>👤 You</>
                ) : (
                  <>
                    <img
                      src={chatbotIcon}
                      alt="CellPilot"
                      style={{
                        width: '18px',
                        height: '18px',
                        verticalAlign: 'middle',
                        marginRight: '4px'
                      }}
                    />
                    CellPilot
                  </>
                )}
              </span>
              <span className="message-time">
                {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div className="message-content">
              {msg.type === 'bot' ? (
                <>
                  <ReactMarkdown>{msg.text}</ReactMarkdown>
                  {msg.imputeAction && (
                    <div style={{ marginTop: '8px' }}>
                      <Button
                        icon="folder-open"
                        intent="primary"
                        text="Select scRNA-seq Reference"
                        onClick={() => handleSelectScrnaReference(msg.imputeAction)}
                        disabled={isProcessing || isAnalyzing}
                      />
                    </div>
                  )}
                </>
              ) : (
                msg.text.split('\n').map((line, i) => (
                  <p key={i}>{line}</p>
                ))
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div
        className="chatbot-input"
        onKeyDown={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
      >
        <InputGroup
          inputRef={inputRef}
          placeholder={isAnalyzing && !analysisStatusMessage ? "Analysis in progress..." : (!isAnalyzing ? "Ask me to analyze your data... (e.g., 'cluster the cells and show me UMAP plot')" : "")}
          value={isAnalyzing && analysisStatusMessage ? analysisStatusMessage : inputValue}
          onChange={(e) => { if (!isAnalyzing) setInputValue(e.target.value); }}
          onKeyPress={handleKeyPress}
          disabled={isProcessing || isAnalyzing}
          readOnly={isAnalyzing && !!analysisStatusMessage}
          rightElement={
            <Button
              icon="send-message"
              intent="primary"
              onClick={handleSend}
              loading={isProcessing || isAnalyzing}
              disabled={!inputValue.trim() || isProcessing || isAnalyzing}
            />
          }
        />
      </div>
    </div>
  );
});

export default ChatBot;
