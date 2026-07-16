const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // File system operations
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectPath: () => ipcRenderer.invoke('select-path'),
  selectSpatialType: () => ipcRenderer.invoke('select-spatial-type'),
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  read10xFiles: (targetPath, options) => ipcRenderer.invoke('read-10x-files', targetPath, options || {}),
  read10xAtacFiles: (targetPath) => ipcRenderer.invoke('read-10x-atac-files', targetPath),
  getAtacMatrixChunk: (chunkKey, offset, length) => ipcRenderer.invoke('get-atac-matrix-chunk', chunkKey, offset, length),
  releaseAtacMatrixBuffer: (chunkKey) => ipcRenderer.invoke('release-atac-matrix-buffer', chunkKey),
  readMultiomeFiles: (targetPath) => ipcRenderer.invoke('read-multiome-files', targetPath),
  readXeniumFiles: (targetPath) => ipcRenderer.invoke('read-xenium-files', targetPath),
  readVisiumHDFiles: (targetPath) => ipcRenderer.invoke('read-visium-hd-files', targetPath),
  readMerfishFiles: (targetPath) => ipcRenderer.invoke('read-merfish-files', targetPath),
  readCosmxFiles: (targetPath) => ipcRenderer.invoke('read-cosmx-files', targetPath),
  listDirectory: (dirPath) => ipcRenderer.invoke('list-directory', dirPath),
  pathExists: (path) => ipcRenderer.invoke('path-exists', path),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  loadImageFile: (filePath) => ipcRenderer.invoke('load-image-file', filePath),
  loadTransformationMatrix: (filePath) => ipcRenderer.invoke('load-transformation-matrix', filePath),
  convertTiffToDzi: (imagePath, transformMatrix) => ipcRenderer.invoke('convert-tiff-to-dzi', imagePath, transformMatrix),
  selectHistologyImage: () => ipcRenderer.invoke('select-histology-image'),
  selectTransformationMatrix: () => ipcRenderer.invoke('select-transformation-matrix'),

  // ATAC-seq fragment queries
  queryAtacFragments: (options) => ipcRenderer.invoke('query-atac-fragments', options),

  // CellPilot results persistence (save/load UMAP + clusters to input folder)
  saveCellpilotResults: (folderPath, results) => ipcRenderer.invoke('save-cellpilot-results', folderPath, results),
  saveCellpilotResultsSync: (folderPath, results) => ipcRenderer.sendSync('save-cellpilot-results-sync', folderPath, results),
  checkCellpilotResults: (folderPath) => ipcRenderer.invoke('check-cellpilot-results', folderPath),

  // High-resolution screenshot capture
  captureScreenshot: (options) => ipcRenderer.invoke('capture-screenshot', options),

  // Screen recording
  saveRecording: (buffer, ext) => ipcRenderer.invoke('save-recording', buffer, ext),

  // Session tracking (optional: for UI display)
  getSessionInfo: () => ipcRenderer.invoke('get-session-info'),

  // Platform info
  platform: process.platform,

  // Check if running in Electron
  isElectron: true,
});


