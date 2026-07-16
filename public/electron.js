const { app, BrowserWindow, ipcMain, dialog, protocol, globalShortcut, shell, desktopCapturer, systemPreferences, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const readline = require('readline');
const crypto = require('crypto');
const express = require('express');
const { tiffToDzi } = require('./tiffToDzi');

let mainWindow;
let tileServer = null;
let cosmxTempServer = null;

// ============== Session Tracking ==============
// Set TRACKING_SERVER_URL in your environment or replace this with your own tracking endpoint.
const TRACKING_SERVER_URL = process.env.TRACKING_SERVER_URL || '';

let sessionData = {
  sessionId: null,
  startTime: null,
  endTime: null,
  durationMs: null,
};

let machineId = null;

function generateSessionId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function getMachineId() {
  if (machineId) return machineId;

  const machineIdPath = path.join(app.getPath('userData'), '.machine-id');

  try {
    if (fs.existsSync(machineIdPath)) {
      machineId = fs.readFileSync(machineIdPath, 'utf8').trim();
    } else {
      machineId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}`;
      fs.writeFileSync(machineIdPath, machineId);
    }
  } catch (error) {
    machineId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    console.error('[Tracking] Could not persist machine ID:', error.message);
  }

  return machineId;
}

function startSessionTracking() {
  sessionData.sessionId = generateSessionId();
  sessionData.startTime = new Date().toISOString();
}

async function endSessionTracking() {
  if (!sessionData.startTime) {
    return;
  }

  sessionData.endTime = new Date().toISOString();
  sessionData.durationMs = new Date(sessionData.endTime) - new Date(sessionData.startTime);


  await sendSessionToServer(sessionData);

  sessionData = {
    sessionId: null,
    startTime: null,
    endTime: null,
    durationMs: null,
  };
}

function sendSessionToServer(data) {
  return new Promise((resolve) => {
    try {
      const { net } = require('electron');
      const payload = {
        sessionId: data.sessionId,
        machineId: getMachineId(),
        startTime: data.startTime,
        endTime: data.endTime,
        durationMs: data.durationMs,
        durationSeconds: Math.round(data.durationMs / 1000),
        platform: process.platform,
        appVersion: app.getVersion(),
      };


      const request = net.request({
        method: 'POST',
        url: TRACKING_SERVER_URL,
      });

      request.setHeader('Content-Type', 'application/json');

      const timeout = setTimeout(() => {
        console.error('[Tracking] Request timed out after 5 seconds');
        resolve();
      }, 5000);

      request.on('response', (response) => {

        let responseData = '';
        response.on('data', (chunk) => {
          responseData += chunk.toString();
        });

        response.on('end', () => {
          clearTimeout(timeout);
          if (response.statusCode >= 200 && response.statusCode < 300) {
          } else {
            console.error('[Tracking] Failed to send session data: HTTP', response.statusCode);
          }
          resolve();
        });
      });

      request.on('error', (error) => {
        clearTimeout(timeout);
        console.error('[Tracking] Request error:', error.message);
        resolve();
      });

      request.write(JSON.stringify(payload));
      request.end();
    } catch (error) {
      console.error('[Tracking] Error sending session data:', error.message);
      console.error('[Tracking] Stack trace:', error.stack);
      resolve();
    }
  });
}
// ============== End Session Tracking ==============

// Set up Express server configuration for serving DZI tiles
const TILE_PORT = 18765;
let TILE_ROOT; // Will be set when app is ready
const TILE_PROTOCOL = 'tile'; // Custom protocol for serving tiles

// CosMX preparsed files served over HTTP so we never send huge buffers over IPC
const COSMX_TEMP_PORT = 18766;

// App bundle HTTP server, serves build/ over localhost so Web Workers load from
// the same origin (http://127.0.0.1:APP_SERVER_PORT).  Chromium's Worker script
// fetch bypasses Electron's ASAR protocol handler, so file:// workers from inside
// app.asar fail silently.  HTTP is the only reliable workaround.
const APP_SERVER_PORT = 18764;
let appFileServer = null;

function startAppFileServer(callback) {
  if (appFileServer) {
    if (callback) callback();
    return;
  }
  const appPath = app.getAppPath(); // ends with "app.asar" in production
  const buildDir = appPath.endsWith('.asar')
    ? path.join(appPath + '.unpacked', 'build') // real FS path (unpacked from ASAR)
    : path.join(appPath, 'build');              // dev: normal build dir

  const serverApp = express();
  serverApp.use((req, res, next) => {
    res.header('Cross-Origin-Opener-Policy', 'same-origin');
    res.header('Cross-Origin-Embedder-Policy', 'credentialless');
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });
  serverApp.use(express.static(buildDir, { maxAge: 0 }));
  // SPA fallback
  serverApp.get('*', (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.sendFile(path.join(buildDir, 'index.html'));
  });

  appFileServer = serverApp.listen(APP_SERVER_PORT, '127.0.0.1', () => {
    if (callback) callback();
  });
  appFileServer.on('error', (err) => {
    console.error('App file server error:', err.message);
    if (callback) callback(); // proceed even on error
  });
}
function getCosmxTempRoot() {
  return path.join(app.getPath('userData'), 'cosmx-temp');
}

// Large HDF5 file HTTP server, serves local H5 files with Range-request support so
// the analysis web worker can use FS.createLazyFile() for on-demand chunk fetching.
// Files are never copied into memory; only the requested byte-ranges are read from disk.
const H5_SERVER_PORT = 18767;
let h5FileServer = null;
const h5Registry = new Map(); // token → absolute file path

function startH5FileServer() {
  if (h5FileServer) return;
  const serverApp = express();
  serverApp.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });
  serverApp.all('/h5/:token', (req, res) => {
    const filePath = h5Registry.get(req.params.token);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).send('H5 file not found');
    }
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', String(chunkSize));
      res.status(206);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', String(fileSize));
      res.status(200);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath).pipe(res);
    }
  });
  h5FileServer = serverApp.listen(H5_SERVER_PORT, '127.0.0.1', () => {
  });
}
function startCosmxTempServer() {
  if (cosmxTempServer) return;
  const root = getCosmxTempRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  const serverApp = express();
  serverApp.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });
  serverApp.use('/cosmx-temp', express.static(root, { maxAge: 0 }));
  cosmxTempServer = serverApp.listen(COSMX_TEMP_PORT, () => {
  });
}

// Increase V8 heap limits so large datasets (e.g., Xenium) can load without TypedArray allocation failures.
// Applies to all renderer processes, including dedicated WebWorkers.
app.commandLine.appendSwitch('js-flags', '--max_old_space_size=8192');

// Set Sharp pixel limit environment variable BEFORE any Sharp operations
// This allows processing of very large histology images
// Set to 10 billion pixels (effectively unlimited for most use cases)
if (!process.env.SHARP_LIMIT_INPUT_PIXELS) {
  process.env.SHARP_LIMIT_INPUT_PIXELS = '10000000000';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false, // Disable for local files (allows file:// URLs)
      allowRunningInsecureContent: false,
      // Enable SharedArrayBuffer for WebAssembly multi-threading
      additionalArguments: [
        '--enable-features=SharedArrayBuffer',
        '--disable-web-security', // Allow file:// URLs to load images
      ],
    },
    title: 'CellPilot | HumphreysLab',
    backgroundColor: '#f5f5f5',
  });

  // Load from the local HTTP server so Web Workers are same-origin and
  // load without ASAR protocol issues.  Dev mode uses ELECTRON_START_URL.
  const startUrl =
    process.env.ELECTRON_START_URL ||
    `http://127.0.0.1:${APP_SERVER_PORT}/`;

  // Set COEP/COOP headers for SharedArrayBuffer support
  // BUT: Only set them on the main document, NOT on tile server responses
  // This allows SharedArrayBuffer to work while avoiding tile loading issues
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders || {};
    const url = details.url || '';
    
    // Check if this is a tile server request; if so, don't modify headers
    // Express server sets the proper CORS headers including Cross-Origin-Resource-Policy
    const isTileRequest = url.includes(`:${TILE_PORT}`) ||
                          url.includes(`:${APP_SERVER_PORT}`) ||
                          url.includes('localhost:18765') ||
                          url.startsWith(`${TILE_PROTOCOL}://`);
    
    if (isTileRequest) {
      // For tile requests, return headers as-is (Express sets CORS headers)
      callback({ responseHeaders });
      return;
    }
    
    // For main document and other resources, set COEP/COOP for SharedArrayBuffer
    const newHeaders = {};
    Object.keys(responseHeaders).forEach(key => {
      newHeaders[key] = Array.isArray(responseHeaders[key]) 
        ? responseHeaders[key] 
        : [responseHeaders[key]];
    });
    
    // Set COEP/COOP for SharedArrayBuffer support
    // Use 'credentialless' which is less strict than 'require-corp' but still supports SharedArrayBuffer
    newHeaders['cross-origin-opener-policy'] = ['same-origin'];
    newHeaders['cross-origin-embedder-policy'] = ['credentialless'];
    
    callback({ responseHeaders: newHeaders });
  });

  mainWindow.loadURL(startUrl);

  // Handle getDisplayMedia() calls from the renderer for screen recording.
  // On macOS, screen recording permission must be granted in System Preferences.
  mainWindow.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    // Check macOS screen recording permission before attempting capture
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status !== 'granted') {
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Screen Recording Permission Required',
          message: 'CellPilot needs Screen Recording permission to record your screen.',
          detail: 'Go to System Preferences → Privacy & Security → Screen Recording, enable CellPilot, then restart the app.',
          buttons: ['Open System Preferences', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) {
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        }
        callback({ video: undefined });
        return;
      }
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'] });
      const appSource = sources.find(s => s.name.includes('CellPilot')) || sources.find(s => s.name.includes('Electron'));
      if (!appSource) throw new Error('Could not find CellPilot window source');
      callback({ video: appSource });
    } catch (err) {
      console.error('Screen capture error:', err.message);
      // Permission was likely revoked, guide the user to re-enable it
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Screen Recording Permission Required',
        message: 'CellPilot could not access the screen.',
        detail: 'Go to System Preferences → Privacy & Security → Screen Recording, enable CellPilot, then restart the app.',
        buttons: ['Open System Preferences', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
      callback({ video: undefined });
    }
  });

  // Open external links (e.g. Tutorial, GitHub, X) in the system browser instead of in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const u = url || '';
    if (u.startsWith('https://') || u.startsWith('http://')) {
      shell.openExternal(u);
    }
    return { action: 'deny' };
  });

  // Open DevTools automatically for debugging
  if (process.env.ELECTRON_START_URL) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function closeLocalServices() {
  if (appFileServer) {
    appFileServer.close();
    appFileServer = null;
  }
  if (tileServer) {
    tileServer.close();
    tileServer = null;
  }
  if (cosmxTempServer) {
    cosmxTempServer.close();
    cosmxTempServer = null;
  }
  if (h5FileServer) {
    h5FileServer.close();
    h5FileServer = null;
  }
}

function createMenu() {
  const template = [
    {
      label: process.platform === 'darwin' ? app.getName() : 'CellPilot',
      submenu: [
        {
          label: 'Privacy',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Privacy Policy',
              message: 'Privacy Policy',
              detail: 'CellPilot collects anonymous usage metrics (such as session duration, application version, and operating system) to understand how the application is used and to improve performance. This data does not include personal information and cannot be used to identify individual users.',
              buttons: ['OK'],
              defaultId: 0,
            });
          },
        },
        { type: 'separator' },
        {
          label: 'Quit CellPilot',
          accelerator: process.platform === 'darwin' ? 'Command+Q' : 'Ctrl+Q',
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'forceReload', label: 'Force Reload' },
        { role: 'toggleDevTools', label: 'Toggle Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn', label: 'Zoom In' },
        { role: 'zoomOut', label: 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toggle Full Screen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize', label: 'Minimize' },
        { role: 'close', label: 'Close' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About CellPilot',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About CellPilot',
              message: 'CellPilot',
              detail: 'AI-Powered Single-Cell and Spatial Transcriptomics Analysis\nDeveloped by Humphreys Lab',
              buttons: ['OK'],
              defaultId: 0,
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.on('ready', () => {
  createMenu();
  startSessionTracking();
  if (process.env.ELECTRON_START_URL) {
    // Dev mode: CRA serves the app itself; no local HTTP server needed
    createWindow();
  } else {
    // Production: start the app HTTP server first, then load the window
    startAppFileServer(() => {
      createWindow();
    });
  }
});

let isQuitting = false;
let isEndingSession = false;

async function flushSessionTracking() {
  if (isEndingSession || !sessionData.startTime) {
    return;
  }
  isEndingSession = true;
  try {
    await endSessionTracking();
  } finally {
    isEndingSession = false;
  }
}

app.on('window-all-closed', async () => {
  await flushSessionTracking();
  if (process.platform !== 'darwin') {
    app.quit();
  }
  closeLocalServices();
});

app.on('before-quit', async (event) => {
  if (isQuitting) {
    return;
  }

  if (sessionData.startTime) {
    isQuitting = true;
    event.preventDefault();

    await flushSessionTracking();

    closeLocalServices();
    globalShortcut.unregisterAll();

    app.quit();
  }
});

app.on('will-quit', () => {
  closeLocalServices();
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (mainWindow === null) {
    startSessionTracking();
    if (process.env.ELECTRON_START_URL || appFileServer) {
      createWindow();
    } else {
      startAppFileServer(() => createWindow());
    }
  }
});

// Register custom protocol for serving tiles (avoids COEP issues)
// Protocol handlers in Electron treat files as same-origin, avoiding COEP restrictions
function registerTileProtocol() {
  try {
    protocol.registerFileProtocol(TILE_PROTOCOL, (request, callback) => {
      // Compute TILE_ROOT dynamically (in case it's not set yet)
      const tileRoot = TILE_ROOT || path.join(app.getPath('userData'), 'dzi-tiles');
      const url = request.url.replace(`${TILE_PROTOCOL}://`, '');
      const filePath = path.join(tileRoot, url);
      
      // Security check: ensure file is within TILE_ROOT
      const normalizedPath = path.normalize(filePath);
      const normalizedRoot = path.normalize(tileRoot);
      if (!normalizedPath.startsWith(normalizedRoot)) {
        console.error('Security check failed: path outside TILE_ROOT', filePath);
        callback({ error: -6 }); // FILE_NOT_FOUND
        return;
      }
      
      // Check if file exists
      if (fs.existsSync(filePath)) {
        callback({ path: filePath });
      } else {
        console.error('Tile file not found:', filePath);
        callback({ error: -6 }); // FILE_NOT_FOUND
      }
    });
  } catch (error) {
    console.error('Error registering tile protocol:', error);
  }
}

// Initialize tile root when app is ready
app.whenReady().then(() => {
  TILE_ROOT = path.join(app.getPath('userData'), 'dzi-tiles');
  
  // Register custom protocol (makes tiles same-origin, avoiding COEP)
  registerTileProtocol();
  
  // Also start HTTP server as fallback
  startTileServer();
  
  // Register refresh shortcut: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows/Linux)
  // Do this after app is fully ready to avoid Windows issues
  const refreshShortcut = process.platform === 'darwin' ? 'Command+Shift+R' : 'Ctrl+Shift+R';
  
  try {
    globalShortcut.register(refreshShortcut, () => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.reload();
      }
    });
  } catch (error) {
    console.warn('Failed to register global shortcut:', error.message);
  }
});

function startTileServer() {
  if (tileServer) {
    return;
  }

  const serverApp = express();
  
  // Ensure tile directory exists
  if (!fs.existsSync(TILE_ROOT)) {
    fs.mkdirSync(TILE_ROOT, { recursive: true });
  }
  
  // Enable CORS for local file access with COEP support
  // When COEP (Cross-Origin-Embedder-Policy) is set to 'require-corp' in the Electron app,
  // cross-origin resources must have Cross-Origin-Resource-Policy header set to 'cross-origin'
  serverApp.use((req, res, next) => {
    // Set CORS headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    // CRITICAL: Set Cross-Origin-Resource-Policy to allow embedding with COEP require-corp
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });
  
  // Serve static files from tile directory
  serverApp.use('/tiles', express.static(TILE_ROOT, {
    setHeaders: (res, path) => {
      // Ensure all tile images have proper CORS headers for COEP
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', path.endsWith('.dzi') || path.endsWith('.xml') 
        ? 'application/xml' 
        : 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache tiles for 1 year
    }
  }));
  
  // Health check endpoint
  serverApp.get('/tiles/health', (req, res) => {
    res.json({ status: 'ok', tileRoot: TILE_ROOT });
  });
  
  tileServer = serverApp.listen(TILE_PORT, () => {
  });
}

// Handle uncaught exceptions to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  // Don't exit; log the error instead
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit; log the error instead
});

// IPC handlers for file/folder selection
const selectTenxFolder = async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select 10x Data Folder',
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
};

const selectTenxFile = async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Select 10x HDF5 File',
    filters: [
      { name: '10x HDF5 Files', extensions: ['h5', 'hdf5'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
};

ipcMain.handle('select-folder', async () => {
  return await selectTenxFolder();
});

ipcMain.handle('select-path', async () => {
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['10x Folder', '10x HDF5 File', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Select Data Source',
    message: 'Choose the type of 10x data you want to load.',
    detail: 'Select "10x Folder" for matrix.mtx + features.tsv + barcodes.tsv.\nSelect "10x HDF5 File" for a single .h5 dataset.',
  });

  if (response.response === 0) {
    return await selectTenxFolder();
  }
  if (response.response === 1) {
    return await selectTenxFile();
  }
  return null;
});

ipcMain.handle('select-spatial-type', async () => {
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['10x Xenium', '10x Visium HD', 'MERFISH', 'NanoString CosMX', 'Cancel'],
    defaultId: 0,
    cancelId: 4,
    title: 'Select Spatial Data Type',
    message: 'Choose the spatial dataset format you want to load.',
  });

  if (response.response === 0) {
    return 'xenium';
  }
  if (response.response === 1) {
    return 'visium-hd';
  }
  if (response.response === 2) {
    return 'merfish';
  }
  if (response.response === 3) {
    return 'cosmx';
  }
  return null;
});

ipcMain.handle('select-file', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: options?.title || 'Select File',
    filters: options?.filters || [{ name: 'All Files', extensions: ['*'] }],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// Read file from filesystem (for 10x data)
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const data = fs.readFileSync(filePath);
    // Return as Uint8Array buffer
    return { success: true, data: Array.from(data) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

const readH5File = (filePath, suppliedName) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`HDF5 file not found at ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  const fileName = suppliedName || path.basename(filePath);
  const TWO_GIB = 2 * 1024 * 1024 * 1024;

  if (stats.size >= TWO_GIB) {
    // Large file: register with the H5 HTTP server so the analysis worker can
    // use FS.createLazyFile() and stream only the chunks it needs.
    const token = crypto.randomBytes(16).toString('hex');
    h5Registry.set(token, filePath);
    startH5FileServer();
    return {
      success: true,
      format: '10X HDF5',
      isLargeFile: true,
      files: {
        h5: {
          name: fileName,
          h5Url: `http://127.0.0.1:${H5_SERVER_PORT}/h5/${token}`,
          size: stats.size,
          data: null,
        },
      },
    };
  }

  const data = fs.readFileSync(filePath);

  return {
    success: true,
    format: '10X HDF5',
    files: {
      h5: {
        name: fileName,
        data: new Uint8Array(data),
      },
    },
  };
};

const resolveDirectoryEntries = (dirPath) => {
  const entries = fs.readdirSync(dirPath);
  const lookup = new Map();
  entries.forEach((entry) => {
    lookup.set(entry.toLowerCase(), entry);
  });
  return { entries, lookup };
};

const findCandidate = (lookup, candidates) => {
  for (const candidate of candidates) {
    const resolved = lookup.get(candidate.toLowerCase());
    if (resolved) {
      return resolved;
    }
  }
  return null;
};

/** Resolve path to summary.csv: root first, then outs/, atacseq/, outs/atacseq/ (10X ATAC/Multiome). */
const getSummaryCsvPath = (targetPath, lookup) => {
  if (lookup.has('summary.csv')) {
    return path.join(targetPath, lookup.get('summary.csv'));
  }
  for (const sub of ['outs', 'atacseq', path.join('outs', 'atacseq')]) {
    const p = path.join(targetPath, sub, 'summary.csv');
    if (fs.existsSync(p)) return p;
  }
  return null;
};

/** Parse genome/reference from summary.csv text (key-value lines or header + data row). Returns normalized hg38/hg19/mm10/mm39 or raw string. */
const parseGenomeFromSummaryText = (summaryText) => {
  const lines = summaryText.split(/\r?\n/).filter((line) => line.trim());
  const parseCsvLine = (line) => line.split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
  for (const line of lines) {
    const parts = parseCsvLine(line);
    if (parts.length >= 2 && (parts[0] === 'Genome' || parts[0] === 'Reference')) {
      const ref = (parts[1] || '').trim();
      if (/GRCh38|hg38|human/i.test(ref)) return 'hg38';
      if (/GRCh37|hg19|human/i.test(ref)) return 'hg19';
      if (/GRCm39|mm39/i.test(ref)) return 'mm39';
      if (/GRCm38|mm10|mouse/i.test(ref)) return 'mm10';
      if (ref) return ref;
      break;
    }
  }
  if (lines.length >= 2) {
    const headers = parseCsvLine(lines[0]);
    const genomeCol = headers.findIndex((h) => /^genome$/i.test(h.trim()) || /^reference$/i.test(h.trim()));
    if (genomeCol >= 0) {
      const dataRow = parseCsvLine(lines[1]);
      const ref = (dataRow[genomeCol] || '').trim();
      if (/GRCh38|hg38|human/i.test(ref)) return 'hg38';
      if (/GRCh37|hg19|human/i.test(ref)) return 'hg19';
      if (/GRCm39|mm39/i.test(ref)) return 'mm39';
      if (/GRCm38|mm10|mouse/i.test(ref)) return 'mm10';
      if (ref) return ref;
    }
  }
  return null;
};

// Read multiple files for 10x data
ipcMain.handle('read-10x-files', async (event, targetPath, options = {}) => {
  try {
    if (!targetPath) {
      throw new Error('No path provided to read-10x-files');
    }

    const stats = fs.statSync(targetPath);

    if (stats.isFile()) {
      if (targetPath.toLowerCase().endsWith('.h5') || targetPath.toLowerCase().endsWith('.hdf5')) {
        return readH5File(targetPath);
      }
      throw new Error('Unsupported file type. Please select a 10x HDF5 (.h5) file or 10x folder.');
    }

    const { entries, lookup } = resolveDirectoryEntries(targetPath);

    const preferredH5 = options?.h5FileName;
    let h5File = null;
    if (preferredH5 && lookup.has(preferredH5.toLowerCase())) {
      h5File = lookup.get(preferredH5.toLowerCase());
    } else {
      h5File = entries.find((entry) => {
        const lower = entry.toLowerCase();
        return lower.endsWith('.h5') || lower.endsWith('.hdf5');
      });
    }

    if (h5File) {
      const h5Path = path.join(targetPath, h5File);
      return readH5File(h5Path, h5File);
    }

    const matrixFile = findCandidate(lookup, ['matrix.mtx.gz', 'matrix.mtx']);
    const featuresFile = findCandidate(lookup, ['features.tsv.gz', 'features.tsv', 'genes.tsv.gz', 'genes.tsv']);
    const barcodesFile = findCandidate(lookup, ['barcodes.tsv.gz', 'barcodes.tsv']);

    if (!matrixFile) {
      throw new Error('matrix.mtx(.gz) not found');
    }
    if (!featuresFile) {
      throw new Error('features.tsv(.gz) or genes.tsv(.gz) not found');
    }
    if (!barcodesFile) {
      throw new Error('barcodes.tsv(.gz) not found');
    }

    const matrixPath = path.join(targetPath, matrixFile);
    const featuresPath = path.join(targetPath, featuresFile);
    const barcodesPath = path.join(targetPath, barcodesFile);

    const matrixData = fs.readFileSync(matrixPath);
    const featuresData = fs.readFileSync(featuresPath);
    const barcodesData = fs.readFileSync(barcodesPath);


    return {
      success: true,
      format: '10X MatrixMarket',
      files: {
        matrix: {
          name: matrixFile,
          data: new Uint8Array(matrixData),
        },
        features: {
          name: featuresFile,
          data: new Uint8Array(featuresData),
        },
        barcodes: {
          name: barcodesFile,
          data: new Uint8Array(barcodesData),
        },
      },
    };
  } catch (error) {
    console.error('Error reading 10x files:', error);
    return { success: false, error: error.message };
  }
});

// Large ATAC matrix: transfer in chunks over IPC to avoid SIGTRAP/crash (Electron IPC size limits)
const ATAC_MATRIX_CHUNK_THRESHOLD_BYTES = 150 * 1024 * 1024; // 150 MB
const ATAC_MATRIX_CHUNK_SIZE = 80 * 1024 * 1024; // 80 MB per IPC message
const atacMatrixChunkCache = new Map(); // key -> Uint8Array (cleared when new load or release)

ipcMain.handle('get-atac-matrix-chunk', (event, chunkKey, offset, length) => {
  const buf = atacMatrixChunkCache.get(chunkKey);
  if (!buf) return null;
  const end = Math.min(offset + length, buf.length);
  if (offset >= buf.length) return null;
  return buf.slice(offset, end);
});

ipcMain.handle('release-atac-matrix-buffer', (event, chunkKey) => {
  atacMatrixChunkCache.delete(chunkKey);
});

// Read 10x Cell Ranger ATAC output: matrix.mtx + barcodes.tsv + peaks (same as scATAC folder, no H5/bakana)
ipcMain.handle('read-10x-atac-files', async (event, targetPath) => {
  try {
    if (!targetPath) {
      throw new Error('No path provided to read-10x-atac-files');
    }

    // Clear any previous chunked matrix so we don't hold two large buffers when user switches dataset
    atacMatrixChunkCache.clear();

    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) {
      throw new Error('Please select the cellranger-atac output folder (e.g. outs or filtered_peak_bc_matrix).');
    }

    const { entries, lookup } = resolveDirectoryEntries(targetPath);

    // Prefer MTX (same as scATAC pipeline): filtered_peak_bc_matrix/matrix.mtx or outs/filtered_peak_bc_matrix/matrix.mtx
    const matrixDirCandidates = [
      path.join(targetPath, 'filtered_peak_bc_matrix'),
      path.join(targetPath, 'outs', 'filtered_peak_bc_matrix'),
      path.join(targetPath, 'raw_peak_bc_matrix'),
      path.join(targetPath, 'outs', 'raw_peak_bc_matrix'),
    ];
    let matrixPath = null;
    let matrixName = null;
    let dataDir = null;
    for (const dir of matrixDirCandidates) {
      if (!fs.existsSync(dir)) continue;
      const mtxPath = path.join(dir, 'matrix.mtx');
      const mtxGzPath = path.join(dir, 'matrix.mtx.gz');
      if (fs.existsSync(mtxPath)) {
        matrixPath = mtxPath;
        matrixName = 'matrix.mtx';
        dataDir = dir;
        break;
      }
      if (fs.existsSync(mtxGzPath)) {
        matrixPath = mtxGzPath;
        matrixName = 'matrix.mtx.gz';
        dataDir = dir;
        break;
      }
    }
    if (!matrixPath || !dataDir) {
      throw new Error(
        'filtered_peak_bc_matrix/matrix.mtx (or matrix.mtx.gz) not found. Use the same folder structure as the scATAC pipeline (matrix.mtx + barcodes.tsv + peaks).'
      );
    }

    let matrixBuf = fs.readFileSync(matrixPath);
    if (path.extname(matrixPath) === '.gz' || matrixName === 'matrix.mtx.gz') {
      matrixBuf = zlib.gunzipSync(matrixBuf);
    }
    const matrixData = new Uint8Array(matrixBuf);
    const useChunkedTransfer = matrixData.length > ATAC_MATRIX_CHUNK_THRESHOLD_BYTES;
    if (useChunkedTransfer) {
      atacMatrixChunkCache.set(targetPath, matrixData);
    }

    const barcodesPath = path.join(dataDir, 'barcodes.tsv');
    if (!fs.existsSync(barcodesPath)) {
      throw new Error('barcodes.tsv not found in ' + dataDir);
    }
    const barcodesText = fs.readFileSync(barcodesPath, 'utf8');
    const cellBarcodes = barcodesText.trim().split('\n').map((b) => b.trim()).filter(Boolean);

    let peaks = [];
    const peaksBedPath = path.join(dataDir, 'peaks.bed');
    if (fs.existsSync(peaksBedPath)) {
      const peakLines = fs.readFileSync(peaksBedPath, 'utf8').trim().split('\n').map((l) => l.trim()).filter(Boolean);
      peaks = peakLines.map((l) => {
        const parts = l.split(/\t/);
        return parts.length >= 3 ? `${parts[0]}-${parts[1]}-${parts[2]}` : l;
      });
    } else {
      const peakAnnoPath = path.join(targetPath, 'peak_annotation.tsv');
      if (fs.existsSync(peakAnnoPath)) {
        const peakAnnoText = fs.readFileSync(peakAnnoPath, 'utf8');
        const peakAnnoLines = peakAnnoText.trim().split('\n').map((l) => l.trim()).filter(Boolean);
        const headers = peakAnnoLines[0].split('\t').map((h) => h.trim());
        const chromIdx = headers.indexOf('chrom');
        const startIdx = headers.indexOf('start');
        const endIdx = headers.indexOf('end');
        for (let k = 1; k < peakAnnoLines.length; k++) {
          const parts = peakAnnoLines[k].split('\t');
          const chrom = chromIdx >= 0 ? parts[chromIdx] : '';
          const start = startIdx >= 0 ? parts[startIdx] : '';
          const end = endIdx >= 0 ? (parts[endIdx] || parts[headers.indexOf('stop')]) : '';
          peaks.push(`${chrom}-${start}-${end}`);
        }
      }
    }

    let peakAnnotationData = null;
    const peakAnnoPath = path.join(targetPath, 'peak_annotation.tsv');
    if (fs.existsSync(peakAnnoPath)) {
      peakAnnotationData = fs.readFileSync(peakAnnoPath);
    }

    let genome = null;
    const summaryPath = getSummaryCsvPath(targetPath, lookup);
    if (summaryPath) {
      try {
        const summaryText = fs.readFileSync(summaryPath, 'utf8');
        genome = parseGenomeFromSummaryText(summaryText);
      } catch (e) {
        console.warn('Could not parse summary.csv for genome:', e.message);
      }
    }

    const files = {
      matrix: {
        name: matrixName || 'matrix.mtx',
        data: useChunkedTransfer ? undefined : matrixData,
      },
      barcodes: cellBarcodes,
      peaks,
      peakAnnotation: peakAnnotationData
        ? { name: 'peak_annotation.tsv', data: new Uint8Array(peakAnnotationData) }
        : undefined,
    };
    const result = {
      success: true,
      format: '10X ATAC',
      regionPath: targetPath,
      genome: genome || undefined,
      cellBarcodes,
      files,
    };
    if (useChunkedTransfer) {
      result._matrixChunkKey = targetPath;
      result._matrixSize = matrixData.length;
    }
    return result;
  } catch (error) {
    atacMatrixChunkCache.clear();
    console.error('Error reading 10x ATAC files:', error);
    return { success: false, error: error.message };
  }
});

// Read 10x Multiome (ARC) output: filtered_feature_bc_matrix.h5 + atac_peak_annotation.tsv + precomputed analysis
ipcMain.handle('read-multiome-files', async (event, targetPath) => {
  try {
    if (!targetPath) {
      throw new Error('No path provided to read-multiome-files');
    }

    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) {
      throw new Error('Please select the cellranger-arc output folder.');
    }

    const { entries, lookup } = resolveDirectoryEntries(targetPath);

    // 1. Find the combined filtered_feature_bc_matrix.h5
    const h5Candidates = ['filtered_feature_bc_matrix.h5', 'filtered_feature_bc_matrix.hdf5'];
    let h5File = null;
    for (const candidate of h5Candidates) {
      if (lookup.has(candidate.toLowerCase())) {
        h5File = lookup.get(candidate.toLowerCase());
        break;
      }
    }
    if (!h5File) {
      throw new Error('filtered_feature_bc_matrix.h5 not found in folder.');
    }

    const h5Path = path.join(targetPath, h5File);
    const h5Result = readH5File(h5Path, h5File);

    // 2. Find atac_peak_annotation.tsv
    const peakAnnoCandidates = ['atac_peak_annotation.tsv', 'peak_annotation.tsv'];
    let peakAnnoFile = null;
    for (const candidate of peakAnnoCandidates) {
      if (lookup.has(candidate.toLowerCase())) {
        peakAnnoFile = lookup.get(candidate.toLowerCase());
        break;
      }
    }
    let peakAnnoData = null;
    if (peakAnnoFile) {
      peakAnnoData = fs.readFileSync(path.join(targetPath, peakAnnoFile));
    } else {
      console.warn('[Multiome] No peak annotation file found (atac_peak_annotation.tsv)');
    }

    // 3. Read precomputed analysis from analysis/ folder
    const precomputed = {};
    const analysisDir = path.join(targetPath, 'analysis');
    if (fs.existsSync(analysisDir) && fs.statSync(analysisDir).isDirectory()) {
      // RNA UMAP
      const rnaUmapPath = path.join(analysisDir, 'dimensionality_reduction', 'gex', 'umap_projection.csv');
      if (fs.existsSync(rnaUmapPath)) {
        precomputed.rnaUmap = fs.readFileSync(rnaUmapPath, 'utf8');
      }
      // ATAC UMAP
      const atacUmapPath = path.join(analysisDir, 'dimensionality_reduction', 'atac', 'umap_projection.csv');
      if (fs.existsSync(atacUmapPath)) {
        precomputed.atacUmap = fs.readFileSync(atacUmapPath, 'utf8');
      }
      // RNA clusters (graphclust), try both old and new Cell Ranger ARC naming
      const rnaClustersPath = path.join(analysisDir, 'clustering', 'gex', 'graphclust', 'clusters.csv');
      const rnaClustersPathNew = path.join(analysisDir, 'clustering', 'gex', 'gene_expression_graphclust', 'clusters.csv');
      if (fs.existsSync(rnaClustersPath)) {
        precomputed.rnaClusters = fs.readFileSync(rnaClustersPath, 'utf8');
      } else if (fs.existsSync(rnaClustersPathNew)) {
        precomputed.rnaClusters = fs.readFileSync(rnaClustersPathNew, 'utf8');
      }
      // ATAC clusters (graphclust), try both old and new Cell Ranger ARC naming
      const atacClustersPath = path.join(analysisDir, 'clustering', 'atac', 'graphclust', 'clusters.csv');
      const atacClustersPathNew = path.join(analysisDir, 'clustering', 'atac', 'peaks_graphclust', 'clusters.csv');
      if (fs.existsSync(atacClustersPath)) {
        precomputed.atacClusters = fs.readFileSync(atacClustersPath, 'utf8');
      } else if (fs.existsSync(atacClustersPathNew)) {
        precomputed.atacClusters = fs.readFileSync(atacClustersPathNew, 'utf8');
      }
    } else {
      console.warn('[Multiome] analysis/ folder not found');
    }

    // 4. Read cell barcodes
    let cellBarcodes = null;
    const barcodesDir = path.join(targetPath, 'filtered_feature_bc_matrix');
    const barcodesGzPath = path.join(barcodesDir, 'barcodes.tsv.gz');
    const barcodesTsvPath = path.join(barcodesDir, 'barcodes.tsv');
    if (fs.existsSync(barcodesGzPath)) {
      try {
        const zlib = require('zlib');
        const compressed = fs.readFileSync(barcodesGzPath);
        const decompressed = zlib.gunzipSync(compressed).toString('utf8');
        cellBarcodes = decompressed.trim().split('\n').map(b => b.trim()).filter(Boolean);
      } catch (e) {
        console.warn('[Multiome] Could not read barcodes.tsv.gz:', e.message);
      }
    } else if (fs.existsSync(barcodesTsvPath)) {
      try {
        const barcodesText = fs.readFileSync(barcodesTsvPath, 'utf8');
        cellBarcodes = barcodesText.trim().split('\n').map(b => b.trim()).filter(Boolean);
      } catch (e) {
        console.warn('[Multiome] Could not read barcodes.tsv:', e.message);
      }
    }

    // 5. Detect genome from summary.csv (root or outs/, atacseq/, outs/atacseq/)
    let genome = null;
    const summaryPath = getSummaryCsvPath(targetPath, lookup);
    if (summaryPath) {
      try {
        const summaryText = fs.readFileSync(summaryPath, 'utf8');
        genome = parseGenomeFromSummaryText(summaryText);
      } catch (e) {
        console.warn('[Multiome] Could not parse summary.csv for genome:', e.message);
      }
    }


    return {
      success: true,
      format: '10X Multiome',
      regionPath: targetPath,
      genome: genome || undefined,
      cellBarcodes: cellBarcodes || undefined,
      precomputed,
      files: {
        h5: h5Result.files.h5,
        ...(peakAnnoData ? {
          peakAnnotation: {
            name: peakAnnoFile,
            data: new Uint8Array(peakAnnoData),
          }
        } : {}),
      },
    };
  } catch (error) {
    console.error('Error reading multiome files:', error);
    return { success: false, error: error.message };
  }
});

const ensureDirectory = (candidatePath, description) => {
  if (!fs.existsSync(candidatePath)) {
    throw new Error(`${description} not found at ${candidatePath}`);
  }
  const stats = fs.statSync(candidatePath);
  if (!stats.isDirectory()) {
    throw new Error(`${description} at ${candidatePath} is not a directory`);
  }
  return candidatePath;
};

const getExistingFile = (baseDir, candidates, description, optional = false) => {
  for (const candidate of candidates) {
    const resolved = path.join(baseDir, candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return { name: candidate, absolutePath: resolved };
    }
  }
  if (optional) {
    return null;
  }
  throw new Error(`${description} not found in ${baseDir}`);
};

const readBinaryFile = (filePath) => new Uint8Array(fs.readFileSync(filePath));

const inspectXeniumRegion = (regionPath) => {
  const files = {};
  const metadata = { skipped: {}, sizes: {} };

  // Helper to read a file only if below a safe size threshold
  const MAX_READ_SIZE = 512 * 1024 * 1024; // 512 MB safety cap per file
  const readIfSmall = (absPath, logicalName, optional = false) => {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      if (!optional) {
        throw new Error(`${logicalName} not found at ${absPath}`);
      }
      return null;
    }
    const { size } = fs.statSync(absPath);
    metadata.sizes[logicalName] = size;
    if (size > MAX_READ_SIZE) {
      metadata.skipped[logicalName] = `Too large to load in-memory (${size} bytes)`;
      return null;
    }
    return readBinaryFile(absPath);
  };

  // Read and transparently gunzip small CSV files (e.g., cells.csv.gz), returning plain CSV bytes
  const readMaybeCsvGz = (absPath, logicalName, optional = false) => {
    const data = readIfSmall(absPath, logicalName, optional);
    if (!data) return null;
    const lower = absPath.toLowerCase();
    if (lower.endsWith('.csv.gz')) {
      try {
        const buf = Buffer.from(data);
        const unzipped = zlib.gunzipSync(buf);
        metadata.sizes[`${logicalName} (unzipped)`] = unzipped.length;
        return new Uint8Array(unzipped);
      } catch (e) {
        metadata.skipped[logicalName] = `Failed to gunzip: ${e.message}`;
        return null;
      }
    }
    return data;
  };

  const experimentFile = getExistingFile(regionPath, ['experiment.xenium'], 'experiment.xenium');
  files.experiment = {
    name: experimentFile.name,
    data: readIfSmall(experimentFile.absolutePath, 'experiment.xenium')
  };

  // Prefer textual CSV for cells metadata (coordinates), try csv before parquet.
  const cellsFile =
    getExistingFile(regionPath, ['cells.csv.gz', 'cells.csv', 'cells.parquet', 'cells.zarr.zip'], 'cells file');
  // Only attempt gunzip/plain read for CSV; if parquet selected (fallback), we won't parse spatial coords yet.
  const isCsvLike = /\.csv(\.gz)?$/i.test(cellsFile.name);
  const cellsData = isCsvLike ? readMaybeCsvGz(cellsFile.absolutePath, 'cells') : null;
  if (!isCsvLike) {
    metadata.skipped.cells = 'Using parquet cells file; spatial coordinates parsing deferred.';
  }
  files.cells = {
    name: cellsFile.name,
    data: cellsData,
  };
  metadata.cellsFormat = path.extname(cellsFile.name).replace('.', '') || 'unknown';

  // Intentionally do not check or load transcript files at this stage.
  // Only counts (cell_feature_matrix) and cells.csv(.gz) for spatial coords are needed at this stage.

  const cellFeatureMatrixDir = ensureDirectory(path.join(regionPath, 'cell_feature_matrix'), 'cell_feature_matrix');
  
  // Check for h5 file first (preferred for Xenium data)
  // List files in the directory to find h5 files
  let h5File = null;
  try {
    const dirEntries = fs.readdirSync(cellFeatureMatrixDir);
    const h5Candidates = dirEntries.filter(entry => {
      const lower = entry.toLowerCase();
      return lower.endsWith('.h5') || lower.endsWith('.hdf5');
    });
    if (h5Candidates.length > 0) {
      // Prefer cell_feature_matrix.h5, then any .h5 file
      const preferred = h5Candidates.find(e => e.toLowerCase() === 'cell_feature_matrix.h5');
      const h5Name = preferred || h5Candidates[0];
      const h5Path = path.join(cellFeatureMatrixDir, h5Name);
      if (fs.existsSync(h5Path) && fs.statSync(h5Path).isFile()) {
        h5File = { name: h5Name, absolutePath: h5Path };
      }
    }
  } catch (e) {
    // Ignore errors, fall back to MatrixMarket
  }
  
  if (h5File) {
    // Use HDF5 format if h5 file exists
    const h5Data = readIfSmall(h5File.absolutePath, 'cell_feature_matrix.h5');
    if (h5Data) {
      files.cellFeatureMatrix = {
        h5: {
          name: `cell_feature_matrix/${h5File.name}`,
          data: h5Data,
        },
      };
      metadata.cellFeatureMatrixFormat = 'HDF5';
    }
  }
  
  // If no h5 file, or h5 file couldn't be read, fall back to MatrixMarket format
  if (!files.cellFeatureMatrix || !files.cellFeatureMatrix.h5) {
    const matrixFile = getExistingFile(
      cellFeatureMatrixDir,
      ['matrix.mtx.gz', 'matrix.mtx'],
      'cell_feature_matrix/matrix file'
    );
    const featuresFile = getExistingFile(
      cellFeatureMatrixDir,
      ['features.tsv.gz', 'features.tsv', 'gene_ids.tsv', 'genes.tsv.gz', 'genes.tsv'],
      'cell_feature_matrix/features file'
    );
    const barcodesFile = getExistingFile(
      cellFeatureMatrixDir,
      ['barcodes.tsv.gz', 'barcodes.tsv'],
      'cell_feature_matrix/barcodes file'
    );
    files.cellFeatureMatrix = {
      matrix: {
        name: `cell_feature_matrix/${matrixFile.name}`,
        data: readBinaryFile(matrixFile.absolutePath),
      },
      features: {
        name: `cell_feature_matrix/${featuresFile.name}`,
        data: readBinaryFile(featuresFile.absolutePath),
      },
      barcodes: {
        name: `cell_feature_matrix/${barcodesFile.name}`,
        data: readBinaryFile(barcodesFile.absolutePath),
      },
    };
    metadata.cellFeatureMatrixFormat = 'MatrixMarket';
  }

  const analysisDir = ensureDirectory(path.join(regionPath, 'analysis'), 'analysis folder');
  files.analysis = {};
  metadata.analysis = {};

  const umapDir = path.join(analysisDir, 'umap');
  if (fs.existsSync(umapDir) && fs.statSync(umapDir).isDirectory()) {
    files.analysis.umap = {};
    const umapSubdirs = fs.readdirSync(umapDir);
    metadata.analysis.umap = [];
    umapSubdirs.forEach((subdir) => {
      const subdirPath = path.join(umapDir, subdir);
      if (!fs.statSync(subdirPath).isDirectory()) {
        return;
      }
      const projectionFile = getExistingFile(
        subdirPath,
        ['projection.csv', 'umap.projection.csv', 'gene_expression_2_components.csv'],
        `UMAP projection in ${subdir}`,
        true
      );
      if (projectionFile) {
        const key = `umap/${subdir}/${projectionFile.name}`;
        files.analysis.umap[key] = {
          name: key,
          data: readBinaryFile(projectionFile.absolutePath),
        };
        metadata.analysis.umap.push(key);
      }
    });
  }

  const clusteringDir = path.join(analysisDir, 'clustering');
  if (fs.existsSync(clusteringDir) && fs.statSync(clusteringDir).isDirectory()) {
    const geClusterDir = path.join(clusteringDir, 'gene_expression_graphclust');
    if (fs.existsSync(geClusterDir) && fs.statSync(geClusterDir).isDirectory()) {
      const clusterFile = getExistingFile(
        geClusterDir,
        ['clusters.csv.gz', 'clusters.csv'],
        'gene_expression_graphclust clusters',
        true
      );
      if (clusterFile) {
        const clusterData = readMaybeCsvGz(clusterFile.absolutePath, 'gene_expression_graphclust/clusters', true);
        if (clusterData) {
          files.analysis.clusters = {
            name: path.join('clustering', 'gene_expression_graphclust', clusterFile.name),
            data: clusterData,
          };
          metadata.analysis.clusters = files.analysis.clusters.name;
        } else {
          metadata.skipped['analysis/clustering/gene_expression_graphclust'] =
            'Clusters file too large to load';
        }
      }
    }
  }

  const metricsFile = getExistingFile(analysisDir, ['metrics_summary.csv'], 'metrics_summary.csv', true);
  if (metricsFile) {
    const data = readIfSmall(metricsFile.absolutePath, 'metrics_summary.csv', true);
    if (data) {
      files.analysis.metricsSummary = {
        name: `analysis/${metricsFile.name}`,
        data,
      };
    } else {
      metadata.skipped['analysis/metrics_summary.csv'] = 'Too large to load';
    }
  }

  const analysisSummaryFile = getExistingFile(regionPath, ['analysis_summary.html'], 'analysis_summary.html', true);
  if (analysisSummaryFile) {
    const data = readIfSmall(analysisSummaryFile.absolutePath, 'analysis_summary.html', true);
    if (data) {
      files.analysisSummary = {
        name: analysisSummaryFile.name,
        data,
      };
    } else {
      metadata.skipped['analysis_summary.html'] = 'Too large to load';
    }
  }

  // Intentionally do not check for large morphology images (e.g., morphology.ome.tif) or overview images now.
  // These are not used in the current pipeline and probing their presence caused confusing UI warnings.

  return { files, metadata };
};

const resolveXeniumRegionPath = (targetPath) => {
  const stats = fs.statSync(targetPath);
  if (!stats.isDirectory()) {
    throw new Error('Xenium datasets must be provided as a directory');
  }

  const hasExperiment = fs.existsSync(path.join(targetPath, 'experiment.xenium'));
  if (hasExperiment) {
    return targetPath;
  }

  const outsPath = path.join(targetPath, 'outs');
  if (fs.existsSync(outsPath) && fs.statSync(outsPath).isDirectory()) {
    const directExperiment = fs.existsSync(path.join(outsPath, 'experiment.xenium'));
    if (directExperiment) {
      return outsPath;
    }

    const subdirs = fs.readdirSync(outsPath);
    for (const subdir of subdirs) {
      const candidate = path.join(outsPath, subdir);
      if (fs.statSync(candidate).isDirectory()) {
        if (fs.existsSync(path.join(candidate, 'experiment.xenium'))) {
          return candidate;
        }
      }
    }
  }

  throw new Error(
    'Unable to locate experiment.xenium. Please select the Xenium run folder containing the outs directory or the specific region output.'
  );
};

ipcMain.handle('read-xenium-files', async (event, targetPath) => {
  try {
    if (!targetPath) {
      throw new Error('No path provided to read-xenium-files');
    }

    const regionPath = resolveXeniumRegionPath(targetPath);
    const { files, metadata } = inspectXeniumRegion(regionPath);

    return {
      success: true,
      format: '10X Xenium',
      regionPath,
      files,
      metadata,
    };
  } catch (error) {
    console.error('Error reading Xenium files:', error);
    return { success: false, error: error.message };
  }
});

// ================= Visium HD Support =================

/**
 * Resolve Visium HD data path: looks for segmented_outputs or binned_outputs
 * Priority: segmented_outputs > binned_outputs
 */
const resolveVisiumHDRegionPath = (targetPath) => {
  const stats = fs.statSync(targetPath);
  if (!stats.isDirectory()) {
    throw new Error('Visium HD datasets must be provided as a directory');
  }

  const chooseBinnedRegion = (binnedPath) => {
    if (!fs.existsSync(binnedPath) || !fs.statSync(binnedPath).isDirectory()) return null;
    const binDirs = fs.readdirSync(binnedPath).filter(d => {
      const fullPath = path.join(binnedPath, d);
      return fs.statSync(fullPath).isDirectory();
    });
    if (!binDirs.length) return null;
    const preferredBin = binDirs.find(d => d.includes('008um')) || binDirs[0];
    const binPath = path.join(binnedPath, preferredBin);
    return { regionPath: binPath, dataType: 'binned', binSize: preferredBin };
  };

  const inspectOutsLikeFolder = (outsLikePath) => {
    const segmentedPath = path.join(outsLikePath, 'segmented_outputs');
    if (fs.existsSync(segmentedPath) && fs.statSync(segmentedPath).isDirectory()) {
      return { regionPath: segmentedPath, dataType: 'segmented' };
    }

    const binnedPath = path.join(outsLikePath, 'binned_outputs');
    return chooseBinnedRegion(binnedPath);
  };

  // Accept either the outs folder itself or the parent sample folder containing outs.
  const directMatch = inspectOutsLikeFolder(targetPath);
  if (directMatch) return directMatch;

  const outsPath = path.join(targetPath, 'outs');
  if (fs.existsSync(outsPath) && fs.statSync(outsPath).isDirectory()) {
    const outsMatch = inspectOutsLikeFolder(outsPath);
    if (outsMatch) return outsMatch;
  }

  const baseName = path.basename(targetPath);
  if (baseName === 'segmented_outputs') {
    return { regionPath: targetPath, dataType: 'segmented' };
  }
  if (baseName === 'binned_outputs') {
    const binnedMatch = chooseBinnedRegion(targetPath);
    if (binnedMatch) return binnedMatch;
  }
  if (baseName.includes('square_')) {
    return { regionPath: targetPath, dataType: 'binned', binSize: baseName };
  }

  throw new Error(
    'Unable to locate Visium HD data. Please select the sample folder, its outs folder, segmented_outputs, binned_outputs, or a square_* bin folder.'
  );
};

/**
 * Inspect Visium HD segmented outputs region
 */
const inspectVisiumHDSegmented = (regionPath) => {
  const files = {};
  const metadata = { skipped: {}, sizes: {} };

  const MAX_READ_SIZE = 512 * 1024 * 1024; // 512 MB safety cap per file

  const readIfSmall = (absPath, logicalName, optional = false) => {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      if (!optional) {
        throw new Error(`${logicalName} not found at ${absPath}`);
      }
      return null;
    }
    const { size } = fs.statSync(absPath);
    metadata.sizes[logicalName] = size;
    if (size > MAX_READ_SIZE) {
      metadata.skipped[logicalName] = `Too large to load in-memory (${size} bytes)`;
      return null;
    }
    return readBinaryFile(absPath);
  };

  const readMaybeCsvGz = (absPath, logicalName, optional = false) => {
    const data = readIfSmall(absPath, logicalName, optional);
    if (!data) return null;
    const lower = absPath.toLowerCase();
    if (lower.endsWith('.csv.gz')) {
      try {
        const buf = Buffer.from(data);
        const unzipped = zlib.gunzipSync(buf);
        metadata.sizes[`${logicalName} (unzipped)`] = unzipped.length;
        return new Uint8Array(unzipped);
      } catch (e) {
        metadata.skipped[logicalName] = `Failed to gunzip: ${e.message}`;
        return null;
      }
    }
    return data;
  };

  // Read cell_segmentations.geojson (required for segmented data)
  const cellSegPath = path.join(regionPath, 'cell_segmentations.geojson');
  if (fs.existsSync(cellSegPath)) {
    const data = readIfSmall(cellSegPath, 'cell_segmentations.geojson');
    if (data) {
      files.cellSegmentation = {
        name: 'cell_segmentations.geojson',
        data,
      };
    }
  } else {
    throw new Error('cell_segmentations.geojson not found in segmented_outputs');
  }

  // For Visium HD, prefer MatrixMarket format over H5 because we can parse barcodes directly
  // This ensures proper cell ID matching with the spatial data
  const matrixDir = path.join(regionPath, 'filtered_feature_cell_matrix');
  if (fs.existsSync(matrixDir) && fs.statSync(matrixDir).isDirectory()) {
    try {
      const matrixFile = getExistingFile(matrixDir, ['matrix.mtx.gz', 'matrix.mtx'], 'matrix file');
      const featuresFile = getExistingFile(matrixDir, ['features.tsv.gz', 'features.tsv'], 'features file');
      const barcodesFile = getExistingFile(matrixDir, ['barcodes.tsv.gz', 'barcodes.tsv'], 'barcodes file');

      files.cellFeatureMatrix = {
        matrix: {
          name: `filtered_feature_cell_matrix/${matrixFile.name}`,
          data: readBinaryFile(matrixFile.absolutePath),
        },
        features: {
          name: `filtered_feature_cell_matrix/${featuresFile.name}`,
          data: readBinaryFile(featuresFile.absolutePath),
        },
        barcodes: {
          name: `filtered_feature_cell_matrix/${barcodesFile.name}`,
          data: readBinaryFile(barcodesFile.absolutePath),
        },
      };
      metadata.cellFeatureMatrixFormat = 'MatrixMarket';
    } catch (mtxError) {
      // Fall back to H5 if MatrixMarket files not found
      const h5Path = path.join(regionPath, 'filtered_feature_cell_matrix.h5');
      if (fs.existsSync(h5Path)) {
        const data = readIfSmall(h5Path, 'filtered_feature_cell_matrix.h5');
        if (data) {
          files.cellFeatureMatrix = {
            h5: {
              name: 'filtered_feature_cell_matrix.h5',
              data,
            },
          };
          metadata.cellFeatureMatrixFormat = 'HDF5';
        }
      }
    }
  } else {
    // No MatrixMarket directory, try H5 file directly
    const h5Path = path.join(regionPath, 'filtered_feature_cell_matrix.h5');
    if (fs.existsSync(h5Path)) {
      const data = readIfSmall(h5Path, 'filtered_feature_cell_matrix.h5');
      if (data) {
        files.cellFeatureMatrix = {
          h5: {
            name: 'filtered_feature_cell_matrix.h5',
            data,
          },
        };
        metadata.cellFeatureMatrixFormat = 'HDF5';
      }
    }
  }

  // Read analysis folder
  const analysisDir = path.join(regionPath, 'analysis');
  files.analysis = {};
  metadata.analysis = {};

  if (fs.existsSync(analysisDir) && fs.statSync(analysisDir).isDirectory()) {
    // Read UMAP coordinates
    const umapDir = path.join(analysisDir, 'umap', 'gene_expression_2_components');
    if (fs.existsSync(umapDir) && fs.statSync(umapDir).isDirectory()) {
      const projectionPath = path.join(umapDir, 'projection.csv');
      if (fs.existsSync(projectionPath)) {
        files.analysis.umap = {};
        const key = 'umap/gene_expression_2_components/projection.csv';
        files.analysis.umap[key] = {
          name: key,
          data: readBinaryFile(projectionPath),
        };
        metadata.analysis.umap = [key];
      }
    }

    // Read clustering results
    const clusterDir = path.join(analysisDir, 'clustering', 'gene_expression_graphclust');
    if (fs.existsSync(clusterDir) && fs.statSync(clusterDir).isDirectory()) {
      const clusterFile = getExistingFile(clusterDir, ['clusters.csv', 'clusters.csv.gz'], 'clusters', true);
      if (clusterFile) {
        const clusterData = readMaybeCsvGz(clusterFile.absolutePath, 'gene_expression_graphclust/clusters', true);
        if (clusterData) {
          files.analysis.clusters = {
            name: 'clustering/gene_expression_graphclust/' + clusterFile.name,
            data: clusterData,
          };
          metadata.analysis.clusters = files.analysis.clusters.name;
        }
      }
    }
  }

  return { files, metadata };
};

/**
 * Inspect Visium HD binned outputs region (older format without cell segmentation)
 * Data is in outs/binned_outputs/square_008um/
 */
const inspectVisiumHDBinned = (regionPath, binSize) => {
  const files = {};
  const metadata = { skipped: {}, sizes: {}, binSize };

  const MAX_READ_SIZE = 512 * 1024 * 1024; // 512 MB safety cap per file

  const readIfSmall = (absPath, logicalName, optional = false) => {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      if (!optional) {
        throw new Error(`${logicalName} not found at ${absPath}`);
      }
      return null;
    }
    const { size } = fs.statSync(absPath);
    metadata.sizes[logicalName] = size;
    if (size > MAX_READ_SIZE) {
      metadata.skipped[logicalName] = `Too large to load in-memory (${size} bytes)`;
      return null;
    }
    return readBinaryFile(absPath);
  };

  const readMaybeCsvGz = (absPath, logicalName, optional = false) => {
    const data = readIfSmall(absPath, logicalName, optional);
    if (!data) return null;
    const lower = absPath.toLowerCase();
    if (lower.endsWith('.csv.gz')) {
      try {
        const buf = Buffer.from(data);
        const unzipped = zlib.gunzipSync(buf);
        metadata.sizes[`${logicalName} (unzipped)`] = unzipped.length;
        return new Uint8Array(unzipped);
      } catch (e) {
        metadata.skipped[logicalName] = `Failed to gunzip: ${e.message}`;
        return null;
      }
    }
    return data;
  };

  // For binned data, read filtered_feature_bc_matrix (note: "bc" not "cell")
  const matrixDir = path.join(regionPath, 'filtered_feature_bc_matrix');
  if (fs.existsSync(matrixDir) && fs.statSync(matrixDir).isDirectory()) {
    try {
      const matrixFile = getExistingFile(matrixDir, ['matrix.mtx.gz', 'matrix.mtx'], 'matrix file');
      const featuresFile = getExistingFile(matrixDir, ['features.tsv.gz', 'features.tsv'], 'features file');
      const barcodesFile = getExistingFile(matrixDir, ['barcodes.tsv.gz', 'barcodes.tsv'], 'barcodes file');

      files.cellFeatureMatrix = {
        matrix: {
          name: `filtered_feature_bc_matrix/${matrixFile.name}`,
          data: readBinaryFile(matrixFile.absolutePath),
        },
        features: {
          name: `filtered_feature_bc_matrix/${featuresFile.name}`,
          data: readBinaryFile(featuresFile.absolutePath),
        },
        barcodes: {
          name: `filtered_feature_bc_matrix/${barcodesFile.name}`,
          data: readBinaryFile(barcodesFile.absolutePath),
        },
      };
      metadata.cellFeatureMatrixFormat = 'MatrixMarket';
    } catch (mtxError) {
      // Fall back to H5 if MatrixMarket files not found
      const h5Path = path.join(regionPath, 'filtered_feature_bc_matrix.h5');
      if (fs.existsSync(h5Path)) {
        const data = readIfSmall(h5Path, 'filtered_feature_bc_matrix.h5');
        if (data) {
          files.cellFeatureMatrix = {
            h5: {
              name: 'filtered_feature_bc_matrix.h5',
              data,
            },
          };
          metadata.cellFeatureMatrixFormat = 'HDF5';
        }
      }
    }
  } else {
    // No MatrixMarket directory, try H5 file directly
    const h5Path = path.join(regionPath, 'filtered_feature_bc_matrix.h5');
    if (fs.existsSync(h5Path)) {
      const data = readIfSmall(h5Path, 'filtered_feature_bc_matrix.h5');
      if (data) {
        files.cellFeatureMatrix = {
          h5: {
            name: 'filtered_feature_bc_matrix.h5',
            data,
          },
        };
        metadata.cellFeatureMatrixFormat = 'HDF5';
      }
    }
  }

  if (!files.cellFeatureMatrix) {
    throw new Error('Could not find feature matrix in binned_outputs. Expected filtered_feature_bc_matrix/ directory or .h5 file.');
  }

  // Read spatial coordinates from spatial/ folder
  const spatialDir = path.join(regionPath, 'spatial');
  if (fs.existsSync(spatialDir) && fs.statSync(spatialDir).isDirectory()) {
    // Try CSV first (we can parse it), then parquet as fallback
    const parquetPath = path.join(spatialDir, 'tissue_positions.parquet');
    const csvPath = path.join(spatialDir, 'tissue_positions.csv');
    const csvGzPath = path.join(spatialDir, 'tissue_positions.csv.gz');

    if (fs.existsSync(csvPath)) {
      const data = readIfSmall(csvPath, 'tissue_positions.csv', true);
      if (data) {
        files.tissuePositions = {
          name: 'spatial/tissue_positions.csv',
          data,
          format: 'csv',
        };
      }
    } else if (fs.existsSync(csvGzPath)) {
      const data = readMaybeCsvGz(csvGzPath, 'tissue_positions.csv.gz', true);
      if (data) {
        files.tissuePositions = {
          name: 'spatial/tissue_positions.csv.gz',
          data,
          format: 'csv',
        };
      }
    } else if (fs.existsSync(parquetPath)) {
      const data = readIfSmall(parquetPath, 'tissue_positions.parquet', true);
      if (data) {
        files.tissuePositions = {
          name: 'spatial/tissue_positions.parquet',
          data,
          format: 'parquet',
        };
      }
    }
  }

  // If no tissue positions found, look for barcode_mappings.parquet in parent directories
  // This file is typically at outs/barcode_mappings.parquet for Visium HD
  if (!files.tissuePositions) {
    // Go up from binned_outputs/square_XXXum to outs level
    const outsDir = path.dirname(path.dirname(regionPath));
    const barcodeMappingsPath = path.join(outsDir, 'barcode_mappings.parquet');


    if (fs.existsSync(barcodeMappingsPath)) {
      const data = readIfSmall(barcodeMappingsPath, 'barcode_mappings.parquet', true);
      if (data) {
        files.barcodeMappings = {
          name: 'barcode_mappings.parquet',
          data,
          format: 'parquet',
        };
      }
    }
  }

  // Read analysis folder (same structure as segmented)
  const analysisDir = path.join(regionPath, 'analysis');
  files.analysis = {};
  metadata.analysis = {};

  if (fs.existsSync(analysisDir) && fs.statSync(analysisDir).isDirectory()) {
    // Read UMAP coordinates
    const umapDir = path.join(analysisDir, 'umap', 'gene_expression_2_components');
    if (fs.existsSync(umapDir) && fs.statSync(umapDir).isDirectory()) {
      const projectionPath = path.join(umapDir, 'projection.csv');
      if (fs.existsSync(projectionPath)) {
        files.analysis.umap = {};
        const key = 'umap/gene_expression_2_components/projection.csv';
        files.analysis.umap[key] = {
          name: key,
          data: readBinaryFile(projectionPath),
        };
        metadata.analysis.umap = [key];
      }
    }

    // Read clustering results
    const clusterDir = path.join(analysisDir, 'clustering', 'gene_expression_graphclust');
    if (fs.existsSync(clusterDir) && fs.statSync(clusterDir).isDirectory()) {
      const clusterFile = getExistingFile(clusterDir, ['clusters.csv', 'clusters.csv.gz'], 'clusters', true);
      if (clusterFile) {
        const clusterData = readMaybeCsvGz(clusterFile.absolutePath, 'gene_expression_graphclust/clusters', true);
        if (clusterData) {
          files.analysis.clusters = {
            name: 'clustering/gene_expression_graphclust/' + clusterFile.name,
            data: clusterData,
          };
          metadata.analysis.clusters = files.analysis.clusters.name;
        }
      }
    }
  }

  return { files, metadata };
};

ipcMain.handle('read-visium-hd-files', async (event, targetPath) => {
  try {
    if (!targetPath) {
      throw new Error('No path provided to read-visium-hd-files');
    }

    const { regionPath, dataType, binSize } = resolveVisiumHDRegionPath(targetPath);

    let files, metadata;
    if (dataType === 'binned') {
      const result = inspectVisiumHDBinned(regionPath, binSize);
      files = result.files;
      metadata = result.metadata;
    } else {
      const result = inspectVisiumHDSegmented(regionPath);
      files = result.files;
      metadata = result.metadata;
    }

    const response = {
      success: true,
      format: '10X Visium HD',
      regionPath,
      dataType,
      files,
      metadata,
    };

    // Include bin size for binned data
    if (dataType === 'binned' && binSize) {
      response.binSize = binSize;
    }

    return response;
  } catch (error) {
    console.error('Error reading Visium HD files:', error);
    return { success: false, error: error.message };
  }
});

// ================= MERFISH Support =================

/**
 * Read MERFISH data files from a directory
 * Expected files:
 * cell_by_gene.csv: Gene expression counts matrix (cells x genes)
 * cell_metadata.csv: Spatial coordinates (EntityID, center_x, center_y, etc.)
 * cell_categories.csv: Clustering results (EntityID, leiden)
 * cell_numeric_categories.csv: UMAP coordinates (EntityID, umap_X, umap_Y)
 */
const inspectMERFISHRegion = (regionPath) => {
  const files = {};
  const metadata = { skipped: {}, sizes: {} };

  const MAX_READ_SIZE = 512 * 1024 * 1024; // 512 MB safety cap per file

  const readIfSmall = (absPath, logicalName, optional = false) => {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      if (!optional) {
        throw new Error(`${logicalName} not found at ${absPath}`);
      }
      return null;
    }
    const { size } = fs.statSync(absPath);
    metadata.sizes[logicalName] = size;
    if (size > MAX_READ_SIZE) {
      metadata.skipped[logicalName] = `Too large to load in-memory (${size} bytes)`;
      return null;
    }
    return readBinaryFile(absPath);
  };

  // Read counts file (cell_by_gene.csv): required
  const countsFile = getExistingFile(regionPath, ['cell_by_gene.csv'], 'cell_by_gene.csv');
  const countsData = readIfSmall(countsFile.absolutePath, 'cell_by_gene.csv');
  if (countsData) {
    files.counts = {
      name: countsFile.name,
      data: countsData,
    };
  }

  // Read spatial metadata file (cell_metadata.csv): required for coordinates
  const spatialFile = getExistingFile(regionPath, ['cell_metadata.csv'], 'cell_metadata.csv');
  const spatialData = readIfSmall(spatialFile.absolutePath, 'cell_metadata.csv');
  if (spatialData) {
    files.spatial = {
      name: spatialFile.name,
      data: spatialData,
    };
  }

  // Read clustering file (cell_categories.csv): optional
  const clusterFile = getExistingFile(regionPath, ['cell_categories.csv'], 'cell_categories.csv', true);
  if (clusterFile) {
    const clusterData = readIfSmall(clusterFile.absolutePath, 'cell_categories.csv', true);
    if (clusterData) {
      files.clusters = {
        name: clusterFile.name,
        data: clusterData,
      };
    }
  }

  // Read UMAP file (cell_numeric_categories.csv): optional
  const umapFile = getExistingFile(regionPath, ['cell_numeric_categories.csv'], 'cell_numeric_categories.csv', true);
  if (umapFile) {
    const umapData = readIfSmall(umapFile.absolutePath, 'cell_numeric_categories.csv', true);
    if (umapData) {
      files.umap = {
        name: umapFile.name,
        data: umapData,
      };
    }
  }

  return { files, metadata };
};

ipcMain.handle('read-merfish-files', async (event, targetPath) => {
  try {
    if (!targetPath) {
      throw new Error('No path provided to read-merfish-files');
    }

    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) {
      throw new Error('MERFISH datasets must be provided as a directory');
    }

    const { files, metadata } = inspectMERFISHRegion(targetPath);

    // Verify required files are present
    if (!files.counts) {
      throw new Error('cell_by_gene.csv not found in MERFISH directory');
    }
    if (!files.spatial) {
      throw new Error('cell_metadata.csv not found in MERFISH directory');
    }

    return {
      success: true,
      format: 'MERFISH',
      regionPath: targetPath,
      files,
      metadata,
    };
  } catch (error) {
    console.error('Error reading MERFISH files:', error);
    return { success: false, error: error.message };
  }
});

// ================= CosMX Support =================

/** Max size (bytes) for loading a CosMX file in-memory; larger files are stream-parsed. */
const COSMX_MAX_READ_SIZE = 512 * 1024 * 1024; // 512 MB

/** Compute a deterministic cache key for a CosMX dataset based on source file identity. */
function computeCosmxCacheKey(countsPath, metaPath) {
  const countsStat = fs.statSync(countsPath);
  const metaStat = fs.statSync(metaPath);
  const payload = JSON.stringify({
    countsPath,
    countsSize: countsStat.size,
    countsMtime: countsStat.mtimeMs,
    metaPath,
    metaSize: metaStat.size,
    metaMtime: metaStat.mtimeMs,
  });
  const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
  return 'cosmx-cache-' + hash;
}

/** Validate that a CosMX cache directory is still valid (source files haven't changed). */
function validateCosmxCache(cacheDir, countsPath, metaPath) {
  const manifestPath = path.join(cacheDir, 'cache-manifest.json');
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== 1) return false;
    const countsStat = fs.statSync(countsPath);
    const metaStat = fs.statSync(metaPath);
    if (manifest.countsSize !== countsStat.size) return false;
    if (manifest.countsMtimeMs !== countsStat.mtimeMs) return false;
    if (manifest.metaSize !== metaStat.size) return false;
    if (manifest.metaMtimeMs !== metaStat.mtimeMs) return false;
    for (const f of manifest.files) {
      if (!fs.existsSync(path.join(cacheDir, f))) return false;
    }
    return true;
  } catch (e) {
    console.warn('CosMX cache manifest validation failed:', e.message);
    return false;
  }
}

/**
 * Stream-parse CosMX expression CSV (*_exprMat_file.csv) without loading the whole file.
 * If targetDir is provided, output files are written there; otherwise a random directory is used.
 */
function streamParseCosMXExprMat(csvPath, targetDir) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const once = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      fn(...args);
    };

    const geneNames = [];
    const cellIds = [];
    let countsFovIdx = -1;
    let countsCellIdIdx = -1;
    let geneIndices = [];
    let cellIdx = 0;
    let lineNum = 0;
    let nnz = 0; // count non-zeros instead of storing them
    const PROGRESS_INTERVAL = 500000; // log every 500k data rows

    const trimQuotes = (s) => (s && typeof s === 'string' ? s.trim().replace(/^["']|["']$/g, '') : s);

    // Write sparse entries directly to a temp file instead of accumulating in memory.
    // Since cells are processed sequentially and genes in fixed order, output is already
    // in column-major order, no sort needed.
    const tempDataPath = path.join(os.tmpdir(), 'cellpilot-cosmx-data-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt');
    const dataWriter = fs.createWriteStream(tempDataPath, { encoding: 'utf8' });
    let dataWriterError = null;
    dataWriter.on('error', (err) => {
      dataWriterError = err;
    });

    const rawStream = fs.createReadStream(csvPath);
    const textStream = csvPath.toLowerCase().endsWith('.gz')
      ? rawStream.pipe(zlib.createGunzip())
      : rawStream;
    const rl = readline.createInterface({
      input: textStream,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        if (dataWriterError) {
          rl.close();
          once(reject)(dataWriterError);
          return;
        }
        lineNum++;
        const values = line.split(',').map((v) => trimQuotes(v));

        if (lineNum === 1) {
          const rawHeaders = values;
          countsFovIdx = rawHeaders.findIndex((h) => /^fov$/i.test(h.trim()));
          countsCellIdIdx = rawHeaders.findIndex((h) => /^cell_ID$/i.test(h.trim()) || /^cell_id$/i.test(h.trim()));
          if (countsCellIdIdx < 0) {
            countsCellIdIdx = rawHeaders.findIndex((h) => /^cell\s*id$/i.test(h.trim()));
          }
          if (countsFovIdx < 0 || countsCellIdIdx < 0) {
            rl.close();
            once(reject)(new Error('Could not find fov or cell_ID column in CosMX expression matrix'));
            return;
          }
          const idColumnIndices = new Set([countsFovIdx, countsCellIdIdx]);
          for (let i = 0; i < rawHeaders.length; i++) {
            if (idColumnIndices.has(i)) continue;
            const geneName = rawHeaders[i];
            if (!geneName.startsWith('NegPrb')) {
              geneIndices.push(i);
              geneNames.push(geneName);
            }
          }
          return;
        }

        const fov = values[countsFovIdx];
        const cellId = values[countsCellIdIdx];
        if (fov === undefined || cellId === undefined) {
          return; // skip malformed or short lines
        }
        cellIds.push(`${fov}_${cellId}`);

        // Write sparse entries directly to disk instead of pushing to an in-memory array.
        // Format: "row col val\n" (1-indexed, matching MatrixMarket coordinate format).
        const parts = [];
        for (let gIdx = 0; gIdx < geneIndices.length; gIdx++) {
          const origColIdx = geneIndices[gIdx];
          const countValue = parseInt(values[origColIdx], 10);
          if (!Number.isNaN(countValue) && countValue > 0) {
            parts.push(`${gIdx + 1} ${cellIdx + 1} ${countValue}\n`);
            nnz++;
          }
        }
        if (parts.length > 0) {
          // Batch-write all entries for this cell in a single write call for efficiency.
          // Handle back-pressure: pause readline if write buffer is full.
          const canContinue = dataWriter.write(parts.join(''));
          if (!canContinue) {
            rl.pause();
            dataWriter.once('drain', () => rl.resume());
          }
        }

        cellIdx++;
        if (cellIdx > 0 && cellIdx % PROGRESS_INTERVAL === 0) {
        }
      } catch (err) {
        rl.close();
        once(reject)(err);
      }
    });

    rl.on('close', () => {
      if (settled) return;
      const nGenes = geneNames.length;
      const nCells = cellIds.length;
      if (nCells === 0) {
        dataWriter.end(() => { try { fs.unlinkSync(tempDataPath); } catch (_) {} });
        once(reject)(new Error('CosMX expression matrix has no data rows'));
        return;
      }

      // Finish writing sparse data, then assemble the final gzipped MTX file
      dataWriter.end(() => {
        if (settled) return;
        if (dataWriterError) {
          try { fs.unlinkSync(tempDataPath); } catch (_) {}
          once(reject)(dataWriterError);
          return;
        }

        try {

          const featuresContent = geneNames.map((g) => `${g}\t${g}\tGene Expression`).join('\n');
          const barcodesContent = cellIds.join('\n');

          // Set up output directory (use targetDir if provided for caching, otherwise random)
          startCosmxTempServer();
          const cosmxDir = targetDir || path.join(getCosmxTempRoot(), 'cosmx-' + Date.now() + '-' + Math.random().toString(36).slice(2));
          fs.mkdirSync(cosmxDir, { recursive: true });

          // Stream-assemble and gzip the MTX file: header + size line + data from temp file
          const mtxGzPath = path.join(cosmxDir, 'matrix.mtx.gz');
          const gzipStream = zlib.createGzip();
          const mtxOut = fs.createWriteStream(mtxGzPath);

          mtxOut.on('error', (err) => {
            try { fs.unlinkSync(tempDataPath); } catch (_) {}
            once(reject)(err);
          });

          gzipStream.pipe(mtxOut);

          // Write MatrixMarket header
          const mmHeader = '%%MatrixMarket matrix coordinate integer general\n';
          const mmSizeLine = `${nGenes} ${nCells} ${nnz}\n`;
          gzipStream.write(mmHeader);
          gzipStream.write(mmSizeLine);

          // Stream the sparse data from the temp file through the gzip pipeline
          const dataReadStream = fs.createReadStream(tempDataPath, { encoding: 'utf8' });
          dataReadStream.on('error', (err) => {
            try { fs.unlinkSync(tempDataPath); } catch (_) {}
            once(reject)(err);
          });

          dataReadStream.on('data', (chunk) => {
            if (!gzipStream.write(chunk)) {
              dataReadStream.pause();
              gzipStream.once('drain', () => dataReadStream.resume());
            }
          });

          dataReadStream.on('end', () => {
            gzipStream.end();
          });

          mtxOut.on('finish', () => {
            // Clean up temp data file
            try { fs.unlinkSync(tempDataPath); } catch (_) {}
            if (settled) return;

            try {
              const featuresGz = zlib.gzipSync(Buffer.from(featuresContent, 'utf8'));
              const barcodesGz = zlib.gzipSync(Buffer.from(barcodesContent, 'utf8'));
              fs.writeFileSync(path.join(cosmxDir, 'features.tsv.gz'), featuresGz);
              fs.writeFileSync(path.join(cosmxDir, 'barcodes.tsv.gz'), barcodesGz);
              fs.writeFileSync(path.join(cosmxDir, 'cellIds.json'), JSON.stringify(cellIds), 'utf8');

              const base = 'http://localhost:' + COSMX_TEMP_PORT + '/cosmx-temp/' + path.basename(cosmxDir);
              once(resolve)({
                preparsedUrls: {
                  matrix: base + '/matrix.mtx.gz',
                  features: base + '/features.tsv.gz',
                  barcodes: base + '/barcodes.tsv.gz',
                  cellIds: base + '/cellIds.json',
                },
              });
            } catch (err) {
              once(reject)(err);
            }
          });
        } catch (err) {
          try { fs.unlinkSync(tempDataPath); } catch (_) {}
          once(reject)(err);
        }
      });
    });

    rl.on('error', (err) => {
      try { fs.unlinkSync(tempDataPath); } catch (_) {}
      once(reject)(err);
    });
  });
}

/**
 * Read NanoString CosMX data files from a directory
 * Expected files:
 * *_exprMat_file.csv: Gene expression counts matrix (cells x genes)
 *   Columns: fov, cell_ID, <gene1>, <gene2>, ..., NegPrb3, NegPrb5, ...
 * *_metadata_file.csv: Spatial coordinates and cell metadata
 *   Columns: fov, cell_ID, Area, ..., CenterX_global_px, CenterY_global_px, ...
 * For expression files larger than COSMX_MAX_READ_SIZE, the CSV is stream-parsed in the main process
 * and the parsed MatrixMarket + features + barcodes are passed as preparsed blobs.
 */
async function inspectCosMXRegion(regionPath) {
  const files = {};
  const metadata = { skipped: {}, sizes: {} };

  const readIfSmall = (absPath, logicalName, optional = false) => {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      if (!optional) {
        throw new Error(`${logicalName} not found at ${absPath}`);
      }
      return null;
    };
    const { size } = fs.statSync(absPath);
    metadata.sizes[logicalName] = size;
    if (size > COSMX_MAX_READ_SIZE) {
      metadata.skipped[logicalName] = `Too large to load in-memory (${size} bytes); will stream-parse`;
      return null;
    }
    const raw = readBinaryFile(absPath);
    // Decompress gzip on the fly so the worker always receives plain CSV bytes
    if (absPath.toLowerCase().endsWith('.gz')) {
      return new Uint8Array(zlib.gunzipSync(Buffer.from(raw)));
    }
    return raw;
  };

  // Find the exprMat_file.csv(.gz) and metadata_file.csv(.gz) by suffix
  const dirEntries = fs.readdirSync(regionPath);

  const exprMatFile =
    dirEntries.find((f) => f.toLowerCase().endsWith('exprmat_file.csv')) ||
    dirEntries.find((f) => f.toLowerCase().endsWith('exprmat_file.csv.gz'));
  if (!exprMatFile) {
    throw new Error('Could not find *_exprMat_file.csv or *_exprMat_file.csv.gz in CosMX directory');
  }

  const metadataFile =
    dirEntries.find((f) => f.toLowerCase().endsWith('metadata_file.csv')) ||
    dirEntries.find((f) => f.toLowerCase().endsWith('metadata_file.csv.gz'));
  if (!metadataFile) {
    throw new Error('Could not find *_metadata_file.csv or *_metadata_file.csv.gz in CosMX directory');
  }

  const countsPath = path.join(regionPath, exprMatFile);
  const metaPath = path.join(regionPath, metadataFile);

  // --- Cache check: reuse previously parsed data if source files haven't changed ---
  const cacheKey = computeCosmxCacheKey(countsPath, metaPath);
  const cacheDir = path.join(getCosmxTempRoot(), cacheKey);

  if (fs.existsSync(cacheDir) && validateCosmxCache(cacheDir, countsPath, metaPath)) {
    startCosmxTempServer();

    const base = 'http://localhost:' + COSMX_TEMP_PORT + '/cosmx-temp/' + cacheKey;
    const countsSize = fs.statSync(countsPath).size;
    const metaSize = fs.statSync(metaPath).size;
    metadata.sizes[exprMatFile] = countsSize;
    metadata.sizes[metadataFile] = metaSize;

    files.counts = {
      name: exprMatFile,
      preparsedUrls: {
        matrix: base + '/matrix.mtx.gz',
        features: base + '/features.tsv.gz',
        barcodes: base + '/barcodes.tsv.gz',
        cellIds: base + '/cellIds.json',
      },
    };

    // Read cached spatial metadata binary
    const cachedSpatialPath = path.join(cacheDir, 'spatial_metadata.bin');
    files.spatial = { name: metadataFile, data: readBinaryFile(cachedSpatialPath) };

    return { files, metadata };
  }


  // --- Cache miss: parse from source ---
  const countsSize = fs.statSync(countsPath).size;
  metadata.sizes[exprMatFile] = countsSize;

  if (countsSize <= COSMX_MAX_READ_SIZE) {
    const countsData = readIfSmall(countsPath, exprMatFile);
    if (countsData) {
      files.counts = { name: exprMatFile, data: countsData };
    }
  } else {
    const preparsed = await streamParseCosMXExprMat(countsPath, cacheDir);
    files.counts = {
      name: exprMatFile,
      preparsedUrls: preparsed.preparsedUrls,
    };
  }

  const metaData = readIfSmall(metaPath, metadataFile);
  if (metaData) {
    files.spatial = { name: metadataFile, data: metaData };
  } else if (!files.spatial && fs.existsSync(metaPath) && fs.statSync(metaPath).isFile()) {
    const metaSize = fs.statSync(metaPath).size;
    metadata.sizes[metadataFile] = metaSize;
    if (metaSize > COSMX_MAX_READ_SIZE) {
      metadata.skipped[metadataFile] = `Too large to load in-memory (${metaSize} bytes)`;
    }
  }

  // --- Write cache for future loads ---
  if (files.counts && files.counts.preparsedUrls && files.spatial && files.spatial.data) {
    try {
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      // Cache spatial metadata binary
      fs.writeFileSync(path.join(cacheDir, 'spatial_metadata.bin'), files.spatial.data);
      // Write validation manifest
      const countsStat = fs.statSync(countsPath);
      const metaStat = fs.statSync(metaPath);
      const manifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        countsPath,
        countsSize: countsStat.size,
        countsMtimeMs: countsStat.mtimeMs,
        metaPath,
        metaSize: metaStat.size,
        metaMtimeMs: metaStat.mtimeMs,
        files: ['matrix.mtx.gz', 'features.tsv.gz', 'barcodes.tsv.gz', 'cellIds.json', 'spatial_metadata.bin'],
      };
      fs.writeFileSync(path.join(cacheDir, 'cache-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    } catch (cacheErr) {
      console.warn('Failed to write CosMX cache (non-fatal):', cacheErr.message);
    }
  }

  return { files, metadata };
}

// CosMX load can take a long time for huge CSVs; timeout so we always send a reply.
const COSMX_LOAD_TIMEOUT_MS = 120 * 60 * 1000; // 2 hours

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message || 'Operation timed out')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}

ipcMain.handle('read-cosmx-files', async (event, targetPath) => {
  const sendReply = (result) => {
    if (result && typeof result === 'object' && result.success === false) {
      console.error('CosMX read error:', result.error);
    }
    return result;
  };

  try {
    if (!targetPath) {
      return sendReply({ success: false, error: 'No path provided to read-cosmx-files' });
    }

    let stats;
    try {
      stats = fs.statSync(targetPath);
    } catch (statErr) {
      return sendReply({ success: false, error: statErr.message || 'Invalid path' });
    }
    if (!stats.isDirectory()) {
      return sendReply({ success: false, error: 'CosMX datasets must be provided as a directory' });
    }

    const result = await withTimeout(
      (async () => {
        const { files, metadata } = await inspectCosMXRegion(targetPath);

        if (!files.counts) {
          throw new Error('Expression matrix file (*_exprMat_file.csv) not found or too large in CosMX directory');
        }
        if (!files.spatial) {
          throw new Error('Metadata file (*_metadata_file.csv) not found or too large in CosMX directory');
        }

        return {
          success: true,
          format: 'CosMX',
          regionPath: targetPath,
          files,
          metadata,
        };
      })(),
      COSMX_LOAD_TIMEOUT_MS,
      'CosMX load timed out after 2 hours. The expression file may be too large or the disk may be slow.'
    ).catch((error) => {
      const errMsg = error && (error.message || String(error));
      console.error('Error reading CosMX files:', error);
      return { success: false, error: errMsg };
    });

    return sendReply(result);
  } catch (error) {
    const errMsg = error && (error.message || String(error));
    console.error('Error reading CosMX files (outer catch):', error);
    return sendReply({ success: false, error: errMsg });
  }
});

// List directory contents
ipcMain.handle('list-directory', async (event, dirPath) => {
  try {
    const files = fs.readdirSync(dirPath);
    return { success: true, files };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Check if path exists
ipcMain.handle('path-exists', async (event, checkPath) => {
  try {
    return fs.existsSync(checkPath);
  } catch (error) {
    return false;
  }
});

// Get app path for storing models
ipcMain.handle('get-app-path', async () => {
  return app.getPath('userData');
});

// Get current session info (optional, for displaying in UI)
ipcMain.handle('get-session-info', async () => {
  const now = new Date();
  const startTime = new Date(sessionData.startTime);
  const currentDurationMs = now - startTime;

  return {
    sessionId: sessionData.sessionId,
    startTime: sessionData.startTime,
    currentDurationMs,
    currentDurationSeconds: Math.round(currentDurationMs / 1000),
  };
});

// Save CellPilot analysis results (UMAP coords + clusters) to the input folder
ipcMain.handle('save-cellpilot-results', async (event, folderPath, results) => {
  try {
    const filePath = path.join(folderPath, 'cellpilot_results.json');
    fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    console.error('Failed to save CellPilot results:', error);
    return { success: false, error: error.message };
  }
});

// Synchronous save used by beforeunload handler so data is never lost on app close
ipcMain.on('save-cellpilot-results-sync', (event, folderPath, results) => {
  try {
    const filePath = path.join(folderPath, 'cellpilot_results.json');
    fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf8');
    event.returnValue = true;
  } catch (error) {
    console.error('Failed to save CellPilot results (sync):', error);
    event.returnValue = false;
  }
});

// Check if CellPilot results exist in a folder and return them
ipcMain.handle('check-cellpilot-results', async (event, folderPath) => {
  try {
    const filePath = path.join(folderPath, 'cellpilot_results.json');
    if (!fs.existsSync(filePath)) {
      return { success: false };
    }
    const data = fs.readFileSync(filePath, 'utf8');
    const results = JSON.parse(data);
    return { success: true, results };
  } catch (error) {
    console.error('Failed to check CellPilot results:', error);
    return { success: false };
  }
});

// Convert TIFF to DZI and return URL
ipcMain.handle('convert-tiff-to-dzi', async (event, imagePath, transformMatrix = null) => {
  try {
    
    // Ensure TILE_ROOT is initialized
    if (!TILE_ROOT) {
      TILE_ROOT = path.join(app.getPath('userData'), 'dzi-tiles');
      // Start tile server if not already running
      if (!tileServer) {
        startTileServer();
      }
    }
    
    if (transformMatrix) {
    }
    
    // Verify input file exists
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Input file does not exist: ${imagePath}`);
    }
    
    const { dziPath, tilesDir, width, height, offset, scale, angle, matrix } = await tiffToDzi(imagePath, TILE_ROOT, transformMatrix);

    const baseName = path.parse(imagePath).name;

    // Use HTTP URL for tiles: OpenSeadragon works better with HTTP
    // Express server sets Cross-Origin-Resource-Policy: cross-origin header
    // which allows tiles to work with COEP credentialless on the main document
    const dziUrl = `http://localhost:${TILE_PORT}/tiles/${baseName}.dzi`;


    return {
      success: true,
      dziUrl,
      width,
      height,
      baseName,
      offset,
      scale,
      angle,
      transformMatrix: matrix,  // Pass the full transformation matrix to frontend
    };
  } catch (error) {
    console.error('=== Error Converting TIFF to DZI ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    return { success: false, error: error.message };
  }
});

// Load image file (TIFF or other image formats)
// For large TIFF files, this will convert to DZI format and return HTTP URL
ipcMain.handle('load-image-file', async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'Image file not found' };
    }
    
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const stats = fs.statSync(filePath);
    const fileSizeMB = stats.size / 1024 / 1024;
    
    // Check if sharp is available
    let sharpAvailable = false;
    let sharpError = null;
    try {
      require.resolve('sharp');
      // Try to actually require it to make sure it works
      try {
        require('sharp');
        sharpAvailable = true;
      } catch (requireError) {
        sharpError = requireError.message;
        console.error('Sharp module found but failed to load:', requireError.message);
        console.error('This might require a rebuild. Try: npm rebuild sharp');
      }
    } catch (resolveError) {
      sharpAvailable = false;
      sharpError = 'Sharp module not found';
    }
    
    // For very large images, we must use sharp and file:// URLs instead of base64
    const LARGE_IMAGE_THRESHOLD = 100 * 1024 * 1024; // 100MB
    const useFileUrl = stats.size > LARGE_IMAGE_THRESHOLD;
    
    if (useFileUrl && !sharpAvailable) {
      let errorMessage = `Large image file (${fileSizeMB.toFixed(1)}MB) requires the sharp library.\n\n`;
      
      if (sharpError) {
        errorMessage += `Error details: ${sharpError}\n\n`;
      }
      
      errorMessage += `To fix this issue:\n`;
      errorMessage += `1. Install sharp: npm install sharp\n`;
      errorMessage += `2. Rebuild for Electron: npx electron-rebuild -f -w sharp\n`;
      errorMessage += `3. Restart the Electron app\n\n`;
      errorMessage += `Note: Sharp is already in package.json. If it's installed, you may just need to rebuild it for Electron.`;
      
      console.error('Sharp not available for large image:', {
        fileSizeMB: fileSizeMB.toFixed(1),
        sharpError,
        sharpAvailable,
      });
      
      return {
        success: false,
        error: errorMessage
      };
    }
    
    let imageWidth = 0;
    let imageHeight = 0;
    let mimeType = 'image/png';
    let dataUrl = null;
    let fileUrl = null;
    
    // Determine MIME type
    if (ext === '.tiff' || ext === '.tif') {
      mimeType = 'image/tiff';
    } else if (ext === '.jpg' || ext === '.jpeg') {
      mimeType = 'image/jpeg';
    } else if (ext === '.png') {
      mimeType = 'image/png';
    }
    
    if (sharpAvailable) {
      try {
        const sharp = require('sharp');
        
        // Log the environment variable value to verify it's set correctly
        
        // Environment variable should already be set at process startup
        // For very large TIFF files, use tiling to create a DeepZoom pyramid
        // This processes the image in tiles and should avoid pixel limit issues
        if (useFileUrl && (ext === '.tiff' || ext === '.tif')) {
          // For large TIFF files, create tiled pyramid
          const tempDir = path.dirname(filePath);
          const tempFileName = `${path.basename(filePath, ext)}_converted.jpg`;
          const tempPath = path.join(tempDir, tempFileName);
          const dzOutputDir = tempPath.replace(/\.(jpg|jpeg)$/i, '_dz');
          
          // Check if converted file or DZI already exists
          let useExisting = false;
          let useDZI = false;
          
          // Check for existing DZI
          if (fs.existsSync(dzOutputDir)) {
            const dziXmlPath = path.join(dzOutputDir, 'dzc_output.xml');
            if (fs.existsSync(dziXmlPath)) {
              const dziStats = fs.statSync(dziXmlPath);
              const originalStats = fs.statSync(filePath);
              if (dziStats.mtime > originalStats.mtime) {
                useExisting = true;
                useDZI = true;
                // Read dimensions from DZI XML
                try {
                  const dziXml = fs.readFileSync(dziXmlPath, 'utf8');
                  const widthMatch = dziXml.match(/Width="(\d+)"/);
                  const heightMatch = dziXml.match(/Height="(\d+)"/);
                  if (widthMatch && heightMatch) {
                    imageWidth = parseInt(widthMatch[1], 10);
                    imageHeight = parseInt(heightMatch[1], 10);
                  }
                } catch (e) {
                  console.warn('Could not read DZI XML:', e.message);
                }
              }
            }
          }
          
          // Check for existing converted JPEG
          if (!useExisting && fs.existsSync(tempPath)) {
            const tempStats = fs.statSync(tempPath);
            const originalStats = fs.statSync(filePath);
            if (tempStats.mtime > originalStats.mtime) {
              useExisting = true;
              // Get metadata from converted file
              try {
                const convertedImage = sharp(tempPath);
                const convertedMetadata = await convertedImage.metadata();
                imageWidth = convertedMetadata.width || 0;
                imageHeight = convertedMetadata.height || 0;
              } catch (e) {
                console.warn('Could not read metadata from converted file:', e.message);
              }
            }
          }
          
          if (!useExisting) {
            
            try {
              // Create output directory for DeepZoom tiles
              if (!fs.existsSync(dzOutputDir)) {
                fs.mkdirSync(dzOutputDir, { recursive: true });
              }
              
              // Use Sharp's tile() method to create DeepZoom pyramid
              // Tile() processes images in chunks and should work even for very large images
              // Note: We don't read metadata first; tile() handles it internally
              const startTime = Date.now();
              
              // Create tile image with very high pixel limit
              // Use both environment variable (set at startup) and per-instance option
              const tileImage = sharp(filePath);
              
              // Create DeepZoom pyramid: processes image tile by tile
              // This should work even for very large images because it processes in chunks
              await tileImage
                .tile({
                  size: 512, // Tile size in pixels
                  overlap: 0, // No overlap between tiles
                  layout: 'dz', // DeepZoom layout
                  container: 'fs', // Filesystem container
                  format: 'jpeg',
                  quality: 90
                })
                .toFile(dzOutputDir);
              
              const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
              
              // Read dimensions from DZI XML file
              const dziXmlPath = path.join(dzOutputDir, 'dzc_output.xml');
              if (fs.existsSync(dziXmlPath)) {
                try {
                  const dziXml = fs.readFileSync(dziXmlPath, 'utf8');
                  const widthMatch = dziXml.match(/Width="(\d+)"/);
                  const heightMatch = dziXml.match(/Height="(\d+)"/);
                  if (widthMatch && heightMatch) {
                    imageWidth = parseInt(widthMatch[1], 10);
                    imageHeight = parseInt(heightMatch[1], 10);
                  }
                } catch (e) {
                  console.warn('Could not read DZI XML:', e.message);
                }
              }
              
              useDZI = true;
              const normalizedPath = dzOutputDir.replace(/\\/g, '/');
              fileUrl = `file:///${normalizedPath}`;
              mimeType = 'image/dzi';
              
            } catch (tileError) {
              console.error('DeepZoom pyramid creation error:', tileError);
              console.error('Error details:', tileError.message);
              
              // If tiling fails due to pixel limit, try direct conversion as fallback
              if (tileError.message && tileError.message.includes('pixel limit')) {
                
                try {
                  // Try direct conversion with maximum pixel limit
                  const conversionImage = sharp(filePath, {
                    limitInputPixels: 10000000000 // 10 billion pixels
                  });
                  
                  const startTime = Date.now();
                  await conversionImage
                    .jpeg({ 
                      quality: 90, 
                      progressive: true,
                      mozjpeg: true
                    })
                    .toFile(tempPath);
                  
                  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
                  
                  // Get metadata from converted file
                  try {
                    const convertedImage = sharp(tempPath);
                    const convertedMetadata = await convertedImage.metadata();
                    imageWidth = convertedMetadata.width || 0;
                    imageHeight = convertedMetadata.height || 0;
                  } catch (e) {
                    console.warn('Could not read metadata from converted file:', e.message);
                  }
                  
                  const normalizedPath = tempPath.replace(/\\/g, '/');
                  fileUrl = `file:///${normalizedPath}`;
                  mimeType = 'image/jpeg';
                  
                } catch (conversionError) {
                  // Both tiling and direct conversion failed
                  console.error('Both tiling and direct conversion failed:', conversionError);
                  
                  if (conversionError.message && conversionError.message.includes('pixel limit')) {
                    // The image is too large for Sharp to process
                    // Provide helpful error message with instructions
                    const errorMessage = `Image is too large (${fileSizeMB.toFixed(1)}MB). The image exceeds Sharp's pixel limit.\n\n` +
                      `The environment variable SHARP_LIMIT_INPUT_PIXELS is set to 10 billion pixels, but the image still exceeds this limit.\n\n` +
                      `For very large histology images, please pre-process the image using one of these methods:\n\n` +
                      `1. Using VIPS (recommended - handles very large images):\n` +
                      `   vips dzsave "${filePath}" "${path.join(path.dirname(filePath), 'output.dzi')}"\n\n` +
                      `2. Or using ImageMagick:\n` +
                      `   convert "${filePath}" -define tiff:tile-geometry=512x512 -compress jpeg "${tempPath}"\n\n` +
                      `After preprocessing, you can load the pre-processed file instead of the original TIFF.\n\n` +
                      `Alternatively, you can reduce the image resolution or split it into smaller regions.`;
                    
                    return {
                      success: false,
                      error: errorMessage
                    };
                  }
                  
                  return {
                    success: false,
                    error: `Failed to process large TIFF file: ${conversionError.message}`
                  };
                }
              } else {
                // Other error during tiling
                return {
                  success: false,
                  error: `Failed to create DeepZoom pyramid: ${tileError.message}`
                };
              }
            }
          }
          
          // Set file URL if not already set
          if (!fileUrl) {
            if (useDZI) {
              const normalizedPath = dzOutputDir.replace(/\\/g, '/');
              fileUrl = `file:///${normalizedPath}`;
              mimeType = 'image/dzi';
            } else {
              const normalizedPath = tempPath.replace(/\\/g, '/');
              fileUrl = `file:///${normalizedPath}`;
              mimeType = 'image/jpeg';
            }
          }
          
        } else if (useFileUrl) {
          // For other large formats (non-TIFF), use file:// URL directly
          const normalizedPath = filePath.replace(/\\/g, '/');
          fileUrl = `file:///${normalizedPath}`;
          
          // Try to get metadata for non-TIFF large files
          try {
            const image = sharp(filePath, { limitInputPixels: 10000000000 });
            const metadata = await image.metadata();
            imageWidth = metadata.width || 0;
            imageHeight = metadata.height || 0;
          } catch (e) {
            console.warn('Could not read metadata for large non-TIFF file:', e.message);
          }
        } else {
          // For smaller images, try to get metadata and convert to base64
          try {
            const image = sharp(filePath, { limitInputPixels: 10000000000 });
            const metadata = await image.metadata();
            imageWidth = metadata.width || 0;
            imageHeight = metadata.height || 0;
            
            if (ext === '.tiff' || ext === '.tif') {
              const imageData = await image.png().toBuffer();
              const base64Data = imageData.toString('base64');
              dataUrl = `data:image/png;base64,${base64Data}`;
              mimeType = 'image/png';
            } else {
              const imageData = await image.toBuffer();
              const base64Data = imageData.toString('base64');
              dataUrl = `data:${mimeType};base64,${base64Data}`;
            }
          } catch (e) {
            console.error('Error processing small image:', e);
            return {
              success: false,
              error: `Failed to process image: ${e.message}`
            };
          }
        }
      } catch (sharpError) {
        console.error('Error using sharp:', sharpError);
        console.error('Error stack:', sharpError.stack);
        
        // Check if it's a pixel limit error
        if (sharpError.message && sharpError.message.includes('pixel limit')) {
          return {
            success: false,
            error: `Image is too large (${fileSizeMB.toFixed(1)}MB). Sharp cannot process images exceeding its pixel limit. For very large histology images, consider preprocessing the image into a tiled format.`
          };
        }
        
        // Fall through to file-based approach if sharp fails
        if (useFileUrl) {
          if (ext !== '.tiff' && ext !== '.tif') {
            const normalizedPath = filePath.replace(/\\/g, '/');
            fileUrl = `file:///${normalizedPath}`;
          } else {
            return {
              success: false,
              error: `Failed to process large TIFF file: ${sharpError.message}. The image may exceed Sharp's processing capabilities.`
            };
          }
        } else {
          return {
            success: false,
            error: `Failed to process image with sharp: ${sharpError.message}`
          };
        }
      }
    } else {
      // Sharp not available: only handle small non-TIFF files
      if (ext === '.tiff' || ext === '.tif') {
        return {
          success: false,
          error: 'TIFF files require the sharp library. Please install it with: npm install sharp'
        };
      }
      
      if (useFileUrl) {
        // For large files without sharp, use file URL directly
        // Normalize path for file:// URL
        const normalizedPath = filePath.replace(/\\/g, '/');
        fileUrl = `file:///${normalizedPath}`;
      } else {
        // Read small files directly
        try {
          const data = fs.readFileSync(filePath);
          const base64Data = data.toString('base64');
          dataUrl = `data:${mimeType};base64,${base64Data}`;
        } catch (readError) {
          console.error('Error reading image file:', readError);
          return {
            success: false,
            error: `Failed to read image file: ${readError.message}`
          };
        }
      }
    }
    
    // If we don't have dimensions yet and have a file URL, try to get them
    if ((!imageWidth || !imageHeight) && fileUrl) {
      // For file URLs, dimensions will be loaded in the renderer
      // We'll return 0 and let the renderer handle it
    }
    
    return {
      success: true,
      dataUrl: dataUrl || undefined,
      fileUrl: fileUrl || undefined,
      fileName,
      filePath,
      size: stats.size,
      width: imageWidth,
      height: imageHeight,
      mimeType,
      useFileUrl,
    };
  } catch (error) {
    console.error('Error loading image file:', error);
    console.error('Error stack:', error.stack);
    return {
      success: false,
      error: error.message || 'Unknown error occurred while loading image'
    };
  }
});

// Load transformation matrix from CSV
ipcMain.handle('load-transformation-matrix', async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'Matrix file not found' };
    }
    
    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.trim().split('\n');
    
    // Parse 3x3 matrix from CSV
    // Expected format: 3 rows, 3 columns (comma or space separated)
    const matrix = [];
    for (const line of lines) {
      const values = line.split(/[,\s]+/).filter(v => v.trim() !== '').map(parseFloat);
      if (values.length === 3) {
        matrix.push(values);
      }
    }
    
    if (matrix.length !== 3) {
      return { success: false, error: 'Matrix must be 3x3' };
    }
    
    return {
      success: true,
      matrix,
    };
  } catch (error) {
    console.error('Error loading transformation matrix:', error);
    return { success: false, error: error.message };
  }
});

// Select histology image file
ipcMain.handle('select-histology-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Select Histology Image',
    filters: [
      { name: 'Image Files', extensions: ['tif', 'tiff', 'png', 'jpg', 'jpeg'] },
      { name: 'TIFF Files', extensions: ['tif', 'tiff'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// Select transformation matrix file (CSV)
ipcMain.handle('select-transformation-matrix', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Select Transformation Matrix',
    filters: [
      { name: 'CSV Files', extensions: ['csv', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// ============================================================================
// ATAC-seq Fragment Query Handler
// ============================================================================
// Query fragments.tsv.gz for a specific genomic region. Supports both:
// 1. tabix (if installed): fast random access via index
// 2. Streaming fallback: reads through the bgzip file
// ============================================================================

/**
 * Pure JavaScript tabix query using @gmod/tabix.
 * Reads the .tbi index to do random-access into the bgzf file, no CLI tools needed.
 */
async function queryFragmentsWithJsTabix(fragmentsPath, tbiPath, region, cellBarcodes) {
  const { TabixIndexedFile } = require('@gmod/tabix');

  // Custom file handle compatible with @gmod/tabix and Node.js
  class NodeFileHandle {
    constructor(filePath) {
      this.filePath = filePath;
      this.fd = null;
    }
    async read(length, position) {
      if (!this.fd) this.fd = fs.openSync(this.filePath, 'r');
      const buf = Buffer.alloc(length);
      fs.readSync(this.fd, buf, 0, length, position);
      return buf;
    }
    async readFile() {
      return fs.readFileSync(this.filePath);
    }
    async stat() {
      return fs.statSync(this.filePath);
    }
    async close() {
      if (this.fd) { fs.closeSync(this.fd); this.fd = null; }
    }
  }

  const tbiFile = new TabixIndexedFile({
    filehandle: new NodeFileHandle(fragmentsPath),
    tbiFilehandle: new NodeFileHandle(tbiPath),
  });

  const rawChrom = String(region.chrom);
  const chrom = rawChrom.toLowerCase().startsWith('chr') ? rawChrom : `chr${rawChrom}`;
  const barcodeSet = cellBarcodes instanceof Set ? cellBarcodes :
                     (Array.isArray(cellBarcodes) ? new Set(cellBarcodes) : null);

  const fragments = [];
  await tbiFile.getLines(chrom, region.start, region.end, (line) => {
    const parts = line.split('\t');
    if (parts.length < 4) return;
    const barcode = parts[3];
    if (barcodeSet && !barcodeSet.has(barcode)) return;
    fragments.push({
      chrom: parts[0],
      start: parseInt(parts[1], 10),
      end: parseInt(parts[2], 10),
      barcode,
      count: parts[4] ? parseInt(parts[4], 10) : 1,
    });
  });

  return fragments;
}

async function queryFragmentsWithTabix(fragmentsPath, region, cellBarcodes) {
  const { spawn } = require('child_process');

  return new Promise((resolve, reject) => {
    // Ensure chromosome has "chr" prefix (10x fragments.tsv.gz uses this format)
    const rawChrom = String(region.chrom);
    const chrom = rawChrom.toLowerCase().startsWith('chr') ? rawChrom : `chr${rawChrom}`;
    const regionStr = `${chrom}:${region.start}-${region.end}`;
    const tabix = spawn('tabix', [fragmentsPath, regionStr]);

    const fragments = [];
    const barcodeSet = cellBarcodes instanceof Set ? cellBarcodes :
                       (Array.isArray(cellBarcodes) ? new Set(cellBarcodes) : null);
    let totalLines = 0;
    let filteredOut = 0;
    let firstUnmatchedBarcode = null;

    let buffer = '';

    tabix.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 4) continue;

        const [chrom, startStr, endStr, barcode] = parts;
        const count = parts[4] ? parseInt(parts[4], 10) : 1;
        totalLines++;

        // Filter by cell barcode if provided
        if (barcodeSet && !barcodeSet.has(barcode)) {
          filteredOut++;
          if (!firstUnmatchedBarcode) firstUnmatchedBarcode = barcode;
          continue;
        }

        fragments.push({
          chrom,
          start: parseInt(startStr, 10),
          end: parseInt(endStr, 10),
          barcode,
          count,
        });
      }
    });

    tabix.stderr.on('data', (data) => {
      console.warn('tabix stderr:', data.toString());
    });

    tabix.on('close', (code) => {
      // Process any remaining buffer
      if (buffer.trim()) {
        const parts = buffer.split('\t');
        if (parts.length >= 4) {
          const [chrom, startStr, endStr, barcode] = parts;
          const count = parts[4] ? parseInt(parts[4], 10) : 1;
          const barcodeSet = cellBarcodes instanceof Set ? cellBarcodes :
                             (Array.isArray(cellBarcodes) ? new Set(cellBarcodes) : null);
          if (!barcodeSet || barcodeSet.has(barcode)) {
            fragments.push({
              chrom,
              start: parseInt(startStr, 10),
              end: parseInt(endStr, 10),
              barcode,
              count,
            });
          }
        }
      }

      if (code === 0) {
        if (filteredOut > 0 && fragments.length === 0 && firstUnmatchedBarcode) {
          if (barcodeSet && barcodeSet.size > 0) {
            const firstSetBarcode = barcodeSet.values().next().value;
          }
        }
        resolve(fragments);
      } else {
        reject(new Error(`tabix exited with code ${code}`));
      }
    });

    tabix.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Check if tabix is available in PATH
 */
async function isTabixAvailable() {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const tabix = spawn('tabix', ['--version']);
    tabix.on('close', (code) => resolve(code === 0));
    tabix.on('error', () => resolve(false));
  });
}

/**
 * Streaming fallback for querying fragments without tabix.
 * Streams through the bgzip file and filters to the region.
 * Slower but works without tabix installed.
 */
async function queryFragmentsStreaming(fragmentsPath, region, cellBarcodes) {
  return new Promise((resolve, reject) => {
    const fragments = [];
    const barcodeSet = cellBarcodes instanceof Set ? cellBarcodes :
                       (Array.isArray(cellBarcodes) ? new Set(cellBarcodes) : null);

    // Normalize chromosome to lowercase, with and without "chr" prefix for matching
    const rawChrom = String(region.chrom).toLowerCase();
    const targetChrom = rawChrom.startsWith('chr') ? rawChrom : `chr${rawChrom}`;
    const targetChromNoPrefix = rawChrom.startsWith('chr') ? rawChrom.slice(3) : rawChrom;
    const regionStart = region.start;
    const regionEnd = region.end;

    let foundChrom = false;
    let passedChrom = false;
    let lineCount = 0;
    const maxLines = 500000000; // Safety limit (500M lines, multiome fragment files can be very large)

    // Create gunzip stream for bgzip file (compatible with gzip)
    const fileStream = fs.createReadStream(fragmentsPath);
    const gunzip = zlib.createGunzip();
    const rl = readline.createInterface({
      input: fileStream.pipe(gunzip),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      lineCount++;
      if (lineCount > maxLines) {
        rl.close();
        return;
      }

      if (!line.trim() || line.startsWith('#')) return;

      const parts = line.split('\t');
      if (parts.length < 4) return;

      const [chrom, startStr, endStr, barcode] = parts;
      const chromLower = chrom.toLowerCase();
      const chromNoPrefix = chromLower.startsWith('chr') ? chromLower.slice(3) : chromLower;
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      // Track chromosome progress (match with or without "chr" prefix)
      const chromMatches = chromLower === targetChrom || chromNoPrefix === targetChromNoPrefix;
      if (chromMatches) {
        foundChrom = true;

        // Check if fragment overlaps region
        if (end >= regionStart && start <= regionEnd) {
          // Filter by cell barcode if provided
          if (!barcodeSet || barcodeSet.has(barcode)) {
            const count = parts[4] ? parseInt(parts[4], 10) : 1;
            fragments.push({ chrom, start, end, barcode, count });
          }
        }

        // Stop early if we've passed the region
        if (start > regionEnd) {
          passedChrom = true;
          rl.close();
        }
      } else if (foundChrom) {
        // We've moved past the target chromosome
        passedChrom = true;
        rl.close();
      }
    });

    rl.on('close', () => {
      resolve(fragments);
    });

    rl.on('error', (err) => {
      reject(err);
    });

    gunzip.on('error', (err) => {
      // Handle truncated gzip (common with bgzip when we close early)
      if (err.code === 'Z_BUF_ERROR' || passedChrom) {
        resolve(fragments);
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Compute per-cluster binned coverage from fragments using Tn5 cut sites.
 *
 * Signac's CoveragePlot counts Tn5 insertion sites (the start and end of each
 * fragment) rather than the full fragment body.  Counting the body spreads
 * signal across the entire fragment length (often 150–500 bp), washing out
 * cluster-specific accessibility differences and producing noisy, "peaks
 * everywhere" tracks.  By counting only the two cut sites per fragment we
 * recover the sharp, cluster-specific peaks that match the gene-activity UMAP.
 *
 * @param {Array} fragments: Array of { chrom, start, end, barcode, count }
 * @param {Map} barcodeToCluster: Map from barcode to cluster ID
 * @param {number} regionStart: Start of genomic region
 * @param {number} regionEnd: End of genomic region
 * @param {number} binSize: Size of each bin in bp (default: 100)
 * @returns {Object}: { clusters: [...], coverageByCluster: [...] }
 */
function computeBinnedCoverageFromFragments(fragments, barcodeToCluster, regionStart, regionEnd, binSize = 100, clusterMeanDepths = null) {
  const numBins = Math.ceil((regionEnd - regionStart) / binSize);

  // Initialize coverage arrays per cluster
  const clusterCoverage = new Map(); // clusterId -> Float32Array
  const clusterCellCounts = new Map(); // clusterId -> Set of barcodes

  for (const frag of fragments) {
    const clusterId = barcodeToCluster.get(frag.barcode);
    if (clusterId === undefined || clusterId === null) continue;

    if (!clusterCoverage.has(clusterId)) {
      clusterCoverage.set(clusterId, new Float32Array(numBins));
      clusterCellCounts.set(clusterId, new Set());
    }

    clusterCellCounts.get(clusterId).add(frag.barcode);
    const coverage = clusterCoverage.get(clusterId);

    // Signac-style: count Tn5 cut sites (fragment start + end) instead of
    // full fragment body overlap.  Each fragment produces exactly two
    // insertion events, one at each end of the sequenced fragment.
    const cutSiteStart = frag.start;
    const cutSiteEnd = frag.end;

    if (cutSiteStart >= regionStart && cutSiteStart < regionEnd) {
      const bin = Math.floor((cutSiteStart - regionStart) / binSize);
      if (bin >= 0 && bin < numBins) {
        coverage[bin] += frag.count;
      }
    }
    if (cutSiteEnd >= regionStart && cutSiteEnd < regionEnd) {
      const bin = Math.floor((cutSiteEnd - regionStart) / binSize);
      if (bin >= 0 && bin < numBins) {
        coverage[bin] += frag.count;
      }
    }
  }

  // Signac-style normalization using GLOBAL library size (not region-specific)
  //
  // CRITICAL: Signac uses the TOTAL number of cells per group (CellsPerGroup)
  // and the GLOBAL mean depth (AverageCounts / nCount_ATAC) for each group:
  // NOT the number of cells that happen to have fragments in this region.
  //
  // Using only region-present cells inflates signal for non-accessible clusters
  // (few outlier cells → small denominator → artificially high norm values)
  // and suppresses signal for accessible clusters (most cells present →
  // denominator ≈ total → correct but relatively lower values).
  //
  // group_scale_factor = mean_depth_per_cell * TOTAL_n_cells_in_group
  // norm_value = raw_sum / group_scale_factor * median(group_scale_factors)

  // Count TOTAL cells per cluster from the full barcode→cluster mapping
  // (this includes ALL cells, not just those with fragments in the region)
  const totalCellsPerCluster = new Map();
  for (const [, clusterId] of barcodeToCluster) {
    if (clusterId === undefined || clusterId === null) continue;
    totalCellsPerCluster.set(clusterId, (totalCellsPerCluster.get(clusterId) || 0) + 1);
  }

  const groupScaleFactors = new Map();
  const hasGlobalDepths = clusterMeanDepths && typeof clusterMeanDepths === 'object';

  // Compute group scale factors for ALL clusters (not just those with fragments
  // in the region) so the median is computed over the full set of clusters.
  const allClusterIds = new Set([...clusterCoverage.keys(), ...totalCellsPerCluster.keys()]);
  for (const clusterId of allClusterIds) {
    const totalCells = totalCellsPerCluster.get(clusterId) || 0;
    if (totalCells === 0) continue;
    if (hasGlobalDepths) {
      // Use global per-cell depth from the peak matrix (like Signac's nCount_ATAC)
      const meanDepth = clusterMeanDepths[String(clusterId)] || clusterMeanDepths[clusterId] || 1;
      groupScaleFactors.set(clusterId, meanDepth * totalCells);
    } else {
      // Fallback: use total cell count only
      groupScaleFactors.set(clusterId, totalCells);
    }
  }

  const gsVals = Array.from(groupScaleFactors.values()).sort((a, b) => a - b);
  let medianScale = gsVals.length % 2 === 1
    ? gsVals[Math.floor(gsVals.length / 2)]
    : (gsVals[gsVals.length / 2 - 1] + gsVals[gsVals.length / 2]) / 2;
  if (medianScale <= 0) medianScale = 1;

  // Normalize, apply Signac-style rolling window sum, and convert to signal format.
  //
  // Signac works at 1bp resolution and applies roll_sum(n=100, align="center")
  // to produce smooth coverage curves.  With our binned data (default 25bp bins),
  // a rolling window of ceil(100/binSize) bins gives equivalent 100bp smoothing.
  const smoothWindow = Math.max(1, Math.ceil(100 / binSize)); // ~4 bins for 25bp
  const halfWin = Math.floor(smoothWindow / 2);

  const coverageByCluster = [];
  for (const [clusterId, coverage] of clusterCoverage.entries()) {
    // Use total cells for reporting; skip clusters with no cells
    const totalCells = totalCellsPerCluster.get(clusterId) || clusterCellCounts.get(clusterId).size;
    if (totalCells === 0) continue;

    const gsf = groupScaleFactors.get(clusterId) || 1;

    // First pass: normalize raw counts
    const normValues = new Float32Array(numBins);
    for (let b = 0; b < numBins; b++) {
      normValues[b] = (coverage[b] / gsf) * medianScale;
    }

    // Second pass: centered rolling sum (matches Signac's roll_sum)
    const smoothed = new Float32Array(numBins);
    for (let b = 0; b < numBins; b++) {
      const lo = Math.max(0, b - halfWin);
      const hi = Math.min(numBins - 1, b + halfWin);
      let sum = 0;
      for (let k = lo; k <= hi; k++) sum += normValues[k];
      smoothed[b] = sum;
    }

    const signal = [];
    for (let b = 0; b < numBins; b++) {
      const binStart = regionStart + b * binSize;
      const binEnd = binStart + binSize;
      signal.push({ start: binStart, end: binEnd, value: smoothed[b] });
    }

    coverageByCluster.push({
      clusterId,
      label: `Cluster ${clusterId}`,
      cellCount: totalCells,
      signal,
    });
  }

  // Sort by cell count (largest first)
  coverageByCluster.sort((a, b) => b.cellCount - a.cellCount);

  return {
    clusters: Array.from(clusterCoverage.keys()),
    coverageByCluster,
  };
}

ipcMain.handle('query-atac-fragments', async (event, options) => {
  try {
    let { fragmentsPath, region, cellBarcodes, barcodeToCluster, clusterMeanDepths, binSize = 100 } = options;

    // Resolve path: try given path, then alternate filename (atac_fragments.tsv.gz <-> fragments.tsv.gz), then outs/
    const FRAGMENTS_BASE = 'fragments.tsv.gz';
    const ATAC_FRAGMENTS_BASE = 'atac_fragments.tsv.gz';
    if (fragmentsPath && !fs.existsSync(fragmentsPath)) {
      const dir = path.dirname(fragmentsPath);
      const base = path.basename(fragmentsPath);
      const altBase = base === FRAGMENTS_BASE ? ATAC_FRAGMENTS_BASE : base === ATAC_FRAGMENTS_BASE ? FRAGMENTS_BASE : null;
      const candidates = [path.join(dir, 'outs', base)];
      if (altBase) {
        candidates.unshift(path.join(dir, altBase));
        candidates.push(path.join(dir, 'outs', altBase));
      }
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          fragmentsPath = candidate;
          break;
        }
      }
    }
    if (!fragmentsPath || !fs.existsSync(fragmentsPath)) {
      throw new Error('Fragment file not found at: ' + (options.fragmentsPath || '') + ' (tried alternate name and outs/ subfolder)');
    }

    if (!region || !region.chrom || region.start === undefined || region.end === undefined) {
      throw new Error('Invalid region specified');
    }

    if (Array.isArray(cellBarcodes) && cellBarcodes.length > 0) {
    }

    let fragments;

    // Try pure-JS tabix (uses @gmod/tabix to read .tbi index, no CLI tools needed)
    const tbiPath = fragmentsPath + '.tbi';
    if (fs.existsSync(tbiPath)) {
      try {
        fragments = await queryFragmentsWithJsTabix(fragmentsPath, tbiPath, region, cellBarcodes);
      } catch (err) {
        console.warn('@gmod/tabix query failed, trying CLI tabix:', err.message);
        fragments = null;
      }
    }

    // Fallback: CLI tabix
    if (!fragments) {
      const tabixAvailable = await isTabixAvailable();
      if (tabixAvailable) {
        try {
          fragments = await queryFragmentsWithTabix(fragmentsPath, region, cellBarcodes);
        } catch (err) {
          console.warn('CLI tabix query failed, falling back to streaming:', err.message);
          fragments = null;
        }
      }
    }

    // Final fallback: streaming (slow for large files)
    if (!fragments) {
      fragments = await queryFragmentsStreaming(fragmentsPath, region, cellBarcodes);
    }


    // If barcodeToCluster mapping provided, compute binned coverage
    if (barcodeToCluster && Object.keys(barcodeToCluster).length > 0) {
      const barcodeMap = new Map(Object.entries(barcodeToCluster));
      const regionStart = region.start;
      const regionEnd = region.end;

      const { coverageByCluster } = computeBinnedCoverageFromFragments(
        fragments,
        barcodeMap,
        regionStart,
        regionEnd,
        binSize,
        clusterMeanDepths
      );

      return {
        success: true,
        fragmentCount: fragments.length,
        coverageByCluster,
        region,
        binSize,
      };
    }

    // Return raw fragments if no clustering info
    return {
      success: true,
      fragments,
      fragmentCount: fragments.length,
      region,
    };
  } catch (error) {
    console.error('Error querying ATAC fragments:', error);
    return { success: false, error: error.message };
  }
});

// High-resolution screenshot capture for publication figures
// Captures at native Retina resolution, then upscales with Sharp (lanczos3)
// for publication-quality output without distorting the UI layout.
ipcMain.handle('capture-screenshot', async (event, options = {}) => {
  try {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win) return { success: false, error: 'No window available' };

    const upscale = options.upscale || 2; // upscale factor applied after Retina 2× capture

    const image = await win.webContents.capturePage();
    const pngBuffer = image.toPNG();
    const size = image.getSize();

    // Upscale using Sharp with high-quality lanczos3 resampling
    const sharp = require('sharp');
    const finalWidth = size.width * upscale;
    const finalHeight = size.height * upscale;
    const upscaledBuffer = await sharp(pngBuffer)
      .resize(finalWidth, finalHeight, { kernel: 'lanczos3' })
      .png()
      .toBuffer();

    // Let user pick save location
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save High-Resolution Screenshot',
      defaultPath: path.join(app.getPath('pictures'), `CellPilot_figure_${Date.now()}.png`),
      filters: [
        { name: 'PNG Image', extensions: ['png'] },
        { name: 'TIFF Image', extensions: ['tiff', 'tif'] },
      ],
    });

    if (canceled || !filePath) {
      return { success: false, error: 'Save cancelled' };
    }

    if (filePath.endsWith('.tiff') || filePath.endsWith('.tif')) {
      await sharp(upscaledBuffer)
        .tiff({ compression: 'lzw' })
        .toFile(filePath);
    } else {
      fs.writeFileSync(filePath, upscaledBuffer);
    }

    return {
      success: true,
      filePath,
      width: finalWidth,
      height: finalHeight,
    };
  } catch (error) {
    console.error('Screenshot capture error:', error);
    return { success: false, error: error.message };
  }
});

// Screen recording support
// Saves a recorded video buffer sent from the renderer to a user-chosen path.
// ext: 'mp4' or 'webm' depending on what MediaRecorder used.
ipcMain.handle('save-recording', async (event, buffer, ext = 'mp4') => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const isMP4 = ext === 'mp4';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Recording',
    defaultPath: path.join(app.getPath('videos'), `CellPilot_recording_${Date.now()}.${ext}`),
    filters: isMP4
      ? [{ name: 'MP4 Video', extensions: ['mp4'] }]
      : [{ name: 'WebM Video', extensions: ['webm'] }],
  });
  if (canceled || !filePath) return { success: false, error: 'Save cancelled' };
  try {
    fs.writeFileSync(filePath, Buffer.from(buffer));
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

