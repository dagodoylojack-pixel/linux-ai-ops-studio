/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ServerConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  password?: string;
  privateKey?: string;
  status: 'online' | 'offline' | 'connecting';
  uptime?: string;
  osName?: string;
  cpuModel?: string;
  cpuCores?: number;
  cpuUsage?: number;
  ramUsage?: number;
  ramTotal?: number; // GB
  diskUsage?: number;
  diskTotal?: number; // GB
  rxRate?: number; // KB/s
  txRate?: number; // KB/s
  temperature?: number; // Celsius
  usersConnected?: string[];
}

export interface LinuxProcess {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  vsz: number;
  rss: number;
  tty: string;
  stat: string;
  start: string;
  time: string;
  command: string;
}

export interface SystemService {
  name: string;
  loaded: string;
  active: string;
  sub: string;
  description: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  command: string;
  created: string;
  status: string;
  ports: string;
  cpu: number; // Simulated utilization %
  mem: string; // Used / limit
}

export interface TerminalLine {
  id: string;
  type: 'input' | 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp: string;
}

export interface LogLine {
  id: string;
  timestamp: string;
  service: string;
  level: 'info' | 'warn' | 'error' | 'critical';
  message: string;
  aiClassification?: string;
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  category: 'DevOps' | 'Security' | 'SysAdmin' | 'Backup';
  content: string; // Shell script or structural instructions
  stepsCount: number;
}

export interface CronJob {
  id: string;
  schedule: string;
  command: string;
  description: string;
  active: boolean;
}

export type AgentRole =
  | 'SysAdmin'
  | 'Security'
  | 'DevOps'
  | 'Monitoring'
  | 'Docker'
  | 'Networking'
  | 'Backup';

export type AIControlMode = 'suggestion' | 'semi-autonomous' | 'fully-autonomous';

export interface AIAgent {
  role: AgentRole;
  name: string;
  description: string;
  icon: string;
  systemPrompt: string;
  capabilities: string[];
}

export interface AuditLog {
  id: string;
  timestamp: string;
  serverId: string;
  serverName: string;
  agentRole: AgentRole;
  commandExecuted: string;
  success: boolean;
  outputSummary: string;
  mode: AIControlMode;
  userApproved: boolean;
}

export interface SecurityAsset {
  id: string;
  name: string;
  category: 'port' | 'user' | 'vulnerability' | 'firewall';
  status: 'secure' | 'warning' | 'danger';
  details: string;
}

export interface LinuxFile {
  path: string;
  content: string;
  type: 'conf' | 'json' | 'yaml' | 'script' | 'text';
  description: string;
}

export interface SFTPEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mode: number;
  mtime: number;
}

export interface AIActionStep {
  id: string;
  title: string;
  description: string;
  command: string;
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'rejected' | 'running' | 'success' | 'failed';
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  retryCount?: number;       // fully-autonomous: tracks repair attempts for this step
}

export interface AIChatMessage {
  id: string;
  sender: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string;
  steps?: AIActionStep[];
  suggestedCommands?: string[];
  reportSummary?: string;
  requiresConfirmation?: boolean;
  confirmationState?: 'pending' | 'confirmed' | 'declined';
  modeWhenCreated?: AIControlMode;  // mode active when plan was generated
}

// ── Hardening Scan ────────────────────────────────────────────────────────────

export type HardeningStatus   = 'PASS' | 'FAIL' | 'WARN' | 'INFO' | 'ERROR';
export type HardeningSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface HardeningCompliance {
  framework: string;
  control: string;
}

export interface HardeningRecommendation {
  command: string;
  restart?: string;
}

export interface HardeningPolicy {
  policy_id: string;
  category: string;
  title: string;
  status: HardeningStatus;
  severity: HardeningSeverity;
  risk_score: number;
  description: string;
  evidence: Record<string, string | number | boolean>;
  recommendation: HardeningRecommendation;
  compliance: HardeningCompliance[];
}

export interface HardeningScanSummary {
  passed: number;
  failed: number;
  warnings: number;
  critical: number;
  score: number;
}

export interface HardeningScanResult {
  host: string;
  os: string;
  scan_id: string;
  timestamp: string;
  summary: HardeningScanSummary;
  policies: HardeningPolicy[];
}
