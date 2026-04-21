/**
 * Autonomous Planning API Routes - Phase 2 Enhanced
 * 
 * Endpoints for daily planning, evening reflection, failure analysis, and health monitoring
 */

import { Hono } from "hono";
import { getAutonomousPlanning } from "../../services/autonomous-planning.js";
import { getTaskStore } from "../../memory/agent/tasks.js";
import { getDatabase } from "../../memory/index.js";
import { createLogger } from "../../utils/logger.js";
import { FailureAnalyzer, SelfHealthMonitor } from "../../agent/services/index.js";
import type { ErrorContext, HealthMetrics } from "../../agent/services/index.js";

const log = createLogger("WebUI:Autonomous");

// Singleton instances for Phase 2 services
let failureAnalyzer: FailureAnalyzer | null = null;
let healthMonitor: SelfHealthMonitor | null = null;

function getFailureAnalyzer(): FailureAnalyzer {
  if (!failureAnalyzer) {
    // We'll need to inject the task manager properly in production
    failureAnalyzer = new FailureAnalyzer({
      addTask: (task: any) => {
        const db = getDatabase().getDb();
        const taskStore = getTaskStore(db);
        taskStore.createTask({
          description: task.title,
          priority: task.priority === 'high' ? 1 : task.priority === 'medium' ? 2 : 3,
          payload: task,
        });
      }
    } as any);
  }
  return failureAnalyzer;
}

function getHealthMonitor(): SelfHealthMonitor {
  if (!healthMonitor) {
    healthMonitor = new SelfHealthMonitor();
  }
  return healthMonitor;
}

export function registerAutonomousRoutes(app: Hono): void {
  const router = new Hono();

  /**
   * GET /dashboard - Get self-monitoring dashboard data
   */
  router.get("/dashboard", (c) => {
    try {
      const planning = getAutonomousPlanning();
      if (!planning) {
        return c.json({ error: "Autonomous planning not initialized" }, 503);
      }

      const data = planning.getDashboardData();
      return c.json(data);
    } catch (error) {
      log.error({ err: error }, "Failed to get dashboard data");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /plan/daily - Generate daily plan
   */
  router.post("/plan/daily", async (c) => {
    try {
      const planning = getAutonomousPlanning();
      if (!planning) {
        return c.json({ error: "Autonomous planning not initialized" }, 503);
      }

      const body = await c.req.json().catch(() => ({}));
      const date = body.date ? new Date(body.date) : new Date();

      const plan = await planning.generateDailyPlan(date);
      return c.json({ success: true, plan });
    } catch (error) {
      log.error({ err: error }, "Failed to generate daily plan");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /reflection/evening - Generate evening reflection
   */
  router.post("/reflection/evening", async (c) => {
    try {
      const planning = getAutonomousPlanning();
      if (!planning) {
        return c.json({ error: "Autonomous planning not initialized" }, 503);
      }

      const body = await c.req.json().catch(() => ({}));
      const date = body.date ? new Date(body.date) : new Date();

      const reflection = await planning.generateEveningReflection(date);
      return c.json({ success: true, reflection });
    } catch (error) {
      log.error({ err: error }, "Failed to generate evening reflection");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /failure/analyze - Analyze a failure and create improvement task
   */
  router.post("/failure/analyze", async (c) => {
    try {
      const planning = getAutonomousPlanning();
      if (!planning) {
        return c.json({ error: "Autonomous planning not initialized" }, 503);
      }

      const body = await c.req.json();
      const { context, errorType, severity, description } = body;

      if (!context || !errorType || !severity || !description) {
        return c.json(
          { error: "Missing required fields: context, errorType, severity, description" },
          400
        );
      }

      const failure = {
        timestamp: Date.now(),
        context,
        errorType,
        severity,
        description,
      };

      await planning.analyzeFailure(failure);
      return c.json({ success: true, failure });
    } catch (error) {
      log.error({ err: error }, "Failed to analyze failure");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /health/metrics - Record health metrics
   */
  router.post("/health/metrics", async (c) => {
    try {
      const monitor = getHealthMonitor();
      const body = await c.req.json() as HealthMetrics;

      if (!body.timestamp || !body.tokenUsage || !body.toolExecution) {
        return c.json(
          { error: "Missing required fields: timestamp, tokenUsage, toolExecution" },
          400
        );
      }

      monitor.recordMetrics(body);
      const status = monitor.getHealthStatus();

      return c.json({ success: true, status });
    } catch (error) {
      log.error({ err: error }, "Failed to record health metrics");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /health/status - Get current health status
   */
  router.get("/health/status", (c) => {
    try {
      const monitor = getHealthMonitor();
      const status = monitor.getHealthStatus();
      return c.json(status);
    } catch (error) {
      log.error({ err: error }, "Failed to get health status");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /health/alerts - Get recent health alerts
   */
  router.get("/health/alerts", (c) => {
    try {
      const monitor = getHealthMonitor();
      const limit = parseInt(c.req.query("limit") || "10", 10);
      const alerts = monitor.getRecentAlerts(limit);
      return c.json({ alerts });
    } catch (error) {
      log.error({ err: error }, "Failed to get health alerts");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /health/history - Get metrics history for charting
   */
  router.get("/health/history", (c) => {
    try {
      const monitor = getHealthMonitor();
      const limit = parseInt(c.req.query("limit") || "20", 10);
      const history = monitor.getMetricsHistory(limit);
      return c.json({ history });
    } catch (error) {
      log.error({ err: error }, "Failed to get metrics history");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /tool/error - Report tool execution error for auto-analysis
   */
  router.post("/tool/error", async (c) => {
    try {
      const analyzer = getFailureAnalyzer();
      const body = await c.req.json() as {
        toolName: string;
        errorMessage: string;
        parameters?: Record<string, any>;
        stackTrace?: string;
      };

      if (!body.toolName || !body.errorMessage) {
        return c.json(
          { error: "Missing required fields: toolName, errorMessage" },
          400
        );
      }

      const errorContext: ErrorContext = {
        toolName: body.toolName,
        errorMessage: body.errorMessage,
        parameters: body.parameters,
        timestamp: new Date().toISOString(),
        stackTrace: body.stackTrace,
      };

      const remediationTask = analyzer.createFixTask(errorContext);

      if (remediationTask) {
        // Task is automatically added via the injected task manager
        return c.json({ 
          success: true, 
          taskCreated: true,
          task: remediationTask 
        });
      } else {
        return c.json({ 
          success: true, 
          taskCreated: false,
          message: "Error analyzed but no automatic fix available"
        });
      }
    } catch (error) {
      log.error({ err: error }, "Failed to analyze tool error");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /tasks - List tasks with optional filters
   */
  router.get("/tasks", (c) => {
    try {
      const db = getDatabase().getDb();
      const taskStore = getTaskStore(db);

      const status = c.req.query("status");
      const limit = parseInt(c.req.query("limit") || "50", 10);

      const tasks = taskStore.listTasks({
        status: status as any,
      }).slice(0, limit);

      return c.json({ tasks });
    } catch (error) {
      log.error({ err: error }, "Failed to list tasks");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /tasks - Create a new task
   */
  router.post("/tasks", async (c) => {
    try {
      const db = getDatabase().getDb();
      const taskStore = getTaskStore(db);

      const body = await c.req.json();
      const { description, priority, scheduledFor, reason, payload } = body;

      if (!description) {
        return c.json({ error: "Description is required" }, 400);
      }

      const task = taskStore.createTask({
        description,
        priority: priority || 0,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined,
        reason,
        payload,
      });

      return c.json({ success: true, task });
    } catch (error) {
      log.error({ err: error }, "Failed to create task");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * PUT /tasks/:id - Update a task
   */
  router.put("/tasks/:id", async (c) => {
    try {
      const db = getDatabase().getDb();
      const taskStore = getTaskStore(db);

      const taskId = c.req.param("id");
      const body = await c.req.json();
      const { description, status, priority, result, error } = body;

      const updated = taskStore.updateTask(taskId, {
        description,
        status,
        priority,
        result,
        error,
      });

      if (!updated) {
        return c.json({ error: "Task not found" }, 404);
      }

      return c.json({ success: true, task: updated });
    } catch (error) {
      log.error({ err: error }, "Failed to update task");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * DELETE /tasks/:id - Delete a task
   */
  router.delete("/tasks/:id", (c) => {
    try {
      const db = getDatabase().getDb();
      const taskStore = getTaskStore(db);

      const taskId = c.req.param("id");
      const deleted = taskStore.deleteTask(taskId);

      if (!deleted) {
        return c.json({ error: "Task not found" }, 404);
      }

      return c.json({ success: true });
    } catch (error) {
      log.error({ err: error }, "Failed to delete task");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  app.route("/api/autonomous", router);
}

  /**
   * =====================
   * PHASE 3: GOAL MANAGEMENT ENDPOINTS
   * =====================
   */

  let goalManager: any = null;

  function getGoalManager(): any {
    if (!goalManager) {
      const { GoalManager } = require('../../agent/services/goal-manager');
      const { LLMService } = require('../../agent/services/llm-service');
      
      // Initialize LLM service (in production, use proper config)
      const llmService = new LLMService({
        apiKey: process.env.OPENAI_API_KEY || '',
        model: 'gpt-4o-mini'
      });
      
      goalManager = new GoalManager(llmService);
    }
    return goalManager;
  }

  /**
   * GET /goals - Get all goals or filter by level
   */
  router.get("/goals", (c) => {
    try {
      const gm = getGoalManager();
      const level = c.req.query('level');
      
      let goals;
      if (level) {
        goals = gm.getGoalsByLevel(level);
      } else {
        goals = Array.from(gm.goals.values());
      }
      
      return c.json({ goals });
    } catch (error) {
      log.error({ err: error }, "Failed to get goals");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /goals/tree - Get goal tree structure
   */
  router.get("/goals/tree", (c) => {
    try {
      const gm = getGoalManager();
      const rootId = c.req.query('rootId');
      
      const tree = gm.getGoalTree(rootId || undefined);
      return c.json({ tree });
    } catch (error) {
      log.error({ err: error }, "Failed to get goal tree");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /goals/stats - Get goal statistics
   */
  router.get("/goals/stats", (c) => {
    try {
      const gm = getGoalManager();
      const stats = gm.getGoalStats();
      return c.json({ stats });
    } catch (error) {
      log.error({ err: error }, "Failed to get goal stats");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /goals - Create a new goal
   */
  router.post("/goals", async (c) => {
    try {
      const body = await c.req.json();
      const { title, level, description, parentId, priority, deadline, context } = body;
      
      if (!title || !level) {
        return c.json({ error: "Title and level are required" }, 400);
      }
      
      const gm = getGoalManager();
      const goal = await gm.createGoal(
        title,
        level,
        description,
        parentId,
        priority,
        deadline ? new Date(deadline) : undefined,
        context
      );
      
      return c.json({ success: true, goal });
    } catch (error) {
      log.error({ err: error }, "Failed to create goal");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /goals/:id/decompose - Decompose a goal into sub-goals
   */
  router.post("/goals/:id/decompose", async (c) => {
    try {
      const goalId = c.req.param("id");
      const body = await c.req.json();
      const { maxDepth, targetLevel, includeMetrics } = body;
      
      const gm = getGoalManager();
      const result = await gm.decomposeGoal(goalId, {
        maxDepth: maxDepth || 2,
        targetLevel: targetLevel || 'short_term',
        includeMetrics: includeMetrics !== false
      });
      
      return c.json({ success: true, decomposition: result });
    } catch (error) {
      log.error({ err: error }, "Failed to decompose goal");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * PUT /goals/:id/status - Update goal status
   */
  router.put("/goals/:id/status", async (c) => {
    try {
      const goalId = c.req.param("id");
      const body = await c.req.json();
      const { status } = body;
      
      if (!status) {
        return c.json({ error: "Status is required" }, 400);
      }
      
      const gm = getGoalManager();
      const updated = await gm.updateGoalStatus(goalId, status);
      
      if (!updated) {
        return c.json({ error: "Goal not found" }, 404);
      }
      
      return c.json({ success: true, goal: updated });
    } catch (error) {
      log.error({ err: error }, "Failed to update goal status");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * PUT /goals/:id/progress - Update goal progress
   */
  router.put("/goals/:id/progress", async (c) => {
    try {
      const goalId = c.req.param("id");
      const body = await c.req.json();
      const { progress } = body;
      
      if (progress === undefined || progress < 0 || progress > 100) {
        return c.json({ error: "Progress must be between 0 and 100" }, 400);
      }
      
      const gm = getGoalManager();
      const updated = await gm.updateGoalProgress(goalId, progress);
      
      if (!updated) {
        return c.json({ error: "Goal not found" }, 404);
      }
      
      return c.json({ success: true, goal: updated });
    } catch (error) {
      log.error({ err: error }, "Failed to update goal progress");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * DELETE /goals/:id - Delete a goal
   */
  router.delete("/goals/:id", async (c) => {
    try {
      const goalId = c.req.param("id");
      
      const gm = getGoalManager();
      const deleted = await gm.deleteGoal(goalId);
      
      if (!deleted) {
        return c.json({ error: "Goal not found" }, 404);
      }
      
      return c.json({ success: true });
    } catch (error) {
      log.error({ err: error }, "Failed to delete goal");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /goals/reprioritize - Dynamically reprioritize goals based on context
   */
  router.post("/goals/reprioritize", async (c) => {
    try {
      const body = await c.req.json();
      const { contextChanges } = body;
      
      const gm = getGoalManager();
      const updated = await gm.reprioritizeGoals(contextChanges || {});
      
      return c.json({ success: true, updatedGoals: updated });
    } catch (error) {
      log.error({ err: error }, "Failed to reprioritize goals");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  // ============================================
  // Multi-Agent System Endpoints (Phase 4)
  // ============================================

  /**
   * GET /agents - Get all registered agents
   */
  router.get("/agents", async (c) => {
    try {
      const orchestrator = getMultiAgentOrchestrator();
      const stats = orchestrator.getAgentStats();
      
      return c.json({ success: true, agents: stats });
    } catch (error) {
      log.error({ err: error }, "Failed to get agents");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /agents/:id - Get specific agent profile
   */
  router.get("/agents/:id", async (c) => {
    try {
      const agentId = c.req.param("id");
      const orchestrator = getMultiAgentOrchestrator();
      const agent = orchestrator.getAgent(agentId);
      
      if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
      }
      
      return c.json({ success: true, agent });
    } catch (error) {
      log.error({ err: error }, "Failed to get agent");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /agents/tasks/active - Get active task assignments
   */
  router.get("/agents/tasks/active", async (c) => {
    try {
      const orchestrator = getMultiAgentOrchestrator();
      const assignments = orchestrator.getActiveAssignments();
      
      return c.json({ success: true, assignments });
    } catch (error) {
      log.error({ err: error }, "Failed to get active assignments");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /agents/messages - Get agent messages
   */
  router.get("/agents/messages", async (c) => {
    try {
      const taskId = c.req.query("taskId");
      const agentId = c.req.query("agentId");
      
      const orchestrator = getMultiAgentOrchestrator();
      const messages = orchestrator.getMessages(taskId, agentId);
      
      return c.json({ success: true, messages });
    } catch (error) {
      log.error({ err: error }, "Failed to get messages");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /agents/:id/message - Send message to agent
   */
  router.post("/agents/:id/message", async (c) => {
    try {
      const agentId = c.req.param("id");
      const body = await c.req.json();
      const { fromAgent, content, messageType, taskId, metadata } = body;

      if (!fromAgent || !content || !messageType) {
        return c.json({ error: "fromAgent, content, and messageType are required" }, 400);
      }

      const orchestrator = getMultiAgentOrchestrator();
      const message = await orchestrator.sendMessage(
        fromAgent,
        content,
        messageType,
        agentId,
        taskId,
        metadata
      );
      
      return c.json({ success: true, message });
    } catch (error) {
      log.error({ err: error }, "Failed to send message");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /agents/task/decompose - Decompose task and assign to agents
   */
  router.post("/agents/task/decompose", async (c) => {
    try {
      const body = await c.req.json();
      const { taskId, description, orchestratorId } = body;

      if (!taskId || !description) {
        return c.json({ error: "taskId and description are required" }, 400);
      }

      const orchestrator = getMultiAgentOrchestrator();
      const assignments = await orchestrator.decomposeAndAssign(
        taskId,
        description,
        orchestratorId || 'orchestrator-1'
      );
      
      return c.json({ success: true, assignments });
    } catch (error) {
      log.error({ err: error }, "Failed to decompose task");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /agents/consensus/initiate - Initiate consensus for a task
   */
  router.post("/agents/consensus/initiate", async (c) => {
    try {
      const body = await c.req.json();
      const { taskId, requiredRoles } = body;

      if (!taskId || !requiredRoles || !Array.isArray(requiredRoles)) {
        return c.json({ error: "taskId and requiredRoles array are required" }, 400);
      }

      const orchestrator = getMultiAgentOrchestrator();
      const sessionId = await orchestrator.initiateConsensus(taskId, requiredRoles);
      
      return c.json({ success: true, sessionId });
    } catch (error) {
      log.error({ err: error }, "Failed to initiate consensus");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /agents/consensus/:sessionId/vote - Cast vote in consensus session
   */
  router.post("/agents/consensus/:sessionId/vote", async (c) => {
    try {
      const sessionId = c.req.param("sessionId");
      const body = await c.req.json();
      const { voterId, vote, reasoning, confidence } = body;

      if (!voterId || !vote || !reasoning || confidence === undefined) {
        return c.json({ error: "voterId, vote, reasoning, and confidence are required" }, 400);
      }

      const orchestrator = getMultiAgentOrchestrator();
      const result = await orchestrator.castVote(
        sessionId,
        voterId,
        vote,
        reasoning,
        confidence
      );
      
      return c.json({ success: true, consensus: result });
    } catch (error) {
      log.error({ err: error }, "Failed to cast vote");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /agents/:id/review - Request review from agent
   */
  router.post("/agents/:id/review", async (c) => {
    try {
      const agentId = c.req.param("id");
      const body = await c.req.json();
      const { taskId, reviewerRole } = body;

      if (!taskId || !reviewerRole) {
        return c.json({ error: "taskId and reviewerRole are required" }, 400);
      }

      const orchestrator = getMultiAgentOrchestrator();
      const reviewerId = await orchestrator.requestReview(taskId, reviewerRole);
      
      return c.json({ success: true, reviewerId });
    } catch (error) {
      log.error({ err: error }, "Failed to request review");
      return c.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        500
      );
    }
  });
