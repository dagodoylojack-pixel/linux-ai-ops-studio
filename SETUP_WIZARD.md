# Setup Wizard — Configuración de OpenRouter API Key

## Descripción

En el primer inicio de la aplicación (después de instalar), aparece un **setup wizard** que pregunta si el usuario desea configurar una clave API de OpenRouter para habilitar la IA.

## Flujo

1. **Primera ejecución después de instalar**:
   - La app inicia normalmente
   - Después de que carga la UI, aparece un diálogo de Electron

2. **Diálogo inicial**:
   ```
   ┌─────────────────────────────────────────────┐
   │ Bienvenido a Linux AI Ops Studio            │
   ├─────────────────────────────────────────────┤
   │                                             │
   │ ¿Deseas configurar una clave API de         │
   │ OpenRouter para habilitar la IA?            │
   │                                             │
   │ Puedes configurarla ahora o después         │
   │ desde la aplicación.                        │
   │                                             │
   │ Obtén una clave gratis en:                  │
   │ https://openrouter.ai/keys                  │
   │                                             │
   │  [Configurar ahora]  [Configurar después]   │
   └─────────────────────────────────────────────┘
   ```

3. **Si elige "Configurar ahora"**:
   - Se crea un archivo `.env` en: `%APPDATA%\linux-ai-ops-studio\.env`
   - Se abre automáticamente en el editor de texto por defecto
   - El usuario ve el template:
     ```
     # ========================================
     # Linux AI Ops Studio - Configuración
     # ========================================

     # OpenRouter API Key
     # Obtén tu clave en: https://openrouter.ai/keys
     # Descomenta la siguiente línea y reemplaza con tu clave:
     # OPENROUTER_API_KEY=sk_or_xxxxx...

     # Modelo a usar (por defecto: openrouter/free)
     # OPENROUTER_MODEL=openrouter/free
     ```
   - El usuario:
     1. Va a https://openrouter.ai/keys
     2. Copia su clave API (ej: `sk_or_abc123...`)
     3. Regresa al archivo `.env`
     4. Descomenta la línea `OPENROUTER_API_KEY`
     5. Reemplaza el valor con su clave
     6. Guarda el archivo
   - Se muestra otro diálogo: "Reinicia la aplicación para aplicar los cambios"

4. **Si elige "Configurar después"**:
   - No se muestra el diálogo
   - La app sigue funcionando en modo simulado
   - El usuario puede configurar después accediendo manualmente al archivo `.env`

5. **En siguientes inicios**:
   - El wizard NO se muestra (detecta que ya se configuró)
   - Carga automáticamente la clave del `.env` si existe
   - Si hay clave válida, activa el modo IA en el servidor

## Ubicación del archivo .env

- **Windows**: `C:\Users\<username>\AppData\Roaming\linux-ai-ops-studio\.env`
- **Alternativa (si está fuera de AppData)**: Donde indicó el diálogo durante la configuración

El usuario puede editar este archivo en cualquier momento usando:
- Bloc de notas (notepad)
- VS Code
- Cualquier editor de texto

## Soporte de variables

El archivo `.env` soporta:

| Variable | Ejemplo | Opcional |
|----------|---------|----------|
| `OPENROUTER_API_KEY` | `sk_or_abc123...` | ✅ Sí (sin ella, modo simulado) |
| `OPENROUTER_MODEL` | `openrouter/free` | ✅ Sí (default: openrouter/free) |
| `OPENROUTER_API_BASE` | `https://openrouter.ai/api/v1` | ✅ Sí (default: OpenRouter) |

## Comportamiento sin API key

Si no hay clave configurada:
- La app funciona normalmente
- El agente IA responde con **acciones simuladas** (mock responses)
- Los usuarios pueden navegar, agregar servidores, ejecutar comandos simulados
- Útil para demos o testing

## Para usuarios finales

**Instrucciones que recibirán:**

1. Instala la app con el instalador `.exe`
2. En el primer inicio, elige "Configurar ahora" si deseas habilitar IA
3. Obtén una clave en https://openrouter.ai/keys (la primera es gratis)
4. Copia tu clave y pégala en el archivo que se abre
5. Guarda y reinicia la app

**Modelo recomendado** para usar en OpenRouter:
- `openrouter/free` — Gratis, sin necesidad de crédito (default de la app)
- `gpt-4-1-mini` — Rápido, barato, buen balance
- `gpt-4` — Más potente pero más caro
- `claude-3-haiku` — Buena alternativa

## Implementación técnica

### Archivos involucrados

| Archivo | Propósito |
|---------|-----------|
| `electron/setup-wizard.js` | Módulo con la lógica del wizard |
| `electron/main.js` | Integración en el ciclo de vida de Electron |

### Funciones principales

```javascript
// En setup-wizard.js
isFirstRun()              // Retorna true si es la primera ejecución
showSetupWizard(window)   // Muestra el diálogo y wizard
loadApiKey()              // Carga la clave del .env al iniciar
```

### Marcador de primera ejecución

Se crea un archivo vacío: `%APPDATA%\linux-ai-ops-studio\.first-run`

Si existe, el wizard no se muestra. Eliminar este archivo hará que el wizard se muestre de nuevo en el siguiente inicio.

## Troubleshooting

### "El diálogo no aparece"
- Verifica que `%APPDATA%\linux-ai-ops-studio\.first-run` no exista
- Elimínalo para forzar que aparezca de nuevo

### "El .env no se abre"
- El archivo se creó, pero no se abrió automáticamente
- Búscalo en `%APPDATA%\linux-ai-ops-studio\`
- Abrelo manualmente con un editor de texto

### "Mi clave no funciona"
- Verifica que esté correctamente sin comentarios (#)
- Asegúrate de haber guardado el archivo
- Reinicia la app
- Verifica que la clave sea válida en https://openrouter.ai/keys

---

**Versión**: 1.0  
**Fecha**: 2026-09-10  
**Estado**: Implementado y probado
