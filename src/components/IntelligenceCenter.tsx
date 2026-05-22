/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { ServerConnection, TerminalLine, LogLine, LinuxFile, SecurityAsset, SFTPEntry } from '../types';
import {
  Terminal as TermIcon,
  AlignLeft,
  FileCode,
  AlertTriangle,
  Save,
  Cpu,
  FolderOpen,
  Send,
  Upload,
  Download,
  ChevronRight,
  ArrowUp,
  RefreshCw,
} from 'lucide-react';

interface IntelligenceCenterProps {
  server: ServerConnection | null;
  files: LinuxFile[];
  logs: LogLine[];
  securityAssets: SecurityAsset[];
  onExecuteCommand: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  onSaveFile: (path: string, content: string) => Promise<void>;
  onRunAuditScan: () => Promise<void>;
}

export default function IntelligenceCenter({
  server,
  logs,
  securityAssets,
  onExecuteCommand,
  onRunAuditScan,
}: IntelligenceCenterProps) {
  const [activeTab, setActiveTab] = useState<'terminal' | 'logs' | 'files' | 'security'>('terminal');

  // Terminal States
  const [termLines, setTermLines] = useState<TerminalLine[]>([
    {
      id: 'init-1',
      type: 'system',
      text: 'Linux AI Ops Smart Console [v1.0.0] - Secure SSH Layer Active.',
      timestamp: new Date().toLocaleTimeString(),
    },
    {
      id: 'init-2',
      type: 'stdout',
      text: 'Type a command or write naturally. Type "help" or select Agent actions above.',
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [inputCmd, setInputCmd] = useState('');
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [cwd, setCwd] = useState<string>('~');
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Logs States
  const [logFilter, setLogFilter] = useState('all');
  const [diagnosingLogs, setDiagnosingLogs] = useState(false);
  const [logsAiDiagnostic, setLogsAiDiagnostic] = useState<string | null>(null);

  // File AI analysis states (shared with SFTP editor)
  const [selectedFilePath, setSelectedFilePath] = useState<string>('');
  const [editedCode, setEditedCode] = useState('');
  const [editorNotice, setEditorNotice] = useState('');
  const [explainingFile, setExplainingFile] = useState(false);
  const [fileAiExplanation, setFileAiExplanation] = useState<string | null>(null);

  // SFTP Browser States
  const [sftpPath, setSftpPath] = useState<string>('/');
  const [sftpEntries, setSftpEntries] = useState<SFTPEntry[]>([]);
  const [sftpLoading, setSftpLoading] = useState(false);
  const [sftpError, setSftpError] = useState<string | null>(null);
  const [sftpSelectedFile, setSftpSelectedFile] = useState<{ path: string } | null>(null);
  const [sftpFileLoading, setSftpFileLoading] = useState(false);
  const [sftpUploading, setSftpUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Handle terminal scroll
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [termLines]);

  // Reset SFTP state when active server changes
  useEffect(() => {
    setSftpPath('/');
    setSftpEntries([]);
    setSftpSelectedFile(null);
    setSftpError(null);
    setEditedCode('');
    setFileAiExplanation(null);
    setSelectedFilePath('');
  }, [server?.id]);

  // SFTP functions

  const loadSftpDir = async (path: string) => {
    if (!server) return;
    setSftpLoading(true);
    setSftpError(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/sftp/ls?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al listar directorio.');
      setSftpEntries(data.entries || []);
      setSftpPath(path);
    } catch (err: any) {
      setSftpError(err.message);
    } finally {
      setSftpLoading(false);
    }
  };

  const loadSftpFile = async (filePath: string) => {
    if (!server) return;
    setSftpFileLoading(true);
    setSftpError(null);
    setFileAiExplanation(null);
    try {
      const res = await fetch(`/api/servers/${server.id}/sftp/read?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al leer archivo.');
      setSftpSelectedFile({ path: filePath });
      setSelectedFilePath(filePath);
      setEditedCode(data.content);
    } catch (err: any) {
      setSftpError(err.message);
    } finally {
      setSftpFileLoading(false);
    }
  };

  const saveSftpFile = async () => {
    if (!server || !sftpSelectedFile) return;
    setEditorNotice('');
    try {
      const res = await fetch(`/api/servers/${server.id}/sftp/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: sftpSelectedFile.path, content: editedCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al guardar.');
      setEditorNotice('¡Archivo guardado en el servidor!');
      setTimeout(() => setEditorNotice(''), 3000);
    } catch (err: any) {
      setEditorNotice(`Error: ${err.message}`);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !server) return;
    setSftpUploading(true);
    setSftpError(null);
    try {
      await new Promise<void>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = (reader.result as string).split(',')[1];
          try {
            const res = await fetch(`/api/servers/${server.id}/sftp/upload`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: sftpPath, content: base64, filename: file.name }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Error al subir archivo.');
            await loadSftpDir(sftpPath);
            resolve();
          } catch (err: any) {
            reject(err);
          }
        };
        reader.onerror = () => reject(new Error('Error al leer el archivo local.'));
        reader.readAsDataURL(file);
      });
    } catch (err: any) {
      setSftpError(err.message);
    } finally {
      setSftpUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  const goUp = () => {
    if (sftpPath === '/') return;
    const parts = sftpPath.split('/').filter(Boolean);
    parts.pop();
    loadSftpDir(parts.length === 0 ? '/' : '/' + parts.join('/'));
  };

  // Load directory when files tab becomes active or server changes
  useEffect(() => {
    if (activeTab === 'files' && server?.id) {
      loadSftpDir('/');
    }
  }, [activeTab, server?.id]);

  const handleTerminalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const command = inputCmd.trim();
    if (!command) return;

    const timestamp = new Date().toLocaleTimeString();

    const inputLine: TerminalLine = {
      id: Math.random().toString(),
      type: 'input',
      text: command,
      timestamp,
    };

    setTermLines((prev) => [...prev, inputLine]);
    setCmdHistory((prev) => [command, ...prev]);
    setHistoryIdx(-1);
    setInputCmd('');

    if (command === 'clear') {
      setTermLines([]);
      return;
    }

    if (command === 'help') {
      const helpLines: TerminalLine[] = [
        { id: Math.random().toString(), type: 'system', text: 'Soporte de Comandos Rápidos del Sistema:', timestamp },
        { id: Math.random().toString(), type: 'stdout', text: '  - uptime      : diagnóstico de levantado del servidor', timestamp },
        { id: Math.random().toString(), type: 'stdout', text: '  - df -h       : espacio y almacenamiento de discos', timestamp },
        { id: Math.random().toString(), type: 'stdout', text: '  - docker ps   : contenedores cargados en el nodo', timestamp },
        { id: Math.random().toString(), type: 'stdout', text: '  - free -h     : monitoreo detallado de memoria RAM', timestamp },
        { id: Math.random().toString(), type: 'stdout', text: '  - clear       : limpiar la consola del terminal', timestamp },
      ];
      setTermLines((prev) => [...prev, ...helpLines]);
      return;
    }

    const CWD_MARKER = '___CWD___:';
    const cdPrefix = cwd !== '~' ? `cd ${cwd} 2>/dev/null; ` : '';
    const wrappedCommand = `${cdPrefix}${command}; echo "${CWD_MARKER}$(pwd)"`;

    try {
      const result = await onExecuteCommand(wrappedCommand);
      const resLines: TerminalLine[] = [];

      let stdout = result.stdout || '';
      const cwdLineIdx = stdout.split('\n').findIndex((l) => l.startsWith(CWD_MARKER));
      if (cwdLineIdx !== -1) {
        const cwdLines = stdout.split('\n');
        const newCwd = cwdLines[cwdLineIdx].replace(CWD_MARKER, '').trim();
        if (newCwd) setCwd(newCwd);
        cwdLines.splice(cwdLineIdx, 1);
        stdout = cwdLines.join('\n').replace(/\n$/, '');
      }

      if (stdout) {
        resLines.push({ id: Math.random().toString(), type: 'stdout', text: stdout, timestamp });
      }
      if (result.stderr) {
        resLines.push({ id: Math.random().toString(), type: 'stderr', text: result.stderr, timestamp });
      }
      if (!stdout && !result.stderr) {
        resLines.push({
          id: Math.random().toString(),
          type: 'system',
          text: `Command finished. Exit code: ${result.exitCode}`,
          timestamp,
        });
      }

      setTermLines((prev) => [...prev, ...resLines]);
    } catch (err: any) {
      setTermLines((prev) => [
        ...prev,
        { id: Math.random().toString(), type: 'stderr', text: `Error de ejecución: ${err.message}`, timestamp },
      ]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIdx < cmdHistory.length - 1) {
        const nextIdx = historyIdx + 1;
        setHistoryIdx(nextIdx);
        setInputCmd(cmdHistory[nextIdx]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx > 0) {
        const nextIdx = historyIdx - 1;
        setHistoryIdx(nextIdx);
        setInputCmd(cmdHistory[nextIdx]);
      } else if (historyIdx === 0) {
        setHistoryIdx(-1);
        setInputCmd('');
      }
    }
  };

  const runLogDiagnosticAI = async () => {
    setDiagnosingLogs(true);
    setLogsAiDiagnostic(null);
    try {
      const logsContext = logs.slice(-10).map((l) => `[${l.level.toUpperCase()}] ${l.service}: ${l.message}`).join('\n');
      const response = await fetch('/api/openrouter/run-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server?.id,
          role: 'Monitoring',
          prompt: `Analiza estos logs del servidor e identifica el error principal, la causa probable y la solución directa paso a paso:\n${logsContext}`,
        }),
      });
      const data = await response.json();
      setLogsAiDiagnostic(data.explanation || data.reportSummary);
    } catch (err: any) {
      setLogsAiDiagnostic(`Error al diagnosticar: ${err.message}`);
    } finally {
      setDiagnosingLogs(false);
    }
  };

  const runFileExplanationAI = async () => {
    setExplainingFile(true);
    setFileAiExplanation(null);
    try {
      const response = await fetch('/api/openrouter/run-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server?.id,
          role: 'SysAdmin',
          prompt: `Explica las directivas de configuración de este archivo (${selectedFilePath}), advierte si posee malas prácticas y cómo optimizarlo:\n${editedCode}`,
        }),
      });
      const data = await response.json();
      setFileAiExplanation(data.explanation || data.reportSummary);
    } catch (err: any) {
      setFileAiExplanation(`Error al explicar: ${err.message}`);
    } finally {
      setExplainingFile(false);
    }
  };

  const termPrompt = '[' + (server?.name || 'linux') + ']:' + cwd + '$';

  const filteredLogs = logs.filter((l) => {
    if (logFilter === 'all') return true;
    if (logFilter === 'error') return l.level === 'error' || l.level === 'critical';
    return l.service.toLowerCase() === logFilter.toLowerCase();
  });

  const pathParts = sftpPath.split('/').filter(Boolean);

  return (
    <div id="ops-intelligence-center" className="bg-brand-bg border border-brand-border rounded-xl p-4 flex flex-col h-full shadow-2xl overflow-hidden">
      {/* Top Tabs */}
      <div className="flex items-center justify-between border-b border-brand-border pb-2 flex-shrink-0">
        <div className="flex items-center gap-1 bg-brand-dark border border-brand-border p-1 rounded">
          {[
            { id: 'terminal', label: 'Bash Console', icon: TermIcon },
            { id: 'logs', label: 'SysLog Live Tail', icon: AlignLeft },
            { id: 'files', label: 'SFTP Browser', icon: FileCode },
            { id: 'security', label: 'Security Auditor', icon: AlertTriangle },
          ].map((tab) => {
            const Icon = tab.icon;
            const isSel = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded font-sans transition-all cursor-pointer ${
                  isSel
                    ? 'bg-brand-item text-zinc-100 border border-brand-border-light'
                    : 'text-brand-text-muted hover:text-zinc-300'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="hidden md:inline">{tab.label}</span>
              </button>
            );
          })}
        </div>
        <div className="text-[10px] text-brand-text-muted font-mono hidden sm:block">
          SSH @ {server?.username || 'root'}:{server?.host || 'unset'}
        </div>
      </div>

      {/* Main Core Content tabs */}
      <div className="flex-1 overflow-hidden mt-3 relative">

        {/* TAB 1: BASH TERMINAL */}
        {activeTab === 'terminal' && (
          <div className="flex flex-col h-full bg-brand-panel text-zinc-300 font-mono text-xs rounded border border-brand-border overflow-hidden">
            <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-[#050505]/60 min-h-[160px]">
              {termLines.map((line, idx) => {
                if (line.type === 'input') {
                  return (
                    <div key={idx} className="flex gap-1">
                      <span className="text-emerald-400 font-bold font-mono">{termPrompt}</span>
                      <span className="text-zinc-100 font-semibold">{line.text}</span>
                    </div>
                  );
                }
                const colorMap = {
                  stdout: 'text-zinc-300 whitespace-pre-wrap',
                  stderr: 'text-rose-400 whitespace-pre-wrap bg-rose-950/20 px-2 py-1 rounded border border-rose-900/10',
                  system: 'text-emerald-400 font-bold text-[10px] italic',
                };
                return (
                  <div key={idx} className={colorMap[line.type as keyof typeof colorMap] || 'text-zinc-300'}>
                    {line.text}
                  </div>
                );
              })}
              <div ref={terminalEndRef} />
            </div>

            <form onSubmit={handleTerminalSubmit} className="flex border-t border-brand-border bg-brand-bar p-1">
              <span className="text-emerald-400 font-bold self-center px-2 font-mono">{termPrompt}</span>
              <input
                type="text"
                placeholder="Escribe un comando bash o 'help'..."
                value={inputCmd}
                onChange={(e) => setInputCmd(e.target.value)}
                onKeyDown={handleKeyDown}
                className="flex-1 bg-transparent border-none outline-none text-zinc-100 text-xs py-2 px-1 focus:ring-0 font-mono"
              />
              <button type="submit" className="p-2 text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer">
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        )}

        {/* TAB 2: SYSTEM LOGS */}
        {activeTab === 'logs' && (
          <div className="flex flex-col h-full bg-[#050505]/40 rounded border border-brand-border overflow-hidden">
            <div className="flex items-center justify-between p-2.5 bg-brand-bar border-b border-brand-border gap-2 overflow-x-auto">
              <div className="flex gap-1.5">
                {['all', 'ssh', 'nginx', 'postgres', 'fail2ban', 'error'].map((filt) => (
                  <button
                    key={filt}
                    onClick={() => setLogFilter(filt)}
                    className={`px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded font-mono ${
                      logFilter === filt
                        ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                        : 'bg-brand-dark border border-brand-border text-brand-text-muted hover:text-zinc-200'
                    } cursor-pointer`}
                  >
                    {filt}
                  </button>
                ))}
              </div>
              <button
                onClick={runLogDiagnosticAI}
                disabled={diagnosingLogs}
                className="flex items-center gap-1.5 px-3 py-1 bg-emerald-600 text-white rounded text-xs font-bold font-sans cursor-pointer transition-colors hover:bg-emerald-500 disabled:bg-brand-dark disabled:text-zinc-500"
              >
                <Cpu className="w-3.5 h-3.5" />
                {diagnosingLogs ? 'Diagnosticando...' : 'Diagnosticar con IA'}
              </button>
            </div>

            {logsAiDiagnostic && (
              <div className="p-3 bg-emerald-950/20 border-b border-emerald-900/40 text-xs text-emerald-300 font-sans leading-relaxed max-h-40 overflow-y-auto">
                <div className="flex items-center gap-1.5 font-bold mb-1">
                  <Cpu className="w-4 h-4" /> Análisis Diagnóstico de Logs por OpenRouter:
                </div>
                {logsAiDiagnostic}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-2 select-text">
              {filteredLogs.length === 0 ? (
                <div className="text-center py-8 text-brand-text-muted">Ningún registro coincide con el filtro seleccionado.</div>
              ) : (
                filteredLogs.map((log) => {
                  const levelClasses = {
                    info: 'text-brand-text-muted',
                    warn: 'text-amber-400 font-bold',
                    error: 'text-rose-400 bg-red-950/10 px-1 border border-red-950/20 rounded font-bold',
                    critical: 'text-red-500 bg-red-950/30 px-1 border border-red-900/40 rounded blink font-bold',
                  };
                  return (
                    <div key={log.id} className="leading-5 flex items-start gap-2 border-b border-[#050505]/60 pb-1.5">
                      <span className="text-[10px] text-brand-text-dim flex-shrink-0">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="text-emerald-500/80 font-bold font-mono text-[10px] uppercase flex-shrink-0">
                        [{log.service}]
                      </span>
                      <span className={levelClasses[log.level] || 'text-zinc-300'}>{log.message}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* TAB 3: SFTP FILE BROWSER */}
        {activeTab === 'files' && (
          <div className="flex flex-col h-full overflow-hidden gap-2">
            {/* Toolbar: breadcrumb + actions */}
            <div className="flex items-center gap-1.5 px-3 py-2 bg-brand-bar border border-brand-border rounded text-xs overflow-x-auto flex-shrink-0 min-w-0">
              <button
                onClick={() => loadSftpDir('/')}
                className="text-zinc-400 hover:text-emerald-400 font-mono transition-colors flex-shrink-0"
              >
                /
              </button>
              {pathParts.map((part, idx) => (
                <React.Fragment key={idx}>
                  <ChevronRight className="w-3 h-3 text-zinc-600 flex-shrink-0" />
                  <button
                    onClick={() => loadSftpDir('/' + pathParts.slice(0, idx + 1).join('/'))}
                    className="text-zinc-400 hover:text-emerald-400 font-mono transition-colors truncate max-w-[80px]"
                  >
                    {part}
                  </button>
                </React.Fragment>
              ))}

              <div className="flex-1 min-w-0" />

              <button
                onClick={goUp}
                disabled={sftpPath === '/' || sftpLoading}
                title="Subir un nivel"
                className="p-1 text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 transition-colors flex-shrink-0 cursor-pointer"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={() => loadSftpDir(sftpPath)}
                disabled={sftpLoading || !server}
                title="Refrescar"
                className="p-1 text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 transition-colors flex-shrink-0 cursor-pointer"
              >
                <RefreshCw className={'w-3.5 h-3.5' + (sftpLoading ? ' animate-spin' : '')} />
              </button>

              <label
                title={sftpUploading ? 'Subiendo...' : 'Subir archivo al directorio actual'}
                className={'p-1 rounded flex items-center gap-1 transition-colors flex-shrink-0 ' + (sftpUploading || !server ? 'text-zinc-700 cursor-not-allowed' : 'text-zinc-400 hover:text-emerald-400 cursor-pointer')}
              >
                <Upload className="w-3.5 h-3.5" />
                <input
                  type="file"
                  ref={uploadInputRef}
                  onChange={handleFileUpload}
                  className="hidden"
                  disabled={sftpUploading || !server}
                />
              </label>
            </div>

            {/* Error banner */}
            {sftpError && (
              <div className="px-3 py-2 bg-red-950/30 border border-red-900/40 text-rose-300 text-xs rounded flex-shrink-0 flex items-center gap-2">
                <span className="flex-1">{sftpError}</span>
                <button onClick={() => setSftpError(null)} className="text-zinc-500 hover:text-zinc-300">✕</button>
              </div>
            )}

            {/* Main: directory listing + editor */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 flex-1 overflow-hidden min-h-0">
              {/* Left: directory listing */}
              <div className="md:col-span-1 bg-brand-bar border border-brand-border rounded overflow-y-auto max-h-[140px] md:max-h-none">
                {sftpLoading && sftpEntries.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-xs text-brand-text-muted">
                    <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Cargando...
                  </div>
                ) : !server ? (
                  <div className="text-center py-8 text-xs text-brand-text-muted px-3">
                    Sin servidor activo.<br />Seleccione uno en el vault.
                  </div>
                ) : sftpEntries.length === 0 && !sftpLoading ? (
                  <div className="text-center py-8 text-xs text-brand-text-muted">Directorio vacío</div>
                ) : (
                  <div className="py-1">
                    {sftpEntries.map((entry) => {
                      const fullPath = sftpPath === '/' ? '/' + entry.name : sftpPath + '/' + entry.name;
                      const isSelected = sftpSelectedFile?.path === fullPath;
                      return (
                        <button
                          key={entry.name}
                          onClick={() => entry.type === 'dir' ? loadSftpDir(fullPath) : loadSftpFile(fullPath)}
                          className={'w-full text-left flex items-center gap-2 py-1.5 px-2.5 text-xs transition-colors cursor-pointer ' +
                            (isSelected
                              ? 'bg-brand-item text-emerald-400 border-l-2 border-l-emerald-500'
                              : 'text-brand-text-muted hover:bg-brand-panel hover:text-zinc-200')}
                        >
                          <FolderOpen className={'w-3.5 h-3.5 flex-shrink-0 ' + (entry.type === 'dir' ? 'text-amber-400' : 'text-blue-400 opacity-60')} />
                          <span className="truncate font-mono">{entry.name}</span>
                          {entry.type === 'file' && (
                            <span className="text-[9px] text-zinc-600 ml-auto flex-shrink-0">
                              {entry.size > 1048576
                                ? (entry.size / 1048576).toFixed(1) + 'M'
                                : entry.size > 1024
                                ? (entry.size / 1024).toFixed(0) + 'K'
                                : entry.size + 'B'}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Right: file editor panel */}
              <div className="md:col-span-3 flex flex-col bg-brand-panel border border-brand-border rounded overflow-hidden min-h-[220px]">
                {/* Editor toolbar */}
                <div className="flex items-center justify-between p-2.5 bg-brand-bar border-b border-brand-border gap-2 flex-shrink-0">
                  <span className="text-[11px] font-mono text-zinc-300 font-bold truncate max-w-[160px] sm:max-w-[280px]">
                    {sftpSelectedFile?.path || 'Seleccione un archivo para editar'}
                  </span>

                  {sftpSelectedFile && (
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        onClick={runFileExplanationAI}
                        disabled={explainingFile}
                        className="px-2.5 py-1 text-[11px] bg-brand-dark border border-brand-border text-zinc-300 rounded font-sans hover:bg-brand-item font-semibold cursor-pointer disabled:opacity-50"
                      >
                        {explainingFile ? 'Analizando...' : 'Explicar IA'}
                      </button>
                      <a
                        href={'/api/servers/' + server?.id + '/sftp/download?path=' + encodeURIComponent(sftpSelectedFile.path)}
                        download
                        title="Descargar archivo"
                        className="flex items-center gap-1 px-2.5 py-1 bg-brand-dark border border-brand-border text-zinc-300 rounded font-sans text-[11px] hover:bg-brand-item font-semibold"
                      >
                        <Download className="w-3 h-3" />
                      </a>
                      <button
                        onClick={saveSftpFile}
                        className="flex items-center gap-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-sans font-bold text-[11px] cursor-pointer"
                      >
                        <Save className="w-3 h-3" /> Guardar
                      </button>
                    </div>
                  )}
                </div>

                {/* Save notice */}
                {editorNotice && (
                  <div className="p-2 bg-emerald-950/20 border-b border-emerald-900/40 text-[11px] text-emerald-300 font-sans font-semibold flex-shrink-0">
                    {editorNotice}
                  </div>
                )}

                {/* AI explanation */}
                {fileAiExplanation && (
                  <div className="p-3 bg-brand-bar border-b border-brand-border text-xs text-zinc-350 leading-relaxed font-sans max-h-40 overflow-y-auto flex-shrink-0">
                    <div className="flex items-center gap-1.5 text-emerald-400 font-bold mb-1 font-sans">
                      <Cpu className="w-4 h-4" /> Análisis de Configuración:
                    </div>
                    {fileAiExplanation}
                  </div>
                )}

                {/* File loading state */}
                {sftpFileLoading ? (
                  <div className="flex-1 flex items-center justify-center text-xs text-brand-text-muted gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin" /> Cargando archivo...
                  </div>
                ) : (
                  <textarea
                    value={sftpSelectedFile ? editedCode : ''}
                    onChange={(e) => setEditedCode(e.target.value)}
                    placeholder={sftpSelectedFile ? '' : '# Navega el árbol de directorios y selecciona un archivo para editar o descargar...'}
                    readOnly={!sftpSelectedFile}
                    className="flex-1 bg-brand-dark text-[#D1D5DB] p-3 outline-none text-xs border-none font-mono resize-none"
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: SECURITY AUDITOR */}
        {activeTab === 'security' && (
          <div className="flex flex-col h-full bg-[#050505]/40 rounded border border-brand-border p-3 space-y-3 overflow-y-auto w-full">
            <div className="flex items-center justify-between border-b border-brand-border pb-2">
              <div>
                <h3 className="text-xs font-bold text-zinc-300 font-sans uppercase tracking-wider">Resultado de la Auditoría</h3>
                <p className="text-[10px] text-brand-text-muted font-sans mt-0.5">Políticas de Hardening e integridad del Sistema</p>
              </div>
              <button
                onClick={onRunAuditScan}
                className="px-3 py-1 bg-brand-bar border border-brand-border hover:bg-[#333] text-zinc-350 text-xs font-semibold rounded font-sans cursor-pointer"
              >
                Escanear de Nuevo
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {securityAssets.map((asset) => {
                const badgeColor = {
                  secure: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
                  warning: 'bg-amber-500/10 border-amber-500/30 text-amber-500',
                  danger: 'bg-rose-500/10 border-rose-500/30 text-rose-500',
                };
                return (
                  <div key={asset.id} className="bg-brand-panel border border-brand-border p-3 rounded">
                    <div className="flex items-start justify-between gap-1">
                      <h4 className="text-xs font-bold text-zinc-250 truncate max-w-[170px]">{asset.name}</h4>
                      <span className={'px-2 py-0.5 text-[9px] uppercase font-bold rounded border ' + (badgeColor[asset.status] || '')}>
                        {asset.status}
                      </span>
                    </div>
                    <p className="text-[11px] text-brand-text-muted mt-2 leading-relaxed font-sans">{asset.details}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
