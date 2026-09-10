/**
 * First-run setup wizard for API key configuration
 * Prompts user to configure OpenRouter API key on first launch
 */

const { dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_DIR = path.join(process.env.APPDATA || path.join(process.env.HOME, '.config'), 'linux-ai-ops-studio');
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
 * Show first-run setup wizard
 */
async function showSetupWizard(mainWindow) {
  if (!isFirstRun()) {
    return; // Not first run
  }

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Bienvenido a Linux AI Ops Studio',
    message: '¿Deseas configurar una clave API de OpenRouter para habilitar la IA?',
    detail: 'Puedes configurarla ahora o después desde la aplicación.\n\nObtén una clave gratis en: https://openrouter.ai/keys',
    buttons: ['Configurar ahora', 'Configurar después'],
    defaultId: 0,
  });

  if (response === 0) {
    // Create .env file with template and open it
    ensureConfigDir();
    createEnvTemplate();

    // Open .env file in default editor
    shell.openPath(ENV_FILE);

    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Configurar API Key',
      message: 'Se abrió el archivo .env para editar.',
      detail: 'Descomenta la línea OPENROUTER_API_KEY y reemplaza con tu clave.\nReinicia la aplicación después de guardar.',
    });
  }

  markFirstRunComplete();
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
 * Create .env template file with instructions
 */
function createEnvTemplate() {
  if (!fs.existsSync(ENV_FILE)) {
    const envContent = `# ========================================
# Linux AI Ops Studio - Configuración
# ========================================

# OpenRouter API Key
# Obtén tu clave en: https://openrouter.ai/keys
# Descomenta la siguiente línea y reemplaza con tu clave:
# OPENROUTER_API_KEY=sk_or_xxxxx...

# Modelo a usar (por defecto: gpt-4-1-mini)
# OPENROUTER_MODEL=gpt-4-1-mini
`;
    fs.writeFileSync(ENV_FILE, envContent);
  }
}

/**
 * Load API key from .env file
 */
function loadApiKey() {
  if (fs.existsSync(ENV_FILE)) {
    const envContent = fs.readFileSync(ENV_FILE, 'utf-8');
    const match = envContent.match(/OPENROUTER_API_KEY=(.+)/);
    if (match) {
      const apiKey = match[1].trim();
      if (apiKey && !apiKey.startsWith('#')) {
        process.env.OPENROUTER_API_KEY = apiKey;
        return apiKey;
      }
    }
  }
  return null;
}

// Exports
module.exports = {
  isFirstRun,
  showSetupWizard,
  loadApiKey,
};
