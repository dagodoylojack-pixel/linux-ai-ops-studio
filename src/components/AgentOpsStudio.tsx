/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { ServerConnection, AgentRole, AIControlMode, AIChatMessage, AIActionStep } from '../types';
import {
  Cpu,
  Bot,
  User,
  ShieldAlert,
  HelpCircle,
  Play,
  RotateCcw,
  CheckCircle,
  XCircle,
  Terminal,
  AlertTriangle,
  Loader,
  Zap,
} from 'lucide-react';

// ── Agent roster ──────────────────────────────────────────────────────────────

const AGENT_LIST: { role: AgentRole; name: string; desc: string; capabilities: string[] }[] = [
  {
    role: 'SysAdmin',
    name: 'SysAdmin Agent',
    desc: 'Administración de disco, CPU, procesos de núcleo, servicios de sistema central (systemd).',
    capabilities: ['Instalar paquetes', 'Reiniciar servicios', 'Configurar cron', 'Inspeccionar swap'],
  },
  {
    role: 'Security',
    name: 'Security Auditor',
    desc: 'Búsqueda de vulnerabilidades, auditoría de puertos SSH expuestos, configuraciones de firewalls (UFW/iptables).',
    capabilities: ['Claves SSH', 'Análisis de puertos', 'Instalar fail2ban', 'Bloquear IPs maliciosas'],
  },
  {
    role: 'DevOps',
    name: 'DevOps Automator',
    desc: 'Despliegues continuos, orquestación, estructuración e integraciones con Ansible/git.',
    capabilities: ['Clonar repositorios', 'Actualizar dependencias', 'Verificar configs', 'Rollbacks'],
  },
  {
    role: 'Docker',
    name: 'Docker Specialist',
    desc: 'Gestión local y remota de sockets Docker, Compose, volúmenes de almacenamiento aislado y Portainer.',
    capabilities: ['Levantar containers', 'Inspeccionar Compose', 'Purgar imágenes', 'Limpiar logs de Docker'],
  },
  {
    role: 'Monitoring',
    name: 'Monitoring & Alerting',
    desc: 'Inspecciona logs de fallas críticas en tiempo real, fugas de memoria y picos de red.',
    capabilities: ['Live-tail logs', 'Filtros inteligentes', 'Diagnostico de CPU', 'Reportes automáticos'],
  },
];

// ── Mode metadata ─────────────────────────────────────────────────────────────

const MODE_META: Record<AIControlMode, { label: string; color: string; activeColor: string; icon: React.ReactNode; hint: string }> = {
  suggestion: {
    label: 'Sugerencia',
    color: 'text-brand-text-muted hover:text-blue-300',
    activeColor: 'bg-blue-900/30 text-blue-400 border border-blue-700/30',
    icon: React.createElement(HelpCircle, { className: 'w-3 h-3' }),
    hint: 'El agente siempre entra en modo plan. Muestra los pasos pero nunca ejecuta nada sin que cambies de modo.',
  },
  'semi-autonomous': {
    label: 'Semi-Autónomo',
    color: 'text-brand-text-muted hover:text-amber-300',
    activeColor: 'bg-amber-900/20 text-amber-400 border border-amber-700/20',
    icon: React.createElement(Zap, { className: 'w-3 h-3' }),
    hint: 'Ejecuta pasos de bajo riesgo automáticamente. Los de riesgo medio/alto requieren confirmación individual.',
  },
  'fully-autonomous': {
    label: 'Totalmente Autónomo',
    color: 'text-brand-text-muted hover:text-red-300',
    activeColor: 'bg-red-900/20 text-red-400 border border-red-700/20',
    icon: React.createElement(Bot, { className: 'w-3 h-3' }),
    hint: 'Ejecuta todos los pasos sin intervención. En error consulta la IA y repara. Máx. 6 reintentos por paso antes de abandonar.',
  },
};

const MAX_AUTO_RETRIES = 6;

// ── Welcome message ───────────────────────────────────────────────────────────

const welcomeMessage: AIChatMessage = {
  id: 'welcome',
  sender: 'assistant',
  text: '¡Hola! Soy tu Copiloto Autónomo. Selecciona un modo de control arriba y pídeme una tarea.',
  timestamp: new Date().toLocaleTimeString(),
  suggestedCommands: [
    'Instala Docker y configura Portainer',
    'Audita la seguridad SSH de este nodo y aplica hardening',
    'Verifica los logs de error de Nginx y optimiza el puerto 8080',
    'Analiza qué proceso consume más memoria RAM',
  ],
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface AgentOpsStudioProps {
  server: ServerConnection | null;
  onExecuteCommand: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  onRefreshTelemetry: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AgentOpsStudio({ server, onExecuteCommand, onRefreshTelemetry }: AgentOpsStudioProps) {
  const [activeRole, setActiveRole]       = useState<AgentRole | null>(null);
  const [pendingRole, setPendingRole]     = useState<typeof AGENT_LIST[0] | null>(null);
  const [controlMode, setControlMode]     = useState<AIControlMode>('semi-autonomous');
  const [prompt, setPrompt]               = useState('');
  const [chatMessages, setChatMessages]   = useState<AIChatMessage[]>([welcomeMessage]);
  const [loadingAI, setLoadingAI]         = useState(false);
  const [isRunningAuto, setIsRunningAuto] = useState(false);
  const [isRunningSemi, setIsRunningSemi] = useState(false);
  const [autoStatus, setAutoStatus]       = useState('');   // current step description shown in banner
  const [expandedStep, setExpandedStep]   = useState<string | null>(null);

  // Ref so async functions always see the latest server
  const serverRef = useRef(server);
  serverRef.current = server;

  // Input is blocked while any auto-execution is in progress
  const isExecuting = isRunningAuto || isRunningSemi;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const addSystemMsg = (text: string) => {
    setChatMessages(prev => [...prev, {
      id: Math.random().toString(),
      sender: 'system',
      text,
      timestamp: new Date().toLocaleTimeString(),
    }]);
  };

  const updateSteps = (msgId: string, steps: AIActionStep[]) => {
    setChatMessages(prev => prev.map(m => m.id === msgId ? { ...m, steps } : m));
  };

  // Prominent final result message (green = ok, red = fail)
  const addFinalMsg = (ok: boolean, text: string) => {
    setChatMessages(prev => [...prev, {
      id: Math.random().toString(),
      sender: ok ? 'assistant' : 'system',
      text,
      timestamp: new Date().toLocaleTimeString(),
    }]);
  };

  // ── Mode: SUGGESTION — only plans, never executes ──────────────────────────
  // (no extra function needed — plan is shown read-only in JSX)

  // ── Mode: SEMI-AUTONOMOUS — auto-execute low-risk, confirm medium/high ─────

  const executeSemiAutoSteps = async (msgId: string, initialSteps: AIActionStep[]) => {
    setIsRunningSemi(true);
    const steps = initialSteps.map(s => ({ ...s }));
    let anyFailed = false;
    const lowRisk = steps.filter(s => s.risk === 'low');

    for (let i = 0; i < steps.length; i++) {
      if (steps[i].risk !== 'low') continue; // leave medium/high for manual click

      setAutoStatus(`Ejecutando: ${steps[i].title}`);
      steps[i] = { ...steps[i], status: 'running' };
      updateSteps(msgId, [...steps]);

      try {
        const res = await onExecuteCommand(steps[i].command);
        const ok = res.exitCode === 0;
        if (!ok) anyFailed = true;
        steps[i] = {
          ...steps[i],
          status: ok ? 'success' : 'failed',
          stdout: res.stdout,
          stderr: res.stderr,
          exitCode: res.exitCode,
        };
      } catch (err: any) {
        anyFailed = true;
        steps[i] = { ...steps[i], status: 'failed', stderr: err.message };
      }

      updateSteps(msgId, [...steps]);
      onRefreshTelemetry();
    }

    const pendingHigh = steps.filter(s => s.risk !== 'low' && s.status === 'pending').length;
    setAutoStatus('');
    setIsRunningSemi(false);

    if (lowRisk.length > 0) {
      if (pendingHigh > 0) {
        addFinalMsg(!anyFailed,
          anyFailed
            ? `⚠ Pasos automáticos ejecutados con errores. ${pendingHigh} paso(s) de riesgo medio/alto esperan tu confirmación arriba.`
            : `✅ ${lowRisk.length} paso(s) de bajo riesgo completados. ${pendingHigh} paso(s) de riesgo medio/alto esperan tu confirmación arriba.`
        );
      } else {
        addFinalMsg(!anyFailed,
          anyFailed
            ? '⚠ Ejecución semi-autónoma terminada con errores. Revisa los pasos fallidos.'
            : '✅ Todos los pasos automáticos completados exitosamente.'
        );
      }
    }
  };

  // ── Mode: FULLY-AUTONOMOUS — execute all, retry on error, consult AI ───────

  const executeFullyAutoSteps = async (msgId: string, initialSteps: AIActionStep[]) => {
    const steps = initialSteps.map(s => ({ ...s, retryCount: 0 }));

    for (let i = 0; i < steps.length; i++) {
      let stepDone = false;

      while (!stepDone) {
        const attempts = (steps[i].retryCount ?? 0) + 1;
        setAutoStatus(`Paso ${i + 1}/${steps.length}: ${steps[i].title}${attempts > 1 ? ` (intento ${attempts}/${MAX_AUTO_RETRIES})` : ''}`);
        steps[i] = { ...steps[i], status: 'running', retryCount: attempts - 1 };
        updateSteps(msgId, [...steps]);

        let res: { stdout: string; stderr: string; exitCode: number };
        try {
          res = await onExecuteCommand(steps[i].command);
        } catch (err: any) {
          res = { stdout: '', stderr: err.message, exitCode: 255 };
        }

        if (res.exitCode === 0) {
          // ✅ Success
          steps[i] = { ...steps[i], status: 'success', stdout: res.stdout, stderr: res.stderr, exitCode: 0 };
          updateSteps(msgId, [...steps]);
          stepDone = true;
          onRefreshTelemetry();
        } else {
          // ❌ Failure
          steps[i] = { ...steps[i], status: 'failed', stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, retryCount: attempts };
          updateSteps(msgId, [...steps]);

          if (attempts >= MAX_AUTO_RETRIES) {
            // Exceeded retry limit — abort entire task
            setAutoStatus('');
            setIsRunningAuto(false);
            addFinalMsg(false,
              `⛔ TAREA NO COMPLETADA\n\nEl paso "${steps[i].title}" falló ${MAX_AUTO_RETRIES} veces consecutivas sin éxito.\n\nEl agente abandonó el bucle de reintento. Por favor intervenga manualmente o reformule la petición con más contexto.`
            );
            return;
          }

          // Consult AI for an alternative command
          addSystemMsg(`🔄 Intento ${attempts}/${MAX_AUTO_RETRIES} fallido en "${steps[i].title}". Consultando IA para alternativa...`);

          try {
            const repairRes = await fetch('/api/openrouter/run-agent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                serverId: serverRef.current?.id,
                role: activeRole ?? 'SysAdmin',
                prompt: `El comando "${steps[i].command}" falló con el error: "${res.stderr || res.stdout}". El objetivo es: "${steps[i].title} — ${steps[i].description}". Proporciona un comando alternativo que logre el mismo objetivo sin este error.`,
                controlMode: 'fully-autonomous',
              }),
            });

            const repairData = await repairRes.json();
            const altCmd: string | undefined = repairData.steps?.[0]?.command;

            if (altCmd && altCmd !== steps[i].command) {
              addSystemMsg(`🔧 Alternativa (intento ${attempts + 1}): \`${altCmd}\``);
              steps[i] = { ...steps[i], command: altCmd, status: 'pending', stdout: undefined, stderr: undefined };
              updateSteps(msgId, [...steps]);
            } else {
              setAutoStatus('');
              setIsRunningAuto(false);
              addFinalMsg(false, `⛔ TAREA NO COMPLETADA\n\nLa IA no encontró una alternativa para "${steps[i].title}". La tarea se detiene.`);
              return;
            }
          } catch (repairErr: any) {
            setAutoStatus('');
            setIsRunningAuto(false);
            addFinalMsg(false, `⛔ TAREA NO COMPLETADA\n\nError consultando la IA: ${repairErr.message}. La tarea se detiene.`);
            return;
          }
        }
      }
    }

    const allOk = steps.every(s => s.status === 'success');
    const failedSteps = steps.filter(s => s.status === 'failed').map(s => `• ${s.title}`).join('\n');
    setAutoStatus('');
    setIsRunningAuto(false);
    addFinalMsg(allOk,
      allOk
        ? `✅ TAREA COMPLETADA\n\nTodos los pasos se ejecutaron exitosamente en modo totalmente autónomo.`
        : `⚠ EJECUCIÓN TERMINADA CON ERRORES\n\nAlgunos pasos no se completaron:\n${failedSteps}\n\nRevisa los detalles en el plan arriba.`
    );
  };

  // ── Submit handler ───────────────────────────────────────────────────────────

  const handleChatSubmit = async (textToSend: string) => {
    if (!textToSend.trim() || !server) return;

    // Check for pending inline confirmation (yes/no answer)
    const pendingMsg = chatMessages.findLast(m => m.requiresConfirmation && m.confirmationState === 'pending');
    if (pendingMsg) {
      const ans = textToSend.trim().toLowerCase();
      if (/^s(i|í|ip)?$|^confirm|^yes$|^ok$/.test(ans)) { handleApprovePlan(pendingMsg.id); return; }
      if (/^n(o)?$|^cancel|^no gracias$/.test(ans))       { handleDeclinePlan(pendingMsg.id);  return; }
    }

    const userMsg: AIChatMessage = {
      id: Math.random().toString(),
      sender: 'user',
      text: textToSend,
      timestamp: new Date().toLocaleTimeString(),
    };
    setChatMessages(prev => [...prev, userMsg]);
    setPrompt('');
    setLoadingAI(true);

    let pendingAutoMode: AIControlMode | null = null;
    let pendingMsgId = '';
    let pendingSteps: AIActionStep[] = [];

    try {
      const response = await fetch('/api/openrouter/run-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server.id, role: activeRole ?? 'SysAdmin', prompt: textToSend, controlMode }),
      });

      const data = await response.json();

      if (!response.ok) {
        addSystemMsg(`⚠ ${data.error || 'Error desconocido al contactar el agente.'}`);
        return;
      }

      // Safety net: if the server couldn't parse AI JSON, explanation may contain the raw JSON string.
      // Re-parse it client-side so steps are extracted correctly.
      let rawExplanation: string = data.explanation || '';
      let rawSteps: any[] = data.steps || [];
      if (rawSteps.length === 0 && rawExplanation.trim().startsWith('{')) {
        try {
          const reparsed = JSON.parse(rawExplanation.trim());
          if (reparsed.explanation) rawExplanation = reparsed.explanation;
          if (Array.isArray(reparsed.steps) && reparsed.steps.length > 0) rawSteps = reparsed.steps;
        } catch { /* leave as-is */ }
      }

      const formattedSteps: AIActionStep[] = rawSteps.map((s: any) => ({ ...s, status: 'pending', retryCount: 0 }));
      const modeWhenCreated = controlMode;

      // Build context-aware intro text
      let introText = rawExplanation || 'Análisis completado.';
      if (controlMode === 'suggestion') {
        introText += formattedSteps.length > 0
          ? '\n\nEste es el plan sugerido. No se ejecutará nada. Cambia al modo Semi-Autónomo o Totalmente Autónomo para ejecutarlo.'
          : '';
      } else if (controlMode === 'semi-autonomous') {
        const lowCount  = formattedSteps.filter(s => s.risk === 'low').length;
        const highCount = formattedSteps.filter(s => s.risk !== 'low').length;
        introText += formattedSteps.length > 0
          ? `\n\nPlan listo (${formattedSteps.length} pasos). ${lowCount > 0 ? `${lowCount} paso(s) de bajo riesgo se ejecutarán automáticamente.` : ''} ${highCount > 0 ? `${highCount} paso(s) de riesgo medio/alto esperan tu confirmación.` : ''}`
          : '';
      } else {
        introText += formattedSteps.length > 0
          ? `\n\nIniciando ejecución autónoma (${formattedSteps.length} pasos). El agente resolverá errores automáticamente — máx. ${MAX_AUTO_RETRIES} reintentos por paso.`
          : '';
      }

      const msgId = Math.random().toString();
      const assistantMsg: AIChatMessage = {
        id: msgId,
        sender: 'assistant',
        text: introText,
        timestamp: new Date().toLocaleTimeString(),
        steps: formattedSteps,
        reportSummary: data.reportSummary,
        requiresConfirmation: false,
        modeWhenCreated,
      };

      setChatMessages(prev => [...prev, assistantMsg]);

      if (formattedSteps.length > 0 && controlMode !== 'suggestion') {
        pendingAutoMode = controlMode;
        pendingMsgId   = msgId;
        pendingSteps   = formattedSteps;
      }

    } catch (err: any) {
      addSystemMsg(`Error al conectar con OpenRouter: ${err.message}`);
    } finally {
      setLoadingAI(false);
    }

    // Start execution after AI spinner stops (fire & forget so UI stays responsive)
    if (pendingAutoMode === 'semi-autonomous') {
      executeSemiAutoSteps(pendingMsgId, pendingSteps);
    } else if (pendingAutoMode === 'fully-autonomous') {
      setIsRunningAuto(true);
      executeFullyAutoSteps(pendingMsgId, pendingSteps);
    }
  };

  // ── Plan approval (kept for legacy / suggestion override) ──────────────────

  const handleApprovePlan = async (messageId: string) => {
    setChatMessages(prev => prev.map(m => m.id === messageId ? { ...m, confirmationState: 'confirmed', requiresConfirmation: false } : m));
    const msg = chatMessages.find(m => m.id === messageId);
    if (!msg?.steps?.length) return;
    // Run as semi-autonomous on confirmation
    await executeSemiAutoSteps(messageId, msg.steps);
  };

  const handleDeclinePlan = (messageId: string) => {
    setChatMessages(prev => prev.map(m => m.id === messageId ? { ...m, confirmationState: 'declined', requiresConfirmation: false } : m));
    addSystemMsg('Plan cancelado. Dime qué quieres hacer.');
  };

  // ── Per-step manual execution (semi-auto medium/high risk, or suggestion override) ──

  const executeSingleStep = async (msgId: string, stepId: string) => {
    let cmd = '';
    setChatMessages(prev => prev.map(m => {
      if (m.id !== msgId || !m.steps) return m;
      const updated = m.steps.map(s => {
        if (s.id === stepId) { cmd = s.command; return { ...s, status: 'running' as const }; }
        return s;
      });
      return { ...m, steps: updated };
    }));

    try {
      const res = await onExecuteCommand(cmd);
      setChatMessages(prev => prev.map(m => {
        if (m.id !== msgId || !m.steps) return m;
        return { ...m, steps: m.steps.map(s => s.id === stepId
          ? { ...s, status: res.exitCode === 0 ? 'success' as const : 'failed' as const, stdout: res.stdout, stderr: res.stderr }
          : s) };
      }));
      onRefreshTelemetry();
    } catch (err: any) {
      setChatMessages(prev => prev.map(m => {
        if (m.id !== msgId || !m.steps) return m;
        return { ...m, steps: m.steps.map(s => s.id === stepId ? { ...s, status: 'failed' as const, stderr: err.message } : s) };
      }));
    }
  };

  const rejectSingleStep = (msgId: string, stepId: string) => {
    setChatMessages(prev => prev.map(m => {
      if (m.id !== msgId || !m.steps) return m;
      return { ...m, steps: m.steps.map(s => s.id === stepId ? { ...s, status: 'rejected' as const } : s) };
    }));
  };

  const handleClearChat = () => { setChatMessages([welcomeMessage]); setExpandedStep(null); setPrompt(''); };

  // ── Role switch with confirmation ────────────────────────────────────────────

  // Default prompt fired automatically when switching to a new agent role
  const ROLE_AUTO_PROMPTS: Partial<Record<AgentRole, string>> = {
    SysAdmin:   'Realiza un diagnóstico completo del sistema: CPU, RAM, disco, servicios activos y procesos críticos.',
    Security:   'Realiza una auditoría de seguridad completa: puertos expuestos, configuración SSH, usuarios privilegiados y logs de acceso.',
    DevOps:     'Revisa el estado del entorno DevOps: repositorios, pipelines activos, configuraciones y servicios de despliegue.',
    Docker:     'Lista todos los contenedores Docker, revisa su estado, uso de recursos e identifica posibles problemas.',
    Monitoring: 'Analiza los logs de error críticos, picos de CPU/RAM y genera un reporte de alertas activas del sistema.',
  };

  const handleRoleClick = (ag: typeof AGENT_LIST[0]) => {
    if (ag.role === activeRole) return; // already selected — no modal
    setPendingRole(ag);
  };

  const confirmRoleSwitch = () => {
    if (!pendingRole || isExecuting) return;
    setActiveRole(pendingRole.role);
    const autoPrompt = ROLE_AUTO_PROMPTS[pendingRole.role];
    const roleName = pendingRole.name;
    setPendingRole(null);
    // Add a system greeting from the new agent, then fire the auto-prompt
    setChatMessages(prev => [...prev, {
      id: Math.random().toString(),
      sender: 'assistant',
      text: `Soy el ${roleName}. Iniciando diagnóstico inicial del servidor...`,
      timestamp: new Date().toLocaleTimeString(),
    }]);
    if (autoPrompt) {
      setTimeout(() => handleChatSubmit(autoPrompt), 150);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  const meta = MODE_META[controlMode];

  return (
    <div id="agent-ops-studio" className="relative bg-brand-bg border border-brand-border rounded-xl p-4 flex flex-col h-full shadow-2xl overflow-hidden">

      {/* ── Header ── */}
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3 border-b border-brand-border pb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-xs font-bold text-brand-text-muted uppercase tracking-widest font-display">Multiagente Copilot</h2>
            <p className="text-[10px] text-zinc-500 font-sans">IA asistida — elige el nivel de autonomía</p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5 items-end">
          {/* Mode selector */}
          <div className="flex items-center gap-1 bg-[#050505]/40 p-1 border border-brand-border rounded">
            {(Object.keys(MODE_META) as AIControlMode[]).map((mode) => {
              const m = MODE_META[mode];
              return (
                <button
                  key={mode}
                  onClick={() => setControlMode(mode)}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold rounded font-sans transition-all cursor-pointer ${
                    controlMode === mode ? m.activeColor : m.color
                  }`}
                >
                  {m.icon} {m.label}
                </button>
              );
            })}
          </div>
          {/* Mode description hint */}
          <p className="text-[9px] text-brand-text-dim font-sans text-right max-w-[340px] leading-relaxed">{meta.hint}</p>
        </div>
      </div>

      {/* ── Agent tray ── */}
      <div className="flex gap-2.5 py-2.5 overflow-x-auto flex-shrink-0 border-b border-brand-border no-scrollbar select-none">
        {AGENT_LIST.map((ag) => (
          <button
            key={ag.role}
            onClick={() => handleRoleClick(ag)}
            disabled={isExecuting}
            title={activeRole === ag.role ? ag.desc : `Cambiar a ${ag.name}`}
            className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-bold font-sans transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              activeRole === ag.role
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-brand-dark border border-brand-border text-brand-text-muted hover:border-emerald-500/20 hover:text-emerald-300 hover:border-emerald-500/30'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" /> {ag.name}
          </button>
        ))}
      </div>

      {/* ── Active agent + clear ── */}
      <div className="flex items-center justify-between gap-2 py-2 flex-shrink-0">
        <div className="p-2 bg-[#050505]/30 border border-brand-border text-[10px] text-brand-text-muted font-sans rounded flex-1 min-w-0">
          {activeRole
            ? <><strong>Rol activo:</strong> {AGENT_LIST.find(a => a.role === activeRole)?.desc}</>
            : <span className="text-zinc-600">Selecciona un agente arriba para comenzar.</span>
          }
        </div>
        <button
          onClick={handleClearChat}
          disabled={isExecuting}
          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-brand-border bg-brand-dark text-zinc-300 hover:bg-[#111] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Limpiar
        </button>
      </div>

      {/* ── Execution status banner ── */}
      {isExecuting && (
        <div className={`flex items-center gap-2 px-3 py-2 border rounded text-[11px] font-semibold flex-shrink-0 mb-1 ${
          isRunningAuto
            ? 'bg-red-950/20 border-red-900/30 text-red-400'
            : 'bg-amber-950/20 border-amber-900/30 text-amber-400'
        }`}>
          <Loader className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
          <span className="truncate">
            {autoStatus || (isRunningAuto ? 'Modo Totalmente Autónomo en ejecución...' : 'Ejecutando pasos automáticos...')}
          </span>
          <span className="text-[9px] ml-auto flex-shrink-0 opacity-70">🔒 Consola bloqueada</span>
        </div>
      )}

      {/* ── Chat ── */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4 min-h-[150px] bg-[#050505]/20 rounded border border-brand-border select-text">
        {chatMessages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 max-w-[92%] ${msg.sender === 'user' ? 'ml-auto flex-row-reverse' : 'mr-auto'}`}>

            {/* Avatar */}
            <div className={`p-2 rounded flex-shrink-0 h-fit ${
              msg.sender === 'user'   ? 'bg-brand-bar text-zinc-100 border border-brand-border' :
              msg.sender === 'system' ? 'bg-amber-950/40 text-amber-500 border border-amber-900/30' :
                                       'bg-emerald-500/10 text-emerald-400'
            }`}>
              {msg.sender === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
            </div>

            <div className="space-y-2 min-w-0">
              {/* Bubble */}
              <div className={`p-3 rounded text-xs font-sans leading-relaxed ${
                msg.sender === 'user'   ? 'bg-brand-panel text-[#E5E7EB] border border-brand-border' :
                msg.sender === 'system' ? 'bg-amber-950/10 text-amber-300 border border-amber-900/20 italic' :
                                         'bg-brand-bar/40 text-[#D1D5DB] border border-brand-border'
              }`}>
                <p className="whitespace-pre-wrap">{msg.text}</p>

                {/* Suggested chips */}
                {msg.suggestedCommands && msg.suggestedCommands.length > 0 && (
                  <div className="flex flex-col sm:flex-row flex-wrap gap-1.5 mt-3">
                    {msg.suggestedCommands.map((chip, i) => (
                      <button key={i} onClick={() => { setPrompt(chip); handleChatSubmit(chip); }}
                        className="text-left px-2 py-1.5 bg-[#050505] border border-brand-border hover:border-brand-border-light text-brand-text-muted hover:text-zinc-200 text-[10px] rounded transition-colors cursor-pointer w-full sm:w-auto">
                        {chip}
                      </button>
                    ))}
                  </div>
                )}

                {/* Legacy global confirm buttons (kept for backwards compat) */}
                {msg.requiresConfirmation && msg.confirmationState === 'pending' && (
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => handleApprovePlan(msg.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-bold transition-all">
                      <CheckCircle className="w-3.5 h-3.5" /> Confirmar plan
                    </button>
                    <button onClick={() => handleDeclinePlan(msg.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded text-xs font-bold transition-all">
                      <XCircle className="w-3.5 h-3.5" /> No aplicar
                    </button>
                  </div>
                )}
              </div>

              {/* ── Steps panel ── */}
              {msg.steps && msg.steps.length > 0 && (
                <div className="bg-brand-panel rounded p-3 border border-brand-border space-y-3">
                  {/* Plan header with mode badge */}
                  <div className="flex items-center justify-between">
                    <h4 className="text-[10px] font-bold uppercase tracking-wider text-brand-text-muted font-mono">
                      {msg.modeWhenCreated === 'suggestion' ? '📋 Plan Sugerido (no se ejecuta)' :
                       msg.modeWhenCreated === 'semi-autonomous' ? '⚡ Plan Semi-Autónomo' :
                       msg.modeWhenCreated === 'fully-autonomous' ? '🤖 Ejecución Autónoma' :
                       'Secuencia del Plan'}
                    </h4>
                    {msg.modeWhenCreated === 'suggestion' && (
                      <span className="text-[9px] text-blue-400 bg-blue-950/30 px-1.5 py-0.5 rounded border border-blue-800/30">
                        Solo lectura
                      </span>
                    )}
                  </div>

                  <div className="space-y-2">
                    {msg.steps.map((st) => {
                      const isHigh = st.risk === 'high';
                      const isMed  = st.risk === 'medium';
                      const statusColors: Record<string, string> = {
                        pending:  'border-[#333] text-zinc-400',
                        running:  'border-amber-500 text-amber-400 animate-pulse',
                        success:  'border-emerald-400 text-emerald-400',
                        failed:   'border-red-500 text-red-400',
                        rejected: 'border-brand-border text-zinc-600 line-through',
                      };

                      return (
                        <div key={st.id} className={`border-l-2 pl-3 py-1 space-y-1.5 ${statusColors[st.status] || 'border-brand-border'}`}>
                          {/* Title + risk badge */}
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-bold text-xs text-zinc-200">{st.title}</span>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {(st.retryCount ?? 0) > 0 && (
                                <span className="text-[9px] text-amber-400 bg-amber-950/30 px-1 py-0.5 rounded border border-amber-900/20">
                                  intento {st.retryCount}/{MAX_AUTO_RETRIES}
                                </span>
                              )}
                              <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase font-bold font-mono ${
                                isHigh ? 'bg-red-950/60 border border-red-900/40 text-red-400' :
                                isMed  ? 'bg-amber-950/40 border border-amber-900/30 text-amber-400' :
                                         'bg-emerald-950/50 text-emerald-400'
                              }`}>
                                {st.risk} risk
                              </span>
                            </div>
                          </div>

                          <p className="text-[11px] text-brand-text-muted leading-relaxed">{st.description}</p>

                          {/* Command box */}
                          <div className="bg-[#050505] border border-brand-border px-2 py-1.5 rounded text-[10px] font-mono text-zinc-300 truncate">
                            {st.command}
                          </div>

                          {/* ── Action controls — differ by mode ── */}
                          {st.status === 'pending' && (
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">

                              {/* SUGGESTION: read-only notice */}
                              {msg.modeWhenCreated === 'suggestion' && (
                                <span className="text-[10px] text-blue-400 italic flex items-center gap-1">
                                  <HelpCircle className="w-3 h-3" /> Solo sugerencia
                                </span>
                              )}

                              {/* SEMI-AUTO + low risk: auto-executing indicator */}
                              {msg.modeWhenCreated === 'semi-autonomous' && st.risk === 'low' && (
                                <span className="text-[10px] text-emerald-400 flex items-center gap-1 animate-pulse">
                                  <Zap className="w-3 h-3" /> Ejecutando automáticamente...
                                </span>
                              )}

                              {/* SEMI-AUTO + medium/high risk: manual confirm required */}
                              {msg.modeWhenCreated === 'semi-autonomous' && st.risk !== 'low' && (
                                <>
                                  <span className={`text-[10px] px-2 py-1 rounded border flex items-center gap-1 font-bold flex-shrink-0 ${
                                    isHigh ? 'text-red-400 bg-red-950/20 border-red-900/30' : 'text-amber-400 bg-amber-950/20 border-amber-900/30'
                                  }`}>
                                    <ShieldAlert className="w-3 h-3" />
                                    {isHigh ? 'Alto riesgo — confirmar' : 'Riesgo medio — confirmar'}
                                  </span>
                                  <button onClick={() => executeSingleStep(msg.id, st.id)}
                                    className="flex items-center gap-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[10px] font-bold cursor-pointer">
                                    <Play className="w-3 h-3" /> Ejecutar
                                  </button>
                                  <button onClick={() => rejectSingleStep(msg.id, st.id)}
                                    className="px-2.5 py-1 bg-brand-dark border border-brand-border text-brand-text-muted rounded text-[10px] cursor-pointer hover:text-zinc-200">
                                    Omitir
                                  </button>
                                </>
                              )}

                              {/* FULLY-AUTO: running autonomously */}
                              {msg.modeWhenCreated === 'fully-autonomous' && (
                                <span className="text-[10px] text-red-400 flex items-center gap-1">
                                  <Loader className="w-3 h-3 animate-spin" /> En cola de ejecución autónoma
                                </span>
                              )}

                              {/* NO MODE STORED (legacy messages): classic buttons */}
                              {!msg.modeWhenCreated && !msg.requiresConfirmation && (
                                <>
                                  {isHigh && (
                                    <span className="text-[10px] text-red-400 bg-red-950/10 px-2 py-1 rounded border border-red-900/20 font-bold flex items-center gap-1">
                                      <AlertTriangle className="w-3 h-3" /> Alto riesgo
                                    </span>
                                  )}
                                  <button onClick={() => executeSingleStep(msg.id, st.id)}
                                    className="flex items-center gap-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[10px] font-bold cursor-pointer">
                                    <Play className="w-3 h-3" /> Ejecutar
                                  </button>
                                  <button onClick={() => rejectSingleStep(msg.id, st.id)}
                                    className="px-2.5 py-1 bg-brand-dark border border-brand-border text-brand-text-muted rounded text-[10px] cursor-pointer">
                                    Omitir
                                  </button>
                                </>
                              )}
                            </div>
                          )}

                          {/* Stdout collapsible */}
                          {st.stdout && (
                            <div className="mt-1">
                              <button onClick={() => setExpandedStep(expandedStep === st.id ? null : st.id)}
                                className="flex items-center gap-1 text-[9px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded cursor-pointer">
                                <Terminal className="w-3 h-3" />
                                {expandedStep === st.id ? 'Ocultar salida' : 'Ver salida'}
                              </button>
                              {expandedStep === st.id && (
                                <pre className="mt-1 p-2 bg-[#050505] border border-brand-border text-zinc-300 font-mono text-[10px] overflow-x-auto max-h-40 rounded">
                                  {st.stdout}
                                </pre>
                              )}
                            </div>
                          )}

                          {/* Stderr */}
                          {st.stderr && (
                            <pre className="mt-1 p-2 bg-red-950/20 border border-red-900/30 text-rose-400 font-mono text-[10px] overflow-x-auto max-h-32 rounded">
                              {st.stderr}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {loadingAI && (
          <div className="flex gap-3 mr-auto items-center animate-pulse">
            <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded">
              <Bot className="w-4 h-4 animate-spin" />
            </div>
            <span className="text-xs text-brand-text-muted font-sans">
              OpenRouter está analizando el servidor y generando el plan...
            </span>
          </div>
        )}
      </div>

      {/* ── Input ── */}
      <div className="mt-3 flex-shrink-0">
        <div className={`flex p-1.5 border rounded transition-colors ${
          isExecuting
            ? 'bg-brand-dark/60 border-brand-border opacity-60 pointer-events-none'
            : 'bg-brand-bar border-brand-border'
        }`}>
          <textarea
            placeholder={isExecuting ? '🔒 Esperando que el agente termine...' : `Pídele algo al agente en modo ${meta.label}...`}
            rows={2}
            value={prompt}
            disabled={isExecuting}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isExecuting) { e.preventDefault(); handleChatSubmit(prompt); } }}
            className="flex-1 bg-transparent border-none outline-none text-zinc-200 text-xs px-2 resize-none py-1.5 h-[42px] font-sans leading-relaxed disabled:cursor-not-allowed"
          />
          <button
            onClick={() => handleChatSubmit(prompt)}
            disabled={loadingAI || !prompt.trim() || !server || isExecuting}
            className="self-end px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-brand-dark disabled:text-zinc-500 text-white rounded text-xs font-bold transition-all cursor-pointer h-fit font-sans disabled:cursor-not-allowed"
          >
            {isExecuting ? '⏳' : 'Enviar'}
          </button>
        </div>
      </div>

      {/* ── Role confirmation modal ── */}
      {pendingRole && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm rounded-xl">
          <div className="bg-[#0d0d0d] border border-emerald-700/40 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            {/* Icon + title */}
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg flex-shrink-0">
                <Cpu className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-zinc-100 font-sans">{pendingRole.name}</h3>
                <p className="text-[10px] text-zinc-500 font-sans">Cambiar agente activo</p>
              </div>
            </div>

            {/* Description */}
            <p className="text-xs text-zinc-300 font-sans leading-relaxed mb-4">
              {pendingRole.desc}
            </p>

            {/* Capabilities list */}
            <div className="bg-[#050505] border border-brand-border rounded-lg p-3 mb-5">
              <p className="text-[9px] text-zinc-500 uppercase tracking-widest font-mono mb-2">Capacidades</p>
              <ul className="space-y-1">
                {pendingRole.capabilities.map((cap, i) => (
                  <li key={i} className="flex items-center gap-2 text-[11px] text-zinc-300 font-sans">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                    {cap}
                  </li>
                ))}
              </ul>
            </div>

            {/* Prompt preview */}
            {ROLE_AUTO_PROMPTS[pendingRole.role] && (
              <p className="text-[10px] text-zinc-500 font-sans italic mb-4 leading-relaxed">
                Al confirmar, el agente ejecutará un diagnóstico inicial automáticamente.
              </p>
            )}

            {/* Buttons */}
            <div className="flex gap-2">
              <button
                onClick={confirmRoleSwitch}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all cursor-pointer"
              >
                <CheckCircle className="w-3.5 h-3.5" /> Activar agente
              </button>
              <button
                onClick={() => setPendingRole(null)}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 bg-brand-dark border border-brand-border text-zinc-300 hover:text-zinc-100 hover:border-zinc-600 rounded-lg text-xs font-bold transition-all cursor-pointer"
              >
                <XCircle className="w-3.5 h-3.5" /> Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
