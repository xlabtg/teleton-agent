/**
 * Services Index - Phase 2: Self-Healing & Monitoring
 */

export { FailureAnalyzer } from './failure-analyzer';
export type { ErrorContext, RemediationTask } from './failure-analyzer';

export { SelfHealthMonitor } from './self-health-monitor';
export type { HealthMetrics, HealthAlert, HealthThresholds } from './self-health-monitor';

// Phase 3: Goal Management
export { GoalManager } from './goal-manager';

// Multi-agent system exports
export { MultiAgentOrchestrator, multiAgentOrchestrator } from '../orchestrator/multi-agent-orchestrator';
