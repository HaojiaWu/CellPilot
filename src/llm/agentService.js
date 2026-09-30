import {
  getApiConfig,
  getOpenAIChatReasoningParams,
  getOpenAIReasoningEffort,
  getOpenAITemperatureParams,
  getClaudeTemperatureParams,
  getOpenAITokenParams,
  isOpenAINewChatModel,
  isOpenAIResponsesPreferredModel,
  getSelectedApiModel,
} from './apiChatService';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const OPENROUTER_MODEL = 'deepseek/deepseek-v4-pro';
const AGENT_RESULT_SUMMARY_MAX_TOKENS = 5000;

export const AGENT_PROVIDERS = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  groq: 'Groq',
  openrouter: 'OpenRouter',
};

function getAgentModel(provider, fallbackModel) {
  return getSelectedApiModel(provider) || fallbackModel;
}

function claudeTemperature(value = 0) {
  const model = getAgentModel('claude', 'claude-sonnet-4-20250514');
  return getClaudeTemperatureParams(model, value);
}

function getGeminiModelUrl(apiKey, model) {
  return `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;
}

async function requestOpenRouterChatContent(apiKey, {
  model,
  system,
  user,
  maxTokens,
  temperature = 0,
  json = false,
}) {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `OpenRouter API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

function extractOpenAIResponsesText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}

async function requestOpenAIResponsesText(apiKey, {
  model,
  system,
  user,
  maxTokens,
  json = false,
}) {
  const body = {
    model,
    instructions: system,
    input: user,
    max_output_tokens: maxTokens,
  };
  if (isOpenAINewChatModel(model)) {
    body.reasoning = { effort: getOpenAIReasoningEffort(model) };
  }
  if (json) body.text = { format: { type: 'json_object' } };

  const response = await fetch(OPENAI_RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
  }

  return extractOpenAIResponsesText(await response.json());
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2], dataUrl };
}

function getFirstRoiImage(toolHistory = []) {
  for (const item of toolHistory) {
    const parsed = parseDataUrl(item?.roiImageDataUrl);
    if (parsed) return parsed;
  }
  return null;
}

const CELLPILOT_TOOLS = [
  {
    name: 'plot_gene_expression',
    description: 'Plot one gene or peak on UMAP, ATAC gene activity, or the active embedding.',
    parameters: { gene: 'string', colorMap: 'optional color map object', showPeakView: 'optional boolean' },
    readOnly: true,
  },
  {
    name: 'plot_spatial_gene',
    description: 'Plot one gene on spatial tissue coordinates when spatial data is loaded.',
    parameters: { gene: 'string' },
    readOnly: true,
  },
  {
    name: 'plot_gene_violin',
    description: 'Create a violin plot for one gene or peak grouped by active clusters.',
    parameters: { gene: 'string' },
    readOnly: true,
  },
  {
    name: 'plot_gene_dotplot',
    description: 'Create a dot plot for one or more genes or peaks grouped by active clusters.',
    parameters: { genes: 'array of gene strings' },
    readOnly: true,
  },
  {
    name: 'find_markers',
    description: 'Find marker genes or peaks for a cluster compared with other cells.',
    parameters: { cluster: 'cluster id or label', clusters: 'optional array of cluster ids', multiomeTarget: 'optional rna|atac|wnn' },
    readOnly: true,
  },
  {
    name: 'spatial_region_markers',
    description: 'Find marker genes for the currently selected spatial region compared with non-selected cells, then use the markers to annotate what the selected tissue area likely represents.',
    parameters: { selectedCellIndices: 'array of selected cell indices supplied by CellPilot from the ROI tool' },
    readOnly: true,
  },
  {
    name: 'spatial_cell_interaction',
    description: 'Run CellChat-like ligand-receptor / cell-cell communication analysis across currently selected spatial regions, including marker-based annotation of each selected region before interpreting interactions. CellPilot supplies ROI cell indices internally; never ask the user to paste cell IDs. If fewer than two selected regions are present, tell the user to draw/select at least two spatial areas.',
    parameters: {},
    readOnly: true,
  },
  {
    name: 'cluster_info',
    description: 'Summarize or inspect one cluster using existing cluster data and marker results. Use annotateCellType=true when the user asks to annotate, identify, name, or infer the cell type of a cluster.',
    parameters: { cluster: 'cluster id or label', multiomeTarget: 'optional rna|atac|wnn', annotateCellType: 'optional boolean' },
    readOnly: true,
  },
  {
    name: 'identify_cell_type_clusters',
    description: 'Rank clusters by marker expression for a requested cell type or compartment, such as loop of Henle, proximal tubule, endothelial cells, podocytes, immune cells, or collecting duct.',
    parameters: { cellType: 'requested cell type string', markerGenes: 'optional array of marker gene strings', multiomeTarget: 'optional rna|atac|wnn' },
    readOnly: true,
  },
  {
    name: 'show_parameters',
    description: 'Show current analysis parameters.',
    parameters: { step: 'optional pipeline step' },
    readOnly: true,
  },
  {
    name: 'show_spatial',
    description: 'Switch to the spatial tissue view.',
    parameters: {},
    readOnly: true,
  },
  {
    name: 'spatial_view',
    description: 'Switch to the spatial tissue view.',
    parameters: {},
    readOnly: true,
  },
  {
    name: 'show_regions',
    description: 'Show existing BANKSY or spatial region segmentation results.',
    parameters: {},
    readOnly: true,
  },
  {
    name: 'region_composition',
    description: 'Describe the cell or cluster composition of a spatial region.',
    parameters: { regionId: 'region id or label' },
    readOnly: true,
  },
  {
    name: 'plot_cell_fraction',
    description: 'Compute and plot cell fraction per cluster per sample.',
    parameters: {},
    readOnly: true,
  },
  {
    name: 'deg_between_samples',
    description: 'Compare genes or peaks between two samples within a cluster.',
    parameters: { cluster: 'cluster id or label', sample1: 'string', sample2: 'string' },
    readOnly: true,
  },
  {
    name: 'tf_motif_analysis',
    description: 'Run TF motif enrichment or TF prioritization for one cluster.',
    parameters: { cluster: 'cluster id or label' },
    readOnly: true,
  },
  {
    name: 'show_peak_gene_links',
    description: 'Show existing peak-gene links for a gene.',
    parameters: { gene: 'string' },
    readOnly: true,
  },
  {
    name: 'link_peaks',
    description: 'Link accessible peaks to one gene using existing RNA and ATAC data.',
    parameters: { gene: 'string', cluster: 'optional cluster id or label' },
    readOnly: true,
  },
  {
    name: 'impute_gene',
    description: 'Impute missing spatial genes with SpaGE using an external scRNA-seq reference selected by the user.',
    parameters: { gene: 'string', genes: 'optional array of gene strings' },
    readOnly: false,
    expensive: true,
  },
  {
    name: 'run_umap',
    description: 'Run UMAP dimensionality reduction with current preprocessing.',
    parameters: { multiomeTarget: 'optional rna|atac' },
    readOnly: false,
  },
  {
    name: 'cluster_and_visualize',
    description: 'Run clustering and visualization using current or supplied parameters.',
    parameters: { resolution: 'optional number', multiomeTarget: 'optional rna|atac' },
    readOnly: false,
  },
  {
    name: 'force_reanalysis',
    description: 'Rerun the full analysis pipeline.',
    parameters: { multiomeTarget: 'optional rna|atac' },
    readOnly: false,
    expensive: true,
  },
  {
    name: 'update_clustering_resolution',
    description: 'Change clustering resolution and rerun clustering.',
    parameters: { resolution: 'number', multiomeTarget: 'optional rna|atac|wnn' },
    readOnly: false,
  },
  {
    name: 'update_umap_parameters',
    description: 'Change UMAP parameters and rerun UMAP.',
    parameters: { n_neighbors: 'optional number', min_dist: 'optional number', spread: 'optional number', multiomeTarget: 'optional rna|atac' },
    readOnly: false,
  },
  {
    name: 'update_pca_for_umap',
    description: 'Change the number of PCs used for UMAP and rerun UMAP.',
    parameters: { num_pcs: 'number', multiomeTarget: 'optional rna|atac' },
    readOnly: false,
  },
  {
    name: 'update_cell_filtering',
    description: 'Update cell filtering thresholds and rerun analysis.',
    parameters: { min_genes: 'optional number', max_genes: 'optional number', max_mito: 'optional number' },
    readOnly: false,
    expensive: true,
  },
  {
    name: 'update_gene_filtering',
    description: 'Update gene filtering thresholds.',
    parameters: { min_cells: 'optional number' },
    readOnly: false,
  },
  {
    name: 'update_variable_genes',
    description: 'Set the number of highly variable genes and rerun downstream analysis.',
    parameters: { num_hvgs: 'number' },
    readOnly: false,
  },
  {
    name: 'rename_cluster',
    description: 'Rename one cluster label.',
    parameters: { oldLabel: 'cluster id or current label', newLabel: 'new label string', multiomeTarget: 'optional rna|atac|wnn' },
    readOnly: false,
    modifiesObject: true,
  },
  {
    name: 'region_segmentation',
    description: 'Run BANKSY spatial region segmentation.',
    parameters: { lambda: 'optional number', resolution: 'optional number' },
    readOnly: false,
    expensive: true,
  },
  {
    name: 'wnn_integrate',
    description: 'Run WNN integration for multiome RNA and ATAC data.',
    parameters: {},
    readOnly: false,
    expensive: true,
  },
];

const TOOL_NAMES = new Set(CELLPILOT_TOOLS.map(tool => tool.name));

function buildAgentSystemPrompt(context = {}) {
  const contextJson = JSON.stringify(context, null, 2);
  const toolsJson = JSON.stringify(CELLPILOT_TOOLS, null, 2);

  return `You are CellPilot Agent, an AI assistant for single-cell, single-nucleus, spatial transcriptomics, scATAC-seq, and multiome data analysis.

You do not perform heavy computation yourself. You choose internal CellPilot tools, pass structured parameters, and explain what should happen. Never invent results, genes, cell types, plots, statistics, or dataset properties.

Use the current dataset context carefully:
${contextJson}

Available CellPilot tools:
${toolsJson}

Return only valid JSON. No markdown fences.

JSON response schema:
{
  "mode": "tool_plan" | "answer" | "clarify",
  "message": "short user-facing explanation",
  "steps": [
    {
      "action": "one available tool name",
      "parameters": {},
      "reason": "brief reason",
      "requires_confirmation": false
    }
  ]
}

Rules:
- If dataset_loaded is false and the request needs data, use mode "answer" and tell the user to load data.
- Use tools for analysis, visualization, clustering, renaming, spatial work, ATAC work, or object changes.
- Read-only actions such as plotting, marker finding, cluster info, summaries, and existing results do not need confirmation.
- Object-changing actions such as rename_cluster should require confirmation unless the user clearly gave a direct command.
- Expensive actions such as force_reanalysis, region_segmentation, WNN integration, or broad filtering changes should require confirmation unless the user clearly asked to run them.
- If the user asks to annotate clusters, get markers first and suggest labels. Do not rename clusters automatically.
- For "annotate cluster N", "what cell type is cluster N", or "identify cluster N", use cluster_info with annotateCellType=true.
- For "what is this area/region?" after a spatial ROI is selected, use spatial_region_markers.
- For "which cluster might be <cell type>", "find <cell type> clusters", or "do you know which cluster is <cell type>", use identify_cell_type_clusters.
- Do not treat cluster_labels as the complete cluster list. cluster_ids / rna_cluster_ids are the authoritative available numeric cluster IDs; cluster_labels only contains renamed labels.
- If a gene might be spatial and spatial coordinates exist, prefer plot_spatial_gene. Otherwise use plot_gene_expression.
- If required parameters are missing, use mode "clarify" with one specific question.
- Never use a tool name outside the available tool list.
- Keep plans short: one to five steps.`;
}

function normalizeAgentResponse(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) throw new Error('Agent returned an empty response');

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  const jsonText = extractBalancedJson(candidate);
  const parsed = JSON.parse(jsonText);

  if (!['tool_plan', 'answer', 'clarify'].includes(parsed.mode)) {
    throw new Error('Agent response did not include a valid mode');
  }

  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const safeSteps = steps.map(step => {
    if (!TOOL_NAMES.has(step.action)) {
      throw new Error(`Agent requested unavailable tool: ${step.action}`);
    }
    return {
      action: step.action,
      params: step.parameters || step.params || {},
      reason: step.reason || '',
      requiresConfirmation: !!step.requires_confirmation,
    };
  });

  return {
    mode: parsed.mode,
    message: parsed.message || '',
    steps: safeSteps,
  };
}

function extractBalancedJson(text) {
  const source = String(text || '').trim();
  const start = source.indexOf('{');
  if (start < 0 && source.startsWith('"')) return `{${source}`;
  if (start < 0) return source;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return source.slice(start);
}

function buildJsonRepairPrompt(rawText, parseError) {
  return `Convert the following invalid CellPilot agent response into valid JSON only.

Error:
${parseError.message}

Required schema:
{
  "mode": "tool_plan" | "answer" | "clarify",
  "message": "short user-facing explanation",
  "steps": [
    {
      "action": "one available tool name",
      "parameters": {},
      "reason": "brief reason",
      "requires_confirmation": false
    }
  ]
}

Allowed tool names:
${Array.from(TOOL_NAMES).join(', ')}

Invalid response:
${rawText}`;
}

async function requestOpenAIPlan(apiKey, userMessage, context) {
  const model = getAgentModel('chatgpt', 'gpt-5-mini');
  if (isOpenAIResponsesPreferredModel(model)) {
    return requestOpenAIResponsesText(apiKey, {
      model,
      system: buildAgentSystemPrompt(context),
      user: userMessage,
      maxTokens: 5000,
      json: true,
    });
  }
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildAgentSystemPrompt(context) },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      ...getOpenAITokenParams(model, 5000),
      ...getOpenAITemperatureParams(model, 0),
      ...getOpenAIChatReasoningParams(model),
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

async function requestClaudePlan(apiKey, userMessage, context) {
  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: getAgentModel('claude', 'claude-sonnet-4-20250514'),
      system: buildAgentSystemPrompt(context),
      messages: [
        { role: 'user', content: `${userMessage}\n\nReturn valid JSON only. Escape all quotes inside string values.` },
      ],
      max_tokens: 5000,
      ...claudeTemperature(0),
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content
    ?.filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

async function requestGeminiPlan(apiKey, userMessage, context) {
  const response = await fetch(getGeminiModelUrl(apiKey, getAgentModel('gemini', 'gemini-2.5-flash')), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `${buildAgentSystemPrompt(context)}\n\nUser request:\n${userMessage}`,
        }],
      }],
      generationConfig: {
        maxOutputTokens: 5000,
        temperature: 0,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text;
}

async function requestGroqPlan(apiKey, userMessage, context) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: getAgentModel('groq', GROQ_MODEL),
      messages: [
        { role: 'system', content: buildAgentSystemPrompt(context) },
        { role: 'user', content: `${userMessage}\n\nReturn valid JSON only.` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 5000,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Groq API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

async function requestOpenRouterPlan(apiKey, userMessage, context) {
  return requestOpenRouterChatContent(apiKey, {
    model: getAgentModel('openrouter', OPENROUTER_MODEL),
    system: buildAgentSystemPrompt(context),
    user: `${userMessage}\n\nReturn valid JSON only.`,
    maxTokens: 5000,
    temperature: 0,
    json: true,
  });
}

async function repairOpenAIPlan(apiKey, rawText, parseError) {
  const model = getAgentModel('chatgpt', 'gpt-5-mini');
  if (isOpenAIResponsesPreferredModel(model)) {
    return requestOpenAIResponsesText(apiKey, {
      model,
      system: 'You repair invalid JSON. Return valid JSON only.',
      user: buildJsonRepairPrompt(rawText, parseError),
      maxTokens: 5000,
      json: true,
    });
  }
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You repair invalid JSON. Return valid JSON only.' },
        { role: 'user', content: buildJsonRepairPrompt(rawText, parseError) },
      ],
      response_format: { type: 'json_object' },
      ...getOpenAITokenParams(model, 5000),
      ...getOpenAITemperatureParams(model, 0),
      ...getOpenAIChatReasoningParams(model),
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `OpenAI JSON repair error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

async function repairClaudePlan(apiKey, rawText, parseError) {
  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: getAgentModel('claude', 'claude-sonnet-4-20250514'),
      system: 'You repair invalid JSON. Return valid JSON only.',
      messages: [
        { role: 'user', content: buildJsonRepairPrompt(rawText, parseError) },
      ],
      max_tokens: 5000,
      ...claudeTemperature(0),
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Claude JSON repair error: ${response.status}`);
  }

  const data = await response.json();
  return data.content
    ?.filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

async function repairGeminiPlan(apiKey, rawText, parseError) {
  const response = await fetch(getGeminiModelUrl(apiKey, getAgentModel('gemini', 'gemini-2.5-flash')), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: buildJsonRepairPrompt(rawText, parseError) }],
      }],
      generationConfig: {
        maxOutputTokens: 5000,
        temperature: 0,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Gemini JSON repair error: ${response.status}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text;
}

async function repairGroqPlan(apiKey, rawText, parseError) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: getAgentModel('groq', GROQ_MODEL),
      messages: [
        { role: 'system', content: 'You repair invalid JSON. Return valid JSON only.' },
        { role: 'user', content: buildJsonRepairPrompt(rawText, parseError) },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 5000,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Groq JSON repair error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

async function repairOpenRouterPlan(apiKey, rawText, parseError) {
  return requestOpenRouterChatContent(apiKey, {
    model: getAgentModel('openrouter', OPENROUTER_MODEL),
    system: 'You repair invalid JSON. Return valid JSON only.',
    user: buildJsonRepairPrompt(rawText, parseError),
    maxTokens: 5000,
    temperature: 0,
    json: true,
  });
}

async function repairAgentPlan(provider, apiKey, rawText, parseError) {
  if (provider === 'chatgpt') {
    return repairOpenAIPlan(apiKey, rawText, parseError);
  }
  if (provider === 'claude') {
    return repairClaudePlan(apiKey, rawText, parseError);
  }
  if (provider === 'gemini') {
    return repairGeminiPlan(apiKey, rawText, parseError);
  }
  if (provider === 'groq') {
    return repairGroqPlan(apiKey, rawText, parseError);
  }
  if (provider === 'openrouter') {
    return repairOpenRouterPlan(apiKey, rawText, parseError);
  }
  throw parseError;
}

export function inferAgentProviderFromKey(input) {
  const value = String(input || '').trim();
  const explicit = value.match(/^(chatgpt|openai|claude|anthropic|gemini|google|groq|openrouter)\s*[:=]\s*(.+)$/i);
  const key = explicit ? explicit[2].trim() : value;
  let provider = explicit ? explicit[1].toLowerCase() : null;

  if (provider === 'openai') provider = 'chatgpt';
  if (provider === 'anthropic') provider = 'claude';
  if (provider === 'google') provider = 'gemini';
  if (!provider && key.startsWith('sk-or-')) provider = 'openrouter';
  if (!provider && key.startsWith('sk-ant-')) provider = 'claude';
  if (!provider && key.startsWith('AIza')) provider = 'gemini';
  if (!provider && key.startsWith('gsk_')) provider = 'groq';
  if (!provider && key.startsWith('sk-')) provider = 'chatgpt';

  return { provider, apiKey: key };
}

export function maskApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (key.length <= 10) return '******';
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}

export function getConfiguredAgentProvider() {
  const config = getApiConfig();
  return ['openrouter', 'chatgpt', 'claude', 'gemini', 'groq'].find(provider => config[provider]?.enabled && config[provider]?.apiKey) || null;
}

export async function generateAgentPlan(provider, userMessage, context = {}) {
  const config = getApiConfig();
  const apiKey = config[provider]?.apiKey;
  if (!apiKey) {
    throw new Error(`${AGENT_PROVIDERS[provider] || provider} API key not configured`);
  }

  let rawText = null;
  if (provider === 'chatgpt') {
    rawText = await requestOpenAIPlan(apiKey, userMessage, context);
  } else if (provider === 'claude') {
    rawText = await requestClaudePlan(apiKey, userMessage, context);
  } else if (provider === 'gemini') {
    rawText = await requestGeminiPlan(apiKey, userMessage, context);
  } else if (provider === 'groq') {
    rawText = await requestGroqPlan(apiKey, userMessage, context);
  } else if (provider === 'openrouter') {
    rawText = await requestOpenRouterPlan(apiKey, userMessage, context);
  } else {
    throw new Error(`Unknown agent provider: ${provider}`);
  }

  try {
    return normalizeAgentResponse(rawText);
  } catch (parseError) {
    console.warn('Agent returned invalid JSON, attempting repair:', parseError, rawText);
    const repairedText = await repairAgentPlan(provider, apiKey, rawText, parseError);
    return normalizeAgentResponse(repairedText);
  }
}

function buildClusterAnnotationPrompt(clusterData, context = {}) {
  const clusterLabel = clusterData.clusterLabel || `Cluster ${clusterData.cluster}`;
  const markerRows = (clusterData.markers || clusterData.topMarkers || [])
    .slice(0, 15)
    .map(marker => ({
      gene: marker.gene,
      logFC: Number.isFinite(marker.avg_logFC) ? Number(marker.avg_logFC.toFixed(3)) : marker.avg_logFC,
      pct_cluster: Number.isFinite(marker.pct1) ? Number(marker.pct1.toFixed(3)) : marker.pct1,
      pct_other: Number.isFinite(marker.pct2) ? Number(marker.pct2.toFixed(3)) : marker.pct2,
    }));

  return `You are CellPilot Agent, helping annotate a single-cell/spatial cluster from marker genes.

Dataset context:
${JSON.stringify(context, null, 2)}

Cluster:
${clusterLabel}

Cluster size:
${clusterData.cellCount} of ${clusterData.totalCells} cells (${((clusterData.fraction || 0) * 100).toFixed(1)}%)

Marker genes ranked by the app:
${JSON.stringify(markerRows, null, 2)}

Task:
Suggest the most likely cell type or compartment for this cluster. Be cautious and practical.

Return valid JSON only:
{
  "cell_type": "full cell type name, not an abbreviation",
  "short_name": "2-8 character label for UMAP display",
  "confidence": "high|medium|low",
  "supporting_markers": ["gene1", "gene2", "gene3"],
  "rationale": "one short complete sentence",
  "validation": "one short marker or plot suggestion"
}

Rules:
- Do not invent markers that are not listed.
- Do not use unexplained abbreviations in cell_type. For example, write "proximal tubule" instead of "PT", "loop of Henle" instead of "LOH", and "kidney epithelial cell" instead of "Kid".
- short_name must be 2-8 characters with no spaces. Use standard single-cell abbreviations where known (PT, LOH, DCT, CD, Pod, EC, Fib, Mac, NK). Include subtype if relevant: PTS1, PTS2, PTS3, ICA, ICB, cTAL, mTAL. If tissue context is not kidney, adapt abbreviations to the tissue.
- The final cell_type must be a biological cell type or nephron segment, not just an organ name such as "kidney".
- Use phrases like "consistent with" or "likely" unless evidence is overwhelming.
- If the markers are ambiguous, set confidence to "low" and say why in rationale.
- Mention the key marker genes that support the label.
- Keep all JSON string values short.`;
}

function normalizeClusterAnnotation(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(extractBalancedJson(text));
    const cellType = String(parsed.cell_type || parsed.cellType || '').trim();
    const shortName = String(parsed.short_name || parsed.shortName || '').trim();
    const confidence = String(parsed.confidence || 'medium').trim();
    const markers = Array.isArray(parsed.supporting_markers)
      ? parsed.supporting_markers.filter(Boolean).slice(0, 8).join(', ')
      : '';
    const rationale = String(parsed.rationale || '').trim();
    const alternatives = Array.isArray(parsed.alternatives)
      ? parsed.alternatives.filter(Boolean).slice(0, 3).join(', ')
      : '';
    const validation = String(parsed.validation || '').trim();

    if (!cellType) return text;

    let message = `**Cell type:** ${cellType}\n\n**Short name:** ${shortName || cellType}\n\n**Confidence:** ${confidence}`;
    if (markers) message += `\n\n**Supporting markers:** ${markers}`;
    if (rationale) message += `\n\n**Rationale:** ${rationale}`;
    if (alternatives) message += `\n\n**Possible alternatives:** ${alternatives}`;
    if (validation) message += `\n\n**Validation:** ${validation}`;
    return message;
  } catch (error) {
    const partial = salvagePartialClusterAnnotation(text);
    if (partial) return partial;
    return text;
  }
}

function salvagePartialClusterAnnotation(text) {
  const source = String(text || '').trim();
  const cellType = source.match(/"cell_type"\s*:\s*"([^"]+)/)?.[1]?.trim();
  const confidence = source.match(/"confidence"\s*:\s*"([^"]+)/)?.[1]?.trim();
  const markerSection = source.match(/"supporting_markers"\s*:\s*\[([\s\S]*)/)?.[1] || '';
  const markers = Array.from(markerSection.matchAll(/"([^"]+)"/g))
    .map(match => match[1])
    .filter(Boolean)
    .slice(0, 8);

  if (!cellType) return null;

  let message = `**Cell type:** ${cellType}`;
  if (confidence) message += `\n\n**Confidence:** ${confidence}`;
  if (markers.length) message += `\n\n**Supporting markers:** ${markers.join(', ')}`;
  message += '\n\n**Note:** The annotation provider returned a truncated response, so CellPilot recovered the available label and markers. Re-running may fill in the rationale and validation suggestion.';
  return message;
}

async function requestOpenAIAnnotation(apiKey, clusterData, context) {
  const model = getAgentModel('chatgpt', 'gpt-5-mini');
  if (isOpenAIResponsesPreferredModel(model)) {
    const text = await requestOpenAIResponsesText(apiKey, {
      model,
      system: 'You are a cautious single-cell biology annotation assistant.',
      user: buildClusterAnnotationPrompt(clusterData, context),
      maxTokens: 5000,
      json: true,
    });
    return normalizeClusterAnnotation(text);
  }
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a cautious single-cell biology annotation assistant.' },
        { role: 'user', content: buildClusterAnnotationPrompt(clusterData, context) },
      ],
      response_format: { type: 'json_object' },
      ...getOpenAITokenParams(model, 5000),
      ...getOpenAITemperatureParams(model, 0.2),
      ...getOpenAIChatReasoningParams(model),
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return normalizeClusterAnnotation(data.choices?.[0]?.message?.content);
}

async function requestClaudeAnnotation(apiKey, clusterData, context) {
  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: getAgentModel('claude', 'claude-sonnet-4-20250514'),
      system: 'You are a cautious single-cell biology annotation assistant.',
      messages: [
        { role: 'user', content: buildClusterAnnotationPrompt(clusterData, context) },
      ],
      max_tokens: 5000,
      ...claudeTemperature(0.2),
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.content
    ?.filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim();
  return normalizeClusterAnnotation(text);
}

async function requestGeminiAnnotation(apiKey, clusterData, context) {
  const response = await fetch(getGeminiModelUrl(apiKey, getAgentModel('gemini', 'gemini-2.5-flash')), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: buildClusterAnnotationPrompt(clusterData, context) }],
      }],
      generationConfig: {
        maxOutputTokens: 5000,
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  return normalizeClusterAnnotation(data.candidates?.[0]?.content?.parts?.[0]?.text);
}

async function requestGroqAnnotation(apiKey, clusterData, context) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: getAgentModel('groq', GROQ_MODEL),
      messages: [
        { role: 'system', content: 'You are a cautious single-cell biology annotation assistant. Return valid JSON only.' },
        { role: 'user', content: buildClusterAnnotationPrompt(clusterData, context) },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 5000,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Groq API error: ${response.status}`);
  }

  const data = await response.json();
  return normalizeClusterAnnotation(data.choices?.[0]?.message?.content);
}

async function requestOpenRouterAnnotation(apiKey, clusterData, context) {
  const text = await requestOpenRouterChatContent(apiKey, {
    model: getAgentModel('openrouter', OPENROUTER_MODEL),
    system: 'You are a cautious single-cell biology annotation assistant. Return valid JSON only.',
    user: buildClusterAnnotationPrompt(clusterData, context),
    maxTokens: 5000,
    temperature: 0.2,
    json: true,
  });
  return normalizeClusterAnnotation(text);
}

export async function generateClusterAnnotation(provider, clusterData, context = {}) {
  const config = getApiConfig();
  const apiKey = config[provider]?.apiKey;
  if (!apiKey) {
    throw new Error(`${AGENT_PROVIDERS[provider] || provider} API key not configured`);
  }

  if (provider === 'chatgpt') {
    return requestOpenAIAnnotation(apiKey, clusterData, context);
  }
  if (provider === 'claude') {
    return requestClaudeAnnotation(apiKey, clusterData, context);
  }
  if (provider === 'gemini') {
    return requestGeminiAnnotation(apiKey, clusterData, context);
  }
  if (provider === 'groq') {
    return requestGroqAnnotation(apiKey, clusterData, context);
  }
  if (provider === 'openrouter') {
    return requestOpenRouterAnnotation(apiKey, clusterData, context);
  }
  throw new Error(`Unknown annotation provider: ${provider}`);
}

function buildBulkAnnotationPrompt(allClustersData, context = {}) {
  const clusterLines = allClustersData.map(c => {
    const label = c.clusterLabel || `Cluster ${c.cluster}`;
    const markers = (c.markers || [])
      .slice(0, 12)
      .map(m => {
        const fc = Number.isFinite(m.avg_logFC) ? m.avg_logFC.toFixed(2) : '';
        return fc ? `${m.gene}(${fc})` : m.gene;
      })
      .join(', ');
    return `${label}: ${markers}`;
  });

  return `You are CellPilot Agent, annotating multiple single-cell clusters at once.

Dataset context:
${JSON.stringify(context, null, 2)}

Annotate every cluster below using its top marker genes (sorted by log2 fold-change, descending).

Return ONLY valid JSON with this shape:
{
  "annotations": [
    {
      "cluster_id": 0,
      "cell_type": "full cell type name, not an abbreviation",
      "short_name": "2-8 character label for UMAP",
      "confidence": "high|medium|low",
      "supporting_markers": ["GENE1", "GENE2", "GENE3"],
      "rationale": "one short sentence"
    }
  ]
}

Rules:
- short_name: 2-8 chars, no spaces. Use standard abbreviations (PTS1, PTS2, PTS3, cTAL, mTAL, DCT, CD, Pod, EC, Fib, Mac, NK, ICA, ICB). Adapt to the tissue if not kidney.
- cell_type: full biological name, no unexplained abbreviations.
- supporting_markers: 2-5 key genes that drive the label. Only use genes listed for that cluster.
- Annotate EVERY cluster listed. Do not skip any.
- Keep all JSON string values concise.

Clusters:
${clusterLines.join('\n')}`;
}

function extractBalancedArray(text) {
  const source = String(text || '').trim();
  const start = source.indexOf('[');
  if (start < 0) return source;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

function salvageBulkAnnotation(text) {
  const items = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') { if (depth === 0) start = i; depth++; }
    if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { items.push(JSON.parse(text.slice(start, i + 1))); } catch {  }
        start = -1;
      }
    }
  }
  return items;
}

function normalizeBulkAnnotationItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];

  const candidates = [
    parsed.annotations,
    parsed.clusters,
    parsed.results,
    parsed.labels,
    parsed.data,
  ];
  const directArray = candidates.find(Array.isArray);
  if (directArray) return directArray;

  const numericValues = Object.entries(parsed)
    .filter(([key, value]) => /^\d+$/.test(key) && value && typeof value === 'object')
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([key, value]) => ({ cluster_id: key, ...value }));
  if (numericValues.length) return numericValues;

  if (parsed.cell_type || parsed.cellType || parsed.short_name || parsed.shortName) return [parsed];
  return [];
}

function normalizeBulkAnnotation(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(extractBalancedArray(text));
    } catch {
      parsed = salvageBulkAnnotation(text);
      if (!parsed.length) throw new Error('Could not parse annotation response, the model may have hit its output token limit. Try a smaller dataset or a paid API tier.');
    }
  }

  parsed = normalizeBulkAnnotationItems(parsed);
  if (!parsed.length) {
    parsed = salvageBulkAnnotation(text);
  }

  return parsed.map(item => ({
    clusterId: item.cluster_id ?? item.clusterId ?? null,
    cellType: String(item.cell_type || item.cellType || '').trim(),
    shortName: String(item.short_name || item.shortName || '').trim(),
    confidence: String(item.confidence || 'medium').trim(),
    markers: Array.isArray(item.supporting_markers)
      ? item.supporting_markers.filter(Boolean).slice(0, 8).join(', ')
      : '',
    rationale: String(item.rationale || '').trim(),
  }));
}

async function requestOpenAIBulkAnnotation(apiKey, allClustersData, context) {
  const model = getAgentModel('chatgpt', 'gpt-5-mini');
  if (isOpenAIResponsesPreferredModel(model)) {
    const text = await requestOpenAIResponsesText(apiKey, {
      model,
      system: 'You are a cautious single-cell biology annotation assistant.',
      user: buildBulkAnnotationPrompt(allClustersData, context),
      maxTokens: 20000,
      json: true,
    });
    return normalizeBulkAnnotation(text);
  }
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a cautious single-cell biology annotation assistant.' },
        { role: 'user', content: buildBulkAnnotationPrompt(allClustersData, context) },
      ],
      response_format: { type: 'json_object' },
      ...getOpenAITokenParams(model, 20000),
      ...getOpenAITemperatureParams(model, 0.2),
      ...getOpenAIChatReasoningParams(model),
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API error: ${response.status}`);
  }
  const data = await response.json();
  return normalizeBulkAnnotation(data.choices?.[0]?.message?.content);
}

async function requestClaudeBulkAnnotation(apiKey, allClustersData, context) {
  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: getAgentModel('claude', 'claude-sonnet-4-20250514'),
      system: 'You are a cautious single-cell biology annotation assistant.',
      messages: [
        { role: 'user', content: buildBulkAnnotationPrompt(allClustersData, context) },
      ],
      max_tokens: 8192,
      ...claudeTemperature(0.2),
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error: ${response.status}`);
  }
  const data = await response.json();
  const text = data.content?.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
  return normalizeBulkAnnotation(text);
}

async function requestGeminiBulkAnnotation(apiKey, allClustersData, context) {
  const response = await fetch(getGeminiModelUrl(apiKey, getAgentModel('gemini', 'gemini-2.5-flash')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildBulkAnnotationPrompt(allClustersData, context) }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.2 },
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini API error: ${response.status}`);
  }
  const data = await response.json();
  return normalizeBulkAnnotation(data.candidates?.[0]?.content?.parts?.[0]?.text);
}

async function requestGroqBulkAnnotation(apiKey, allClustersData, context) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: getAgentModel('groq', GROQ_MODEL),
      messages: [
        { role: 'system', content: 'You are a cautious single-cell biology annotation assistant. Return valid JSON array only.' },
        { role: 'user', content: buildBulkAnnotationPrompt(allClustersData, context) },
      ],
      max_tokens: 8192,
      temperature: 0.2,
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq API error: ${response.status}`);
  }
  const data = await response.json();
  return normalizeBulkAnnotation(data.choices?.[0]?.message?.content);
}

async function requestOpenRouterBulkAnnotation(apiKey, allClustersData, context) {
  const batchSize = 8;
  const batches = [];
  for (let i = 0; i < allClustersData.length; i += batchSize) {
    batches.push(allClustersData.slice(i, i + batchSize));
  }

  const annotations = [];
  for (const batch of batches) {
    const batchAnnotations = await requestOpenRouterBulkAnnotationBatch(apiKey, batch, context);
    annotations.push(...batchAnnotations);
  }
  return annotations;
}

async function requestOpenRouterBulkAnnotationBatch(apiKey, allClustersData, context) {
  const text = await requestOpenRouterChatContent(apiKey, {
    model: getAgentModel('openrouter', OPENROUTER_MODEL),
    system: 'You are a cautious single-cell biology annotation assistant. Return valid JSON only.',
    user: buildBulkAnnotationPrompt(allClustersData, context),
    maxTokens: 12000,
    temperature: 0.2,
    json: true,
  });
  try {
    return normalizeBulkAnnotation(text);
  } catch (error) {
    if (allClustersData.length <= 1) throw error;
    const midpoint = Math.ceil(allClustersData.length / 2);
    const first = await requestOpenRouterBulkAnnotationBatch(apiKey, allClustersData.slice(0, midpoint), context);
    const second = await requestOpenRouterBulkAnnotationBatch(apiKey, allClustersData.slice(midpoint), context);
    return [...first, ...second];
  }
}

export async function generateBulkClusterAnnotation(provider, allClustersData, context = {}) {
  const config = getApiConfig();
  const apiKey = config[provider]?.apiKey;
  if (!apiKey) {
    throw new Error(`${AGENT_PROVIDERS[provider] || provider} API key not configured`);
  }

  if (provider === 'chatgpt') return requestOpenAIBulkAnnotation(apiKey, allClustersData, context);
  if (provider === 'claude')  return requestClaudeBulkAnnotation(apiKey, allClustersData, context);
  if (provider === 'gemini')  return requestGeminiBulkAnnotation(apiKey, allClustersData, context);
  if (provider === 'groq')    return requestGroqBulkAnnotation(apiKey, allClustersData, context);
  if (provider === 'openrouter') return requestOpenRouterBulkAnnotation(apiKey, allClustersData, context);
  throw new Error(`Unknown annotation provider: ${provider}`);
}

function buildCellTypeMarkerPrompt(cellType, context = {}) {
  return `You are CellPilot Agent, helping choose marker genes for a single-cell cluster search.

Dataset context:
${JSON.stringify(context, null, 2)}

Requested cell type or compartment:
${cellType}

Task:
Return a small canonical marker panel that CellPilot can score against the loaded dataset. You are only choosing marker genes; you are not deciding whether this cell type exists in the dataset.

Return valid JSON only:
{
  "cell_type": "full cell type name, not an abbreviation",
  "markers": ["GeneA", "GeneB", "GeneC"],
  "excluded_markers": ["GeneX"],
  "rationale": "one short sentence explaining why these are useful markers",
  "ambiguity": "empty string, or one short note if the request is broad or ambiguous"
}

Rules:
- Return 4 to 8 positive marker gene symbols for the requested cell type.
- Use canonical mammalian gene symbols only. Do not include protein names, aliases, pathways, descriptions, or punctuation in markers.
- If you know a common marker as a protein/alias, convert it to the official gene symbol before returning it.
- Do not claim that this cell type exists in the current dataset.
- Do not use unexplained abbreviations in cell_type.
- The markers list must contain positive markers for the requested cell type only.
- Do not include genes whose primary use is identifying neighboring, related, contaminating, or commonly confused cell types.
- Do not include broad organ markers, generic epithelial/stromal/immune markers, cell-cycle genes, housekeeping genes, pathway genes, or functional genes that are not specific enough for cell identity.
- Before finalizing, perform this self-check for every marker: "Is this marker primarily associated with the requested cell type rather than a related alternative?" If no, remove it from markers and put it in excluded_markers.
- If the requested label is broad or anatomically ambiguous, choose the narrowest canonical interpretation that matches the words the user gave, and explain the ambiguity.
- If fewer than 4 specific positive markers are known, return fewer markers rather than padding with nonspecific or adjacent-cell markers.
- Keep all JSON string values short.`;
}

function normalizeCellTypeMarkers(rawText, fallbackCellType) {
  const text = String(rawText || '').trim();
  if (!text) {
    throw new Error('Marker provider returned an empty response');
  }

  const parsed = JSON.parse(extractBalancedJson(text));
  const markers = Array.isArray(parsed.markers)
    ? parsed.markers
      .map(marker => String(marker || '').trim())
      .filter(marker => /^[A-Za-z0-9_.-]+$/.test(marker))
      .slice(0, 12)
    : [];

  if (!markers.length) {
    throw new Error('Marker provider did not return usable gene symbols');
  }

  return {
    cellType: String(parsed.cell_type || parsed.cellType || fallbackCellType || 'requested cell type').trim(),
    markers,
    excludedMarkers: Array.isArray(parsed.excluded_markers)
      ? parsed.excluded_markers.map(marker => String(marker || '').trim()).filter(Boolean).slice(0, 12)
      : [],
    rationale: String(parsed.rationale || '').trim(),
    ambiguity: String(parsed.ambiguity || '').trim(),
    source: 'llm',
  };
}

function buildCellTypeMarkerRepairPrompt(rawText, parseError, cellType) {
  return `Repair this invalid marker-panel response into valid JSON only.

Requested cell type:
${cellType}

Parse error:
${parseError.message}

Required schema:
{
  "cell_type": "full cell type name",
  "markers": ["GeneA", "GeneB"],
  "excluded_markers": ["GeneX"],
  "rationale": "short sentence",
  "ambiguity": "short note or empty string"
}

Rules:
- Return only valid JSON. No markdown fences.
- markers and excluded_markers must contain gene symbols only.
- Do not add new markers unless they are specific positive markers for the requested cell type.

Invalid response:
${rawText}`;
}

function buildCellTypeMarkerReviewPrompt(cellType, context, markerInfo) {
  return `You are a strict single-cell marker panel reviewer.

Dataset context:
${JSON.stringify(context, null, 2)}

Requested cell type:
${cellType}

Proposed marker panel:
${JSON.stringify(markerInfo, null, 2)}

Task:
Review the proposed markers and return a corrected marker panel. Your main job is to REMOVE markers that are broad, functional/pathway-related, organ-general, or primarily associated with neighboring, related, contaminating, or commonly confused cell types.

Return valid JSON only:
{
  "cell_type": "full cell type name, not an abbreviation",
  "markers": ["GeneA", "GeneB"],
  "excluded_markers": ["GeneX"],
  "rationale": "one short sentence explaining why the kept markers are specific",
  "ambiguity": "empty string, or one short note if the request is broad or ambiguous"
}

Rules:
- Keep only specific positive markers for the requested cell type.
- It is better to return 2 or 3 specific markers than 6 mixed or nonspecific markers.
- Do not include genes mainly used for adjacent or commonly confused cell types.
- Put removed proposed markers in excluded_markers.
- Do not invent a dataset result.`;
}

async function requestCellTypeMarkerJson(provider, apiKey, prompt, maxTokens = 5000) {
  if (provider === 'chatgpt') {
    const model = getAgentModel('chatgpt', 'gpt-5-mini');
    if (isOpenAIResponsesPreferredModel(model)) {
      return requestOpenAIResponsesText(apiKey, {
        model,
        system: 'You choose cautious canonical marker genes for single-cell analysis. Return valid JSON only.',
        user: prompt,
        maxTokens,
        json: true,
      });
    }
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You choose cautious canonical marker genes for single-cell analysis. Return valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        ...getOpenAITokenParams(model, maxTokens),
        ...getOpenAITemperatureParams(model, 0),
        ...getOpenAIChatReasoningParams(model),
      }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content;
  }

  if (provider === 'claude') {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: getAgentModel('claude', 'claude-sonnet-4-20250514'),
        system: 'You choose cautious canonical marker genes for single-cell analysis. Return valid JSON only.',
        messages: [
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
        ...claudeTemperature(0),
      }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
    }
    const data = await response.json();
    return data.content
      ?.filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
      .trim();
  }

  if (provider === 'gemini') {
    const response = await fetch(getGeminiModelUrl(apiKey, getAgentModel('gemini', 'gemini-2.5-flash')), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }],
        }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text;
  }

  if (provider === 'groq') {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getAgentModel('groq', GROQ_MODEL),
        messages: [
          { role: 'system', content: 'You choose cautious canonical marker genes for single-cell analysis. Return valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: maxTokens,
        temperature: 0,
      }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Groq API error: ${response.status}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content;
  }

  if (provider === 'openrouter') {
    return requestOpenRouterChatContent(apiKey, {
      model: getAgentModel('openrouter', OPENROUTER_MODEL),
      system: 'You choose cautious canonical marker genes for single-cell analysis. Return valid JSON only.',
      user: prompt,
      maxTokens,
      temperature: 0,
      json: true,
    });
  }

  throw new Error(`Unknown marker provider: ${provider}`);
}

async function normalizeCellTypeMarkersWithRepair(provider, apiKey, rawText, fallbackCellType) {
  try {
    return normalizeCellTypeMarkers(rawText, fallbackCellType);
  } catch (parseError) {
    const repairedText = await requestCellTypeMarkerJson(
      provider,
      apiKey,
      buildCellTypeMarkerRepairPrompt(rawText, parseError, fallbackCellType),
      5000
    );
    return normalizeCellTypeMarkers(repairedText, fallbackCellType);
  }
}

async function reviewCellTypeMarkers(provider, apiKey, cellType, context, markerInfo) {
  const reviewedText = await requestCellTypeMarkerJson(
    provider,
    apiKey,
    buildCellTypeMarkerReviewPrompt(cellType, context, markerInfo),
    5000
  );
  const reviewed = await normalizeCellTypeMarkersWithRepair(provider, apiKey, reviewedText, markerInfo.cellType || cellType);
  const excluded = Array.from(new Set([
    ...(markerInfo.excludedMarkers || []),
    ...(reviewed.excludedMarkers || []),
    ...markerInfo.markers.filter(marker => !reviewed.markers.includes(marker)),
  ]));
  return {
    ...markerInfo,
    ...reviewed,
    excludedMarkers: excluded,
    rationale: reviewed.rationale || markerInfo.rationale,
    ambiguity: reviewed.ambiguity || markerInfo.ambiguity,
  };
}

async function requestOpenAICellTypeMarkers(apiKey, cellType, context) {
  const model = getAgentModel('chatgpt', 'gpt-5-mini');
  if (isOpenAIResponsesPreferredModel(model)) {
    const text = await requestOpenAIResponsesText(apiKey, {
      model,
      system: 'You choose cautious canonical marker genes for single-cell analysis. Return valid JSON only.',
      user: buildCellTypeMarkerPrompt(cellType, context),
      maxTokens: 5000,
      json: true,
    });
    return normalizeCellTypeMarkersWithRepair('chatgpt', apiKey, text, cellType);
  }
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You choose cautious canonical marker genes for single-cell analysis. Return valid JSON only.' },
        { role: 'user', content: buildCellTypeMarkerPrompt(cellType, context) },
      ],
      response_format: { type: 'json_object' },
      ...getOpenAITokenParams(model, 5000),
      ...getOpenAITemperatureParams(model, 0),
      ...getOpenAIChatReasoningParams(model),
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return normalizeCellTypeMarkersWithRepair('chatgpt', apiKey, data.choices?.[0]?.message?.content, cellType);
}

async function requestClaudeCellTypeMarkers(apiKey, cellType, context) {
  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: getAgentModel('claude', 'claude-sonnet-4-20250514'),
      system: 'You choose cautious canonical marker genes for single-cell analysis. Return valid JSON only.',
      messages: [
        { role: 'user', content: buildCellTypeMarkerPrompt(cellType, context) },
      ],
      max_tokens: 5000,
      ...claudeTemperature(0),
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.content
    ?.filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim();
  return normalizeCellTypeMarkersWithRepair('claude', apiKey, text, cellType);
}

async function requestGeminiCellTypeMarkers(apiKey, cellType, context) {
  const response = await fetch(getGeminiModelUrl(apiKey, getAgentModel('gemini', 'gemini-2.5-flash')), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: buildCellTypeMarkerPrompt(cellType, context) }],
      }],
      generationConfig: {
        maxOutputTokens: 5000,
        temperature: 0,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  return normalizeCellTypeMarkersWithRepair('gemini', apiKey, data.candidates?.[0]?.content?.parts?.[0]?.text, cellType);
}

async function requestGroqCellTypeMarkers(apiKey, cellType, context) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: getAgentModel('groq', GROQ_MODEL),
      messages: [
        { role: 'system', content: 'You choose cautious canonical marker genes for single-cell analysis. Return valid JSON only.' },
        { role: 'user', content: buildCellTypeMarkerPrompt(cellType, context) },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 5000,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Groq API error: ${response.status}`);
  }

  const data = await response.json();
  return normalizeCellTypeMarkersWithRepair('groq', apiKey, data.choices?.[0]?.message?.content, cellType);
}

async function requestOpenRouterCellTypeMarkers(apiKey, cellType, context) {
  const text = await requestOpenRouterChatContent(apiKey, {
    model: getAgentModel('openrouter', OPENROUTER_MODEL),
    system: 'You choose cautious canonical marker genes for single-cell analysis. Return valid JSON only.',
    user: buildCellTypeMarkerPrompt(cellType, context),
    maxTokens: 5000,
    temperature: 0,
    json: true,
  });
  return normalizeCellTypeMarkersWithRepair('openrouter', apiKey, text, cellType);
}

export async function generateCellTypeMarkers(provider, cellType, context = {}) {
  const config = getApiConfig();
  const apiKey = config[provider]?.apiKey;
  if (!apiKey) {
    throw new Error(`${AGENT_PROVIDERS[provider] || provider} API key not configured`);
  }

  let markerInfo = null;
  if (provider === 'chatgpt') {
    markerInfo = await requestOpenAICellTypeMarkers(apiKey, cellType, context);
  }
  if (provider === 'claude') {
    markerInfo = await requestClaudeCellTypeMarkers(apiKey, cellType, context);
  }
  if (provider === 'gemini') {
    markerInfo = await requestGeminiCellTypeMarkers(apiKey, cellType, context);
  }
  if (provider === 'groq') {
    markerInfo = await requestGroqCellTypeMarkers(apiKey, cellType, context);
  }
  if (provider === 'openrouter') {
    markerInfo = await requestOpenRouterCellTypeMarkers(apiKey, cellType, context);
  }
  if (markerInfo) {
    try {
      return await reviewCellTypeMarkers(provider, apiKey, cellType, context, markerInfo);
    } catch (reviewError) {
      console.warn('Marker panel review failed, using initial panel:', reviewError);
      return markerInfo;
    }
  }
  throw new Error(`Unknown marker provider: ${provider}`);
}

function summarizeToolResultForPrompt(result) {
  if (!result || typeof result !== 'object') return result;

  if (result.type === 'cluster_info') {
    return {
      type: result.type,
      cluster: result.cluster,
      cellCount: result.cellCount,
      totalCells: result.totalCells,
      fraction: result.fraction,
      topMarkers: (result.topMarkers || result.markers || []).slice(0, 15).map(marker => ({
        gene: marker.gene,
        pct_cluster: marker.pct1,
        pct_other: marker.pct2,
        logFC: marker.avg_logFC,
      })),
    };
  }

  if (result.type === 'cell_type_cluster_search') {
    return {
      type: result.type,
      requestedCellType: result.requestedCellType,
      interpretedCellType: result.interpretedCellType,
      markerSource: result.markerSource,
      resolvedMarkers: result.resolvedMarkers,
      missingMarkers: result.missingMarkers,
      hasConvincingCandidate: result.hasConvincingCandidate,
      candidateRankings: (result.candidateRankings || []).slice(0, 5).map(item => ({
        cluster: item.cluster,
        score: item.score,
        expressedMarkerCount: item.expressedMarkerCount,
        strongMarkerCount: item.strongMarkerCount,
        markerStats: (item.markerStats || []).slice(0, 6),
      })),
      highestWeakMatches: (result.rankings || []).slice(0, 3).map(item => ({
        cluster: item.cluster,
        expressedMarkerCount: item.expressedMarkerCount,
        strongestPct: item.strongestPct,
        markerStats: (item.markerStats || []).slice(0, 4),
      })),
    };
  }

  if (result.type === 'gene_expression') {
    return {
      type: result.type,
      gene: result.gene || result.geneName || result.resolvedGene,
      basis: result.basis || result.coordinateType || null,
      cellCount: result.cells?.length || result.coordinates?.length || result.expression?.length || null,
      expressionSummary: result.summary || result.dataSummary || null,
    };
  }

  if (result.type === 'markers') {
    return {
      type: result.type,
      cluster: result.cluster,
      comparison: result.comparison || null,
      selectedRegion: result.selectedRegion || null,
      clusterSize: result.clusterSize,
      totalGenes: result.totalGenes,
      topMarkers: (result.markers || []).slice(0, 15).map(marker => ({
        gene: marker.gene,
        pct_cluster: marker.pct1,
        pct_other: marker.pct2,
        logFC: marker.avg_logFC,
      })),
      structureEnrichment: result.structureEnrichment ? {
        available: !!result.structureEnrichment.available,
        method: result.structureEnrichment.method || null,
        source: result.structureEnrichment.source || null,
        reason: result.structureEnrichment.reason || null,
        collections: result.structureEnrichment.collections || [],
        topThemes: (result.structureEnrichment.themes || []).slice(0, 8).map(theme => ({
          term: theme.term,
          collection: theme.collection,
          adjustedPValue: theme.adjustedPValue,
          pValue: theme.pValue,
          overlapCount: theme.overlapCount,
          geneSetSize: theme.geneSetSize,
          overlapGenes: (theme.overlapGenes || []).slice(0, 12),
          relatedTerms: (theme.relatedTerms || []).slice(0, 4).map(term => term.term),
        })),
      } : null,
      pathwayEnrichment: result.pathwayEnrichment ? {
        available: !!result.pathwayEnrichment.available,
        method: result.pathwayEnrichment.method || null,
        source: result.pathwayEnrichment.source || null,
        reason: result.pathwayEnrichment.reason || null,
        collections: result.pathwayEnrichment.collections || [],
        topThemes: (result.pathwayEnrichment.themes || []).slice(0, 8).map(theme => ({
          term: theme.term,
          collection: theme.collection,
          adjustedPValue: theme.adjustedPValue,
          pValue: theme.pValue,
          overlapCount: theme.overlapCount,
          geneSetSize: theme.geneSetSize,
          overlapGenes: (theme.overlapGenes || []).slice(0, 12),
          relatedTerms: (theme.relatedTerms || []).slice(0, 4).map(term => term.term),
        })),
      } : null,
    };
  }

  if (result.type === 'spatial_cell_interaction') {
    return {
      type: result.type,
      method: result.method,
      regions: result.regions,
      summary: result.summary,
      significance: result.significance || null,
      lrDatabase: result.lrDatabase || null,
      topInteractions: (result.interactions || []).slice(0, 12).map(item => ({
        source: item.source,
        target: item.target,
        pair: item.pair,
        pathway: item.pathway,
        probability: item.probability,
        p_value: item.p_value,
        significant: item.significant,
        ligandPct: item.ligandPct,
        receptorPct: item.receptorPct,
      })),
      markerGenes: Object.fromEntries(Object.entries(result.markerGenes || {}).map(([region, markers]) => [
        region,
        (markers || []).slice(0, 12).map(marker => ({
          gene: marker.gene,
          logFC: marker.avg_logFC,
          pct_region: marker.pct1,
        })),
      ])),
    };
  }

  const safe = {};
  Object.entries(result).forEach(([key, value]) => {
    if (['expression', 'cells', 'coordinates', 'markers', 'rankings', 'data'].includes(key)) return;
    safe[key] = value;
  });
  return safe;
}

function buildAgentResultPrompt(userMessage, context = {}, toolHistory = []) {
  const compactHistory = toolHistory.map(item => ({
    action: item.action,
    parameters: item.parameters || {},
    result: summarizeToolResultForPrompt(item.result),
    roiImageAttached: !!parseDataUrl(item.roiImageDataUrl),
    error: item.error || null,
  }));
  const hasSpatialRegionMarkers = compactHistory.some(item =>
    item.action === 'spatial_region_markers' ||
    item.result?.comparison === 'selected_spatial_region_vs_other_cells'
  );
  const hasSpatialInteraction = compactHistory.some(item =>
    item.action === 'spatial_cell_interaction' ||
    item.result?.type === 'spatial_cell_interaction'
  );

  const spatialRegionRules = hasSpatialRegionMarkers ? `
Selected spatial region annotation rules:
- The user is asking what a drawn ROI is. Do not only restate cell counts or list markers; make a cautious biological judgement when the evidence supports one.
- Infer the likely anatomical structure, tissue domain, disease state, or enriched cell population from the enriched marker genes and the dataset context. Do not rely on organ-specific examples or prewritten marker-to-structure mappings from this prompt.
- If tissue/organ context is provided, use it to interpret marker specificity. If tissue/organ context is missing and the marker set could mean different things in different organs, explicitly ask the user to provide the tissue/organ instead of forcing a confident annotation.
- If the marker evidence is coherent, start with a short "Interpretation" sentence naming the most likely interpretation. If it is not coherent, start by saying the ROI is mixed or ambiguous.
- Explain the judgement using the observed top markers and their known biology. Mention which markers drive the call and whether they suggest a structure, a cell type, a state, or a mixture.
- If an ROI image is attached, combine the image morphology with the gene-marker evidence. Be explicit when the image supports, weakens, or is insufficient for the marker-based interpretation.
- If histology_image_loaded is true but no ROI image is attached, say the marker-based call should be interpreted together with the visible tissue morphology, but do not claim to inspect pixels.
- Include 4-8 top marker genes with concise rationale, then one cautious caveat if mixed cells, low cell count, organ ambiguity, or marker nonspecificity could affect the call.
- If structureEnrichment.topThemes is available, present it as "CellMarker 2024 enrichment" supporting evidence for the likely structure/cell-type identity, but do not let it override stronger canonical marker evidence.
- If pathwayEnrichment.topThemes is available, present it as "WikiPathways 2024 Human enrichment" with 3-6 nonredundant themes. Make clear that pathway terms describe biological programs, not anatomical identity.
- Keep structure/cell-type signature evidence separate from functional pathway evidence.
- For enriched terms, write compact bullets in the form: **Term name** (FDR 0.003): overlap genes; one short interpretation.
- Simplify long database names by removing prefixes like HALLMARK_, REACTOME_, and GOBP_ and replacing underscores with spaces.
` : '';
  const spatialInteractionRules = hasSpatialInteraction ? `
Spatial cell-cell interaction rules:
- Keep the UMAP/Analysis view focused on the interaction heatmap; do not ask to show marker tables there.
- Start with a short title and overview of interaction counts/pathways.
- Add an **Annotation** section before interpreting ligand-receptor pathways. In this section, annotate every selected region (Region 1, Region 2, etc.) from markerGenes and regions in the tool result.
- For each region annotation, infer the likely anatomical structure, tissue compartment, enriched cell population, or state using only that region's marker genes plus dataset context. Use cautious wording such as "consistent with" or "likely".
- For each region, include 2-5 marker genes that drive the call and a one-sentence rationale. If the marker evidence is mixed or insufficient, explicitly say the region is mixed/ambiguous rather than forcing a label.
- After **Annotation**, summarize the selected regions as CellChat-like communication groups for the interaction analysis.
- State the number of significant ligand-receptor interactions and signaling pathways from the tool result.
- Name the strongest pathways and the ligand-receptor pairs driving them, including source -> target direction, communication probability, and p_value when available.
- The tool now uses CellChat-style label permutation significance. If significance.method is present, describe it accurately: p_value is the fraction of permuted communication scores greater than the observed score, with nboot and threshold from the result.
- Mention that L-R candidates were generated from region marker genes filtered against the exported CellChatDB ligand-receptor database for the inferred species.
- Use this section order when possible: Overview, Annotation, Dominant Signaling Pathways, Strongest Ligand-Receptor Pairs, Regional Communication Summary, Caveat, Next step.
- Make the answer supplement-figure friendly: concise section headings, short paragraphs, and compact bullets. Avoid long single-line ligand-receptor entries; keep each interaction entry to one readable sentence.
- Preserve the scientific details from the tool result, but do not over-explain every marker. Prefer the strongest 3-5 markers per region and the top 8-10 interactions.
` : '';

  return `You are CellPilot Agent. The user asked:
${userMessage}

Dataset context:
${JSON.stringify(context, null, 2)}

CellPilot tool results:
${JSON.stringify(compactHistory, null, 2)}

Write the final user-facing answer.

Rules:
- Base the answer only on the tool results.
- Do not invent genes, clusters, plots, cell types, or statistics.
- If the evidence is weak or absent, say that clearly.
- For marker-based annotation, use cautious language such as "consistent with" or "likely".
- Keep the answer concise and practical.
- Do not use markdown tables. They render poorly in the CellPilot chat panel.
- Use this format for selected-region reports when applicable:
  Interpretation: one short sentence.
  Evidence: 3-6 bullets, each with bold marker/signature names and concise rationale.
  CellMarker 2024 enrichment: 0-4 bullets if structureEnrichment is available.
  WikiPathways 2024 Human enrichment: 0-5 bullets if pathwayEnrichment is available.
  Caveat: one short sentence.
  Next step: one concrete validation step.
- If a next step is useful, suggest one concrete next step.
${spatialRegionRules}
${spatialInteractionRules}`;
}

async function requestOpenAIResultSummary(apiKey, userMessage, context, toolHistory) {
  const model = getAgentModel('chatgpt', 'gpt-5-mini');
  const roiImage = getFirstRoiImage(toolHistory);
  const prompt = buildAgentResultPrompt(userMessage, context, toolHistory);
  if (isOpenAIResponsesPreferredModel(model) && !roiImage) {
    return requestOpenAIResponsesText(apiKey, {
      model,
      system: 'You summarize CellPilot analysis results accurately and cautiously.',
      user: prompt,
      maxTokens: AGENT_RESULT_SUMMARY_MAX_TOKENS,
    });
  }
  const userContent = roiImage
    ? [
        { type: 'text', text: `${prompt}\n\nAn ROI histology image crop is attached. Use it together with the marker results.` },
        { type: 'image_url', image_url: { url: roiImage.dataUrl, detail: 'high' } },
      ]
    : prompt;
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You summarize CellPilot analysis results accurately and cautiously.' },
        { role: 'user', content: userContent },
      ],
      ...getOpenAITokenParams(model, AGENT_RESULT_SUMMARY_MAX_TOKENS),
      ...getOpenAITemperatureParams(model, 0.2),
      ...getOpenAIChatReasoningParams(model),
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

async function requestClaudeResultSummary(apiKey, userMessage, context, toolHistory) {
  const roiImage = getFirstRoiImage(toolHistory);
  const prompt = buildAgentResultPrompt(userMessage, context, toolHistory);
  const userContent = roiImage
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: roiImage.mimeType,
            data: roiImage.base64,
          },
        },
        { type: 'text', text: `${prompt}\n\nAn ROI histology image crop is attached. Use it together with the marker results.` },
      ]
    : buildAgentResultPrompt(userMessage, context, toolHistory);
  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: getAgentModel('claude', 'claude-sonnet-4-20250514'),
      system: 'You summarize CellPilot analysis results accurately and cautiously.',
      messages: [
        { role: 'user', content: userContent },
      ],
      max_tokens: AGENT_RESULT_SUMMARY_MAX_TOKENS,
      ...claudeTemperature(0.2),
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content
    ?.filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim();
}

async function requestGeminiResultSummary(apiKey, userMessage, context, toolHistory) {
  const roiImage = getFirstRoiImage(toolHistory);
  const prompt = buildAgentResultPrompt(userMessage, context, toolHistory);
  const parts = roiImage
    ? [
        { text: `${prompt}\n\nAn ROI histology image crop is attached. Use it together with the marker results.` },
        {
          inlineData: {
            mimeType: roiImage.mimeType,
            data: roiImage.base64,
          },
        },
      ]
    : [{ text: prompt }];
  const response = await fetch(getGeminiModelUrl(apiKey, getAgentModel('gemini', 'gemini-2.5-flash')), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts,
      }],
      generationConfig: {
        maxOutputTokens: AGENT_RESULT_SUMMARY_MAX_TOKENS,
        temperature: 0.2,
      },
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text;
}

async function requestGroqResultSummary(apiKey, userMessage, context, toolHistory) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: getAgentModel('groq', GROQ_MODEL),
      messages: [
        { role: 'system', content: 'You summarize CellPilot analysis results accurately and cautiously.' },
        { role: 'user', content: buildAgentResultPrompt(userMessage, context, toolHistory) },
      ],
      max_tokens: AGENT_RESULT_SUMMARY_MAX_TOKENS,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Groq API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

async function requestOpenRouterResultSummary(apiKey, userMessage, context, toolHistory) {
  const roiImage = getFirstRoiImage(toolHistory);
  const prompt = buildAgentResultPrompt(userMessage, context, toolHistory);
  const userContent = roiImage
    ? [
        { type: 'text', text: `${prompt}\n\nAn ROI histology image crop is attached. Use it together with the marker results.` },
        { type: 'image_url', image_url: { url: roiImage.dataUrl, detail: 'high' } },
      ]
    : prompt;
  return requestOpenRouterChatContent(apiKey, {
    model: getAgentModel('openrouter', OPENROUTER_MODEL),
    system: 'You summarize CellPilot analysis results accurately and cautiously.',
    user: userContent,
    maxTokens: AGENT_RESULT_SUMMARY_MAX_TOKENS,
    temperature: 0.2,
  });
}

export async function generateAgentResultSummary(provider, userMessage, context = {}, toolHistory = []) {
  const config = getApiConfig();
  const apiKey = config[provider]?.apiKey;
  if (!apiKey) {
    throw new Error(`${AGENT_PROVIDERS[provider] || provider} API key not configured`);
  }

  if (provider === 'chatgpt') {
    return requestOpenAIResultSummary(apiKey, userMessage, context, toolHistory);
  }
  if (provider === 'claude') {
    return requestClaudeResultSummary(apiKey, userMessage, context, toolHistory);
  }
  if (provider === 'gemini') {
    return requestGeminiResultSummary(apiKey, userMessage, context, toolHistory);
  }
  if (provider === 'groq') {
    return requestGroqResultSummary(apiKey, userMessage, context, toolHistory);
  }
  if (provider === 'openrouter') {
    return requestOpenRouterResultSummary(apiKey, userMessage, context, toolHistory);
  }
  throw new Error(`Unknown result summary provider: ${provider}`);
}
