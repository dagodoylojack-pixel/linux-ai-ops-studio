/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * WorkflowOrchestrator — Coordinates multiple agents in parallel
 * Inspired by Ruflo's orchestration system
 */

import { AgentRole, AIActionStep } from '../types';

export interface AgentTask {
  id: string;
  agentRole: AgentRole;
  prompt: string;
  priority: 'low' | 'normal' | 'high';
  dependsOn?: string[]; // IDs of tasks that must complete first
  timeout: number; // ms
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: AIActionStep[];
  error?: string;
  startTime?: number;
  endTime?: number;
}

export interface OrchestrationPlan {
  id: string;
  serverId: string;
  tasks: AgentTask[];
  executionMode: 'sequential' | 'parallel';
  status: 'created' | 'running' | 'completed' | 'failed';
  completedAt?: number;
  summary?: string;
}

/**
 * WorkflowOrchestrator manages execution of multiple agent tasks
 * Can run them sequentially or in parallel based on dependencies
 */
export class WorkflowOrchestrator {
  private plans: Map<string, OrchestrationPlan> = new Map();

  /**
   * Create a new orchestration plan from multiple agent prompts
   */
  createPlan(
    serverId: string,
    agents: Array<{
      role: AgentRole;
      prompt: string;
      priority?: 'low' | 'normal' | 'high';
    }>,
    mode: 'sequential' | 'parallel' = 'parallel'
  ): OrchestrationPlan {
    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const tasks: AgentTask[] = agents.map((a, idx) => ({
      id: `task-${idx}`,
      agentRole: a.role,
      prompt: a.prompt,
      priority: a.priority || 'normal',
      timeout: 30000, // 30s per task
      status: 'pending',
    }));

    const plan: OrchestrationPlan = {
      id: planId,
      serverId,
      tasks,
      executionMode: mode,
      status: 'created',
    };

    this.plans.set(planId, plan);
    return plan;
  }

  /**
   * Get a plan by ID
   */
  getPlan(planId: string): OrchestrationPlan | undefined {
    return this.plans.get(planId);
  }

  /**
   * Get all tasks for a plan
   */
  getTasks(planId: string): AgentTask[] {
    const plan = this.plans.get(planId);
    return plan ? plan.tasks : [];
  }

  /**
   * Get tasks for a specific agent in a plan
   */
  getTasksByAgent(planId: string, agentRole: AgentRole): AgentTask[] {
    return this.getTasks(planId).filter((t) => t.agentRole === agentRole);
  }

  /**
   * Mark a task as completed
   */
  completeTask(
    planId: string,
    taskId: string,
    result: AIActionStep[]
  ): AgentTask | undefined {
    const plan = this.plans.get(planId);
    if (!plan) return undefined;

    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return undefined;

    task.status = 'completed';
    task.result = result;
    task.endTime = Date.now();

    // Check if plan is complete
    this.updatePlanStatus(planId);

    return task;
  }

  /**
   * Mark a task as failed
   */
  failTask(planId: string, taskId: string, error: string): AgentTask | undefined {
    const plan = this.plans.get(planId);
    if (!plan) return undefined;

    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return undefined;

    task.status = 'failed';
    task.error = error;
    task.endTime = Date.now();

    // Check if plan should fail
    this.updatePlanStatus(planId);

    return task;
  }

  /**
   * Get next task to execute based on dependencies and mode
   */
  getNextTask(planId: string): AgentTask | undefined {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'running') return undefined;

    const pending = plan.tasks.filter((t) => t.status === 'pending');
    if (pending.length === 0) return undefined;

    if (plan.executionMode === 'parallel') {
      // In parallel mode, return all tasks with no unsatisfied dependencies
      return pending.find(
        (t) =>
          !t.dependsOn ||
          t.dependsOn.every((depId) => {
            const dep = plan.tasks.find((tt) => tt.id === depId);
            return dep?.status === 'completed';
          })
      );
    } else {
      // In sequential mode, return first pending task with satisfied dependencies
      return pending[0];
    }
  }

  /**
   * Start execution of a plan
   */
  startPlan(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'created') return false;

    plan.status = 'running';
    plan.tasks.forEach((t) => {
      t.status = 'pending';
      t.startTime = Date.now();
    });

    return true;
  }

  /**
   * Check if plan is complete and update status
   */
  private updatePlanStatus(planId: string): void {
    const plan = this.plans.get(planId);
    if (!plan) return;

    const allTasksComplete = plan.tasks.every(
      (t) => t.status === 'completed' || t.status === 'failed'
    );

    if (allTasksComplete) {
      const hasFailed = plan.tasks.some((t) => t.status === 'failed');
      plan.status = hasFailed ? 'failed' : 'completed';
      plan.completedAt = Date.now();

      // Generate summary
      plan.summary = this.generateSummary(plan);
    }
  }

  /**
   * Generate a summary of plan execution
   */
  private generateSummary(plan: OrchestrationPlan): string {
    const completed = plan.tasks.filter((t) => t.status === 'completed').length;
    const failed = plan.tasks.filter((t) => t.status === 'failed').length;
    const duration = plan.completedAt
      ? `${((plan.completedAt - (plan.tasks[0]?.startTime || 0)) / 1000).toFixed(1)}s`
      : 'N/A';

    return `Executed ${plan.tasks.length} agent tasks (${completed} ✓, ${failed} ✗) in ${duration}`;
  }

  /**
   * Get execution timeline (for UI visualization)
   */
  getTimeline(planId: string): Array<{
    taskId: string;
    agentRole: AgentRole;
    status: AgentTask['status'];
    duration?: number;
  }> {
    const plan = this.plans.get(planId);
    if (!plan) return [];

    return plan.tasks.map((t) => ({
      taskId: t.id,
      agentRole: t.agentRole,
      status: t.status,
      duration: t.endTime && t.startTime ? t.endTime - t.startTime : undefined,
    }));
  }

  /**
   * Clear completed plans (cleanup)
   */
  clearCompletedPlans(olderThanMs: number = 3600000): number {
    let cleared = 0;
    const cutoff = Date.now() - olderThanMs;

    for (const [id, plan] of this.plans) {
      if (
        (plan.status === 'completed' || plan.status === 'failed') &&
        plan.completedAt &&
        plan.completedAt < cutoff
      ) {
        this.plans.delete(id);
        cleared++;
      }
    }

    return cleared;
  }

  /**
   * Get all active plans
   */
  getActivePlans(): OrchestrationPlan[] {
    return Array.from(this.plans.values()).filter(
      (p) => p.status === 'running' || p.status === 'created'
    );
  }
}
