import type { Env } from "../types/index.js";

type EmbeddingProvider = "gemini" | "openai";

export class EmbeddingService {
  private provider: EmbeddingProvider;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private dimensions?: number;
  private readonly maxRetryAttempts = 5;
  private readonly baseRetryDelayMs = 1000;

  constructor(env: Env) {
    this.provider = env.EMBEDDING_PROVIDER;
    const openaiKey = env.OPENAI_API_KEY || "";
    const openaiBaseUrl = env.OPENAI_BASE_URL;
    this.apiKey = env.EMBEDDING_API_KEY || openaiKey || env.LLM_API_KEY || "";
    this.model = env.EMBEDDING_MODEL;
    this.dimensions = env.EMBEDDING_DIMENSIONS;
    this.baseUrl = env.EMBEDDING_BASE_URL || openaiBaseUrl || this.defaultBaseUrl(this.provider);
    if (this.baseUrl.endsWith("/")) this.baseUrl = this.baseUrl.slice(0, -1);
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error("No embedding API key configured (EMBEDDING_API_KEY/OPENAI_API_KEY/LLM_API_KEY)");
    }

    try {
      return await this.withRetryOnQuota(async () => {
        if (this.provider === "gemini") {
          return this.generateGeminiEmbedding(text);
        }
        return this.generateOpenAiEmbedding(text);
      });
    } catch (error) {
      console.error("Embedding generation failed:", error);
      throw error;
    }
  }

  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error("No embedding API key configured (EMBEDDING_API_KEY/OPENAI_API_KEY/LLM_API_KEY)");
    }
    if (texts.length === 0) return [];

    try {
      return await this.withRetryOnQuota(async () => {
        if (this.provider === "gemini") {
          const out: number[][] = [];
          for (const text of texts) out.push(await this.generateGeminiEmbedding(text));
          return out;
        }
        return this.generateOpenAiBatchEmbeddings(texts);
      });
    } catch (error) {
      console.error("Batch embedding generation failed:", error);
      throw error;
    }
  }

  private defaultBaseUrl(provider: EmbeddingProvider): string {
    return provider === "openai"
      ? "https://api.openai.com/v1"
      : "https://api.openai.com/v1";
  }

  private async generateGeminiEmbedding(text: string): Promise<number[]> {
    const modelName = this.model.startsWith("models/") ? this.model.slice("models/".length) : this.model;
    const url = `${this.baseUrl}/v1beta/models/${modelName}:embedContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini Embedding API error (${response.status}): ${errorText}`);
    }

    const data: any = await response.json();
    return data.embedding.values as number[];
  }

  private async generateOpenAiEmbedding(text: string): Promise<number[]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
    };
    if (this.dimensions && this.model.startsWith("text-embedding-3")) {
      body.dimensions = this.dimensions;
    }

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI Embedding API error (${response.status}): ${errorText}`);
    }

    const data: any = await response.json();
    return data.data[0].embedding as number[];
  }

  private async generateOpenAiBatchEmbeddings(texts: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
    };
    if (this.dimensions && this.model.startsWith("text-embedding-3")) {
      body.dimensions = this.dimensions;
    }

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI Batch Embedding API error (${response.status}): ${errorText}`);
    }

    const data: any = await response.json();
    return data.data.map((item: any) => item.embedding as number[]);
  }

  private async withRetryOnQuota<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < this.maxRetryAttempts) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const canRetry = this.isRateLimitOrQuotaError(error);
        if (!canRetry || attempt === this.maxRetryAttempts - 1) break;
        await this.sleep(this.baseRetryDelayMs * 2 ** attempt);
        attempt += 1;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Embedding request failed");
  }

  private isRateLimitOrQuotaError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || "");
    return (
      message.includes("(429)") ||
      message.includes("RESOURCE_EXHAUSTED") ||
      message.includes("quota") ||
      message.includes("rate limit")
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
