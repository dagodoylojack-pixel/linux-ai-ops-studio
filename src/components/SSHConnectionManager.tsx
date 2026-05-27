/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { ServerConnection } from '../types';
import { Server, ShieldCheck, Plus, Trash2, Key, Check, AlertCircle, ServerOff, Wifi, WifiOff, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

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
  const [showAddForm, setShowAddForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  
  // Form States
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('root');
  const [authType, setAuthType] = useState<'password' | 'privateKey'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setFormSuccess('');

    if (!name || !host || !username) {
      setFormError('El nombre, host/IP y usuario son requeridos.');
      return;
    }

    try {
      await onAddServer({
        name,
        host,
        port: parseInt(port) || 22,
        username,
        authType,
        password: authType === 'password' ? password : '',
        privateKey: authType === 'privateKey' ? privateKey : '',
      });

      setFormSuccess('¡Servidor agregado y conectado!');
      // Reset form
      setName('');
      setHost('');
      setPort('22');
      setUsername('root');
      setPassword('');
      setPrivateKey('');
      
      setTimeout(() => {
        setShowAddForm(false);
        setFormSuccess('');
      }, 1500);
    } catch (err: any) {
      setFormError('Error al guardar credenciales en el Vault: ' + err.message);
    }
  };

  return (
    <div id="ssh-connection-manager" className="flex flex-col h-full bg-brand-panel border border-brand-border rounded-xl p-4 overflow-hidden shadow-2xl">
      {/* Vault Title */}
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
            onClick={() => setShowAddForm(!showAddForm)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded font-sans transition-all cursor-pointer ${
              showAddForm
                ? 'bg-brand-border text-zinc-300 hover:bg-[#333]'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500/20'
            }`}
          >
            {showAddForm ? 'Cancelar' : <><Plus className="w-3.5 h-3.5" /> Agregar Server</>}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto mt-3 space-y-3 pr-1">
        <AnimatePresence mode="wait">
          {showAddForm ? (
            <motion.form
              key="add-server-form"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              onSubmit={handleSubmit}
              className="space-y-3 bg-brand-bar p-3 rounded border border-brand-border"
            >
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-brand-text-muted">Nuevo Servidor Linux</h3>
              
              {formError && (
                <div className="flex items-center gap-2 p-2 bg-red-950/30 border border-red-900/40 text-red-200 text-xs rounded animate-pulse">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              {formSuccess && (
                <div className="flex items-center gap-2 p-2 bg-emerald-950/30 border border-emerald-900/40 text-emerald-300 text-xs rounded">
                  <Check className="w-4 h-4 flex-shrink-0 animate-bounce" />
                  <span>{formSuccess}</span>
                </div>
              )}

              <div>
                <label className="block text-[10px] text-zinc-400 font-mono mb-1">Nombre Descriptivo</label>
                <input
                  type="text"
                  placeholder="e.g. prod-core-01"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-brand-dark border border-brand-border rounded px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-brand-border-light transition-colors"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block text-[10px] text-zinc-400 font-mono mb-1">IP o Dominio Host</label>
                  <input
                    type="text"
                    placeholder="192.168.1.100"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    className="w-full bg-brand-dark border border-brand-border rounded px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-brand-border-light transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-400 font-mono mb-1">Puerto</label>
                  <input
                    type="text"
                    placeholder="22"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className="w-full bg-brand-dark border border-brand-border rounded px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-brand-border-light transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] text-zinc-400 font-mono mb-1">Usuario SSH</label>
                <input
                  type="text"
                  placeholder="root"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-brand-dark border border-brand-border rounded px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-brand-border-light transition-colors"
                />
              </div>

              <div>
                <label className="block text-[10px] text-zinc-400 font-mono mb-1">Tipo de Autenticación</label>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => setAuthType('password')}
                    className={`px-2.5 py-1.5 text-xs rounded border flex items-center justify-center gap-1 cursor-pointer ${
                      authType === 'password'
                        ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-400'
                        : 'border-brand-border bg-brand-dark hover:bg-brand-item text-zinc-400'
                    }`}
                  >
                    Contraseña
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthType('privateKey')}
                    className={`px-2.5 py-1.5 text-xs rounded border flex items-center justify-center gap-1 cursor-pointer ${
                      authType === 'privateKey'
                        ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-400'
                        : 'border-brand-border bg-brand-dark hover:bg-brand-item text-zinc-400'
                    }`}
                  >
                    Clave Privada
                  </button>
                </div>
              </div>

              {authType === 'password' ? (
                <div>
                  <label className="block text-[10px] text-zinc-400 font-mono mb-1">Password SSH</label>
                  <input
                    type="password"
                    placeholder="••••••••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-brand-dark border border-brand-border rounded px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-brand-border-light transition-colors"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-[10px] text-zinc-400 font-mono mb-1">Clave RSA Privada PEM</label>
                  <textarea
                    placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;..."
                    rows={4}
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    className="w-full bg-brand-dark border border-brand-border rounded px-2.5 py-1.5 text-xs font-mono text-zinc-350 outline-none focus:border-brand-border-light resize-none transition-colors"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-bold transition-all mt-2 cursor-pointer"
              >
                {loading ? 'Cargando Pool...' : 'Conectar y Guardar'}
              </button>
            </motion.form>
          ) : (
            <motion.div
              key="server-list"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-2 mt-1"
            >
              {servers.length === 0 && (
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
                    onClick={() => setShowAddForm(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-emerald-600 hover:bg-emerald-500 text-white transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" /> Agregar servidor
                  </button>
                </div>
              )}
              {servers.map((serv) => {
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
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded ${
                        isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-brand-bar text-zinc-400'
                      }`}>
                        <Server className="w-4.5 h-4.5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-bold ${isActive ? 'text-emerald-405' : 'text-zinc-200'}`}>{serv.name}</span>
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            serv.status === 'online' ? 'bg-emerald-400' : 'bg-[#404040]'
                          }`} />
                        </div>
                        <span className="text-[10px] text-brand-text-muted font-mono leading-tight block mt-0.5">
                          {serv.username}@{serv.host}:{serv.port}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {isActive && serv.status === 'online' && (
                        <span className="text-[9px] uppercase tracking-wider font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 font-mono">
                          Activo
                        </span>
                      )}
                      {isActive && serv.status === 'connecting' && (
                        <span className="text-[9px] uppercase tracking-wider font-bold text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 font-mono">
                          Conectando
                        </span>
                      )}
                      {isActive && serv.status === 'offline' && (
                        <span className="text-[9px] uppercase tracking-wider font-bold text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded border border-red-500/20 font-mono">
                          Offline
                        </span>
                      )}
                      {serv.authType === 'privateKey' && (
                        <Key className="w-3.5 h-3.5 text-zinc-500 group-hover:text-amber-400 transition-colors" />
                      )}

                      {/* Connect / Disconnect button */}
                      {busyId === serv.id ? (
                        <span className="p-1 text-zinc-500">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        </span>
                      ) : serv.status === 'online' ? (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            setBusyId(serv.id);
                            try { await onDisconnectServer(serv.id); } finally { setBusyId(null); }
                          }}
                          title="Desconectar"
                          className="p-1 rounded border border-brand-border hover:border-amber-400 hover:text-amber-300 text-zinc-500 transition-colors cursor-pointer"
                        >
                          <WifiOff className="w-3 h-3" />
                        </button>
                      ) : (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            setBusyId(serv.id);
                            try { await onConnectServer(serv.id); } finally { setBusyId(null); }
                          }}
                          title="Conectar"
                          className="p-1 rounded border border-brand-border hover:border-emerald-400 hover:text-emerald-300 text-zinc-500 transition-colors cursor-pointer"
                        >
                          <Wifi className="w-3 h-3" />
                        </button>
                      )}

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteServer(serv.id);
                        }}
                        title="Eliminar servidor"
                        className="p-1 rounded border border-brand-border hover:border-red-400 hover:text-red-300 text-zinc-500 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}

            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
