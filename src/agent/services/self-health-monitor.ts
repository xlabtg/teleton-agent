/**
 * Module: Self-Health Monitor
 * Description: Tracks agent health metrics and triggers alerts or auto-fix tasks.
 */

import { logger } from '../utils/logger';

export interface HealthMetrics {
  timestamp: string;
  tokenUsage: {
    total: number;
    input: number;
    output: number;
    remaining?: number;
  };
  toolExecution: {
    total: number;
    successful: number;
    failed: number;
    successRate: number;
  };
  responseTime: {
    averageMs: number;
    p95Ms: number;
    p99Ms: number;
  };
  memoryUsage?: {
    usedMB: number;
    limitMB: number;
    percentage: number;
  };
  activeTasks?: number;
  errorRate?: number;
}

export interface HealthAlert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  metric: string;
  currentValue: number;
  threshold: number;
  message: string;
  timestamp: string;
  suggestedAction?: string;
}

export interface HealthThresholds {
  tokenUsageWarning: number; // percentage of limit
  tokenUsageCritical: number; // percentage of limit
  successRateWarning: number; // percentage
  successRateCritical: number; // percentage
  responseTimeWarningMs: number;
  responseTimeCriticalMs: number;
  memoryUsageWarning: number; // percentage
  memoryUsageCritical: number; // percentage
}

export class SelfHealthMonitor {
  private metricsHistory: HealthMetrics[] = [];
  private alerts: HealthAlert[] = [];
  private thresholds: HealthThresholds = {
    tokenUsageWarning: 80,
    tokenUsageCritical: 95,
    successRateWarning: 90,
    successRateCritical: 75,
    responseTimeWarningMs: 5000,
    responseTimeCriticalMs: 10000,
    memoryUsageWarning: 80,
    memoryUsageCritical: 95,
  };

  private maxHistoryLength = 100; // Keep last 100 measurements

  /**
   * Records a new health metrics snapshot
   */
  public recordMetrics(metrics: HealthMetrics): void {
    this.metricsHistory.push(metrics);

    // Trim history if too long
    if (this.metricsHistory.length > this.maxHistoryLength) {
      this.metricsHistory.shift();
    }

    // Check for threshold violations
    this.checkThresholds(metrics);
  }

  /**
   * Checks metrics against thresholds and generates alerts
   */
  private checkThresholds(metrics: HealthMetrics): void {
    const alerts: HealthAlert[] = [];

    // Check success rate
    if (metrics.toolExecution.successRate < this.thresholds.successRateCritical) {
      alerts.push({
        id: `alert_${Date.now()}_success_critical`,
        severity: 'critical',
        metric: 'tool_success_rate',
        currentValue: metrics.toolExecution.successRate,
        threshold: this.thresholds.successRateCritical,
        message: `Critical: Tool success rate dropped to ${metrics.toolExecution.successRate.toFixed(1)}%`,
        timestamp: new Date().toISOString(),
        suggestedAction: 'Review recent tool failures and trigger failure analysis.',
      });
    } else if (metrics.toolExecution.successRate < this.thresholds.successRateWarning) {
      alerts.push({
        id: `alert_${Date.now()}_success_warning`,
        severity: 'warning',
        metric: 'tool_success_rate',
        currentValue: metrics.toolExecution.successRate,
        threshold: this.thresholds.successRateWarning,
        message: `Warning: Tool success rate at ${metrics.toolExecution.successRate.toFixed(1)}%`,
        timestamp: new Date().toISOString(),
        suggestedAction: 'Monitor tool execution patterns.',
      });
    }

    // Check response time
    if (metrics.responseTime.averageMs > this.thresholds.responseTimeCriticalMs) {
      alerts.push({
        id: `alert_${Date.now()}_response_critical`,
        severity: 'critical',
        metric: 'response_time',
        currentValue: metrics.responseTime.averageMs,
        threshold: this.thresholds.responseTimeCriticalMs,
        message: `Critical: Average response time is ${metrics.responseTime.averageMs.toFixed(0)}ms`,
        timestamp: new Date().toISOString(),
        suggestedAction: 'Check system load and optimize slow operations.',
      });
    } else if (metrics.responseTime.averageMs > this.thresholds.responseTimeWarningMs) {
      alerts.push({
        id: `alert_${Date.now()}_response_warning`,
        severity: 'warning',
        metric: 'response_time',
        currentValue: metrics.responseTime.averageMs,
        threshold: this.thresholds.responseTimeWarningMs,
        message: `Warning: Average response time is ${metrics.responseTime.averageMs.toFixed(0)}ms`,
        timestamp: new Date().toISOString(),
        suggestedAction: 'Consider caching or optimizing frequent operations.',
      });
    }

    // Check memory usage if available
    if (metrics.memoryUsage) {
      if (metrics.memoryUsage.percentage > this.thresholds.memoryUsageCritical) {
        alerts.push({
          id: `alert_${Date.now()}_memory_critical`,
          severity: 'critical',
          metric: 'memory_usage',
          currentValue: metrics.memoryUsage.percentage,
          threshold: this.thresholds.memoryUsageCritical,
          message: `Critical: Memory usage at ${metrics.memoryUsage.percentage.toFixed(1)}%`,
          timestamp: new Date().toISOString(),
          suggestedAction: 'Clear caches or restart agent to free memory.',
        });
      } else if (metrics.memoryUsage.percentage > this.thresholds.memoryUsageWarning) {
        alerts.push({
          id: `alert_${Date.now()}_memory_warning`,
          severity: 'warning',
          metric: 'memory_usage',
          currentValue: metrics.memoryUsage.percentage,
          threshold: this.thresholds.memoryUsageWarning,
          message: `Warning: Memory usage at ${metrics.memoryUsage.percentage.toFixed(1)}%`,
          timestamp: new Date().toISOString(),
          suggestedAction: 'Monitor memory consumption trends.',
        });
      }
    }

    // Store new alerts
    this.alerts.push(...alerts);

    // Log alerts
    alerts.forEach(alert => {
      logger.warn(`[Health Alert] ${alert.severity.toUpperCase()}: ${alert.message}`);
    });
  }

  /**
   * Gets current health status summary
   */
  public getHealthStatus(): {
    status: 'healthy' | 'degraded' | 'critical';
    activeAlerts: number;
    criticalAlerts: number;
    latestMetrics: HealthMetrics | null;
  } {
    const criticalAlerts = this.alerts.filter(a => a.severity === 'critical').length;
    const warningAlerts = this.alerts.filter(a => a.severity === 'warning').length;

    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (criticalAlerts > 0) {
      status = 'critical';
    } else if (warningAlerts > 0) {
      status = 'degraded';
    }

    return {
      status,
      activeAlerts: this.alerts.length,
      criticalAlerts,
      latestMetrics: this.metricsHistory[this.metricsHistory.length - 1] || null,
    };
  }

  /**
   * Gets recent alerts
   */
  public getRecentAlerts(limit: number = 10): HealthAlert[] {
    return this.alerts.slice(-limit).reverse();
  }

  /**
   * Gets metrics history for charting
   */
  public getMetricsHistory(limit: number = 20): HealthMetrics[] {
    return this.metricsHistory.slice(-limit);
  }

  /**
   * Clears old alerts (older than 24 hours or resolved)
   */
  public clearOldAlerts(): void {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    this.alerts = this.alerts.filter(alert => alert.timestamp > oneDayAgo);
  }

  /**
   * Updates thresholds dynamically
   */
  public updateThresholds(newThresholds: Partial<HealthThresholds>): void {
    this.thresholds = { ...this.thresholds, ...newThresholds };
    logger.info('Health monitor thresholds updated');
  }
}
