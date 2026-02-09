import type { Env } from "../types/index.js";

/**
 * Generates vector embeddings for semantic search
 * Uses OpenAI-compatible API (Gemini, OpenAI, or local models)
 */
export class EmbeddingService {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(env: Env) {
    this.apiKey = env.LLM_API_KEY || "";
    /**
     * IMPORTANT:
     * Our MongoDB Atlas vector index is configured for 768 dimensions, and the stored product embeddings were generated
     * using Gemini's `gemini-embedding-001` (768 dims).
     *
     * If the runtime query embedding model produces a different dimension (e.g. 3072), Atlas will error and we'll
     * end up in the (misleading) text-search fallback. To keep the system consistent, we force the query embedding
     * model/provider here.
     */
    this.baseUrl = "https://generativelanguage.googleapis.com";
    this.model = "gemini-embedding-001";
  }

  /**
   * Generate embedding for a single text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error("LLM_API_KEY not configured for embeddings");
    }

    try {
      // Check if using Gemini API
      const isGemini = this.baseUrl.includes("generativelanguage.googleapis.com");
      
      if (isGemini) {
        // Gemini uses a different endpoint structure
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: {
              parts: [{ text }]
            }
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Gemini Embedding API error (${response.status}): ${errorText}`);
        }

        const data: any = await response.json();
        return data.embedding.values as number[];
      } else {
        // OpenAI-compatible API
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: text,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Embedding API error (${response.status}): ${errorText}`);
        }

        const data: any = await response.json();
        return data.data[0].embedding as number[];
      }
    } catch (error) {
      console.error("Embedding generation failed:", error);
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   * More efficient for indexing products
   */
  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error("LLM_API_KEY not configured for embeddings");
    }

    if (texts.length === 0) {
      return [];
    }

    try {
      // Check if using Gemini API
      const isGemini = this.baseUrl.includes("generativelanguage.googleapis.com");
      
      if (isGemini) {
        // Gemini doesn't support batch embeddings in a single call
        // We need to make individual requests
        const embeddings: number[][] = [];
        for (const text of texts) {
          const embedding = await this.generateEmbedding(text);
          embeddings.push(embedding);
        }
        return embeddings;
      } else {
        // OpenAI-compatible API supports batch
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: texts,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Batch embedding API error (${response.status}): ${errorText}`);
        }

        const data: any = await response.json();
        return data.data.map((item: any) => item.embedding as number[]);
      }
    } catch (error) {
      console.error("Batch embedding generation failed:", error);
      throw error;
    }
  }
}
