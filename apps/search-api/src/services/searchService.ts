import type { SearchQuery, SearchResult, Env } from "../types/index.js";
import { QueryParser } from "./queryParser.js";
import { EmbeddingService } from "./embeddingService.js";
import { VectorSearchService } from "./vectorSearchService.js";
import { Reranker } from "./reranker.js";
import { EntityExtractionService } from "./entityExtractionService.js";
import type { BoostRuleService } from "./boostRuleService.js";

/**
 * Main search orchestrator
 * Coordinates parsing, embedding, vector search, and reranking
 */
export class SearchService {
  private parser: QueryParser;
  private entityExtractor: EntityExtractionService;
  private embeddingService: EmbeddingService;
  private vectorSearch: VectorSearchService;
  private reranker: Reranker;
  private boostRuleService?: BoostRuleService;

  constructor(env: Env, boostRuleService?: BoostRuleService) {
    this.parser = new QueryParser();
    this.entityExtractor = new EntityExtractionService(env);
    this.embeddingService = new EmbeddingService(env);
    this.vectorSearch = new VectorSearchService(env);
    this.reranker = new Reranker();
    this.boostRuleService = boostRuleService;
  }

  /**
   * Initialize the service (connect to MongoDB)
   */
  async initialize(): Promise<void> {
    await this.vectorSearch.connect();
  }

  /**
   * Close connections
   */
  async close(): Promise<void> {
    await this.vectorSearch.close();
  }

  /**
   * Perform semantic search
   */
  async search(query: SearchQuery): Promise<SearchResult> {
    const timings = {
      parsing: 0,
      embedding: 0,
      vectorSearch: 0,
      reranking: 0,
      total: 0,
    };

    const startTotal = Date.now();

    try {
      // 1. Parse query and extract filters
      const startParsing = Date.now();
      const ruleFilters = this.parser.parse(query.query);
      const ruleHasSpecificType =
        Array.isArray(ruleFilters.type) &&
        ruleFilters.type.some((t) => String(t).toLowerCase() !== "wine");
      const hasRuleHints =
        Boolean(ruleHasSpecificType) ||
        Boolean(ruleFilters.category?.length) ||
        Boolean(ruleFilters.countries?.length) ||
        Boolean(ruleFilters.grapes?.length) ||
        Boolean(ruleFilters.sweetness?.length) ||
        Boolean((ruleFilters as any).softTags?.length) ||
        Boolean(ruleFilters.kosher !== undefined) ||
        Boolean(ruleFilters.priceRange?.min !== undefined || ruleFilters.priceRange?.max !== undefined);
      const ner = hasRuleHints
        ? ({ filters: {} as any, confidence: undefined, language: undefined } as const)
        : await this.entityExtractor.extract(query.query);

      // Merge rule-based + NER filters (NER can add synonyms/morphology)
      const mergeUnique = (a?: string[], b?: string[]) =>
        Array.from(new Set([...(a || []), ...(b || [])]));

      const mergedFilters = {
        ...ruleFilters,
        ...ner.filters,
        countries: mergeUnique(ruleFilters.countries, ner.filters.countries),
        regions: mergeUnique((ruleFilters as any).regions, (ner.filters as any).regions),
        grapes: mergeUnique(ruleFilters.grapes, ner.filters.grapes),
        sweetness: mergeUnique(ruleFilters.sweetness, ner.filters.sweetness),
        // HARD filters should be explicit in query (rule-based).
        // NER-only type/category is ignored to avoid over-filtering (e.g. "מרטיני").
        type:
          ruleFilters.type && ruleFilters.type.length > 0
            ? mergeUnique(ruleFilters.type, ner.filters.type)
            : ruleFilters.type,
        category:
          ruleFilters.category && ruleFilters.category.length > 0
            ? mergeUnique(ruleFilters.category, ner.filters.category)
            : ruleFilters.category,
        softTags: mergeUnique((ruleFilters as any).softTags, (ner.filters as any).softTags),
        priceRange: {
          ...(ruleFilters.priceRange || {}),
          ...(ner.filters.priceRange || {}),
        },
        kosher:
          ruleFilters.kosher === true || ner.filters.kosher === true
            ? true
            : ruleFilters.kosher === false || ner.filters.kosher === false
              ? false
              : undefined,
      } as any;

      // Only apply EXPLICIT filters from the request as hard pre-filters.
      // Parsed filters are best-effort hints and can easily over-filter to 0 results
      // if the merchant catalog doesn't reliably populate those attributes.
      const extractedFilters = { ...mergedFilters };

      // Merge with explicit filters from request
      if (query.minPrice) {
        extractedFilters.priceRange = {
          ...extractedFilters.priceRange,
          min: query.minPrice,
        };
      }
      if (query.maxPrice) {
        extractedFilters.priceRange = {
          ...extractedFilters.priceRange,
          max: query.maxPrice,
        };
      }
      if (query.countries) extractedFilters.countries = query.countries;
      if (query.kosher !== undefined) extractedFilters.kosher = query.kosher;

      // Build pre-filters ONLY from explicit request fields
      // (don’t include parsed filters to avoid “0 results” surprises)
      const preFilterObj: any = {};
      if (query.minPrice || query.maxPrice) {
        preFilterObj.priceRange = {
          ...(query.minPrice ? { min: query.minPrice } : {}),
          ...(query.maxPrice ? { max: query.maxPrice } : {}),
        };
      }
      if (query.countries) preFilterObj.countries = query.countries;
      if (query.kosher !== undefined) preFilterObj.kosher = query.kosher;

      // HARD filters requested by user:
      // - type (wine/whiskey/liqueur/etc.)
      // - category (red/white/rosé/sparkling)
      // - kosher / price
      const mapTypeToCategory = (types?: string[]) =>
        (types || [])
          .map((cat) => {
            switch (cat.toLowerCase()) {
              case "wine":
                return ["יין", "יין אדום", "יין לבן", "יין מבעבע", "יין רוזה"];
              case "vodka":
                return ["וודקה"];
              case "beer":
                return ["בירה"];
              case "liqueur":
                return ["ליקר", "ליקרים"];
              case "whiskey":
              case "whisky":
                return ["וויסקי"];
              case "gin":
                return ["ג׳ין", "גין"];
              case "rum":
                return ["רום"];
              case "tequila":
                return ["טקילה"];
              case "brandy":
                return ["ברנדי", "קוניאק"];
              case "soda":
                return ["משקאות קלים"];
              default:
                return [];
            }
          })
          .flat()
          .filter(Boolean);

      const mapColorToCategory = (colors?: string[]) =>
        (colors || [])
          .map((c) => {
            switch (c.toLowerCase()) {
              case "red":
                return ["יין אדום"];
              case "white":
                return ["יין לבן"];
              case "rosé":
              case "rose":
                return ["יין רוזה"];
              case "sparkling":
                return ["יין מבעבע", "שמפניה"];
              default:
                return [];
            }
          })
          .flat()
          .filter(Boolean);

      const hardTypeCats = mapTypeToCategory(mergedFilters.type);
      const hardColorCats = mapColorToCategory(mergedFilters.category);
      const normalizedTypes = (mergedFilters.type || []).map((t: string) => String(t).toLowerCase());
      const hasSpecificTypeConstraint = normalizedTypes.some((t: string) => t !== "wine");
      const shouldApplyTypeAsHardCategory = hasSpecificTypeConstraint;
      const requiresWineCategory = normalizedTypes.includes("wine");
      const hardCategorySet = new Set(
        hardColorCats.length > 0 ? hardColorCats : shouldApplyTypeAsHardCategory ? hardTypeCats : []
      );
      const countryAliasMap: Record<string, string[]> = {
        france: ["france", "french", "צרפת", "צרפתי", "צרפתית"],
        italy: ["italy", "italian", "איטליה", "איטלקי", "איטלקית"],
        spain: ["spain", "spanish", "ספרד", "ספרדי", "ספרדית"],
        usa: ["usa", "united states", "america", "אמריקה", "ארהב", "ארצות הברית", "אמריקאי", "אמריקאית"],
        argentina: ["argentina", "argentinian", "ארגנטינה", "ארגנטינאי", "ארגנטינאית"],
        chile: ["chile", "chilean", "צ'ילה", "ציליאני", "ציליאנית"],
        australia: ["australia", "australian", "אוסטרליה", "אוסטרלי", "אוסטרלית"],
        germany: ["germany", "german", "גרמניה", "גרמני", "גרמנית"],
        portugal: ["portugal", "portuguese", "פורטוגל", "פורטוגלי", "פורטוגלית"],
        israel: ["israel", "israeli", "ישראל", "ישראלי", "ישראלית"],
      };
      const hardCountryAliases: string[] = Array.from(
        new Set(
          (mergedFilters.countries || [])
            .flatMap((country: string) => {
              const normalized = String(country || "").toLowerCase().trim();
              if (!normalized) return [];
              return countryAliasMap[normalized] || [normalized];
            })
            .map((v: string) => String(v).toLowerCase())
            .filter(Boolean)
        )
      );

      // NOTE: We intentionally do not push parsed category/type into vector pre-filter.
      // Atlas filter mappings can be brittle across catalog shapes; we enforce these as post-filters.

      // Use merged filters for cleaning so "אדום/ישראלי/יבש" doesn't dominate the embedding.
      const cleanedQuery = this.parser.cleanQuery(query.query, mergedFilters);
      timings.parsing = Date.now() - startParsing;

      const startVectorRetrieval = Date.now();
      const textResultSet = await Promise.resolve(this.vectorSearch.textSearch(query.query, preFilterObj, 50))
        .then((value) => ({ status: "fulfilled" as const, value }))
        .catch((reason) => ({ status: "rejected" as const, reason }));

      const textResults = textResultSet.status === "fulfilled" ? textResultSet.value : [];
      if (textResultSet.status === "rejected") {
        console.warn("Text search failed in adaptive path:", textResultSet.reason);
      }

      const useTextOnly = this.isTextStrongEnough(textResults, query.limit);
      let vectorResults: any[] = [];
      if (!useTextOnly) {
        const startEmbedding = Date.now();
        const embeddingResultSet = await Promise.resolve(
          this.embeddingService.generateEmbedding(cleanedQuery)
        )
          .then((value) => ({ status: "fulfilled" as const, value }))
          .catch((reason) => ({ status: "rejected" as const, reason }));

        if (embeddingResultSet.status === "fulfilled") {
          timings.embedding = Date.now() - startEmbedding;
          vectorResults = await this.vectorSearch.search(
            embeddingResultSet.value,
            query.merchantId,
            preFilterObj,
            50
          );
        } else {
          timings.embedding = Date.now() - startEmbedding;
          console.warn("Embedding generation failed in adaptive path:", embeddingResultSet.reason);
        }
      }

      const baseResults = useTextOnly
        ? this.mergeHybridCandidates([], textResults)
        : this.mergeHybridCandidates(vectorResults, textResults);
      const retrievalBreakdown = {
        vectorCandidates: vectorResults.length,
        textCandidates: textResults.length,
        mergedCandidates: baseResults.length,
        mode: useTextOnly ? ("text_only" as const) : ("hybrid" as const),
      };
      timings.vectorSearch = Date.now() - startVectorRetrieval;

      // Apply HARD filters again after retrieval to guarantee strictness
      const applyHardConstraints = (results: any[]) =>
        results.filter((p: any) => {
          const productCategories = Array.isArray(p.category)
            ? p.category
            : typeof p.category === "string"
              ? [p.category]
              : [];
          const productSoftCategories = Array.isArray(p.softCategory)
            ? p.softCategory
            : typeof p.softCategory === "string"
              ? [p.softCategory]
              : [];
          if (hardCategorySet.size > 0) {
            const hasCategory = productCategories.some((c: string) => hardCategorySet.has(c));
            if (!hasCategory) return false;
          }
          if (hardCountryAliases.length > 0) {
            const candidateFields = [
              ...(typeof p.country === "string" ? [p.country] : []),
              ...(typeof p.region === "string" ? [p.region] : []),
              ...productCategories,
              ...productSoftCategories,
            ]
              .map((v) => String(v).toLowerCase())
              .filter(Boolean);
            const matchesCountry = candidateFields.some((fieldValue) =>
              hardCountryAliases.some((alias) => fieldValue.includes(alias))
            );
            if (!matchesCountry) return false;
          }
          if (requiresWineCategory) {
            const looksLikeWine = productCategories.some((c: string) =>
              String(c).toLowerCase().includes("יין")
            );
            if (!looksLikeWine) return false;
          }
          if (mergedFilters.kosher !== undefined && p.kosher !== mergedFilters.kosher) return false;
          if (mergedFilters.priceRange) {
            if (mergedFilters.priceRange.min && p.price < mergedFilters.priceRange.min) return false;
            if (mergedFilters.priceRange.max && p.price > mergedFilters.priceRange.max) return false;
          }
          return true;
        });
      let hardFilteredResults = applyHardConstraints(baseResults);

      // Deterministic category fallback when hard constraints are explicit and retrieval is empty.
      if (hardFilteredResults.length === 0 && hardCategorySet.size > 0) {
        const categoryFallbackResults = await this.vectorSearch.fetchProductsByCategories(
          Array.from(hardCategorySet),
          50
        );
        if (categoryFallbackResults.length > 0) {
          hardFilteredResults = applyHardConstraints(categoryFallbackResults as any[]);
        }
      }

      // Soft tags boost (non-hard categories like pizza/Portugal/etc.)
      const mapSoftTags = (filters: any) => {
        const tags = new Set<string>();
        const addAll = (arr?: string[]) => (arr || []).forEach((t) => t && tags.add(t));

        addAll(filters.softTags);
        addAll(filters.countries);
        addAll(filters.regions);
        addAll(filters.grapes);
        addAll(filters.sweetness);

        // Map canonical values to Hebrew softCategory values (as seen in Mongo)
        const map = new Map<string, string[]>([
          ["italian food", ["איטליה", "איטלקי", "פסטה", "פיצה"]],
          ["italian cuisine", ["איטליה", "איטלקי", "פסטה", "פיצה"]],
          ["north europe", ["גרמניה", "צרפת", "ריזלינג", "לואר", "בורגון"]],
          ["crispy", ["רענן", "מינרלי", "יבש", "לבן", "מבעבע", "חומציות"]],
          ["crisp", ["רענן", "מינרלי", "יבש", "לבן", "מבעבע", "חומציות"]],
          ["fresh", ["רענן", "מינרלי", "יבש", "לבן", "מבעבע", "חומציות"]],
          ["קריספי", ["רענן", "מינרלי", "יבש", "לבן", "מבעבע", "חומציות"]],
          ["רענן", ["רענן", "מינרלי", "יבש", "לבן", "מבעבע", "חומציות"]],
          ["pizza", ["פיצה", "מנות איטלקיות", "איטליה"]],
          ["פיצה", ["פיצה", "מנות איטלקיות", "איטליה"]],
          ["fish", ["דגים", "דג", "פירות ים"]],
          ["seafood", ["דגים", "דג", "פירות ים"]],
          ["דגים", ["דגים", "דג", "פירות ים"]],
          ["meat", ["בשר"]],
          ["בשר", ["בשר"]],
          ["cheese", ["גבינות", "גבינה"]],
          ["גבינות", ["גבינות", "גבינה"]],
          ["pasta", ["פסטה", "מנות איטלקיות"]],
          ["פסטה", ["פסטה", "מנות איטלקיות"]],
          ["portugal", ["פורטוגל"]],
          ["france", ["צרפת", "בורגון", "בורדו"]],
          ["italy", ["איטליה", "טוסקנה", "פיימונטה", "ונטו", "סיציליה"]],
          ["spain", ["ספרד", "ריוחה"]],
          ["germany", ["גרמניה"]],
          ["australia", ["אוסטרליה"]],
          ["argentina", ["ארגנטינה"]],
          ["chile", ["צ'ילה"]],
          ["usa", ["ארצות הברית"]],
          ["israel", ["ישראל"]],
          ["dry", ["יבש"]],
          ["semi-dry", ["חצי יבש"]],
          ["sweet", ["מתוק"]],
        ]);

        const normalized = Array.from(tags).flatMap((t) =>
          map.get(t.toLowerCase()) ? map.get(t.toLowerCase())! : [t]
        );
        return Array.from(new Set(normalized.filter(Boolean)));
      };

      const softTags = mapSoftTags(mergedFilters);

      if (hardFilteredResults.length === 0 && softTags.length > 0) {
        const softIntentResults = await this.vectorSearch.fetchProductsBySoftTags(softTags, 50);
        if (softIntentResults.length > 0) {
          hardFilteredResults = applyHardConstraints(softIntentResults as any[]);
        }
      }

      const boostedResults = hardFilteredResults.map((product) => {
        if (!softTags.length) return product;
        const softCategory = product.softCategory;
        const softValues = Array.isArray(softCategory)
          ? softCategory
          : typeof softCategory === "string"
            ? [softCategory]
            : [];
        const catValues = Array.isArray(product.category) ? product.category : [];
        const allTags = new Set<string>([...softValues, ...catValues]);
        const matches = softTags.filter((t) => allTags.has(t)).length;
        const boost = 1 + Math.min(0.15, matches * 0.03); // cap soft boost at +15%
        return { ...product, score: product.score * boost };
      });

      // 3.1 Wine-demo guardrail: prefer wine-like results (catalog may include other beverages)
      // We keep this as a soft filter: if it eliminates everything, we fall back to the full vector results.
      const wineLike = (p: any) => {
        const name = typeof p?.name === "string" ? p.name : "";
        const desc = typeof p?.description === "string" ? p.description : "";
        return /\bwine\b/i.test(name) || /\bwine\b/i.test(desc) || name.includes("יין") || desc.includes("יין");
      };
      const wineFilteredResults = boostedResults.filter(wineLike);
      let candidatesForRerank =
        wineFilteredResults.length > 0 ? wineFilteredResults : boostedResults;

      if (this.boostRuleService) {
        const relevantRules = await this.boostRuleService.getRelevantRules(
          query.merchantId,
          query.query
        );
        if (relevantRules.length > 0) {
          const existingIds = new Set(candidatesForRerank.map((p: any) => String(p._id)));
          const missingBoostedIds = relevantRules
            .map((r) => r.productId)
            .filter((id) => !existingIds.has(String(id)));

          if (missingBoostedIds.length > 0) {
            const injected = await this.vectorSearch.fetchProductsByIds(missingBoostedIds);
            if (injected.length > 0) {
              candidatesForRerank = [...candidatesForRerank, ...injected];
            }
          }
        }

        candidatesForRerank = await this.boostRuleService.applyBoosts(
          query.merchantId,
          query.query,
          candidatesForRerank as any
        );
        // Boosted products must still respect hard semantic constraints from parsing.
        candidatesForRerank = applyHardConstraints(candidatesForRerank);
      }

      // 4. Rerank results
      const startReranking = Date.now();
      // Keep the full candidate pool through reranking so boosted items don't get trimmed out
      let finalResults = this.reranker.rerank(
        candidatesForRerank,
        Math.max(candidatesForRerank.length, query.limit + query.offset)
      );
      finalResults = this.reranker.applyBusinessRules(finalResults);
      finalResults = this.applyPinnedOrdering(finalResults);
      timings.reranking = Date.now() - startReranking;

      timings.total = Date.now() - startTotal;

      // Apply pagination
      const paginatedResults = finalResults.slice(
        query.offset,
        query.offset + query.limit
      );

      return {
        products: paginatedResults,
        metadata: {
          query: query.query,
          appliedFilters: extractedFilters,
          ner: {
            enabled: this.entityExtractor.isEnabled(),
            extractedFilters: ner.filters,
            confidence: ner.confidence,
            language: ner.language,
          },
          totalResults: finalResults.length,
          returnedCount: paginatedResults.length,
          retrieval: retrievalBreakdown,
          timings,
        },
      };
    } catch (error) {
      console.error("Search failed:", error);
      throw error;
    }
  }

  private mergeHybridCandidates(vectorResults: any[], textResults: any[]): any[] {
    const byId = new Map<
      string,
      {
        product: any;
        semanticScore: number;
        textScore: number;
      }
    >();

    for (const product of vectorResults || []) {
      const id = String(product?._id || "");
      if (!id) continue;
      byId.set(id, {
        product,
        semanticScore: this.normalizeScore(product?.score),
        textScore: 0,
      });
    }

    for (const product of textResults || []) {
      const id = String(product?._id || "");
      if (!id) continue;
      const existing = byId.get(id);
      const textScore = this.normalizeScore(product?.score);
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

    const merged = Array.from(byId.values()).map(({ product, semanticScore, textScore }) => {
      const hasSemantic = semanticScore > 0;
      const hasText = textScore > 0;

      let retrievalScore = semanticScore * 0.78 + textScore * 0.22;
      if (hasSemantic && hasText) retrievalScore += 0.08;
      if (!hasSemantic && hasText) retrievalScore = 0.25 + textScore * 0.5;
      if (hasSemantic && !hasText) retrievalScore = Math.max(retrievalScore, semanticScore * 0.72);
      retrievalScore = Math.min(1, retrievalScore);

      return {
        ...product,
        semanticScore,
        textScore,
        score: retrievalScore,
      };
    });

    merged.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    return merged;
  }

  private isTextStrongEnough(textResults: any[], requestedLimit: number): boolean {
    if (!textResults || textResults.length === 0) return false;

    const sorted = [...textResults].sort(
      (a, b) => Number(b?.score || 0) - Number(a?.score || 0)
    );
    const topScore = this.normalizeScore(sorted[0]?.score);
    const topThree = sorted.slice(0, 3).map((item) => this.normalizeScore(item?.score));
    const topThreeAvg =
      topThree.length > 0 ? topThree.reduce((sum, n) => sum + n, 0) / topThree.length : 0;
    const strongTextHits = sorted.filter((item) => this.normalizeScore(item?.score) >= 0.62).length;
    const countThreshold = Math.max(3, Math.min(7, Math.ceil(Math.max(4, requestedLimit) * 0.5)));

    return topScore >= 0.8 && topThreeAvg >= 0.68 && strongTextHits >= countThreshold;
  }

  private normalizeScore(score: unknown): number {
    const n = typeof score === "number" ? score : Number(score || 0);
    if (!Number.isFinite(n)) return 0;
    if (n <= 0) return 0;
    if (n >= 1) return 1;
    return n;
  }

  private applyPinnedOrdering(results: any[]): any[] {
    if (results.length === 0) return results;
    const pinned = results.filter((p) => Boolean((p as any).promotedPin));
    const promoted = results.filter(
      (p) => !Boolean((p as any).promotedPin) && Boolean((p as any).promoted)
    );
    if (pinned.length === 0 && promoted.length === 0) return results;

    const rest = results.filter(
      (p) => !(p as any).promotedPin && !(p as any).promoted
    );
    const byScoreDesc = (a: any, b: any) =>
      Number((b as any).finalScore || (b as any).score || 0) -
      Number((a as any).finalScore || (a as any).score || 0);
    pinned.sort(byScoreDesc);
    promoted.sort(byScoreDesc);
    rest.sort(byScoreDesc);
    return [...pinned, ...promoted, ...rest];
  }
}
