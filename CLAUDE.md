# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start dev server (Express + Vite middleware on port 3005)
npm run build     # Build frontend (Vite → dist/) + bundle server (esbuild → dist/server.cjs)
npm run lint      # Type-check only — tsc --noEmit (no test suite exists)
npm start         # Run production build (requires npm run build first)
```

There are no automated tests. Type checking (`npm run lint`) is the only static validation.

## Architecture

Single-process full-stack app: `server.ts` (Express) embeds Vite as middleware in dev, or serves `dist/` in production. The frontend and backend share no code except the types in `src/types.ts`.

**Backend — `server.ts`**

All server state lives in a single in-memory object `db: ServerStateStore`. This includes server connections, processes, services, Docker containers, files, logs, cron jobs, audit logs, and security assets. There is no external database for runtime state.

Server credentials are the only data persisted to disk: they are written to a SQLite file (`.linux_ai_ops.sqlite3` by default) with AES-256-CBC encryption on save/load via `sql.js`.

Command execution has two modes, chosen per-request:
- **Simulated**: triggered when the server host is a known mock IP (`192.168.1.10`, `192.168.1.12`) or when no credentials are provided. `runSimulatedCommand()` returns canned responses for common Linux commands.
- **Real SSH**: triggered for any other server with credentials. Uses `ssh2` (`runRealSSHCommand()`).

The AI agent endpoint (`POST /api/openrouter/run-agent`) calls OpenRouter to generate a JSON plan (`{ explanation, riskLevel, steps[], reportSummary }`). If `OPENROUTER_API_KEY` is not set, it falls back to `generateSimulatedAgentAction()`.

**Frontend — `src/`**

`App.tsx` is the root component and the single source of truth for all server state. It polls `/api/servers/:id/state` every 6 seconds. The 3-column layout maps directly to three components:

| Column | Component | Responsibility |
|--------|-----------|----------------|
| Left (1/5) | `SSHConnectionManager` | Server vault, add/delete/cleanup servers |
| Center top (2/5) | `Dashboard` | Telemetry, processes, services, Docker, terminal |
| Center bottom (2/5) | `IntelligenceCenter` | File editor, log viewer, security audit |
| Right (2/5) | `AgentOpsStudio` | AI agent chat, multi-step command approval/execution |

`MetricsGraphics.tsx` is a shared animated chart component used by `Dashboard`.

**Key data flow**: `App.tsx` fetches state → passes it down as props → child components call `onExecuteCommand` / `onSaveFile` callbacks → `App` hits the API → state is refreshed.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | No | Enables real AI. Without it, the app uses simulated responses. |
| `OPENROUTER_MODEL` | No | Model to use (default: `openrouter/free`) |
| `OPENROUTER_API_BASE` | No | Override base URL (default: `https://openrouter.ai/api/v1`) |
| `STORAGE_DB_PATH` | No | SQLite file path (default: `.linux_ai_ops.sqlite3`) |
| `PORT` | No | HTTP port (default: `3005`) |

## AI agent JSON contract

When OpenRouter responds, the server expects this exact shape. The robust `tryParseJson()` parser in `server.ts` handles malformed or markdown-wrapped JSON.

```ts
{
  explanation: string;
  riskLevel: 'low' | 'medium' | 'high';
  steps: Array<{
    id: string;
    title: string;
    description: string;
    command: string;
    risk: 'low' | 'medium' | 'high';
  }>;
  reportSummary: string;
}
```

## Notable constraints

- `server.ts` is intentionally monolithic — all backend logic (DB, SSH, AI, REST routes) lives in one file.
- The `db` object resets on server restart except for the `connections` array, which is reloaded from SQLite on startup.
- `analyzeCommandRisk()` in `server.ts` is a simple keyword matcher used to flag commands as low/medium/high risk before execution; it does not block execution.
- `SECRETS_ENCRYPTION_KEY` in `server.ts` is a hardcoded dummy passphrase (intentional for this demo app).
