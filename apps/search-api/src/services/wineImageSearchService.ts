import type {
  DetectedWine,
  Env,
  ImageSearchResult,
  SearchQuery,
  WineProduct,
} from "../types/index.js";
import { DetectedWineSchema } from "../types/index.js";
import type { ProductCatalogService } from "./productCatalogService.js";
import type { SearchService } from "./searchService.js";

type AnalyzeImageInput = {
  imageDataUrl: string;
  queryHint?: string;
  merchantId: string;
  limit: number;
};

class WineImageSearchError extends Error {
  statusCode: number;
  code: string;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class WineImageSearchService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly enabled: boolean;
  private readonly maxImageBytes = 6 * 1024 * 1024;
  private readonly analysisTimeoutMs = 18_000;

  constructor(
    private env: Env,
    private searchService: SearchService,
    private productCatalogService: ProductCatalogService
  ) {
    this.apiKey = env.LLM_API_KEY || env.OPENAI_API_KEY || "";
    this.baseUrl = (env.LLM_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    this.model = env.LLM_MODEL || env.NER_MODEL || "gpt-4.1-mini";
    this.enabled = Boolean(this.apiKey);
  }

  async searchByImage(input: AnalyzeImageInput): Promise<ImageSearchResult> {
    const startTotal = Date.now();
    const startAnalysis = Date.now();

    this.validateInputImage(input.imageDataUrl);
    if (!this.enabled) {
      throw new WineImageSearchError(
        "vision_not_configured",
        "Vision model is not configured on server",
        422
      );
    }

    const detectedWine = await this.detectWineFromImage(input.imageDataUrl, input.queryHint);
    const analysisMs = Date.now() - startAnalysis;

    const startMatching = Date.now();
    const exactMatch = await this.findStrictExactMatch(detectedWine);
    const searchLimit = Math.min(50, Math.max(input.limit * 2, exactMatch ? 20 : 16));
    const alternativesSearch = await this.findAlternatives(
      detectedWine,
      input.queryHint,
      input.merchantId,
      searchLimit
    );

    let alternatives = alternativesSearch.products;
    if (exactMatch) {
      alternatives = this.pinProductFirst(alternatives, exactMatch);
    }

    const matchingMs = Date.now() - startMatching;
    const totalMs = Date.now() - startTotal;
    const decision: "exact" | "alternatives" = exactMatch ? "exact" : "alternatives";

    return {
      detectedWine,
      exactMatch,
      alternatives: alternatives.slice(0, input.limit),
      metadata: {
        decision,
        reason: exactMatch ? "strict_exact_match_found" : alternativesSearch.reason,
        timings: {
          analysis: analysisMs,
          matching: matchingMs,
          total: totalMs,
        },
      },
    };
  }

  toPublicError(error: unknown): { statusCode: number; code: string; message: string } {
    if (error instanceof WineImageSearchError) {
      return {
        statusCode: error.statusCode,
        code: error.code,
        message: error.message,
      };
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    const lowered = message.toLowerCase();
    if (lowered.includes("abort")) {
      return {
        statusCode: 504,
        code: "image_analysis_timeout",
        message: "Image analysis timed out",
      };
    }
    if (lowered.includes("image") && (lowered.includes("unsupported") || lowered.includes("vision"))) {
      return {
        statusCode: 422,
        code: "vision_not_supported",
        message: "Configured model does not support image analysis",
      };
    }
    return {
      statusCode: 500,
      code: "image_search_failed",
      message,
    };
  }

  private async detectWineFromImage(imageDataUrl: string, queryHint?: string): Promise<DetectedWine> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.analysisTimeoutMs);
    try {
      const prompt = [
        "You are a wine-recognition parser for an e-commerce catalog.",
        "Analyze the wine bottle image and return JSON only.",
        "No markdown, no explanations.",
        "",
        "Schema:",
        "{",
        '  "name": "required string",',
        '  "producer"?: "string",',
        '  "vintage"?: number,',
        '  "country"?: "string",',
        '  "region"?: "string",',
        '  "grapes"?: string[],',
        '  "styleTags"?: string[],',
        '  "confidence"?: number',
        "}",
        "",
        "Rules:",
        "- Name must be the likely marketed wine name from label.",
        "- Confidence must be 0..1.",
        "- Use concise canonical values where possible.",
        "- If uncertain, omit fields.",
        queryHint ? `User hint: ${queryHint}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageDataUrl } },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        const lowered = errorBody.toLowerCase();
        if (response.status === 400 && (lowered.includes("image") || lowered.includes("vision"))) {
          throw new WineImageSearchError(
            "vision_not_supported",
            "Configured model does not support image analysis",
            422
          );
        }
        throw new WineImageSearchError(
          "image_analysis_failed",
          `Image analysis request failed (${response.status})`,
          500
        );
      }

      const data: any = await response.json();
      const raw = data?.choices?.[0]?.message?.content;
      if (!raw || typeof raw !== "string") {
        throw new WineImageSearchError(
          "image_analysis_failed",
          "Image analysis returned empty response",
          500
        );
      }

      const json = this.extractJson(raw);
      if (!json) {
        throw new WineImageSearchError(
          "image_analysis_failed",
          "Image analysis response was not valid JSON",
          500
        );
      }

      const parsed = DetectedWineSchema.safeParse(JSON.parse(json));
      if (!parsed.success) {
        throw new WineImageSearchError(
          "image_analysis_failed",
          "Image analysis returned invalid wine schema",
          500
        );
      }

      return parsed.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async findStrictExactMatch(detectedWine: DetectedWine): Promise<WineProduct | null> {
    const lookup = [detectedWine.name, detectedWine.producer].filter(Boolean).join(" ").trim();
    if (!lookup) return null;

    const candidates = await this.productCatalogService.searchByName(lookup, 30);
    if (candidates.length === 0) return null;

    const scored = candidates
      .map((candidate) => {
        const nameScore = this.computeNameSimilarity(detectedWine.name, candidate.name || "");
        const producerScore = this.computeProducerScore(detectedWine.producer, candidate);
        const vintageScore = this.computeVintageScore(detectedWine.vintage, candidate);

        const weightedScore = nameScore * 0.75 + producerScore * 0.15 + vintageScore * 0.1;
        return {
          candidate,
          nameScore,
          producerScore,
          vintageScore,
          weightedScore,
        };
      })
      .sort((a, b) => b.weightedScore - a.weightedScore);

    const best = scored[0];
    if (!best) return null;

    const producerRequired = Boolean(detectedWine.producer);
    const vintageRequired = typeof detectedWine.vintage === "number";
    const passesStrict =
      best.nameScore >= 0.86 &&
      (!producerRequired || best.producerScore >= 0.8) &&
      (!vintageRequired || best.vintageScore >= 0.9);

    if (!passesStrict) return null;
    return best.candidate as unknown as WineProduct;
  }

  private buildSemanticQuery(detectedWine: DetectedWine, queryHint?: string): string {
    const parts = [
      detectedWine.name,
      detectedWine.producer,
      detectedWine.vintage ? String(detectedWine.vintage) : undefined,
      detectedWine.country,
      detectedWine.region,
      ...(detectedWine.grapes || []),
      ...(detectedWine.styleTags || []),
      queryHint,
      "wine alternative closest match",
    ]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);

    return parts.join(" ");
  }

  private buildDescriptorQuery(detectedWine: DetectedWine, queryHint?: string): string {
    const parts = [
      detectedWine.country,
      detectedWine.region,
      ...(detectedWine.grapes || []),
      ...(detectedWine.styleTags || []),
      queryHint,
      "wine",
    ]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    return parts.join(" ");
  }

  private buildBroadFallbackQuery(detectedWine: DetectedWine): string {
    const style = (detectedWine.styleTags || []).slice(0, 2).join(" ");
    const country = detectedWine.country ? String(detectedWine.country).trim() : "";
    const region = detectedWine.region ? String(detectedWine.region).trim() : "";
    return [style, country, region, "יין wine red white sparkling"].filter(Boolean).join(" ");
  }

  private async findAlternatives(
    detectedWine: DetectedWine,
    queryHint: string | undefined,
    merchantId: string,
    limit: number
  ): Promise<{ products: WineProduct[]; reason: string }> {
    const attempts = [
      {
        reason: "semantic_primary",
        query: this.buildSemanticQuery(detectedWine, queryHint),
      },
      {
        reason: "semantic_descriptor_fallback",
        query: this.buildDescriptorQuery(detectedWine, queryHint),
      },
      {
        reason: "semantic_broad_fallback",
        query: this.buildBroadFallbackQuery(detectedWine),
      },
    ].filter((a) => a.query.trim().length > 0);

    for (const attempt of attempts) {
      const products = await this.runSemanticSearch(attempt.query, merchantId, limit);
      if (products.length > 0) {
        return { products, reason: attempt.reason };
      }
    }

    const catalogFallback = await this.searchCatalogFallback(detectedWine, limit);
    if (catalogFallback.length > 0) {
      return { products: catalogFallback, reason: "catalog_name_fallback" };
    }

    return { products: [], reason: "no_alternatives_found" };
  }

  private async runSemanticSearch(
    query: string,
    merchantId: string,
    limit: number
  ): Promise<WineProduct[]> {
    const semanticInput: SearchQuery = {
      query,
      merchantId,
      offset: 0,
      limit,
    };
    try {
      const semanticResult = await this.searchService.search(semanticInput);
      return semanticResult.products as WineProduct[];
    } catch (error) {
      console.warn("[WineImageSearchService] semantic fallback search failed", {
        query,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async searchCatalogFallback(
    detectedWine: DetectedWine,
    limit: number
  ): Promise<WineProduct[]> {
    const lookup = [detectedWine.name, detectedWine.producer].filter(Boolean).join(" ").trim();
    if (!lookup) return [];
    const docs = await this.productCatalogService.searchByName(lookup, Math.min(50, limit));
    return docs.map((doc) => ({
      ...(doc as any),
      score: Number((doc as any).score || 0.28),
      finalScore: Number((doc as any).finalScore || 0.28),
    })) as WineProduct[];
  }

  private pinProductFirst(products: WineProduct[], exactMatch: WineProduct): WineProduct[] {
    const exactId = String(exactMatch._id);
    const deduped = new Map<string, WineProduct>();
    deduped.set(exactId, {
      ...exactMatch,
      score: Number((exactMatch as any).score || 1),
      finalScore: Number((exactMatch as any).finalScore || 1),
    } as WineProduct);
    for (const product of products) {
      deduped.set(String(product._id), product);
    }
    const ordered = Array.from(deduped.values());
    ordered.sort((a, b) => {
      const aExact = String(a._id) === exactId ? 1 : 0;
      const bExact = String(b._id) === exactId ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      return Number((b as any).finalScore || b.score || 0) - Number((a as any).finalScore || a.score || 0);
    });
    return ordered;
  }

  private computeNameSimilarity(left: string, right: string): number {
    const a = this.tokenize(left);
    const b = this.tokenize(right);
    if (a.length === 0 || b.length === 0) return 0;

    const aSet = new Set(a);
    const bSet = new Set(b);
    let intersection = 0;
    for (const token of aSet) {
      if (bSet.has(token)) intersection += 1;
    }
    const dice = (2 * intersection) / (aSet.size + bSet.size);

    const normalizedLeft = this.normalizeText(left);
    const normalizedRight = this.normalizeText(right);
    const contains =
      normalizedLeft.length > 3 &&
      (normalizedRight.includes(normalizedLeft) || normalizedLeft.includes(normalizedRight));

    return Math.max(dice, contains ? 0.92 : 0);
  }

  private computeProducerScore(
    producer: string | undefined,
    candidate: { name?: string; description?: string; country?: string; region?: string }
  ): number {
    if (!producer) return 1;
    const normProducer = this.normalizeText(producer);
    if (!normProducer) return 0;

    const combined = this.normalizeText(
      `${candidate.name || ""} ${candidate.description || ""} ${candidate.country || ""} ${candidate.region || ""}`
    );
    if (!combined) return 0;
    return combined.includes(normProducer) ? 1 : 0;
  }

  private computeVintageScore(
    vintage: number | undefined,
    candidate: { name?: string; description?: string }
  ): number {
    if (!vintage) return 1;
    const inName = String(candidate.name || "").includes(String(vintage));
    const inDesc = String(candidate.description || "").includes(String(vintage));
    return inName || inDesc ? 1 : 0;
  }

  private tokenize(value: string): string[] {
    return this.normalizeText(value)
      .split(/\s+/)
      .filter((token) => token.length > 1);
  }

  private normalizeText(value: string): string {
    return value
      .toLowerCase()
      .replace(/[\u0591-\u05C7]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractJson(raw: string): string | null {
    let text = raw.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```$/m, "").trim();
    }
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
    return text.slice(firstBrace, lastBrace + 1);
  }

  private validateInputImage(imageDataUrl: string): void {
    const match = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) {
      throw new WineImageSearchError(
        "invalid_image",
        "imageDataUrl must be a base64 data URL",
        400
      );
    }
    const mimeType = match[1] || "";
    if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(mimeType)) {
      throw new WineImageSearchError(
        "invalid_image_type",
        "Unsupported image type. Use jpeg/png/webp/heic",
        400
      );
    }

    const base64Payload = (match[2] || "").replace(/\s+/g, "");
    const decodedBytes = Math.floor((base64Payload.length * 3) / 4);
    if (decodedBytes > this.maxImageBytes) {
      throw new WineImageSearchError(
        "image_too_large",
        `Image is too large. Max size is ${Math.round(this.maxImageBytes / (1024 * 1024))}MB`,
        400
      );
    }
  }
}
