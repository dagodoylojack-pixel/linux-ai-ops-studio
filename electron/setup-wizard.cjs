/**
 * First-run setup wizard for API key configuration
 * Prompts user to configure OpenRouter API key on first launch
 */

const { dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_DIR = path.join(
  process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE, '.config'),
  'linux-ai-ops-studio'
);
const CONFIG_FILE = path.join(CONFIG_DIR, '.first-run');
const ENV_FILE = path.join(CONFIG_DIR, '.env');

/**
 * Check if this is first run
 */
function isFirstRun() {
  return !fs.existsSync(CONFIG_FILE);
}

/**
 * Mark first run as complete
 */
function markFirstRunComplete() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, '');
}

/**
 * Show first-run setup wizard.
 *
 * This re-fires on every fresh install AND every reinstall (not just the
 * very first launch ever): the NSIS installer deletes the marker file this
 * function checks on every install run — see installer.nsi's `customInstall`
 * macro — so `isFirstRun()` is true again each time, regardless of whether a
 * key was configured in a previous install.
 *
 * Returns true when the user chose "Configurar ahora", so the caller
 * (main.cjs) can open the in-app API key modal right away instead of
 * routing the user through hand-editing a text file.
 */
async function showSetupWizard(mainWindow) {
  if (!isFirstRun()) {
    return false;
  }

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Bienvenido a Linux AI Ops Studio',
    message: '¿Deseas configurar una clave API de OpenRouter para habilitar la IA?',
    detail: 'Puedes configurarla ahora mismo desde la aplicación — se valida al instante, sin editar archivos — o hacerlo después con el botón "Configurar IA" en la parte superior.\n\nObtén una clave gratis en: https://openrouter.ai/keys',
    buttons: ['Configurar ahora', 'Configurar después'],
    defaultId: 0,
  });

  // Always leave a documented .env template behind too, as a fallback for
  // users who prefer editing the file directly (headless use, automation,
  // or simply personal preference). The in-app modal writes to this same
  // file's counterpart in the install directory once a key is entered.
  ensureConfigDir();
  createEnvTemplate();

  markFirstRunComplete();
  return response === 0;
}

/**
 * Ensure config directory exists
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Create .env template file with instructions. This is a fallback location
 * for users who prefer editing the file by hand — the recommended path is
 * the "Configurar IA" button inside the app itself, which validates the key
 * against OpenRouter and applies it immediately (no restart, no manual edit).
 */
function createEnvTemplate() {
  if (!fs.existsSync(ENV_FILE)) {
    const envContent = `# ========================================
# Linux AI Ops Studio - Configuración
# ========================================
#
# Forma recomendada: abre la aplicación y usa el botón "Configurar IA" —
# valida tu clave al instante y la activa sin reiniciar nada.
#
# Alternativa manual: descomenta la siguiente línea y reemplaza con tu
# clave, luego reinicia la aplicación.

# OpenRouter API Key
# Obtén tu clave en: https://openrouter.ai/keys
# OPENROUTER_API_KEY=sk_or_xxxxx...

# Modelo a usar (por defecto: openrouter/free)
# OPENROUTER_MODEL=openrouter/free
`;
    fs.writeFileSync(ENV_FILE, envContent);
  }
}

// Exports
// NOTE: API key loading itself lives in main.cjs (resolveOpenRouterApiKey),
// which scans several candidate .env locations and logs what it finds.
// CONFIG_DIR/ENV_FILE are exported so main.cjs uses the exact same paths
// this wizard writes to instead of duplicating the logic.
module.exports = {
  isFirstRun,
  showSetupWizard,
  CONFIG_DIR,
  ENV_FILE,
};
