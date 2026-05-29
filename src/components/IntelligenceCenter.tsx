/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { ServerConnection, TerminalLine, LogLine, LinuxFile, SecurityAsset, SFTPEntry, HardeningScanResult, HardeningPolicy } from '../types';
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
  X,
  Trash2,
  Shield,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';

// ── Transfer task types ──────────────────────────────────────────────────────

interface UploadTask {
  id: string;
  filename: string;
  size: number;
  loaded: number;
  pct: number;
  speed: number; // bytes/s
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
}

interface DownloadTask {
  id: string;
  filename: string;
  size: number;
  loaded: number;
  pct: number;
  speed: number;
  status: 'downloading' | 'done' | 'error';
  error?: string;
}

// ── Formatters ───────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

function formatSpeed(bps: number): string {
  if (bps < 1024) return bps.toFixed(0) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(0) + ' KB/s';
  return (bps / 1048576).toFixed(1) + ' MB/s';
}

// ── Props ────────────────────────────────────────────────────────────────────

interface IntelligenceCenterProps {
  server: ServerConnection | null;
  files: LinuxFile[];
  logs: LogLine[];
  securityAssets: SecurityAsset[];
  onExecuteCommand: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  onSaveFile: (path: string, content: string) => Promise<void>;
  onRunAuditScan: () => Promise<void>;
}

// ── Terminal output safety limits ────────────────────────────────────────────

const MAX_OUTPUT_LINES = 500;      // max lines rendered per command output
const MAX_OUTPUT_BYTES = 100_000;  // 100 KB hard cap before line-splitting
const MAX_TERM_LINES   = 2_000;    // max total lines kept in terminal history

/** Truncate raw command output before rendering to avoid UI hang on large files. */
function truncateOutput(raw: string): { text: string; wasTruncated: boolean; totalLines: number } {
  // Server already caps at 500 KB, but guard client-side too
  if (raw.length > MAX_OUTPUT_BYTES) {
    let t = raw.slice(0, MAX_OUTPUT_BYTES);
    const lastNl = t.lastIndexOf('\n');
    if (lastNl > 0) t = t.slice(0, lastNl);
    const totalLines = (raw.match(/\n/g) || []).length + 1;
    return { text: t, wasTruncated: true, totalLines };
  }
  const lines = raw.split('\n');
  if (lines.length > MAX_OUTPUT_LINES) {
    return { text: lines.slice(0, MAX_OUTPUT_LINES).join('\n'), wasTruncated: true, totalLines: lines.length };
  }
  return { text: raw, wasTruncated: false, totalLines: lines.length };
}

// ── Hardening scan UI metadata ────────────────────────────────────────────────

const HARDENING_CAT_META: Record<string, { label: string; emoji: string }> = {
  ssh_hardening:     { label: 'SSH Hardening',          emoji: '🔐' },
  firewall:          { label: 'Firewall',               emoji: '🛡️' },
  kernel_hardening:  { label: 'Kernel Hardening',       emoji: '⚙️' },
  users_permissions: { label: 'Usuarios y Permisos',    emoji: '👥' },
  file_integrity:    { label: 'Integridad de Archivos', emoji: '📁' },
  services:          { label: 'Servicios',              emoji: '🔧' },
};

const HARDENING_STATUS_CLS: Record<string, string> = {
  PASS:  'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  FAIL:  'bg-red-500/10     text-red-400     border-red-500/30',
  WARN:  'bg-amber-500/10   text-amber-400   border-amber-500/30',
  INFO:  'bg-blue-500/10    text-blue-400    border-blue-500/30',
  ERROR: 'bg-rose-500/10    text-rose-400    border-rose-500/30',
};

const HARDENING_SEV_CLS: Record<string, string> = {
  CRITICAL: 'bg-red-950/60   text-red-300    border-red-800/40',
  HIGH:     'bg-orange-950/40 text-orange-300 border-orange-800/30',
  MEDIUM:   'bg-amber-950/30  text-amber-300  border-amber-800/20',
  LOW:      'bg-zinc-800      text-zinc-400   border-zinc-700',
};

// ── Component ────────────────────────────────────────────────────────────────

const MAX_CONCURRENT_UPLOADS = 3;
// Files larger than this are handed off to the browser's native download (no in-memory buffering)
const NATIVE_DOWNLOAD_THRESHOLD = 500 * 1024 * 1024; // 500 MB

export default function IntelligenceCenter({
  server,
  logs,
  securityAssets,
  onExecuteCommand,
  onRunAuditScan,
}: IntelligenceCenterProps) {
  const [activeTab, setActiveTab] = useState<'terminal' | 'logs' | 'files' | 'security'>('terminal');

  // Terminal
  const [termLines, setTermLines] = useState<TerminalLine[]>([
    { id: 'init-1', type: 'system', text: 'Linux AI Ops Smart Console [v1.0.0] - Secure SSH Layer Active.', timestamp: new Date().toLocaleTimeString() },
    { id: 'init-2', type: 'stdout', text: 'Type a command or write naturally. Type "help" or select Agent actions above.', timestamp: new Date().toLocaleTimeString() },
  ]);
  const [inputCmd, setInputCmd] = useState('');
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [cwd, setCwd] = useState<string>('~');
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Root escalation mode
  const [rootMode, setRootMode] = useState(false);
  const [rootCwd, setRootCwd] = useState('/root');
  const [showRootAuth, setShowRootAuth] = useState(false);
  const [rootPassInput, setRootPassInput] = useState('');
  const [rootAuthError, setRootAuthError] = useState('');
  const [rootAuthLoading, setRootAuthLoading] = useState(false);
  const rootPassRef = useRef('');
  const rootModeRef = useRef(false);
  const rootCwdRef = useRef('/root');
  const rootViaRef = useRef<'su' | 'sudo'>('su');

  // Sudo escalation (per-command, non-persistent)
  const [showSudoAuth, setShowSudoAuth] = useState(false);
  const [sudoPassInput, setSudoPassInput] = useState('');
  const [sudoAuthError, setSudoAuthError] = useState('');
  const [sudoAuthLoading, setSudoAuthLoading] = useState(false);
  const [pendingSudoCmd, setPendingSudoCmd] = useState('');
  const sudoPassRef = useRef('');

  // Logs
  const [logFilter, setLogFilter] = useState('all');
  const [diagnosingLogs, setDiagnosingLogs] = useState(false);
  const [logsAiDiagnostic, setLogsAiDiagnostic] = useState<string | null>(null);

  // Hardening scan
  const [scanResult, setScanResult]         = useState<HardeningScanResult | null>(null);
  const [scanLoading, setScanLoading]       = useState(false);
  const [scanError, setScanError]           = useState<string | null>(null);
  const [aiAnalyzing, setAiAnalyzing]       = useState(false);
  const [aiHardeningAnalysis, setAiHardeningAnalysis] = useState<string | null>(null);
  const [expandedPolicy, setExpandedPolicy] = useState<string | null>(null);

  // SFTP browser
  const [sftpPath, setSftpPath] = useState<string>('/');
  const [sftpEntries, setSftpEntries] = useState<SFTPEntry[]>([]);
  const [sftpLoading, setSftpLoading] = useState(false);
  const [sftpError, setSftpError] = useState<string | null>(null);
  const [sftpSelectedFile, setSftpSelectedFile] = useState<{ path: string; size: number } | null>(null);

  // File editor (shared with SFTP)
  const [editedCode, setEditedCode] = useState('');
  const [sftpFileLoading, setSftpFileLoading] = useState(false);
  const [editorNotice, setEditorNotice] = useState('');
  const [explainingFile, setExplainingFile] = useState(false);
  const [fileAiExplanation, setFileAiExplanation] = useState<string | null>(null);

  // Transfer queues
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [downloadTasks, setDownloadTasks] = useState<DownloadTask[]>([]);

  // Refs for async-safe access to latest state
  const serverRef = useRef(server);
  const sftpPathRef = useRef(sftpPath);
  const uploadQueueRef = useRef<{ file: File; taskId: string }[]>([]);
  const activeUploadsRef = useRef(0);
  const xhrMapRef = useRef<Map<string, XMLHttpRequest>>(new Map());
  const uploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { serverRef.current = server; }, [server]);
  useEffect(() => { sftpPathRef.current = sftpPath; }, [sftpPath]);

  // Terminal scroll
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [termLines]);

  // Reset SFTP when server changes
  useEffect(() => {
    setSftpPath('/');
    setSftpEntries([]);
    setSftpSelectedFile(null);
    setSftpError(null);
    setEditedCode('');
    setFileAiExplanation(null);
    setUploadTasks([]);
    setDownloadTasks([]);
    // Reset escalation state on server change
    sudoPassRef.current = '';
    setSudoPassInput('');
    setSudoAuthError('');
    setShowSudoAuth(false);
    setPendingSudoCmd('');
    rootViaRef.current = 'su';
  }, [server?.id]);

  // ── SFTP functions ─────────────────────────────────────────────────────────

  const loadSftpDir = async (path: string) => {
    const srv = serverRef.current;
    if (!srv) return;
    setSftpLoading(true);
    setSftpError(null);
    try {
      const res = await fetch(`/api/servers/${srv.id}/sftp/ls?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al listar directorio.');
      setSftpEntries(data.entries || []);
      setSftpPath(path);
      sftpPathRef.current = path;
    } catch (err: any) {
      setSftpError(err.message);
    } finally {
      setSftpLoading(false);
    }
  };

  const loadSftpFile = async (filePath: string, fileSize: number) => {
    const srv = serverRef.current;
    if (!srv) return;
    setSftpFileLoading(true);
    setSftpError(null);
    setFileAiExplanation(null);
    // Always register the selected file so the error banner can offer a download link
    setSftpSelectedFile({ path: filePath, size: fileSize });
    try {
      const res = await fetch(`/api/servers/${srv.id}/sftp/read?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al leer archivo.');
      setEditedCode(data.content);
    } catch (err: any) {
      setSftpError(err.message);
      setEditedCode('');
    } finally {
      setSftpFileLoading(false);
    }
  };

  const saveSftpFile = async () => {
    const srv = serverRef.current;
    if (!srv || !sftpSelectedFile) return;
    setEditorNotice('');
    try {
      const res = await fetch(`/api/servers/${srv.id}/sftp/write`, {
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

  const goUp = () => {
    if (sftpPath === '/') return;
    const parts = sftpPath.split('/').filter(Boolean);
    parts.pop();
    loadSftpDir(parts.length === 0 ? '/' : '/' + parts.join('/'));
  };

  // Load directory when files tab opens or server changes
  useEffect(() => {
    if (activeTab === 'files' && server?.id) loadSftpDir('/');
  }, [activeTab, server?.id]);

  // ── Upload queue (3 concurrent workers) ───────────────────────────────────

  const startUploadTask = (file: File, taskId: string) => {
    const srv = serverRef.current;
    if (!srv) return Promise.resolve();

    setUploadTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: 'uploading' } : t));

    return new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhrMapRef.current.set(taskId, xhr);

      let lastLoaded = 0;
      let lastTime = Date.now();

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const now = Date.now();
        const dt = (now - lastTime) / 1000;
        const byteDelta = e.loaded - lastLoaded;
        const speed = dt > 0.2 ? byteDelta / dt : 0;
        if (dt > 0.2) { lastLoaded = e.loaded; lastTime = now; }
        const pct = Math.round((e.loaded / e.total) * 100);
        setUploadTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, loaded: e.loaded, pct, speed } : t));
      };

      const finish = (status: UploadTask['status'], error?: string) => {
        xhrMapRef.current.delete(taskId);
        setUploadTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status, pct: status === 'done' ? 100 : t.pct, speed: 0, error } : t));
        if (status === 'done') loadSftpDir(sftpPathRef.current);
        resolve();
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          finish('done');
        } else {
          let msg = `HTTP ${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
          finish('error', msg);
        }
      };
      xhr.onerror = () => finish('error', 'Error de red.');
      xhr.onabort = () => finish('error', 'Cancelado.');

      const fd = new FormData();
      fd.append('file', file);
      xhr.open('POST', `/api/servers/${srv.id}/sftp/upload-stream?path=${encodeURIComponent(sftpPathRef.current)}`);
      xhr.send(fd);
    });
  };

  const drainUploadQueue = () => {
    while (activeUploadsRef.current < MAX_CONCURRENT_UPLOADS && uploadQueueRef.current.length > 0) {
      const item = uploadQueueRef.current.shift()!;
      activeUploadsRef.current++;
      startUploadTask(item.file, item.taskId).finally(() => {
        activeUploadsRef.current--;
        drainUploadQueue();
      });
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length || !serverRef.current) return;
    const files = Array.from<File>(e.target.files);

    const newTasks: UploadTask[] = files.map((f) => ({
      id: Math.random().toString(36).slice(2),
      filename: f.name,
      size: f.size,
      loaded: 0,
      pct: 0,
      speed: 0,
      status: 'queued',
    }));

    setUploadTasks((prev) => [...prev, ...newTasks]);
    files.forEach((f, i) => uploadQueueRef.current.push({ file: f, taskId: newTasks[i].id }));
    drainUploadQueue();

    if (uploadInputRef.current) uploadInputRef.current.value = '';
  };

  const cancelUpload = (taskId: string) => {
    const xhr = xhrMapRef.current.get(taskId);
    if (xhr) xhr.abort();
    else setUploadTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: 'error', error: 'Cancelado.' } : t));
    // Remove from pending queue
    uploadQueueRef.current = uploadQueueRef.current.filter((q) => q.taskId !== taskId);
  };

  const clearDoneUploads = () => setUploadTasks((prev) => prev.filter((t) => t.status === 'queued' || t.status === 'uploading'));

  // ── Download with progress bar ─────────────────────────────────────────────

  const downloadWithProgress = async (filePath: string, fileSize: number) => {
    const srv = serverRef.current;
    if (!srv) return;

    const filename = filePath.split('/').pop() || 'download';
    const url = `/api/servers/${srv.id}/sftp/download?path=${encodeURIComponent(filePath)}`;

    // Large files: hand off to browser's native download (Content-Length set → browser shows progress)
    if (fileSize > NATIVE_DOWNLOAD_THRESHOLD) {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      return;
    }

    const taskId = Math.random().toString(36).slice(2);
    setDownloadTasks((prev) => [...prev, { id: taskId, filename, size: fileSize, loaded: 0, pct: 0, speed: 0, status: 'downloading' }]);

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength) : fileSize;
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      let lastTime = Date.now();
      let lastLoaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;

        const now = Date.now();
        const dt = (now - lastTime) / 1000;
        const speed = dt > 0.2 ? (loaded - lastLoaded) / dt : 0;
        if (dt > 0.2) { lastTime = now; lastLoaded = loaded; }

        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
        setDownloadTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, loaded, pct, speed } : t));
      }

      // Trigger browser save dialog
      const blob = new Blob(chunks);
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);

      setDownloadTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, pct: 100, speed: 0, status: 'done' } : t));
      setTimeout(() => setDownloadTasks((prev) => prev.filter((t) => t.id !== taskId)), 4000);

    } catch (err: any) {
      setDownloadTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: 'error', error: err.message } : t));
    }
  };

  // ── AI helpers ─────────────────────────────────────────────────────────────

  const runLogDiagnosticAI = async () => {
    setDiagnosingLogs(true);
    setLogsAiDiagnostic(null);
    try {
      const ctx = logs.slice(-10).map((l) => `[${l.level.toUpperCase()}] ${l.service}: ${l.message}`).join('\n');
      const res = await fetch('/api/openrouter/run-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server?.id, role: 'Monitoring', prompt: `Analiza estos logs e identifica el error principal y solución:\n${ctx}` }),
      });
      const data = await res.json();
      setLogsAiDiagnostic(data.explanation || data.reportSummary);
    } catch (err: any) {
      setLogsAiDiagnostic(`Error: ${err.message}`);
    } finally {
      setDiagnosingLogs(false);
    }
  };

  const runFileExplanationAI = async () => {
    if (!sftpSelectedFile) return;
    setExplainingFile(true);
    setFileAiExplanation(null);
    try {
      const res = await fetch('/api/openrouter/run-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server?.id,
          role: 'SysAdmin',
          prompt: `Explica las directivas de este archivo (${sftpSelectedFile.path}), advierte malas prácticas y cómo optimizarlo:\n${editedCode}`,
        }),
      });
      const data = await res.json();
      setFileAiExplanation(data.explanation || data.reportSummary);
    } catch (err: any) {
      setFileAiExplanation(`Error: ${err.message}`);
    } finally {
      setExplainingFile(false);
    }
  };

  // ── Hardening scan ────────────────────────────────────────────────────────

  const runHardeningScan = async () => {
    if (!serverRef.current) return;
    setScanLoading(true);
    setScanError(null);
    setScanResult(null);
    setAiHardeningAnalysis(null);
    setExpandedPolicy(null);
    try {
      const res = await fetch(`/api/servers/${serverRef.current.id}/security-scan`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error en el scan.');
      setScanResult(data as HardeningScanResult);
    } catch (err: any) {
      setScanError(err.message);
    } finally {
      setScanLoading(false);
    }
  };

  const runAIHardeningAnalysis = async () => {
    if (!scanResult || !serverRef.current) return;
    setAiAnalyzing(true);
    setAiHardeningAnalysis(null);
    try {
      const failedPolicies = scanResult.policies
        .filter((p) => p.status === 'FAIL' || p.status === 'WARN')
        .map((p) => `[${p.status}][${p.severity}] ${p.title}: ${p.description}`)
        .join('\n');
      const res = await fetch('/api/openrouter/run-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: serverRef.current.id,
          role: 'Security',
          prompt: `Analiza este reporte de hardening del servidor "${scanResult.host}" (${scanResult.os}).\n\nScore: ${scanResult.summary.score}/100 | FAIL: ${scanResult.summary.failed} | WARN: ${scanResult.summary.warnings} | PASS: ${scanResult.summary.passed}\n\nProblemas encontrados:\n${failedPolicies}\n\nResponde con: 1) Evaluación del riesgo general 2) Top 3 remediaciones urgentes con impacto esperado 3) Roadmap de hardening priorizado por severidad.`,
        }),
      });
      const data = await res.json();
      setAiHardeningAnalysis(data.explanation || data.reportSummary || 'Sin análisis disponible.');
    } catch (err: any) {
      setAiHardeningAnalysis(`Error: ${err.message}`);
    } finally {
      setAiAnalyzing(false);
    }
  };

  // ── Terminal ───────────────────────────────────────────────────────────────

  const handleTerminalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const command = inputCmd.trim();
    if (!command) return;
    const ts = new Date().toLocaleTimeString();
    setTermLines((prev) => [...prev, { id: Math.random().toString(), type: 'input', text: command, timestamp: ts }]);
    setCmdHistory((prev) => [command, ...prev]);
    setHistoryIdx(-1);
    setInputCmd('');

    if (command === 'clear') { setTermLines([]); return; }
    if (command === 'help') {
      setTermLines((prev) => [...prev,
        { id: Math.random().toString(), type: 'system', text: 'Comandos rápidos:', timestamp: ts },
        { id: Math.random().toString(), type: 'stdout', text: '  uptime  df -h  docker ps  free -h  clear  su -  sudo -i', timestamp: ts },
      ]);
      return;
    }

    // Intercept su / su - / su root → show root auth modal
    if (/^su(\s+(-\s*)?(root\s*)?)?$/.test(command)) {
      setShowRootAuth(true);
      setRootAuthError('');
      setRootPassInput('');
      return;
    }

    // exit in root mode → return to normal user
    if (rootModeRef.current && /^exit\s*$/.test(command)) {
      rootModeRef.current = false;
      rootPassRef.current = '';
      rootCwdRef.current = '/root';
      rootViaRef.current = 'su';
      setRootMode(false);
      setRootCwd('/root');
      setTermLines((prev) => [...prev, { id: Math.random().toString(), type: 'system', text: '↩  Sesión root terminada. Volviendo al usuario normal.', timestamp: ts }]);
      return;
    }

    // sudo -i / sudo -s / sudo su → escalate to root mode via sudo
    if (/^sudo\s+(-i\b|-s\b|su(\s|$))/.test(command)) {
      if (!sudoPassRef.current) {
        setPendingSudoCmd(command);
        setShowSudoAuth(true);
        setSudoAuthError('');
        setSudoPassInput('');
      } else {
        const esc = sudoPassRef.current.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
        const r = await onExecuteCommand(`echo '${esc}' | sudo -S echo __SUDO_ROOT__ 2>&1`);
        if ((r.stdout + r.stderr).includes('__SUDO_ROOT__')) {
          rootPassRef.current = sudoPassRef.current;
          rootViaRef.current = 'sudo';
          rootModeRef.current = true; rootCwdRef.current = '/root';
          setRootMode(true); setRootCwd('/root');
          setTermLines((p) => [...p, { id: Math.random().toString(), type: 'system', text: '✓ Sesión root activa via sudo. Escribe "exit" para salir.', timestamp: ts }]);
        } else {
          setTermLines((p) => [...p, { id: Math.random().toString(), type: 'stderr', text: 'sudo: autenticación fallida.', timestamp: ts }]);
        }
      }
      return;
    }

    // sudo <cmd> → run transparently with user password
    if (/^sudo\s+/.test(command) && !rootModeRef.current) {
      if (!sudoPassRef.current) {
        setPendingSudoCmd(command);
        setShowSudoAuth(true);
        setSudoAuthError('');
        setSudoPassInput('');
        return;
      }
    }

    const CWD = '___CWD___:';

    // Build the actual command
    let cmdToRun: string;
    if (rootModeRef.current) {
      const escapedPass = rootPassRef.current.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
      const escapedCmd  = command.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
      const rootPrefix  = rootCwdRef.current !== '/root' ? `cd ${rootCwdRef.current} 2>/dev/null; ` : '';
      if (rootViaRef.current === 'sudo') {
        cmdToRun = `echo '${escapedPass}' | sudo -S bash -c '${rootPrefix}${escapedCmd}; echo "${CWD}$(pwd)"' 2>&1`;
      } else {
        cmdToRun = `echo '${escapedPass}' | su root -c '${rootPrefix}${escapedCmd}; echo "${CWD}$(pwd)"' 2>&1`;
      }
    } else if (/^sudo\s+/.test(command) && sudoPassRef.current) {
      const escapedPass = sudoPassRef.current.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
      const sudoArgs = command.slice('sudo '.length);
      const prefix = cwd !== '~' ? `cd ${cwd} 2>/dev/null; ` : '';
      cmdToRun = `${prefix}echo '${escapedPass}' | sudo -S ${sudoArgs}; echo "${CWD}$(pwd)"`;
    } else {
      const prefix = cwd !== '~' ? `cd ${cwd} 2>/dev/null; ` : '';
      cmdToRun = `${prefix}${command}; echo "${CWD}$(pwd)"`;
    }

    try {
      const result = await onExecuteCommand(cmdToRun);
      let stdout = result.stdout || '';
      const cwdIdx = stdout.split('\n').findIndex((l) => l.startsWith(CWD));
      if (cwdIdx !== -1) {
        const lines = stdout.split('\n');
        const newCwd = lines[cwdIdx].replace(CWD, '').trim();
        if (newCwd) {
          if (rootModeRef.current) { rootCwdRef.current = newCwd; setRootCwd(newCwd); }
          else setCwd(newCwd);
        }
        lines.splice(cwdIdx, 1);
        stdout = lines.join('\n').replace(/\n$/, '');
      }
      // Check server-side truncation marker
      const serverTruncated = stdout.includes('[OUTPUT_TRUNCATED]');
      if (serverTruncated) stdout = stdout.replace('\n[OUTPUT_TRUNCATED]', '');
      const { text: displayOut, wasTruncated, totalLines } = truncateOutput(stdout);
      const out: TerminalLine[] = [];
      if (displayOut) out.push({ id: Math.random().toString(), type: 'stdout', text: displayOut, timestamp: ts });
      if (wasTruncated || serverTruncated) {
        out.push({ id: Math.random().toString(), type: 'system', text: `⚠ Salida truncada (${totalLines.toLocaleString()} líneas). Usa head -n100, tail, grep o less para filtrar.`, timestamp: ts });
      }
      if (result.stderr) out.push({ id: Math.random().toString(), type: 'stderr', text: result.stderr, timestamp: ts });
      if (!displayOut && !result.stderr) out.push({ id: Math.random().toString(), type: 'system', text: `Exit code: ${result.exitCode}`, timestamp: ts });
      setTermLines((prev) => {
        const next = [...prev, ...out];
        return next.length > MAX_TERM_LINES ? next.slice(next.length - MAX_TERM_LINES) : next;
      });
    } catch (err: any) {
      setTermLines((prev) => [...prev, { id: Math.random().toString(), type: 'stderr', text: err.message, timestamp: ts }]);
    }
  };

  const handleRootAuth = async () => {
    if (!rootPassInput) return;
    setRootAuthLoading(true);
    setRootAuthError('');
    const escapedPass = rootPassInput.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
    try {
      const result = await onExecuteCommand(`echo '${escapedPass}' | su root -c 'echo __ROOT_OK__' 2>&1`);
      const combined = (result.stdout || '') + (result.stderr || '');
      if (combined.includes('__ROOT_OK__')) {
        rootPassRef.current = rootPassInput;
        rootModeRef.current = true;
        rootCwdRef.current = '/root';
        setRootMode(true);
        setRootCwd('/root');
        setShowRootAuth(false);
        setRootPassInput('');
        setTermLines((prev) => [...prev, {
          id: Math.random().toString(), type: 'system',
          text: '✓ Sesión root activa. Escribe "exit" para volver al usuario normal.',
          timestamp: new Date().toLocaleTimeString(),
        }]);
      } else {
        setRootAuthError('Contraseña incorrecta o su no permite autenticación sin TTY.');
      }
    } catch {
      setRootAuthError('Error al autenticar. Verifica las credenciales.');
    } finally {
      setRootAuthLoading(false);
    }
  };

  const handleSudoAuth = async () => {
    if (!sudoPassInput) return;
    setSudoAuthLoading(true);
    setSudoAuthError('');
    const escapedPass = sudoPassInput.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
    const ts = new Date().toLocaleTimeString();
    try {
      const result = await onExecuteCommand(`echo '${escapedPass}' | sudo -S echo __SUDO_OK__ 2>&1`);
      const combined = (result.stdout || '') + (result.stderr || '');
      if (combined.includes('__SUDO_OK__')) {
        sudoPassRef.current = sudoPassInput;
        const cmd = pendingSudoCmd;
        setShowSudoAuth(false);
        setSudoPassInput('');
        setPendingSudoCmd('');

        if (/^sudo\s+(-i\b|-s\b|su(\s|$))/.test(cmd)) {
          // Enter root mode via sudo
          rootPassRef.current = sudoPassInput;
          rootViaRef.current = 'sudo';
          rootModeRef.current = true;
          rootCwdRef.current = '/root';
          setRootMode(true);
          setRootCwd('/root');
          setTermLines((prev) => [...prev, {
            id: Math.random().toString(), type: 'system',
            text: '✓ Sesión root activa via sudo. Escribe "exit" para volver.',
            timestamp: ts,
          }]);
        } else {
          // Execute the pending sudo command
          const CWD = '___CWD___:';
          const sudoArgs = cmd.slice('sudo '.length);
          const prefix = cwd !== '~' ? `cd ${cwd} 2>/dev/null; ` : '';
          const cmdToRun = `${prefix}echo '${escapedPass}' | sudo -S ${sudoArgs}; echo "${CWD}$(pwd)"`;
          const r = await onExecuteCommand(cmdToRun);
          let stdout = r.stdout || '';
          const cwdIdx = stdout.split('\n').findIndex((l) => l.startsWith(CWD));
          if (cwdIdx !== -1) {
            const lines = stdout.split('\n');
            const newCwd = lines[cwdIdx].replace(CWD, '').trim();
            if (newCwd) setCwd(newCwd);
            lines.splice(cwdIdx, 1);
            stdout = lines.join('\n').replace(/\n$/, '');
          }
          const serverTruncated2 = stdout.includes('[OUTPUT_TRUNCATED]');
          if (serverTruncated2) stdout = stdout.replace('\n[OUTPUT_TRUNCATED]', '');
          const { text: displayOut2, wasTruncated: wt2, totalLines: tl2 } = truncateOutput(stdout);
          const out: TerminalLine[] = [];
          if (displayOut2) out.push({ id: Math.random().toString(), type: 'stdout', text: displayOut2, timestamp: ts });
          if (wt2 || serverTruncated2) out.push({ id: Math.random().toString(), type: 'system', text: `⚠ Salida truncada (${tl2.toLocaleString()} líneas). Usa head -n100, tail o grep para filtrar.`, timestamp: ts });
          if (r.stderr) out.push({ id: Math.random().toString(), type: 'stderr', text: r.stderr, timestamp: ts });
          if (!displayOut2 && !r.stderr) out.push({ id: Math.random().toString(), type: 'system', text: `Exit code: ${r.exitCode}`, timestamp: ts });
          setTermLines((prev) => {
            const next = [...prev, ...out];
            return next.length > MAX_TERM_LINES ? next.slice(next.length - MAX_TERM_LINES) : next;
          });
        }
      } else {
        setSudoAuthError('Contraseña incorrecta o usuario sin permisos sudo.');
      }
    } catch {
      setSudoAuthError('Error al autenticar. Verifica las credenciales.');
    } finally {
      setSudoAuthLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIdx < cmdHistory.length - 1) { const i = historyIdx + 1; setHistoryIdx(i); setInputCmd(cmdHistory[i]); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx > 0) { const i = historyIdx - 1; setHistoryIdx(i); setInputCmd(cmdHistory[i]); }
      else if (historyIdx === 0) { setHistoryIdx(-1); setInputCmd(''); }
    }
  };

  // ── Derived values ─────────────────────────────────────────────────────────

  const termPrompt = rootMode
    ? '[root]:' + rootCwd + '#'
    : '[' + (server?.name || 'linux') + ']:' + cwd + '$';
  const pathParts = sftpPath.split('/').filter(Boolean);
  const filteredLogs = logs.filter((l) => {
    if (logFilter === 'all') return true;
    if (logFilter === 'error') return l.level === 'error' || l.level === 'critical';
    return l.service.toLowerCase() === logFilter.toLowerCase();
  });

  const hasActiveTransfers =
    uploadTasks.some((t) => t.status === 'queued' || t.status === 'uploading' || t.status === 'error' || t.status === 'done') ||
    downloadTasks.some((t) => t.status === 'downloading' || t.status === 'error');

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div id="ops-intelligence-center" className="bg-brand-bg border border-brand-border rounded-xl p-4 flex flex-col h-full shadow-2xl overflow-hidden">

      {/* Tabs */}
      <div className="flex items-center justify-between border-b border-brand-border pb-2 flex-shrink-0">
        <div className="flex items-center gap-1 bg-brand-dark border border-brand-border p-1 rounded">
          {([
            { id: 'terminal', label: 'Bash Console', icon: TermIcon },
            { id: 'logs',     label: 'SysLog',       icon: AlignLeft },
            { id: 'files',    label: 'SFTP Browser', icon: FileCode },
            { id: 'security', label: 'Security',     icon: AlertTriangle },
          ] as const).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded transition-all cursor-pointer ${
                activeTab === id
                  ? 'bg-brand-item text-zinc-100 border border-brand-border-light'
                  : 'text-brand-text-muted hover:text-zinc-300'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="hidden md:inline">{label}</span>
            </button>
          ))}
        </div>
        <div className="text-[10px] text-brand-text-muted font-mono hidden sm:block">
          SSH @ {server?.username || 'root'}:{server?.host || 'unset'}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden mt-3 relative">

        {/* ── TAB: TERMINAL ── */}
        {activeTab === 'terminal' && (
          <div className="flex flex-col h-full bg-brand-panel text-zinc-300 font-mono text-xs rounded border border-brand-border overflow-hidden relative">

            {/* Root mode badge */}
            {rootMode && (
              <div className="flex items-center justify-between px-3 py-1.5 bg-red-950/40 border-b border-red-900/40 flex-shrink-0">
                <span className="text-red-400 font-bold text-[10px] uppercase tracking-wider">⚡ Sesión Root Activa</span>
                <button
                  onClick={() => { rootModeRef.current = false; rootPassRef.current = ''; rootCwdRef.current = '/root'; rootViaRef.current = 'su'; setRootMode(false); setRootCwd('/root'); setTermLines((p) => [...p, { id: Math.random().toString(), type: 'system', text: '↩  Sesión root terminada.', timestamp: new Date().toLocaleTimeString() }]); }}
                  className="text-[10px] text-red-400 hover:text-red-300 border border-red-900/40 px-2 py-0.5 rounded cursor-pointer"
                >
                  Salir de root
                </button>
              </div>
            )}

            {/* Sudo auth modal */}
            {showSudoAuth && (
              <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-20">
                <div className="bg-brand-panel border border-brand-border rounded-lg p-5 w-72 shadow-2xl">
                  <h3 className="text-xs font-bold text-zinc-200 mb-1">Autenticación sudo</h3>
                  <p className="text-[10px] text-zinc-500 mb-3">Contraseña de <span className="text-amber-400">{server?.username || 'usuario'}</span> para ejecutar con sudo</p>
                  <input
                    type="password"
                    autoFocus
                    value={sudoPassInput}
                    onChange={(e) => setSudoPassInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSudoAuth(); if (e.key === 'Escape') { setShowSudoAuth(false); setSudoPassInput(''); setPendingSudoCmd(''); } }}
                    placeholder="Contraseña del usuario..."
                    className="w-full bg-brand-dark border border-brand-border rounded px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-500/50 transition-colors"
                  />
                  {sudoAuthError && <p className="text-[10px] text-amber-400 mt-2">{sudoAuthError}</p>}
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={handleSudoAuth}
                      disabled={sudoAuthLoading || !sudoPassInput}
                      className="flex-1 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white rounded text-[11px] font-bold cursor-pointer transition-colors"
                    >
                      {sudoAuthLoading ? 'Verificando...' : 'Autenticar'}
                    </button>
                    <button
                      onClick={() => { setShowSudoAuth(false); setSudoPassInput(''); setSudoAuthError(''); setPendingSudoCmd(''); }}
                      className="flex-1 py-1.5 bg-brand-dark border border-brand-border text-zinc-400 rounded text-[11px] cursor-pointer hover:text-zinc-200 transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Root auth modal */}
            {showRootAuth && (
              <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-20">
                <div className="bg-brand-panel border border-brand-border rounded-lg p-5 w-72 shadow-2xl">
                  <h3 className="text-xs font-bold text-zinc-200 mb-1">Autenticación root</h3>
                  <p className="text-[10px] text-zinc-500 mb-3">Contraseña del usuario <span className="text-red-400">root</span> en el servidor</p>
                  <input
                    type="password"
                    autoFocus
                    value={rootPassInput}
                    onChange={(e) => setRootPassInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRootAuth(); if (e.key === 'Escape') { setShowRootAuth(false); setRootPassInput(''); } }}
                    placeholder="Contraseña de root..."
                    className="w-full bg-brand-dark border border-brand-border rounded px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-red-500/50 transition-colors"
                  />
                  {rootAuthError && <p className="text-[10px] text-red-400 mt-2">{rootAuthError}</p>}
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={handleRootAuth}
                      disabled={rootAuthLoading || !rootPassInput}
                      className="flex-1 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded text-[11px] font-bold cursor-pointer transition-colors"
                    >
                      {rootAuthLoading ? 'Verificando...' : 'Autenticar'}
                    </button>
                    <button
                      onClick={() => { setShowRootAuth(false); setRootPassInput(''); setRootAuthError(''); }}
                      className="flex-1 py-1.5 bg-brand-dark border border-brand-border text-zinc-400 rounded text-[11px] cursor-pointer hover:text-zinc-200 transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-[#050505]/60">
              {termLines.map((line, idx) => {
                if (line.type === 'input') return (
                  <div key={idx} className="flex gap-1">
                    <span className={`font-bold ${rootMode ? 'text-red-400' : 'text-emerald-400'}`}>{termPrompt}</span>
                    <span className="text-zinc-100 font-semibold">{line.text}</span>
                  </div>
                );
                const cls = { stdout: 'text-zinc-300 whitespace-pre-wrap', stderr: 'text-rose-400 whitespace-pre-wrap bg-rose-950/20 px-2 py-1 rounded', system: 'text-emerald-400 font-bold text-[10px] italic' };
                return <div key={idx} className={cls[line.type as keyof typeof cls] || 'text-zinc-300'}>{line.text}</div>;
              })}
              <div ref={terminalEndRef} />
            </div>
            <form onSubmit={handleTerminalSubmit} className={`flex items-center border-t ${rootMode ? 'border-red-900/40 bg-red-950/10' : 'border-brand-border bg-brand-bar'} p-1`}>
              <span className={`font-bold self-center px-2 font-mono ${rootMode ? 'text-red-400' : 'text-emerald-400'}`}>{termPrompt}</span>
              <input type="text" value={inputCmd} onChange={(e) => setInputCmd(e.target.value)} onKeyDown={handleKeyDown}
                placeholder="Escribe un comando bash o 'help'..."
                className="flex-1 bg-transparent border-none outline-none text-zinc-100 text-xs py-2 px-1 font-mono" />
              <button
                type="button"
                onClick={() => setTermLines([])}
                title="Limpiar consola"
                className="p-2 text-zinc-600 hover:text-zinc-300 cursor-pointer transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button type="submit" className="p-2 text-emerald-400 hover:text-emerald-300 cursor-pointer"><Send className="w-4 h-4" /></button>
            </form>
          </div>
        )}

        {/* ── TAB: LOGS ── */}
        {activeTab === 'logs' && (
          <div className="flex flex-col h-full bg-[#050505]/40 rounded border border-brand-border overflow-hidden">
            <div className="flex items-center justify-between p-2.5 bg-brand-bar border-b border-brand-border gap-2 overflow-x-auto">
              <div className="flex gap-1.5">
                {['all', 'ssh', 'nginx', 'postgres', 'fail2ban', 'error'].map((f) => (
                  <button key={f} onClick={() => setLogFilter(f)}
                    className={`px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded font-mono cursor-pointer ${
                      logFilter === f ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' : 'bg-brand-dark border border-brand-border text-brand-text-muted hover:text-zinc-200'
                    }`}>{f}</button>
                ))}
              </div>
              <button onClick={runLogDiagnosticAI} disabled={diagnosingLogs}
                className="flex items-center gap-1.5 px-3 py-1 bg-emerald-600 text-white rounded text-xs font-bold cursor-pointer hover:bg-emerald-500 disabled:opacity-50">
                <Cpu className="w-3.5 h-3.5" />{diagnosingLogs ? 'Diagnosticando...' : 'Diagnosticar con IA'}
              </button>
            </div>
            {logsAiDiagnostic && (
              <div className="p-3 bg-emerald-950/20 border-b border-emerald-900/40 text-xs text-emerald-300 leading-relaxed max-h-40 overflow-y-auto">
                <div className="flex items-center gap-1.5 font-bold mb-1"><Cpu className="w-4 h-4" /> Análisis por OpenRouter:</div>
                {logsAiDiagnostic}
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-2 select-text">
              {filteredLogs.length === 0
                ? <div className="text-center py-8 text-brand-text-muted">Sin registros para el filtro seleccionado.</div>
                : filteredLogs.map((log) => {
                    const cls = { info: 'text-brand-text-muted', warn: 'text-amber-400 font-bold', error: 'text-rose-400 bg-red-950/10 px-1 rounded font-bold', critical: 'text-red-500 bg-red-950/30 px-1 rounded font-bold' };
                    return (
                      <div key={log.id} className="leading-5 flex items-start gap-2 border-b border-[#050505]/60 pb-1.5">
                        <span className="text-[10px] text-brand-text-dim flex-shrink-0">{new Date(log.timestamp).toLocaleTimeString()}</span>
                        <span className="text-emerald-500/80 font-bold font-mono text-[10px] uppercase flex-shrink-0">[{log.service}]</span>
                        <span className={cls[log.level] || 'text-zinc-300'}>{log.message}</span>
                      </div>
                    );
                  })}
            </div>
          </div>
        )}

        {/* ── TAB: SFTP BROWSER ── */}
        {activeTab === 'files' && (
          <div className="flex flex-col h-full overflow-hidden gap-2">

            {/* Breadcrumb toolbar */}
            <div className="flex items-center gap-1.5 px-3 py-2 bg-brand-bar border border-brand-border rounded text-xs overflow-x-auto flex-shrink-0">
              <button onClick={() => loadSftpDir('/')} className="text-zinc-400 hover:text-emerald-400 font-mono transition-colors flex-shrink-0">/</button>
              {pathParts.map((part, idx) => (
                <React.Fragment key={idx}>
                  <ChevronRight className="w-3 h-3 text-zinc-600 flex-shrink-0" />
                  <button onClick={() => loadSftpDir('/' + pathParts.slice(0, idx + 1).join('/'))}
                    className="text-zinc-400 hover:text-emerald-400 font-mono transition-colors truncate max-w-[80px]">{part}</button>
                </React.Fragment>
              ))}
              <div className="flex-1 min-w-0" />
              <button onClick={goUp} disabled={sftpPath === '/' || sftpLoading} title="Subir un nivel"
                className="p-1 text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 transition-colors cursor-pointer flex-shrink-0">
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => loadSftpDir(sftpPath)} disabled={sftpLoading || !server} title="Refrescar"
                className="p-1 text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 transition-colors cursor-pointer flex-shrink-0">
                <RefreshCw className={'w-3.5 h-3.5' + (sftpLoading ? ' animate-spin' : '')} />
              </button>
              <label title="Seleccionar archivos para subir (múltiples)"
                className={'p-1 rounded flex items-center gap-1 transition-colors flex-shrink-0 ' + (!server ? 'text-zinc-700 cursor-not-allowed' : 'text-zinc-400 hover:text-emerald-400 cursor-pointer')}>
                <Upload className="w-3.5 h-3.5" />
                <input type="file" multiple ref={uploadInputRef} onChange={handleFileSelect} className="hidden" disabled={!server} />
              </label>
            </div>

            {/* Error */}
            {sftpError && (
              <div className="px-3 py-2 bg-red-950/30 border border-red-900/40 text-rose-300 text-xs rounded flex-shrink-0 flex items-center gap-2">
                <span className="flex-1">{sftpError}</span>
                {sftpSelectedFile && sftpError.includes('demasiado grande') && (
                  <button
                    onClick={() => { setSftpError(null); downloadWithProgress(sftpSelectedFile.path, sftpSelectedFile.size); }}
                    className="flex items-center gap-1 px-2.5 py-1 bg-emerald-700 hover:bg-emerald-600 text-white text-[11px] font-bold rounded cursor-pointer flex-shrink-0 transition-colors"
                  >
                    <Download className="w-3 h-3" /> Descargar
                  </button>
                )}
                <button onClick={() => setSftpError(null)} className="text-zinc-500 hover:text-zinc-300 flex-shrink-0"><X className="w-3 h-3" /></button>
              </div>
            )}

            {/* Transfer progress panel */}
            {hasActiveTransfers && (
              <div className="flex-shrink-0 bg-brand-bar border border-brand-border rounded p-2.5 space-y-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-brand-text-muted">Transferencias</span>
                  <button onClick={clearDoneUploads} className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors">Limpiar completadas</button>
                </div>

                {uploadTasks.map((task) => (
                  <div key={task.id} className="flex items-center gap-2 text-xs min-w-0">
                    <Upload className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                    <span className="truncate font-mono text-zinc-300 max-w-[100px] sm:max-w-[160px]" title={task.filename}>{task.filename}</span>
                    <div className="flex-1 min-w-[40px] bg-brand-dark rounded-full h-1.5 overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-300 ${task.status === 'error' ? 'bg-rose-500' : task.status === 'done' ? 'bg-emerald-500' : 'bg-emerald-400'}`}
                        style={{ width: (task.status === 'done' ? 100 : task.pct) + '%' }} />
                    </div>
                    <span className="text-[10px] font-mono text-brand-text-muted w-7 text-right flex-shrink-0">
                      {task.status === 'done' ? '✓' : task.status === 'error' ? '✗' : task.status === 'queued' ? '—' : task.pct + '%'}
                    </span>
                    {task.status === 'uploading' && task.speed > 0 && (
                      <span className="text-[10px] text-zinc-600 flex-shrink-0 hidden sm:inline">{formatSpeed(task.speed)}</span>
                    )}
                    {task.status === 'error' && task.error && (
                      <span className="text-[10px] text-rose-400 truncate max-w-[80px]" title={task.error}>{task.error}</span>
                    )}
                    {(task.status === 'queued' || task.status === 'uploading') && (
                      <button onClick={() => cancelUpload(task.id)} className="text-zinc-600 hover:text-rose-400 transition-colors flex-shrink-0 cursor-pointer">
                        <X className="w-3 h-3" />
                      </button>
                    )}
                    {task.status === 'done' && <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />}
                    {task.status === 'error' && <AlertCircle className="w-3 h-3 text-rose-500 flex-shrink-0" />}
                  </div>
                ))}

                {downloadTasks.map((task) => (
                  <div key={task.id} className="flex items-center gap-2 text-xs min-w-0">
                    <Download className="w-3 h-3 text-blue-400 flex-shrink-0" />
                    <span className="truncate font-mono text-zinc-300 max-w-[100px] sm:max-w-[160px]" title={task.filename}>{task.filename}</span>
                    <div className="flex-1 min-w-[40px] bg-brand-dark rounded-full h-1.5 overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-300 ${task.status === 'error' ? 'bg-rose-500' : task.status === 'done' ? 'bg-blue-500' : 'bg-blue-400'}`}
                        style={{ width: (task.status === 'done' ? 100 : task.pct) + '%' }} />
                    </div>
                    <span className="text-[10px] font-mono text-brand-text-muted w-7 text-right flex-shrink-0">
                      {task.status === 'done' ? '✓' : task.status === 'error' ? '✗' : task.pct + '%'}
                    </span>
                    {task.status === 'downloading' && task.speed > 0 && (
                      <span className="text-[10px] text-zinc-600 flex-shrink-0 hidden sm:inline">{formatSpeed(task.speed)}</span>
                    )}
                    {task.status === 'done' && <CheckCircle2 className="w-3 h-3 text-blue-400 flex-shrink-0" />}
                    {task.status === 'error' && <span className="text-[10px] text-rose-400 truncate">{task.error}</span>}
                  </div>
                ))}
              </div>
            )}

            {/* Directory listing + editor */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 flex-1 overflow-hidden min-h-0">

              {/* Left: file tree */}
              <div className="md:col-span-1 bg-brand-bar border border-brand-border rounded overflow-y-auto max-h-[140px] md:max-h-none">
                {sftpLoading && sftpEntries.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-xs text-brand-text-muted gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin" /> Cargando...
                  </div>
                ) : !server ? (
                  <div className="text-center py-8 text-xs text-brand-text-muted px-3">Sin servidor activo.</div>
                ) : sftpEntries.length === 0 ? (
                  <div className="text-center py-8 text-xs text-brand-text-muted">Directorio vacío</div>
                ) : (
                  <div className="py-1">
                    {sftpEntries.map((entry) => {
                      const fullPath = sftpPath === '/' ? '/' + entry.name : sftpPath + '/' + entry.name;
                      const isSelected = sftpSelectedFile?.path === fullPath;
                      return (
                        <button key={entry.name}
                          onClick={() => entry.type === 'dir' ? loadSftpDir(fullPath) : loadSftpFile(fullPath, entry.size)}
                          className={'w-full text-left flex items-center gap-2 py-1.5 px-2.5 text-xs transition-colors cursor-pointer ' +
                            (isSelected ? 'bg-brand-item text-emerald-400 border-l-2 border-l-emerald-500' : 'text-brand-text-muted hover:bg-brand-panel hover:text-zinc-200')}>
                          <FolderOpen className={'w-3.5 h-3.5 flex-shrink-0 ' + (entry.type === 'dir' ? 'text-amber-400' : 'text-blue-400 opacity-60')} />
                          <span className="truncate font-mono">{entry.name}</span>
                          {entry.type === 'file' && (
                            <span className="text-[9px] text-zinc-600 ml-auto flex-shrink-0">{formatBytes(entry.size)}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Right: editor */}
              <div className="md:col-span-3 flex flex-col bg-brand-panel border border-brand-border rounded overflow-hidden min-h-[220px]">
                <div className="flex items-center justify-between p-2.5 bg-brand-bar border-b border-brand-border gap-2 flex-shrink-0">
                  <span className="text-[11px] font-mono text-zinc-300 font-bold truncate max-w-[160px] sm:max-w-[280px]">
                    {sftpSelectedFile?.path || 'Seleccione un archivo'}
                  </span>
                  {sftpSelectedFile && (
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[10px] text-zinc-600 hidden sm:inline">{formatBytes(sftpSelectedFile.size)}</span>
                      <button onClick={runFileExplanationAI} disabled={explainingFile}
                        className="px-2.5 py-1 text-[11px] bg-brand-dark border border-brand-border text-zinc-300 rounded hover:bg-brand-item font-semibold cursor-pointer disabled:opacity-50">
                        {explainingFile ? 'Analizando...' : 'Explicar IA'}
                      </button>
                      <button
                        onClick={() => downloadWithProgress(sftpSelectedFile.path, sftpSelectedFile.size)}
                        title={sftpSelectedFile.size > NATIVE_DOWNLOAD_THRESHOLD ? 'Descarga nativa del navegador (archivo grande)' : 'Descargar con barra de progreso'}
                        className="flex items-center gap-1 px-2.5 py-1 bg-brand-dark border border-brand-border text-zinc-300 rounded text-[11px] hover:bg-brand-item font-semibold cursor-pointer">
                        <Download className="w-3 h-3" />
                        {sftpSelectedFile.size > NATIVE_DOWNLOAD_THRESHOLD && <span className="hidden sm:inline">Nativa</span>}
                      </button>
                      <button onClick={saveSftpFile}
                        className="flex items-center gap-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-bold text-[11px] cursor-pointer">
                        <Save className="w-3 h-3" /> Guardar
                      </button>
                    </div>
                  )}
                </div>

                {editorNotice && (
                  <div className="p-2 bg-emerald-950/20 border-b border-emerald-900/40 text-[11px] text-emerald-300 font-semibold flex-shrink-0">{editorNotice}</div>
                )}
                {fileAiExplanation && (
                  <div className="p-3 bg-brand-bar border-b border-brand-border text-xs leading-relaxed max-h-40 overflow-y-auto flex-shrink-0">
                    <div className="flex items-center gap-1.5 text-emerald-400 font-bold mb-1"><Cpu className="w-4 h-4" /> Análisis de Configuración:</div>
                    {fileAiExplanation}
                  </div>
                )}
                {sftpFileLoading ? (
                  <div className="flex-1 flex items-center justify-center text-xs text-brand-text-muted gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin" /> Cargando archivo...
                  </div>
                ) : (
                  <textarea
                    value={sftpSelectedFile ? editedCode : ''}
                    onChange={(e) => setEditedCode(e.target.value)}
                    readOnly={!sftpSelectedFile}
                    placeholder="# Navega el árbol de directorios y selecciona un archivo para editar o descargar..."
                    className="flex-1 bg-brand-dark text-[#D1D5DB] p-3 outline-none text-xs border-none font-mono resize-none"
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── TAB: SECURITY ── */}
        {activeTab === 'security' && (
          <div className="flex flex-col h-full overflow-y-auto space-y-3 pr-0.5">

            {/* Action bar */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={runHardeningScan}
                disabled={scanLoading || !server}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-xs font-bold rounded cursor-pointer transition-colors"
              >
                <Shield className="w-3.5 h-3.5" />
                {scanLoading ? 'Escaneando...' : 'Hardening Scan'}
              </button>
              {scanResult && !scanLoading && (
                <button
                  onClick={runAIHardeningAnalysis}
                  disabled={aiAnalyzing}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-bar border border-brand-border hover:bg-[#111] disabled:opacity-50 text-zinc-300 text-xs font-bold rounded cursor-pointer transition-colors"
                >
                  <Cpu className="w-3.5 h-3.5" />
                  {aiAnalyzing ? 'Analizando...' : 'Analizar con IA'}
                </button>
              )}
              <div className="flex-1" />
              <button
                onClick={onRunAuditScan}
                title="Auditoría rápida del servidor"
                className="px-2.5 py-1.5 bg-brand-bar border border-brand-border hover:bg-[#111] text-zinc-500 text-xs rounded cursor-pointer transition-colors"
              >
                Auditoría rápida
              </button>
            </div>

            {/* Loading */}
            {scanLoading && (
              <div className="flex items-center gap-2 p-4 bg-brand-bar border border-brand-border rounded text-xs text-brand-text-muted animate-pulse flex-shrink-0">
                <RefreshCw className="w-4 h-4 animate-spin text-emerald-400 flex-shrink-0" />
                Ejecutando verificaciones de hardening en <strong className="text-zinc-300">{server?.name}</strong>… puede tardar 10–30 s.
              </div>
            )}

            {/* Error */}
            {scanError && (
              <div className="p-3 bg-red-950/30 border border-red-900/40 text-rose-300 text-xs rounded flex-shrink-0 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1">{scanError}</span>
                <button onClick={() => setScanError(null)}><X className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-300" /></button>
              </div>
            )}

            {/* Empty state */}
            {!scanResult && !scanLoading && !scanError && (
              <div className="flex flex-col items-center justify-center flex-1 py-12 text-center space-y-3">
                <Shield className="w-10 h-10 text-zinc-700" />
                <div>
                  <p className="text-sm font-bold text-zinc-400">Sin escaneo activo</p>
                  <p className="text-xs text-zinc-600 mt-1">Ejecuta un Hardening Scan para auditar SSH, firewall, kernel, usuarios, archivos y servicios</p>
                </div>
                <button
                  onClick={runHardeningScan}
                  disabled={!server}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-xs font-bold rounded cursor-pointer transition-colors"
                >
                  <Shield className="w-3.5 h-3.5" /> Iniciar Hardening Scan
                </button>
              </div>
            )}

            {/* Results */}
            {scanResult && !scanLoading && (
              <>
                {/* Score card */}
                <div className="bg-brand-bar border border-brand-border rounded p-3 space-y-2.5 flex-shrink-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-xs font-bold text-zinc-200 truncate">{scanResult.host}</span>
                      <span className="text-[10px] text-zinc-500 ml-2">{scanResult.os}</span>
                    </div>
                    <span className="text-[9px] text-zinc-600 font-mono flex-shrink-0">
                      {new Date(scanResult.timestamp).toLocaleString()}
                    </span>
                  </div>

                  {/* Score bar */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-mono">Risk Score</span>
                      <span className={`text-base font-bold font-mono ${
                        scanResult.summary.score >= 80 ? 'text-emerald-400' :
                        scanResult.summary.score >= 60 ? 'text-amber-400' : 'text-red-400'
                      }`}>{scanResult.summary.score}<span className="text-xs text-zinc-600">/100</span></span>
                    </div>
                    <div className="h-2 bg-[#050505] rounded-full overflow-hidden border border-brand-border">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${
                          scanResult.summary.score >= 80 ? 'bg-emerald-500' :
                          scanResult.summary.score >= 60 ? 'bg-amber-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${scanResult.summary.score}%` }}
                      />
                    </div>
                  </div>

                  {/* Summary counters */}
                  <div className="grid grid-cols-4 gap-1.5">
                    {([
                      { label: 'PASS',    value: scanResult.summary.passed,   cls: 'text-emerald-400 bg-emerald-950/20 border-emerald-900/30' },
                      { label: 'FAIL',    value: scanResult.summary.failed,   cls: 'text-red-400     bg-red-950/20     border-red-900/30' },
                      { label: 'WARN',    value: scanResult.summary.warnings, cls: 'text-amber-400   bg-amber-950/20   border-amber-900/30' },
                      { label: 'CRÍTICO', value: scanResult.summary.critical, cls: 'text-rose-400    bg-rose-950/30    border-rose-900/40' },
                    ] as const).map(({ label, value, cls }) => (
                      <div key={label} className={`flex flex-col items-center py-1.5 rounded border ${cls}`}>
                        <span className="text-sm font-bold font-mono leading-none">{value}</span>
                        <span className="text-[8px] uppercase tracking-wider mt-0.5 opacity-80">{label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* AI analysis result */}
                {aiAnalyzing && (
                  <div className="flex items-center gap-2 p-3 bg-brand-bar border border-brand-border rounded text-xs text-brand-text-muted animate-pulse flex-shrink-0">
                    <Cpu className="w-4 h-4 animate-spin text-emerald-400" />
                    La IA está analizando el reporte de hardening…
                  </div>
                )}
                {aiHardeningAnalysis && (
                  <div className="bg-emerald-950/10 border border-emerald-900/30 rounded p-3 flex-shrink-0">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-400 mb-2 uppercase tracking-wider">
                      <Cpu className="w-3.5 h-3.5" /> Plan de Remediación IA
                    </div>
                    <p className="text-xs text-emerald-300 leading-relaxed whitespace-pre-wrap">{aiHardeningAnalysis}</p>
                  </div>
                )}

                {/* Policies grouped by category */}
                <div className="space-y-2">
                  {Object.entries(
                    scanResult.policies.reduce<Record<string, HardeningPolicy[]>>((acc, p) => {
                      if (!acc[p.category]) acc[p.category] = [];
                      acc[p.category].push(p);
                      return acc;
                    }, {})
                  ).map(([cat, catPolicies]: [string, HardeningPolicy[]]) => {
                    const catMeta = HARDENING_CAT_META[cat] || { label: cat, emoji: '🔧' };
                    const catFailed = catPolicies.filter((p) => p.status === 'FAIL').length;
                    const catWarn   = catPolicies.filter((p) => p.status === 'WARN').length;
                    const catPassed = catPolicies.filter((p) => p.status === 'PASS').length;
                    return (
                      <div key={cat} className="bg-brand-panel border border-brand-border rounded overflow-hidden">
                        {/* Category header */}
                        <div className="flex items-center justify-between px-3 py-2 bg-brand-bar border-b border-brand-border">
                          <span className="text-xs font-bold text-zinc-200">
                            {catMeta.emoji} {catMeta.label}
                          </span>
                          <div className="flex items-center gap-1.5 text-[10px] font-mono">
                            <span className="text-emerald-400">{catPassed}✓</span>
                            {catWarn   > 0 && <span className="text-amber-400">{catWarn}⚠</span>}
                            {catFailed > 0 && <span className="text-red-400">{catFailed}✗</span>}
                          </div>
                        </div>

                        {/* Policy rows */}
                        <div className="divide-y divide-[#0d0d0d]">
                          {catPolicies.map((policy) => {
                            const isExp = expandedPolicy === policy.policy_id;
                            const stCls = HARDENING_STATUS_CLS[policy.status] || 'bg-zinc-800 text-zinc-400 border-zinc-700';
                            const svCls = HARDENING_SEV_CLS[policy.severity]  || 'bg-zinc-800 text-zinc-400 border-zinc-700';
                            return (
                              <div key={policy.policy_id}>
                                {/* Collapsed row */}
                                <button
                                  onClick={() => setExpandedPolicy(isExp ? null : policy.policy_id)}
                                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#050505]/60 transition-colors text-left"
                                >
                                  <span className={`px-1.5 py-0.5 text-[8px] font-bold uppercase rounded border flex-shrink-0 ${stCls}`}>
                                    {policy.status}
                                  </span>
                                  <span className={`px-1.5 py-0.5 text-[8px] font-bold uppercase rounded border flex-shrink-0 ${svCls}`}>
                                    {policy.severity}
                                  </span>
                                  <span className="flex-1 text-xs text-zinc-200 font-semibold leading-snug">{policy.title}</span>
                                  <span className="text-zinc-600 text-[9px] flex-shrink-0">{isExp ? '▲' : '▼'}</span>
                                </button>

                                {/* Expanded details */}
                                {isExp && (
                                  <div className="px-3 pb-3 pt-1 space-y-2 bg-[#050505]/50">
                                    <p className="text-[11px] text-zinc-400 leading-relaxed">{policy.description}</p>

                                    {/* Evidence */}
                                    <div className="bg-[#050505] border border-brand-border rounded p-2">
                                      <p className="text-[8px] text-zinc-600 uppercase tracking-widest font-mono mb-1.5">Evidencia técnica</p>
                                      <div className="space-y-0.5">
                                        {Object.entries(policy.evidence).map(([k, v]) => (
                                          <div key={k} className="flex items-center gap-2 text-[10px] font-mono">
                                            <span className="text-zinc-600 min-w-[100px]">{k}:</span>
                                            <span className={`font-semibold ${
                                              String(v) === String((policy.evidence as any).expected) ? 'text-emerald-400' : 'text-zinc-100'
                                            }`}>{String(v)}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>

                                    {/* Remediation */}
                                    {policy.recommendation.command && (
                                      <div className="bg-[#050505] border border-emerald-900/30 rounded p-2">
                                        <p className="text-[8px] text-emerald-700 uppercase tracking-widest font-mono mb-1.5">Remediación</p>
                                        <pre className="text-[10px] text-emerald-300 font-mono whitespace-pre-wrap break-all">$ {policy.recommendation.command}</pre>
                                        {policy.recommendation.restart && (
                                          <pre className="text-[10px] text-emerald-300 font-mono mt-1">$ {policy.recommendation.restart}</pre>
                                        )}
                                      </div>
                                    )}

                                    {/* Compliance frameworks */}
                                    {policy.compliance.length > 0 && (
                                      <div className="flex flex-wrap gap-1">
                                        {policy.compliance.map((c, i) => (
                                          <span key={i} className="px-1.5 py-0.5 text-[9px] bg-brand-bar border border-brand-border rounded font-mono text-zinc-500">
                                            {c.framework} {c.control}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* Legacy quick audit assets (at bottom, compact) */}
            {securityAssets.length > 0 && (
              <div className="border-t border-brand-border pt-3 space-y-2 flex-shrink-0">
                <p className="text-[9px] text-zinc-700 uppercase tracking-widest font-mono">Auditoría rápida del servidor</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {securityAssets.map((asset) => {
                    const dot = { secure: 'bg-emerald-500', warning: 'bg-amber-500', danger: 'bg-red-500' };
                    return (
                      <div key={asset.id} className="bg-brand-bar border border-brand-border p-2.5 rounded flex items-start gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1 ${dot[asset.status] || 'bg-zinc-600'}`} />
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold text-zinc-300 truncate">{asset.name}</p>
                          <p className="text-[10px] text-brand-text-muted mt-0.5 leading-relaxed">{asset.details}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
