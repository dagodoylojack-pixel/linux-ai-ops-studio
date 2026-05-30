/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { ServerConnection, LinuxProcess, SystemService, DockerContainer } from '../types';
import { CPUUsageMeter, RAMUsageMeter, CircularProgress } from './MetricsGraphics';
import {
  Activity,
  Cpu,
  Database,
  RefreshCw,
  Power,
  Play,
  PlayCircle,
  StopCircle,
  Thermometer,
  Clock,
  Users,
  Grid,
  Settings,
  XCircle,
  AlertTriangle,
  Layers,
  CheckCircle,
} from 'lucide-react';

interface DashboardProps {
  server: ServerConnection | null;
  processes: LinuxProcess[];
  services: SystemService[];
  dockerContainers: DockerContainer[];
  onExecuteCommand: (cmd: string) => Promise<any>;
  onRefresh: () => void;
  loading: boolean;
}

export default function Dashboard({
  server,
  processes,
  services,
  dockerContainers,
  onExecuteCommand,
  onRefresh,
  loading,
}: DashboardProps) {
  const [activeTab, setActiveTab] = useState<'resources' | 'processes' | 'services' | 'docker'>('resources');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  if (!server) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-400 font-sans p-8 text-center bg-zinc-950 border border-zinc-900 rounded-2xl">
        <ServerIconFallback />
        <h3 className="mt-4 text-base font-semibold text-zinc-200">Ningún Servidor Conectado</h3>
        <p className="mt-1 text-xs text-zinc-500 max-w-sm">
          Selecciona un servidor del pool del Vault o agrega uno nuevo para visualizar la telemetría e iniciar el asistente inteligente.
        </p>
      </div>
    );
  }

  // Handle process kill
  const handleKillProcess = async (pid: number, commandName: string) => {
    setActionLoading(`kill-${pid}`);
    setDashboardError(null);
    try {
      await onExecuteCommand(`kill -9 ${pid}`);
      onRefresh();
    } catch (err: any) {
      setDashboardError(`Error al matar proceso (${commandName}): ${err?.message || err}`);
      setTimeout(() => setDashboardError(null), 6000);
    } finally {
      setActionLoading(null);
    }
  };

  // Handle service actions — works on systemd, SysV init.d and OpenRC
  const handleServiceAction = async (serviceName: string, action: 'restart' | 'stop', description = '') => {
    setActionLoading(`${action}-${serviceName}`);
    setDashboardError(null);
    // Strip .service suffix for the `service` command and rc-service
    const baseName = serviceName.replace(/\.service$/, '');
    // Build the right command per init system detected from the service description
    const cmd = description.startsWith('OpenRC')
      ? `rc-service ${baseName} ${action}`
      : description.startsWith('SysV')
      ? `service ${baseName} ${action}`   // /etc/init.d wrapper, works on CentOS 6/7 SysV
      : `systemctl ${action} ${serviceName}`;  // systemd default
    try {
      await onExecuteCommand(cmd);
      onRefresh();
    } catch (err: any) {
      setDashboardError(`Error al ejecutar (${action} ${serviceName}): ${err?.message || err}`);
      setTimeout(() => setDashboardError(null), 6000);
    } finally {
      setActionLoading(null);
    }
  };

  // Handle Docker actions
  const handleDockerAction = async (containerName: string, action: 'start' | 'stop') => {
    setActionLoading(`${action}-${containerName}`);
    setDashboardError(null);
    try {
      await onExecuteCommand(`docker ${action} ${containerName}`);
      onRefresh();
    } catch (err: any) {
      setDashboardError(`Error en Docker (${action} ${containerName}): ${err?.message || err}`);
      setTimeout(() => setDashboardError(null), 6000);
    } finally {
      setActionLoading(null);
    }
  };

  // Dynamic colors for gauges
  const getResourceColor = (value: number) => {
    if (value > 85) return 'text-red-500 bg-red-500/10 border-red-500/20';
    if (value > 65) return 'text-amber-500 bg-amber-500/10 border-amber-500/20';
    return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
  };

  // Zero out all metrics when the server is offline to avoid showing stale data
  const isOffline = server.status !== 'online';
  const cpu    = isOffline ? 0 : (server.cpuUsage  || 0);
  const ram    = isOffline ? 0 : (server.ramUsage   || 0);
  const ramTotal = server.ramTotal || 4;
  const disk   = isOffline ? 0 : (server.diskUsage  || 0);
  const temp   = isOffline ? 0 : (server.temperature || 0);
  const rxKbs  = isOffline ? 0 : (server.rxRate || 0);
  const txKbs  = isOffline ? 0 : (server.txRate || 0);
  const totalKbs = rxKbs + txKbs;
  const netDisplay = isOffline ? '0 KB/s'
    : totalKbs >= 1024 ? `${(totalKbs / 1024).toFixed(1)} MB/s`
    : `${totalKbs} KB/s`;
  const hasTemp = !isOffline && server.temperature !== undefined && (server.temperature as number) >= 0;

  return (
    <div id="ops-dashboard" className="bg-brand-bg border border-brand-border rounded-xl p-4 flex flex-col h-full shadow-2xl">
      {/* Dynamic Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-brand-border pb-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-sm font-bold text-zinc-100 font-display uppercase tracking-tight">{server.name}</h1>
            <span className={`w-2 h-2 rounded-full ${server.status === 'online' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
            <span className="text-[10px] text-zinc-400 bg-brand-dark border border-brand-border px-2 py-0.5 rounded font-mono">
              {server.host}
            </span>
            <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${server.status === 'online' ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-300 border border-rose-500/20'}`}>
              {server.status === 'online' ? 'Conectado' : 'Desconectado'}
            </span>
          </div>
          <p className="text-[11px] text-brand-text-muted mt-1 font-sans">{server.osName || 'Linux Genérico'}</p>
        </div>

        <div className="flex items-center gap-2">
          {/* Uptime indicators */}
          <div className="hidden sm:flex items-center gap-4 text-brand-text-dim text-[11px] pr-2 border-r border-brand-border font-mono">
            <div className="flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-brand-text-muted" />
              <span>{server.uptime || 'N/A'}</span>
            </div>
            <div className="flex items-center gap-1">
              <Users className="w-3.5 h-3.5 text-brand-text-muted" />
              <span>{server.usersConnected?.length || 0} usuarios</span>
            </div>
          </div>
          
          <button
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-border rounded hover:bg-[#333] border border-brand-border-light text-zinc-300 font-semibold text-xs font-sans transition-all cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-emerald-400' : ''}`} />
            Sincronizar
          </button>
        </div>
      </div>

      {/* Inline Dashboard Action Errors (Anti-Alert iframe compatible) */}
      {dashboardError && (
        <div className="mt-3 flex items-center gap-2 p-2.5 bg-rose-950/20 border border-rose-900/30 text-rose-400 text-xs rounded-lg animate-pulse select-text">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 text-rose-500" />
          <span className="font-sans font-medium">{dashboardError}</span>
        </div>
      )}

      {/* Primary Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-px bg-brand-border border border-brand-border rounded overflow-hidden mt-4">
        {/* CPU Panel */}
        <div className="bg-brand-panel p-3.5">
          <div className="text-[10px] text-brand-text-muted uppercase mb-1 font-bold font-mono">CPU Load</div>
          <div className="flex items-center gap-2.5">
            <span className="text-lg font-mono text-emerald-400 font-bold">{cpu}%</span>
            <div className="flex-1 h-1.5 bg-brand-dark rounded-full overflow-hidden">
              <div style={{ width: `${cpu}%` }} className="h-full bg-emerald-500 transition-all duration-300"></div>
            </div>
          </div>
          <span className="text-[9px] text-brand-text-dim font-mono block mt-1 truncate max-w-[150px]">{server.cpuModel}</span>
        </div>

        {/* RAM Panel */}
        <div className="bg-brand-panel p-3.5">
          <div className="text-[10px] text-brand-text-muted uppercase mb-1 font-bold font-mono">RAM Usage</div>
          <div className="flex items-center gap-2.5">
            <span className="text-lg font-mono text-amber-400 font-bold">{ram}<small className="text-[10px] ml-1 uppercase">GB</small></span>
            <div className="flex-1 h-1.5 bg-brand-dark rounded-full overflow-hidden">
              <div style={{ width: `${Math.round((ram / (ramTotal || 1)) * 100)}%` }} className="h-full bg-amber-500 transition-all duration-300"></div>
            </div>
          </div>
          <span className="text-[9px] text-brand-text-dim font-mono block mt-1">de {ramTotal} GB totales</span>
        </div>

        {/* Disk Panel */}
        <div className="bg-brand-panel p-3.5">
          <div className="text-[10px] text-brand-text-muted uppercase mb-1 font-bold font-mono">Disk Storage</div>
          <div className="flex items-center gap-2.5">
            <span className="text-lg font-mono text-blue-400 font-bold">{disk}%</span>
            <div className="flex-1 h-1.5 bg-brand-dark rounded-full overflow-hidden">
              <div style={{ width: `${disk}%` }} className="h-full bg-blue-500 transition-all duration-300"></div>
            </div>
          </div>
          <span className="text-[9px] text-brand-text-dim font-mono block mt-1">capacidad utilizada</span>
        </div>

        {/* Net Panel */}
        <div className="bg-brand-panel p-3.5">
          <div className="text-[10px] text-brand-text-muted uppercase mb-1 font-bold font-mono">Network I/O</div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-mono text-blue-400 font-bold">{netDisplay}</span>
            <div className="flex gap-0.5 items-end h-4 ml-auto">
              <div className={`w-1 h-[20%] ${isOffline ? 'bg-zinc-700' : 'bg-blue-500 animate-pulse'}`}></div>
              <div className={`w-1 h-[40%] ${isOffline ? 'bg-zinc-700' : 'bg-blue-500'}`}></div>
              <div className={`w-1 h-[80%] ${isOffline ? 'bg-zinc-700' : 'bg-blue-500'}`}></div>
              <div className={`w-1 h-[50%] ${isOffline ? 'bg-zinc-700' : 'bg-blue-500'}`}></div>
            </div>
          </div>
          <div className="flex justify-between items-center text-[9px] text-brand-text-dim font-mono mt-1">
            <span>RX: {rxKbs} KB/s</span>
            <span>TX: {txKbs} KB/s</span>
          </div>
        </div>

        {/* Temperature Panel */}
        <div className="bg-brand-panel p-3.5">
          <div className="text-[10px] text-brand-text-muted uppercase mb-1 font-bold font-mono">Core Temp</div>
          <div className="flex items-baseline gap-2">
            <span className={`text-lg font-mono font-bold ${hasTemp ? 'text-orange-400' : 'text-zinc-500'}`}>
              {hasTemp ? `${temp}°C` : '—'}
            </span>
            {hasTemp && temp < 80 && (
              <span className="text-[9px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1 py-0.2 rounded font-mono ml-auto">NORMAL</span>
            )}
            {hasTemp && temp >= 80 && (
              <span className="text-[9px] text-red-400 bg-red-500/10 border border-red-500/20 px-1 py-0.2 rounded font-mono ml-auto">HIGH</span>
            )}
          </div>
          <span className="text-[9px] text-brand-text-dim font-mono block mt-1">
            {isOffline ? '● Sin datos de telemetría' : hasTemp ? '● Thermal regulation active' : '● Sensor no disponible'}
          </span>
        </div>
      </div>

      {/* Tabs Menu */}
      <div className="flex overflow-x-auto border-b border-brand-border mt-5 no-scrollbar">
        {[
          { id: 'resources', label: 'Monitor de Recursos' },
          { id: 'processes', label: `Procesos (${processes.length})` },
          { id: 'services', label: `Servicios (${services.length})` },
          { id: 'docker', label: `Docker Containers (${dockerContainers.length})` },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex-shrink-0 px-4 py-2 text-xs font-bold border-b-2 font-sans transition-all cursor-pointer whitespace-nowrap ${
              activeTab === tab.id
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-brand-text-muted hover:text-[#E5E7EB]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content Panels */}
      <div className="flex-1 overflow-y-auto mt-3 pr-1 min-h-[220px]">
        {activeTab === 'resources' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full p-1">
            {/* Visual metrics graphs */}
            <div className="bg-brand-panel border border-brand-border p-3.5 rounded">
              <h3 className="text-[10px] font-bold text-brand-text-muted uppercase tracking-widest font-mono mb-3">Live CPU Activity</h3>
              <CPUUsageMeter value={cpu} />
            </div>
            <div className="bg-brand-panel border border-brand-border p-3.5 rounded">
              <h3 className="text-[10px] font-bold text-brand-text-muted uppercase tracking-widest font-mono mb-3">Memory Resource Commit</h3>
              <RAMUsageMeter used={ram} total={ramTotal} />
            </div>
          </div>
        )}

        {activeTab === 'processes' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="border-b border-brand-border text-brand-text-muted font-mono text-[10px]">
                  <th className="py-2 px-3">PID</th>
                  <th className="py-2 px-3">USER</th>
                  <th className="py-2 px-3">CPU%</th>
                  <th className="py-2 px-3">MEM%</th>
                  <th className="py-2 px-3">TTY</th>
                  <th className="py-2 px-3">COMMAND</th>
                  <th className="py-2 px-3 text-right">OPERACIÓN</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border bg-brand-dark/20">
                {processes.map((proc) => (
                  <tr key={proc.pid} className="hover:bg-brand-item text-zinc-300">
                    <td className="py-2.5 px-3 text-brand-text-muted">{proc.pid}</td>
                    <td className="py-2.5 px-3 font-semibold">{proc.user}</td>
                    <td className="py-2.5 px-3 text-emerald-400">{proc.cpu}%</td>
                    <td className="py-2.5 px-3 text-amber-500">{proc.mem}%</td>
                    <td className="py-2.5 px-3 text-brand-text-dim">{proc.tty}</td>
                    <td className="py-2.5 px-3 text-zinc-100 max-w-[200px] truncate font-mono" title={proc.command}>
                      {proc.command}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <button
                        onClick={() => handleKillProcess(proc.pid, proc.command)}
                        disabled={actionLoading === `kill-${proc.pid}`}
                        className={`px-2 py-1 ${
                          actionLoading === `kill-${proc.pid}` ? 'bg-zinc-800 text-zinc-500' : 'bg-red-950/40 border border-red-900/50 text-red-400 hover:bg-red-950'
                        } rounded text-[10px] font-bold tracking-tight transition-colors cursor-pointer`}
                      >
                        {actionLoading === `kill-${proc.pid}` ? 'Procesando...' : 'SIGKILL'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'services' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-1">
            {services.map((svc) => {
              const isRunning = svc.active === 'active';
              return (
                <div key={svc.name} className="bg-brand-panel border border-brand-border p-3 rounded flex items-center justify-between">
                  <div className="flex gap-3">
                    <div className={`p-2 rounded flex-shrink-0 ${
                      isRunning ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-500'
                    }`}>
                      {isRunning ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-zinc-200">{svc.name}</h4>
                      <p className="text-[10px] text-brand-text-muted mt-0.5 max-w-[180px] sm:max-w-[220px] truncate font-sans" title={svc.description}>
                        {svc.description || '—'}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className={`inline-block text-[9px] font-mono px-1.5 py-0.5 rounded ${
                          isRunning ? 'bg-emerald-950/50 text-emerald-400' : 'bg-brand-dark text-brand-text-muted'
                        }`}>
                          {svc.active} ({svc.sub})
                        </span>
                        {(svc.description === 'SysV' || svc.description === 'OpenRC') && (
                          <span className="inline-block text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-400 border border-amber-900/30">
                            {svc.description}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-1">
                    <button
                      onClick={() => handleServiceAction(svc.name, 'restart', svc.description)}
                      disabled={actionLoading !== null}
                      title="Reiniciar servicio"
                      className="p-1 px-2 text-[10px] bg-brand-item border border-brand-border hover:bg-brand-bar text-zinc-300 rounded cursor-pointer"
                    >
                      <RefreshCw className="w-3 h-3 block m-auto" />
                    </button>
                    {isRunning ? (
                      <button
                        onClick={() => handleServiceAction(svc.name, 'stop', svc.description)}
                        disabled={actionLoading !== null}
                        title="Detener servicio"
                        className="p-1 px-2 text-[10px] bg-red-950/20 border border-red-900/40 text-red-500 hover:bg-red-950 rounded cursor-pointer"
                      >
                        <Power className="w-3 h-3 block m-auto" />
                      </button>
                    ) : (
                      <button
                        onClick={() => handleServiceAction(svc.name, 'restart', svc.description)}
                        disabled={actionLoading !== null}
                        title="Iniciar servicio"
                        className="p-1 px-2 text-[10px] bg-emerald-950/20 border border-emerald-900/40 text-emerald-400 hover:bg-emerald-950 rounded cursor-pointer"
                      >
                        <Play className="w-3 h-3 block m-auto" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === 'docker' && (
          <div className="space-y-3 p-1">
            {dockerContainers.length === 0 ? (
              <div className="p-6 bg-brand-panel border border-brand-border rounded text-center text-brand-text-muted text-xs">
                No se detectaron contenedores ejecutándose en el socket Docker de este nodo.
              </div>
            ) : (
              dockerContainers.map((container) => {
                const isRunning = container.status.includes('Up');
                return (
                  <div key={container.id} className="bg-brand-panel border border-brand-border p-3 rounded flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex gap-3">
                      <div className={`p-2 rounded flex-shrink-0 align-middle ${
                        isRunning ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-500'
                      }`}>
                        <Layers className="w-4.5 h-4.5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="text-xs font-bold text-zinc-100">{container.name}</h4>
                          <span className={`text-[9px] font-mono px-1.5 py-0.2 rounded ${
                            isRunning ? 'bg-emerald-950/60 text-emerald-400 font-bold' : 'bg-brand-dark text-white'
                          }`}>
                            {container.status}
                          </span>
                        </div>
                        <p className="text-[10px] text-brand-text-muted font-mono mt-1">
                          IMAGE: {container.image} | PORTS: {container.ports || 'N/A'}
                        </p>
                        <div className="flex gap-4 mt-1.5 text-[9px] text-brand-text-muted font-mono">
                          <span>CPU: <span className="text-emerald-400 font-bold">{container.cpu}%</span></span>
                          <span>MEM: <span className="text-amber-400 font-bold">{container.mem}</span></span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {isRunning ? (
                        <button
                          onClick={() => handleDockerAction(container.name, 'stop')}
                          disabled={actionLoading !== null}
                          className="flex items-center gap-1 px-2.5 py-1 bg-red-950/40 border border-red-900/50 hover:bg-red-950 text-red-400 rounded text-[10px] font-bold cursor-pointer"
                        >
                          <StopCircle className="w-3.5 h-3.5" /> Stop
                        </button>
                      ) : (
                        <button
                          onClick={() => handleDockerAction(container.name, 'start')}
                          disabled={actionLoading !== null}
                          className="flex items-center gap-1 px-2.5 py-1 bg-emerald-950/40 border border-emerald-900/50 hover:bg-emerald-950 text-emerald-400 rounded text-[10px] font-bold cursor-pointer"
                        >
                          <PlayCircle className="w-3.5 h-3.5" /> Run
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ServerIconFallback() {
  return (
    <div className="relative p-6 bg-zinc-900 border border-zinc-800 rounded-2xl text-emerald-400/80">
      <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-red-400" />
      <Settings className="w-12 h-12 stroke-[1.2] animate-spin-slow" />
    </div>
  );
}
