<#
.SYNOPSIS
Manage the Linux AI Ops Studio application locally.

.DESCRIPTION
Simple script to start, stop, and check status of the application.
.PARAMETER Action
Action to perform: start, status, stop, or restart
#>

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('start', 'status', 'stop', 'restart', IgnoreCase = $true)]
    [string]$Action
)

$Port = 3005
$ServerFile = 'server.ts'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Helper: Get process listening on port
function Get-PortProcess {
    param([int]$Port)
    try {
        $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        return $connection.OwningProcess
    } catch {
        return $null
    }
}

# Status command
function Show-Status {
    Write-Host ""
    Write-Host "[STATUS] Application Information" -ForegroundColor Cyan
    Write-Host "=" * 50 -ForegroundColor Cyan
    
    $procId = Get-PortProcess $Port
    if ($null -ne $procId) {
        Write-Host "[OK] Running on port $Port (PID: $procId)" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Not running on port $Port" -ForegroundColor Yellow
    }
    
    Write-Host "      URL: http://localhost:$Port" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "[STATUS] Dependencies" -ForegroundColor Cyan
    Write-Host "=" * 50 -ForegroundColor Cyan
    
    if (Test-Path '.\node_modules\express') {
        Write-Host "[OK] Installed" -ForegroundColor Green
    } else {
        Write-Host "[WARN] npm install recommended" -ForegroundColor Yellow
    }
    Write-Host ""
}

# Start command
function Start-App {
    Write-Host ""
    Write-Host "[START] Starting application..." -ForegroundColor Cyan
    
    $procId = Get-PortProcess $Port
    if ($null -ne $procId) {
        Write-Host "[OK] Already running on port $Port (PID: $procId)" -ForegroundColor Green
        Write-Host "      URL: http://localhost:$Port" -ForegroundColor Cyan
        Write-Host ""
        return
    }

    # Install dependencies if needed
    if (-not (Test-Path '.\node_modules\express')) {
        Write-Host "[INFO] Installing dependencies..." -ForegroundColor Yellow
        npm install --quiet 2>&1 | Out-Null
    }

    # Start server in a cmd window (will show output to user)
    Set-Location $ScriptDir
    Start-Process cmd.exe -ArgumentList "/k npx --no-install tsx $ServerFile" | Out-Null
    Start-Sleep -Seconds 6

    # Verify it's running
    $procId = Get-PortProcess $Port
    if ($null -ne $procId) {
        Write-Host "[OK] Application started (PID: $procId)" -ForegroundColor Green
        Write-Host "      URL: http://localhost:$Port" -ForegroundColor Cyan
    } else {
        Write-Host "[WARN] Started process but unable to verify on port yet" -ForegroundColor Yellow
        Write-Host "      URL: http://localhost:$Port" -ForegroundColor Cyan
    }
    Write-Host ""
}

# Stop command
function Stop-App {
    Write-Host ""
    Write-Host "[STOP] Stopping application..." -ForegroundColor Yellow
    
    $procId = Get-PortProcess $Port
    if ($null -eq $procId) {
        Write-Host "[OK] Application is not running" -ForegroundColor Yellow
        Write-Host ""
        return
    }

    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop 2>&1 | Out-Null
        Start-Sleep -Milliseconds 500
        Write-Host "[OK] Application stopped (PID: $procId)" -ForegroundColor Green
    } catch {
        Write-Host "[ERROR] Failed to stop process: $_" -ForegroundColor Red
    }
    Write-Host ""
}

# Main switch
switch ($Action.ToLower()) {
    'start' { Start-App }
    'stop' { Stop-App }
    'status' { Show-Status }
    'restart' {
        Stop-App
        Start-Sleep -Seconds 2
        Start-App
    }
}
