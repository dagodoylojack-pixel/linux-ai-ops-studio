@echo off
REM Script para gestionar la aplicación localmente en Windows
REM Uso: app.bat [start|stop|status|restart]

setlocal enabledelayedexpansion

if "%1"=="" (
    echo.
    echo   Linux AI Ops Studio - Application Manager
    echo   ==========================================
    echo.
    echo   Uso: app.bat [comando]
    echo.
    echo   Comandos:
    echo     start   - Inicia la aplicación en puerto 3005
    echo     stop    - Detiene la aplicación
    echo     status  - Muestra el estado de la aplicación
    echo     restart - Reinicia la aplicación
    echo.
    exit /b 1
)

REM Cambiar a directorio del script
cd /d "%~dp0"

REM Ejecutar script PowerShell con parámetro
powershell -ExecutionPolicy Bypass -NoProfile -File ".\manage-app.ps1" "%1"

exit /b !errorlevel!
