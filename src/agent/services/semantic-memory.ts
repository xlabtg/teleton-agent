import { Embeddings } from '@langchain/core/embeddings';
import { VectorStore } from '@langchain/core/vectorstores';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { Document } from '@langchain/core/documents';

/**
 * v2-01 Semantic Vector Memory with Embeddings
 * Хранит воспоминания как векторы для семантического поиска по смыслу, а не ключевым словам.
 */
export interface SemanticMemoryItem {
  id: string;
  content: string;
  embedding: number[];
  timestamp: number;
  source: 'user_input' | 'agent_action' | 'observation' | 'reflection';
  tags: string[];
  importanceScore: number; // Для v2-03
}

export class SemanticMemoryService {
  private vectorStore: VectorStore;
  private embeddings: Embeddings;
  private memoryIndex: Map<string, SemanticMemoryItem>;

  constructor(embeddings: Embeddings) {
    this.embeddings = embeddings;
    this.vectorStore = new MemoryVectorStore(embeddings);
    this.memoryIndex = new Map();
  }

  /**
   * Сохранение нового воспоминания с автоматическим эмбеддингом
   */
  async addMemory(
    content: string,
    source: SemanticMemoryItem['source'],
    tags: string[] = []
  ): Promise<string> {
    const embedding = await this.embeddings.embedQuery(content);
    const id = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const item: SemanticMemoryItem = {
      id,
      content,
      embedding,
      timestamp: Date.now(),
      source,
      tags,
      importanceScore: 1.0, // Default
    };

    await this.vectorStore.addDocuments([
      new Document({
        pageContent: content,
        metadata: { id, source, timestamp: item.timestamp, tags },
      })
    ]);

    this.memoryIndex.set(id, item);
    return id;
  }

  /**
   * Семантический поиск наиболее релевантных воспоминаний
   */
  async searchRelevant(
    query: string,
    limit: number = 5,
    filter?: { source?: SemanticMemoryItem['source']; tags?: string[] }
  ): Promise<SemanticMemoryItem[]> {
    const results = await this.vectorStore.similaritySearchWithScore(query, limit);
    
    return results.map(([doc, score]) => {
      const meta = doc.metadata as any;
      const storedItem = this.memoryIndex.get(meta.id);
      return storedItem ? { ...storedItem, relevanceScore: score } : null;
    }).filter(Boolean) as (SemanticMemoryItem & { relevanceScore: number })[];
  }

  /**
   * Удаление старых или неважных воспоминаний (часть v2-03)
   */
  async pruneMemories(threshold: number = 0.3): Promise<number> {
    let removedCount = 0;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    for (const [id, item] of this.memoryIndex.entries()) {
      // Decay formula: importance decreases over time unless reinforced
      const ageInDays = (now - item.timestamp) / dayMs;
      const currentImportance = item.importanceScore * Math.exp(-0.05 * ageInDays);

      if (currentImportance < threshold) {
        // In a real vector store, we would delete by ID here
        this.memoryIndex.delete(id);
        removedCount++;
      }
    }
    return removedCount;
  }

  /**
   * Обновление важности воспоминания (подкрепление)
   */
  async reinforceMemory(id: string, boost: number = 0.2): Promise<void> {
    const item = this.memoryIndex.get(id);
    if (item) {
      item.importanceScore = Math.min(1.0, item.importanceScore + boost);
      this.memoryIndex.set(id, item);
    }
  }
}
