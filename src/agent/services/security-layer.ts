/**
 * v2-13 Zero-Trust Validation for Actions
 * Проверяет каждое действие агента на безопасность перед выполнением.
 */
export interface SecurityPolicy {
  allowedTools: string[];
  blockedPatterns: RegExp[];
  maxResourceUsage: { cpuPercent?: number; memoryMB?: number };
  requireApprovalFor: string[]; // Tools requiring user confirmation
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval: boolean;
}

export class ZeroTrustValidator {
  private policy: SecurityPolicy;

  constructor(policy: SecurityPolicy) {
    this.policy = policy;
  }

  /**
   * Валидация действия перед выполнением
   */
  validateAction(toolName: string, args: any): ValidationResult {
    // 1. Check allowlist
    if (!this.policy.allowedTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `Tool '${toolName}' is not in the allowed list`,
        riskLevel: 'high',
        requiresApproval: true
      };
    }

    // 2. Check blocked patterns in arguments
    const argsString = JSON.stringify(args);
    for (const pattern of this.policy.blockedPatterns) {
      if (pattern.test(argsString)) {
        return {
          allowed: false,
          reason: `Action contains blocked pattern: ${pattern.source}`,
          riskLevel: 'critical',
          requiresApproval: true
        };
      }
    }

    // 3. Check approval requirements
    const requiresApproval = this.policy.requireApprovalFor.includes(toolName);

    return {
      allowed: true,
      riskLevel: 'low',
      requiresApproval
    };
  }

  /**
   * Аудит действия для логирования
   */
  auditAction(actionId: string, toolName: string, result: ValidationResult): AuditLogEntry {
    return {
      id: actionId,
      timestamp: Date.now(),
      tool: toolName,
      allowed: result.allowed,
      riskLevel: result.riskLevel,
      reason: result.reason
    };
  }
}

/**
 * v2-14 Full Audit Logs for Agent Decisions
 * Полное логирование всех решений агента для отладки и безопасности.
 */
export interface AuditLogEntry {
  id: string;
  timestamp: number;
  tool: string;
  allowed: boolean;
  riskLevel: string;
  reason?: string;
  context?: any;
  userId?: string;
}

export class AuditLogger {
  private logs: AuditLogEntry[] = [];
  private maxLogs: number = 1000;

  log(entry: AuditLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  getLogs(filter?: { tool?: string; riskLevel?: string; from?: number }): AuditLogEntry[] {
    return this.logs.filter(entry => {
      if (filter?.tool && entry.tool !== filter.tool) return false;
      if (filter?.riskLevel && entry.riskLevel !== filter.riskLevel) return false;
      if (filter?.from && entry.timestamp < filter.from) return false;
      return true;
    });
  }

  exportLogs(): string {
    return JSON.stringify(this.logs, null, 2);
  }
}
