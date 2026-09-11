/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Electron main process — launches the Node.js Express server as a child process
 * and displays it in a native window.
 */

const { app, BrowserWindow, Menu, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const { isFirstRun, showSetupWizard, loadApiKey } = require('./setup-wizard.cjs');

const APP_VERSION = '1.0.0';
const APP_AUTHOR = 'Daniel Godoy';

// Safety net: if anything throws outside a try/catch during startup, show it
// instead of letting the app vanish with no window and no error dialog.
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err);
  logToConsole(`Error inesperado: ${err.message}`, 'err');
  try {
    dialog.showErrorBox('Error inesperado', err.stack || String(err));
  } catch (_) {
    /* dialog may not be ready yet */
  }
});

process.on('unhandledRejection', (reason) => {
  const message = reason && reason.stack ? reason.stack : String(reason);
  console.error('[Main] Unhandled rejection:', message);
  logToConsole(`Error inesperado: ${message}`, 'err');
});

let mainWindow;
let consoleWindow;
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
 * Create a visible console window that reports startup progress and server
 * output in real time. Stays open on failure so the user can read what went
 * wrong instead of the app silently closing.
 */
function createConsoleWindow() {
  consoleWindow = new BrowserWindow({
    width: 760,
    height: 500,
    title: `Linux AI Ops Studio — Consola`,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      sandbox: true,
    },
  });

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0f172a; color: #e2e8f0; font-family: Consolas, 'Courier New', monospace; }
  header { padding: 16px 20px; border-bottom: 1px solid #1e293b; background: #111827; }
  header .title { font-size: 18px; font-weight: bold; color: #34d399; }
  header .meta { font-size: 12px; color: #94a3b8; margin-top: 4px; }
  #log { padding: 12px 20px; font-size: 12px; line-height: 1.7; height: calc(100vh - 78px); overflow-y: auto; white-space: pre-wrap; }
  .info { color: #93c5fd; }
  .ok { color: #34d399; }
  .err { color: #f87171; }
</style>
</head>
<body>
  <header>
    <div class="title">Linux AI Ops Studio</div>
    <div class="meta">v${APP_VERSION} &mdash; por ${APP_AUTHOR}</div>
  </header>
  <div id="log"></div>
</body>
</html>`;

  consoleWindow.loadURL(`data:text/html,${encodeURIComponent(html)}`);

  consoleWindow.on('closed', () => {
    consoleWindow = null;
  });
}

/**
 * Append a line to the console window (and stdout, for `npm run dev` / logs).
 */
function logToConsole(message, level = 'info') {
  const tag = { info: '[i]', ok: '[OK]', err: '[ERROR]' }[level] || '[i]';
  console.log(`${tag} ${message}`);

  if (!consoleWindow || consoleWindow.isDestroyed()) return;

  const script = `
    (function() {
      var el = document.getElementById('log');
      if (!el) return;
      var line = document.createElement('div');
      line.className = ${JSON.stringify(level)};
      line.textContent = ${JSON.stringify(message)};
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
    })();
  `;
  consoleWindow.webContents.executeJavaScript(script).catch(() => {});
}

/**
 * Launch the Express server as a child process
 */
function launchServer() {
  // __dirname is electron/, parent is app root
  const appRoot = path.join(__dirname, '..');
  const serverPath = path.join(appRoot, 'dist', 'server.cjs');

  logToConsole(`Raíz de la app: ${appRoot}`);
  logToConsole(`Ruta del servidor: ${serverPath}`);

  if (!fs.existsSync(serverPath)) {
    logToConsole(`No se encontró server.cjs en la ruta esperada.`, 'err');
    return;
  }

  logToConsole('Lanzando el servidor...');

  // Use Electron's own bundled Node runtime instead of relying on a system
  // 'node' binary being present in PATH (end users won't have Node installed).
  // ELECTRON_RUN_AS_NODE makes process.execPath behave as a plain Node process.
  try {
    serverProcess = spawn(process.execPath, [serverPath], {
      cwd: appRoot, // Run from app root so relative paths work
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        PORT: APP_PORT.toString(),
        STORAGE_DB_PATH: path.join(
          app.getPath('userData'),
          'linux_ai_ops.sqlite3'
        ),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    logToConsole(`No se pudo lanzar el servidor: ${err.message}`, 'err');
    return;
  }

  serverProcess.stdout.on('data', (data) => {
    logToConsole(data.toString().trim());
  });

  serverProcess.stderr.on('data', (data) => {
    logToConsole(data.toString().trim(), 'err');
  });

  serverProcess.on('error', (err) => {
    logToConsole(`Fallo al iniciar el servidor: ${err.message}`, 'err');
  });

  serverProcess.on('exit', (code) => {
    logToConsole(`El proceso del servidor terminó (código ${code})`, code === 0 ? 'info' : 'err');
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
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
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
 * Full startup sequence: show console, launch server, wait for it, then
 * open the main window (or leave the console open with the error).
 */
async function startApp() {
  createConsoleWindow();
  logToConsole(`Iniciando Linux AI Ops Studio v${APP_VERSION}...`);
  logToConsole(`Desarrollado por ${APP_AUTHOR}`);

  try {
    loadApiKey();
  } catch (err) {
    logToConsole(`Advertencia cargando la API key: ${err.message}`, 'err');
  }

  launchServer();
  logToConsole('Esperando respuesta del servidor...');

  const ready = await waitForServer();

  if (ready) {
    logToConsole('Servidor listo.', 'ok');
    createWindow();

    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.close();
    }

    // Show first-run setup wizard if needed
    if (isFirstRun()) {
      setTimeout(() => showSetupWizard(mainWindow), 1000);
    }
  } else {
    logToConsole('El servidor no respondió a tiempo. Revise los mensajes anteriores.', 'err');
    logToConsole('Esta ventana permanecerá abierta para diagnóstico.', 'err');
    // Do not close the console window or quit automatically — let the user read the log.
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
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Linux AI Ops Studio',
              message: `Linux AI Ops Studio v${APP_VERSION}`,
              detail: `Autonomous systems orchestrator powered by AI.\npor ${APP_AUTHOR}`,
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
  createMenu();
  await startApp();
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
    startApp();
  }
});

app.on('before-quit', () => {
  // Terminate server process before quitting
  if (serverProcess && !serverProcess.killed) {
    console.log('[App] Terminating server process...');
    serverProcess.kill('SIGTERM');
  }
});
