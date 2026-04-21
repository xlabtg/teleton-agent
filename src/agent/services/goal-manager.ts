import { v4 as uuidv4 } from 'uuid';
import { Goal, GoalLevel, GoalStatus, DecompositionResult, DecompositionConfig } from '../types/goals';
import { LLMService } from './llm-service';

/**
 * Менеджер целей - управляет иерархией целей агента
 */
export class GoalManager {
  private goals: Map<string, Goal> = new Map();
  private llmService: LLMService;

  constructor(llmService: LLMService) {
    this.llmService = llmService;
  }

  /**
   * Создать новую цель
   */
  async createGoal(
    title: string,
    level: GoalLevel,
    description?: string,
    parentId?: string,
    priority?: number,
    deadline?: Date,
    context?: Record<string, any>
  ): Promise<Goal> {
    const goal: Goal = {
      id: uuidv4(),
      title,
      description,
      level,
      status: GoalStatus.ACTIVE,
      parentId: parentId || null,
      priority: priority || 5,
      deadline: deadline || null,
      createdAt: new Date(),
      updatedAt: new Date(),
      metrics: { progress: 0, completedSubtasks: 0, totalSubtasks: 0 },
      context
    };

    this.goals.set(goal.id, goal);

    // Если это подзадача, обновить метрики родителя
    if (parentId) {
      await this.updateParentMetrics(parentId);
    }

    return goal;
  }

  /**
   * Получить цель по ID
   */
  getGoal(id: string): Goal | undefined {
    return this.goals.get(id);
  }

  /**
   * Получить все цели определенного уровня
   */
  getGoalsByLevel(level: GoalLevel): Goal[] {
    return Array.from(this.goals.values()).filter(g => g.level === level);
  }

  /**
   * Получить дочерние цели
   */
  getChildGoals(parentId: string): Goal[] {
    return Array.from(this.goals.values()).filter(g => g.parentId === parentId);
  }

  /**
   * Обновить статус цели
   */
  async updateGoalStatus(id: string, status: GoalStatus): Promise<Goal | null> {
    const goal = this.goals.get(id);
    if (!goal) return null;

    goal.status = status;
    goal.updatedAt = new Date();

    if (status === GoalStatus.COMPLETED) {
      goal.metrics.progress = 100;
    }

    this.goals.set(id, goal);

    // Обновить родителя
    if (goal.parentId) {
      await this.updateParentMetrics(goal.parentId);
    }

    return goal;
  }

  /**
   * Обновить прогресс цели
   */
  async updateGoalProgress(id: string, progress: number): Promise<Goal | null> {
    const goal = this.goals.get(id);
    if (!goal) return null;

    goal.metrics.progress = Math.min(100, Math.max(0, progress));
    goal.updatedAt = new Date();

    this.goals.set(id, goal);

    // Обновить родителя
    if (goal.parentId) {
      await this.updateParentMetrics(goal.parentId);
    }

    return goal;
  }

  /**
   * Обновить метрики родительской цели на основе дочерних
   */
  private async updateParentMetrics(parentId: string): Promise<void> {
    const parent = this.goals.get(parentId);
    if (!parent) return;

    const children = this.getChildGoals(parentId);
    const total = children.length;
    const completed = children.filter(c => c.status === GoalStatus.COMPLETED).length;

    // Рассчитать средний прогресс
    const avgProgress = total > 0
      ? children.reduce((sum, c) => sum + c.metrics.progress, 0) / total
      : 0;

    parent.metrics.totalSubtasks = total;
    parent.metrics.completedSubtasks = completed;
    parent.metrics.progress = Math.round(avgProgress);
    parent.updatedAt = new Date();

    // Автоматически завершить родителя, если все дети завершены
    if (total > 0 && completed === total) {
      parent.status = GoalStatus.COMPLETED;
    }

    this.goals.set(parentId, parent);

    // Рекурсивно обновить выше по иерархии
    if (parent.parentId) {
      await this.updateParentMetrics(parent.parentId);
    }
  }

  /**
   * Декомпозировать цель на подцели с помощью LLM
   */
  async decomposeGoal(
    goalId: string,
    config: DecompositionConfig = { maxDepth: 2, targetLevel: GoalLevel.SHORT_TERM, includeMetrics: true }
  ): Promise<DecompositionResult> {
    const goal = this.goals.get(goalId);
    if (!goal) {
      throw new Error(`Goal ${goalId} not found`);
    }

    const prompt = this.buildDecompositionPrompt(goal, config);
    
    try {
      const response = await this.llmService.generate(prompt, {
        temperature: 0.7,
        maxTokens: 2000
      });

      const result = this.parseDecompositionResponse(response, goal, config);
      
      // Создать подцели в системе
      for (const subGoal of result.subGoals) {
        await this.createGoal(
          subGoal.title,
          subGoal.level,
          subGoal.description,
          goal.id,
          subGoal.priority,
          subGoal.deadline,
          subGoal.context
        );
      }

      return result;
    } catch (error) {
      console.error('Failed to decompose goal:', error);
      throw new Error(`Decomposition failed: ${error}`);
    }
  }

  /**
   * Построить промпт для декомпозиции
   */
  private buildDecompositionPrompt(goal: Goal, config: DecompositionConfig): string {
    const levelNames = {
      [GoalLevel.LONG_TERM]: 'долгосрочная стратегическая цель (квартал/год)',
      [GoalLevel.MID_TERM]: 'среднесрочный проект (месяц/неделя)',
      [GoalLevel.SHORT_TERM]: 'краткосрочная задача (день/спринт)'
    };

    return `Ты - эксперт по стратегическому планированию. Твоя задача - разбить цель на конкретные подцели.

ГЛАВНАЯ ЦЕЛЬ:
${goal.title}
${goal.description ? `Описание: ${goal.description}` : ''}
Уровень: ${levelNames[goal.level]}
Приоритет: ${goal.priority}/10
${goal.deadline ? `Дедлайн: ${goal.deadline.toISOString().split('T')[0]}` : ''}

ЗАДАЧА:
Разбей эту цель на 3-7 конкретных подцелей уровня "${levelNames[config.targetLevel]}".

Для каждой подцели укажи:
1. Название (четкое и измеримое)
2. Краткое описание
3. Приоритет (1-10)
4. Рекомендуемый дедлайн (если уместно)
5. Ключевые метрики успеха

Формат ответа (строго JSON):
{
  "subGoals": [
    {
      "title": "...",
      "description": "...",
      "priority": 5,
      "deadline": "YYYY-MM-DD",
      "context": {"metrics": "..."}
    }
  ],
  "reasoning": "Объяснение логики декомпозиции"
}

Важно:
- Подцели должны быть конкретными и выполнимыми
- Избегай абстрактных формулировок
- Учитывай логическую последовательность выполнения
- Сфокусируйся на действиях, которые приведут к достижению главной цели`;
  }

  /**
   * Распарсить ответ LLM о декомпозиции
   */
  private parseDecompositionResponse(
    response: string,
    parentGoal: Goal,
    config: DecompositionConfig
  ): DecompositionResult {
    try {
      // Попытка найти JSON в ответе
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      const subGoals = parsed.subGoals.map((sg: any) => ({
        title: sg.title,
        description: sg.description || '',
        level: config.targetLevel,
        status: GoalStatus.ACTIVE,
        parentId: parentGoal.id,
        priority: sg.priority || 5,
        deadline: sg.deadline ? new Date(sg.deadline) : null,
        metrics: { progress: 0, completedSubtasks: 0, totalSubtasks: 0 },
        context: sg.context || {}
      }));

      return {
        subGoals,
        reasoning: parsed.reasoning || 'Декомпозиция выполнена'
      };
    } catch (error) {
      console.error('Failed to parse decomposition response:', error);
      // Вернуть заглушку при ошибке парсинга
      return {
        subGoals: [{
          title: 'Анализировать и создать подзадачи вручную',
          description: 'Автоматическая декомпозиция не удалась',
          level: config.targetLevel,
          status: GoalStatus.ACTIVE,
          parentId: parentGoal.id,
          priority: 10,
          deadline: null,
          metrics: { progress: 0, completedSubtasks: 0, totalSubtasks: 0 }
        }],
        reasoning: 'Ошибка парсинга ответа LLM'
      };
    }
  }

  /**
   * Динамически пересмотреть приоритеты на основе контекста
   */
  async reprioritizeGoals(contextChanges: Record<string, any>): Promise<Goal[]> {
    const activeGoals = Array.from(this.goals.values()).filter(
      g => g.status === GoalStatus.ACTIVE
    );

    // Простая эвристика: увеличить приоритет срочных целей
    const updatedGoals: Goal[] = [];
    
    for (const goal of activeGoals) {
      let newPriority = goal.priority;

      // Если дедлайн близко - повысить приоритет
      if (goal.deadline) {
        const daysUntilDeadline = (goal.deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        if (daysUntilDeadline < 3) {
          newPriority = Math.min(10, newPriority + 3);
        } else if (daysUntilDeadline < 7) {
          newPriority = Math.min(10, newPriority + 1);
        }
      }

      // Если есть контекстные изменения, влияющие на цель
      if (contextChanges.urgency === 'high' && goal.priority < 8) {
        newPriority = Math.min(10, newPriority + 2);
      }

      if (newPriority !== goal.priority) {
        goal.priority = newPriority;
        goal.updatedAt = new Date();
        this.goals.set(goal.id, goal);
        updatedGoals.push(goal);
      }
    }

    return updatedGoals;
  }

  /**
   * Получить дерево целей (рекурсивно)
   */
  getGoalTree(rootId?: string): any[] {
    const roots = rootId 
      ? [this.goals.get(rootId)].filter(Boolean) as Goal[]
      : Array.from(this.goals.values()).filter(g => !g.parentId);

    const buildTree = (goal: Goal): any => ({
      ...goal,
      children: this.getChildGoals(goal.id).map(buildTree)
    });

    return roots.map(buildTree);
  }

  /**
   * Удалить цель (и все дочерние)
   */
  async deleteGoal(id: string): Promise<boolean> {
    const goal = this.goals.get(id);
    if (!goal) return false;

    // Рекурсивно удалить дочерние
    const children = this.getChildGoals(id);
    for (const child of children) {
      await this.deleteGoal(child.id);
    }

    this.goals.delete(id);

    // Обновить родителя
    if (goal.parentId) {
      await this.updateParentMetrics(goal.parentId);
    }

    return true;
  }

  /**
   * Получить статистику по целям
   */
  getGoalStats(): {
    total: number;
    byLevel: Record<GoalLevel, number>;
    byStatus: Record<GoalStatus, number>;
    avgProgress: number;
  } {
    const goals = Array.from(this.goals.values());
    
    return {
      total: goals.length,
      byLevel: {
        [GoalLevel.LONG_TERM]: goals.filter(g => g.level === GoalLevel.LONG_TERM).length,
        [GoalLevel.MID_TERM]: goals.filter(g => g.level === GoalLevel.MID_TERM).length,
        [GoalLevel.SHORT_TERM]: goals.filter(g => g.level === GoalLevel.SHORT_TERM).length
      },
      byStatus: {
        [GoalStatus.ACTIVE]: goals.filter(g => g.status === GoalStatus.ACTIVE).length,
        [GoalStatus.COMPLETED]: goals.filter(g => g.status === GoalStatus.COMPLETED).length,
        [GoalStatus.PAUSED]: goals.filter(g => g.status === GoalStatus.PAUSED).length,
        [GoalStatus.BLOCKED]: goals.filter(g => g.status === GoalStatus.BLOCKED).length,
        [GoalStatus.ARCHIVED]: goals.filter(g => g.status === GoalStatus.ARCHIVED).length
      },
      avgProgress: goals.length > 0
        ? Math.round(goals.reduce((sum, g) => sum + g.metrics.progress, 0) / goals.length)
        : 0
    };
  }
}
