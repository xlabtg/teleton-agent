import { createHash } from "node:crypto";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function serializeEmbedding(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

/**
 * Deserialize embedding from storage (handles BLOB and legacy JSON TEXT).
 */
export function deserializeEmbedding(data: Buffer | string): number[] {
  try {
    if (Buffer.isBuffer(data)) {
      const floats = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      return Array.from(floats);
    }
    return JSON.parse(data) as number[];
  } catch {
    return [];
  }
}
