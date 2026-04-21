/**
 * v2-11 Time-Aware Context System
 * Учитывает временные аспекты (время суток, день недели, дедлайны) при принятии решений.
 */
export interface TimeContext {
  hour: number;
  dayOfWeek: number;
  isWorkHours: boolean;
  deadlineProximity?: 'urgent' | 'soon' | 'normal' | 'distant';
  userTimezone?: string;
}

export class TimeAwareContext {
  /**
   * Получение текущего временного контекста
   */
  getCurrentContext(userTimezone: string = 'UTC'): TimeContext {
    const now = new Date();
    // In production, use timezone library like date-fns-tz
    const hour = now.getHours(); 
    const dayOfWeek = now.getDay();
    
    const isWorkHours = hour >= 9 && hour <= 18 && dayOfWeek >= 1 && dayOfWeek <= 5;

    return {
      hour,
      dayOfWeek,
      isWorkHours,
      userTimezone
    };
  }

  /**
   * Оценка срочности на основе дедлайна
   */
  evaluateDeadlineProximity(deadline: Date): TimeContext['deadlineProximity'] {
    const now = new Date().getTime();
    const diff = deadline.getTime() - now;
    const hoursLeft = diff / (1000 * 60 * 60);

    if (hoursLeft < 2) return 'urgent';
    if (hoursLeft < 24) return 'soon';
    if (hoursLeft < 168) return 'normal'; // week
    return 'distant';
  }

  /**
   * Адаптация стиля ответа в зависимости от времени
   */
  adaptCommunicationStyle(context: TimeContext): { tone: string; verbosity: 'low' | 'medium' | 'high' } {
    if (!context.isWorkHours) {
      return { tone: 'casual', verbosity: 'low' }; // Кратко в нерабочее время
    }
    if (context.deadlineProximity === 'urgent') {
      return { tone: 'direct', verbosity: 'low' }; // Только суть при срочности
    }
    return { tone: 'professional', verbosity: 'medium' };
  }
}

/**
 * v2-12 Smart Task Scheduling
 * Оптимизирует выполнение задач с учетом приоритетов, времени и ресурсов.
 */
export interface ScheduledTask {
  id: string;
  priority: number;
  estimatedDurationMin: number;
  deadline?: Date;
  dependencies?: string[];
  bestTimeSlot?: { start: Date; end: Date };
}

export class SmartScheduler {
  /**
   * Расчет оптимального времени для задачи
   */
  findOptimalSlot(task: ScheduledTask, availableSlots: { start: Date; end: Date }[]): Date | null {
    // Sort by deadline urgency
    const sortedTasks = [task].sort((a, b) => {
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return a.deadline.getTime() - b.deadline.getTime();
    });

    for (const slot of availableSlots) {
      const durationMs = task.estimatedDurationMin * 60 * 1000;
      if (slot.end.getTime() - slot.start.getTime() >= durationMs) {
        return slot.start;
      }
    }
    return null;
  }

  /**
   * Генерация расписания на день
   */
  generateDailyPlan(tasks: ScheduledTask[], workHours: { start: number; end: number }): ScheduledTask[] {
    // Simple greedy algorithm for demo
    return tasks.sort((a, b) => b.priority - a.priority);
  }
}
