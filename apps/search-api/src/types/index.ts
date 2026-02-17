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

export const ImageSearchRequestSchema = z.object({
  imageDataUrl: z.string().min(30).max(8_000_000),
  queryHint: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(50).default(12),
});

export type ImageSearchRequest = z.infer<typeof ImageSearchRequestSchema>;

export const OnboardingCategoryValues = [
  "fashion",
  "footwear",
  "wine",
  "furniture",
  "beauty",
  "electronics",
  "jewelry",
  "home_decor",
  "sports",
  "pets",
  "toys",
  "kids",
  "food",
  "supplements",
  "books",
  "automotive",
  "garden",
  "travel",
  "bags",
  "lingerie",
] as const;

export const OnboardingCategorySchema = z.enum(OnboardingCategoryValues);
export type OnboardingCategory = z.infer<typeof OnboardingCategorySchema>;

export const OnboardingStartRequestSchema = z.object({
  websiteUrl: z.string().url().max(2048),
  category: OnboardingCategorySchema,
  email: z.string().email().max(320),
});

export type OnboardingStartRequest = z.infer<typeof OnboardingStartRequestSchema>;

export const OnboardingDemoSearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(24),
  offset: z.number().int().min(0).default(0),
});

export type OnboardingDemoSearchRequest = z.infer<typeof OnboardingDemoSearchRequestSchema>;

export const OnboardingTrackEventSchema = z.object({
  event: z.enum([
    "start_clicked",
    "job_polled",
    "demo_opened",
    "demo_search",
    "demo_exit",
    "error_seen",
  ]),
  jobId: z.string().min(1).max(120).optional(),
  demoId: z.string().min(1).max(120).optional(),
  websiteUrl: z.string().url().max(2048).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export type OnboardingTrackEvent = z.infer<typeof OnboardingTrackEventSchema>;

export const DetectedWineSchema = z.object({
  name: z.string().min(1).max(300),
  producer: z.string().max(200).optional(),
  vintage: z.number().int().min(1900).max(2100).optional(),
  wineColor: z.enum(["red", "white", "rose", "sparkling"]).optional(),
  country: z.string().max(80).optional(),
  region: z.string().max(120).optional(),
  grapes: z.array(z.string().max(80)).max(8).default([]),
  styleTags: z.array(z.string().max(80)).max(12).default([]),
  confidence: z.number().min(0).max(1).optional(),
});

export type DetectedWine = z.infer<typeof DetectedWineSchema>;

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
    retrieval?: {
      vectorCandidates: number;
      textCandidates: number;
      mergedCandidates: number;
      mode?: "text_only" | "hybrid";
      vectorStatus?: "ok" | "empty" | "skipped_text_strong" | "embedding_failed";
    };
    timings: {
      parsing: number;
      embedding: number;
      vectorSearch: number;
      reranking: number;
      total: number;
    };
  };
}

export interface ImageSearchResult {
  detectedWine: DetectedWine;
  exactMatch: WineProduct | null;
  textualMatches: WineProduct[];
  alternatives: WineProduct[];
  metadata: {
    decision: "exact" | "alternatives";
    searchStrategy: "text_first_then_vector";
    reason: string;
    textualCount: number;
    alternativesCount: number;
    vectorAttempted: boolean;
    vectorUsedAsFallback: boolean;
    messages: {
      textualSection: string;
      alternativesSection: string;
    };
    derivedTags: string[];
    tagSource: "llm_catalog_context" | "catalog_fallback";
    timings: {
      analysis: number;
      matching: number;
      tagging: number;
      total: number;
    };
  };
}

export type OnboardingJobStatus = "queued" | "running" | "ready" | "partial_ready" | "failed";

export interface OnboardingJobProgress {
  step:
    | "queued"
    | "discover"
    | "extract"
    | "normalize"
    | "sample"
    | "embed"
    | "index"
    | "finalize"
    | "done"
    | "failed";
  percent: number;
  message?: string;
}

export interface OnboardingNormalizedProduct {
  name: string;
  description?: string;
  price: number;
  currency?: string;
  imageUrl?: string;
  productUrl: string;
  brand?: string;
  category?: string;
  inStock?: boolean;
  source: "shopify" | "woocommerce" | "generic_static" | "browser_fallback";
  raw?: Record<string, unknown>;
}

export interface OnboardingIndexedProduct extends OnboardingNormalizedProduct {
  _id: string;
  jobId: string;
  demoId: string;
  merchantId: string;
  embedding?: number[];
  score?: number;
  finalScore?: number;
  createdAt: string;
  expiresAt: string;
}

export interface OnboardingStartResponse {
  jobId: string;
  status: OnboardingJobStatus;
  pollUrl: string;
  createdAt: string;
}

export interface OnboardingJobStatusResponse {
  jobId: string;
  websiteUrl: string;
  category: OnboardingCategory;
  email: string;
  status: OnboardingJobStatus;
  progress: OnboardingJobProgress;
  errorCode?: string;
  errorMessage?: string;
  demoToken?: string;
  demoUrl?: string;
  demoId?: string;
  productCount?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface OnboardingDemoResponse {
  demoId: string;
  websiteUrl: string;
  category: OnboardingCategory;
  productCount: number;
  status: "ready" | "partial_ready";
  createdAt: string;
  expiresAt: string;
  previewProducts: OnboardingIndexedProduct[];
}

export interface OnboardingDemoSearchResult {
  products: OnboardingIndexedProduct[];
  metadata: {
    query: string;
    totalResults: number;
    returnedCount: number;
    retrieval: {
      vectorCandidates: number;
      textCandidates: number;
      mergedCandidates: number;
      mode: "text_only" | "hybrid";
      vectorStatus: "ok" | "empty" | "embedding_failed" | "vector_failed";
    };
    timings: {
      textSearch: number;
      embedding: number;
      vectorSearch: number;
      merge: number;
      total: number;
    };
  };
}

export interface OnboardingAssistSelector {
  selector: string;
  mode: "text" | "src";
  sampleText?: string;
}

export interface OnboardingAssistCustomField {
  key: string;
  label: string;
  selector: OnboardingAssistSelector;
}

export interface OnboardingAssistTemplatePayload {
  websiteUrl: string;
  productUrl: string;
  category?: OnboardingCategory;
  selectors: {
    name: OnboardingAssistSelector;
    price?: OnboardingAssistSelector;
    image?: OnboardingAssistSelector;
    description?: OnboardingAssistSelector;
    inStock?: OnboardingAssistSelector;
  };
  customFields?: OnboardingAssistCustomField[];
}

export interface OnboardingAssistRuntimeTemplate {
  domain: string;
  websiteUrl: string;
  sampleProductUrl: string;
  category?: OnboardingCategory;
  selectors: {
    name: OnboardingAssistSelector;
    price?: OnboardingAssistSelector;
    image?: OnboardingAssistSelector;
    description?: OnboardingAssistSelector;
    inStock?: OnboardingAssistSelector;
  };
  customFields: OnboardingAssistCustomField[];
}

export interface OnboardingSampleProduct {
  name?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  description?: string;
  inStock?: boolean;
  attributes: Record<string, string>;
}

export interface OnboardingAssistExtractSampleResult {
  sampleProduct: OnboardingSampleProduct;
  missingFields: string[];
}

export interface OnboardingJobCounters {
  extracted: number;
  normalized: number;
  embedded: number;
  indexed: number;
}

export interface OnboardingJobLiveResponse {
  jobId: string;
  status: OnboardingJobStatus;
  progress: OnboardingJobProgress;
  counters: OnboardingJobCounters;
  recentProducts: OnboardingIndexedProduct[];
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
  ONBOARDING_TOKEN_SECRET: z.string().optional(),
  ONBOARDING_DEMO_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
});

export type Env = z.infer<typeof EnvSchema>;
