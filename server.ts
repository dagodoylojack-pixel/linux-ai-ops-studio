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
      stream
        .on('close', (code: number) => {
          ssh.end();
          callback(null, { stdout, stderr, exitCode: code });
        })
        .on('data', (data: Buffer) => {
          stdout += data.toString();
        })
        .stderr.on('data', (data: Buffer) => {
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
    readyTimeout: 10000,
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
const STATE_CACHE_TTL = 12000;

async function fetchRealServerState(server: any) {
  const run = (cmd: string) =>
    runRealSSHCommandAsync(server, cmd).catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));

  const [cpuRes, memRes, diskRes, uptimeRes, psRes, svcRes, dockerRes, logRes, cronRes, osRes, tempRes, usersRes] =
    await Promise.all([
      run("top -bn1 | grep '%Cpu\\|Cpu(s)' | awk '{for(i=1;i<=NF;i++) if($i~/^[0-9]/ && $(i-1)~/id/) print 100-$i}' | head -1"),
      run("free -m | awk '/Mem:/{print $2,$3}'"),
      run("df -h / | awk 'NR==2{print $2,$3,$5}'"),
      run('uptime -p 2>/dev/null || uptime'),
      run('ps aux --sort=-%cpu | head -21'),
      run('systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -30'),
      run("docker ps -a --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null"),
      run('journalctl -n 25 --no-pager -o short 2>/dev/null || tail -n 25 /var/log/syslog 2>/dev/null || tail -n 25 /var/log/messages 2>/dev/null'),
      run('crontab -l 2>/dev/null'),
      run("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'\"' -f2"),
      run("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk '{printf \"%.0f\",$1/1000}'"),
      run("who | awk '{print $1}' | sort -u | head -5"),
    ]);

  const cpuUsage = Math.min(100, Math.max(0, parseFloat(cpuRes.stdout.trim()) || 0));

  const [ramTotalMb, ramUsedMb] = memRes.stdout.trim().split(' ').map(Number);
  const ramTotal = parseFloat(((ramTotalMb || 0) / 1024).toFixed(1));
  const ramUsage = parseFloat(((ramUsedMb || 0) / 1024).toFixed(1));

  const diskParts = diskRes.stdout.trim().split(' ');
  const diskTotal = parseFloat(diskParts[0]) || 0;
  const diskUsagePct = parseFloat((diskParts[2] || '0%').replace('%', '')) || 0;

  const processes = psRes.stdout
    .trim()
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

  const services = svcRes.stdout
    .trim()
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

  const dockerContainers = dockerRes.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id = '', name = '', image = '', status = '', ports = ''] = line.split('\t');
      return { id, name, image, command: '', created: '', status, ports, cpu: 0, mem: '—' };
    })
    .filter((c) => c.id);

  const logs = logRes.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      const lower = line.toLowerCase();
      const level = lower.includes('error') || lower.includes('fail') ? 'error'
        : lower.includes('warn') ? 'warn' : 'info';
      return { id: `log-${i}`, timestamp: new Date().toISOString(), service: 'system', level, message: line.slice(0, 300) };
    });

  const cronJobs = cronRes.stdout
    .trim()
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((line, i) => {
      const p = line.split(/\s+/);
      return { id: `c${i}`, schedule: p.slice(0, 5).join(' '), command: p.slice(5).join(' '), description: `Cron ${i + 1}`, active: true };
    });

  const updatedServer = {
    ...server,
    status: 'online' as const,
    cpuUsage: Math.round(cpuUsage),
    ramUsage,
    ramTotal,
    diskUsage: diskUsagePct,
    diskTotal,
    uptime: uptimeRes.stdout.trim() || server.uptime || '—',
    osName: osRes.stdout.trim() || server.osName || 'Linux',
    temperature: parseInt(tempRes.stdout.trim()) || 0,
    usersConnected: usersRes.stdout.trim().split('\n').filter(Boolean),
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
    const idx = db.connections.findIndex((c) => c.id === id);
    if (idx >= 0) db.connections[idx].status = 'offline';
    return res.json({
      server: { ...serv, status: 'offline' }, processes: [], services: [], dockerContainers: [],
      files: db.files[id] || [], logs: [], cronJobs: [], securityAssets: db.securityAssets[id] || [],
    });
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
      host: server.host, port: server.port, username: server.username, readyTimeout: 10000,
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

// SFTP — download file as binary stream (browser download)
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

  ssh.on('error', (err: any) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  const cfg: any = {
    host: serv.host, port: serv.port, username: serv.username, readyTimeout: 10000,
  };
  if (serv.authType === 'password') cfg.password = serv.password;
  else cfg.privateKey = serv.privateKey;

  try { ssh.connect(cfg); } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
  }
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

// SFTP — upload file from browser (base64 encoded binary)
app.post('/api/servers/:id/sftp/upload', async (req, res) => {
  const serv = db.connections.find((c) => c.id === req.params.id);
  if (!serv) return res.status(404).json({ error: 'Server not found.' });
  if (!serv.password && !serv.privateKey) return res.status(400).json({ error: 'No credentials configured.' });

  const { path: remotePath, content, filename } = req.body;
  if (!remotePath || !content || !filename) {
    return res.status(400).json({ error: 'path, content, and filename are required.' });
  }

  const buf = Buffer.from(content, 'base64');
  const targetPath = (remotePath === '/' ? '' : remotePath) + '/' + filename;

  try {
    await withSFTP(serv, (sftp) => new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(targetPath);
      ws.on('close', () => resolve());
      ws.on('error', (e: any) => reject(e));
      ws.end(buf);
    }));
    res.json({ success: true, path: targetPath });
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
