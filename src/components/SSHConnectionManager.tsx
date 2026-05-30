/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { ServerConnection } from '../types';
import {
  Server, ShieldCheck, Plus, Trash2, Key, Check, AlertCircle,
  ServerOff, Wifi, WifiOff, Loader2, Lock, Monitor, Upload,
  Eye, EyeOff, Fingerprint, Zap, Copy, X, CheckCircle2,
  Info, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// ── Key analysis helpers ──────────────────────────────────────────────────────

function detectKeyInfo(pem: string): { type: string; bits: number } | null {
  const t = pem.trim();
  if (!t.startsWith('-----BEGIN')) return null;
  if (t.includes('BEGIN RSA PRIVATE KEY'))    return { type: 'RSA', bits: 2048 };
  if (t.includes('BEGIN EC PRIVATE KEY'))     return { type: 'ECDSA', bits: 256 };
  if (t.includes('BEGIN DSA PRIVATE KEY'))    return { type: 'DSA', bits: 1024 };
  if (t.includes('BEGIN OPENSSH PRIVATE KEY')) {
    try {
      const b64 = t.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
      const decoded = atob(b64);
      if (decoded.includes('ed25519')) return { type: 'ED25519', bits: 256 };
      if (decoded.includes('ecdsa'))   return { type: 'ECDSA', bits: 256 };
      if (decoded.includes('ssh-rsa')) return { type: 'RSA', bits: 2048 };
    } catch { /* */ }
    return { type: 'OpenSSH', bits: 256 };
  }
  if (t.includes('BEGIN PRIVATE KEY')) return { type: 'PKCS8/RSA', bits: 2048 };
  return null;
}

async function computeFingerprints(pem: string): Promise<{ sha256: string; md5: string }> {
  try {
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    const arr = Array.from(new Uint8Array(buf));
    const sha256 = 'SHA256:' + btoa(String.fromCharCode(...arr)).replace(/=/g, '');
    const md5 = arr.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
    return { sha256, md5 };
  } catch {
    return { sha256: 'SHA256:(error)', md5: '(error)' };
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface SSHConnectionManagerProps {
  servers: ServerConnection[];
  selectedServer: ServerConnection | null;
  onSelectServer: (server: ServerConnection) => void;
  onAddServer: (serverData: Omit<ServerConnection, 'id' | 'status'>) => Promise<void>;
  onDeleteServer: (serverId: string) => Promise<void>;
  onConnectServer: (serverId: string) => Promise<void>;
  onDisconnectServer: (serverId: string) => Promise<void>;
  onCleanupUnusedServers: () => Promise<void>;
  loading: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SSHConnectionManager({
  servers,
  selectedServer,
  onSelectServer,
  onAddServer,
  onDeleteServer,
  onConnectServer,
  onDisconnectServer,
  onCleanupUnusedServers,
  loading,
}: SSHConnectionManagerProps) {

  const [busyId, setBusyId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);

  // ── Wizard state ───────────────────────────────────────────────────────────
  type AuthKind = 'password' | 'privateKey' | 'agent';
  const [authType, setAuthType]         = useState<AuthKind>('password');
  const [name, setName]                 = useState('');
  const [host, setHost]                 = useState('');
  const [port, setPort]                 = useState('22');
  const [username, setUsername]         = useState('root');
  const [password, setPassword]         = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Step 2 — key upload
  const [privateKey, setPrivateKey]         = useState('');
  const [passphrase, setPassphrase]         = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [keyInputMode, setKeyInputMode]     = useState<'file' | 'paste'>('file');
  const [keyFileName, setKeyFileName]       = useState('');
  const [dragging, setDragging]             = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 3 — validation (auto-computed)
  const [keyInfo, setKeyInfo]     = useState<{ type: string; bits: number } | null>(null);
  const [keyInvalid, setKeyInvalid] = useState(false);

  // Step 4 — fingerprints (auto-computed)
  const [fingerprints, setFingerprints] = useState<{ sha256: string; md5: string } | null>(null);
  const [copiedFP, setCopiedFP]         = useState<'sha256' | 'md5' | null>(null);

  // Step 5 — test connection
  const [testResult, setTestResult] = useState<{ success: boolean; latency?: number; error?: string } | null>(null);
  const [testing, setTesting]       = useState(false);

  // Global wizard
  const [formError, setFormError]     = useState('');
  const [formSuccess, setFormSuccess] = useState('');
  const [saving, setSaving]           = useState(false);

  // Section refs
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const stepRefs = [
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
    useRef<HTMLDivElement>(null),
  ];

  const skipKeySteps = authType !== 'privateKey';
  const step1Valid   = !!(name.trim() && host.trim() && username.trim());

  // Auto-compute key info + fingerprints on key change
  useEffect(() => {
    if (!privateKey.trim()) {
      setKeyInfo(null); setKeyInvalid(false); setFingerprints(null); return;
    }
    const info = detectKeyInfo(privateKey);
    setKeyInfo(info);
    setKeyInvalid(!info);
    if (info) computeFingerprints(privateKey).then(setFingerprints);
    else setFingerprints(null);
  }, [privateKey]);

  const handleFileRead = (file: File) => {
    setKeyFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => setPrivateKey((e.target?.result as string) || '');
    reader.readAsText(file);
  };

  const copyFP = async (which: 'sha256' | 'md5') => {
    const text = which === 'sha256' ? fingerprints?.sha256 : fingerprints?.md5;
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch { /* */ }
    setCopiedFP(which);
    setTimeout(() => setCopiedFP(null), 2000);
  };

  const handleTestConnection = async () => {
    if (!host || !username) { setFormError('Completa host y usuario antes de probar.'); return; }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/servers/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host, port: parseInt(port) || 22, username,
          authType: authType === 'agent' ? 'password' : authType,
          password: authType === 'password' ? password : '',
          privateKey: authType === 'privateKey' ? privateKey : '',
          passphrase: authType === 'privateKey' ? passphrase : '',
        }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!step1Valid) { setFormError('Nombre, host y usuario son requeridos.'); return; }
    if (authType === 'privateKey' && !privateKey.trim()) { setFormError('Carga o pega tu clave privada.'); return; }
    setSaving(true); setFormError('');
    try {
      await onAddServer({
        name, host, port: parseInt(port) || 22, username,
        authType: authType === 'agent' ? 'privateKey' : authType,
        password: authType === 'password' ? password : '',
        privateKey: authType === 'privateKey' ? privateKey : '',
      });
      setFormSuccess('¡Servidor guardado en el Vault!');
      setTimeout(() => { closeWizard(); }, 1800);
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const closeWizard = () => {
    setShowWizard(false);
    setAuthType('password'); setName(''); setHost(''); setPort('22'); setUsername('root');
    setPassword(''); setPrivateKey(''); setPassphrase('');
    setKeyInfo(null); setKeyInvalid(false); setFingerprints(null);
    setTestResult(null); setFormError(''); setFormSuccess('');
    setKeyFileName(''); setKeyInputMode('file');
  };

  const scrollToStep = (idx: number) => {
    stepRefs[idx]?.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ── Sidebar step config ────────────────────────────────────────────────────
  const STEPS = [
    { label: 'Tipo de Autenticación', sub: 'Selecciona cómo deseas conectarte al servidor', done: step1Valid, skip: false },
    { label: 'Cargar Clave',          sub: 'Sube tu clave privada (PEM/PPK)',                done: !!keyInfo,      skip: skipKeySteps },
    { label: 'Validación',            sub: 'Verificamos que la clave sea válida',            done: !!keyInfo,      skip: skipKeySteps },
    { label: 'Fingerprint',           sub: 'Mostramos las huellas digitales de la clave',   done: !!fingerprints, skip: skipKeySteps },
    { label: 'Probar Conexión',       sub: 'Probamos la conexión al servidor',              done: testResult?.success === true, skip: false },
    { label: 'Guardar en Vault',      sub: 'Cifrado y almacenamiento seguro',               done: !!formSuccess,  skip: false },
  ];

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Server list panel (always visible) ── */}
      <div id="ssh-connection-manager" className="flex flex-col h-full bg-brand-panel border border-brand-border rounded-xl p-4 overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-brand-border">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-xs font-bold text-brand-text-muted uppercase tracking-widest font-display">Vault de Credenciales</h2>
              <p className="text-[10px] text-zinc-500 font-sans">AES-256 SSH Connection Pool</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onCleanupUnusedServers}
              disabled={loading}
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-brand-dark border border-brand-border text-zinc-300 hover:bg-[#333] transition-all"
            >
              <Trash2 className="w-3.5 h-3.5" /> Limpiar Offline
            </button>
            <button
              onClick={() => setShowWizard(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded font-sans transition-all cursor-pointer bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500/20"
            >
              <Plus className="w-3.5 h-3.5" /> Agregar Server
            </button>
          </div>
        </div>

        {/* Server list */}
        <div className="flex-1 overflow-y-auto mt-3 space-y-2 pr-1">
          {servers.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
              <div className="p-4 bg-brand-bar border border-brand-border rounded-xl text-zinc-500">
                <ServerOff className="w-8 h-8" />
              </div>
              <div>
                <p className="text-xs font-bold text-zinc-300">Sin servidores</p>
                <p className="text-[11px] text-brand-text-muted mt-1 leading-relaxed">
                  Agregue un servidor Linux con sus credenciales SSH para comenzar.
                </p>
              </div>
              <button
                onClick={() => setShowWizard(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-emerald-600 hover:bg-emerald-500 text-white transition-all"
              >
                <Plus className="w-3.5 h-3.5" /> Agregar servidor
              </button>
            </div>
          ) : servers.map((serv) => {
            const isActive = selectedServer?.id === serv.id;
            return (
              <div
                key={serv.id}
                onClick={() => onSelectServer(serv)}
                className={`group relative flex items-center justify-between p-3 rounded border transition-all cursor-pointer ${
                  isActive
                    ? 'bg-brand-item border border-brand-border-light border-l-2 border-l-emerald-500 shadow-md'
                    : 'bg-brand-dark/40 border border-brand-border hover:bg-brand-item'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`p-2 rounded flex-shrink-0 ${isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-brand-bar text-zinc-400'}`}>
                    <Server className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span title={serv.name} className={`text-xs font-bold truncate max-w-[120px] ${isActive ? 'text-emerald-400' : 'text-zinc-200'}`}>{serv.name}</span>
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${serv.status === 'online' ? 'bg-emerald-400' : 'bg-[#404040]'}`} />
                    </div>
                    <span title={`${serv.username}@${serv.host}:${serv.port}`} className="text-[10px] text-brand-text-muted font-mono leading-tight block mt-0.5 truncate">
                      {serv.username}@{serv.host}:{serv.port}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {isActive && serv.status === 'online' && <span className="text-[9px] uppercase tracking-wider font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 font-mono">Activo</span>}
                  {isActive && serv.status === 'connecting' && <span className="text-[9px] uppercase tracking-wider font-bold text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 font-mono">Conectando</span>}
                  {isActive && serv.status === 'offline' && <span className="text-[9px] uppercase tracking-wider font-bold text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded border border-red-500/20 font-mono">Desconectado</span>}
                  {serv.authType === 'privateKey' && <Key className="w-3.5 h-3.5 text-zinc-500 group-hover:text-amber-400 transition-colors" />}

                  {busyId === serv.id ? (
                    <span className="p-1 text-zinc-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /></span>
                  ) : serv.status === 'online' ? (
                    <button onClick={async (e) => { e.stopPropagation(); setBusyId(serv.id); try { await onDisconnectServer(serv.id); } finally { setBusyId(null); } }}
                      title="Desconectar" className="p-1 rounded border border-brand-border hover:border-amber-400 hover:text-amber-300 text-zinc-500 transition-colors cursor-pointer">
                      <WifiOff className="w-3 h-3" />
                    </button>
                  ) : (
                    <button onClick={async (e) => { e.stopPropagation(); setBusyId(serv.id); try { await onConnectServer(serv.id); } finally { setBusyId(null); } }}
                      title="Conectar" className="p-1 rounded border border-brand-border hover:border-emerald-400 hover:text-emerald-300 text-zinc-500 transition-colors cursor-pointer">
                      <Wifi className="w-3 h-3" />
                    </button>
                  )}

                  <button onClick={(e) => { e.stopPropagation(); onDeleteServer(serv.id); }}
                    title="Eliminar servidor" className="p-1 rounded border border-brand-border hover:border-red-400 hover:text-red-300 text-zinc-500 transition-colors cursor-pointer">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Wizard overlay ── */}
      <AnimatePresence>
        {showWizard && (
          <motion.div
            key="vault-wizard"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="w-full max-w-4xl max-h-[92vh] bg-[#0d0d0d] border border-[#222] rounded-2xl flex overflow-hidden shadow-2xl"
            >
              {/* ── Left sidebar ── */}
              <div className="w-52 flex-shrink-0 bg-[#080808] border-r border-[#1a1a1a] flex flex-col">
                {/* Vault header */}
                <div className="p-4 border-b border-[#1a1a1a]">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="p-1.5 bg-emerald-500/10 rounded border border-emerald-500/20">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-zinc-200 uppercase tracking-widest leading-none">Vault de Credenciales</p>
                      <p className="text-[8px] text-zinc-600 font-mono mt-0.5">AES-256 SSH Connection Pool</p>
                    </div>
                  </div>
                </div>

                {/* Step list */}
                <div className="flex-1 p-3 space-y-0.5 overflow-y-auto">
                  {STEPS.map((step, idx) => (
                    <button
                      key={idx}
                      onClick={() => scrollToStep(idx)}
                      className={`w-full flex items-start gap-2.5 p-2 rounded-lg transition-colors text-left ${
                        step.skip ? 'opacity-30 cursor-default' : 'hover:bg-[#111] cursor-pointer'
                      }`}
                    >
                      {/* Step number circle */}
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 border text-[10px] font-bold transition-colors ${
                        step.done && !step.skip
                          ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                          : step.skip
                          ? 'bg-[#1a1a1a] border-[#2a2a2a] text-zinc-700'
                          : 'bg-[#1a1a1a] border-[#333] text-zinc-500'
                      }`}>
                        {step.done && !step.skip ? <Check className="w-3 h-3" /> : idx + 1}
                      </div>
                      <div className="min-w-0">
                        <p className={`text-[11px] font-semibold leading-tight ${step.skip ? 'text-zinc-700' : step.done ? 'text-emerald-400' : 'text-zinc-300'}`}>
                          {step.label}
                        </p>
                        <p className="text-[9px] text-zinc-600 leading-tight mt-0.5">{step.sub}</p>
                      </div>
                    </button>
                  ))}
                </div>

                {/* Sidebar actions */}
                <div className="p-3 border-t border-[#1a1a1a] space-y-2">
                  <button
                    onClick={onCleanupUnusedServers}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded bg-[#111] border border-[#222] text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" /> Limpiar Offline
                  </button>
                  <button
                    onClick={closeWizard}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded bg-[#111] border border-[#222] text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors cursor-pointer"
                  >
                    <X className="w-3 h-3" /> Cancelar
                  </button>
                </div>
              </div>

              {/* ── Right content ── */}
              <div ref={rightPanelRef} className="flex-1 overflow-y-auto p-6 space-y-6 bg-[#0d0d0d]">

                {/* Global messages */}
                {formError && (
                  <div className="flex items-center gap-2 p-3 bg-red-950/30 border border-red-900/40 text-red-300 text-xs rounded-lg">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{formError}</span>
                    <button onClick={() => setFormError('')} className="ml-auto"><X className="w-3.5 h-3.5" /></button>
                  </div>
                )}
                {formSuccess && (
                  <div className="flex items-center gap-2 p-3 bg-emerald-950/30 border border-emerald-900/40 text-emerald-300 text-xs rounded-lg">
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                    <span>{formSuccess}</span>
                  </div>
                )}

                {/* ── STEP 1: Auth type + server info ── */}
                <div ref={stepRefs[0]} className="space-y-4">
                  <div>
                    <p className="text-[9px] text-zinc-600 uppercase tracking-widest font-mono">1. TIPO DE AUTENTICACIÓN</p>
                    <p className="text-xs text-zinc-500 mt-0.5">Selecciona el método de autenticación para conectar al servidor</p>
                  </div>

                  {/* Auth type buttons */}
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { id: 'password',   icon: Lock,    label: 'Contraseña' },
                      { id: 'privateKey', icon: Key,     label: 'Clave Privada' },
                      { id: 'agent',      icon: Monitor, label: 'Agente SSH' },
                    ] as const).map(({ id, icon: Icon, label }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setAuthType(id)}
                        className={`flex items-center justify-center gap-2 py-2.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
                          authType === id
                            ? 'bg-emerald-600 border-emerald-500 text-white'
                            : 'bg-[#111] border-[#222] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {label}
                        {id === 'agent' && authType !== 'agent' && (
                          <span className="text-[8px] bg-zinc-800 text-zinc-500 px-1 rounded">Beta</span>
                        )}
                      </button>
                    ))}
                  </div>

                  {/* Server fields */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] text-zinc-500 font-mono mb-1.5">Nombre Descriptivo</label>
                      <input type="text" placeholder="e.g. prod-core-01" value={name} onChange={e => setName(e.target.value)}
                        className="w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-emerald-500/50 transition-colors" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 font-mono mb-1.5">Puerto</label>
                      <input type="text" placeholder="22" value={port} onChange={e => setPort(e.target.value)}
                        className="w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-emerald-500/50 transition-colors" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 font-mono mb-1.5">IP o Dominio Host</label>
                      <input type="text" placeholder="192.168.1.100" value={host} onChange={e => setHost(e.target.value)}
                        className="w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-emerald-500/50 transition-colors" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 font-mono mb-1.5">Usuario SSH</label>
                      <input type="text" placeholder="root" value={username} onChange={e => setUsername(e.target.value)}
                        className="w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-emerald-500/50 transition-colors" />
                    </div>
                  </div>

                  {/* Password field (only for password auth) */}
                  {authType === 'password' && (
                    <div>
                      <label className="block text-[10px] text-zinc-500 font-mono mb-1.5">Contraseña SSH</label>
                      <div className="relative">
                        <input
                          type={showPassword ? 'text' : 'password'}
                          placeholder="••••••••••••••••"
                          value={password}
                          onChange={e => setPassword(e.target.value)}
                          className="w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 pr-9 text-xs text-zinc-200 outline-none focus:border-emerald-500/50 transition-colors"
                        />
                        <button type="button" onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 cursor-pointer">
                          {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Agent SSH notice */}
                  {authType === 'agent' && (
                    <div className="flex items-start gap-2 p-3 bg-blue-950/20 border border-blue-900/30 rounded-lg">
                      <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-blue-300 leading-relaxed">
                        El Agente SSH usará las claves cargadas en tu agente local. Asegúrate de que el agente esté activo y las claves estén añadidas con <code className="bg-[#111] px-1 rounded font-mono">ssh-add</code>.
                      </p>
                    </div>
                  )}
                </div>

                {/* ── STEP 2: Load key (privateKey only) ── */}
                {authType === 'privateKey' && (
                  <div ref={stepRefs[1]} className="space-y-4 border-t border-[#1a1a1a] pt-6">
                    <div>
                      <p className="text-[9px] text-zinc-600 uppercase tracking-widest font-mono">2. CARGAR CLAVE PRIVADA</p>
                      <p className="text-xs text-zinc-500 mt-0.5">Sube tu archivo de clave privada (.pem, .ppk) o pégala manualmente</p>
                    </div>

                    {/* Help info box */}
                    <div className="bg-[#0a0a1a] border border-blue-900/30 rounded-lg p-3 space-y-3">
                      <div className="flex items-center gap-1.5 text-[11px] font-bold text-blue-400">
                        <Info className="w-3.5 h-3.5" />
                        ¿De dónde obtengo mi clave privada?
                      </div>
                      <p className="text-[10px] text-zinc-500">Puedes usar una clave existente en tu equipo o generar una nueva.</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <p className="text-[8px] text-zinc-600 uppercase tracking-widest font-mono mb-1.5">VERIFICAR CLAVES EXISTENTES</p>
                          <code className="block bg-[#050505] border border-[#222] rounded px-2 py-1.5 text-[10px] text-emerald-400 font-mono">ls ~/.ssh</code>
                          <p className="text-[9px] text-zinc-600 mt-1.5 mb-1">Normalmente verás archivos como:</p>
                          <div className="flex flex-wrap gap-1">
                            {['id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub'].map(f => (
                              <span key={f} className="text-[9px] bg-[#111] border border-[#222] px-1.5 py-0.5 rounded font-mono text-zinc-400">{f}</span>
                            ))}
                          </div>
                        </div>
                        <div>
                          <p className="text-[8px] text-zinc-600 uppercase tracking-widest font-mono mb-1.5">GENERAR NUEVA CLAVE (RECOMENDADO)</p>
                          <code className="block bg-[#050505] border border-[#222] rounded px-2 py-1.5 text-[10px] text-emerald-400 font-mono break-all">{'ssh-keygen -t ed25519 -C "tu-servidor"'}</code>
                          <p className="text-[9px] text-zinc-600 mt-1.5 mb-1">Esto creará:</p>
                          <div className="flex flex-wrap gap-1">
                            {['id_ed25519', 'id_ed25519.pub'].map(f => (
                              <span key={f} className="text-[9px] bg-[#111] border border-[#222] px-1.5 py-0.5 rounded font-mono text-zinc-400">{f}</span>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-start gap-1.5 pt-1 border-t border-[#1a1a1a]">
                        <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
                        <p className="text-[10px] text-zinc-400">
                          Importante: Sube la <span className="text-amber-400 font-semibold">clave privada</span> (<code className="font-mono text-zinc-300">id_ed25519</code> o <code className="font-mono text-zinc-300">id_rsa</code>), NO el archivo <span className="text-rose-400 font-semibold">.pub</span>
                        </p>
                      </div>
                    </div>

                    {/* Upload / Paste tabs */}
                    <div className="flex gap-2 border-b border-[#1a1a1a]">
                      {(['file', 'paste'] as const).map((mode) => (
                        <button key={mode} type="button" onClick={() => setKeyInputMode(mode)}
                          className={`flex items-center gap-1.5 px-4 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer -mb-px ${
                            keyInputMode === mode
                              ? 'border-emerald-500 text-emerald-400'
                              : 'border-transparent text-zinc-500 hover:text-zinc-300'
                          }`}>
                          {mode === 'file' ? <><Upload className="w-3.5 h-3.5" /> Subir Archivo</> : <><Key className="w-3.5 h-3.5" /> Pegar Clave Manualmente</>}
                        </button>
                      ))}
                    </div>

                    {keyInputMode === 'file' ? (
                      /* Drop zone */
                      <div
                        onDragOver={e => { e.preventDefault(); setDragging(true); }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFileRead(f); }}
                        className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center gap-3 transition-colors ${
                          dragging ? 'border-emerald-500 bg-emerald-950/10' : keyFileName ? 'border-emerald-600/40 bg-emerald-950/5' : 'border-[#222] hover:border-[#333]'
                        }`}
                      >
                        <Upload className={`w-8 h-8 ${dragging ? 'text-emerald-400' : keyFileName ? 'text-emerald-600' : 'text-zinc-700'}`} />
                        {keyFileName ? (
                          <div className="text-center">
                            <p className="text-sm font-semibold text-emerald-400">{keyFileName}</p>
                            <p className="text-xs text-zinc-500 mt-1">Archivo cargado correctamente</p>
                          </div>
                        ) : (
                          <div className="text-center">
                            <p className="text-sm text-zinc-300">Arrastra tu archivo de clave privada aquí</p>
                            <p className="text-xs text-zinc-600 mt-1">o haz clic para seleccionar</p>
                          </div>
                        )}
                        <div className="flex items-center gap-3 w-full">
                          <span className="text-[10px] text-zinc-600 flex-1">Formatos soportados: .pem, .ppk, .key, id_rsa, id_ed25519</span>
                          <button type="button" onClick={() => fileInputRef.current?.click()}
                            className="px-3 py-1.5 bg-[#111] border border-[#333] text-zinc-300 text-xs rounded-lg hover:border-zinc-500 cursor-pointer">
                            Seleccionar Archivo
                          </button>
                        </div>
                        <input type="file" ref={fileInputRef} className="hidden"
                          accept=".pem,.ppk,.key,.txt,id_rsa,id_ed25519,id_ecdsa"
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleFileRead(f); }} />
                      </div>
                    ) : (
                      /* Paste textarea */
                      <textarea
                        placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'}
                        rows={8}
                        value={privateKey}
                        onChange={e => setPrivateKey(e.target.value)}
                        className="w-full bg-[#080808] border border-[#222] rounded-xl px-3 py-2.5 text-[11px] font-mono text-zinc-300 outline-none focus:border-emerald-500/40 resize-none transition-colors"
                      />
                    )}

                    {/* Invalid key warning */}
                    {keyInvalid && privateKey && (
                      <div className="flex items-center gap-2 p-2.5 bg-red-950/20 border border-red-900/30 rounded-lg text-xs text-red-300">
                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                        El archivo no parece una clave privada válida. Verifica que no sea el archivo .pub.
                      </div>
                    )}

                    {/* Passphrase */}
                    <div>
                      <label className="block text-[10px] text-zinc-500 font-mono mb-1.5">Passphrase (Opcional)</label>
                      <div className="relative">
                        <input
                          type={showPassphrase ? 'text' : 'password'}
                          placeholder="Vacío si tu clave no tiene passphrase"
                          value={passphrase}
                          onChange={e => setPassphrase(e.target.value)}
                          className="w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 pr-9 text-xs text-zinc-200 outline-none focus:border-emerald-500/50 transition-colors"
                        />
                        <button type="button" onClick={() => setShowPassphrase(!showPassphrase)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 cursor-pointer">
                          {showPassphrase ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      <div className="flex items-start gap-1.5 mt-2 p-2.5 bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg">
                        <Info className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 mt-0.5" />
                        <p className="text-[10px] text-zinc-500 leading-relaxed">
                          La passphrase es la contraseña que usaste al generar la clave privada. Déjala vacía si tu clave no tiene passphrase.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── STEP 3: Key validation ── */}
                {authType === 'privateKey' && (
                  <div ref={stepRefs[2]} className="space-y-3 border-t border-[#1a1a1a] pt-6">
                    <div>
                      <p className="text-[9px] text-zinc-600 uppercase tracking-widest font-mono">3. VALIDACIÓN DE CLAVE</p>
                    </div>

                    {!privateKey ? (
                      <p className="text-xs text-zinc-600 italic">Carga una clave en el paso anterior para ver la validación.</p>
                    ) : keyInfo ? (
                      <>
                        <div className="flex items-center gap-2 text-xs text-emerald-400 font-semibold">
                          <CheckCircle2 className="w-4 h-4" />
                          La clave ha sido validada correctamente
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="bg-[#111] border border-[#222] rounded-xl p-3 flex items-start gap-2">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                            <div>
                              <p className="text-[10px] font-semibold text-zinc-300">Formato válido</p>
                              <p className="text-[10px] text-zinc-500 mt-0.5">Tipo de clave detectado: <span className="text-emerald-400 font-mono">{keyInfo.type}</span></p>
                            </div>
                          </div>
                          <div className="bg-[#111] border border-[#222] rounded-xl p-3 flex items-center justify-between">
                            <div className="flex items-start gap-2">
                              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                              <div>
                                <p className="text-[10px] font-semibold text-zinc-300">Longitud de clave</p>
                                <p className="text-[10px] text-zinc-500 mt-0.5"><span className="text-zinc-300 font-mono">{keyInfo.bits}</span> bits</p>
                              </div>
                            </div>
                            <span className="text-[9px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">Válido</span>
                          </div>
                        </div>
                      </>
                    ) : keyInvalid ? (
                      <div className="flex items-center gap-2 text-xs text-red-400 font-semibold">
                        <AlertCircle className="w-4 h-4" />
                        Formato de clave no reconocido — verifica que sea una clave privada válida.
                      </div>
                    ) : null}
                  </div>
                )}

                {/* ── STEP 4: Fingerprints ── */}
                {authType === 'privateKey' && (
                  <div ref={stepRefs[3]} className="space-y-3 border-t border-[#1a1a1a] pt-6">
                    <div>
                      <p className="text-[9px] text-zinc-600 uppercase tracking-widest font-mono">4. FINGERPRINT DE CLAVE</p>
                      <p className="text-xs text-zinc-500 mt-0.5">Huellas digitales de la clave para verificación</p>
                    </div>

                    {!fingerprints ? (
                      <p className="text-xs text-zinc-600 italic">Los fingerprints aparecerán cuando la clave sea válida.</p>
                    ) : (
                      <div className="bg-[#080808] border border-[#1a1a1a] rounded-xl p-4 space-y-3">
                        <div className="flex items-center gap-3">
                          <Fingerprint className="w-6 h-6 text-zinc-600 flex-shrink-0" />
                          <div className="flex-1 space-y-2 min-w-0">
                            {/* SHA256 */}
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-zinc-600 font-mono w-12 flex-shrink-0">SHA256:</span>
                              <code className="flex-1 text-[10px] font-mono text-zinc-300 truncate">{fingerprints.sha256}</code>
                              <button onClick={() => copyFP('sha256')} title="Copiar SHA256"
                                className="flex-shrink-0 p-1 rounded text-zinc-600 hover:text-emerald-400 hover:bg-emerald-950/30 transition-colors cursor-pointer">
                                {copiedFP === 'sha256' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                            {/* MD5 */}
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-zinc-600 font-mono w-12 flex-shrink-0">MD5:</span>
                              <code className="flex-1 text-[10px] font-mono text-zinc-300 truncate">{fingerprints.md5}</code>
                              <button onClick={() => copyFP('md5')} title="Copiar MD5"
                                className="flex-shrink-0 p-1 rounded text-zinc-600 hover:text-emerald-400 hover:bg-emerald-950/30 transition-colors cursor-pointer">
                                {copiedFP === 'md5' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── STEP 5: Test connection ── */}
                <div ref={stepRefs[4]} className="space-y-3 border-t border-[#1a1a1a] pt-6">
                  <div>
                    <p className="text-[9px] text-zinc-600 uppercase tracking-widest font-mono">5. PROBAR CONEXIÓN</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {testing ? 'Probando conexión SSH al servidor...' : 'Verifica que las credenciales son correctas antes de guardar'}
                    </p>
                  </div>

                  {!testResult && !testing && (
                    <button
                      onClick={handleTestConnection}
                      disabled={!step1Valid}
                      className="flex items-center gap-2 px-4 py-2 bg-[#111] border border-[#222] hover:border-zinc-500 text-zinc-300 text-xs font-semibold rounded-lg cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Zap className="w-3.5 h-3.5 text-amber-400" /> Probar Conexión SSH
                    </button>
                  )}

                  {testing && (
                    <div className="flex items-center gap-2 text-xs text-zinc-400 animate-pulse">
                      <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                      Conectando a {host}:{port}…
                    </div>
                  )}

                  {testResult && (
                    <div className={`flex items-center justify-between p-3 rounded-xl border ${
                      testResult.success
                        ? 'bg-emerald-950/20 border-emerald-900/40'
                        : 'bg-red-950/20 border-red-900/40'
                    }`}>
                      <div className="flex items-center gap-2">
                        {testResult.success
                          ? <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                          : <AlertCircle className="w-5 h-5 text-red-400" />}
                        <div>
                          <p className={`text-xs font-semibold ${testResult.success ? 'text-emerald-300' : 'text-red-300'}`}>
                            {testResult.success ? 'Conexión exitosa' : 'Conexión fallida'}
                          </p>
                          <p className="text-[10px] text-zinc-500 mt-0.5">
                            {testResult.success
                              ? 'Conexión SSH establecida correctamente'
                              : testResult.error || 'No se pudo conectar al servidor'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {testResult.latency !== undefined && testResult.success && (
                          <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                            <Zap className="w-3 h-3 text-amber-500" /> {testResult.latency}ms
                          </span>
                        )}
                        <button
                          onClick={handleTestConnection}
                          disabled={testing}
                          className="px-2.5 py-1 text-[10px] font-semibold bg-[#111] border border-[#222] text-zinc-400 hover:text-zinc-200 rounded-lg cursor-pointer transition-colors"
                        >
                          <RefreshCw className="w-3 h-3 inline mr-1" />Probar de Nuevo
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* ── STEP 6: Save to Vault ── */}
                <div ref={stepRefs[5]} className="space-y-3 border-t border-[#1a1a1a] pt-6">
                  <div>
                    <p className="text-[9px] text-zinc-600 uppercase tracking-widest font-mono">6. GUARDAR EN VAULT</p>
                    <p className="text-xs text-zinc-500 mt-0.5">La conexión se guardará cifrada en tu vault de credenciales</p>
                  </div>

                  <button
                    onClick={handleSave}
                    disabled={saving || !!formSuccess}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900 disabled:text-emerald-700 text-white text-sm font-bold rounded-xl cursor-pointer transition-colors"
                  >
                    {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Guardando…</> : <><ShieldCheck className="w-4 h-4" /> Guardar en Vault de Credenciales</>}
                  </button>

                  <div className="flex items-center gap-1.5 justify-center">
                    <Info className="w-3 h-3 text-zinc-600" />
                    <p className="text-[10px] text-zinc-600">Tus claves privadas se cifran con AES-256 antes de ser almacenadas.</p>
                  </div>
                </div>

              </div>{/* end right content */}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
