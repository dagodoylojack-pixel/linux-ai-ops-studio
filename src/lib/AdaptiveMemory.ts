/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * AdaptiveMemory — Learns from solved problems and suggests solutions
 * Inspired by Ruflo's adaptive memory system
 */

export interface MemoryEntry {
  id: string;
  timestamp: number;
  serverId: string;
  problemDescription: string;
  symptoms: string[];
  solution: string;
  commandsExecuted: string[];
  riskLevel: 'low' | 'medium' | 'high';
  success: boolean;
  agentRole: string;
  tags: string[];
}

export interface ProblemSimilarity {
  entryId: string;
  similarity: number; // 0-1
  problem: MemoryEntry;
}

/**
 * Adaptive Memory stores solutions to problems and suggests similar solutions
 * when new problems arise. Persisted to SQLite.
 */
export class AdaptiveMemory {
  private memories: MemoryEntry[] = [];
  private dbKey = 'adaptive_memory_store';

  constructor() {
    this.loadFromLocalStorage();
  }

  /**
   * Record a successful solution
   */
  recordSolution(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): string {
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const memory: MemoryEntry = {
      ...entry,
      id,
      timestamp: Date.now(),
      tags: this.extractTags(entry.problemDescription, entry.solution),
    };
    this.memories.push(memory);
    this.saveToLocalStorage();
    return id;
  }

  /**
   * Find similar past problems and their solutions
   */
  findSimilarProblems(
    currentProblem: string,
    serverId: string,
    topN = 3
  ): ProblemSimilarity[] {
    return this.memories
      .filter((m) => m.success && m.serverId === serverId)
      .map((m) => ({
        entryId: m.id,
        similarity: this.calculateSimilarity(currentProblem, m.problemDescription),
        problem: m,
      }))
      .filter((m) => m.similarity > 0.5)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topN);
  }

  /**
   * Get all solutions for a specific agent role
   */
  getSolutionsByRole(role: string, serverId?: string): MemoryEntry[] {
    return this.memories.filter(
      (m) =>
        m.success &&
        m.agentRole === role &&
        (!serverId || m.serverId === serverId)
    );
  }

  /**
   * Get recent successful solutions (last 7 days)
   */
  getRecentSolutions(days = 7): MemoryEntry[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.memories.filter((m) => m.success && m.timestamp > cutoff);
  }

  /**
   * Calculate semantic similarity between two problem descriptions (0-1)
   * Uses simple keyword overlap as baseline
   */
  private calculateSimilarity(problem1: string, problem2: string): number {
    const normalize = (s: string) =>
      s.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const words1 = normalize(problem1);
    const words2 = normalize(problem2);
    const intersection = words1.filter((w) => words2.includes(w)).length;
    const union = new Set([...words1, ...words2]).size;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * Extract tags from problem and solution
   */
  private extractTags(problem: string, solution: string): string[] {
    const combined = `${problem} ${solution}`.toLowerCase();
    const keywords = [
      'cpu',
      'memory',
      'disk',
      'network',
      'ssh',
      'docker',
      'nginx',
      'mysql',
      'postgres',
      'timeout',
      'connection',
      'permission',
      'crash',
      'hang',
      'slow',
    ];
    return keywords.filter((k) => combined.includes(k));
  }

  /**
   * Persist to localStorage (for now; later → SQLite)
   */
  private saveToLocalStorage(): void {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(this.dbKey, JSON.stringify(this.memories));
      } catch (e) {
        console.warn('Failed to save adaptive memory:', e);
      }
    }
  }

  private loadFromLocalStorage(): void {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(this.dbKey);
        if (stored) {
          this.memories = JSON.parse(stored);
        }
      } catch (e) {
        console.warn('Failed to load adaptive memory:', e);
      }
    }
  }

  /**
   * Get all memories (for export/audit)
   */
  getAllMemories(): MemoryEntry[] {
    return [...this.memories];
  }

  /**
   * Clear memory (admin function)
   */
  clear(): void {
    this.memories = [];
    this.saveToLocalStorage();
  }
}
