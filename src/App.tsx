/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import SSHConnectionManager from './components/SSHConnectionManager';
import Dashboard from './components/Dashboard';
import IntelligenceCenter from './components/IntelligenceCenter';
import AgentOpsStudio from './components/AgentOpsStudio';
import { ServerConnection, LinuxProcess, SystemService, DockerContainer, LogLine, LinuxFile, SecurityAsset, AuditLog } from './types';
import { Terminal, Bot, Radio, Sparkles, Server, LayoutDashboard } from 'lucide-react';

type MobileTab = 'servers' | 'dashboard' | 'agent';

export default function App() {
  const [mobileTab, setMobileTab] = useState<MobileTab>('servers');

  // Master connection states
  const [servers, setServers] = useState<ServerConnection[]>([]);
  const [selectedServer, setSelectedServer] = useState<ServerConnection | null>(null);

  // Loaded telemetry parameters for active server
  const [processes, setProcesses] = useState<LinuxProcess[]>([]);
  const [services, setServices] = useState<SystemService[]>([]);
  const [dockerContainers, setDockerContainers] = useState<DockerContainer[]>([]);
  const [files, setFiles] = useState<LinuxFile[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [securityAssets, setSecurityAssets] = useState<SecurityAsset[]>([]);
  
  // App system loaders
  const [loadingServers, setLoadingServers] = useState(true);
  const [loadingState, setLoadingState] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [modelStatus, setModelStatus] = useState<{
    connected: boolean;
    authMode: 'apikey' | 'none';
    model: string | null;
  }>({ connected: false, authMode: 'none', model: null });

  // 1. Initial server pool loading
  const fetchServers = async () => {
    try {
      const response = await fetch('/api/servers');
      const data = await response.json();
      setServers(data);

      if (data.length > 0 && !selectedServer) {
        // Select first server by default
        const activeSrv = data.find((s: any) => s.status === 'online') || data[0];
        setSelectedServer(activeSrv);
      }
    } catch (err) {
      console.error('Error fetching server list:', err);
    } finally {
      setLoadingServers(false);
    }
  };

  // 2. Telemetry and state synchronized fetching
  const refreshActiveServerState = async (silently = false) => {
    if (!selectedServer) return;
    if (!silently) setLoadingState(true);

    try {
      // Reload server specific state parameters
      const response = await fetch(`/api/servers/${selectedServer.id}/state`);
      const data = await response.json();

      setProcesses(data.processes);
      setServices(data.services);
      setDockerContainers(data.dockerContainers);
      setFiles(data.files);
      setLogs(data.logs);
      setSecurityAssets(data.securityAssets);
      
      // Update local server metrics list
      setServers((prev) =>
        prev.map((s) => (s.id === selectedServer.id ? { ...s, ...data.server } : s))
      );
      
      setSelectedServer((prev) => (prev ? { ...prev, ...data.server } : null));
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('Error reloading active Linux state node:', err);
    } finally {
      if (!silently) setLoadingState(false);
    }
  };

  const syncServerConnections = async () => {
    setLoadingState(true);
    try {
      const response = await fetch('/api/servers/sync', { method: 'POST' });
      if (!response.ok) {
        const errPayload = await response.json().catch(() => ({ error: 'Sync error' }));
        throw new Error(errPayload.error || 'Failed to sync server connections.');
      }

      const serverList = await response.json();
      setServers(serverList);

      const activeServer =
        serverList.find((s: ServerConnection) => s.id === selectedServer?.id) ||
        serverList.find((s: ServerConnection) => s.status === 'online') ||
        serverList[0] ||
        null;

      setSelectedServer(activeServer);
      if (activeServer) {
        const stateResp = await fetch(`/api/servers/${activeServer.id}/state`);
        if (stateResp.ok) {
          const stateData = await stateResp.json();
          setProcesses(stateData.processes);
          setServices(stateData.services);
          setDockerContainers(stateData.dockerContainers);
          setFiles(stateData.files);
          setLogs(stateData.logs);
          setSecurityAssets(stateData.securityAssets);
          setSelectedServer((prev) => (prev ? { ...prev, ...stateData.server } : activeServer));
        }
      }

      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('Error syncing server connections:', err);
    } finally {
      setLoadingState(false);
    }
  };

  const deleteServer = async (serverId: string) => {
    try {
      const response = await fetch(`/api/servers/${serverId}`, { method: 'DELETE' });
      if (!response.ok) {
        const errPayload = await response.json().catch(() => ({ error: 'Delete failed' }));
        throw new Error(errPayload.error || 'Failed to delete the server.');
      }

      const updatedList = servers.filter((srv) => srv.id !== serverId);
      setServers(updatedList);

      if (selectedServer?.id === serverId) {
        const nextServer = updatedList.find((srv) => srv.status === 'online') || updatedList[0] || null;
        setSelectedServer(nextServer);
        if (nextServer) {
          refreshActiveServerState();
        }
      }
    } catch (err) {
      console.error('Error deleting server:', err);
    }
  };

  const cleanupUnusedServers = async () => {
    setLoadingState(true);
    try {
      const response = await fetch('/api/servers/cleanup', { method: 'POST' });
      if (!response.ok) {
        const errPayload = await response.json().catch(() => ({ error: 'Cleanup failed' }));
        throw new Error(errPayload.error || 'Failed to cleanup unused servers.');
      }

      const data = await response.json();
      setServers(data.servers);

      if (selectedServer && data.removed > 0 && !data.servers.some((srv: ServerConnection) => srv.id === selectedServer.id)) {
        const nextServer = data.servers.find((srv: ServerConnection) => srv.status === 'online') || data.servers[0] || null;
        setSelectedServer(nextServer);
        if (nextServer) {
          refreshActiveServerState();
        }
      }

      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('Error cleaning up unused servers:', err);
    } finally {
      setLoadingState(false);
    }
  };

  useEffect(() => {
    fetchServers();
  }, []);

  // Sync state whenever selected server changes
  useEffect(() => {
    if (selectedServer?.id) {
      refreshActiveServerState();
    }
  }, [selectedServer?.id]);

  // Telemetry poll interval for active graphs and real-time streams
  useEffect(() => {
    const timer = setInterval(() => {
      if (selectedServer?.id) {
        refreshActiveServerState(true);
      }
    }, 6000); // 6 sec loop
    return () => clearInterval(timer);
  }, [selectedServer?.id]);

  const fetchOpenRouterStatus = async () => {
    try {
      const response = await fetch('/auth/openrouter/status');
      if (!response.ok) return;
      const data = await response.json();
      setModelStatus({
        connected: data.connected,
        authMode: data.authMode,
        model: data.model || null,
      });
    } catch (err) {
      console.error('Error fetching OpenRouter status:', err);
    }
  };

  useEffect(() => {
    fetchOpenRouterStatus();
    const statusTimer = setInterval(fetchOpenRouterStatus, 30000);
    return () => clearInterval(statusTimer);
  }, []);

  // 3. Command execution pathway proxy
  const executeServerCommand = async (command: string) => {
    if (!selectedServer) throw new Error('Ningún servidor activo disponible.');

    const res = await fetch(`/api/servers/${selectedServer.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    
    if (!res.ok) {
      const errPayload = await res.json();
      throw new Error(errPayload.error || 'Server execute action error.');
    }
    
    const output = await res.json();
    return output;
  };

  // 4. File saver mapping
  const saveServerFile = async (filePath: string, content: string) => {
    if (!selectedServer) throw new Error('Ningún servidor activo disponible.');

    const res = await fetch(`/api/servers/${selectedServer.id}/files/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'No se pudo guardar el archivo.');
    }

    refreshActiveServerState(true);
  };

  // 5. Audit logs scanner
  const runSecurityAuditScan = async () => {
    if (!selectedServer) return;
    setLoadingState(true);
    try {
      // Simulate scanning by reloading
      await new Promise((r) => setTimeout(r, 1200));
      refreshActiveServerState();
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingState(false);
    }
  };

  // 6. Connect / Disconnect individual server
  const connectServer = async (serverId: string) => {
    const res = await fetch(`/api/servers/${serverId}/connect`, { method: 'POST' });
    if (!res.ok) return;
    const updated = await res.json();
    setServers((prev) => prev.map((s) => s.id === serverId ? { ...s, ...updated } : s));
    if (selectedServer?.id === serverId) {
      setSelectedServer((prev) => prev ? { ...prev, ...updated } : null);
      if (updated.status === 'online') refreshActiveServerState();
    }
  };

  const disconnectServer = async (serverId: string) => {
    const res = await fetch(`/api/servers/${serverId}/disconnect`, { method: 'POST' });
    if (!res.ok) return;
    const updated = await res.json();
    setServers((prev) => prev.map((s) => s.id === serverId ? { ...s, ...updated } : s));
    if (selectedServer?.id === serverId) {
      setSelectedServer((prev) => prev ? { ...prev, ...updated } : null);
    }
  };

  // 7. Add raw new server
  const handleAddNewServerVault = async (srvData: Omit<ServerConnection, 'id' | 'status'>) => {
    const res = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(srvData),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Error instantiating server connect credentials.');
    }

    const created = await res.json();
    setServers((prev) => [...prev, created]);
    setSelectedServer(created);
  };

  const MOBILE_TABS = [
    { id: 'servers' as MobileTab, label: 'Servidores', icon: Server },
    { id: 'dashboard' as MobileTab, label: 'Dashboard', icon: LayoutDashboard },
    { id: 'agent' as MobileTab, label: 'Agente IA', icon: Bot },
  ];

  return (
    <div id="linux-ai-ops-studio-app" className="min-h-screen bg-brand-bg text-[#E5E7EB] flex flex-col font-sans select-none selection:bg-emerald-500/30 selection:text-emerald-300">

      {/* HEADER */}
      <header className="border-b border-brand-border bg-brand-bar px-4 sm:px-6 py-3 flex flex-shrink-0 items-center justify-between shadow-md gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-2 bg-gradient-to-tr from-emerald-600 to-blue-600 rounded-lg shadow-lg ring-1 ring-emerald-500/20 flex-shrink-0">
            <Radio className="w-4 h-4 sm:w-5 sm:h-5 text-white animate-pulse" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h1 className="text-xs sm:text-sm font-bold text-zinc-50 font-display uppercase tracking-tight leading-none whitespace-nowrap">
                Linux ASO
              </h1>
              <span className="text-[10px] font-semibold text-zinc-400 hidden sm:inline whitespace-nowrap">by Daniel Godoy</span>
              <span className="text-[10px] uppercase font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 flex items-center gap-1 flex-shrink-0">
                <Sparkles className="w-2.5 h-2.5" /> OpenRouter
              </span>
            </div>
            <p className="text-[10px] text-brand-text-muted font-sans mt-0.5 hidden sm:block">Autonomous Systems orchestrator</p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs flex-shrink-0">
          <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 bg-brand-dark/40 border border-brand-border rounded-lg text-brand-text-muted font-mono text-[11px]">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping flex-shrink-0" />
            <span className="text-emerald-400 font-mono whitespace-nowrap">
              {modelStatus.connected ? `Modelo: ${modelStatus.model}` : 'OpenRouter: sin configurar'}
            </span>
          </div>
          {lastUpdated && (
            <span className="text-[10px] text-brand-text-muted font-mono hidden lg:inline whitespace-nowrap">
              Sync: {lastUpdated}
            </span>
          )}
          <button
            onClick={fetchOpenRouterStatus}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs rounded-lg font-semibold whitespace-nowrap"
          >
            <Radio className="w-3 h-3" />
            <span className="hidden sm:inline">Actualizar</span>
          </button>
        </div>
      </header>

      {/* MOBILE TAB BAR */}
      <div className="xl:hidden flex border-b border-brand-border bg-brand-bar flex-shrink-0">
        {MOBILE_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setMobileTab(id)}
            className={`flex-1 flex flex-col items-center gap-1 py-2.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
              mobileTab === id
                ? 'text-emerald-400 border-b-2 border-emerald-400'
                : 'text-brand-text-muted hover:text-zinc-300'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* DESKTOP: 3-column grid | MOBILE: single panel via tabs */}
      <main className="flex-1 overflow-hidden xl:grid xl:grid-cols-5 xl:p-5 xl:gap-4 xl:h-[calc(100vh-68px)]">

        {/* Left — Connection Vault */}
        <div className={`xl:col-span-1 xl:h-full xl:overflow-hidden xl:block p-4 xl:p-0 h-[calc(100vh-120px)] overflow-y-auto ${mobileTab === 'servers' ? 'block' : 'hidden xl:block'}`}>
          <SSHConnectionManager
            servers={servers}
            selectedServer={selectedServer}
            onSelectServer={(srv) => { setSelectedServer(srv); setMobileTab('dashboard'); }}
            onAddServer={handleAddNewServerVault}
            onDeleteServer={deleteServer}
            onConnectServer={connectServer}
            onDisconnectServer={disconnectServer}
            onCleanupUnusedServers={cleanupUnusedServers}
            loading={loadingServers}
          />
        </div>

        {/* Center — Dashboard + Intelligence */}
        <div className={`xl:col-span-2 xl:h-full xl:overflow-hidden xl:flex xl:flex-col xl:gap-4 xl:block p-4 xl:p-0 h-[calc(100vh-120px)] overflow-y-auto flex flex-col gap-4 ${mobileTab === 'dashboard' ? 'block' : 'hidden xl:flex'}`}>
          <div className="flex-1 min-h-0">
            <Dashboard
              server={selectedServer}
              processes={processes}
              services={services}
              dockerContainers={dockerContainers}
              onExecuteCommand={executeServerCommand}
              onRefresh={() => syncServerConnections()}
              loading={loadingState}
            />
          </div>
          <div className="flex-1 min-h-0">
            <IntelligenceCenter
              server={selectedServer}
              files={files}
              logs={logs}
              securityAssets={securityAssets}
              onExecuteCommand={executeServerCommand}
              onSaveFile={saveServerFile}
              onRunAuditScan={runSecurityAuditScan}
            />
          </div>
        </div>

        {/* Right — Agent Copilot */}
        <div className={`xl:col-span-2 xl:h-full xl:overflow-hidden xl:block p-4 xl:p-0 h-[calc(100vh-120px)] overflow-hidden ${mobileTab === 'agent' ? 'block' : 'hidden xl:block'}`}>
          <AgentOpsStudio
            server={selectedServer}
            onExecuteCommand={executeServerCommand}
            onRefreshTelemetry={() => refreshActiveServerState(true)}
          />
        </div>

      </main>
    </div>
  );
}
