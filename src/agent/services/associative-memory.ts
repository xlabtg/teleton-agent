import { SemanticMemoryService, SemanticMemoryItem } from './semantic-memory';

/**
 * v2-02 Associative Graph-Based Memory
 * Строит граф связей между воспоминаниями на основе общих сущностей, тегов и контекста.
 * Позволяет агенту "ассоциировать" идеи (например, связать "проект Х" с "клиентом Y" и "дедлайном Z").
 */

interface MemoryNode {
  id: string;
  item: SemanticMemoryItem;
  connections: Map<string, number>; // nodeId -> strength
}

export class AssociativeMemoryGraph {
  private nodes: Map<string, MemoryNode>;
  private semanticMemory: SemanticMemoryService;

  constructor(semanticMemory: SemanticMemoryService) {
    this.nodes = new Map();
    this.semanticMemory = semanticMemory;
  }

  /**
   * Добавление узла в граф и построение ассоциативных связей
   */
  async addNode(item: SemanticMemoryItem): Promise<void> {
    if (this.nodes.has(item.id)) return;

    const node: MemoryNode = {
      id: item.id,
      item,
      connections: new Map(),
    };

    this.nodes.set(item.id, node);

    // Поиск ассоциаций с существующими узлами
    await this.buildAssociations(node);
  }

  private async buildAssociations(newNode: MemoryNode): Promise<void> {
    for (const [otherId, otherNode] of this.nodes.entries()) {
      if (otherId === newNode.item.id) continue;

      let strength = 0;

      // 1. Общие теги
      const commonTags = newNode.item.tags.filter(t => otherNode.item.tags.includes(t));
      strength += commonTags.length * 0.3;

      // 2. Близость по времени (если события были рядом)
      const timeDiff = Math.abs(newNode.item.timestamp - otherNode.item.timestamp);
      if (timeDiff < 3600000) strength += 0.2; // В течение часа
      else if (timeDiff < 86400000) strength += 0.1; // В течение дня

      // 3. Семантическая близость (упрощенно, через cosine similarity эмбеддингов)
      const similarity = this.calculateCosineSimilarity(
        newNode.item.embedding,
        otherNode.item.embedding
      );
      strength += similarity * 0.5;

      if (strength > 0.2) {
        newNode.connections.set(otherId, strength);
        otherNode.connections.set(newNode.item.id, strength);
      }
    }
  }

  private calculateCosineSimilarity(a: number[], b: number[]): number {
    const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return normA && normB ? dotProduct / (normA * normB) : 0;
  }

  /**
   * Получение связанных воспоминаний (ассоциативный поиск)
   */
  getAssociations(memoryId: string, minStrength: number = 0.3): SemanticMemoryItem[] {
    const node = this.nodes.get(memoryId);
    if (!node) return [];

    const results: SemanticMemoryItem[] = [];
    for (const [connectedId, strength] of node.connections.entries()) {
      if (strength >= minStrength) {
        const connectedNode = this.nodes.get(connectedId);
        if (connectedNode) results.push(connectedNode.item);
      }
    }
    return results;
  }

  /**
   * Обход графа для поиска цепочек ассоциаций
   */
  traverseAssociations(startId: string, depth: number = 2): Set<string> {
    const visited = new Set<string>();
    const queue: [{ id: string; currentDepth: number }] = [{ id: startId, currentDepth: 0 }];

    while (queue.length > 0) {
      const { id, currentDepth } = queue.shift()!;
      if (visited.has(id) || currentDepth > depth) continue;

      visited.add(id);
      const node = this.nodes.get(id);
      
      if (node && currentDepth < depth) {
        for (const connectedId of node.connections.keys()) {
          if (!visited.has(connectedId)) {
            queue.push({ id: connectedId, currentDepth: currentDepth + 1 });
          }
        }
      }
    }
    return visited;
  }
}

/**
 * v2-03 Importance-Based Memory Retention
 * Интегрируется с SemanticMemory и Graph для управления жизненным циклом памяти.
 */
export class MemoryRetentionManager {
  private semanticMemory: SemanticMemoryService;
  private graph: AssociativeMemoryGraph;

  constructor(semanticMemory: SemanticMemoryService, graph: AssociativeMemoryGraph) {
    this.semanticMemory = semanticMemory;
    this.graph = graph;
  }

  /**
   * Оценка важности воспоминания на основе частоты доступа и связей
   */
  calculateImportance(memoryId: string): number {
    const node = (this.graph as any).nodes.get(memoryId); // Access internal for demo
    if (!node) return 0;

    let score = node.item.importanceScore;

    // Boost based on number of strong connections (hub nodes are important)
    const strongConnections = Array.from(node.connections.values()).filter(s => s > 0.5).length;
    score += strongConnections * 0.1;

    // TODO: Add access frequency tracking here
    return Math.min(1.0, score);
  }

  /**
   * Запуск процесса "забывания" ненужного
   */
  async runRetentionCycle(): Promise<{ pruned: number; reinforced: number }> {
    // 1. Prune low importance memories via semantic service
    const pruned = await this.semanticMemory.pruneMemories(0.2);

    // 2. Reinforce highly connected nodes
    let reinforced = 0;
    // Implementation would iterate and call reinforceMemory
    
    return { pruned, reinforced };
  }
}
