/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Electron main process — launches the Node.js Express server as a child process
 * and displays it in a native window.
 */

const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const { isFirstRun, showSetupWizard, loadApiKey } = require('./setup-wizard.cjs');

// __dirname equivalent in CommonJS
const __dirname = path.dirname(__filename);

let mainWindow;
let serverProcess;

const APP_PORT = 3005;
const SERVER_STARTUP_TIMEOUT = 15000; // 15 seconds
const SERVER_HEALTH_POLL_INTERVAL = 500; // Check every 500ms

/**
 * Check if the server is responding on the expected port
 */
function isServerReady() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${APP_PORT}`, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 404); // 404 is ok (SPA route)
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Wait for server to become ready
 */
async function waitForServer() {
  const startTime = Date.now();
  while (Date.now() - startTime < SERVER_STARTUP_TIMEOUT) {
    if (await isServerReady()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, SERVER_HEALTH_POLL_INTERVAL));
  }
  return false;
}

/**
 * Launch the Express server as a child process
 */
function launchServer() {
  // __dirname is electron/, parent is app root
  const appRoot = path.join(__dirname, '..');
  const serverPath = path.join(appRoot, 'dist', 'server.cjs');

  console.log(`[Server] App root: ${appRoot}`);
  console.log(`[Server] Server path: ${serverPath}`);
  console.log(`[Server] Server exists: ${fs.existsSync(serverPath)}`);

  serverProcess = spawn('node', [serverPath], {
    cwd: appRoot, // Run from app root so relative paths work
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: APP_PORT.toString(),
      STORAGE_DB_PATH: path.join(
        app.getPath('userData'),
        'linux_ai_ops.sqlite3'
      ),
    },
    stdio: 'inherit', // Show all output for debugging
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(`[Server] ${data.toString().trim()}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[Server Error] ${data.toString().trim()}`);
  });

  serverProcess.on('error', (err) => {
    console.error('[Server] Failed to start:', err);
  });

  serverProcess.on('exit', (code) => {
    console.log(`[Server] Process exited with code ${code}`);
    serverProcess = null;
  });
}

/**
 * Create the main application window
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
  });

  mainWindow.loadURL(`http://127.0.0.1:${APP_PORT}`);

  // Open dev tools in development
  if (process.env.NODE_ENV !== 'production') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Show a splash/loading screen while server starts
 */
async function showLoadingWindow() {
  const loadingWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    alwaysOnTop: true,
    webPreferences: {
      sandbox: true,
    },
  });

  loadingWindow.loadURL(
    `data:text/html,<html style="background: linear-gradient(135deg, #059669, #2563eb); display: flex; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif;">
      <div style="text-align: center; color: white;">
        <div style="font-size: 24px; font-weight: bold; margin-bottom: 20px;">Linux AI Ops Studio</div>
        <div style="font-size: 14px;">Starting up...</div>
      </div>
    </html>`
  );

  const ready = await waitForServer();
  loadingWindow.close();

  if (ready) {
    createWindow();

    // Show first-run setup wizard if needed
    if (isFirstRun()) {
      setTimeout(() => showSetupWizard(mainWindow), 1000);
    }
  } else {
    console.error('Server failed to start within timeout');
    app.quit();
  }
}

/**
 * Create application menu
 */
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Exit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow) mainWindow.webContents.reload();
          },
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            if (mainWindow) mainWindow.webContents.toggleDevTools();
          },
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            require('electron').dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Linux AI Ops Studio',
              message: 'Linux AI Ops Studio v1.0.0',
              detail:
                'Autonomous systems orchestrator powered by AI.\nby Daniel Godoy',
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * App lifecycle
 */
app.on('ready', async () => {
  // Load API key from config if available
  loadApiKey();

  createMenu();
  launchServer();
  await showLoadingWindow();
});

app.on('window-all-closed', () => {
  // On macOS, apps usually stay open until user quits explicitly
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS, re-show window when app is activated
  if (mainWindow === null) {
    showLoadingWindow();
  }
});

app.on('before-quit', () => {
  // Terminate server process before quitting
  if (serverProcess && !serverProcess.killed) {
    console.log('[App] Terminating server process...');
    serverProcess.kill('SIGTERM');
  }
});
