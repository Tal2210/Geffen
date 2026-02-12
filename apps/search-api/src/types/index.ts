import { z } from "zod";

// ============================================================================
// Request/Response Schemas
// ============================================================================

export const SearchQuerySchema = z.object({
  query: z.string().min(1).max(500),
  merchantId: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(24),
  offset: z.number().int().min(0).default(0),
  // Optional explicit filters
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  colors: z.array(z.string()).optional(),
  countries: z.array(z.string()).optional(),
  kosher: z.boolean().optional(),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

// ============================================================================
// Extracted Filters (from NER/Query Parsing)
// ============================================================================

export interface ExtractedFilters {
  priceRange?: { min?: number; max?: number };
  countries?: string[]; // ['france', 'italy', 'spain', etc.]
  grapes?: string[]; // ['cabernet', 'merlot', 'chardonnay', etc.]
  sweetness?: string[]; // ['dry', 'semi-dry', 'sweet']
  type?: string[]; // ['wine', 'whiskey', 'liqueur', 'vodka', etc.]
  category?: string[]; // ['red', 'white', 'rosé', 'sparkling'] (hard color category)
  softTags?: string[]; // ['pizza', 'portugal', 'bordeaux', ...] (soft boosts)
  kosher?: boolean;
  regions?: string[]; // ['bordeaux', 'tuscany', 'rioja', etc.]
}

// ============================================================================
// Wine Product (MongoDB Document)
// ============================================================================

export interface WineProduct {
  _id: string;
  merchantId: string;
  name: string;
  description?: string;
  price: number;
  currency?: string;
  color?: string; // 'red' | 'white' | 'rosé' | 'sparkling'
  country?: string;
  region?: string;
  grapes?: string[];
  vintage?: number;
  sweetness?: string; // 'dry' | 'semi-dry' | 'sweet'
  kosher?: boolean;
  alcohol?: number;
  volume?: number; // ml
  imageUrl?: string;
  inStock?: boolean;
  stockCount?: number;
  rating?: number; // 0-100
  category?: string[]; // ['יין', 'יין אדום', ...]
  softCategory?: string | string[]; // ['פורטוגל', 'פיצה', ...] or single value
  reviewCount?: number;
  
  // Vector embedding (for semantic search)
  embedding?: number[]; // 768-dim or 1536-dim
  
  // Metadata for reranking
  salesCount30d?: number;
  viewCount30d?: number;
  popularity?: number;
  createdAt?: Date;
  updatedAt?: Date;
  
  // Allow any additional fields from bana.stores
  [key: string]: any;
}

// ============================================================================
// Vector Search Result (with score)
// ============================================================================

export interface VectorSearchHit extends WineProduct {
  score: number; // similarity score from MongoDB
}

// ============================================================================
// Final Search Result
// ============================================================================

export interface SearchResult {
  products: WineProduct[];
  metadata: {
    query: string;
    appliedFilters: ExtractedFilters;
    ner?: {
      enabled: boolean;
      confidence?: number;
      language?: "he" | "en" | "mixed" | "unknown";
      extractedFilters: ExtractedFilters;
    };
    totalResults: number;
    returnedCount: number;
    timings: {
      parsing: number;
      embedding: number;
      vectorSearch: number;
      reranking: number;
      total: number;
    };
  };
}

// ============================================================================
// Environment Configuration
// ============================================================================

export const EnvSchema = z.object({
  MONGO_URI: z.string().min(1),
  MONGO_DB: z.string().min(1),
  MONGO_COLLECTION: z.string().default("bana.stores"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-4.1-mini"),
  EMBEDDING_PROVIDER: z.enum(["gemini", "openai"]).default("openai"),
  EMBEDDING_BASE_URL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-large"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),
  NER_ENABLED: z.coerce.boolean().default(true),
  // Optional override for NER/explanations. Defaults to LLM_MODEL.
  NER_MODEL: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
