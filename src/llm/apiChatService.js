const API_CONFIG_KEY = 'cellpilot_api_config';
const EMPTY_API_CONFIG = {
  chatgpt: { apiKey: '', enabled: false, model: '' },
  claude: { apiKey: '', enabled: false, model: '' },
  gemini: { apiKey: '', enabled: false, model: '' },
  groq: { apiKey: '', enabled: false, model: '' },
  openrouter: { apiKey: '', enabled: false, model: '' }
};
let runtimeApiConfig = {
  chatgpt: { ...EMPTY_API_CONFIG.chatgpt },
  claude: { ...EMPTY_API_CONFIG.claude },
  gemini: { ...EMPTY_API_CONFIG.gemini },
  groq: { ...EMPTY_API_CONFIG.groq },
  openrouter: { ...EMPTY_API_CONFIG.openrouter }
};

const CHATGPT_API_URL = 'https://api.openai.com/v1/chat/completions';
const CHATGPT_RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CHATGPT_MODELS_API_URL = 'https://api.openai.com/v1/models';
const CLAUDE_MODELS_API_URL = 'https://api.anthropic.com/v1/models';
const GEMINI_MODELS_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_MODELS_API_URL = 'https://api.groq.com/openai/v1/models';
const OPENROUTER_MODELS_API_URL = 'https://openrouter.ai/api/v1/models';
export const PROVIDER_MODEL_CATALOG = {
  chatgpt: {
    defaultModel: 'gpt-5.2',
    docsUrl: 'https://platform.openai.com/docs/models',
    fallbackModels: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-pro', label: 'GPT-5.4 Pro' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
      { id: 'gpt-5.2', label: 'GPT-5.2' },
      { id: 'gpt-5.2-pro', label: 'GPT-5.2 Pro' },
      { id: 'gpt-5.2-chat-latest', label: 'GPT-5.2 Chat Latest' },
      { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
      { id: 'gpt-5-nano', label: 'GPT-5 Nano' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini' }
    ]
  },
  claude: {
    defaultModel: 'claude-opus-5-5',
    docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/all-models',
    fallbackModels: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }
    ]
  },
  gemini: {
    defaultModel: 'gemini-3-pro-preview',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models/gemini',
    fallbackModels: [
      { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite' }
    ]
  },
  groq: {
    defaultModel: 'llama-3.3-70b-versatile',
    docsUrl: 'https://console.groq.com/docs/models',
    fallbackModels: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
      { id: 'openai/gpt-oss-120b', label: 'OpenAI GPT OSS 120B' },
      { id: 'openai/gpt-oss-20b', label: 'OpenAI GPT OSS 20B' }
    ]
  },
  openrouter: {
    defaultModel: 'deepseek/deepseek-v4-pro',
    docsUrl: 'https://openrouter.ai/models',
    fallbackModels: [
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2' },
      { id: 'qwen/qwen3.6-max-preview', label: 'Qwen3.6 Max Preview' },
      { id: 'qwen/qwen3.6-flash', label: 'Qwen3.6 Flash' },
      { id: 'qwen/qwen3.6-35b-a3b', label: 'Qwen3.6 35B A3B' },
      { id: 'qwen/qwen3.6-27b', label: 'Qwen3.6 27B' },
      { id: 'qwen/qwen3.5-plus-20260420', label: 'Qwen3.5 Plus 2026-04-20' },
      { id: 'qwen/qwen3-max-thinking', label: 'Qwen3 Max Thinking' },
      { id: 'qwen/qwen3-coder-plus', label: 'Qwen3 Coder Plus' },
      { id: 'qwen/qwen3-coder-flash', label: 'Qwen3 Coder Flash' },
      { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder 480B A35B' },
      { id: '~moonshotai/kimi-latest', label: 'Kimi Latest' },
      { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
      { id: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5' },
      { id: 'z-ai/glm-5.1', label: 'GLM 5.1' },
      { id: 'z-ai/glm-5-turbo', label: 'GLM 5 Turbo' },
      { id: 'z-ai/glm-5', label: 'GLM 5' },
      { id: 'z-ai/glm-4.7', label: 'GLM 4.7' },
      { id: 'z-ai/glm-4.7-flash', label: 'GLM 4.7 Flash' },
      { id: 'minimax/minimax-m2.7', label: 'MiniMax M2.7' },
      { id: 'minimax/minimax-m2.5', label: 'MiniMax M2.5' },
      { id: 'baidu/cobuddy', label: 'Baidu CoBuddy' },
      { id: 'mistralai/mistral-small-2603', label: 'Mistral Small 4 (Europe)' },
      { id: 'qwen/qwen-2.5-72b-instruct', label: 'Qwen2.5 72B Instruct' }
    ]
  }
};

function normalizeModelOption(model) {
  const id = typeof model === 'string' ? model : (model?.id || model?.name || '');
  if (!id) return null;
  const cleanId = id.replace(/^models\//, '');
  const displayName = model?.displayName || model?.display_name || model?.label || cleanId;
  return { id: cleanId, label: displayName };
}

function dedupeModels(models) {
  const seen = new Set();
  return (models || [])
    .map(normalizeModelOption)
    .filter(Boolean)
    .filter(model => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
}

function filterModelsForProvider(provider, models) {
  const normalized = dedupeModels(models);
  if (provider === 'chatgpt') {
    return normalized.filter(model => /^(gpt|o[0-9]|chatgpt)/i.test(model.id));
  }
  if (provider === 'claude') {
    return normalized.filter(model => /^claude-/i.test(model.id));
  }
  if (provider === 'gemini') {
    return normalized.filter(model => /^gemini-/i.test(model.id));
  }
  if (provider === 'groq' || provider === 'openrouter') {
    return normalized;
  }
  return normalized;
}

export function getApiConfig() {
  try {
    localStorage.removeItem(API_CONFIG_KEY);
  } catch (error) {
    console.warn('Failed to clear persisted API config:', error);
  }
  return runtimeApiConfig;
}

export function saveApiConfig(config) {
  runtimeApiConfig = {
    chatgpt: { ...EMPTY_API_CONFIG.chatgpt, ...(config.chatgpt || {}) },
    claude: { ...EMPTY_API_CONFIG.claude, ...(config.claude || {}) },
    gemini: { ...EMPTY_API_CONFIG.gemini, ...(config.gemini || {}) },
    groq: { ...EMPTY_API_CONFIG.groq, ...(config.groq || {}) },
    openrouter: { ...EMPTY_API_CONFIG.openrouter, ...(config.openrouter || {}) }
  };
  try {
    localStorage.removeItem(API_CONFIG_KEY);
  } catch (error) {
    console.warn('Failed to clear persisted API config:', error);
  }
  return true;
}

export function setApiKey(provider, apiKey) {
  const config = getApiConfig();
  config[provider] = {
    ...(config[provider] || EMPTY_API_CONFIG[provider]),
    apiKey: apiKey.trim(),
    enabled: !!apiKey.trim(),
    model: config[provider]?.model || ''
  };
  return saveApiConfig(config);
}

export function setApiModel(provider, model) {
  const config = getApiConfig();
  config[provider] = {
    ...(config[provider] || EMPTY_API_CONFIG[provider]),
    model: String(model || '').trim()
  };
  return saveApiConfig(config);
}

export function getSelectedApiModel(provider) {
  const config = getApiConfig();
  return config[provider]?.model || PROVIDER_MODEL_CATALOG[provider]?.defaultModel || '';
}

export function getFallbackProviderModels(provider) {
  return PROVIDER_MODEL_CATALOG[provider]?.fallbackModels || [];
}

export function isOpenAINewChatModel(model) {
  return /^(gpt-([5-9]|\d{2,})|o[1-9])/i.test(String(model || ''));
}

export function isOpenAIResponsesPreferredModel(model) {
  return /^gpt-5(?:\.\d+)?-pro(?:-|$)/i.test(String(model || ''));
}

export function getOpenAITokenParams(model, maxTokens) {
  return isOpenAINewChatModel(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

export function getOpenAITemperatureParams(model, temperature) {
  return isOpenAINewChatModel(model) ? {} : { temperature };
}

export function claudeAcceptsTemperature(model) {
  const id = String(model || '').toLowerCase().trim();
  if (/^claude-3/.test(id)) return true;
  return /^claude-(opus|sonnet|haiku)-4(-[0-6])?(-\d{8})?$/.test(id);
}

export function getClaudeTemperatureParams(model, temperature) {
  return claudeAcceptsTemperature(model) ? { temperature } : {};
}

export function getOpenAIReasoningEffort(model) {
  return isOpenAIResponsesPreferredModel(model) ? 'medium' : 'low';
}

export function getOpenAIChatReasoningParams(model) {
  return isOpenAINewChatModel(model)
    ? { reasoning_effort: getOpenAIReasoningEffort(model) }
    : {};
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

async function generateOpenAIResponsesText(apiKey, model, systemPrompt, userMessage, maxTokens) {
  const response = await fetch(CHATGPT_RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      instructions: systemPrompt,
      input: userMessage,
      max_output_tokens: maxTokens,
      ...(isOpenAINewChatModel(model) ? { reasoning: { effort: getOpenAIReasoningEffort(model) } } : {})
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `API error: ${response.status}`);
  }

  return extractOpenAIResponsesText(await response.json());
}

export function formatProviderModelOptions(provider, models) {
  const fallback = getFallbackProviderModels(provider);
  const merged = dedupeModels([...fallback, ...(models || [])]);
  return merged.length ? merged : fallback;
}

export async function fetchProviderModels(provider, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return getFallbackProviderModels(provider);

  let response;
  if (provider === 'chatgpt') {
    response = await fetch(CHATGPT_MODELS_API_URL, {
      headers: { 'Authorization': `Bearer ${key}` }
    });
  } else if (provider === 'claude') {
    response = await fetch(CLAUDE_MODELS_API_URL, {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      }
    });
  } else if (provider === 'gemini') {
    response = await fetch(`${GEMINI_MODELS_API_URL}?key=${key}`);
  } else if (provider === 'groq') {
    response = await fetch(GROQ_MODELS_API_URL, {
      headers: { 'Authorization': `Bearer ${key}` }
    });
  } else if (provider === 'openrouter') {
    response = await fetch(OPENROUTER_MODELS_API_URL, {
      headers: { 'Authorization': `Bearer ${key}` }
    });
  } else {
    return [];
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Could not fetch models: ${response.status}`);
  }

  const data = await response.json();
  const rawModels = data.data || data.models || [];
  const modelOptions = filterModelsForProvider(provider, rawModels);
  return formatProviderModelOptions(provider, modelOptions);
}

export function isApiConfigured(provider) {
  const config = getApiConfig();
  return config[provider]?.enabled && !!config[provider]?.apiKey;
}

export async function generateChatGPTResponse(userMessage, context = {}) {
  const config = getApiConfig();
  const apiKey = config.chatgpt?.apiKey;

  if (!apiKey) {
    throw new Error('ChatGPT API key not configured');
  }

  try {
    const systemPrompt = buildSystemPrompt(context);

    const selectedModel = getSelectedApiModel('chatgpt');
    const modelNames = [selectedModel, 'gpt-5-nano', 'gpt-5-mini', 'gpt-5.2-chat-latest', 'gpt-4o']
      .filter(Boolean)
      .filter((model, index, all) => all.indexOf(model) === index);
    let lastError = null;

    for (const modelName of modelNames) {
      try {
        if (isOpenAIResponsesPreferredModel(modelName)) {
          const text = await generateOpenAIResponsesText(apiKey, modelName, systemPrompt, userMessage, 500);
          if (text) {
            console.log(`Successfully used ChatGPT model via Responses API: ${modelName}`);
            return text;
          }
          throw new Error('No response from ChatGPT API');
        }

        const response = await fetch(CHATGPT_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage }
            ],
            ...getOpenAITokenParams(modelName, 5000),
            ...getOpenAITemperatureParams(modelName, 0.7),
            ...getOpenAIChatReasoningParams(modelName)
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMsg = errorData.error?.message || `API error: ${response.status}`;
          
          if ((errorMsg.includes('not found') || errorMsg.includes('does not exist') || response.status === 404) && 
              modelNames.indexOf(modelName) < modelNames.length - 1) {
            console.log(`Model ${modelName} not found, trying next model...`);
            lastError = new Error(errorMsg);
            continue;
          }
          
          throw new Error(errorMsg);
        }

        const data = await response.json();
        const text = data.choices[0]?.message?.content || null;
        
        if (text) {
          console.log(`Successfully used ChatGPT model: ${modelName}`);
          return text;
        }
        
        throw new Error('No response from ChatGPT API');
      } catch (error) {
        if (modelName === modelNames[modelNames.length - 1]) {
          throw error;
        }
        lastError = error;
        continue;
      }
    }

    throw lastError || new Error('All ChatGPT models failed');

  } catch (error) {
    console.error('ChatGPT API error:', error);
    throw error;
  }
}

export async function generateClaudeResponse(userMessage, context = {}) {
  const config = getApiConfig();
  const apiKey = config.claude?.apiKey;

  if (!apiKey) {
    throw new Error('Claude API key not configured');
  }

  try {
    const systemPrompt = buildSystemPrompt(context);
    const selectedModel = getSelectedApiModel('claude');
    const modelNames = [selectedModel, 'claude-opus-5-5', 'claude-sonnet-5-5']
      .filter(Boolean)
      .filter((model, index, all) => all.indexOf(model) === index);
    let lastError = null;

    for (const modelName of modelNames) {
      try {
        const response = await fetch(CLAUDE_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          body: JSON.stringify({
            model: modelName,
            system: systemPrompt,
            messages: [
              { role: 'user', content: userMessage }
            ],
            max_tokens: 5000,
            ...getClaudeTemperatureParams(modelName, 0.7)
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMsg = errorData.error?.message || `API error: ${response.status}`;
          if ((errorMsg.includes('not found') || errorMsg.includes('does not exist') || response.status === 404) &&
              modelNames.indexOf(modelName) < modelNames.length - 1) {
            lastError = new Error(errorMsg);
            continue;
          }
          throw new Error(errorMsg);
        }

        const data = await response.json();
        const text = data.content
          ?.filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n')
          .trim();

        if (text) {
          console.log(`Successfully used Claude model: ${modelName}`);
          return text;
        }

        throw new Error('No response from Claude API');
      } catch (error) {
        if (modelName === modelNames[modelNames.length - 1]) {
          throw error;
        }
        lastError = error;
      }
    }

    throw lastError || new Error('All Claude models failed');
  } catch (error) {
    console.error('Claude API error:', error);
    throw error;
  }
}

export async function generateGeminiResponse(userMessage, context = {}) {
  const config = getApiConfig();
  const apiKey = config.gemini?.apiKey;

  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  try {
    const systemPrompt = buildSystemPrompt(context);

    const selectedModel = getSelectedApiModel('gemini');
    const modelNames = [
      selectedModel,
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-1.5-flash',
      'gemini-1.5-pro',
      'gemini-pro'
    ].filter(Boolean).filter((model, index, all) => all.indexOf(model) === index);
    let lastError = null;

    for (const modelName of modelNames) {
      try {
        const url = `${GEMINI_API_URL}/${modelName}:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: `${systemPrompt}\n\nUser: ${userMessage}\n\nAssistant:` }
              ]
            }],
            generationConfig: {
              maxOutputTokens: 5000,
              temperature: 0.7
            }
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMsg = errorData.error?.message || `API error: ${response.status}`;
          
          if (errorMsg.includes('Quota exceeded') || errorMsg.includes('quota') || errorMsg.includes('limit: 0')) {
            const retryMatch = errorMsg.match(/Please retry in ([\d.]+)s/);
            const retrySeconds = retryMatch ? parseFloat(retryMatch[1]) : 60;
            
            if (modelName === modelNames[modelNames.length - 1]) {
              throw new Error(
                `**Gemini API Quota Exceeded**\n\n` +
                `Your free tier quota has been reached (limit: 0 requests).\n\n` +
                `Options:\n` +
                `1. Wait ${Math.ceil(retrySeconds)} seconds and try again\n` +
                `2. Check your usage: https://ai.dev/rate-limit\n` +
                `3. Upgrade your API plan at https://ai.google.dev/pricing\n` +
                `4. Use ChatGPT API instead (configure in Model section)`
              );
            }
            
            console.log(`Quota exceeded for ${modelName}, waiting ${Math.ceil(retrySeconds)}s before trying next model...`);
            await new Promise(resolve => setTimeout(resolve, Math.ceil(retrySeconds * 1000)));
            lastError = new Error(`Quota exceeded on ${modelName}`);
            continue;
          }
          
          if (response.status === 429) {
            console.log(`Rate limit hit for ${modelName}, waiting 2 seconds before trying next model...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (modelNames.indexOf(modelName) < modelNames.length - 1) {
              lastError = new Error(`Rate limited on ${modelName}, trying next model...`);
              continue;
            }
          }
          
          if ((errorMsg.includes('not found') || response.status === 404) && 
              modelNames.indexOf(modelName) < modelNames.length - 1) {
            console.log(`Model ${modelName} not found, trying next model...`);
            lastError = new Error(errorMsg);
            continue;
          }
          
          throw new Error(errorMsg);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!text) {
          throw new Error('No response from Gemini API');
        }
        
        console.log(`Successfully used Gemini model: ${modelName}`);
        return text;
      } catch (error) {
        if (modelName === modelNames[modelNames.length - 1]) {
          throw error;
        }
        lastError = error;
        continue;
      }
    }

    throw lastError || new Error('All Gemini models failed');

  } catch (error) {
    console.error('Gemini API error:', error);
    throw error;
  }
}

export async function generateGroqResponse(userMessage, context = {}) {
  const config = getApiConfig();
  const apiKey = config.groq?.apiKey;

  if (!apiKey) {
    throw new Error('Groq API key not configured');
  }

  try {
    const systemPrompt = buildSystemPrompt(context);
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: getSelectedApiModel('groq') || 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 5000,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Groq API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || null;
    if (!text) {
      throw new Error('No response from Groq API');
    }
    return text;
  } catch (error) {
    console.error('Groq API error:', error);
    throw error;
  }
}

export async function generateOpenRouterResponse(userMessage, context = {}) {
  const config = getApiConfig();
  const apiKey = config.openrouter?.apiKey;

  if (!apiKey) {
    throw new Error('OpenRouter API key not configured');
  }

  try {
    const systemPrompt = buildSystemPrompt(context);
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: getSelectedApiModel('openrouter') || PROVIDER_MODEL_CATALOG.openrouter.defaultModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 5000,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || null;
    if (!text) {
      throw new Error('No response from OpenRouter API');
    }
    return text;
  } catch (error) {
    console.error('OpenRouter API error:', error);
    throw error;
  }
}

function buildSystemPrompt(context = {}) {
  let prompt = `You are CellPilot, an AI assistant specialized in single-cell RNA sequencing (scRNA-seq) analysis. You help researchers analyze their single-cell data.

Your main capabilities include:
- Clustering cells and running UMAP visualization
- Finding marker genes for clusters (differentially expressed genes)
- Plotting gene expression on UMAP
- Creating violin plots and dot plots for genes
- Running quality control (QC) analysis
- Renaming clusters with biological cell type labels
- Adjusting analysis parameters (resolution, HVGs, filtering thresholds)
- Answering general biology questions about genes, cell types, pathways, and biological processes

You have access to general biological knowledge and can answer questions about:
- Gene functions and roles
- Cell type characteristics and markers
- Biological pathways and processes
- Tissue-specific expression patterns
- Protein functions and interactions

For questions about scRNA-seq analysis tasks (plotting, clustering, finding markers), guide the user on how to phrase their request. For general biology questions, provide helpful, accurate information based on your knowledge.

Keep responses concise (2-4 sentences for simple questions, up to a paragraph for complex topics) and helpful.`;

  if (context.clusters && context.clusters.length > 0) {
    prompt += `\n\nCurrent data context: The user has ${context.totalCells || 'unknown'} cells in ${context.clusters.length} clusters.`;
    if (context.clusterLabels && Object.keys(context.clusterLabels).length > 0) {
      const labels = Object.entries(context.clusterLabels)
        .map(([id, name]) => `${id}: ${name}`)
        .join(', ');
      prompt += ` Cluster labels: ${labels}.`;
    }
  }

  return prompt;
}

export async function generateApiChatResponse(provider, userMessage, context = {}) {
  if (provider === 'chatgpt') {
    return await generateChatGPTResponse(userMessage, context);
  } else if (provider === 'claude') {
    return await generateClaudeResponse(userMessage, context);
  } else if (provider === 'gemini') {
    return await generateGeminiResponse(userMessage, context);
  } else if (provider === 'groq') {
    return await generateGroqResponse(userMessage, context);
  } else if (provider === 'openrouter') {
    return await generateOpenRouterResponse(userMessage, context);
  } else {
    throw new Error(`Unknown API provider: ${provider}`);
  }
}

export async function testApiConnection(provider) {
  try {
    const testMessage = 'Hello';
    await generateApiChatResponse(provider, testMessage, {});
    return true;
  } catch (error) {
    console.error(`API test failed for ${provider}:`, error);
    return false;
  }
}

const apiChatService = {
  getApiConfig,
  saveApiConfig,
  setApiKey,
  setApiModel,
  getSelectedApiModel,
  getFallbackProviderModels,
  fetchProviderModels,
  isApiConfigured,
  generateChatGPTResponse,
  generateClaudeResponse,
  generateGeminiResponse,
  generateGroqResponse,
  generateOpenRouterResponse,
  generateApiChatResponse,
  testApiConnection
};

export default apiChatService;
