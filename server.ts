/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import { Client as SSH2Client } from 'ssh2';
import fs from 'fs/promises';
import crypto from 'crypto';
import busboy from 'busboy';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const envResult = dotenv.config({ path: ENV_PATH });
if (envResult.error) {
  console.warn('dotenv .env file not loaded:', envResult.error.message || envResult.error);
} else {
  console.log('dotenv loaded environment variables from', ENV_PATH);
}

const app = express();
const PORT = Number(process.env.PORT) || 3005;

app.use(express.json({ limit: '100mb' }));

let SQL: any = null;
let sqlDb: any = null;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY?.trim() || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL?.trim() || 'gpt-4.1-mini';
const OPENROUTER_API_BASE = process.env.OPENROUTER_API_BASE?.trim() || 'https://openrouter.ai/api/v1';

// Persistence configuration (allow override via env)
const STORAGE_DB_PATH = process.env.STORAGE_DB_PATH || path.join(process.cwd(), '.linux_ai_ops.sqlite3');
function getEncryptionKey() {
  return crypto.createHash('sha256').update(SECRETS_ENCRYPTION_KEY).digest();
}

function encryptText(plain: string) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return iv.toString('base64') + ':' + encrypted.toString('base64');
}

function decryptText(payload: string) {
  const [ivb, data] = payload.split(':');
  if (!ivb || !data) throw new Error('Invalid encrypted payload');
  const iv = Buffer.from(ivb, 'base64');
  const encrypted = Buffer.from(data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getEncryptionKey(), iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

async function initStorageDb() {
  if (sqlDb) return;
  if (!SQL) {
    const initSqlJs = (await import('sql.js')).default;
    SQL = await initSqlJs();
  }

  try {
    const fileBuffer = await fs.readFile(STORAGE_DB_PATH);
    sqlDb = new SQL.Database(fileBuffer);
  } catch (err: any) {
    sqlDb = new SQL.Database();
  }

  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

async function persistStorageDb() {
  if (!sqlDb) return;
  await fs.writeFile(STORAGE_DB_PATH, Buffer.from(sqlDb.export()));
}

// No OAuth token persistence is needed for OpenRouter API key usage.

async function saveServerToDb(server: any) {
  try {
    await initStorageDb();
    const payload = JSON.stringify(server);
    const enc = encryptText(payload);
    const stmt = sqlDb.prepare('INSERT OR REPLACE INTO servers (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    stmt.bind([server.id, enc, now, now]);
    stmt.step();
    stmt.free();
    await persistStorageDb();
    console.log(`Server ${server.id} persisted to SQLite DB.`);
  } catch (err: any) {
    console.error('Failed to persist server to DB:', err.message || err);
  }
}

async function loadServersFromDb() {
  try {
    await initStorageDb();
    const stmt = sqlDb.prepare('SELECT payload FROM servers');
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (!row.payload) continue;
      const decoded = decryptText(row.payload as string);
      const server = JSON.parse(decoded);
      if (!db.connections.some((c) => c.id === server.id)) {
        db.connections.push(server);
      }
    }
    stmt.free();
    console.log('Loaded persisted servers from SQLite DB.');
  } catch (err: any) {
    console.log('Failed to load persisted servers from DB:', err.message || err);
  }
}

async function deleteServerFromDb(serverId: string) {
  try {
    await initStorageDb();
    const stmt = sqlDb.prepare('DELETE FROM servers WHERE id = ?');
    stmt.bind([serverId]);
    stmt.step();
    stmt.free();
    await persistStorageDb();
    console.log(`Server ${serverId} removed from SQLite DB.`);
  } catch (err: any) {
    console.error('Failed to delete server from DB:', err.message || err);
  }
}

function runRealSSHCommandAsync(connection: any, command: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    runRealSSHCommand(connection, command, (err, response) => {
      if (err) return reject(err);
      resolve(response!);
    });
  });
}

async function verifyServerConnection(server: any) {
  if (!server.password && !server.privateKey) {
    return 'offline';
  }

  try {
    const result = await runRealSSHCommandAsync(server, 'echo LINUX_AI_OPS_HEALTH && uname -s');
    if (result.exitCode === 0) {
      return 'online';
    }
  } catch (err) {
    console.warn(`Server health check failed for ${server.id}:`, (err as any).message || err);
  }

  return 'offline';
}

async function verifyOpenRouterConnection() {
  if (!isOpenRouterConfigured()) {
    return { connected: false, authMode: 'none' as const, model: null };
  }

  const normalizedBase = OPENROUTER_API_BASE.replace(/\/+$/, '');
  const baseHeaders = {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const tryRequest = async (url: string) => {
    const response = await fetch(url, {
      method: 'GET',
      headers: baseHeaders,
    });
    if (!response.ok) {
      throw new Error(`Status ${response.status}`);
    }
    return response.json();
  };

  try {
    const modelResponse = await tryRequest(`${normalizedBase}/models/${OPENROUTER_MODEL}`);
    return {
      connected: true,
      authMode: 'apikey' as const,
      model: modelResponse?.id || OPENROUTER_MODEL,
    };
  } catch (firstErr) {
    try {
      const modelsResponse = await tryRequest(`${normalizedBase}/models`);
      const foundModel = Array.isArray(modelsResponse?.data)
        ? modelsResponse.data.find((item: any) => item?.id === OPENROUTER_MODEL)
        : undefined;
      return {
        connected: true,
        authMode: 'apikey' as const,
        model: foundModel?.id || OPENROUTER_MODEL,
      };
    } catch (secondErr) {
      console.error('OpenRouter connection validation failed:', secondErr);
      return { connected: false, authMode: 'apikey' as const, model: OPENROUTER_MODEL };
    }
  }
}

try {
  if (OPENROUTER_API_KEY) {
    console.log('OpenRouter API key configured, backend AI requests enabled.');
  } else {
    console.warn('OPENROUTER_API_KEY environment variable is not defined. Running in AI simulation fallback mode.');
  }
} catch (error) {
  console.error('Error initializing OpenRouter configuration:', error);
}

console.log('OpenRouter configuration:');
console.log(`  OPENROUTER_API_KEY configured=${Boolean(OPENROUTER_API_KEY)}`);
console.log(`  OPENROUTER_MODEL=${OPENROUTER_MODEL}`);
console.log(`  OPENROUTER_API_BASE=${OPENROUTER_API_BASE}`);

function isOpenRouterConfigured() {
  return Boolean(OPENROUTER_API_KEY);
}

async function requestOpenRouterCompletion(systemInstruction: string, userPrompt: string) {
  const payload = {
    model: OPENROUTER_MODEL,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 1200,
  };

  const normalizedBase = OPENROUTER_API_BASE.replace(/\/+$/, '');
  const requestUrl = normalizedBase.endsWith('/chat/completions')
    ? normalizedBase
    : `${normalizedBase}/chat/completions`;

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${bodyText}`);
  }

  const result = await response.json();

  const extractText = (payload: any): string | undefined => {
    if (payload == null) return undefined;
    if (typeof payload === 'string') return payload;
    if (typeof payload?.text === 'string') return payload.text;
    if (typeof payload?.content === 'string') return payload.content;
    if (Array.isArray(payload)) {
      return payload
        .map((item) => extractText(item))
        .filter(Boolean)
        .join('');
    }
    if (typeof payload === 'object') {
      const nested = extractText(payload.text || payload.content || payload.parts || payload.message || payload.output_text);
      if (nested) return nested;
      return Object.values(payload)
        .map((value) => extractText(value))
        .filter(Boolean)
        .join(' ')
        .trim() || undefined;
    }
    return undefined;
  };

  const choice = result?.choices?.[0];
  const message = choice?.message;
  let rawText = extractText(message?.content ?? choice?.text ?? result?.output_text ?? result);

  if (!rawText) {
    console.error('OpenRouter response payload structure:', JSON.stringify(result, null, 2));
    throw new Error('OpenRouter did not return a content payload.');
  }

  return rawText;
}

app.get('/auth/openrouter/status', async (req, res) => {
  const status = await verifyOpenRouterConnection();
  res.json(status);
});

// Load persisted servers from DB at startup
(async () => {
  await loadServersFromDb();
})();

// ---------------- GLOBAL IN-MEMORY PERSISTENT DB STATES ----------------
// Represents the vault and operational states of the Linux admin studio.
const SECRETS_ENCRYPTION_KEY = 'LINUX-AI-OPS-STUDIO-ENCRYPTION-PASSPHRASE-AES'; // Dummy key for simulation

interface ServerStateStore {
  connections: any[];
  processes: { [serverId: string]: any[] };
  services: { [serverId: string]: any[] };
  dockerContainers: { [serverId: string]: any[] };
  files: { [serverId: string]: any[] };
  logs: { [serverId: string]: any[] };
  cronJobs: { [serverId: string]: any[] };
  auditLogs: any[];
  securityAssets: { [serverId: string]: any[] };
  chatHistories: { [serverId: string]: any[] };
}

const db: ServerStateStore = {
  connections: [],
  processes: {},
  services: {},
  dockerContainers: {},
  files: {},
  logs: {},
  cronJobs: {},
  auditLogs: [],
  securityAssets: {},
  chatHistories: {},
};

// ---------------- ALGORITHMS & AUXILIARY LOGIC ----------------

// Validate for commands and flag risk
function analyzeCommandRisk(command: string): 'low' | 'medium' | 'high' {

  const normalized = command.toLowerCase().trim();
  const highRiskPatterns = [
    'rm -rf',
    'mkfs',
    'reboot',
    'shutdown',
    'dd ',
    '> /dev/sda',
    'fdisk',
    'ufw disable',
    'iptables -f',
    'init 0',
  ];
  const mediumRiskPatterns = [
    'chmod',
    'chown',
    'systemctl stop',
    'kill ',
    'apt-get install',
    'apt install',
    'docker stop',
    'docker rm',
    'passwd',
    'crontab -r',
  ];

  if (highRiskPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'high';
  }
  if (mediumRiskPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'medium';
  }
  return 'low';
}

// Real SSH connection executing helper client
function runRealSSHCommand(
  connection: any,
  cmd: string,
  callback: (err: Error | null, response?: { stdout: string; stderr: string; exitCode: number }) => void
) {
  const ssh = new SSH2Client();

  ssh.on('ready', () => {
    let stdout = '';
    let stderr = '';

    ssh.exec(cmd, (err, stream) => {
      if (err) {
        ssh.end();
        return callback(err);
      }

      // Cap stdout at 500 KB to prevent large commands (cat bigfile) from hanging the app.
      // When exceeded: truncate, close the SSH channel early, add a marker.
      const STDOUT_LIMIT = 500 * 1024;
      let truncated = false;
      let resolved = false;

      const done = (code: number) => {
        if (resolved) return;
        resolved = true;
        ssh.end();
        callback(null, { stdout, stderr, exitCode: code ?? 0 });
      };

      stream.on('close', (code: number) => done(code));
      stream.on('data', (data: Buffer) => {
        if (truncated) return;
        stdout += data.toString();
        if (stdout.length > STDOUT_LIMIT) {
          truncated = true;
          // Trim to last complete line within the limit
          stdout = stdout.slice(0, STDOUT_LIMIT);
          const lastNl = stdout.lastIndexOf('\n');
          if (lastNl > 0) stdout = stdout.slice(0, lastNl);
          stdout += '\n[OUTPUT_TRUNCATED]';
          try { stream.destroy(); } catch {}
          // stream.destroy() may not fire 'close' — resolve with a short delay as fallback
          setTimeout(() => done(0), 300);
        }
      });
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
    });
  });

  ssh.on('error', (err) => {
    callback(err);
  });

  const connectConfig: any = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    readyTimeout: 5000,
  };

  if (connection.authType === 'password') {
    connectConfig.password = connection.password;
  } else {
    connectConfig.privateKey = connection.privateKey;
  }

  try {
    ssh.connect(connectConfig);
  } catch (err: any) {
    callback(err);
  }
}

// ---------------- REAL SERVER STATE FETCHING ----------------

const stateCache: Record<string, { data: any; fetchedAt: number }> = {};
const STATE_CACHE_TTL = 8000;

// Per-server /proc/net/dev snapshots used to compute KB/s between polls (no sleep needed)
const netSamples = new Map<string, { rx: number; tx: number; ts: number }>();

async function fetchRealServerState(server: any) {
  // Single SSH connection with a batch script — avoids opening 12+ concurrent connections
  // which can exceed MaxSessions/MaxStartups on the remote sshd and cause silent failures.
  // CPU uses /proc/stat (universally reliable across all distros/versions).
  const batchScript = [
    "echo '<<CPU>>'",
    "awk 'NR==1{t=0;for(i=2;i<=NF;i++)t+=$i;printf \"%.0f\\n\",(1-$5/t)*100}' /proc/stat 2>/dev/null || echo 0",
    "echo '<<MEM>>'",
    "free -m 2>/dev/null | awk '/Mem:/{print $2,$3}' || echo '0 0'",
    "echo '<<DISK>>'",
    "df -h / 2>/dev/null | awk 'NR==2{print $2,$3,$5}' || echo '0G 0G 0%'",
    "echo '<<UPTIME>>'",
    "uptime -p 2>/dev/null || uptime 2>/dev/null || echo ''",
    "echo '<<PS>>'",
    "ps aux --sort=-%cpu 2>/dev/null | head -21 || echo ''",
    "echo '<<SVC>>'",
    // Detection cascade: systemd → SysV /var/lock/subsys (CentOS/RHEL) → OpenRC (Alpine) → /var/run/*.pid (generic SysV)
    // All branches emit: "name.service loaded active running <description>" for consistent parsing.
    "_SD=$(systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -30); if [ -n \"$_SD\" ]; then echo \"$_SD\"; elif [ -d /var/lock/subsys ] && [ -n \"$(ls -A /var/lock/subsys/ 2>/dev/null)\" ]; then ls /var/lock/subsys/ 2>/dev/null | head -30 | sed 's/$/.service loaded active running SysV/'; elif command -v rc-status >/dev/null 2>&1; then rc-status 2>/dev/null | awk '/ started /{print $1\".service loaded active running OpenRC\"}' | head -20; elif ls /var/run/*.pid >/dev/null 2>&1; then ls /var/run/*.pid 2>/dev/null | sed 's|.*/||;s|\\.pid$|.service loaded active running SysV|' | head -30; fi",
    "echo '<<DOCKER>>'",
    "docker ps -a --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null || echo ''",
    "echo '<<LOG>>'",
    "journalctl -n 25 --no-pager -o short 2>/dev/null || tail -n 25 /var/log/syslog 2>/dev/null || tail -n 25 /var/log/messages 2>/dev/null || echo ''",
    "echo '<<CRON>>'",
    "crontab -l 2>/dev/null || echo ''",
    "echo '<<OS>>'",
    "grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d'\"' -f2 || echo 'Linux'",
    "echo '<<TEMP>>'",
    "T=$(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | awk '{s+=$1;c++}END{if(c>0)printf \"%.0f\",s/c/1000}'); if [ -n \"$T\" ]; then echo \"$T\"; else sensors 2>/dev/null | awk '/^Core|^Package/{for(i=1;i<=NF;i++) if($i~/^\\+[0-9]/) {gsub(/[^0-9.]/,\"\",$i); printf \"%.0f\\n\",$i; exit}}' || echo ''; fi",
    "echo '<<NETDEV>>'",
    "awk 'NR>2 && !/lo:/{gsub(/:/, \"\", $1); print $1, $2, $10; exit}' /proc/net/dev 2>/dev/null || echo '- 0 0'",
    "echo '<<USERS>>'",
    "who 2>/dev/null | awk '{print $1}' | sort -u | head -5 || echo ''",
    "echo '<<END>>'",
  ].join('; ');

  // This throws if SSH is unreachable — caught by the state endpoint which marks server offline
  const result = await runRealSSHCommandAsync(server, batchScript);
  const out = result.stdout;

  function sec(name: string): string {
    const marker = `<<${name}>>\n`;
    const start = out.indexOf(marker);
    if (start === -1) return '';
    const from = start + marker.length;
    const next = out.indexOf('<<', from);
    return (next === -1 ? out.slice(from) : out.slice(from, next)).trim();
  }

  const cpuUsage = Math.min(100, Math.max(0, parseFloat(sec('CPU')) || 0));

  const [ramTotalMb, ramUsedMb] = sec('MEM').split(' ').map(Number);
  const ramTotal = parseFloat(((ramTotalMb || 0) / 1024).toFixed(1));
  const ramUsage = parseFloat(((ramUsedMb || 0) / 1024).toFixed(1));

  const diskParts = sec('DISK').split(' ');
  const diskTotal = parseFloat(diskParts[0]) || 0;
  const diskUsagePct = parseFloat((diskParts[2] || '0%').replace('%', '')) || 0;

  const processes = sec('PS')
    .split('\n')
    .slice(1)
    .map((line) => {
      const p = line.trim().split(/\s+/);
      return {
        user: p[0] || '', pid: parseInt(p[1]) || 0, cpu: parseFloat(p[2]) || 0,
        mem: parseFloat(p[3]) || 0, vsz: parseInt(p[4]) || 0, rss: parseInt(p[5]) || 0,
        tty: p[6] || '?', stat: p[7] || '', start: p[8] || '', time: p[9] || '',
        command: p.slice(10).join(' '),
      };
    })
    .filter((p) => p.pid > 0);

  const services = sec('SVC')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const p = line.trim().split(/\s+/);
      return {
        name: p[0] || '', loaded: p[1] || 'loaded', active: p[2] || 'active',
        sub: p[3] || 'running', description: p.slice(4).join(' '),
      };
    })
    .filter((s) => s.name.endsWith('.service'));

  const dockerContainers = sec('DOCKER')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      const p = line.split('\t');
      return {
        id: p[0]?.trim() || `dc${i}`, name: p[1]?.trim() || '',
        image: p[2]?.trim() || '', status: p[3]?.trim() || '',
        ports: p[4]?.trim() || '', cpu: 0, mem: '—', command: '', created: '',
      };
    });

  const logs = sec('LOG')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      const lower = line.toLowerCase();
      const level = lower.includes('error') || lower.includes('fail') ? 'error'
        : lower.includes('warn') ? 'warn' : 'info';
      return { id: `log-${i}`, timestamp: new Date().toISOString(), service: 'system', level, message: line.slice(0, 300) };
    });

  const cronJobs = sec('CRON')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((line, i) => {
      const p = line.split(/\s+/);
      return { id: `c${i}`, schedule: p.slice(0, 5).join(' '), command: p.slice(5).join(' '), description: `Cron ${i + 1}`, active: true };
    });

  // Network rate — compare current /proc/net/dev snapshot with previous poll
  const netdevLine = sec('NETDEV').split('\n').filter(Boolean)[0] || '- 0 0';
  const [, rxBytesStr, txBytesStr] = netdevLine.trim().split(/\s+/);
  const rxBytes = parseInt(rxBytesStr) || 0;
  const txBytes = parseInt(txBytesStr) || 0;
  const now = Date.now();
  const prev = netSamples.get(server.id);
  let rxRate = 0;
  let txRate = 0;
  if (prev && prev.rx > 0 && now > prev.ts) {
    const elapsed = (now - prev.ts) / 1000;
    rxRate = Math.max(0, Math.round((rxBytes - prev.rx) / elapsed / 1024));
    txRate = Math.max(0, Math.round((txBytes - prev.tx) / elapsed / 1024));
  }
  netSamples.set(server.id, { rx: rxBytes, tx: txBytes, ts: now });

  // Temperature — empty string means no sensor available (VM/container)
  const tempStr = sec('TEMP');
  const temperature = tempStr ? (parseInt(tempStr) || 0) : -1;

  const updatedServer = {
    ...server,
    status: 'online' as const,
    cpuUsage: Math.round(cpuUsage),
    ramUsage,
    ramTotal,
    diskUsage: diskUsagePct,
    diskTotal,
    uptime: sec('UPTIME') || server.uptime || '—',
    osName: sec('OS') || server.osName || 'Linux',
    temperature,
    rxRate,
    txRate,
    usersConnected: sec('USERS').split('\n').filter(Boolean),
  };

  return { server: updatedServer, processes, services, dockerContainers, logs, cronJobs };
}

// ---------------- REST RUNTIME APIS ----------------

// 1. Connection endpoints
app.get('/api/servers', (req, res) => {
  // Return server list. Do not mutate the underlying state here; sync is handled separately.
  res.json(db.connections);
});

app.post('/api/servers/sync', async (req, res) => {
  try {
    const updated = await Promise.all(
      db.connections.map(async (server) => {
        const status = await verifyServerConnection(server);
        server.status = status as 'online' | 'offline' | 'connecting';
        return server;
      })
    );
    res.json(updated);
  } catch (err: any) {
    console.error('Error running server sync:', err);
    res.status(500).json({ error: 'Unable to sync server connection state.' });
  }
});

app.delete('/api/servers/:id', async (req, res) => {
  const id = req.params.id;
  const index = db.connections.findIndex((c) => c.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Server node not found.' });
  }

  db.connections.splice(index, 1);
  delete db.processes[id];
  delete db.services[id];
  delete db.dockerContainers[id];
  delete db.files[id];
  delete db.logs[id];
  delete db.cronJobs[id];
  delete db.securityAssets[id];
  deleteServerFromDb(id).catch(() => {});

  res.json({ success: true, id });
});

app.post('/api/servers/cleanup', async (req, res) => {
  try {
    const offlineServers = db.connections.filter((server) => server.status === 'offline');
    const removedIds = offlineServers.map((s) => s.id);
    db.connections = db.connections.filter((server) => server.status !== 'offline');

    removedIds.forEach((id) => {
      delete db.processes[id];
      delete db.services[id];
      delete db.dockerContainers[id];
      delete db.files[id];
      delete db.logs[id];
      delete db.cronJobs[id];
      delete db.securityAssets[id];
      deleteServerFromDb(id).catch(() => {});
    });

    res.json({ removed: removedIds.length, servers: db.connections });
  } catch (err: any) {
    console.error('Error cleaning up servers:', err);
    res.status(500).json({ error: 'Unable to remove unused servers.' });
  }
});

// Connect a specific server: verify SSH and update status
app.post('/api/servers/:id/connect', async (req, res) => {
  const id = req.params.id;
  const idx = db.connections.findIndex((c) => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Server not found.' });

  db.connections[idx].status = 'connecting';
  const status = await verifyServerConnection(db.connections[idx]);
  db.connections[idx].status = status as 'online' | 'offline' | 'connecting';

  // Invalidate cache so next state poll fetches fresh data
  delete stateCache[id];

  res.json(db.connections[idx]);
});

// Disconnect a specific server: mark offline and clear cache
app.post('/api/servers/:id/disconnect', (req, res) => {
  const id = req.params.id;
  const idx = db.connections.findIndex((c) => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Server not found.' });

  db.connections[idx].status = 'offline';
  delete stateCache[id];

  res.json(db.connections[idx]);
});

app.post('/api/servers', async (req, res) => {
  const { name, host, port, username, authType, password, privateKey } = req.body;
  
  if (!name || !host || !username) {
    return res.status(400).json({ error: 'Name, Host and Username are required fields.' });
  }

  const id = 'srv-' + Math.random().toString(36).substring(2, 9);
  const newServer = {
    id,
    name,
    host,
    port: port ? parseInt(port) : 22,
    username,
    authType,
    password,
    privateKey,
    status: 'connecting' as const,
  };

  db.connections.push(newServer);
  await saveServerToDb(newServer);

  res.status(201).json(newServer);
});

// 2. State elements for active host
app.get('/api/servers/:id/state', async (req, res) => {
  const id = req.params.id;
  const serv = db.connections.find((c) => c.id === id);
  if (!serv) return res.status(404).json({ error: 'Server node not found.' });

  const cached = stateCache[id];
  if (cached && Date.now() - cached.fetchedAt < STATE_CACHE_TTL) {
    return res.json(cached.data);
  }

  if (!serv.password && !serv.privateKey) {
    return res.json({
      server: serv, processes: [], services: [], dockerContainers: [],
      files: db.files[id] || [], logs: [], cronJobs: [], securityAssets: db.securityAssets[id] || [],
    });
  }

  try {
    const state = await fetchRealServerState(serv);
    const idx = db.connections.findIndex((c) => c.id === id);
    if (idx >= 0) db.connections[idx] = { ...db.connections[idx], ...state.server };

    const responseData = {
      server: state.server,
      processes: state.processes,
      services: state.services,
      dockerContainers: state.dockerContainers,
      files: db.files[id] || [],
      logs: state.logs,
      cronJobs: state.cronJobs,
      securityAssets: db.securityAssets[id] || [],
    };

    stateCache[id] = { data: responseData, fetchedAt: Date.now() };
    return res.json(responseData);
  } catch (err: any) {
    console.warn(`State fetch failed for ${id} — marking offline:`, (err as any).message || err);
    const idx = db.connections.findIndex((c) => c.id === id);
    if (idx >= 0) db.connections[idx].status = 'offline';
    const offlinePayload = {
      server: { ...serv, status: 'offline' }, processes: [], services: [], dockerContainers: [],
      files: db.files[id] || [], logs: [], cronJobs: [], securityAssets: db.securityAssets[id] || [],
    };
    stateCache[id] = { data: offlinePayload, fetchedAt: Date.now() };
    return res.json(offlinePayload);
  }
});

// 3. Command execution endpoint
app.post('/api/servers/:id/execute', (req, res) => {
  const id = req.params.id;
  const { command } = req.body;
  const serv = db.connections.find((c) => c.id === id);

  if (!serv) {
    return res.status(404).json({ error: 'Server node not found.' });
  }
  if (!command) {
    return res.status(400).json({ error: 'No command input string specified.' });
  }

  // Audit safety review
  const risk = analyzeCommandRisk(command);

  if (!serv.password && !serv.privateKey) {
    return res.status(400).json({
      error: 'No hay credenciales configuradas para este servidor. Edítelo y agregue contraseña o clave privada.',
    });
  }

  runRealSSHCommand(serv, command, (err, response) => {
    if (err) {
      return res.status(500).json({
        stdout: '',
        stderr: `SSH Connection Failure occurred: ${err.message}`,
        exitCode: 255,
        risk,
      });
    }

    db.auditLogs.unshift({
      id: 'aud-' + Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      serverId: id,
      serverName: serv.name,
      agentRole: 'SysAdmin',
      commandExecuted: command,
      success: response!.exitCode === 0,
      outputSummary: response!.stdout.slice(0, 150),
      mode: 'semi-autonomous',
      userApproved: true,
    });

    return res.json({
      stdout: response!.stdout,
      stderr: response!.stderr,
      exitCode: response!.exitCode,
      risk,
    });
  });
});

// File system explorer editing commands
app.post('/api/servers/:id/files/save', (req, res) => {
  const id = req.params.id;
  const { path: filePath, content } = req.body;
  
  if (!filePath) {
    return res.status(400).json({ error: 'File path key is required.' });
  }

  const sFiles = db.files[id] || [];
  const fileIndex = sFiles.findIndex((f) => f.path === filePath);

  if (fileIndex > -1) {
    sFiles[fileIndex].content = content;
    res.json({ success: true, message: 'File saved successfully.' });
  } else {
    // Create new file
    sFiles.push({
      path: filePath,
      type: filePath.endsWith('.json') ? 'json' : filePath.endsWith('.yaml') ? 'yaml' : 'conf',
      description: 'Custom User Config Asset',
      content: content,
    });
    db.files[id] = sFiles;
    res.json({ success: true, message: 'New file created and saved.' });
  }
});

// ---------------- SFTP BIDIRECTIONAL FILE TRANSFER ----------------

// Helper: opens an SFTP subsystem and runs fn, then closes the connection
function withSFTP<T>(server: any, fn: (sftp: any) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const ssh = new SSH2Client();
    let settled = false;

    ssh.on('ready', () => {
      ssh.sftp((err: any, sftp: any) => {
        if (err) { ssh.end(); return reject(err); }
        fn(sftp)
          .then((val) => { settled = true; ssh.end(); resolve(val); })
          .catch((e) => { settled = true; ssh.end(); reject(e); });
      });
    });

    ssh.on('error', (err: any) => { if (!settled) reject(err); });

    const cfg: any = {
      host: server.host, port: server.port, username: server.username, readyTimeout: 5000,
    };
    if (server.authType === 'password') cfg.password = server.password;
    else cfg.privateKey = server.privateKey;

    try { ssh.connect(cfg); } catch (e: any) { reject(e); }
  });
}

// SFTP — list directory entries
app.get('/api/servers/:id/sftp/ls', async (req, res) => {
  const serv = db.connections.find((c) => c.id === req.params.id);
  if (!serv) return res.status(404).json({ error: 'Server not found.' });
  if (!serv.password && !serv.privateKey) return res.status(400).json({ error: 'No credentials configured.' });

  const remotePath = (req.query.path as string) || '/';

  try {
    const entries = await withSFTP(serv, (sftp) => new Promise<any[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err: any, list: any[]) => {
        if (err) return reject(new Error(`Cannot list directory: ${err.message}`));
        const parsed = (list || [])
          .filter((item: any) => item.filename !== '.' && item.filename !== '..')
          .map((item: any) => ({
            name: item.filename as string,
            type: (item.attrs.isDirectory() ? 'dir' : 'file') as 'dir' | 'file',
            size: (item.attrs.size as number) || 0,
            mode: (item.attrs.mode as number) || 0,
            mtime: (item.attrs.mtime as number) || 0,
          }))
          .sort((a: any, b: any) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        resolve(parsed);
      });
    }));
    res.json({ path: remotePath, entries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// SFTP — read file content into editor (max 512 KB)
app.get('/api/servers/:id/sftp/read', async (req, res) => {
  const serv = db.connections.find((c) => c.id === req.params.id);
  if (!serv) return res.status(404).json({ error: 'Server not found.' });
  if (!serv.password && !serv.privateKey) return res.status(400).json({ error: 'No credentials configured.' });

  const remotePath = req.query.path as string;
  if (!remotePath) return res.status(400).json({ error: 'path parameter required.' });

  const MAX_SIZE = 512 * 1024;

  try {
    const content = await withSFTP(serv, (sftp) => new Promise<string>((resolve, reject) => {
      sftp.stat(remotePath, (statErr: any, stats: any) => {
        if (statErr) return reject(new Error(`File not found: ${statErr.message}`));
        if (stats.size > MAX_SIZE) {
          return reject(new Error(`El archivo es demasiado grande para editar inline (${(stats.size / 1024).toFixed(0)} KB). Use la descarga directa.`));
        }
        const chunks: Buffer[] = [];
        const rs = sftp.createReadStream(remotePath);
        rs.on('data', (chunk: Buffer) => chunks.push(chunk));
        rs.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        rs.on('error', (e: any) => reject(e));
      });
    }));
    res.json({ path: remotePath, content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// SFTP — download file as binary stream with Content-Length for progress
app.get('/api/servers/:id/sftp/download', (req, res) => {
  const serv = db.connections.find((c) => c.id === req.params.id);
  if (!serv) return res.status(404).json({ error: 'Server not found.' });
  if (!serv.password && !serv.privateKey) return res.status(400).json({ error: 'No credentials configured.' });

  const remotePath = req.query.path as string;
  if (!remotePath) return res.status(400).json({ error: 'path parameter required.' });

  const filename = remotePath.split('/').pop() || 'download';
  const ssh = new SSH2Client();

  ssh.on('ready', () => {
    ssh.sftp((err: any, sftp: any) => {
      if (err) {
        ssh.end();
        if (!res.headersSent) res.status(500).json({ error: err.message });
        return;
      }
      // Stat first to set Content-Length so browser/client can track progress
      sftp.stat(remotePath, (statErr: any, stats: any) => {
        if (!statErr && stats?.size) {
          res.setHeader('Content-Length', String(stats.size));
        }
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        const rs = sftp.createReadStream(remotePath);
        rs.on('error', (streamErr: any) => {
          ssh.end();
          if (!res.headersSent) res.status(500).json({ error: streamErr.message });
          else res.end();
        });
        rs.on('close', () => ssh.end());
        rs.pipe(res);
      });
    });
  });

  ssh.on('error', (err: any) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  const cfg: any = {
    host: serv.host, port: serv.port, username: serv.username, readyTimeout: 5000,
  };
  if (serv.authType === 'password') cfg.password = serv.password;
  else cfg.privateKey = serv.privateKey;

  try { ssh.connect(cfg); } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
  }
});

// SFTP — streaming upload via multipart/form-data (busboy), no base64 overhead
app.post('/api/servers/:id/sftp/upload-stream', (req, res) => {
  const serv = db.connections.find((c) => c.id === req.params.id);
  if (!serv) return res.status(404).json({ error: 'Server not found.' });
  if (!serv.password && !serv.privateKey) return res.status(400).json({ error: 'No credentials configured.' });

  const remotePath = (req.query.path as string) || '/';

  const bb = busboy({ headers: req.headers });
  let responded = false;

  bb.on('file', (_field: string, fileStream: any, info: any) => {
    const filename = info.filename || 'upload';
    const targetPath = (remotePath === '/' ? '' : remotePath) + '/' + filename;

    const ssh = new SSH2Client();
    let settled = false;

    ssh.on('ready', () => {
      ssh.sftp((sftpErr: any, sftp: any) => {
        if (sftpErr) {
          ssh.end();
          fileStream.resume();
          if (!responded) { responded = true; res.status(500).json({ error: sftpErr.message }); }
          return;
        }
        const ws = sftp.createWriteStream(targetPath);
        ws.on('close', () => {
          settled = true;
          ssh.end();
          if (!responded) { responded = true; res.json({ success: true, path: targetPath, filename }); }
        });
        ws.on('error', (wsErr: any) => {
          settled = true;
          ssh.end();
          fileStream.resume();
          if (!responded) { responded = true; res.status(500).json({ error: wsErr.message }); }
        });
        fileStream.pipe(ws);
      });
    });

    ssh.on('error', (err: any) => {
      if (!settled && !responded) { responded = true; fileStream.resume(); res.status(500).json({ error: err.message }); }
    });

    const cfg: any = { host: serv.host, port: serv.port, username: serv.username, readyTimeout: 5000 };
    if (serv.authType === 'password') cfg.password = serv.password;
    else cfg.privateKey = serv.privateKey;
    try { ssh.connect(cfg); } catch (e: any) {
      if (!responded) { responded = true; res.status(500).json({ error: (e as Error).message }); }
    }
  });

  bb.on('error', (err: any) => {
    if (!responded) { responded = true; res.status(500).json({ error: err.message }); }
  });

  req.pipe(bb);
});

// SFTP — write/overwrite file from editor (text)
app.post('/api/servers/:id/sftp/write', async (req, res) => {
  const serv = db.connections.find((c) => c.id === req.params.id);
  if (!serv) return res.status(404).json({ error: 'Server not found.' });
  if (!serv.password && !serv.privateKey) return res.status(400).json({ error: 'No credentials configured.' });

  const { path: remotePath, content } = req.body;
  if (!remotePath) return res.status(400).json({ error: 'path required.' });

  try {
    await withSFTP(serv, (sftp) => new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(remotePath);
      ws.on('close', () => resolve());
      ws.on('error', (e: any) => reject(e));
      ws.end(content ?? '', 'utf8');
    }));
    res.json({ success: true, path: remotePath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// Get Audit Logs
app.get('/api/audits', (req, res) => {
  res.json(db.auditLogs);
});

// ---------------- AUTONOMOUS OPENROUTER DECISION AGENT ----------------

app.post('/api/openrouter/run-agent', async (req, res) => {
  const { serverId, role, prompt, controlMode } = req.body;

  const server = db.connections.find((c) => c.id === serverId) || db.connections[0];
  const agentRole = role || 'SysAdmin';

  const systemPromptMap: Record<string, string> = {
    SysAdmin: `Eres el Agente Administrador de Sistemas Linux (SysAdmin Agent). Tu objetivo es mantener el sistema saludable, configurar servicios, diagnosticar problemas de rendimiento, y ejecutar mantenimiento.`,
    Security: `Eres el Agente Auditor de Seguridad Linux (Security Agent). Tu objetivo es detectar vulnerabilidades, auditar firewalls, revisar contraseñas débiles, auditar logs e implementar "hardening" del sistema operativo.`,
    DevOps: `Eres el Agente DevOps (DevOps Agent). Tu objetivo es desplegar aplicaciones, optimizar pipelines de CI/CD, administrar configuraciones como Ansible o Docker y automatizar tareas.`,
    Monitoring: `Eres el Agente de Monitoreo (Monitoring Agent). Tu especialidad es analizar la telemetria: uso de CPU, RAM, red, disco, alertando picos anómalos o fugas de memoria.`,
    Docker: `Eres el Agente Especialista en Docker (Docker Agent). Puedes listar, analizar, encender, apagar contenedores, revisar redes Docker y gestionar configuraciones complejas de Docker Compose.`,
    Networking: `Eres el Agente Especialista en redes Linux (Networking Agent). Tu objetivo es diagnosticar la conectividad de red, resolver DNS caídos, verificar puertos abiertos y configurar Firewalls.`,
    Backup: `Eres el Agente de Backups y Recuperación. Tareas: Programar CRONS de respaldo, verificar rotación de almacenamiento y verificar integridad de archivos históricos.`,
  };

  const sysInstruction = systemPromptMap[agentRole] + `
IMPORTANTE: Como agente inteligente, tu salida debe tener un análisis riguroso y explicar claramente los comandos antes de ejecutarlos.
Si el usuario te solicita una tarea, debes proponer una serie de pasos concretos de ejecución para resolver el problema.
Debes responder en formato JSON que respete la siguiente estructura:
{
  "explanation": "Una explicación detallada en español de la situación, los riesgos implicados y tu diagnóstico.",
  "riskLevel": "low" | "medium" | "high",
  "steps": [
    {
      "id": "paso-1",
      "title": "Breve titulo del paso",
      "description": "Explicación de lo que hace este comando en el servidor",
      "command": "Comando bash exacto a ejecutar",
      "risk": "low" | "medium" | "high"
    }
  ],
  "reportSummary": "Resumen ejecutivo para la pantalla de reporte."
}
`;

  const contextDoc = {
    serverName: server.name,
    osName: server.osName,
    cpuUsage: `${server.cpuUsage}%`,
    ramUsage: `${server.ramUsage}GB / ${server.ramTotal}GB`,
    diskUsage: `${server.diskUsage}%`,
    activeDockerContainers: db.dockerContainers[server.id]?.length || 0,
    activeServices: (db.services[server.id] || []).map((s) => `${s.name}: ${s.active}`).join(', '),
    activeRecentLogs: (db.logs[server.id] || []).slice(-5).map((l) => `[${l.level.toUpperCase()}] ${l.message}`).join('\n'),
  };

  const userInstructionPrompt = `
Contexto de Servidor Conectado:
${JSON.stringify(contextDoc, null, 2)}

Instrucción del operador humano:
"${prompt}"

Por favor, analiza la situación, provee un diagnóstico detallado, genera los comandos bash recomendados para solucionar el problema y devuelve el resultado respetando exclusivamente la estructura JSON solicitada.
`;

  if (!isOpenRouterConfigured()) {
    return res.status(503).json({
      error: 'OpenRouter no está configurado. Agregue OPENROUTER_API_KEY en el archivo .env y reinicie el servidor.',
    });
  }

  try {
    const rawResult = await requestOpenRouterCompletion(sysInstruction, userInstructionPrompt);
    let parsedData: any = null;

    const tryParseJson = (text: string): any | null => {
      if (!text || typeof text !== 'string') return null;

      const findJsonCandidates = (s: string): string[] => {
        const results: string[] = [];
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (ch !== '{' && ch !== '[') continue;
          const open = ch;
          const close = open === '{' ? '}' : ']';
          let depth = 0;
          let inString = false;
          let escape = false;
          for (let j = i; j < s.length; j++) {
            const c = s[j];
            if (escape) {
              escape = false;
              continue;
            }
            if (c === '\\') {
              escape = true;
              continue;
            }
            if (c === '"') {
              inString = !inString;
            }
            if (!inString) {
              if (c === open) depth++;
              else if (c === close) depth--;
              if (depth === 0) {
                results.push(s.slice(i, j + 1));
                i = j;
                break;
              }
            }
          }
        }
        return results;
      };

      const cleanup = (s: string) => s.replace(/\r\n/g, '\n').replace(/,\s*([}\]])/g, '$1');

      // 1) Try to find balanced JSON objects/arrays in the text and parse those candidates
      const candidates = findJsonCandidates(text);
      for (const cand of candidates) {
        try {
          const parsed = JSON.parse(cand);
          // Prefer parsed objects that include the expected keys
          if (
            parsed &&
            (Object.prototype.hasOwnProperty.call(parsed, 'explanation') || Object.prototype.hasOwnProperty.call(parsed, 'steps') || (typeof parsed === 'object' && parsed != null))
          ) {
            return parsed;
          }
        } catch (e) {
          // try cleaned variant next
          try {
            const cleaned = cleanup(cand).replace(/'/g, '"');
            const parsed2 = JSON.parse(cleaned);
            return parsed2;
          } catch (e2) {
            // continue
          }
        }
      }

      // 2) If no balanced candidates parsed, try to extract looser JSON by heuristics
      try {
        const loose = cleanup(text);
        return JSON.parse(loose);
      } catch (e) {
        // 3) Last-resort: try to normalize unquoted keys and single quotes
        try {
          const normalized = cleanup(text)
            .replace(/([\{,\n\s])([a-zA-Z0-9_\-]+)\s*:/g, '$1"$2":')
            .replace(/'/g, '"')
            .replace(/,\s*([}\]])/g, '$1');
          return JSON.parse(normalized);
        } catch (e2) {
          return null;
        }
      }
    };

    try {
      parsedData = tryParseJson(rawResult);
    } catch (parseErr) {
      parsedData = null;
    }

    if (!parsedData) {
      // keep the raw text for debugging and return as explanation fallback
      console.warn('Failed to parse AI output as JSON; returning raw text as explanation.');
      console.debug('Raw AI output preview:', rawResult.slice(0, 2000));
      parsedData = {
        explanation: rawResult.trim() || 'OpenRouter devolvió una respuesta vacía.',
        riskLevel: 'low',
        steps: [],
        reportSummary: 'Respuesta no estructurada de OpenRouter devuelta como explicación.',
      };
    }

    return res.json(parsedData);
  } catch (err: any) {
    console.error('OpenRouter Execution error:', err);
    return res.status(502).json({
      error: `Error al conectar con OpenRouter: ${err.message}. Verifique su API key y conexión a internet.`,
    });
  }
});

// ---------------- HARDENING / SECURITY SCAN ----------------

/** One-shot bash script — outputs KEY=VALUE lines, runs in a single SSH exec. */
const HARDENING_SCAN_SCRIPT = `
SSH_ROOT=$(grep -E "^PermitRootLogin" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -1);
SSH_PASSAUTH=$(grep -E "^PasswordAuthentication" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -1);
SSH_IDLE=$(grep -E "^ClientAliveInterval" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -1);
SSH_MAXAUTH=$(grep -E "^MaxAuthTries" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -1);
SSH_EMPTYPWD=$(grep -E "^PermitEmptyPasswords" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -1);
SSH_X11=$(grep -E "^X11Forwarding" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -1);
FW_UFW=$(ufw status 2>/dev/null | head -1 | grep -c "active" || echo 0);
FW_FWD=$(systemctl is-active firewalld 2>/dev/null | grep -c "^active$" || echo 0);
FW_IPT=$(iptables -L INPUT -n 2>/dev/null | grep -cE "DROP|REJECT" || echo 0);
OPEN_PORTS=$(ss -tlnp 2>/dev/null | grep LISTEN | awk '{print $4}' | sort -u | tr '\\n' ',' | sed 's/,$//');
ASLR=$(cat /proc/sys/kernel/randomize_va_space 2>/dev/null || echo "");
SELINUX=$(getenforce 2>/dev/null || echo "Disabled");
APPARMOR=$(aa-status 2>/dev/null | head -1 | grep -c "loaded" 2>/dev/null || echo 0);
IPFORWARD=$(sysctl -n net.ipv4.ip_forward 2>/dev/null || echo "");
SUID_DUMP=$(sysctl -n fs.suid_dumpable 2>/dev/null || echo "");
UID0=$(awk -F: '\$3==0{printf "%s,",\$1}' /etc/passwd 2>/dev/null | sed 's/,$//');
SUDO_NOPWD=$(grep -rh "NOPASSWD" /etc/sudoers /etc/sudoers.d/ 2>/dev/null | grep -v "^#" | wc -l | tr -d ' ' || echo 0);
EMPTY_PWD=$(awk -F: '(\$2==""||(\$2!~/^[!*]/&&length(\$2)<13))&&\$1!="root"{printf "%s,",\$1}' /etc/shadow 2>/dev/null | sed 's/,$//' || echo "");
WORLD_WRITE=$(find /etc /usr/bin /usr/sbin /bin /sbin -xdev -maxdepth 4 -type f -perm -o+w 2>/dev/null | head -5 | tr '\\n' ',' | sed 's/,$//');
SUID_FILES=$(find /usr/bin /usr/sbin /bin /sbin -xdev -user root -perm -4000 2>/dev/null | tr '\\n' ',' | sed 's/,$//');
INSEC_SVCS=$(systemctl list-units --state=running --type=service 2>/dev/null | grep -oE "(telnet|vsftpd|rsh|rlogin|rexec|tftp|xinetd)[^ ]*" | tr '\\n' ',' | sed 's/,$//' || echo "");
SRV_HOSTNAME=$(hostname 2>/dev/null);
SRV_OS=$(cat /etc/os-release 2>/dev/null | grep "^PRETTY_NAME" | cut -d= -f2 | tr -d '"' | head -1 || uname -r);
printf "SSH_ROOT=%s\\nSSH_PASSAUTH=%s\\nSSH_IDLE=%s\\nSSH_MAXAUTH=%s\\nSSH_EMPTYPWD=%s\\nSSH_X11=%s\\nFW_UFW=%s\\nFW_FWD=%s\\nFW_IPT=%s\\nOPEN_PORTS=%s\\nASLR=%s\\nSELINUX=%s\\nAPPARMOR=%s\\nIPFORWARD=%s\\nSUID_DUMP=%s\\nUID0=%s\\nSUDO_NOPWD=%s\\nEMPTY_PWD=%s\\nWORLD_WRITE=%s\\nSUID_FILES=%s\\nINSEC_SVCS=%s\\nSRV_HOSTNAME=%s\\nSRV_OS=%s\\n" "$SSH_ROOT" "$SSH_PASSAUTH" "$SSH_IDLE" "$SSH_MAXAUTH" "$SSH_EMPTYPWD" "$SSH_X11" "$FW_UFW" "$FW_FWD" "$FW_IPT" "$OPEN_PORTS" "$ASLR" "$SELINUX" "$APPARMOR" "$IPFORWARD" "$SUID_DUMP" "$UID0" "$SUDO_NOPWD" "$EMPTY_PWD" "$WORLD_WRITE" "$SUID_FILES" "$INSEC_SVCS" "$SRV_HOSTNAME" "$SRV_OS"
`.replace(/\n\s*/g, ' ').trim();

/** Parse KEY=VALUE lines from bash output into a plain object. */
function parseScanOutput(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    result[key] = val;
  }
  return result;
}

/** Build normalized HardeningPolicy objects from parsed scan data. */
function buildHardeningPolicies(d: Record<string, string>): any[] {
  const policies: any[] = [];
  const get = (k: string) => (d[k] || '').trim();

  // ── SSH Hardening ──────────────────────────────────────────────────────────
  const sshRoot = get('SSH_ROOT').toLowerCase();
  policies.push({
    policy_id: 'SSH-001',
    category: 'ssh_hardening',
    title: 'Root login deshabilitado',
    status: (!sshRoot || sshRoot === 'no' || sshRoot === 'prohibit-password') ? 'PASS' : 'FAIL',
    severity: 'HIGH',
    risk_score: (!sshRoot || sshRoot === 'no' || sshRoot === 'prohibit-password') ? 10 : 90,
    description: sshRoot === 'yes'
      ? 'El acceso root por SSH está habilitado — cualquier atacante puede intentar fuerza bruta directamente contra root.'
      : 'Acceso root por SSH deshabilitado o restringido a clave.',
    evidence: { PermitRootLogin: sshRoot || '(no definido — predeterminado: prohibit-password)', expected: 'no' },
    recommendation: {
      command: "sed -i 's/^PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config",
      restart: 'systemctl restart sshd',
    },
    compliance: [{ framework: 'CIS', control: '5.2.8' }, { framework: 'NIST-800-53', control: 'AC-6' }],
  });

  const sshPass = get('SSH_PASSAUTH').toLowerCase();
  policies.push({
    policy_id: 'SSH-002',
    category: 'ssh_hardening',
    title: 'Autenticación por contraseña deshabilitada',
    status: (sshPass === 'no') ? 'PASS' : 'FAIL',
    severity: 'HIGH',
    risk_score: (sshPass === 'no') ? 5 : 85,
    description: sshPass !== 'no'
      ? 'SSH permite autenticación por contraseña — vulnerable a ataques de diccionario y fuerza bruta.'
      : 'Solo se permite autenticación por clave pública.',
    evidence: { PasswordAuthentication: sshPass || 'yes (default)', expected: 'no' },
    recommendation: {
      command: "sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config",
      restart: 'systemctl restart sshd',
    },
    compliance: [{ framework: 'CIS', control: '5.2.13' }, { framework: 'NIST-800-53', control: 'IA-5' }],
  });

  const sshIdle = parseInt(get('SSH_IDLE') || '0', 10);
  policies.push({
    policy_id: 'SSH-003',
    category: 'ssh_hardening',
    title: 'Timeout de sesión inactiva configurado',
    status: (sshIdle > 0 && sshIdle <= 300) ? 'PASS' : (sshIdle > 300 ? 'WARN' : 'FAIL'),
    severity: 'MEDIUM',
    risk_score: (sshIdle > 0 && sshIdle <= 300) ? 10 : (sshIdle > 300 ? 40 : 60),
    description: sshIdle === 0
      ? 'No hay timeout configurado — sesiones SSH inactivas permanecen abiertas indefinidamente.'
      : `Timeout de sesión: ${sshIdle}s${sshIdle > 300 ? ' — valor mayor al recomendado (300s).' : '.'}`,
    evidence: { ClientAliveInterval: sshIdle || 0, expected: '≤300' },
    recommendation: {
      command: "sed -i 's/^#*ClientAliveInterval.*/ClientAliveInterval 300/' /etc/ssh/sshd_config && sed -i 's/^#*ClientAliveCountMax.*/ClientAliveCountMax 3/' /etc/ssh/sshd_config",
      restart: 'systemctl restart sshd',
    },
    compliance: [{ framework: 'CIS', control: '5.2.14' }, { framework: 'NIST-800-53', control: 'SC-10' }],
  });

  const sshMax = parseInt(get('SSH_MAXAUTH') || '6', 10);
  policies.push({
    policy_id: 'SSH-004',
    category: 'ssh_hardening',
    title: 'Máximo de intentos de autenticación limitado',
    status: (sshMax > 0 && sshMax <= 4) ? 'PASS' : 'FAIL',
    severity: 'MEDIUM',
    risk_score: (sshMax <= 4) ? 10 : 55,
    description: sshMax > 4
      ? `MaxAuthTries=${sshMax} — demasiados intentos antes de desconectar; facilita ataques de fuerza bruta.`
      : `MaxAuthTries=${sshMax} — límite adecuado.`,
    evidence: { MaxAuthTries: sshMax, expected: '≤4' },
    recommendation: {
      command: "sed -i 's/^#*MaxAuthTries.*/MaxAuthTries 4/' /etc/ssh/sshd_config",
      restart: 'systemctl restart sshd',
    },
    compliance: [{ framework: 'CIS', control: '5.2.7' }],
  });

  const sshEmpty = get('SSH_EMPTYPWD').toLowerCase();
  policies.push({
    policy_id: 'SSH-005',
    category: 'ssh_hardening',
    title: 'Contraseñas vacías prohibidas en SSH',
    status: (!sshEmpty || sshEmpty === 'no') ? 'PASS' : 'FAIL',
    severity: 'CRITICAL',
    risk_score: (!sshEmpty || sshEmpty === 'no') ? 5 : 100,
    description: sshEmpty === 'yes'
      ? 'SSH permite login con contraseña vacía — riesgo crítico de acceso no autorizado.'
      : 'Contraseñas vacías bloqueadas en SSH.',
    evidence: { PermitEmptyPasswords: sshEmpty || 'no (default)', expected: 'no' },
    recommendation: {
      command: "sed -i 's/^PermitEmptyPasswords yes/PermitEmptyPasswords no/' /etc/ssh/sshd_config",
      restart: 'systemctl restart sshd',
    },
    compliance: [{ framework: 'CIS', control: '5.2.9' }, { framework: 'NIST-800-53', control: 'IA-5' }],
  });

  const sshX11 = get('SSH_X11').toLowerCase();
  policies.push({
    policy_id: 'SSH-006',
    category: 'ssh_hardening',
    title: 'X11 Forwarding deshabilitado',
    status: (!sshX11 || sshX11 === 'no') ? 'PASS' : 'WARN',
    severity: 'LOW',
    risk_score: (!sshX11 || sshX11 === 'no') ? 5 : 30,
    description: sshX11 === 'yes'
      ? 'X11 Forwarding habilitado — puede ser explotado para ataques de captura de pantalla o inyección.'
      : 'X11 Forwarding deshabilitado.',
    evidence: { X11Forwarding: sshX11 || 'no (default)', expected: 'no' },
    recommendation: {
      command: "sed -i 's/^X11Forwarding yes/X11Forwarding no/' /etc/ssh/sshd_config",
      restart: 'systemctl restart sshd',
    },
    compliance: [{ framework: 'CIS', control: '5.2.6' }],
  });

  // ── Firewall ───────────────────────────────────────────────────────────────
  const fwUfw  = parseInt(get('FW_UFW')  || '0', 10);
  const fwFwd  = parseInt(get('FW_FWD')  || '0', 10);
  const fwIpt  = parseInt(get('FW_IPT')  || '0', 10);
  const fwActive = fwUfw > 0 || fwFwd > 0 || fwIpt > 0;
  policies.push({
    policy_id: 'FW-001',
    category: 'firewall',
    title: 'Firewall activo',
    status: fwActive ? 'PASS' : 'FAIL',
    severity: 'HIGH',
    risk_score: fwActive ? 10 : 88,
    description: fwActive
      ? `Firewall activo (UFW:${fwUfw > 0 ? 'sí' : 'no'}, firewalld:${fwFwd > 0 ? 'sí' : 'no'}, iptables rules:${fwIpt}).`
      : 'Ningún firewall detectado activo — todos los puertos están expuestos sin filtrado.',
    evidence: {
      ufw_active: fwUfw > 0 ? 'yes' : 'no',
      firewalld_active: fwFwd > 0 ? 'yes' : 'no',
      iptables_drop_rules: fwIpt,
    },
    recommendation: {
      command: 'systemctl enable --now firewalld',
      restart: 'firewall-cmd --permanent --zone=public --add-service=ssh && firewall-cmd --reload',
    },
    compliance: [{ framework: 'CIS', control: '3.5.1' }, { framework: 'NIST-800-53', control: 'SC-7' }],
  });

  const openPorts = get('OPEN_PORTS');
  const portList = openPorts ? openPorts.split(',').filter(Boolean) : [];
  const dangerousPorts = portList.filter(p => {
    const port = parseInt(p.split(':').pop() || '0', 10);
    return [23, 21, 69, 512, 513, 514, 2049, 6000].includes(port);
  });
  policies.push({
    policy_id: 'FW-002',
    category: 'firewall',
    title: 'Puertos inseguros expuestos',
    status: dangerousPorts.length === 0 ? 'PASS' : 'FAIL',
    severity: dangerousPorts.length > 0 ? 'HIGH' : 'LOW',
    risk_score: dangerousPorts.length > 0 ? 80 : 5,
    description: dangerousPorts.length > 0
      ? `Puertos peligrosos escuchando: ${dangerousPorts.join(', ')} (Telnet/FTP/RPC/NFS/X11)`
      : `${portList.length} puertos abiertos — sin puertos críticos detectados.`,
    evidence: { listening_ports: portList.slice(0, 10).join(', ') || 'ninguno', dangerous_ports: dangerousPorts.join(', ') || 'ninguno' },
    recommendation: {
      command: 'ss -tlnp | grep LISTEN  # auditar y cerrar los no necesarios',
    },
    compliance: [{ framework: 'CIS', control: '3.5.2' }, { framework: 'PCI-DSS', control: '1.1.6' }],
  });

  // ── Kernel Hardening ───────────────────────────────────────────────────────
  const aslr = parseInt(get('ASLR') || '0', 10);
  policies.push({
    policy_id: 'KERN-001',
    category: 'kernel_hardening',
    title: 'ASLR habilitado',
    status: aslr === 2 ? 'PASS' : (aslr === 1 ? 'WARN' : 'FAIL'),
    severity: aslr === 0 ? 'HIGH' : 'MEDIUM',
    risk_score: aslr === 2 ? 10 : (aslr === 1 ? 35 : 75),
    description: aslr === 2
      ? 'ASLR completo habilitado (randomize_va_space=2).'
      : aslr === 1
      ? 'ASLR parcial (=1) — protección incompleta contra explotación de memoria.'
      : 'ASLR deshabilitado (=0) — el sistema es vulnerable a ataques return-to-libc y heap spray.',
    evidence: { randomize_va_space: aslr, expected: 2 },
    recommendation: {
      command: "echo 'kernel.randomize_va_space = 2' >> /etc/sysctl.conf && sysctl -w kernel.randomize_va_space=2",
    },
    compliance: [{ framework: 'CIS', control: '1.5.1' }, { framework: 'NIST-800-53', control: 'SI-16' }],
  });

  const selinux = get('SELINUX');
  policies.push({
    policy_id: 'KERN-002',
    category: 'kernel_hardening',
    title: 'SELinux/AppArmor activo',
    status: (selinux === 'Enforcing') ? 'PASS' : (selinux === 'Permissive' ? 'WARN' : 'FAIL'),
    severity: (selinux === 'Enforcing') ? 'LOW' : 'HIGH',
    risk_score: selinux === 'Enforcing' ? 10 : (selinux === 'Permissive' ? 40 : 80),
    description: selinux === 'Enforcing'
      ? 'SELinux en modo Enforcing — políticas MAC activas.'
      : selinux === 'Permissive'
      ? 'SELinux en Permissive — registra pero no bloquea violaciones.'
      : 'SELinux deshabilitado — sin Mandatory Access Control en el sistema.',
    evidence: { selinux_status: selinux || 'Disabled', apparmor: parseInt(get('APPARMOR') || '0', 10) > 0 ? 'loaded' : 'inactive' },
    recommendation: {
      command: "sed -i 's/^SELINUX=.*/SELINUX=enforcing/' /etc/selinux/config && setenforce 1",
    },
    compliance: [{ framework: 'CIS', control: '1.6.1' }, { framework: 'NIST-800-53', control: 'AC-3' }],
  });

  const ipForward = get('IPFORWARD');
  policies.push({
    policy_id: 'KERN-003',
    category: 'kernel_hardening',
    title: 'IP Forwarding deshabilitado (no-router)',
    status: ipForward === '0' ? 'PASS' : (ipForward === '1' ? 'WARN' : 'INFO'),
    severity: ipForward === '1' ? 'MEDIUM' : 'LOW',
    risk_score: ipForward === '0' ? 5 : (ipForward === '1' ? 45 : 10),
    description: ipForward === '1'
      ? 'ip_forward=1 — el host puede enrutar tráfico de red. Peligroso en servidores que no son routers.'
      : 'IP forwarding deshabilitado — configuración correcta para un servidor estándar.',
    evidence: { net_ipv4_ip_forward: ipForward || 'unknown', expected: '0' },
    recommendation: {
      command: "sysctl -w net.ipv4.ip_forward=0 && echo 'net.ipv4.ip_forward = 0' >> /etc/sysctl.conf",
    },
    compliance: [{ framework: 'CIS', control: '3.1.1' }],
  });

  const suidDump = get('SUID_DUMP');
  policies.push({
    policy_id: 'KERN-004',
    category: 'kernel_hardening',
    title: 'Core dumps de binarios SUID deshabilitados',
    status: suidDump === '0' ? 'PASS' : 'FAIL',
    severity: 'MEDIUM',
    risk_score: suidDump === '0' ? 5 : 55,
    description: suidDump !== '0'
      ? 'suid_dumpable!=0 — procesos SUID pueden generar core dumps con datos sensibles del proceso.'
      : 'Core dumps de binarios SUID deshabilitados correctamente.',
    evidence: { fs_suid_dumpable: suidDump || 'unknown', expected: '0' },
    recommendation: {
      command: "sysctl -w fs.suid_dumpable=0 && echo 'fs.suid_dumpable = 0' >> /etc/sysctl.conf",
    },
    compliance: [{ framework: 'CIS', control: '1.5.4' }],
  });

  // ── Usuarios y permisos ────────────────────────────────────────────────────
  const uid0 = get('UID0');
  const uid0List = uid0 ? uid0.split(',').filter(Boolean) : ['root'];
  const extraUid0 = uid0List.filter(u => u !== 'root');
  policies.push({
    policy_id: 'USR-001',
    category: 'users_permissions',
    title: 'Sin usuarios extra con UID 0',
    status: extraUid0.length === 0 ? 'PASS' : 'FAIL',
    severity: 'CRITICAL',
    risk_score: extraUid0.length === 0 ? 5 : 95,
    description: extraUid0.length > 0
      ? `Cuentas con UID 0 adicionales: ${extraUid0.join(', ')} — privilegios root sin ser root.`
      : 'Solo root tiene UID 0.',
    evidence: { uid0_accounts: uid0List.join(', '), extra_root_accounts: extraUid0.join(', ') || 'ninguno' },
    recommendation: {
      command: `# Para cada cuenta extra: usermod -u <nuevo_uid> <usuario>`,
    },
    compliance: [{ framework: 'CIS', control: '5.4.2' }, { framework: 'NIST-800-53', control: 'AC-6' }],
  });

  const sudoNoPwd = parseInt(get('SUDO_NOPWD') || '0', 10);
  policies.push({
    policy_id: 'USR-002',
    category: 'users_permissions',
    title: 'Sin reglas sudo NOPASSWD',
    status: sudoNoPwd === 0 ? 'PASS' : 'FAIL',
    severity: sudoNoPwd > 0 ? 'HIGH' : 'LOW',
    risk_score: sudoNoPwd === 0 ? 5 : 85,
    description: sudoNoPwd > 0
      ? `${sudoNoPwd} regla(s) NOPASSWD en sudoers — permite escalada de privilegios sin contraseña.`
      : 'Sin reglas NOPASSWD en sudoers.',
    evidence: { nopasswd_entries: sudoNoPwd, expected: '0' },
    recommendation: {
      command: "grep -rn 'NOPASSWD' /etc/sudoers /etc/sudoers.d/  # revisar y eliminar entradas innecesarias",
    },
    compliance: [{ framework: 'CIS', control: '5.3.6' }, { framework: 'NIST-800-53', control: 'AC-6' }],
  });

  const emptyPwd = get('EMPTY_PWD');
  const emptyList = emptyPwd ? emptyPwd.split(',').filter(Boolean) : [];
  policies.push({
    policy_id: 'USR-003',
    category: 'users_permissions',
    title: 'Sin cuentas con contraseña vacía',
    status: emptyList.length === 0 ? 'PASS' : 'FAIL',
    severity: 'CRITICAL',
    risk_score: emptyList.length === 0 ? 5 : 100,
    description: emptyList.length > 0
      ? `Cuentas sin contraseña detectadas: ${emptyList.join(', ')} — acceso sin autenticación.`
      : 'Todas las cuentas tienen contraseña configurada.',
    evidence: { empty_password_accounts: emptyList.join(', ') || 'ninguno' },
    recommendation: {
      command: `passwd ${emptyList[0] || '<usuario>'}  # establecer contraseña segura`,
    },
    compliance: [{ framework: 'CIS', control: '5.4.1' }, { framework: 'NIST-800-53', control: 'IA-5' }],
  });

  // ── Integridad de archivos ─────────────────────────────────────────────────
  const worldWrite = get('WORLD_WRITE');
  const wwList = worldWrite ? worldWrite.split(',').filter(Boolean) : [];
  policies.push({
    policy_id: 'FILE-001',
    category: 'file_integrity',
    title: 'Sin archivos world-writable en directorios críticos',
    status: wwList.length === 0 ? 'PASS' : 'FAIL',
    severity: wwList.length > 0 ? 'HIGH' : 'LOW',
    risk_score: wwList.length === 0 ? 5 : 80,
    description: wwList.length > 0
      ? `Archivos escribibles por cualquier usuario: ${wwList.slice(0, 3).join(', ')}${wwList.length > 3 ? ` (+${wwList.length - 3} más)` : ''}`
      : 'Sin archivos world-writable en /etc, /usr/bin, /usr/sbin, /bin, /sbin.',
    evidence: { world_writable_files: wwList.join(', ') || 'ninguno', count: wwList.length },
    recommendation: {
      command: "find /etc /usr/bin /usr/sbin /bin /sbin -type f -perm -o+w -exec chmod o-w {} \\;",
    },
    compliance: [{ framework: 'CIS', control: '6.1.10' }, { framework: 'NIST-800-53', control: 'CM-6' }],
  });

  const suidFiles = get('SUID_FILES');
  const suidList = suidFiles ? suidFiles.split(',').filter(Boolean) : [];
  const unexpectedSuid = suidList.filter(f => ![
    '/usr/bin/passwd', '/usr/bin/sudo', '/usr/bin/su', '/usr/bin/newgrp',
    '/usr/bin/gpasswd', '/usr/bin/chfn', '/usr/bin/chsh', '/usr/bin/mount',
    '/usr/bin/umount', '/usr/bin/pkexec', '/bin/passwd', '/bin/sudo', '/bin/su',
    '/bin/mount', '/bin/umount', '/sbin/mount', '/sbin/umount',
  ].includes(f));
  policies.push({
    policy_id: 'FILE-002',
    category: 'file_integrity',
    title: 'Binarios SUID inesperados',
    status: unexpectedSuid.length === 0 ? 'PASS' : 'WARN',
    severity: unexpectedSuid.length > 0 ? 'MEDIUM' : 'LOW',
    risk_score: unexpectedSuid.length === 0 ? 10 : 60,
    description: unexpectedSuid.length > 0
      ? `Binarios SUID fuera de la lista esperada: ${unexpectedSuid.slice(0, 3).join(', ')}`
      : `${suidList.length} binarios SUID — todos dentro de la lista esperada.`,
    evidence: { suid_binaries: suidList.length, unexpected: unexpectedSuid.join(', ') || 'ninguno' },
    recommendation: {
      command: `find /usr/bin /usr/sbin /bin /sbin -perm -4000 -ls  # auditar y: chmod u-s <binario>`,
    },
    compliance: [{ framework: 'CIS', control: '6.1.13' }],
  });

  // ── Servicios inseguros ────────────────────────────────────────────────────
  const insecSvcs = get('INSEC_SVCS');
  const insecList = insecSvcs ? insecSvcs.split(',').filter(Boolean) : [];
  policies.push({
    policy_id: 'SVC-001',
    category: 'services',
    title: 'Servicios inseguros inactivos (Telnet/FTP/RSH/TFTP)',
    status: insecList.length === 0 ? 'PASS' : 'FAIL',
    severity: insecList.length > 0 ? 'CRITICAL' : 'LOW',
    risk_score: insecList.length === 0 ? 5 : 95,
    description: insecList.length > 0
      ? `Servicios inseguros activos: ${insecList.join(', ')} — transmiten datos en texto claro.`
      : 'Sin servicios legacy inseguros activos.',
    evidence: { running_insecure_services: insecList.join(', ') || 'ninguno' },
    recommendation: {
      command: `systemctl disable --now ${insecList[0] || 'telnet.service'}`,
    },
    compliance: [{ framework: 'CIS', control: '2.1' }, { framework: 'NIST-800-53', control: 'CM-7' }],
  });

  return policies;
}

/** Calculate global risk score: start at 100, deduct by severity+status. */
function calcHardeningScore(policies: any[]): number {
  let score = 100;
  for (const p of policies) {
    if (p.status === 'PASS' || p.status === 'INFO') continue;
    const deduct = p.status === 'FAIL'
      ? ({ CRITICAL: 15, HIGH: 10, MEDIUM: 5, LOW: 2 }[p.severity as string] ?? 3)
      : p.status === 'WARN'
      ? ({ CRITICAL: 6, HIGH: 4, MEDIUM: 2, LOW: 1 }[p.severity as string] ?? 1)
      : 0;
    score -= deduct;
  }
  return Math.max(0, Math.min(100, score));
}

/** Simulated scan result for demo servers without credentials. */
function generateSimulatedScan(serverName: string): any {
  const policies = [
    { policy_id: 'SSH-001', category: 'ssh_hardening', title: 'Root login deshabilitado', status: 'FAIL', severity: 'HIGH', risk_score: 90, description: 'El acceso root por SSH está habilitado.', evidence: { PermitRootLogin: 'yes', expected: 'no' }, recommendation: { command: "sed -i 's/^PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config", restart: 'systemctl restart sshd' }, compliance: [{ framework: 'CIS', control: '5.2.8' }, { framework: 'NIST-800-53', control: 'AC-6' }] },
    { policy_id: 'SSH-002', category: 'ssh_hardening', title: 'Autenticación por contraseña deshabilitada', status: 'FAIL', severity: 'HIGH', risk_score: 85, description: 'SSH permite autenticación por contraseña.', evidence: { PasswordAuthentication: 'yes', expected: 'no' }, recommendation: { command: "sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config", restart: 'systemctl restart sshd' }, compliance: [{ framework: 'CIS', control: '5.2.13' }] },
    { policy_id: 'SSH-003', category: 'ssh_hardening', title: 'Timeout de sesión inactiva configurado', status: 'PASS', severity: 'MEDIUM', risk_score: 10, description: 'ClientAliveInterval=300.', evidence: { ClientAliveInterval: 300, expected: '≤300' }, recommendation: { command: "sed -i 's/^#*ClientAliveInterval.*/ClientAliveInterval 300/' /etc/ssh/sshd_config" }, compliance: [{ framework: 'CIS', control: '5.2.14' }] },
    { policy_id: 'SSH-004', category: 'ssh_hardening', title: 'Máximo de intentos de autenticación limitado', status: 'PASS', severity: 'MEDIUM', risk_score: 10, description: 'MaxAuthTries=3.', evidence: { MaxAuthTries: 3, expected: '≤4' }, recommendation: { command: "sed -i 's/^#*MaxAuthTries.*/MaxAuthTries 4/' /etc/ssh/sshd_config" }, compliance: [{ framework: 'CIS', control: '5.2.7' }] },
    { policy_id: 'SSH-005', category: 'ssh_hardening', title: 'Contraseñas vacías prohibidas en SSH', status: 'PASS', severity: 'CRITICAL', risk_score: 5, description: 'PermitEmptyPasswords=no.', evidence: { PermitEmptyPasswords: 'no', expected: 'no' }, recommendation: { command: "sed -i 's/^PermitEmptyPasswords yes/PermitEmptyPasswords no/' /etc/ssh/sshd_config" }, compliance: [{ framework: 'CIS', control: '5.2.9' }] },
    { policy_id: 'FW-001', category: 'firewall', title: 'Firewall activo', status: 'WARN', severity: 'HIGH', risk_score: 65, description: 'UFW inactivo. iptables tiene 2 reglas de bloqueo activas.', evidence: { ufw_active: 'no', firewalld_active: 'no', iptables_drop_rules: 2 }, recommendation: { command: 'systemctl enable --now firewalld' }, compliance: [{ framework: 'CIS', control: '3.5.1' }] },
    { policy_id: 'FW-002', category: 'firewall', title: 'Puertos inseguros expuestos', status: 'PASS', severity: 'LOW', risk_score: 5, description: 'Sin puertos legacy peligrosos abiertos.', evidence: { listening_ports: '0.0.0.0:22, 0.0.0.0:80, 0.0.0.0:443', dangerous_ports: 'ninguno' }, recommendation: { command: 'ss -tlnp | grep LISTEN' }, compliance: [{ framework: 'CIS', control: '3.5.2' }] },
    { policy_id: 'KERN-001', category: 'kernel_hardening', title: 'ASLR habilitado', status: 'PASS', severity: 'HIGH', risk_score: 10, description: 'ASLR completo (randomize_va_space=2).', evidence: { randomize_va_space: 2, expected: 2 }, recommendation: { command: "echo 'kernel.randomize_va_space = 2' >> /etc/sysctl.conf" }, compliance: [{ framework: 'CIS', control: '1.5.1' }] },
    { policy_id: 'KERN-002', category: 'kernel_hardening', title: 'SELinux/AppArmor activo', status: 'FAIL', severity: 'HIGH', risk_score: 80, description: 'SELinux en modo Permissive — no bloquea violaciones.', evidence: { selinux_status: 'Permissive', apparmor: 'inactive' }, recommendation: { command: "setenforce 1 && sed -i 's/SELINUX=.*/SELINUX=enforcing/' /etc/selinux/config" }, compliance: [{ framework: 'CIS', control: '1.6.1' }] },
    { policy_id: 'KERN-003', category: 'kernel_hardening', title: 'IP Forwarding deshabilitado', status: 'PASS', severity: 'MEDIUM', risk_score: 5, description: 'net.ipv4.ip_forward=0.', evidence: { net_ipv4_ip_forward: '0', expected: '0' }, recommendation: { command: "sysctl -w net.ipv4.ip_forward=0" }, compliance: [{ framework: 'CIS', control: '3.1.1' }] },
    { policy_id: 'KERN-004', category: 'kernel_hardening', title: 'Core dumps de binarios SUID deshabilitados', status: 'PASS', severity: 'MEDIUM', risk_score: 5, description: 'fs.suid_dumpable=0.', evidence: { fs_suid_dumpable: '0', expected: '0' }, recommendation: { command: "sysctl -w fs.suid_dumpable=0" }, compliance: [{ framework: 'CIS', control: '1.5.4' }] },
    { policy_id: 'USR-001', category: 'users_permissions', title: 'Sin usuarios extra con UID 0', status: 'PASS', severity: 'CRITICAL', risk_score: 5, description: 'Solo root tiene UID 0.', evidence: { uid0_accounts: 'root', extra_root_accounts: 'ninguno' }, recommendation: { command: "awk -F: '$3==0' /etc/passwd" }, compliance: [{ framework: 'CIS', control: '5.4.2' }] },
    { policy_id: 'USR-002', category: 'users_permissions', title: 'Sin reglas sudo NOPASSWD', status: 'FAIL', severity: 'HIGH', risk_score: 85, description: '2 reglas NOPASSWD encontradas en /etc/sudoers.d/.', evidence: { nopasswd_entries: 2, expected: '0' }, recommendation: { command: "grep -rn 'NOPASSWD' /etc/sudoers /etc/sudoers.d/" }, compliance: [{ framework: 'CIS', control: '5.3.6' }] },
    { policy_id: 'USR-003', category: 'users_permissions', title: 'Sin cuentas con contraseña vacía', status: 'PASS', severity: 'CRITICAL', risk_score: 5, description: 'Todas las cuentas tienen contraseña.', evidence: { empty_password_accounts: 'ninguno' }, recommendation: { command: "awk -F: '$2==\"\"' /etc/shadow" }, compliance: [{ framework: 'CIS', control: '5.4.1' }] },
    { policy_id: 'FILE-001', category: 'file_integrity', title: 'Sin archivos world-writable en directorios críticos', status: 'PASS', severity: 'LOW', risk_score: 5, description: 'Sin archivos world-writable en /etc /usr/bin /sbin.', evidence: { world_writable_files: 'ninguno', count: 0 }, recommendation: { command: "find /etc /usr -type f -perm -o+w" }, compliance: [{ framework: 'CIS', control: '6.1.10' }] },
    { policy_id: 'FILE-002', category: 'file_integrity', title: 'Binarios SUID inesperados', status: 'PASS', severity: 'LOW', risk_score: 10, description: '12 binarios SUID — todos en la lista estándar.', evidence: { suid_binaries: 12, unexpected: 'ninguno' }, recommendation: { command: "find /usr/bin /bin -perm -4000 -ls" }, compliance: [{ framework: 'CIS', control: '6.1.13' }] },
    { policy_id: 'SVC-001', category: 'services', title: 'Servicios inseguros inactivos', status: 'PASS', severity: 'LOW', risk_score: 5, description: 'Sin servicios Telnet/FTP/RSH activos.', evidence: { running_insecure_services: 'ninguno' }, recommendation: { command: "systemctl list-units --state=running --type=service" }, compliance: [{ framework: 'CIS', control: '2.1' }] },
  ];
  const score = calcHardeningScore(policies);
  return {
    host: serverName,
    os: 'Demo Linux (Simulado)',
    scan_id: `scan-sim-${Date.now()}`,
    timestamp: new Date().toISOString(),
    summary: {
      passed: policies.filter(p => p.status === 'PASS').length,
      failed:  policies.filter(p => p.status === 'FAIL').length,
      warnings: policies.filter(p => p.status === 'WARN').length,
      critical: policies.filter(p => p.status === 'FAIL' && (p.severity === 'CRITICAL' || p.severity === 'HIGH')).length,
      score,
    },
    policies,
  };
}

app.post('/api/servers/:id/security-scan', async (req, res) => {
  const srv = db.connections.find((s: any) => s.id === req.params.id);
  if (!srv) return res.status(404).json({ error: 'Servidor no encontrado.' });

  // Simulated mode: no real credentials
  if (!srv.password && !srv.privateKey) {
    return res.json(generateSimulatedScan(srv.name));
  }

  try {
    const result = await runRealSSHCommandAsync(srv, HARDENING_SCAN_SCRIPT);
    const data = parseScanOutput(result.stdout);
    const policies = buildHardeningPolicies(data);
    const score = calcHardeningScore(policies);

    const scanResult = {
      host: data.SRV_HOSTNAME || srv.name,
      os: data.SRV_OS || srv.osName || 'Linux',
      scan_id: `scan-${Date.now()}`,
      timestamp: new Date().toISOString(),
      summary: {
        passed:   policies.filter((p: any) => p.status === 'PASS').length,
        failed:   policies.filter((p: any) => p.status === 'FAIL').length,
        warnings: policies.filter((p: any) => p.status === 'WARN').length,
        critical: policies.filter((p: any) => p.status === 'FAIL' && (p.severity === 'CRITICAL' || p.severity === 'HIGH')).length,
        score,
      },
      policies,
    };

    return res.json(scanResult);
  } catch (err: any) {
    return res.status(500).json({ error: `Error ejecutando scan: ${err.message}` });
  }
});

// ---------------- SSH TEST CONNECTION (no save) ----------------

app.post('/api/servers/test-connection', async (req, res) => {
  const { host, port, username, authType, password, privateKey, passphrase } = req.body;
  if (!host || !username) return res.status(400).json({ success: false, error: 'Host y usuario son requeridos.' });

  const tempConn: any = {
    host,
    port: Number(port) || 22,
    username,
    authType: authType || 'password',
    password: password || '',
    privateKey: privateKey || '',
  };
  if (passphrase) tempConn.passphrase = passphrase;

  const start = Date.now();
  try {
    const result = await runRealSSHCommandAsync(tempConn, 'echo __CONN_OK__');
    const latency = Date.now() - start;
    if ((result.stdout + result.stderr).includes('__CONN_OK__')) {
      return res.json({ success: true, latency });
    }
    return res.json({ success: false, error: result.stderr || 'El servidor no respondió correctamente.', latency });
  } catch (err: any) {
    return res.json({ success: false, error: err.message, latency: Date.now() - start });
  }
});

// ---------------- PLATFORM RUNTIME ENTRYWAYS ----------------

// Setup Dev vs Production Static file routing
async function initServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('Running Express in Development mode (Vite Middleware active).');
  } else {
    // Production static files deployment setup from Vite /dist
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log('Running Express in Production Mode serving static assets.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Linux AI Ops Server online at http://localhost:${PORT}`);
  });
}

initServer().catch((error) => {
  console.error('Fatal Server crash on startup:', error);
});
