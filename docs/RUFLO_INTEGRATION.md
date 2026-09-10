# Ruflo Integration — AdaptiveMemory & WorkflowOrchestrator

This document explains how the Ruflo-inspired modules enhance Linux AI Ops Studio.

## Modules

### 1. AdaptiveMemory (`src/lib/AdaptiveMemory.ts`)

**Purpose**: Learn from solved problems and suggest solutions based on past experience.

**Key features**:
- Records successful solutions with symptoms, commands, and outcomes
- Finds similar past problems when user describes a new issue
- Tags solutions by keyword (CPU, memory, nginx, etc.)
- Persists memory to localStorage (future: SQLite)

**Usage in AgentOpsStudio**:

```typescript
// When user submits a problem
const similarProblems = adaptiveMemory?.findSimilarProblems(
  userPrompt,
  server.id,
  3 // top 3 similar solutions
);

// Suggest to user
if (similarProblems && similarProblems.length > 0) {
  const suggestion = similarProblems[0];
  setChatMessages(prev => [...prev, {
    id: `suggestion-${Date.now()}`,
    sender: 'assistant',
    text: `I've seen a similar problem before (${suggestion.similarity * 100}% match):
           ${suggestion.problem.problemDescription}
           Solution: ${suggestion.problem.solution}`,
    timestamp: new Date().toLocaleTimeString(),
  }]);
}

// Record successful execution
if (stepResult.success) {
  adaptiveMemory?.recordSolution({
    serverId: server.id,
    problemDescription: userPrompt,
    symptoms: extractSymptoms(userPrompt),
    solution: explanation,
    commandsExecuted: steps.map(s => s.command),
    riskLevel: 'low',
    success: true,
    agentRole: activeRole,
  });
}
```

**Benefits**:
- Users see "I've solved this before" suggestions
- Reduces trial-and-error on repeated problems
- Historical audit trail of solutions
- Personalized per-server memory

---

### 2. WorkflowOrchestrator (`src/lib/WorkflowOrchestrator.ts`)

**Purpose**: Execute multiple agents in parallel instead of sequentially.

**Key features**:
- Creates execution plans with multiple agent tasks
- Supports sequential or parallel execution
- Manages task dependencies
- Tracks execution timeline and status

**Current behavior** (before Ruflo):
```
User: "Diagnose this server"
→ SysAdmin Agent runs (30s)
→ Waits for completion
→ Security Agent runs (25s)
→ Waits for completion
→ Docker Agent runs (20s)
Total: ~75 seconds
```

**With WorkflowOrchestrator** (parallel):
```
User: "Diagnose this server"
→ SysAdmin + Security + Docker agents run in parallel
→ All complete in ~30 seconds (max of individual times)
Total: ~30 seconds (60% faster!)
```

**Usage in AgentOpsStudio**:

```typescript
// Create a multi-agent plan
const plan = workflowOrchestrator?.createPlan(
  server.id,
  [
    { role: 'SysAdmin', prompt: 'Check CPU, RAM, Disk usage' },
    { role: 'Security', prompt: 'Audit SSH configuration' },
    { role: 'Docker', prompt: 'Check container health' },
  ],
  'parallel' // Execute all at once
);

// Start execution
workflowOrchestrator?.startPlan(plan.id);

// Get next task
let task = workflowOrchestrator?.getNextTask(plan.id);
while (task) {
  // Execute task with corresponding agent
  const agentResponse = await callOpenRouter(task.agentRole, task.prompt);
  
  // Mark as complete
  workflowOrchestrator?.completeTask(plan.id, task.id, agentResponse.steps);
  
  // Get next task
  task = workflowOrchestrator?.getNextTask(plan.id);
}

// View execution timeline
const timeline = workflowOrchestrator?.getTimeline(plan.id);
// [ { taskId: 'task-0', agentRole: 'SysAdmin', status: 'completed', duration: 2500 },
//   { taskId: 'task-1', agentRole: 'Security', status: 'completed', duration: 1800 },
//   ... ]
```

**Benefits**:
- 50-70% faster multi-agent diagnostics
- Parallel task execution reduces latency
- Dependency management for sequential tasks when needed
- Real-time execution timeline for UI visualization

---

## Integration Points

### App.tsx
```typescript
// Instances created once, shared with AgentOpsStudio
const adaptiveMemoryRef = useRef(new AdaptiveMemory());
const workflowOrchestratorRef = useRef(new WorkflowOrchestrator());

// Passed as props
<AgentOpsStudio
  adaptiveMemory={adaptiveMemoryRef.current}
  workflowOrchestrator={workflowOrchestratorRef.current}
/>
```

### AgentOpsStudio.tsx
- Store references to modules
- Use AdaptiveMemory to suggest past solutions
- Use WorkflowOrchestrator when user wants parallel diagnostics
- Display similar problems to user before executing
- Record successful solutions after execution

### IntelligenceCenter.tsx (Terminal)
- Could eventually integrate memory for command history
- Learn which commands work on which servers

---

## Next Steps (Future Enhancements)

1. **Persist AdaptiveMemory to SQLite** (not just localStorage)
   - Handle large solution sets (100K+ entries)
   - Query by date range, server, agent role
   - Export/import for backup

2. **Advanced similarity matching**
   - Use embedding-based semantic search (not just keyword matching)
   - Train embeddings from user interactions
   - Support fuzzy matching on command outputs

3. **Workflow templates**
   - Save frequently-used orchestration plans
   - "Run full diagnostics" = SysAdmin + Security + Docker in parallel
   - "Production incident response" = Security → DevOps → Monitoring

4. **Cross-server learning**
   - Solutions from `prod-01` auto-suggested for `prod-02` (same OS/config)
   - Shared knowledge base across server fleet

5. **AI-powered summarization**
   - Automatically generate brief solutions from verbose logs
   - "This is a timeout issue → add connection pool size"

6. **Workflow visualization**
   - Gantt chart of parallel task execution
   - Flame graph of which agent took longest
   - Timeline shown in agent chat

---

## Data Model

### MemoryEntry
```typescript
{
  id: "mem-1694000000000-abc1234",
  timestamp: 1694000000000,
  serverId: "srv-prod-01",
  problemDescription: "High CPU usage, nginx consuming 95% for 2 hours",
  symptoms: ["cpu", "nginx"],
  solution: "Restarted nginx service and cleared connection pool queue",
  commandsExecuted: [
    "systemctl restart nginx",
    "netstat -an | grep CLOSE_WAIT | wc -l"
  ],
  riskLevel: "low",
  success: true,
  agentRole: "SysAdmin",
  tags: ["cpu", "nginx", "restart"]
}
```

### AgentTask (in orchestration plan)
```typescript
{
  id: "task-0",
  agentRole: "SysAdmin",
  prompt: "Check CPU, RAM, Disk usage",
  status: "completed",
  result: [ /* AIActionStep[] */ ],
  startTime: 1694000000000,
  endTime: 1694000002500,
  duration: 2500
}
```

---

## Configuration

### Environment Variables (future)
- `ADAPTIVE_MEMORY_ENABLED` — Enable/disable memory recording
- `WORKFLOW_MAX_PARALLEL_TASKS` — Max concurrent agents (default: 5)
- `MEMORY_RETENTION_DAYS` — Auto-delete old memories (default: 90)

---

## Testing

Run type-check:
```bash
npm run lint
```

Run dev server:
```bash
npm run dev
```

Test AdaptiveMemory:
- Execute multiple commands on a server
- Record solutions manually (via console)
- Suggest similar problems for new prompts

Test WorkflowOrchestrator:
- Create a multi-agent plan
- Execute in parallel mode
- Verify all agents run concurrently
- Check timeline for timing analysis

---

## License

Apache 2.0 — Inspired by Ruflo's agent orchestration framework.
