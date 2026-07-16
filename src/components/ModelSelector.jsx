import React, { useState, useEffect } from 'react';
import { Button, HTMLSelect, Icon, Spinner, ProgressBar, Tag, Collapse } from '@blueprintjs/core';
import './ModelSelector.css';
import {
  downloadModel,
  isModelLoaded,
  getCurrentModel,
  checkWebLLMAvailable,
  checkWebGPUAvailable,
  downloadChatModel,
  isChatModelLoaded,
  getCurrentChatModel,
} from '../llm/webllmService';

// Embedding models for intent classification (fast, small)
const EMBEDDING_MODELS = [
  {
    id: 'all-minilm-l6',
    name: 'MiniLM-L6 (Fast)',
    size: '~22MB',
    description: 'Ultra-fast semantic search model (Recommended)'
  },
  {
    id: 'bge-small',
    name: 'BGE Small',
    size: '~33MB',
    description: 'Better accuracy, slightly larger'
  },
  {
    id: 'gte-small',
    name: 'GTE Small',
    size: '~33MB',
    description: 'Excellent quality embeddings'
  },
];

// Chat models for conversational responses
const CHAT_MODELS = [
  // Local WebLLM models (requires WebGPU)
  {
    id: 'qwen2.5-1.5b',
    name: 'Qwen2.5 1.5B (Local)',
    size: '~1GB',
    description: 'High quality responses, requires WebGPU',
    isApi: false
  },
  {
    id: 'qwen2.5-0.5b',
    name: 'Qwen2.5 0.5B (Local)',
    size: '~500MB',
    description: 'Faster, smaller model',
    isApi: false
  },
  {
    id: 'llama-3.2-1b',
    name: 'Llama 3.2 1B (Local)',
    size: '~700MB',
    description: 'Good quality, Meta model',
    isApi: false
  },
  {
    id: 'smollm2-360m',
    name: 'SmolLM2 360M (Local)',
    size: '~360MB',
    description: 'Ultra-fast, limited capability',
    isApi: false
  },
];

const ModelSelector = ({ selectedModel, onModelChange, onModelLoaded, selectedChatModel, onChatModelChange, onChatModelLoaded }) => {
  // Embedding model state
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [webllmAvailable, setWebllmAvailable] = useState(true);
  const [statusMessage, setStatusMessage] = useState('');

  // Chat model state
  const [chatDownloading, setChatDownloading] = useState(false);
  const [chatDownloadProgress, setChatDownloadProgress] = useState(0);
  const [chatModelReady, setChatModelReady] = useState(false);
  const [webgpuAvailable, setWebgpuAvailable] = useState(false);
  const [chatStatusMessage, setChatStatusMessage] = useState('');
  const [showChatSection, setShowChatSection] = useState(false);
  
  // Check availability on mount
  useEffect(() => {
    // Check embedding model availability
    checkWebLLMAvailable().then(available => {
      setWebllmAvailable(available);
      if (!available) {
        setStatusMessage('WebLLM not supported in this browser');
      }
    });

    // Check WebGPU availability for chat models
    checkWebGPUAvailable().then(available => {
      setWebgpuAvailable(available);
      if (!available) {
        setChatStatusMessage('WebGPU not available (required for chat)');
      }
    });

    // Check if embedding model is already loaded
    if (isModelLoaded()) {
      setModelReady(true);
      setStatusMessage(`Model ready: ${getCurrentModel()}`);
    }

    // Check if chat model is already loaded
    if (isChatModelLoaded()) {
      setChatModelReady(true);
      setChatStatusMessage(`Chat model ready: ${getCurrentChatModel()}`);
    }
  }, []);

  const handleModelChange = (e) => {
    onModelChange(e.target.value);
    // Reset status when model changes
    if (getCurrentModel() !== e.target.value) {
      setModelReady(false);
      setStatusMessage('');
    }
  };

  const handleChatModelChange = async (e) => {
    const newModelId = e.target.value;
    if (onChatModelChange) {
      onChatModelChange(newModelId);
    }
    
    // Reset status when model changes
    if (getCurrentChatModel() !== newModelId) {
      setChatModelReady(false);
      setChatStatusMessage('');
    }
  };

  const handleDownload = async () => {
    if (!webllmAvailable) {
      alert('WebLLM is not supported in this browser. Please use Chrome or Edge with WebGPU support.');
      return;
    }

    setDownloading(true);
    setDownloadProgress(0);
    setStatusMessage('Initializing download...');

    try {
      const model = EMBEDDING_MODELS.find(m => m.id === selectedModel);

      if (!model) {
        alert('Invalid model selected');
        return;
      }

      setStatusMessage(`Downloading ${model.name}...`);

      // Actually download the model using WebLLM service
      const success = await downloadModel(selectedModel, (progress) => {
        setDownloadProgress(progress);
        if (progress < 100) {
          setStatusMessage(`Downloading: ${progress}%`);
        }
      });

      if (success) {
        setModelReady(true);
        setStatusMessage(`${model.name} ready!`);

        // Notify parent that model is loaded
        if (onModelLoaded) {
          onModelLoaded(selectedModel);
        }
      } else {
        setStatusMessage('Download failed. Try a smaller model.');
        alert('Failed to download model. The model may be too large for your browser. Try a smaller model.');
      }
    } catch (error) {
      console.error('Download error:', error);
      setStatusMessage(`Error: ${error.message}`);
      alert(`Failed to download model: ${error.message}`);
    } finally {
      setDownloading(false);
    }
  };

  const handleChatDownload = async () => {
    const model = CHAT_MODELS.find(m => m.id === selectedChatModel);
    if (!model) {
      alert('Invalid chat model selected');
      return;
    }

    // Handle local WebLLM models
    if (!webgpuAvailable) {
      alert('WebGPU is not available in this browser. Local chat models require WebGPU support (Chrome 113+ or Edge 113+).');
      return;
    }

    setChatDownloading(true);
    setChatDownloadProgress(0);
    setChatStatusMessage('Initializing chat model download...');

    try {
      setChatStatusMessage(`Downloading ${model.name}...`);

      const success = await downloadChatModel(selectedChatModel, (progress) => {
        setChatDownloadProgress(progress);
        if (progress < 100) {
          setChatStatusMessage(`Loading: ${progress}%`);
        }
      });

      if (success) {
        setChatModelReady(true);
        setChatStatusMessage(`${model.name} ready!`);

        if (onChatModelLoaded) {
          onChatModelLoaded(selectedChatModel);
        }
      } else {
        setChatStatusMessage('Download failed. WebGPU may not be fully supported.');
        alert('Failed to download chat model. Make sure WebGPU is enabled and try a smaller model.');
      }
    } catch (error) {
      console.error('Chat model download error:', error);
      setChatStatusMessage(`Error: ${error.message}`);
      alert(`Failed to download chat model: ${error.message}`);
    } finally {
      setChatDownloading(false);
    }
  };

  const selectedModelInfo = EMBEDDING_MODELS.find(m => m.id === selectedModel);
  const selectedChatModelInfo = CHAT_MODELS.find(m => m.id === selectedChatModel);

  return (
    <div className="model-selector">
      {/* Embedding Model Selection Section */}
      <div className="model-selector-section">
        <div className="model-selector-row">
          <label className="model-selector-label">
            <Icon icon={modelReady ? 'tick-circle' : 'cloud'} size={14} />
            <span>Intent Model</span>
          </label>

          <HTMLSelect
            value={selectedModel}
            onChange={handleModelChange}
            disabled={downloading}
            className="model-select"
            fill
          >
            {EMBEDDING_MODELS.map(model => (
              <option key={model.id} value={model.id}>
                {model.name} ({model.size})
              </option>
            ))}
          </HTMLSelect>

          <Button
            icon={downloading ? <Spinner size={16} /> : (modelReady ? 'tick' : 'download')}
            text={downloading ? `${downloadProgress}%` : (modelReady ? 'Ready' : 'Download')}
            onClick={handleDownload}
            disabled={downloading || modelReady}
            intent={modelReady ? 'success' : 'primary'}
            className="model-download-btn"
          />
        </div>

        {/* Download progress bar */}
        {downloading && (
          <div className="model-progress">
            <ProgressBar
              value={downloadProgress / 100}
              intent="primary"
              stripes={downloadProgress < 100}
              animate={downloadProgress < 100}
            />
          </div>
        )}

        {/* Status message */}
        {statusMessage && (
          <div className={`model-status ${modelReady ? 'model-status-success' : ''}`}>
            <Icon icon={modelReady ? 'tick-circle' : 'info-sign'} size={11} />
            <span>{statusMessage}</span>
          </div>
        )}

        {/* Model description */}
        {selectedModelInfo && !downloading && !statusMessage && (
          <div className="model-info">
            <Icon icon="info-sign" size={11} />
            <span>{selectedModelInfo.description}</span>
          </div>
        )}
      </div>

      {/* Chat Model Section (Collapsible) */}
      <div className="model-selector-section chat-section">
        <div
          className="chat-section-header"
          onClick={() => setShowChatSection(!showChatSection)}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <Icon icon={showChatSection ? 'chevron-down' : 'chevron-right'} size={12} />
          <span style={{ fontSize: '12px', fontWeight: 500 }}>
            Chat Model (Optional)
          </span>
          {chatModelReady && <Tag minimal intent="success" style={{ fontSize: '10px' }}>Ready</Tag>}
          {!webgpuAvailable && <Tag minimal intent="warning" style={{ fontSize: '10px' }}>No WebGPU</Tag>}
        </div>

        <Collapse isOpen={showChatSection}>
          <div style={{ marginTop: '8px' }}>
            <div className="model-selector-row">
              <label className="model-selector-label">
                <Icon icon={chatModelReady ? 'tick-circle' : 'chat'} size={14} />
                <span>Chat</span>
              </label>

              <HTMLSelect
                value={selectedChatModel || 'chatgpt'}
                onChange={handleChatModelChange}
                disabled={chatDownloading}
                className="model-select"
                fill
              >
                {CHAT_MODELS.map(model => (
                  <option key={model.id} value={model.id} disabled={!webgpuAvailable}>
                    {model.name} ({model.size})
                  </option>
                ))}
              </HTMLSelect>

              <Button
                icon={chatDownloading ? <Spinner size={16} /> : (chatModelReady ? 'tick' : 'download')}
                text={chatDownloading ? `${chatDownloadProgress}%` : (chatModelReady ? 'Ready' : 'Download')}
                onClick={handleChatDownload}
                disabled={chatDownloading || chatModelReady}
                intent={chatModelReady ? 'success' : 'primary'}
                className="model-download-btn"
              />
            </div>

            {/* Chat download progress bar */}
            {chatDownloading && (
              <div className="model-progress">
                <ProgressBar
                  value={chatDownloadProgress / 100}
                  intent="primary"
                  stripes={chatDownloadProgress < 100}
                  animate={chatDownloadProgress < 100}
                />
              </div>
            )}

            {/* Chat status message */}
            {chatStatusMessage && (
              <div className={`model-status ${chatModelReady ? 'model-status-success' : ''}`}>
                <Icon icon={chatModelReady ? 'tick-circle' : 'info-sign'} size={11} />
                <span>{chatStatusMessage}</span>
              </div>
            )}

            {/* Chat model description */}
            {selectedChatModelInfo && !chatDownloading && !chatStatusMessage && (
              <div className="model-info">
                <Icon icon="info-sign" size={11} />
                <span>{selectedChatModelInfo.description}</span>
              </div>
            )}

            {/* WebGPU not available message (only for local models) */}
            {!webgpuAvailable && !chatStatusMessage && selectedChatModelInfo && (
              <div className="model-info" style={{ color: '#bf7326' }}>
                <Icon icon="warning-sign" size={11} />
                <span>Local chat models require WebGPU (Chrome 113+ or Edge 113+). For API agent mode, ask in chat: "switch to agent mode".</span>
              </div>
            )}
          </div>
        </Collapse>
      </div>
    </div>
  );
};

export default ModelSelector;
