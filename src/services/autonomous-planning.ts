/**
 * Autonomous Planning & Reflection System - Phase 1
 * 
 * Provides daily planning, evening reflection, and failure analysis
 * to enable true agent autonomy.
 */

import { getDatabase } from "../index.js";
import { getTaskStore, type Task } from "./agent/tasks.js";
import { appendToDailyLog, readDailyLog, getDailyLogPath } from "./daily-logs.js";
import { JournalStore, type JournalEntry } from "./journal-store.js";
import { createLogger } from "../utils/logger.js";
import type { SupportedProvider } from "../config/providers.js";
import { chatWithContext, getEffectiveApiKey } from "../agent/client.js";
import type { Config } from "../config/schema.js";

const log = createLogger("AutonomousAgent");

export interface DailyPlan {
  date: string;
  goals: string[];
  priorities: string[];
  scheduledTasks: Array<{
    time?: string;
    description: string;
    priority: number;
  }>;
  reflections?: string;
  createdAt: number;
}

export interface EveningReflection {
  date: string;
  accomplishments: string[];
  failures: Array<{
    description: string;
    rootCause: string;
    lesson: string;
    actionItem?: string;
  }>;
  insights: string[];
  tomorrowFocus: string[];
  mood?: "productive" | "neutral" | "challenging";
  createdAt: number;
}

export interface FailureAnalysis {
  timestamp: number;
  context: string;
  errorType: "tool_failure" | "llm_error" | "timeout" | "logic_error" | "external";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  rootCause?: string;
  suggestedFix?: string;
  taskCreated?: string;
}

export class AutonomousPlanningSystem {
  private config: Config;
  private journalStore: JournalStore;

  constructor(config: Config) {
    this.config = config;
    const db = getDatabase().getDb();
    this.journalStore = new JournalStore(db);
  }

  /**
   * Generate daily plan using LLM based on recent context and goals
   */
  async generateDailyPlan(date: Date = new Date()): Promise<DailyPlan> {
    const dateStr = this.formatDate(date);
    log.info(`Generating daily plan for ${dateStr}`);

    try {
      // Get recent context from daily logs
      const recentMemory = this.getRecentContext();
      
      // Get pending tasks
      const taskStore = getTaskStore(getDatabase().getDb());
      const pendingTasks = taskStore.listTasks({ status: "pending" });

      // Build prompt for planning
      const planningPrompt = `
You are an autonomous AI agent creating a daily plan.

Current Date: ${dateStr}

Recent Context:
${recentMemory || "No recent activity recorded."}

Pending Tasks:
${pendingTasks.length > 0 
  ? pendingTasks.map(t => `- [${t.priority}] ${t.description}`).join("\n")
  : "No pending tasks."}

Create a focused daily plan with:
1. Top 3-5 goals for today
2. Priority areas to focus on
3. Specific scheduled tasks with time slots if applicable

Format your response as JSON:
{
  "goals": ["goal 1", "goal 2", ...],
  "priorities": ["priority 1", "priority 2", ...],
  "scheduledTasks": [
    {"time": "09:00", "description": "task", "priority": 1},
    ...
  ]
}

Be realistic and focused. Quality over quantity.`;

      const response = await this.callLLM(planningPrompt);
      const planData = this.parseJSONResponse(response);

      const plan: DailyPlan = {
        date: dateStr,
        goals: planData.goals || [],
        priorities: planData.priorities || [],
        scheduledTasks: planData.scheduledTasks || [],
        createdAt: Date.now(),
      };

      // Log the plan
      this.logDailyPlan(plan);

      // Create tasks from the plan
      await this.createTasksFromPlan(plan);

      return plan;
    } catch (error) {
      log.error({ err: error }, "Failed to generate daily plan");
      throw error;
    }
  }

  /**
   * Generate evening reflection analyzing the day
   */
  async generateEveningReflection(date: Date = new Date()): Promise<EveningReflection> {
    const dateStr = this.formatDate(date);
    log.info(`Generating evening reflection for ${dateStr}`);

    try {
      // Get today's daily log
      const todayLog = readDailyLog(date) || "No activity logged today.";

      // Get completed tasks
      const taskStore = getTaskStore(getDatabase().getDb());
      const allTasks = taskStore.listTasks();
      const completedToday = allTasks.filter(t => 
        t.status === "done" && 
        t.completedAt && 
        this.isSameDay(t.completedAt, date)
      );

      // Get journal entries from today
      const todayEntries = this.journalStore.queryEntries({ 
        days: 1,
        limit: 50 
      });

      // Analyze failures from metrics/logs
      const failures = await this.analyzeTodayFailures(date);

      // Build reflection prompt
      const reflectionPrompt = `
You are reflecting on your day as an autonomous AI agent.

Date: ${dateStr}

Today's Activity Log:
${todayLog}

Completed Tasks:
${completedToday.length > 0
  ? completedToday.map(t => `✓ ${t.description}${t.result ? ` → ${t.result}` : ""}`).join("\n")
  : "No tasks completed."}

Journal Entries:
${todayEntries.length > 0
  ? todayEntries.map(e => `- [${e.type}] ${e.action}: ${e.reasoning || e.outcome}`).join("\n")
  : "No journal entries."}

Identified Failures/Issues:
${failures.length > 0
  ? failures.map(f => `⚠️ ${f.description} (${f.errorType})`).join("\n")
  : "No major failures detected."}

Reflect on:
1. What accomplishments are you proud of?
2. What failures or challenges occurred? What caused them?
3. What lessons did you learn?
4. What should you focus on tomorrow?

Respond in JSON format:
{
  "accomplishments": ["accomplishment 1", ...],
  "failures": [
    {"description": "...", "rootCause": "...", "lesson": "...", "actionItem": "..."}
  ],
  "insights": ["insight 1", ...],
  "tomorrowFocus": ["focus 1", ...],
  "mood": "productive|neutral|challenging"
}`;

      const response = await this.callLLM(reflectionPrompt);
      const reflectionData = this.parseJSONResponse(response);

      const reflection: EveningReflection = {
        date: dateStr,
        accomplishments: reflectionData.accomplishments || [],
        failures: reflectionData.failures || [],
        insights: reflectionData.insights || [],
        tomorrowFocus: reflectionData.tomorrowFocus || [],
        mood: reflectionData.mood || "neutral",
        createdAt: Date.now(),
      };

      // Log the reflection
      this.logEveningReflection(reflection);

      // Create action items from failures
      await this.createActionItemsFromReflection(reflection, failures);

      return reflection;
    } catch (error) {
      log.error({ err: error }, "Failed to generate evening reflection");
      throw error;
    }
  }

  /**
   * Analyze a failure and create improvement task
   */
  async analyzeFailure(failure: FailureAnalysis): Promise<void> {
    log.info(`Analyzing failure: ${failure.errorType} - ${failure.description}`);

    try {
      // If not already analyzed, perform root cause analysis
      if (!failure.rootCause) {
        const analysisPrompt = `
Analyze this failure and suggest a fix:

Error Type: ${failure.errorType}
Severity: ${failure.severity}
Description: ${failure.description}
Context: ${failure.context}

Provide:
1. Root cause analysis
2. Suggested fix or prevention strategy

Respond in JSON:
{"rootCause": "...", "suggestedFix": "..."}`;

        const response = await this.callLLM(analysisPrompt);
        const analysis = this.parseJSONResponse(response);
        failure.rootCause = analysis.rootCause;
        failure.suggestedFix = analysis.suggestedFix;
      }

      // Create task for fixing
      const taskStore = getTaskStore(getDatabase().getDb());
      const task = taskStore.createTask({
        description: `Fix: ${failure.description}`,
        priority: failure.severity === "critical" ? 10 : 
                  failure.severity === "high" ? 8 : 
                  failure.severity === "medium" ? 5 : 2,
        reason: `Failure Analysis: ${failure.rootCause}\n\nSuggested Fix: ${failure.suggestedFix}`,
        payload: JSON.stringify(failure),
      });

      failure.taskCreated = task.id;

      // Log the failure analysis
      this.logFailureAnalysis(failure);

      log.info(`Created task ${task.id} for failure resolution`);
    } catch (error) {
      log.error({ err: error }, "Failed to analyze failure");
    }
  }

  /**
   * Schedule daily planning (morning) and reflection (evening)
   */
  scheduleDailyCycle(): void {
    const taskStore = getTaskStore(getDatabase().getDb());

    // Schedule morning planning (7 AM)
    const planningTime = new Date();
    planningTime.setHours(7, 0, 0, 0);
    if (planningTime.getTime() < Date.now()) {
      planningTime.setDate(planningTime.getDate() + 1);
    }

    taskStore.createTask({
      description: "Generate daily plan",
      priority: 9,
      scheduledFor: planningTime,
      reason: "Autonomous daily planning cycle",
      recurrenceInterval: 24 * 60 * 60, // Daily
    });

    // Schedule evening reflection (9 PM)
    const reflectionTime = new Date();
    reflectionTime.setHours(21, 0, 0, 0);
    if (reflectionTime.getTime() < Date.now()) {
      reflectionTime.setDate(reflectionTime.getDate() + 1);
    }

    taskStore.createTask({
      description: "Generate evening reflection",
      priority: 9,
      scheduledFor: reflectionTime,
      reason: "Autonomous evening reflection cycle",
      recurrenceInterval: 24 * 60 * 60, // Daily
    });

    log.info("Daily planning/reflection cycle scheduled");
  }

  /**
   * Get self-monitoring dashboard data
   */
  getDashboardData(): {
    todayPlan?: DailyPlan;
    todayProgress: {
      completedTasks: number;
      totalTasks: number;
      goalsProgress: number;
    };
    recentFailures: FailureAnalysis[];
    streaks: {
      daysActive: number;
      plansCreated: number;
      reflectionsCompleted: number;
    };
    health: {
      errorRate: number;
      successRate: number;
      avgResponseTime?: number;
    };
  } {
    const today = new Date();
    const dateStr = this.formatDate(today);

    // Get today's plan (from log or regenerate)
    const todayLog = readDailyLog(today) || "";
    const planMatch = todayLog.match(/## Daily Plan.*?\n([\s\S]*?)(?=##|$)/);
    
    // Calculate progress
    const taskStore = getTaskStore(getDatabase().getDb());
    const allTasks = taskStore.listTasks();
    const todayTasks = allTasks.filter(t => 
      t.createdAt && this.isSameDay(t.createdAt, today)
    );
    const completedToday = todayTasks.filter(t => t.status === "done").length;

    // Get recent failures from journal
    const recentFailures = this.journalStore
      .queryEntries({ days: 7, limit: 20 })
      .filter(e => e.outcome === "loss" || e.outcome === "cancelled")
      .map(e => ({
        timestamp: e.timestamp * 1000,
        context: e.reasoning || "",
        errorType: "logic_error" as const,
        severity: "medium" as const,
        description: e.action,
      }));

    // Calculate streaks (simplified)
    const streaks = {
      daysActive: this.calculateActivityStreak(),
      plansCreated: this.countPlansLastWeek(),
      reflectionsCompleted: this.countReflectionsLastWeek(),
    };

    // Health metrics
    const totalOps = todayTasks.length + recentFailures.length;
    const successOps = completedToday;
    
    return {
      todayProgress: {
        completedTasks: completedToday,
        totalTasks: todayTasks.length,
        goalsProgress: totalOps > 0 ? Math.round((successOps / totalOps) * 100) : 0,
      },
      recentFailures,
      streaks,
      health: {
        errorRate: totalOps > 0 ? Math.round(((totalOps - successOps) / totalOps) * 100) : 0,
        successRate: totalOps > 0 ? Math.round((successOps / totalOps) * 100) : 100,
      },
    };
  }

  // ========== Private Helpers ==========

  private formatDate(date: Date): string {
    return date.toISOString().split("T")[0];
  }

  private isSameDay(date1: Date, date2: Date): boolean {
    return date1.getFullYear() === date2.getFullYear() &&
           date1.getMonth() === date2.getMonth() &&
           date1.getDate() === date2.getDate();
  }

  private getRecentContext(): string {
    // Get last 3 days of logs
    const parts: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const log = readDailyLog(date);
      if (log) {
        parts.push(`### ${this.formatDate(date)}\n${log.substring(0, 500)}...`);
      }
    }
    return parts.join("\n\n---\n\n");
  }

  private async callLLM(prompt: string): Promise<string> {
    const provider = (this.config.agent.provider || "anthropic") as SupportedProvider;
    const apiKey = getEffectiveApiKey(provider, this.config.agent.api_key);
    
    const messages = [
      { role: "user" as const, content: prompt }
    ];

    const response = await chatWithContext({
      provider,
      apiKey,
      model: this.config.agent.model,
      messages,
      maxTokens: 2048,
      temperature: 0.7,
    });

    return response.content;
  }

  private parseJSONResponse(response: string): any {
    // Extract JSON from markdown code blocks if present
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : response;
    
    try {
      return JSON.parse(jsonStr);
    } catch {
      // Try to extract just the object
      const objMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try {
          return JSON.parse(objMatch[0]);
        } catch {
          log.warn("Failed to parse JSON response");
          return {};
        }
      }
      return {};
    }
  }

  private async analyzeTodayFailures(date: Date): Promise<FailureAnalysis[]> {
    // This would integrate with error logging system
    // For now, return empty array - can be enhanced later
    return [];
  }

  private async createTasksFromPlan(plan: DailyPlan): Promise<void> {
    const taskStore = getTaskStore(getDatabase().getDb());

    // Create tasks from goals
    for (const goal of plan.goals) {
      taskStore.createTask({
        description: `Goal: ${goal}`,
        priority: 7,
        reason: `From daily plan ${plan.date}`,
      });
    }

    // Create scheduled tasks
    for (const scheduled of plan.scheduledTasks) {
      const scheduledTime = new Date();
      if (scheduled.time) {
        const [hours, minutes] = scheduled.time.split(":").map(Number);
        scheduledTime.setHours(hours, minutes, 0, 0);
      }

      taskStore.createTask({
        description: scheduled.description,
        priority: scheduled.priority,
        scheduledFor: scheduled.time ? scheduledTime : undefined,
        reason: `From daily plan ${plan.date}`,
      });
    }
  }

  private async createActionItemsFromReflection(
    reflection: EveningReflection,
    failures: FailureAnalysis[]
  ): Promise<void> {
    const taskStore = getTaskStore(getDatabase().getDb());

    // Create tasks from failure action items
    for (const failure of reflection.failures) {
      if (failure.actionItem) {
        taskStore.createTask({
          description: failure.actionItem,
          priority: 8,
          reason: `From evening reflection: ${failure.rootCause}`,
        });
      }
    }

    // Create tasks from identified failures
    for (const failure of failures) {
      if (failure.suggestedFix) {
        taskStore.createTask({
          description: `Fix: ${failure.description}`,
          priority: 6,
          reason: failure.suggestedFix,
        });
      }
    }
  }

  private logDailyPlan(plan: DailyPlan): void {
    const content = `## Daily Plan (${plan.date})

### Goals
${plan.goals.map(g => `- ${g}`).join("\n")}

### Priorities
${plan.priorities.map(p => `- ${p}`).join("\n")}

### Scheduled Tasks
${plan.scheduledTasks.map(t => 
  `- ${t.time || "Anytime"} [P${t.priority}]: ${t.description}`
).join("\n")}

---
`;
    appendToDailyLog(content);
  }

  private logEveningReflection(reflection: EveningReflection): void {
    const content = `## Evening Reflection (${reflection.date})

### Accomplishments
${reflection.accomplishments.map(a => `✓ ${a}`).join("\n")}

### Failures & Lessons
${reflection.failures.map(f => 
  `⚠️ ${f.description}\n  Cause: ${f.rootCause}\n  Lesson: ${f.lesson}${f.actionItem ? `\n  Action: ${f.actionItem}` : ""}`
).join("\n\n")}

### Insights
${reflection.insights.map(i => `- ${i}`).join("\n")}

### Tomorrow's Focus
${reflection.tomorrowFocus.map(f => `- ${f}`).join("\n")}

### Mood: ${reflection.mood}

---
`;
    appendToDailyLog(content);
  }

  private logFailureAnalysis(failure: FailureAnalysis): void {
    const content = `## Failure Analysis

**Time**: ${new Date(failure.timestamp).toISOString()}
**Type**: ${failure.errorType}
**Severity**: ${failure.severity}
**Description**: ${failure.description}
**Root Cause**: ${failure.rootCause || "Not analyzed"}
**Suggested Fix**: ${failure.suggestedFix || "None"}
${failure.taskCreated ? `**Task Created**: ${failure.taskCreated}` : ""}

---
`;
    appendToDailyLog(content);
  }

  private calculateActivityStreak(): number {
    // Simplified - count consecutive days with logs
    let streak = 0;
    const today = new Date();
    
    for (let i = 0; i < 365; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const log = readDailyLog(date);
      if (log && log.trim().length > 50) {
        streak++;
      } else if (i > 0) {
        break;
      }
    }
    
    return streak;
  }

  private countPlansLastWeek(): number {
    let count = 0;
    const today = new Date();
    
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const log = readDailyLog(date);
      if (log && log.includes("## Daily Plan")) {
        count++;
      }
    }
    
    return count;
  }

  private countReflectionsLastWeek(): number {
    let count = 0;
    const today = new Date();
    
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const log = readDailyLog(date);
      if (log && log.includes("## Evening Reflection")) {
        count++;
      }
    }
    
    return count;
  }
}

// Singleton instance
let _instance: AutonomousPlanningSystem | null = null;

export function initAutonomousPlanning(config: Config): AutonomousPlanningSystem {
  _instance = new AutonomousPlanningSystem(config);
  return _instance;
}

export function getAutonomousPlanning(): AutonomousPlanningSystem | null {
  return _instance;
}
