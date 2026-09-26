/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * In-app OpenRouter API key setup — lets the user paste a key and have it
 * validated + persisted to .env immediately, with no restart and no manual
 * file editing. Opened either from the header button or from Electron's
 * first-run wizard (which dispatches a window 'open-api-key-setup' event).
 */

import { useEffect, useState } from 'react';
import { KeyRound, Eye, EyeOff, Loader2, CheckCircle2, AlertCircle, X, Sparkles } from 'lucide-react';

interface ApiKeySetupModalProps {
  open: boolean;
  currentModel: string | null;
  onClose: () => void;
  onConfigured: () => void;
}

export default function ApiKeySetupModal({ open, currentModel, onClose, onConfigured }: ApiKeySetupModalProps) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(currentModel || 'openrouter/free');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Reset the form state each time the modal is (re)opened.
  useEffect(() => {
    if (open) {
      setApiKey('');
      setModel(currentModel || 'openrouter/free');
      setShowKey(false);
      setError('');
      setSuccess('');
    }
  }, [open, currentModel]);

  if (!open) return null;

  const handleSave = async () => {
    if (!apiKey.trim()) { setError('Ingresa tu clave API de OpenRouter.'); return; }
    setTesting(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch('/api/openrouter/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim(), model: model.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo validar la clave.');
      setSuccess('¡Clave validada y guardada! La IA ya está activa.');
      onConfigured();
      setTimeout(() => onClose(), 1500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-[#0d0d0d] border border-emerald-700/30 rounded-2xl shadow-2xl p-6 space-y-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg flex-shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-100 font-sans">Configurar OpenRouter</h3>
              <p className="text-[10px] text-zinc-500 font-sans">Habilita el agente de IA con tu propia clave</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[11px] text-zinc-500 leading-relaxed font-sans">
          Obtén una clave gratis en{' '}
          <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">
            openrouter.ai/keys
          </a>
          . Se valida contra OpenRouter antes de guardarse y queda activa de inmediato, sin reiniciar la aplicación.
        </p>

        <div>
          <label className="block text-[10px] text-zinc-500 font-mono mb-1.5">Clave API</label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              placeholder="sk-or-v1-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !testing) handleSave(); }}
              className="w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 pr-9 text-xs text-zinc-200 outline-none focus:border-emerald-500/50 transition-colors font-mono"
              autoFocus
            />
            <button type="button" onClick={() => setShowKey(!showKey)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 cursor-pointer">
              {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-[10px] text-zinc-500 font-mono mb-1.5">Modelo (opcional)</label>
          <input
            type="text"
            placeholder="openrouter/free"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-emerald-500/50 transition-colors font-mono"
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 p-2.5 bg-red-950/30 border border-red-900/40 text-red-300 text-[11px] rounded-lg">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="flex items-start gap-2 p-2.5 bg-emerald-950/30 border border-emerald-900/40 text-emerald-300 text-[11px] rounded-lg">
            <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>{success}</span>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={testing || !!success}
            className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900 disabled:text-emerald-700 text-white text-xs font-bold rounded-lg cursor-pointer transition-colors"
          >
            {testing ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Validando...</> : <><KeyRound className="w-3.5 h-3.5" /> Probar y guardar</>}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2.5 bg-[#111] border border-[#222] text-zinc-400 hover:text-zinc-200 text-xs font-bold rounded-lg cursor-pointer transition-colors"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
