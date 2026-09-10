# Linux AI Ops Studio — Windows Desktop Installer

Este documento describe cómo construir y distribuir la aplicación como un instalador de Windows nativo usando Electron y electron-builder.

## Cómo funciona

La aplicación es un **full-stack Node.js + React** empaquetado en Electron:

1. **Electron main process** (`electron/main.js`):
   - Lanza el servidor Express (`dist/server.cjs`) como proceso hijo
   - Fija `NODE_ENV=production` y `PORT=3005` en variables de entorno
   - Espera a que el servidor inicie (polling a `http://127.0.0.1:3005`)
   - Abre una ventana nativa (BrowserWindow) que carga la SPA
   - Termina gracefully el proceso servidor al cerrar la app

2. **Persistencia de datos del usuario**:
   - Credenciales SSH cifradas: `%APPDATA%\linux-ai-ops-studio\linux_ai_ops.sqlite3`
   - Base de datos aislada por usuario (no en `Program Files` para evitar problemas de permisos)

3. **Instalador NSIS** (Native Setup Installer, estándar de Windows):
   - One-click o paso a paso (configurable)
   - Atajos en Escritorio y Menú Inicio
   - Sin necesidad de privilegios de administrador (per-user installation)
   - Desinstalador estándar ("Agregar o quitar programas")

## Construir el instalador

### Requisitos previos

- Node.js 18+ con npm 9+
- Windows 10+ (para probar el instalador)
- Sin dependencias compiladas nativas (zero pain point)

### Pasos

#### 1. Instalar dependencias de desarrollo (solo la primera vez)

```bash
npm install
```

Esto incluye `electron` y `electron-builder` en `devDependencies`.

#### 2. Generar el instalador

```bash
npm run electron:prepare
```

Este script:
- Corre `npm run build` (Vite + esbuild)
- Crea carpeta `release-resources/` con:
  - `dist/` (frontend + backend bundles)
  - `node_modules/` (solo dependencias de producción, sin devDependencies)
  - `package.json`

#### 3. Compilar el instalador

```bash
npm run electron:build
```

Esto genera:
- `release/Linux AI Ops Studio Setup 0.0.0.exe` — el instalador (60-80 MB aprox.)
- `release/` — artefactos de build (excluidos de git)

El instalador puede entonces distribuirse a usuarios finales.

## Archivos del proyecto

| Archivo | Propósito |
|---------|-----------|
| `electron/main.js` | Proceso principal de Electron (lanzador del servidor) |
| `electron/preload.js` | Preload script mínimo (sandbox) |
| `build/icon.ico` | Ícono de la aplicación para Windows |
| `build/icon.png` | Ícono para otros usos |
| `scripts/generate-icon.js` | Script que genera los iconos |
| `scripts/prepare-electron.js` | Script que prepara `release-resources/` |
| `package.json` | Configuración: devDependencies, scripts, build config |
| `tsconfig.json` | Excluye `plugins/`, `dist/`, etc. del type-check |

## Configuración (en `package.json`)

```json
{
  "build": {
    "appId": "com.linux-ai-ops.studio",
    "productName": "Linux AI Ops Studio",
    "win": {
      "target": ["nsis"],
      "icon": "build/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  }
}
```

Cambios futuros si es necesario:
- `productName`: nombre de la app en Start Menu y Programas
- `nsis.oneClick: true`: instalador automático sin diálogos
- `appId`: ID único para actualizaciones delta (futuro)

## Usar el instalador como usuario final

1. Descargar `Linux AI Ops Studio Setup 0.0.0.exe`
2. Hacer doble clic para ejecutar
3. Seguir los pasos (si `oneClick: false`)
   - Elegir carpeta de instalación (por defecto: `C:\Users\<user>\AppData\Local\Linux AI Ops Studio`)
   - Crear atajos de escritorio/menú
4. Abrir la app desde el ícono de escritorio o menú
5. La ventana nativa se abre, cargando la app en segundos
6. Usar normalmente (sin terminal, sin requerer Node.js)

## Flujo técnico en detail

### Startup

1. Usuario hace clic en ícono de escritorio
2. Electron se inicia → `app.on('ready')`
3. Se crea pantalla de carga ("Starting up...")
4. Se lanza `node dist/server.cjs` como child process con:
   - `NODE_ENV=production` (fija el bug de producción sin tocar `server.ts`)
   - `PORT=3005`
   - `STORAGE_DB_PATH=%APPDATA%\...\linux_ai_ops.sqlite3`
   - `cwd=C:\Program Files\Linux AI Ops Studio` (o donde se instaló)
5. Electron polling: `GET http://127.0.0.1:3005` cada 500ms
6. Cuando responde (timeout: 15s), se crea `BrowserWindow` y se carga la URL
7. Pantalla de carga se cierra → usuario ve la app

### Runtime

- Backend Express y frontend React corren en el mismo puerto (3005)
- Vite NOT embebido (no hay dev middleware)
- Todo es estático (`dist/index.html`, `dist/assets/...`)
- Los comandos SSH se ejecutan contra servidores reales (o simulados si sin credentials)

### Shutdown

1. Usuario cierra ventana
2. `window-all-closed` event → `app.quit()`
3. `before-quit` → mata el child process `serverProcess` con `SIGTERM`
4. Electron se cierra limpiamente (sin procesos `node.exe` huérfanos)

## Troubleshooting

| Problema | Solución |
|----------|----------|
| **Instalador no se genera** | Verificar que `release-resources/` existe y contiene `dist/` y `node_modules/`. Ejecutar `npm run electron:prepare` de nuevo. |
| **App no inicia** | Revisar `release/logs/` si existe. Verificar que puerto 3005 no está en uso. Ejecutar manualmente `node dist/server.cjs` desde una terminal para debug. |
| **Windows SmartScreen aviso** | Normal para apps sin firmar. Usuario hace clic en "Más información" → "Ejecutar de todas formas". Evitable comprando certificado de código (fuera de scope). |
| **Credenciales SSH se pierden** | Verificar que `%APPDATA%\linux-ai-ops-studio\linux_ai_ops.sqlite3` existe y es accesible. No compartir la carpeta entre usuarios Windows. |

## Información técnica para desarrolladores

### Por qué Electron

- **Estable**: usado en producción por VSCode, Slack, Discord, etc.
- **Limpio**: embebe Node + Chromium, sin dependencias del sistema
- **Directo**: no requiere modificar `server.ts` (solo configurar Electron)
- **Portable**: mismo código en macOS/Linux (futuro)

### Por qué no `pkg` o `vercel/pkg`

- Requiere compilar dependencias nativas para cada arquitectura (complejo con `ssh2`)
- El ejecutable debe empaquetar `node_modules` completo (monolítico, difícil de actualizar)
- Menos control sobre el proceso y el entorno

### Por qué no Tauri

- Menor madurez (Tauri 1.0 salió hace ~2 años)
- Curva de aprendizaje (Rust)
- Comunidad más pequeña
- Overkill para esta app (no necesitamos la performance/seguridad de Tauri)

### Posibles mejoras futuras

1. **Actualizaciones automáticas**: electron-updater para delta updates
2. **Firma de código**: comprar certificado Windows Code Signing
3. **Logging remoto**: reportar crashes a un servidor (para diagnóstico)
4. **Instalador multiidioma**: soporte ES/EN/FR en la interfaz de instalación
5. **Portable version**: `.exe` sin instalador (alternativa a NSIS)
6. **macOS/Linux builds**: empaquetar para otros SO (diferente DMG para Mac, .AppImage para Linux)

## FAQ

**¿Qué pasa si el usuario edita la base de datos SQLite?**  
No debería. El archivo está cifrado con `AES-256-CBC` (ver `server.ts`). Intentar abrirlo directamente fallará.

**¿Se puede usar en Red/red corporativa?**  
Sí, pero requiere configuración manual de proxy. El instalador crea una app que conecta a `127.0.0.1` localmente (no requiere red). Para gestionar servidores remotos, el usuario configura credenciales manualmente en la UI.

**¿Qué ocupa el instalador?**  
~80 MB (.exe) incluye:
- Electron runtime + Chromium (~150 MB instalado)
- Node.js + npm modules (~400 MB instalado)
- Aplicación (frontend + backend bundles): ~30 MB

Es normal para apps de escritorio modernas.

**¿Se puede desinstalar completamente?**  
Sí, desde "Agregar o quitar programas". La carpeta `%APPDATA%\linux-ai-ops-studio` con las credenciales SSH se preserva (estándar de Windows, por si el usuario quiere reinstalar sin perder datos).

---

**Última actualización**: 2026-09-10  
**Estado**: Pronto para uso en Windows
