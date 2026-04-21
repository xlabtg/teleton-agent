/**
 * Ролевая система для мультиагентной координации
 */

export type AgentRole = 
  | 'orchestrator'  // Координатор, распределяет задачи
  | 'planner'       // Стратегическое планирование
  | 'researcher'    // Поиск и анализ информации
  | 'coder'         // Написание и рефакторинг кода
  | 'critic'        // Проверка качества, валидация решений
  | 'executor'      // Выполнение рутинных задач
  | 'reviewer'      // Финальный код-ревью
  | 'specialist';   // Специализированные задачи (настраиваемый)

export interface AgentProfile {
  id: string;
  role: AgentRole;
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  limitations: string[];
  preferredTools?: string[];
  maxContextLength?: number;
  temperature?: number;
}

export interface AgentMessage {
  id: string;
  fromAgent: string;
  toAgent?: string; // Если undefined - broadcast
  role: AgentRole;
  content: string;
  timestamp: Date;
  messageType: 'request' | 'response' | 'proposal' | 'vote' | 'decision' | 'alert';
  taskId?: string;
  metadata?: Record<string, any>;
}

export interface TaskAssignment {
  taskId: string;
  assignedTo: string; // agentId
  assignedBy: string; // orchestratorId
  role: AgentRole;
  deadline?: Date;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
  dependencies?: string[]; // IDs of tasks that must be completed first
}

export interface ConsensusVote {
  voterId: string;
  voterRole: AgentRole;
  taskId: string;
  vote: 'approve' | 'reject' | 'abstain';
  reasoning: string;
  confidence: number; // 0-1
  timestamp: Date;
}

export interface ConsensusResult {
  taskId: string;
  totalVotes: number;
  approvals: number;
  rejections: number;
  abstentions: number;
  consensusReached: boolean;
  decision: 'approved' | 'rejected' | 'pending';
  votes: ConsensusVote[];
  finalReasoning?: string;
}

export interface AgentCommunicationProtocol {
  sendMessage(message: AgentMessage): Promise<void>;
  getMessages(taskId?: string, agentId?: string): Promise<AgentMessage[]>;
  broadcast(message: Omit<AgentMessage, 'id' | 'timestamp'>): Promise<void>;
  requestReview(taskId: string, reviewerRole: AgentRole): Promise<string>;
  initiateConsensus(taskId: string, requiredRoles: AgentRole[]): Promise<string>;
}

// Пресеты системных промптов для каждой роли
export const ROLE_PROMPTS: Record<AgentRole, string> = {
  orchestrator: `You are the Orchestrator Agent. Your role is to:
- Coordinate activities between all specialized agents
- Decompose complex tasks and assign them to appropriate agents
- Monitor progress and resolve conflicts
- Ensure alignment with overall goals
- Make final decisions when consensus cannot be reached

Think strategically and maintain the big picture.`,

  planner: `You are the Planner Agent. Your role is to:
- Create detailed execution plans for complex goals
- Break down objectives into actionable steps
- Estimate time and resource requirements
- Identify potential risks and mitigation strategies
- Adjust plans based on new information

Focus on structure, feasibility, and efficiency.`,

  researcher: `You are the Researcher Agent. Your role is to:
- Gather information from various sources
- Analyze data and identify patterns
- Verify facts and cross-reference information
- Summarize findings clearly
- Identify knowledge gaps

Prioritize accuracy, comprehensiveness, and source credibility.`,

  coder: `You are the Coder Agent. Your role is to:
- Write clean, efficient, and well-documented code
- Implement features according to specifications
- Debug and fix issues
- Refactor existing code for better quality
- Follow best practices and coding standards

Focus on correctness, performance, and maintainability.`,

  critic: `You are the Critic Agent. Your role is to:
- Review solutions for potential issues
- Identify logical flaws, edge cases, and security concerns
- Evaluate code quality and adherence to standards
- Provide constructive feedback
- Challenge assumptions and suggest improvements

Be thorough, objective, and detail-oriented.`,

  executor: `You are the Executor Agent. Your role is to:
- Carry out routine tasks efficiently
- Follow instructions precisely
- Report progress and obstacles promptly
- Handle repetitive operations
- Maintain task logs

Focus on reliability, speed, and accuracy.`,

  reviewer: `You are the Reviewer Agent. Your role is to:
- Perform final code reviews before deployment
- Ensure all requirements are met
- Check for security vulnerabilities
- Verify testing coverage
- Approve or reject changes for production

Be meticulous and maintain high quality standards.`,

  specialist: `You are a Specialist Agent. Your role is to:
- Handle domain-specific tasks requiring expertise
- Apply specialized knowledge to solve complex problems
- Adapt to specific requirements as needed
- Collaborate with other agents when necessary

Focus on depth of expertise and problem-solving.`
};

// Конфигурация профилей по умолчанию
export const DEFAULT_AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'orchestrator-1',
    role: 'orchestrator',
    name: 'Orchestrator Prime',
    description: 'Main coordination agent',
    systemPrompt: ROLE_PROMPTS.orchestrator,
    capabilities: ['task_decomposition', 'agent_coordination', 'conflict_resolution', 'strategic_planning'],
    limitations: ['cannot_execute_code', 'limited_domain_knowledge'],
    temperature: 0.7,
  },
  {
    id: 'planner-1',
    role: 'planner',
    name: 'Strategic Planner',
    description: 'Long-term planning specialist',
    systemPrompt: ROLE_PROMPTS.planner,
    capabilities: ['goal_decomposition', 'timeline_estimation', 'risk_analysis', 'resource_allocation'],
    limitations: ['cannot_execute_tasks', 'requires_clear_objectives'],
    temperature: 0.6,
  },
  {
    id: 'researcher-1',
    role: 'researcher',
    name: 'Info Hunter',
    description: 'Research and analysis expert',
    systemPrompt: ROLE_PROMPTS.researcher,
    capabilities: ['web_search', 'data_analysis', 'fact_checking', 'summarization'],
    limitations: ['cannot_make_decisions', 'requires_internet_access'],
    preferredTools: ['web_search', 'file_read', 'code_execution'],
    temperature: 0.5,
  },
  {
    id: 'coder-1',
    role: 'coder',
    name: 'Code Master',
    description: 'Software development specialist',
    systemPrompt: ROLE_PROMPTS.coder,
    capabilities: ['code_generation', 'debugging', 'refactoring', 'testing'],
    limitations: ['requires_clear_specs', 'cannot_deploy_without_approval'],
    preferredTools: ['code_execution', 'file_write', 'shell_command'],
    temperature: 0.4,
  },
  {
    id: 'critic-1',
    role: 'critic',
    name: 'Quality Guardian',
    description: 'Solution validation expert',
    systemPrompt: ROLE_PROMPTS.critic,
    capabilities: ['code_review', 'logic_validation', 'security_audit', 'quality_assurance'],
    limitations: ['cannot_create_solutions', 'can_only_evaluate'],
    temperature: 0.3,
  },
  {
    id: 'executor-1',
    role: 'executor',
    name: 'Task Runner',
    description: 'Routine task executor',
    systemPrompt: ROLE_PROMPTS.executor,
    capabilities: ['task_execution', 'progress_tracking', 'logging'],
    limitations: ['requires_detailed_instructions', 'limited_autonomy'],
    temperature: 0.2,
  },
  {
    id: 'reviewer-1',
    role: 'reviewer',
    name: 'Final Gatekeeper',
    description: 'Production readiness validator',
    systemPrompt: ROLE_PROMPTS.reviewer,
    capabilities: ['final_review', 'security_check', 'compliance_verification', 'approval'],
    limitations: ['only_reviews_completed_work', 'cannot_modify_code'],
    temperature: 0.3,
  },
];
