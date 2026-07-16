# CellPilot

https://github.com/user-attachments/assets/39fd7834-2d85-4b4c-bbce-f617393a6f9a

CellPilot is a serverless, AI-powered desktop application for chat-based single-cell and spatial transcriptomics analysis. It runs entirely on your local machine. No server or data upload required.

**Supported data types:** scRNA-seq · scATAC-seq · Multiome · Spatial (Visium, Visium HD, Xenium, MERFISH, CosMx)

**AI backends:** Local models via WebLLM or Ollama · OpenAI · Anthropic Claude · Google Gemini · Groq · OpenRouter 

---

## For non-developers

Download the pre-built desktop app at **[cellpilot.humphreyslab.com](https://cellpilot.humphreyslab.com)**

---

https://github.com/user-attachments/assets/fb472649-4190-47d6-9302-bd6af364671c

## For developers

### Requirements

- Node.js 18+ and npm
- (macOS only, for packaging) Xcode Command Line Tools

### Install

```bash
npm install
```

### Run in development mode

```bash
npm run electron-dev
```

This starts the React dev server and Electron together. Hot-reload is enabled for the frontend.

### Run production build locally

```bash
npm run build
npm run electron
```

https://github.com/user-attachments/assets/c85f2b02-187c-47f5-b6d8-ec844103df2f

### Package as a desktop app

**macOS (Apple Silicon):**
```bash
npm run dist:mac-arm
```

**macOS (Intel):**
```bash
npm run dist:mac-intel
```

**Windows:**
```bash
npm run electron-pack-win
```

**Linux:**
```bash
npm run electron-pack-linux
```

Output goes to `dist/`. macOS builds require an Apple Developer certificate and notarization credentials — set `APPLE_KEYCHAIN_PROFILE` and fill in the `identity` field in `package.json` before building.

### Tech stack

- **Frontend:** React 18, Deck.gl, OpenSeadragon
- **Desktop shell:** Electron
- **Analysis engine:** WebAssembly (scran.js, bakana, custom WASM modules)
- **AI:** WebLLM (in-browser local LLMs), Ollama (local server), or any OpenAI-compatible API

---

