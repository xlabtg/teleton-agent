import { z } from 'zod';

/**
 * Уровни иерархии целей
 */
export enum GoalLevel {
  LONG_TERM = 'long_term',   // Стратегия (квартал/год)
  MID_TERM = 'mid_term',     // Тактика/Проекты (месяц/неделя)
  SHORT_TERM = 'short_term'  // Операционка (день/спринт)
}

/**
 * Статус цели
 */
export enum GoalStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  PAUSED = 'paused',
  BLOCKED = 'blocked',
  ARCHIVED = 'archived'
}

/**
 * Схема цели
 */
export const GoalSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  level: z.nativeEnum(GoalLevel),
  status: z.nativeEnum(GoalStatus).default(GoalStatus.ACTIVE),
  parentId: z.string().uuid().nullable(), // Ссылка на родительскую цель
  priority: z.number().min(1).max(10).default(5),
  deadline: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  metrics: z.object({
    progress: z.number().min(0).max(100).default(0),
    completedSubtasks: z.number().default(0),
    totalSubtasks: z.number().default(0)
  }).default({ progress: 0, completedSubtasks: 0, totalSubtasks: 0 }),
  context: z.record(z.any()).optional() // Дополнительный контекст (бюджет, ресурсы и т.д.)
});

export type Goal = z.infer<typeof GoalSchema>;

/**
 * Результат декомпозиции
 */
export interface DecompositionResult {
  subGoals: Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>[];
  reasoning: string;
}

/**
 * Конфигурация для декомпозиции
 */
export interface DecompositionConfig {
  maxDepth: number;
  targetLevel: GoalLevel;
  includeMetrics: boolean;
}
