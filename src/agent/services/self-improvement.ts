/**
 * v2-19 Feedback-Based Learning Loop
 * Анализирует фидбек пользователя для улучшения будущих решений.
 */
export interface FeedbackEntry {
  id: string;
  taskId: string;
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  timestamp: number;
  category: 'accuracy' | 'speed' | 'tone' | 'usefulness';
}

export class FeedbackLearningLoop {
  private feedbackHistory: FeedbackEntry[] = [];

  /**
   * Запись фидбека
   */
  addFeedback(entry: FeedbackEntry): void {
    this.feedbackHistory.push(entry);
  }

  /**
   * Анализ паттернов фидбека для выявления слабых мест
   */
  analyzePatterns(): { weakAreas: string[]; strongAreas: string[] } {
    const avgByCategory: Record<string, number[]> = {};

    for (const fb of this.feedbackHistory) {
      if (!avgByCategory[fb.category]) avgByCategory[fb.category] = [];
      avgByCategory[fb.category].push(fb.rating);
    }

    const weakAreas: string[] = [];
    const strongAreas: string[] = [];

    for (const [category, ratings] of Object.entries(avgByCategory)) {
      const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      if (avg < 3) weakAreas.push(category);
      if (avg >= 4.5) strongAreas.push(category);
    }

    return { weakAreas, strongAreas };
  }

  /**
   * Генерация рекомендаций по улучшению на основе фидбека
   */
  generateImprovementPlan(): string[] {
    const { weakAreas } = this.analyzePatterns();
    const recommendations: string[] = [];

    if (weakAreas.includes('accuracy')) {
      recommendations.push('Increase model temperature for more creative exploration or verify facts with search tools.');
    }
    if (weakAreas.includes('speed')) {
      recommendations.push('Optimize prompt length and reduce unnecessary tool calls.');
    }
    if (weakAreas.includes('tone')) {
      recommendations.push('Adjust system prompt to match user preferred communication style.');
    }

    return recommendations;
  }
}

/**
 * v2-20 Dynamic Prompt Optimization
 * Автоматически корректирует промпты на основе успешности предыдущих выполнений.
 */
export interface PromptVariant {
  id: string;
  template: string;
  successRate: number;
  usageCount: number;
}

export class PromptOptimizer {
  private variants: Map<string, PromptVariant> = new Map();

  constructor(initialPrompts: PromptVariant[]) {
    initialPrompts.forEach(p => this.variants.set(p.id, p));
  }

  /**
   * Выбор лучшего промпта на основе статистики
   */
  selectBestPrompt(taskType: string): PromptVariant | null {
    // In production, filter by taskType
    const sorted = Array.from(this.variants.values())
      .sort((a, b) => b.successRate - a.successRate);
    
    return sorted[0] || null;
  }

  /**
   * Обновление статистики после выполнения задачи
   */
  updateStats(promptId: string, success: boolean): void {
    const variant = this.variants.get(promptId);
    if (variant) {
      variant.usageCount++;
      // Moving average for success rate
      variant.successRate = (variant.successRate * (variant.usageCount - 1) + (success ? 1 : 0)) / variant.usageCount;
      this.variants.set(promptId, variant);
    }
  }

  /**
   * Создание новой вариации промпта (мутация)
   */
  createVariant(basePromptId: string, newTemplate: string): string {
    const newId = `prompt_${Date.now()}`;
    this.variants.set(newId, {
      id: newId,
      template: newTemplate,
      successRate: 0.5, // Prior
      usageCount: 0
    });
    return newId;
  }
}
