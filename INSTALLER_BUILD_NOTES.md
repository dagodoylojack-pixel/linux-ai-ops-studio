# Notas de construcción del instalador

## Estado actual

✅ **Configuración completada**:
- Electron main process (`electron/main.js`)
- Preload script (`electron/preload.js`)
- Iconos generados (`build/icon.ico`, `build/icon.png`)
- Scripts de staging (`scripts/prepare-electron.js`, `scripts/generate-icon.js`)
- Configuración de electron-builder en `package.json`
- Documentación completa (`INSTALLER.md`, `INSTALLER_SUMMARY.md`)

✅ **Dependencias instaladas**:
- `electron` (34.5.8)
- `electron-builder` (26.15.3)
- Todas las devDependencies en node_modules

⏳ **Pendiente**: Generación del instalador NSIS
- Error: EPERM (permisos) al extraer Electron en `release/win-unpacked.tmp`

## Problema conocido: EPERM en Windows

El error que se produce es:

```
⨯ EPERM: operation not permitted, rename '...release\win-unpacked.tmp' -> '...release\win-unpacked'
```

**Causa probable**: Windows Defender o antivirus escaneando archivos mientras electron-builder intenta manipularlos.

**Soluciones**:

### Opción 1: Desabilitar Windows Defender temporalmente (más rápido)

```powershell
# Como administrador
Set-MpPreference -DisableRealtimeMonitoring $true

# Ejecutar build
npm run electron:build

# Re-habilitar
Set-MpPreference -DisableRealtimeMonitoring $false
```

### Opción 2: Excluir la carpeta del scanning

```powershell
# Como administrador
Add-MpPreference -ExclusionPath "C:\Users\dagodoy\Downloads\linux-ai-ops-studio"
npm run electron:build
Remove-MpPreference -ExclusionPath "C:\Users\dagodoy\Downloads\linux-ai-ops-studio"
```

### Opción 3: Ejecutar desde una unidad diferente

Si tienes acceso a otra unidad (ej. D:/), copiar el proyecto allá y ejecutar desde allí puede evitar el scanning.

### Opción 4: Usar WSL o VM Linux

Si todo lo anterior falla, construir el instalador desde WSL:

```bash
# En WSL (Ubuntu, etc)
cd /mnt/c/Users/dagodoy/Downloads/linux-ai-ops-studio
npm run electron:build
```

## Pasos una vez resuelto el problema

Cuando `npm run electron:build` se ejecute exitosamente:

1. Se generará: `release/Linux AI Ops Studio Setup 0.0.0.exe` (~80 MB)
2. Copiar el instalador a una ubicación de distribución
3. Usuarios finales pueden:
   - Hacer doble clic en `.exe`
   - Seguir el wizard de instalación
   - Abrir desde escritorio/menú inicio
   - Usar la app (sin necesidad de Node.js)

## Verificación manual

Si `npm run electron:build` sigue fallando después de probar soluciones:

### Build manual del instalador (alternativa)

Puedes crear un instalador NSIS manualmente con herramientas como:
- **NSIS** (`makensis.exe` + `.nsi` script) — gratuito
- **Inno Setup** — alternativa popular
- **Advanced Installer** — profesional

### Pero lo más simple

Asegurate de que:
1. Carpeta `release/` esté totalmente limpia
2. Ningún proceso node.exe esté corriendo
3. Windows Defender esté desactivado temporalmente
4. Ejecutar desde PowerShell administrativo

```powershell
# Como Admin
cd C:\Users\dagodoy\Downloads\linux-ai-ops-studio
npm run electron:build
```

## Información de versiones

```
Node.js: v24.19.0 (o compatible)
npm: 10.8.0 (o compatible)
Electron: 34.5.8
electron-builder: 26.15.3
```

Si las versiones son significativamente diferentes, considerar actualizar npm y dependencias.

## Desarrollo futuro

Si necesitas iterar sobre la app después del instalador:

1. Cambios en código → `npm run build` (Vite + esbuild)
2. Cambios en Electron → sin rebuild necesario (solo en desarrollo)
3. Para dev: `npm run dev` en terminal 1, luego `npm start` en terminal 2

## Preguntas frecuentes

**¿Por qué falla el build en Windows pero funcionaría en Mac/Linux?**
Antivirus/Defender de Windows es más agresivo al monitorear operaciones de I/O. En Mac/Linux no hay problema.

**¿Se puede usar el NSIS generado automáticamente?**
Sí, electron-builder genera uno automáticamente. Solo necesitamos que se ejecute sin errores.

**¿Puedo distribuir el .exe sin firma?**
Sí, pero Windows SmartScreen mostrará advertencia. Los usuarios ven "Unknown Publisher" — hacen clic en "More info" y "Run anyway". Es normal para apps pequeñas/sin firma.

**¿Qué cambiarios para versiones futuras?**
- En `package.json` actualizar `"version"` → se refleja en `.exe`
- Re-ejecutar `npm run electron:prepare && npm run electron:build`
- Nuevo `release/Linux AI Ops Studio Setup 1.0.0.exe`

---

**Última actualización**: 2026-09-10  
**Siguiente paso**: Resolver error EPERM y ejecutar `npm run electron:build` con éxito
