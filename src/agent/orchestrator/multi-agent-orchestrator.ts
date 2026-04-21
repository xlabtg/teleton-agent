import { v4 as uuidv4 } from 'uuid';
import { 
  AgentRole, 
  AgentProfile, 
  AgentMessage, 
  TaskAssignment, 
  ConsensusVote, 
  ConsensusResult,
  DEFAULT_AGENT_PROFILES 
} from '../types/multi-agent';
import { GoalManager } from './goal-manager';
import { TaskPlanner } from './task-planner';

/**
 * Менеджер мультиагентной системы
 * Управляет ролями, коммуникацией и координацией между агентами
 */
export class MultiAgentOrchestrator {
  private agents: Map<string, AgentProfile>;
  private messageQueue: AgentMessage[];
  private taskAssignments: Map<string, TaskAssignment>;
  private consensusSessions: Map<string, ConsensusResult>;
  private goalManager?: GoalManager;
  private taskPlanner?: TaskPlanner;

  constructor() {
    this.agents = new Map();
    this.messageQueue = [];
    this.taskAssignments = new Map();
    this.consensusSessions = new Map();
    
    // Инициализация агентов по умолчанию
    this.initializeDefaultAgents();
  }

  /**
   * Инициализация агентов по умолчанию
   */
  private initializeDefaultAgents(): void {
    DEFAULT_AGENT_PROFILES.forEach(profile => {
      this.agents.set(profile.id, profile);
    });
    console.log(`[MultiAgent] Initialized ${this.agents.size} default agents`);
  }

  /**
   * Регистрация нового агента
   */
  public registerAgent(profile: AgentProfile): void {
    if (this.agents.has(profile.id)) {
      throw new Error(`Agent with ID ${profile.id} already exists`);
    }
    this.agents.set(profile.id, profile);
    console.log(`[MultiAgent] Registered agent: ${profile.name} (${profile.role})`);
  }

  /**
   * Получение профиля агента
   */
  public getAgent(agentId: string): AgentProfile | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Получение всех агентов определенной роли
   */
  public getAgentsByRole(role: AgentRole): AgentProfile[] {
    return Array.from(this.agents.values()).filter(a => a.role === role);
  }

  /**
   * Отправка сообщения между агентами
   */
  public async sendMessage(
    fromAgent: string,
    content: string,
    messageType: AgentMessage['messageType'],
    toAgent?: string,
    taskId?: string,
    metadata?: Record<string, any>
  ): Promise<AgentMessage> {
    const fromProfile = this.agents.get(fromAgent);
    if (!fromProfile) {
      throw new Error(`Agent ${fromAgent} not found`);
    }

    const message: AgentMessage = {
      id: uuidv4(),
      fromAgent,
      toAgent,
      role: fromProfile.role,
      content,
      timestamp: new Date(),
      messageType,
      taskId,
      metadata,
    };

    this.messageQueue.push(message);
    
    // Логирование для отладки
    const direction = toAgent ? `-> ${toAgent}` : '(broadcast)';
    console.log(`[MultiAgent] Message from ${fromAgent} ${direction}: ${content.substring(0, 50)}...`);

    return message;
  }

  /**
   * Получение сообщений для задачи или агента
   */
  public getMessages(taskId?: string, agentId?: string): AgentMessage[] {
    return this.messageQueue.filter(msg => {
      if (taskId && msg.taskId !== taskId) return false;
      if (agentId && msg.toAgent !== agentId && msg.toAgent !== undefined) return false;
      return true;
    });
  }

  /**
   * Назначение задачи агенту
   */
  public assignTask(
    taskId: string,
    agentId: string,
    assignedBy: string,
    priority: TaskAssignment['priority'] = 'medium',
    dependencies?: string[]
  ): TaskAssignment {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const assignment: TaskAssignment = {
      taskId,
      assignedTo: agentId,
      assignedBy,
      role: agent.role,
      priority,
      status: 'pending',
      dependencies,
    };

    this.taskAssignments.set(taskId, assignment);
    
    console.log(`[MultiAgent] Task ${taskId} assigned to ${agent.name} (${agent.role})`);
    
    // Отправка уведомления агенту
    this.sendMessage(
      assignedBy,
      `New task assigned: ${taskId}. Priority: ${priority}`,
      'request',
      agentId,
      taskId
    );

    return assignment;
  }

  /**
   * Обновление статуса задачи
   */
  public updateTaskStatus(taskId: string, status: TaskAssignment['status']): void {
    const assignment = this.taskAssignments.get(taskId);
    if (!assignment) {
      throw new Error(`Task assignment ${taskId} not found`);
    }
    
    assignment.status = status;
    console.log(`[MultiAgent] Task ${taskId} status updated to ${status}`);

    // Уведомление оркестратора о завершении
    if (status === 'completed' || status === 'failed') {
      this.sendMessage(
        assignment.assignedTo,
        `Task ${taskId} ${status}`,
        'response',
        assignment.assignedBy,
        taskId
      );
    }
  }

  /**
   * Инициация консенсуса для задачи
   */
  public async initiateConsensus(
    taskId: string,
    requiredRoles: AgentRole[]
  ): Promise<string> {
    const sessionId = uuidv4();
    
    console.log(`[MultiAgent] Initiating consensus for task ${taskId}, required roles: ${requiredRoles.join(', ')}`);

    // Поиск доступных агентов для каждой роли
    const voters: AgentProfile[] = [];
    for (const role of requiredRoles) {
      const agents = this.getAgentsByRole(role);
      if (agents.length > 0) {
        voters.push(agents[0]); // Берем первого доступного
      }
    }

    if (voters.length === 0) {
      throw new Error('No available agents for required roles');
    }

    // Создание сессии консенсуса
    const consensus: ConsensusResult = {
      taskId,
      totalVotes: 0,
      approvals: 0,
      rejections: 0,
      abstentions: 0,
      consensusReached: false,
      decision: 'pending',
      votes: [],
    };

    this.consensusSessions.set(sessionId, consensus);

    // Отправка запросов на голосование
    for (const voter of voters) {
      await this.sendMessage(
        'orchestrator-1',
        `Please review task ${taskId} and cast your vote`,
        'request',
        voter.id,
        taskId,
        { sessionId, requiredAction: 'vote' }
      );
    }

    return sessionId;
  }

  /**
   * Голосование в сессии консенсуса
   */
  public async castVote(
    sessionId: string,
    voterId: string,
    vote: ConsensusVote['vote'],
    reasoning: string,
    confidence: number
  ): Promise<ConsensusResult> {
    const consensus = this.consensusSessions.get(sessionId);
    if (!consensus) {
      throw new Error(`Consensus session ${sessionId} not found`);
    }

    const voter = this.agents.get(voterId);
    if (!voter) {
      throw new Error(`Voter ${voterId} not found`);
    }

    const consenusVote: ConsensusVote = {
      voterId,
      voterRole: voter.role,
      taskId: consensus.taskId,
      vote,
      reasoning,
      confidence,
      timestamp: new Date(),
    };

    consensus.votes.push(consenusVote);
    consensus.totalVotes++;

    // Подсчет голосов
    if (vote === 'approve') consensus.approvals++;
    else if (vote === 'reject') consensus.rejections++;
    else consensus.abstentions++;

    // Проверка достижения консенсуса
    const participationRate = consensus.totalVotes / Math.max(1, consensus.votes.length);
    const approvalRate = consensus.approvals / Math.max(1, consensus.totalVotes - consensus.abstentions);

    if (participationRate >= 1.0) {
      consensus.consensusReached = true;
      if (approvalRate >= 0.6) {
        consensus.decision = 'approved';
      } else {
        consensus.decision = 'rejected';
      }
      
      // Формирование итогового обоснования
      consensus.finalReasoning = this.generateConsensusReasoning(consensus);
      
      console.log(`[MultiAgent] Consensus reached for ${consensus.taskId}: ${consensus.decision}`);
    }

    return consensus;
  }

  /**
   * Генерация итогового обоснования консенсуса
   */
  private generateConsensusReasoning(consensus: ConsensusResult): string {
    const reasons = consensus.votes.map(v => 
      `[${v.voterRole}]: ${v.vote} - ${v.reasoning} (confidence: ${v.confidence})`
    );
    return reasons.join('\n');
  }

  /**
   * Запрос ревью от агента определенной роли
   */
  public async requestReview(
    taskId: string,
    reviewerRole: AgentRole
  ): Promise<string> {
    const reviewers = this.getAgentsByRole(reviewerRole);
    if (reviewers.length === 0) {
      throw new Error(`No agents with role ${reviewerRole} available`);
    }

    const reviewer = reviewers[0];
    
    await this.sendMessage(
      'orchestrator-1',
      `Please review task ${taskId}`,
      'request',
      reviewer.id,
      taskId,
      { requiredAction: 'review' }
    );

    console.log(`[MultiAgent] Review requested from ${reviewer.name} for task ${taskId}`);
    
    return reviewer.id;
  }

  /**
   * Получение активных назначений задач
   */
  public getActiveAssignments(): TaskAssignment[] {
    return Array.from(this.taskAssignments.values()).filter(
      a => a.status === 'pending' || a.status === 'in_progress'
    );
  }

  /**
   * Получение статистики по агентам
   */
  public getAgentStats(): Record<string, any> {
    const stats: Record<string, any> = {};
    
    this.agents.forEach((agent, id) => {
      const assignments = Array.from(this.taskAssignments.values()).filter(
        a => a.assignedTo === id
      );
      
      stats[id] = {
        name: agent.name,
        role: agent.role,
        totalTasks: assignments.length,
        completedTasks: assignments.filter(a => a.status === 'completed').length,
        failedTasks: assignments.filter(a => a.status === 'failed').length,
        pendingTasks: assignments.filter(a => a.status === 'pending').length,
      };
    });

    return stats;
  }

  /**
   * Интеграция с GoalManager
   */
  public setGoalManager(goalManager: GoalManager): void {
    this.goalManager = goalManager;
    console.log('[MultiAgent] GoalManager integrated');
  }

  /**
   * Интеграция с TaskPlanner
   */
  public setTaskPlanner(taskPlanner: TaskPlanner): void {
    this.taskPlanner = taskPlanner;
    console.log('[MultiAgent] TaskPlanner integrated');
  }

  /**
   * Декомпозиция сложной задачи и распределение между агентами
   */
  public async decomposeAndAssign(
    taskId: string,
    description: string,
    orchestratorId: string = 'orchestrator-1'
  ): Promise<TaskAssignment[]> {
    console.log(`[MultiAgent] Decomposing task ${taskId}: ${description}`);

    // Назначаем задачу Planner для декомпозиции
    const plannerAssignment = this.assignTask(
      `${taskId}-plan`,
      'planner-1',
      orchestratorId,
      'high',
      []
    );

    // После планирования назначаем исполнителей (упрощенная логика)
    // В реальной реализации это будет асинхронный процесс с ожиданием результата
    
    const assignments: TaskAssignment[] = [plannerAssignment];

    // Пример: назначение Coder и Critic для задачи разработки
    if (description.toLowerCase().includes('code') || description.toLowerCase().includes('implement')) {
      const coderAssignment = this.assignTask(
        `${taskId}-code`,
        'coder-1',
        orchestratorId,
        'high',
        [plannerAssignment.taskId]
      );
      
      const criticAssignment = this.assignTask(
        `${taskId}-review`,
        'critic-1',
        orchestratorId,
        'medium',
        [coderAssignment.taskId]
      );

      assignments.push(coderAssignment, criticAssignment);
    }

    return assignments;
  }

  /**
   * Очистка старых сообщений
   */
  public cleanupMessages(maxAge: number = 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAge;
    const initialCount = this.messageQueue.length;
    this.messageQueue = this.messageQueue.filter(m => m.timestamp.getTime() > cutoff);
    console.log(`[MultiAgent] Cleaned up ${initialCount - this.messageQueue.length} old messages`);
  }
}

// Экспорт singleton instance
export const multiAgentOrchestrator = new MultiAgentOrchestrator();
