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
  private readonly taggingTimeoutMs = 3_500;

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
    const textualMatches = await this.findTextualMatches(detectedWine, 3);
    const exactMatch = textualMatches[0] || null;
    const textualIds = new Set(textualMatches.map((p) => String(p._id)));
    const searchLimit = Math.min(50, Math.max(input.limit * 2, textualMatches.length > 0 ? 24 : 16));
    const alternativesSearch = await this.findAlternatives(
      detectedWine,
      input.queryHint,
      input.merchantId,
      searchLimit,
      textualIds,
      textualMatches.length
    );

    const alternatives = alternativesSearch.products;
    const textualMatchesOutput = textualMatches.slice(0, 3);
    const alternativesOutput = alternatives.slice(0, input.limit);
    const startTagging = Date.now();
    const taggingResult = await this.deriveWineTags(
      detectedWine,
      exactMatch,
      [...textualMatches, ...alternatives].slice(0, 8)
    );
    const taggingMs = Date.now() - startTagging;

    const matchingMs = Date.now() - startMatching;
    const totalMs = Date.now() - startTotal;
    const decision: "exact" | "alternatives" = textualMatches.length > 0 ? "exact" : "alternatives";
    const textualSectionMessage =
      textualMatches.length > 0
        ? "מצאנו התאמות טקסטואליות במלאי"
        : "לא מצאנו בדיוק את מה שחיפשת";
    const alternativesSectionMessage =
      alternatives.length > 0 ? "הנה משהו שמתאים" : "לא נמצאו כרגע חלופות מתאימות";

    return {
      detectedWine,
      exactMatch,
      textualMatches: textualMatchesOutput,
      alternatives: alternativesOutput,
      metadata: {
        decision,
        searchStrategy: "text_first_then_vector",
        reason: textualMatches.length > 0 ? "textual_in_stock_match_found" : alternativesSearch.reason,
        textualCount: textualMatchesOutput.length,
        alternativesCount: alternativesOutput.length,
        vectorAttempted: alternativesSearch.vectorAttempted,
        vectorUsedAsFallback: alternativesSearch.vectorUsedAsFallback,
        messages: {
          textualSection: textualSectionMessage,
          alternativesSection: alternativesSectionMessage,
        },
        derivedTags: taggingResult.tags,
        tagSource: taggingResult.source,
        timings: {
          analysis: analysisMs,
          matching: matchingMs,
          tagging: taggingMs,
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
        '  "wineColor"?: "red"|"white"|"rose"|"sparkling",',
        '  "country"?: "string",',
        '  "region"?: "string",',
        '  "grapes"?: string[],',
        '  "styleTags"?: string[],',
        '  "confidence"?: number',
        "}",
        "",
        "Rules:",
        "- Name must be the likely marketed wine name from label.",
        "- wineColor must be one of: red, white, rose, sparkling.",
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

  private async findTextualMatches(
    detectedWine: DetectedWine,
    maxMatches = 3
  ): Promise<WineProduct[]> {
    const detectedColor = this.getDetectedColor(detectedWine);
    const primaryQuery = [
      detectedWine.name,
      detectedWine.producer,
      detectedWine.vintage ? String(detectedWine.vintage) : undefined,
      ...this.colorTerms(detectedColor),
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

    const queryVariants = Array.from(
      new Set(
        [
          primaryQuery,
          [detectedWine.name, detectedWine.producer].filter(Boolean).join(" ").trim(),
          String(detectedWine.name || "").trim(),
        ].filter((q) => q.length > 0)
      )
    );

    if (queryVariants.length === 0) return [];

    const byId = new Map<string, WineProduct & { textualScore: number }>();
    for (const lookup of queryVariants) {
      const candidates = await this.productCatalogService.searchByName(lookup, 40);
      for (const candidate of candidates) {
        if (!this.isInStock(candidate as any)) continue;
        if (
          detectedColor &&
          this.hasExplicitColorConflict(candidate as any, detectedColor)
        ) {
          continue;
        }

        const nameScore = this.computeNameSimilarity(detectedWine.name, candidate.name || "");
        const producerScore = this.computeProducerScore(detectedWine.producer, candidate);
        const vintageScore = this.computeVintageScore(detectedWine.vintage, candidate);
        const colorScore = this.computeColorScore(detectedWine, candidate as any);

        const producerRequired = Boolean(detectedWine.producer);
        const vintageRequired = typeof detectedWine.vintage === "number";
        const strongProducerBridge = producerRequired && producerScore >= 0.9;
        const minNameScore = strongProducerBridge ? 0.55 : 0.72;
        const passes =
          nameScore >= minNameScore &&
          (!producerRequired || producerScore >= 0.5) &&
          (!vintageRequired || vintageScore >= 0.6);
        if (!passes) continue;

        const textualScore =
          nameScore * 0.72 + producerScore * 0.13 + vintageScore * 0.1 + colorScore * 0.05;
        const id = String((candidate as any)._id);
        const current = byId.get(id);
        if (!current || textualScore > current.textualScore) {
          byId.set(id, {
            ...(candidate as any),
            _id: id,
            score: textualScore,
            finalScore: textualScore,
            textualScore,
          });
        }
      }
    }

    const ranked = Array.from(byId.values())
      .sort((a, b) => {
        const scoreDiff = b.textualScore - a.textualScore;
        if (scoreDiff !== 0) return scoreDiff;
        return Number((b as any).stockCount || 0) - Number((a as any).stockCount || 0);
      })
      .slice(0, maxMatches)
      .map((item) => {
        const { textualScore, ...rest } = item;
        return rest;
      }) as WineProduct[];

    return ranked;
  }

  private buildSemanticQuery(detectedWine: DetectedWine, queryHint?: string): string {
    const colorTerms = this.colorTerms(this.getDetectedColor(detectedWine));
    const parts = [
      detectedWine.name,
      detectedWine.producer,
      detectedWine.vintage ? String(detectedWine.vintage) : undefined,
      ...colorTerms,
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
    const colorTerms = this.colorTerms(this.getDetectedColor(detectedWine));
    const parts = [
      ...colorTerms,
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
    const colorTerms = this.colorTerms(this.getDetectedColor(detectedWine));
    return [...colorTerms, style, country, region, "יין wine"].filter(Boolean).join(" ");
  }

  private buildColorTargetQuery(detectedWine: DetectedWine): string {
    const colorTerms = this.colorTerms(this.getDetectedColor(detectedWine));
    const country = detectedWine.country ? String(detectedWine.country).trim() : "";
    const region = detectedWine.region ? String(detectedWine.region).trim() : "";
    return [...colorTerms, country, region, "wine"].filter(Boolean).join(" ");
  }

  private async findAlternatives(
    detectedWine: DetectedWine,
    queryHint: string | undefined,
    merchantId: string,
    limit: number,
    excludedIds: Set<string>,
    textualCount: number
  ): Promise<{
    products: WineProduct[];
    reason: string;
    vectorAttempted: boolean;
    vectorUsedAsFallback: boolean;
  }> {
    const detectedColor = this.getDetectedColor(detectedWine);
    let vectorAttempted = false;
    const attempts = [
      ...(detectedColor
        ? [
            {
              reason: "semantic_color_target",
              query: this.buildColorTargetQuery(detectedWine),
            },
          ]
        : []),
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
      vectorAttempted = true;
      const products = this.applyColorConsistency(
        await this.runSemanticSearch(attempt.query, merchantId, limit),
        detectedWine
      ).filter((p) => !excludedIds.has(String(p._id)));
      if (products.length > 0) {
        const colorReasonSuffix = detectedColor
          ? this.hasAnyColorMatch(products, detectedColor)
            ? "_color_aligned"
            : "_color_miss"
          : "";
        return {
          products,
          reason: `${attempt.reason}${colorReasonSuffix}`,
          vectorAttempted,
          vectorUsedAsFallback: textualCount === 0,
        };
      }
    }

    const catalogFallback = this.applyColorConsistency(
      await this.searchCatalogFallback(detectedWine, limit),
      detectedWine
    ).filter((p) => !excludedIds.has(String(p._id)));
    if (catalogFallback.length > 0) {
      return {
        products: catalogFallback,
        reason: "catalog_name_fallback",
        vectorAttempted,
        vectorUsedAsFallback: false,
      };
    }

    return {
      products: [],
      reason: "no_alternatives_found",
      vectorAttempted,
      vectorUsedAsFallback: false,
    };
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

  private applyColorConsistency(products: WineProduct[], detectedWine: DetectedWine): WineProduct[] {
    const detectedColor = this.getDetectedColor(detectedWine);
    if (!detectedColor || products.length === 0) return products;

    const rescored = products.map((product) => {
      const isMatch = this.matchesDetectedColor(product, detectedColor);
      const base = Number((product as any).finalScore || product.score || 0);
      const adjusted = isMatch ? Math.max(base * 1.25, base + 0.08) : base * 0.55;
      return {
        ...product,
        score: adjusted,
        finalScore: adjusted,
      } as WineProduct;
    });

    rescored.sort(
      (a, b) =>
        Number((b as any).finalScore || b.score || 0) -
        Number((a as any).finalScore || a.score || 0)
    );

    const matched = rescored.filter((p) => this.matchesDetectedColor(p, detectedColor));
    if (matched.length >= Math.min(3, Math.max(1, Math.floor(products.length / 3)))) {
      const unmatched = rescored.filter((p) => !this.matchesDetectedColor(p, detectedColor));
      return [...matched, ...unmatched];
    }

    return rescored;
  }

  private hasAnyColorMatch(products: WineProduct[], detectedColor: "red" | "white" | "rose" | "sparkling"): boolean {
    return products.some((p) => this.matchesDetectedColor(p, detectedColor));
  }

  private hasExplicitColorConflict(
    product: WineProduct,
    detectedColor: "red" | "white" | "rose" | "sparkling"
  ): boolean {
    const productColor = this.normalizeWineColor(product.color);
    return Boolean(productColor && productColor !== detectedColor);
  }

  private computeColorScore(
    detectedWine: DetectedWine,
    candidate: WineProduct
  ): number {
    const detectedColor = this.getDetectedColor(detectedWine);
    if (!detectedColor) return 1;
    return this.matchesDetectedColor(candidate, detectedColor) ? 1 : 0;
  }

  private isInStock(product: Partial<WineProduct>): boolean {
    if (product.inStock === true) return true;
    const stock = Number(product.stockCount || 0);
    return Number.isFinite(stock) && stock > 0;
  }

  private matchesDetectedColor(
    product: WineProduct,
    detectedColor: "red" | "white" | "rose" | "sparkling"
  ): boolean {
    const productColor = this.normalizeWineColor(product.color);
    if (productColor && productColor === detectedColor) return true;

    const categories = Array.isArray(product.category)
      ? product.category
      : typeof product.category === "string"
        ? [product.category]
        : [];
    const softCategories = Array.isArray(product.softCategory)
      ? product.softCategory
      : typeof product.softCategory === "string"
        ? [product.softCategory]
        : [];
    const text = this.normalizeText(
      [product.name, product.description, ...categories, ...softCategories]
        .filter((v): v is string => typeof v === "string")
        .join(" ")
    );

    const expectedTerms = this.colorTerms(detectedColor).map((t) => this.normalizeText(t));
    return expectedTerms.some((term) => term && text.includes(term));
  }

  private getDetectedColor(
    detectedWine: DetectedWine
  ): "red" | "white" | "rose" | "sparkling" | undefined {
    if (detectedWine.wineColor) return detectedWine.wineColor;
    const fromTags = (detectedWine.styleTags || [])
      .map((tag) => this.normalizeWineColor(tag))
      .find(Boolean);
    return fromTags;
  }

  private normalizeWineColor(value: string | undefined): "red" | "white" | "rose" | "sparkling" | undefined {
    if (!value) return undefined;
    const normalized = this.normalizeText(value);
    if (!normalized) return undefined;
    if (
      normalized.includes("rose") ||
      normalized.includes("rosé") ||
      normalized.includes("רוזה") ||
      normalized.includes("pink")
    ) {
      return "rose";
    }
    if (
      normalized.includes("sparkling") ||
      normalized.includes("bubbly") ||
      normalized.includes("מבעבע") ||
      normalized.includes("שמפניה")
    ) {
      return "sparkling";
    }
    if (normalized.includes("white") || normalized.includes("לבן")) return "white";
    if (normalized.includes("red") || normalized.includes("אדום")) return "red";
    return undefined;
  }

  private colorTerms(color: "red" | "white" | "rose" | "sparkling" | undefined): string[] {
    if (!color) return [];
    switch (color) {
      case "rose":
        return ["rosé", "rose wine", "יין רוזה", "רוזה"];
      case "sparkling":
        return ["sparkling wine", "יין מבעבע", "שמפניה"];
      case "white":
        return ["white wine", "יין לבן", "לבן"];
      case "red":
        return ["red wine", "יין אדום", "אדום"];
      default:
        return [];
    }
  }

  private async deriveWineTags(
    detectedWine: DetectedWine,
    exactMatch: WineProduct | null,
    alternatives: WineProduct[]
  ): Promise<{ tags: string[]; source: "llm_catalog_context" | "catalog_fallback" }> {
    const contextProducts = [exactMatch, ...alternatives]
      .filter((p): p is WineProduct => Boolean(p))
      .slice(0, 6);

    const fallbackTags = this.buildFallbackTags(detectedWine, contextProducts);
    if (!this.enabled || contextProducts.length === 0) {
      return { tags: fallbackTags, source: "catalog_fallback" };
    }

    const compactProducts = contextProducts.map((p) => ({
      name: p.name,
      price: p.price,
      color: p.color,
      country: p.country,
      region: p.region,
      grapes: Array.isArray(p.grapes) ? p.grapes.slice(0, 4) : [],
      sweetness: p.sweetness,
      description: this.toPlainText(p.description).slice(0, 220),
    }));

    const prompt = [
      "You create concise wine tags for an e-commerce UI.",
      "Use detected bottle info plus matched product metadata context.",
      "Return JSON only.",
      "",
      "Schema:",
      "{",
      '  "tags": string[]',
      "}",
      "",
      "Rules:",
      "- 6 to 12 tags.",
      "- Mix style + origin + grape/character + price positioning tags.",
      "- Short tags only (max 24 chars each).",
      "- No duplicates.",
      "- Prefer Hebrew tags when context is Hebrew.",
      "",
      `Detected wine: ${JSON.stringify(detectedWine)}`,
      `Catalog context: ${JSON.stringify(compactProducts)}`,
    ].join("\n");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.taggingTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { tags: fallbackTags, source: "catalog_fallback" };
      }

      const data: any = await response.json();
      const raw = data?.choices?.[0]?.message?.content;
      if (!raw || typeof raw !== "string") {
        return { tags: fallbackTags, source: "catalog_fallback" };
      }
      const json = this.extractJson(raw);
      if (!json) {
        return { tags: fallbackTags, source: "catalog_fallback" };
      }
      const parsed = JSON.parse(json);
      const tags: string[] = Array.isArray(parsed?.tags)
        ? parsed.tags
            .map((t: unknown) => (typeof t === "string" ? t.trim() : ""))
            .filter((t: string) => t.length > 0 && t.length <= 24)
        : [];

      const clean: string[] = Array.from(new Set<string>(tags)).slice(0, 12);
      if (clean.length < 4) {
        return { tags: fallbackTags, source: "catalog_fallback" };
      }
      return { tags: clean, source: "llm_catalog_context" };
    } catch {
      return { tags: fallbackTags, source: "catalog_fallback" };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildFallbackTags(detectedWine: DetectedWine, products: WineProduct[]): string[] {
    const tags = new Set<string>();

    const add = (value?: string) => {
      const v = String(value || "").trim();
      if (v) tags.add(v);
    };

    const color = this.getDetectedColor(detectedWine);
    if (color) {
      const labelMap: Record<string, string> = {
        red: "יין אדום",
        white: "יין לבן",
        rose: "יין רוזה",
        sparkling: "יין מבעבע",
      };
      add(labelMap[color]);
    }

    add(detectedWine.country);
    add(detectedWine.region);
    for (const grape of detectedWine.grapes || []) add(grape);
    for (const styleTag of detectedWine.styleTags || []) add(styleTag);

    const prices = products
      .map((p) => Number(p.price))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (prices.length > 0) {
      const avg = prices.reduce((sum, n) => sum + n, 0) / prices.length;
      if (avg < 80) add("תמורה גבוהה");
      else if (avg < 180) add("טווח מחיר בינוני");
      else add("פרימיום");
    }

    const sweetness = products
      .map((p) => String(p.sweetness || "").trim())
      .find(Boolean);
    if (sweetness) add(sweetness);

    const characterHints = [
      ["fresh", "רענן"],
      ["fruity", "פירותי"],
      ["dry", "יבש"],
      ["mineral", "מינרלי"],
      ["acid", "חומציות מודגשת"],
      ["light", "קליל"],
      ["full", "גוף מלא"],
      ["elegant", "אלגנטי"],
    ] as const;
    const combinedText = this.normalizeText(
      [
        ...products.map((p) => p.description || ""),
        ...(detectedWine.styleTags || []),
      ]
        .join(" ")
        .slice(0, 1500)
    );
    for (const [needle, label] of characterHints) {
      if (combinedText.includes(needle) || combinedText.includes(this.normalizeText(label))) add(label);
    }

    return Array.from(tags).slice(0, 12);
  }

  private toPlainText(value?: string): string {
    if (!value) return "";
    return value
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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

    const aKeyTokens = this.tokenizeCrossScript(left);
    const bKeyTokens = this.tokenizeCrossScript(right);
    const keyDice =
      aKeyTokens.length > 0 && bKeyTokens.length > 0
        ? this.computeDiceFromSets(new Set(aKeyTokens), new Set(bKeyTokens))
        : 0;

    const leftKey = this.toCrossScriptKey(left);
    const rightKey = this.toCrossScriptKey(right);
    const keyContains =
      leftKey.length > 3 &&
      rightKey.length > 3 &&
      (rightKey.includes(leftKey) || leftKey.includes(rightKey));

    const fuzzyText = this.computeFuzzySimilarity(normalizedLeft, normalizedRight);
    const fuzzyKey = this.computeFuzzySimilarity(leftKey, rightKey);

    return Math.max(
      dice,
      keyDice * 0.95,
      contains ? 0.92 : 0,
      keyContains ? 0.9 : 0,
      fuzzyText * 0.88,
      fuzzyKey * 0.92
    );
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
    if (combined.includes(normProducer)) return 1;

    const producerKey = this.toCrossScriptKey(producer);
    const combinedKey = this.toCrossScriptKey(combined);
    if (producerKey.length >= 3 && combinedKey.includes(producerKey)) return 1;
    return 0;
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

  private tokenizeCrossScript(value: string): string[] {
    return this.normalizeText(value)
      .split(/\s+/)
      .map((token) => this.toCrossScriptKey(token))
      .filter((token) => token.length > 1);
  }

  private computeDiceFromSets(left: Set<string>, right: Set<string>): number {
    if (left.size === 0 || right.size === 0) return 0;
    let intersection = 0;
    for (const token of left) {
      if (right.has(token)) intersection += 1;
    }
    return (2 * intersection) / (left.size + right.size);
  }

  private computeFuzzySimilarity(left: string, right: string): number {
    if (!left || !right) return 0;
    const a = String(left).trim();
    const b = String(right).trim();
    if (!a || !b) return 0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen < 4) return 0;
    const ratio = this.levenshteinDistance(a, b) / maxLen;
    if (ratio > 0.36) return 0;
    return Math.max(0, 1 - ratio);
  }

  private normalizeText(value: string): string {
    return value
      .toLowerCase()
      .replace(/[\u0591-\u05C7]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private toCrossScriptKey(value: string): string {
    const normalized = this.normalizeText(value);
    if (!normalized) return "";

    const hebrewToLatin: Record<string, string> = {
      א: "",
      ב: "b",
      ג: "g",
      ד: "d",
      ה: "",
      ו: "v",
      ז: "z",
      ח: "h",
      ט: "t",
      י: "y",
      כ: "k",
      ך: "k",
      ל: "l",
      מ: "m",
      ם: "m",
      נ: "n",
      ן: "n",
      ס: "s",
      ע: "",
      פ: "p",
      ף: "p",
      צ: "ts",
      ץ: "ts",
      ק: "k",
      ר: "r",
      ש: "sh",
      ת: "t",
    };

    const mapped = Array.from(normalized)
      .map((char) => hebrewToLatin[char] ?? char)
      .join("");

    return mapped
      .replace(/[aeiou]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  private levenshteinDistance(left: string, right: string): number {
    const a = left;
    const b = right;
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    const prev = new Uint16Array(b.length + 1);
    const curr = new Uint16Array(b.length + 1);
    for (let j = 0; j <= b.length; j += 1) prev[j] = j;

    for (let i = 1; i <= a.length; i += 1) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const deleteCost = (prev[j] ?? 0) + 1;
        const insertCost = (curr[j - 1] ?? 0) + 1;
        const replaceCost = (prev[j - 1] ?? 0) + cost;
        curr[j] = Math.min(deleteCost, insertCost, replaceCost);
      }
      for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0;
    }

    return prev[b.length] ?? 0;
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
