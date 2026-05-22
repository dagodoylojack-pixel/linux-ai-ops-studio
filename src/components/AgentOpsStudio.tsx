/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
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
  ChevronRight,
  Terminal,
  ChevronDown,
} from 'lucide-react';

interface AgentOpsStudioProps {
  server: ServerConnection | null;
  onExecuteCommand: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  onRefreshTelemetry: () => void;
}

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

const welcomeMessage: AIChatMessage = {
  id: 'welcome',
  sender: 'assistant',
  text: '¡Hola! Soy tu Copiloto Autónomo Linux AI Ops Studio. ¿Qué tarea o diagnóstico deseas programar el día de hoy en el servidor?',
  timestamp: new Date().toLocaleTimeString(),
  suggestedCommands: [
    'Instala Docker y configura Portainer',
    'Audita la seguridad SSH de este nodo y aplica hardening',
    'Verifica los logs de error de Nginx y optimiza el puerto 8080',
    'Analiza qué proceso consume más memoria RAM',
  ],
};

export default function AgentOpsStudio({ server, onExecuteCommand, onRefreshTelemetry }: AgentOpsStudioProps) {
  const [activeRole, setActiveRole] = useState<AgentRole>('SysAdmin');
  const [controlMode, setControlMode] = useState<AIControlMode>('semi-autonomous');
  const [prompt, setPrompt] = useState('');
  const [chatMessages, setChatMessages] = useState<AIChatMessage[]>([welcomeMessage]);
  const [loadingAI, setLoadingAI] = useState(false);
  const [expandedStepStdout, setExpandedStepStdout] = useState<string | null>(null);

  const findPendingConfirmation = (): AIChatMessage | undefined => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const msg = chatMessages[i];
      if (msg.requiresConfirmation && msg.confirmationState === 'pending') {
        return msg;
      }
    }
    return undefined;
  };

  const handleChatSubmit = async (textToSend: string) => {
    if (!textToSend.trim() || !server) return;

    const pendingConfirmation = findPendingConfirmation();
    const normalizedAnswer = textToSend.trim().toLowerCase();
    if (pendingConfirmation) {
      if (/^s(i|í|ip)?$|^confirm(ar|o)?$|^yes$|^ok$/.test(normalizedAnswer)) {
        handleApprovePlan(pendingConfirmation.id);
        return;
      }
      if (/^n(o)?$|^cancel(ar|o)?$|^no gracias$/.test(normalizedAnswer)) {
        handleDeclinePlan(pendingConfirmation.id);
        return;
      }
    }

    const userMsg: AIChatMessage = {
      id: Math.random().toString(),
      sender: 'user',
      text: textToSend,
      timestamp: new Date().toLocaleTimeString(),
    };

    setChatMessages((prev) => [...prev, userMsg]);
    setPrompt('');
    setLoadingAI(true);

    try {
      const response = await fetch('/api/openrouter/run-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: server.id,
          role: activeRole,
          prompt: textToSend,
          controlMode,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setChatMessages((prev) => [
          ...prev,
          {
            id: Math.random().toString(),
            sender: 'system',
            text: `⚠ ${data.error || 'Error desconocido al contactar el agente.'}`,
            timestamp: new Date().toLocaleTimeString(),
          },
        ]);
        setLoadingAI(false);
        return;
      }

      const formattedSteps: AIActionStep[] = (data.steps || []).map((s: any) => ({
        ...s,
        status: 'pending',
      }));

      const assistantMsg: AIChatMessage = {
        id: Math.random().toString(),
        sender: 'assistant',
        text: `${data.explanation || 'Análisis completado.'}\n\nHe preparado el siguiente plan. ¿Quieres que lo aplique en el servidor seleccionado?`,
        timestamp: new Date().toLocaleTimeString(),
        steps: formattedSteps,
        reportSummary: data.reportSummary,
        requiresConfirmation: formattedSteps.length > 0,
        confirmationState: formattedSteps.length > 0 ? 'pending' : undefined,
      };

      setChatMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          sender: 'assistant',
          text: `Oops, surgió una incompatibilidad al conectar con OpenRouter: ${err.message}`,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
    } finally {
      setLoadingAI(false);
    }
  };

  const handleClearChat = () => {
    setChatMessages([welcomeMessage]);
    setExpandedStepStdout(null);
    setPrompt('');
  };

  const updateChatMessageConfirmation = (messageId: string, updates: Partial<AIChatMessage>) => {
    setChatMessages((prev) => prev.map((msg) => (msg.id === messageId ? { ...msg, ...updates } : msg)));
  };

  const handleApprovePlan = async (messageId: string) => {
    updateChatMessageConfirmation(messageId, {
      confirmationState: 'confirmed',
      requiresConfirmation: false,
    });

    const msg = chatMessages.find((m) => m.id === messageId);
    if (!msg?.steps || msg.steps.length === 0) return;

    await executePlanSteps(messageId, msg.steps);
  };

  const handleDeclinePlan = (messageId: string) => {
    updateChatMessageConfirmation(messageId, {
      confirmationState: 'declined',
      requiresConfirmation: false,
    });

    setChatMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(),
        sender: 'assistant',
        text: 'Gracias por utilizar el multichat. Si necesitas otra tarea, dime qué quieres hacer.',
        timestamp: new Date().toLocaleTimeString(),
      },
    ]);
  };

  const executePlanSteps = async (messageId: string, stepsToRun: AIActionStep[]) => {
    let updatedSteps = [...stepsToRun];

    for (let i = 0; i < updatedSteps.length; i++) {
      const step = updatedSteps[i];

      updatedSteps[i] = { ...updatedSteps[i], status: 'running' };
      updateChatMessageSteps(messageId, [...updatedSteps]);

      try {
        const result = await onExecuteCommand(step.command);
        updatedSteps[i] = {
          ...updatedSteps[i],
          status: result.exitCode === 0 ? 'success' : 'failed',
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      } catch (err: any) {
        updatedSteps[i] = {
          ...updatedSteps[i],
          status: 'failed',
          stderr: err.message,
          exitCode: 255,
        };
      }

      updateChatMessageSteps(messageId, [...updatedSteps]);
      onRefreshTelemetry();
    }

    const allSuccess = updatedSteps.every((st) => st.status === 'success');
    setChatMessages((prev) => [
      ...prev,
      {
        id: Math.random().toString(),
        sender: 'assistant',
        text: allSuccess
          ? 'El plan se ha ejecutado con éxito en el servidor seleccionado.'
          : 'El plan se ejecutó con algunos fallos. Revisa los pasos marcados como fallidos y sus salidas.',
        timestamp: new Date().toLocaleTimeString(),
        reportSummary: allSuccess ? 'Plan ejecutado con éxito.' : 'Plan ejecutado con fallos parciales.',
      },
    ]);
  };

  // Run a single specific command step on-demand (Semi-autonomous or manual mode)
  const executeSingleStep = async (messageId: string, stepId: string) => {
    setChatMessages((prev) => {
      return prev.map((msg) => {
        if (msg.id === messageId && msg.steps) {
          const updatedSteps = msg.steps.map((st) => {
            if (st.id === stepId) {
              return { ...st, status: 'running' as const };
            }
            return st;
          });
          return { ...msg, steps: updatedSteps };
        }
        return msg;
      });
    });

    // Find the actual command to execute
    let commandToRun = '';
    const msgRef = chatMessages.find((m) => m.id === messageId);
    const stepRef = msgRef?.steps?.find((s) => s.id === stepId);
    if (stepRef) commandToRun = stepRef.command;

    try {
      const result = await onExecuteCommand(commandToRun);
      
      setChatMessages((prev) => {
        return prev.map((msg) => {
          if (msg.id === messageId && msg.steps) {
            const updatedSteps = msg.steps.map((st) => {
              if (st.id === stepId) {
                return {
                  ...st,
                  status: (result.exitCode === 0 ? 'success' : 'failed') as any,
                  stdout: result.stdout,
                  stderr: result.stderr,
                };
              }
              return st;
            });
            return { ...msg, steps: updatedSteps };
          }
          return msg;
        });
      });

      onRefreshTelemetry();
    } catch (err: any) {
      setChatMessages((prev) => {
        return prev.map((msg) => {
          if (msg.id === messageId && msg.steps) {
            const updatedSteps = msg.steps.map((st) => {
              if (st.id === stepId) {
                return { ...st, status: 'failed' as any, stderr: err.message };
              }
              return st;
            });
            return { ...msg, steps: updatedSteps };
          }
          return msg;
        });
      });
    }
  };

  // Reject step
  const rejectSingleStep = (messageId: string, stepId: string) => {
    setChatMessages((prev) => {
      return prev.map((msg) => {
        if (msg.id === messageId && msg.steps) {
          const updatedSteps = msg.steps.map((st) => {
            if (st.id === stepId) {
              return { ...st, status: 'rejected' as const };
            }
            return st;
          });
          return { ...msg, steps: updatedSteps };
        }
        return msg;
      });
    });
  };

  // Common messaging state helper
  const updateChatMessageSteps = (id: string, steps: AIActionStep[]) => {
    setChatMessages((prev) => prev.map((msg) => (msg.id === id ? { ...msg, steps } : msg)));
  };

  return (
    <div id="agent-ops-studio" className="bg-brand-bg border border-brand-border rounded-xl p-4 flex flex-col h-full shadow-2xl overflow-hidden">
      {/* Top Config Row */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-brand-border pb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-xs font-bold text-brand-text-muted uppercase tracking-widest font-display">Multiagente Copilot</h2>
            <p className="text-[10px] text-zinc-500 font-sans">IA asistida con confirmación de seguridad</p>
          </div>
        </div>

        {/* Autonomy switch */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 bg-[#050505]/40 p-1 border border-brand-border rounded max-w-fit">
            {[
              { id: 'suggestion', label: 'Modo Sugerencia' },
              { id: 'semi-autonomous', label: 'Semi-Autónomo' },
              { id: 'fully-autonomous', label: 'Totalmente Autónomo' },
            ].map((mode) => (
              <button
                key={mode.id}
                onClick={() => setControlMode(mode.id as any)}
                className={`px-2.5 py-1 text-[10px] font-bold rounded font-sans transition-all cursor-pointer ${
                  controlMode === mode.id
                    ? 'bg-brand-item text-emerald-400 border border-brand-border-light shadow-sm'
                    : 'text-brand-text-muted hover:text-zinc-300'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <button
            onClick={handleClearChat}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-brand-border bg-brand-dark text-zinc-300 hover:bg-[#111] transition-all"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Limpiar chat
          </button>
        </div>
      </div>

      {/* Specialist Agents tray */}
      <div className="flex gap-2.5 py-2.5 overflow-x-auto flex-shrink-0 border-b border-brand-border no-scrollbar select-none">
        {AGENT_LIST.map((ag) => {
          const isAct = activeRole === ag.role;
          return (
            <button
              key={ag.role}
              onClick={() => setActiveRole(ag.role)}
              title={ag.desc}
              className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-bold font-sans transition-all cursor-pointer ${
                isAct
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 font-bold'
                  : 'bg-brand-dark border border-brand-border text-brand-text-muted hover:border-brand-border-light hover:text-zinc-200'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              {ag.name}
            </button>
          );
        })}
      </div>

      {/* Active Agent description warning */}
      <div className="p-2 bg-[#050505]/30 border border-brand-border text-[10px] text-brand-text-muted font-sans flex items-center justify-between gap-2 flex-shrink-0 rounded">
        <span>
          <strong>Rol Activo:</strong> {AGENT_LIST.find((a) => a.role === activeRole)?.desc}
        </span>
        <span className="text-emerald-400 bg-emerald-500/10 px-1.5 rounded text-[9px] font-mono whitespace-nowrap font-bold">
          {AGENT_LIST.find((a) => a.role === activeRole)?.capabilities.slice(0, 2).join(' / ')}
        </span>
      </div>

      {/* Conversational Screen */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4 min-h-[150px] bg-[#050505]/20 rounded border border-brand-border mt-2 select-text">
        {chatMessages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-3 max-w-[90%] ${msg.sender === 'user' ? 'ml-auto flex-row-reverse' : 'mr-auto'}`}
          >
            {/* Sender avatar indicator */}
            <div className={`p-2 rounded flex-shrink-0 h-fit ${
              msg.sender === 'user' ? 'bg-brand-bar text-zinc-100 border border-brand-border' : msg.sender === 'system' ? 'bg-amber-950/40 text-amber-500 border border-amber-900/30' : 'bg-emerald-500/10 text-emerald-400'
            }`}>
              {msg.sender === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4 animate-pulse-slow" />}
            </div>

            <div className="space-y-2">
              <div className={`p-3 rounded text-xs font-sans leading-relaxed ${
                msg.sender === 'user'
                  ? 'bg-brand-panel text-[#E5E7EB] border border-brand-border'
                  : 'bg-brand-bar/40 text-[#D1D5DB] border border-brand-border'
              }`}>
                {msg.text}

                {/* Question Helper Chips */}
                {msg.suggestedCommands && msg.suggestedCommands.length > 0 && (
                  <div className="gap-1.5 mt-3 flex flex-col sm:flex-row flex-wrap">
                    {msg.suggestedCommands.map((chip, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          setPrompt(chip);
                          handleChatSubmit(chip);
                        }}
                        className="text-left px-2 py-1.5 bg-[#050505] border border-brand-border hover:border-brand-border-light text-brand-text-muted hover:text-zinc-200 text-[10px] rounded transition-colors cursor-pointer w-full sm:w-auto"
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                )}

                {msg.requiresConfirmation && msg.confirmationState === 'pending' && (
                  <div className="mt-3 flex flex-col sm:flex-row gap-2">
                    <button
                      onClick={() => handleApprovePlan(msg.id)}
                      className="inline-flex items-center justify-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-bold transition-all"
                    >
                      <CheckCircle className="w-3.5 h-3.5" /> Confirmar plan
                    </button>
                    <button
                      onClick={() => handleDeclinePlan(msg.id)}
                      className="inline-flex items-center justify-center gap-2 px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded text-xs font-bold transition-all"
                    >
                      <XCircle className="w-3.5 h-3.5" /> No aplicar
                    </button>
                  </div>
                )}
              </div>

              {/* Dynamic Steps Pipeline Render */}
              {msg.steps && msg.steps.length > 0 && (
                <div className="bg-brand-panel rounded p-3 border border-brand-border space-y-3">
                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-brand-text-muted font-mono">
                    Secuencia del Plan de Despliegue
                  </h4>
                  <div className="space-y-2">
                    {msg.steps.map((st) => {
                      const isHighRisk = st.risk === 'high';
                      const isMediumRisk = st.risk === 'medium';
                      
                      const stepStatusColors = {
                        pending: 'text-zinc-550 border-[#333]',
                        running: 'text-amber-400 border-amber-500 animate-pulse',
                        success: 'text-emerald-400 border-emerald-400',
                        failed: 'text-red-500 border-red-500',
                        rejected: 'text-zinc-650 border-brand-border line-through',
                      };

                      return (
                        <div
                          key={st.id}
                          className={`border-l-2 pl-3 py-1 space-y-1 ${
                            st.status ? stepStatusColors[st.status] : 'border-brand-border text-zinc-300'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-xs text-zinc-200">{st.title}</span>
                            <span className={`px-1.5 py-0.2 rounded text-[9px] uppercase font-bold font-mono ${
                              isHighRisk ? 'bg-red-950/60 border border-red-900/40 text-red-500' : isMediumRisk ? 'bg-amber-950/40 border border-amber-900/30 text-amber-500' : 'bg-emerald-950/50 text-emerald-400'
                            }`}>
                              {st.risk} risk
                            </span>
                          </div>
                          
                          <p className="text-[11px] text-brand-text-muted leading-relaxed">{st.description}</p>
                          <div className="bg-[#050505] border border-brand-border px-2 py-1.5 rounded text-[10px] font-mono flex items-center justify-between text-zinc-300 max-w-full overflow-hidden">
                            <span className="truncate">{st.command}</span>
                          </div>

                          {/* Control Actions */}
                          {st.status === 'pending' && !msg.requiresConfirmation && (
                            <div className="flex gap-1.5 mt-2">
                              {isHighRisk && controlMode === 'fully-autonomous' ? (
                                <span className="text-[10px] text-red-400 bg-red-950/10 px-2.5 py-1 rounded border border-red-950 font-bold flex items-center gap-1.5 leading-snug">
                                  <ShieldAlert className="w-3.5 h-3.5" /> Peligro: Requiere Aprobación Humana Manual
                                </span>
                              ) : null}

                              <button
                                onClick={() => executeSingleStep(msg.id, st.id)}
                                className="flex items-center gap-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-sans text-[10px] font-bold cursor-pointer"
                              >
                                <Play className="w-3 h-3" /> Ejecutar
                              </button>
                              <button
                                onClick={() => rejectSingleStep(msg.id, st.id)}
                                className="px-2.5 py-1 bg-brand-dark border border-brand-border hover:bg-brand-item text-brand-text-muted rounded font-sans text-[10px] cursor-pointer"
                              >
                                Omitir
                              </button>
                            </div>
                          )}

                          {/* Collapsible output display */}
                          {st.stdout && (
                            <div className="mt-2">
                              <button
                                onClick={() => setExpandedStepStdout(expandedStepStdout === st.id ? null : st.id)}
                                className="flex items-center gap-1 text-[9px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded cursor-pointer"
                              >
                                <Terminal className="w-3 h-3" />
                                {expandedStepStdout === st.id ? 'Ocultar Salida Console' : 'Mostrar Salida Console'}
                              </button>
                              
                              {expandedStepStdout === st.id && (
                                <pre className="mt-1.5 p-2 bg-[#050505] border border-brand-border text-zinc-300 font-mono text-[10px] overflow-x-auto max-h-40 leading-relaxed font-bold rounded">
                                  {st.stdout}
                                </pre>
                              )}
                            </div>
                          )}

                          {st.stderr && (
                            <pre className="mt-1.5 p-2 bg-red-950/20 border border-red-900/30 text-rose-400 font-mono text-[10px] overflow-x-auto max-h-40 rounded">
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
          <div className="flex gap-3 justify-start mr-auto items-center animate-pulse">
            <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded">
              <Bot className="w-4 h-4 animate-spin-slow" />
            </div>
            <span className="text-xs text-brand-text-muted font-sans">
              OpenRouter está analizando la telemetría del sistema y planeando el despliegue...
            </span>
          </div>
        )}
      </div>

      {/* Input Form Bottom */}
      <div className="mt-3 flex-shrink-0">
        <div className="flex p-1.5 bg-brand-bar border border-brand-border rounded">
          <textarea
            placeholder="Pídele algo al Agente (e.g. 'instala htop y verifica el estado de swap')"
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleChatSubmit(prompt);
              }
            }}
            className="flex-1 bg-transparent border-none outline-none text-zinc-200 text-xs px-2 resize-none py-1.5 focus:ring-0 leading-relaxed h-[42px] font-sans"
          />
          <button
            onClick={() => handleChatSubmit(prompt)}
            disabled={loadingAI || !prompt.trim()}
            className="self-end px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-brand-dark disabled:text-zinc-500 text-white rounded text-xs font-bold transition-all cursor-pointer h-fit font-sans"
          >
            Enviar
          </button>
        </div>
      </div>
    </div>
  );
}
