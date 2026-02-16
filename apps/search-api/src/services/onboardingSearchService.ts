import { MongoClient, type Collection, type Db } from "mongodb";
import type {
  Env,
  ExtractedFilters,
  OnboardingCategory,
  OnboardingDemoSearchResult,
  OnboardingIndexedProduct,
} from "../types/index.js";
import { EmbeddingService } from "./embeddingService.js";
import { EntityExtractionService } from "./entityExtractionService.js";
import { QueryParser } from "./queryParser.js";

type OnboardingProductDoc = Omit<OnboardingIndexedProduct, "_id"> & {
  _id: any;
};

export class OnboardingSearchService {
  private client: MongoClient;
  private db!: Db;
  private products!: Collection<OnboardingProductDoc>;
  private embeddingService: EmbeddingService;
  private parser: QueryParser;
  private entityExtractor: EntityExtractionService;
  private readonly vectorIndex = "onboarding_vector_index";

  constructor(private env: Env) {
    this.client = new MongoClient(env.MONGO_URI);
    this.embeddingService = new EmbeddingService(env);
    this.parser = new QueryParser();
    this.entityExtractor = new EntityExtractionService(env);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.env.MONGO_DB);
    this.products = this.db.collection<OnboardingProductDoc>("onboarding.products");
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async search(
    demoId: string,
    query: string,
    limit = 24,
    offset = 0,
    options?: {
      demoCategory?: OnboardingCategory;
    }
  ): Promise<OnboardingDemoSearchResult> {
    const timings = {
      textSearch: 0,
      embedding: 0,
      vectorSearch: 0,
      merge: 0,
      total: 0,
    };
    const startTotal = Date.now();

    const cappedLimit = Math.max(1, Math.min(limit, 50));

    const ruleFilters = this.parser.parse(query);
    const ner = await this.entityExtractor.extract(query).catch(() => ({ filters: {} as ExtractedFilters }));
    const extractedFilters = this.mergeFilters(ruleFilters, ner.filters || {});
    const cleanedQuery = this.parser.cleanQuery(query, extractedFilters);
    const normalizedQuery = this.normalizeForTextSearch(cleanedQuery);
    const terms = normalizedQuery
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1);

    const textStart = Date.now();
    const textCandidates = await this.textSearch(demoId, terms, Math.max(cappedLimit * 3, 60));
    timings.textSearch = Date.now() - textStart;
    const textStrong = this.isTextStrongEnough(textCandidates, cappedLimit);
    const querySoftTags = Array.from(
      new Set([
        ...this.deriveWineSoftTags(query),
        ...((extractedFilters.softTags || []).map((tag) => this.normalizeForTextSearch(String(tag || "")))),
      ])
    ).filter(Boolean);

    let vectorCandidates: OnboardingIndexedProduct[] = [];
    let vectorStatus: "ok" | "empty" | "embedding_failed" | "vector_failed" = "vector_failed";
    const shouldAttemptVector = query.trim().length > 0;

    if (shouldAttemptVector) {
      const embedStart = Date.now();
      const embeddingResult = await Promise.resolve(
        this.embeddingService.generateEmbedding(cleanedQuery || query)
      )
        .then((value) => ({ status: "fulfilled" as const, value }))
        .catch((reason) => ({ status: "rejected" as const, reason }));
      timings.embedding = Date.now() - embedStart;

      if (embeddingResult.status === "fulfilled") {
        const vectorStart = Date.now();
        vectorCandidates = await this.vectorSearchWithFallback(
          demoId,
          embeddingResult.value,
          Math.max(cappedLimit * 3, 60)
        );
        timings.vectorSearch = Date.now() - vectorStart;
        vectorStatus = vectorCandidates.length > 0 ? "ok" : "empty";
      } else {
        vectorStatus = "embedding_failed";
      }
    } else {
      vectorStatus = "empty";
    }

    const mergeStart = Date.now();
    const merged = this.mergeHybridCandidates(vectorCandidates, textCandidates, querySoftTags);
    const hardFiltered = this.applyHardConstraints(merged, extractedFilters, options?.demoCategory);
    timings.merge = Date.now() - mergeStart;

    timings.total = Date.now() - startTotal;

    const paginated = hardFiltered.slice(offset, offset + cappedLimit);
    const mode: "text_only" | "hybrid" =
      vectorStatus === "ok" || vectorStatus === "empty"
        ? "hybrid"
        : textStrong
          ? "text_only"
          : "hybrid";

    return {
      products: paginated,
      metadata: {
        query,
        totalResults: hardFiltered.length,
        returnedCount: paginated.length,
        retrieval: {
          vectorCandidates: vectorCandidates.length,
          textCandidates: textCandidates.length,
          mergedCandidates: hardFiltered.length,
          mode,
          vectorStatus,
        },
        timings,
      },
    };
  }

  private async textSearch(
    demoId: string,
    terms: string[],
    limit: number
  ): Promise<OnboardingIndexedProduct[]> {
    const regexOr = terms.map((term) => ({
      $or: [
        { name: { $regex: this.escapeRegExp(term), $options: "i" } },
        { description: { $regex: this.escapeRegExp(term), $options: "i" } },
        { brand: { $regex: this.escapeRegExp(term), $options: "i" } },
        { category: { $regex: this.escapeRegExp(term), $options: "i" } },
        { attributesText: { $regex: this.escapeRegExp(term), $options: "i" } },
      ],
    }));

    const match = regexOr.length > 0 ? { $and: regexOr } : {};
    const docs = await this.products
      .find({ demoId, ...match })
      .limit(Math.max(10, Math.min(limit, 120)))
      .toArray();

    return docs
      .map((doc) => {
        const product = this.toProduct(doc);
        return {
          ...product,
          score: this.computeTextCoverageScore(product, terms),
          finalScore: this.computeTextCoverageScore(product, terms),
        };
      })
      .sort((a, b) => Number((b as any).score || 0) - Number((a as any).score || 0));
  }

  private async vectorSearchWithFallback(
    demoId: string,
    embedding: number[],
    limit: number
  ): Promise<OnboardingIndexedProduct[]> {
    try {
      const pipeline = [
        {
          $vectorSearch: {
            index: this.vectorIndex,
            path: "embedding",
            queryVector: embedding,
            numCandidates: Math.min(limit * 3, 200),
            limit,
            filter: { demoId },
          },
        },
        {
          $addFields: {
            score: { $meta: "vectorSearchScore" },
          },
        },
      ];

      const docs = (await this.products.aggregate(pipeline as any).toArray()) as any[];
      if (docs.length > 0) {
        return docs.map((doc) => {
          const p = this.toProduct(doc as any);
          return {
            ...p,
            score: Number((doc as any).score || 0),
            finalScore: Number((doc as any).score || 0),
          };
        });
      }
    } catch {
      // Continue to local fallback.
    }

    return this.localEmbeddingFallback(demoId, embedding, limit);
  }

  private async localEmbeddingFallback(
    demoId: string,
    embedding: number[],
    limit: number
  ): Promise<OnboardingIndexedProduct[]> {
    const docs = (await this.products
      .find({
        demoId,
        embedding: { $exists: true, $type: "array", $ne: [] },
      })
      .project({
        _id: 1,
        demoId: 1,
        jobId: 1,
        merchantId: 1,
        name: 1,
        description: 1,
        price: 1,
        currency: 1,
        imageUrl: 1,
        productUrl: 1,
        brand: 1,
        category: 1,
        inStock: 1,
        source: 1,
        raw: 1,
        attributesText: 1,
        createdAt: 1,
        expiresAt: 1,
        embedding: 1,
      })
      .limit(Math.max(limit * 8, 200))
      .toArray()) as any[];

    const scored = docs
      .map((doc) => {
        const emb = Array.isArray((doc as any).embedding) ? ((doc as any).embedding as number[]) : [];
        const score = this.cosineSimilarity(embedding, emb);
        if (!Number.isFinite(score) || score <= 0) return null;
        const p = this.toProduct(doc as any);
        return {
          ...p,
          score,
          finalScore: score,
        };
      })
      .filter(Boolean)
      .sort((a, b) => Number((b as any).score || 0) - Number((a as any).score || 0))
      .slice(0, limit);

    return scored as OnboardingIndexedProduct[];
  }

  private mergeHybridCandidates(
    vectorResults: OnboardingIndexedProduct[],
    textResults: OnboardingIndexedProduct[],
    querySoftTags: string[]
  ): OnboardingIndexedProduct[] {
    const byId = new Map<
      string,
      {
        product: OnboardingIndexedProduct;
        semanticScore: number;
        textScore: number;
      }
    >();

    for (const product of vectorResults || []) {
      const id = String(product._id || "");
      if (!id) continue;
      byId.set(id, {
        product,
        semanticScore: this.normalizeScore((product as any).score),
        textScore: 0,
      });
    }

    for (const product of textResults || []) {
      const id = String(product._id || "");
      if (!id) continue;
      const existing = byId.get(id);
      const textScore = this.normalizeScore((product as any).score);
      if (!existing) {
        byId.set(id, {
          product,
          semanticScore: 0,
          textScore,
        });
      } else {
        byId.set(id, {
          product: { ...existing.product, ...product },
          semanticScore: existing.semanticScore,
          textScore: Math.max(existing.textScore, textScore),
        });
      }
    }

    return Array.from(byId.values())
      .map(({ product, semanticScore, textScore }) => {
        const hasSemantic = semanticScore > 0;
        const hasText = textScore > 0;
        const productSoftTags = this.extractProductSoftTags(product);
        const softTagHits = querySoftTags.filter((tag) => productSoftTags.has(tag)).length;

        let retrievalScore = semanticScore * 0.74 + textScore * 0.26;
        if (hasSemantic && hasText) retrievalScore += 0.07;
        if (!hasSemantic && hasText) retrievalScore = 0.22 + textScore * 0.55;
        if (hasSemantic && !hasText) retrievalScore = Math.max(retrievalScore, semanticScore * 0.72);
        if (softTagHits > 0) retrievalScore += Math.min(0.12, softTagHits * 0.035);

        retrievalScore = Math.min(1, retrievalScore);
        return {
          ...product,
          score: retrievalScore,
          finalScore: retrievalScore,
        };
      })
      .sort((a, b) => Number((b as any).score || 0) - Number((a as any).score || 0));
  }

  private computeTextCoverageScore(product: OnboardingIndexedProduct, terms: string[]): number {
    if (terms.length === 0) return 0.2;
    const softTagsText = Array.from(this.extractProductSoftTags(product)).join(" ");
    const candidate = this.normalizeForTextSearch(
      [
        product.name,
        product.description || "",
        product.brand || "",
        product.category || "",
        this.attributesText(product.raw?.attributes as Record<string, unknown> | undefined),
        softTagsText,
      ].join(" ")
    );

    if (!candidate) return 0.2;

    const candidateTokens = this.tokenizeForTextSearch(candidate);
    const candidateKey = this.toCrossScriptKey(candidate);
    const candidateKeyTokens = candidateTokens
      .map((token) => this.toCrossScriptKey(token))
      .filter((token) => token.length >= 3);

    let weightedHits = 0;
    for (const term of terms) {
      const normalizedTerm = this.normalizeForTextSearch(term);
      if (!normalizedTerm) continue;

      let termScore = 0;
      if (candidateTokens.includes(normalizedTerm) || candidate.includes(normalizedTerm)) {
        termScore = 1;
      }

      const key = this.toCrossScriptKey(normalizedTerm);
      if (termScore === 0 && key.length >= 3 && candidateKey.includes(key)) {
        termScore = 0.82;
      }

      if (termScore === 0) {
        termScore = this.computeBestFuzzyTokenMatch(normalizedTerm, candidateTokens);
      }
      if (termScore === 0 && key.length >= 3) {
        termScore = this.computeBestFuzzyTokenMatch(key, candidateKeyTokens, true);
      }

      weightedHits += termScore;
    }

    const coverage = weightedHits / Math.max(1, terms.length);
    const phraseBonus = candidate.includes(this.normalizeForTextSearch(terms.join(" "))) ? 0.12 : 0;
    return Math.min(1, 0.24 + coverage * 0.65 + phraseBonus);
  }

  private isTextStrongEnough(results: OnboardingIndexedProduct[], requestedLimit: number): boolean {
    if (!results.length) return false;
    const sorted = [...results].sort(
      (a, b) => Number((b as any).score || 0) - Number((a as any).score || 0)
    );
    const topScore = this.normalizeScore((sorted[0] as any)?.score);
    const topThree = sorted.slice(0, 3).map((item) => this.normalizeScore((item as any)?.score));
    const topThreeAvg = topThree.length
      ? topThree.reduce((sum, item) => sum + item, 0) / topThree.length
      : 0;
    const strongHits = sorted.filter((item) => this.normalizeScore((item as any)?.score) >= 0.6).length;
    const countThreshold = Math.max(3, Math.min(7, Math.ceil(Math.max(requestedLimit, 4) * 0.45)));

    return topScore >= 0.78 && topThreeAvg >= 0.64 && strongHits >= countThreshold;
  }

  private mergeFilters(rule: ExtractedFilters, ner: ExtractedFilters): ExtractedFilters {
    const mergeUnique = (left?: string[], right?: string[]) =>
      Array.from(new Set([...(left || []), ...(right || [])]));

    return {
      ...rule,
      ...ner,
      countries: mergeUnique(rule.countries, ner.countries),
      regions: mergeUnique(rule.regions, ner.regions),
      grapes: mergeUnique(rule.grapes, ner.grapes),
      sweetness: mergeUnique(rule.sweetness, ner.sweetness),
      type: mergeUnique(rule.type, ner.type),
      category: mergeUnique(rule.category, ner.category),
      softTags: mergeUnique(rule.softTags, ner.softTags),
      priceRange: {
        ...(rule.priceRange || {}),
        ...(ner.priceRange || {}),
      },
      kosher:
        rule.kosher === true || ner.kosher === true
          ? true
          : rule.kosher === false || ner.kosher === false
            ? false
            : undefined,
    };
  }

  private applyHardConstraints(
    products: OnboardingIndexedProduct[],
    filters: ExtractedFilters,
    demoCategory?: OnboardingCategory
  ): OnboardingIndexedProduct[] {
    if (!products.length) return products;

    const hasHardCountry = (filters.countries || []).length > 0;
    const hasHardColor = (filters.category || []).length > 0;
    const hasHardType = (filters.type || []).length > 0;
    const hasHardGrape = (filters.grapes || []).length > 0;
    const hasHardSweetness = (filters.sweetness || []).length > 0;
    const hasHardPrice =
      filters.priceRange?.min !== undefined || filters.priceRange?.max !== undefined;
    const hasHardKosher = filters.kosher !== undefined;

    const needsHardFiltering =
      hasHardCountry ||
      hasHardColor ||
      hasHardType ||
      hasHardGrape ||
      hasHardSweetness ||
      hasHardPrice ||
      hasHardKosher ||
      demoCategory === "wine";

    if (!needsHardFiltering) return products;

    const countryAliasMap: Record<string, string[]> = {
      france: ["france", "french", "צרפת", "צרפתי", "צרפתית"],
      italy: ["italy", "italian", "איטליה", "איטלקי", "איטלקית"],
      spain: ["spain", "spanish", "ספרד", "ספרדי", "ספרדית"],
      usa: ["usa", "united states", "america", "ארצות הברית", "ארהב", "אמריק"],
      argentina: ["argentina", "argentinian", "ארגנטינה", "ארגנטינאי"],
      chile: ["chile", "chilean", "צילה", "צ'ילה"],
      australia: ["australia", "australian", "אוסטרליה", "אוסטרלי"],
      germany: ["germany", "german", "גרמניה", "גרמני"],
      portugal: ["portugal", "portuguese", "פורטוגל", "פורטוגלי"],
      israel: ["israel", "israeli", "ישראל", "ישראלי"],
    };

    const colorTokenMap: Record<string, string[]> = {
      red: ["red", "יין אדום", "אדום", "rosso", "tinto", "rouge"],
      white: ["white", "יין לבן", "לבן", "blanc", "blanco", "bianco"],
      "rosé": ["rose", "rosé", "רוזה", "pink", "יין רוזה"],
      rose: ["rose", "rosé", "רוזה", "pink", "יין רוזה"],
      sparkling: ["sparkling", "מבעבע", "champagne", "prosecco", "cava", "יין מבעבע"],
    };

    const typeTokenMap: Record<string, string[]> = {
      wine: ["wine", "יין"],
      beer: ["beer", "בירה"],
      vodka: ["vodka", "וודקה"],
      whiskey: ["whiskey", "whisky", "וויסקי"],
      gin: ["gin", "ג'ין", "ג׳ין", "גין"],
      rum: ["rum", "רום"],
      tequila: ["tequila", "טקילה"],
      liqueur: ["liqueur", "ליקר"],
      brandy: ["brandy", "קוניאק", "ברנדי"],
      soda: ["soda", "soft drink", "משקאות קלים"],
    };

    const countryTokens = Array.from(
      new Set(
        (filters.countries || [])
          .flatMap((country) => {
            const key = this.normalizeForTextSearch(String(country || ""));
            return countryAliasMap[key] || [key];
          })
          .map((value) => this.normalizeForTextSearch(String(value || "")))
          .filter(Boolean)
      )
    );

    const colorTokens = Array.from(
      new Set(
        (filters.category || [])
          .flatMap((color) => colorTokenMap[this.normalizeForTextSearch(color)] || [color])
          .map((value) => this.normalizeForTextSearch(String(value || "")))
          .filter(Boolean)
      )
    );

    const typeTokens = Array.from(
      new Set(
        (filters.type || [])
          .flatMap((kind) => typeTokenMap[this.normalizeForTextSearch(kind)] || [kind])
          .map((value) => this.normalizeForTextSearch(String(value || "")))
          .filter(Boolean)
      )
    );

    const grapeTokens = (filters.grapes || [])
      .map((value) => this.normalizeForTextSearch(String(value || "")))
      .filter(Boolean);
    const sweetnessTokens = (filters.sweetness || [])
      .map((value) => this.normalizeForTextSearch(String(value || "")))
      .filter(Boolean);
    const requestedTypes = (filters.type || [])
      .map((value) => this.normalizeRequestedType(value))
      .filter((value): value is string => Boolean(value));
    const requestedColors = (filters.category || [])
      .map((value) => this.normalizeRequestedColor(value))
      .filter((value): value is string => Boolean(value));

    const requiresWineScope =
      demoCategory === "wine" ||
      typeTokens.some((token) => token.includes("wine") || token.includes("יין")) ||
      colorTokens.length > 0 ||
      countryTokens.length > 0 ||
      grapeTokens.length > 0 ||
      sweetnessTokens.length > 0;

    return products.filter((product) => {
      const haystack = this.buildProductHaystack(product);
      if (!haystack) return false;
      const taxonomy = this.extractProductTaxonomy(product, haystack);

      if (requiresWineScope && !taxonomy.beverageTypes.has("wine") && !this.looksLikeWineProduct(haystack)) {
        return false;
      }

      if (requestedTypes.length > 0) {
        const matchesCanonicalType = requestedTypes.some((type) => taxonomy.beverageTypes.has(type));
        if (!matchesCanonicalType) {
          const matchesTypeToken = typeTokens.some((token) => haystack.includes(token));
          if (!matchesTypeToken) return false;
        }
      }

      if (requestedColors.length > 0) {
        const matchesCanonicalColor = requestedColors.some((color) => taxonomy.wineColors.has(color));
        if (!matchesCanonicalColor) {
          const matchesColorToken = colorTokens.some((token) => haystack.includes(token));
          if (!matchesColorToken) return false;
        }
      }

      if (countryTokens.length > 0) {
        const matchesCountry = countryTokens.some((token) => haystack.includes(token));
        if (!matchesCountry) return false;
      }

      if (grapeTokens.length > 0) {
        const matchesGrape = grapeTokens.some((token) => haystack.includes(token));
        if (!matchesGrape) return false;
      }

      if (sweetnessTokens.length > 0) {
        const matchesSweetness = sweetnessTokens.some((token) => haystack.includes(token));
        if (!matchesSweetness) return false;
      }

      if (filters.kosher !== undefined) {
        const hasKosherSignal = /\bkosher\b|כשר/.test(haystack);
        if (filters.kosher && !hasKosherSignal) return false;
      }

      if (filters.priceRange) {
        const price = Number(product.price || 0);
        if (filters.priceRange.min !== undefined && price < filters.priceRange.min) return false;
        if (filters.priceRange.max !== undefined && price > filters.priceRange.max) return false;
      }

      return true;
    });
  }

  private buildProductHaystack(product: OnboardingIndexedProduct): string {
    const raw = (product.raw || {}) as Record<string, unknown>;
    const attributes =
      raw.attributes && typeof raw.attributes === "object"
        ? (raw.attributes as Record<string, unknown>)
        : {};
    const softCategories = Array.isArray(raw.softCategories)
      ? (raw.softCategories as unknown[]).map((value) => String(value || ""))
      : [];

    return this.normalizeForTextSearch(
      [
        product.name,
        product.description || "",
        product.brand || "",
        product.category || "",
        product.inStock === true ? "in stock זמין" : "",
        ...Object.entries(attributes).map(([k, v]) => `${k} ${String(v || "")}`),
        softCategories.join(" "),
      ].join(" | ")
    );
  }

  private looksLikeWineProduct(haystack: string): boolean {
    if (!haystack) return false;
    if (/\bwine\b|יין|יקב|vintage|grape|cabernet|merlot|chardonnay|riesling/.test(haystack)) {
      return true;
    }
    if (/red|white|rose|rosé|sparkling|אדום|לבן|רוזה|מבעבע/.test(haystack)) {
      return true;
    }
    return false;
  }

  private normalizeRequestedType(value: string): string | undefined {
    const token = this.normalizeForTextSearch(value);
    if (!token) return undefined;
    if (/(wine|יין)/.test(token)) return "wine";
    if (/(whisky|whiskey|וויסקי)/.test(token)) return "whiskey";
    if (/(gin|ג׳ין|גין)/.test(token)) return "gin";
    if (/(vodka|וודקה)/.test(token)) return "vodka";
    if (/(beer|בירה)/.test(token)) return "beer";
    if (/(rum|רום)/.test(token)) return "rum";
    if (/(tequila|טקילה)/.test(token)) return "tequila";
    if (/(liqueur|ליקר)/.test(token)) return "liqueur";
    if (/(brandy|קוניאק|ברנדי)/.test(token)) return "brandy";
    if (/(soda|soft drink|משקאות קלים)/.test(token)) return "soda";
    return undefined;
  }

  private normalizeRequestedColor(value: string): string | undefined {
    const token = this.normalizeForTextSearch(value);
    if (!token) return undefined;
    if (/(red|אדום|rosso|tinto|rouge)/.test(token)) return "red";
    if (/(white|לבן|blanco|blanc|bianco)/.test(token)) return "white";
    if (/(rose|rosé|רוזה|pink)/.test(token)) return "rose";
    if (/(sparkling|מבעבע|champagne|prosecco|cava)/.test(token)) return "sparkling";
    return undefined;
  }

  private extractProductTaxonomy(
    product: OnboardingIndexedProduct,
    haystack: string
  ): { beverageTypes: Set<string>; wineColors: Set<string> } {
    const beverageTypes = new Set<string>();
    const wineColors = new Set<string>();

    const raw = (product.raw || {}) as Record<string, unknown>;
    const attributes =
      raw.attributes && typeof raw.attributes === "object"
        ? (raw.attributes as Record<string, unknown>)
        : {};

    const rawType = this.normalizeRequestedType(String(attributes.product_category || attributes.beverage_type || ""));
    if (rawType) beverageTypes.add(rawType);
    const rawColor = this.normalizeRequestedColor(String(attributes.wine_color || ""));
    if (rawColor) wineColors.add(rawColor);

    const inferredType = this.normalizeRequestedType(haystack);
    if (inferredType) beverageTypes.add(inferredType);

    const inferredColor = this.normalizeRequestedColor(haystack);
    if (inferredColor) wineColors.add(inferredColor);

    return { beverageTypes, wineColors };
  }

  private toProduct(doc: OnboardingProductDoc): OnboardingIndexedProduct {
    return {
      _id: String((doc as any)._id),
      demoId: String(doc.demoId),
      jobId: String(doc.jobId),
      merchantId: String(doc.merchantId),
      name: String(doc.name || ""),
      description: doc.description,
      price: Number(doc.price || 0),
      currency: doc.currency,
      imageUrl: doc.imageUrl,
      productUrl: String(doc.productUrl || ""),
      brand: doc.brand,
      category: doc.category,
      inStock: doc.inStock,
      source: doc.source,
      raw: doc.raw,
      createdAt: doc.createdAt,
      expiresAt: doc.expiresAt,
    };
  }

  private normalizeScore(score: unknown): number {
    const n = typeof score === "number" ? score : Number(score || 0);
    if (!Number.isFinite(n)) return 0;
    if (n <= 0) return 0;
    if (n >= 1) return 1;
    return n;
  }

  private attributesText(attributes?: Record<string, unknown>): string {
    if (!attributes || typeof attributes !== "object") return "";
    return Object.entries(attributes)
      .map(([k, v]) => `${k} ${String(v || "")}`)
      .join(" ");
  }

  private extractProductSoftTags(product: OnboardingIndexedProduct): Set<string> {
    const tags = new Set<string>();
    const raw = product.raw as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return tags;

    if (Array.isArray(raw.softCategories)) {
      for (const value of raw.softCategories as unknown[]) {
        const tag = this.normalizeForTextSearch(String(value || ""));
        if (tag) tags.add(tag);
      }
    }

    const attributes =
      raw.attributes && typeof raw.attributes === "object"
        ? (raw.attributes as Record<string, unknown>)
        : {};
    const softText = this.normalizeForTextSearch(String(attributes.soft_categories || ""));
    for (const token of softText.split(/\s+/).filter((item) => item.length > 1)) {
      tags.add(token);
    }

    return tags;
  }

  private deriveWineSoftTags(query: string): string[] {
    const source = this.normalizeForTextSearch(query);
    if (!source) return [];
    const tags = new Set<string>();
    const add = (values: string[]) => {
      for (const value of values) {
        const clean = this.normalizeForTextSearch(value);
        if (clean) tags.add(clean);
      }
    };

    if (/(fish|seafood|דג|דגים|סושי)/.test(source)) add(["fish", "seafood", "pairing_fish", "דגים"]);
    if (/(pizza|pasta|italian|איטלק|פיצה|פסטה)/.test(source)) {
      add(["italian_food", "pairing_italian", "pizza", "pasta", "איטלקי"]);
    }
    if (/(meat|steak|bbq|grill|בשר|סטייק|גריל)/.test(source)) add(["meat", "bbq", "pairing_meat", "בשר"]);
    if (/(crispy|crisp|fresh|zesty|acid|acidity|רענן|קריספי|חומציות)/.test(source)) {
      add(["crisp", "fresh", "high_acidity", "רענן", "קריספי"]);
    }
    if (/(full bod|rich|bold|גוף מלא|עשיר|עוצמתי)/.test(source)) add(["full_body", "rich", "bold", "גוף מלא"]);
    if (/(light bod|easy drinking|קליל|גוף קל)/.test(source)) add(["light_body", "easy_drinking", "קליל"]);
    if (/(dry|יבש)/.test(source)) add(["dry", "יבש"]);
    if (/(semi dry|חצי יבש)/.test(source)) add(["semi_dry", "חצי יבש"]);
    if (/(sweet|dessert|מתוק|קינוח)/.test(source)) add(["sweet", "dessert_wine", "מתוק"]);
    if (/(rose|rosé|רוזה)/.test(source)) add(["rose", "רוזה"]);
    if (/(sparkling|mous|בועות|מבעבע)/.test(source)) add(["sparkling", "בועות"]);
    if (/(kosher|כשר)/.test(source)) add(["kosher", "כשר"]);
    if (
      /(germany|austria|sweden|denmark|netherlands|belgium|scandinav|גרמניה|אוסטריה|סקנדינביה|צפון אירופה)/.test(
        source
      )
    ) {
      add(["north_europe", "צפון אירופה"]);
    }

    return Array.from(tags).filter(Boolean);
  }

  private normalizeForTextSearch(value: string): string {
    return String(value || "")
      .toLowerCase()
      .replace(/[\u0591-\u05C7]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private tokenizeForTextSearch(value: string): string[] {
    return this.normalizeForTextSearch(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1);
  }

  private toCrossScriptKey(value: string): string {
    const normalized = this.normalizeForTextSearch(value);
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

  private computeBestFuzzyTokenMatch(
    term: string,
    candidates: string[],
    strictLength = false
  ): number {
    if (!term || term.length < 4 || !candidates.length) return 0;
    let best = 0;

    for (const rawCandidate of candidates) {
      const candidate = String(rawCandidate || "").trim();
      if (!candidate) continue;
      const maxLen = Math.max(term.length, candidate.length);
      const lenDiff = Math.abs(term.length - candidate.length);
      if ((strictLength && lenDiff > 2) || (!strictLength && lenDiff > 3)) continue;

      const ratio = this.levenshteinDistance(term, candidate) / Math.max(1, maxLen);
      let score = 0;
      if (ratio <= 0.12) score = 0.88;
      else if (ratio <= 0.2) score = 0.76;
      else if (ratio <= 0.3) score = 0.62;
      else if (ratio <= 0.36) score = 0.5;

      if (score > best) best = score;
      if (best >= 0.88) break;
    }

    return best;
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

  private cosineSimilarity(a: number[], b: number[]): number {
    if (!a.length || !b.length || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i += 1) {
      const av = Number(a[i] || 0);
      const bv = Number(b[i] || 0);
      dot += av * bv;
      normA += av * av;
      normB += bv * bv;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (!denom) return 0;
    return Math.max(0, Math.min(1, (dot / denom + 1) / 2));
  }

  private escapeRegExp(value: string): string {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
