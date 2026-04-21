import { SemanticMemoryService } from './semantic-memory';

/**
 * v2-04 Prediction Engine for Next User Actions
 * Анализирует историю действий и контекст для предсказания следующего шага пользователя.
 */
export interface ActionPrediction {
  predictedAction: string;
  confidence: number;
  reasoning: string;
  suggestedPreparation: string[]; // Что агент может подготовить заранее
}

export class PredictionEngine {
  private memoryService: SemanticMemoryService;
  private historyWindow: any[] = []; // Last N interactions

  constructor(memoryService: SemanticMemoryService) {
    this.memoryService = memoryService;
  }

  /**
   * Предсказание следующего действия на основе паттернов
   */
  async predictNextAction(currentContext: string): Promise<ActionPrediction> {
    // 1. Retrieve semantically similar past sequences
    const relevantMemories = await this.memoryService.searchRelevant(currentContext, 5);
    
    // 2. Analyze patterns (Simplified logic for demo)
    // In production, this would use a dedicated ML model or LLM chain
    let predictedAction = "ask_for_clarification";
    let confidence = 0.5;
    const preparations: string[] = [];

    if (relevantMemories.length > 0) {
      // Heuristic: If user often asks for code after discussing "feature", prepare IDE
      const hasFeatureTalk = relevantMemories.some(m => 
        m.content.toLowerCase().includes('feature') || m.content.toLowerCase().includes('implement')
      );
      
      if (hasFeatureTalk) {
        predictedAction = "request_code_generation";
        confidence = 0.75;
        preparations.push("open_ide_context", "load_related_files");
      }
    }

    return {
      predictedAction,
      confidence,
      reasoning: `Based on ${relevantMemories.length} similar past interactions.`,
      suggestedPreparation: preparations
    };
  }

  /**
   * v2-05 Predictive Caching Layer
   * Кэширует данные, которые могут понадобиться согласно предсказанию
   */
  async preloadResources(preparations: string[]): Promise<void> {
    // Logic to fetch data before user explicitly asks
    console.log(`[PredictionEngine] Preloading resources: ${preparations.join(', ')}`);
    // Implementation depends on specific resource types (files, API data, etc.)
  }
}

/**
 * v2-06 Anomaly Detection for Unusual Behavior
 * Детектирует отклонения от нормальных паттернов использования или поведения агента.
 */
export interface AnomalyReport {
  type: 'user_behavior' | 'agent_performance' | 'system_resource';
  severity: 'low' | 'medium' | 'high';
  description: string;
  deviationScore: number; // 0.0 to 1.0
  timestamp: number;
}

export class AnomalyDetector {
  private baselineMetrics: Map<string, number[]>;

  constructor() {
    this.baselineMetrics = new Map();
  }

  /**
   * Запись метрики и проверка на аномалию
   */
  recordMetric(name: string, value: number): AnomalyReport | null {
    if (!this.baselineMetrics.has(name)) {
      this.baselineMetrics.set(name, []);
    }
    const history = this.baselineMetrics.get(name)!;
    history.push(value);
    if (history.length > 100) history.shift(); // Keep last 100

    if (history.length < 10) return null; // Not enough data

    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / history.length;
    const stdDev = Math.sqrt(variance);

    // Z-score calculation
    const zScore = Math.abs((value - mean) / (stdDev || 1));

    if (zScore > 2.5) {
      return {
        type: 'user_behavior', // Simplified
        severity: zScore > 3.5 ? 'high' : 'medium',
        description: `Unusual value for ${name}: ${value.toFixed(2)} (mean: ${mean.toFixed(2)})`,
        deviationScore: Math.min(1.0, zScore / 5),
        timestamp: Date.now()
      };
    }
    return null;
  }
}
