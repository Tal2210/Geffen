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
      const hasRuleHints =
        Boolean(ruleFilters.type?.length) ||
        Boolean(ruleFilters.category?.length) ||
        Boolean(ruleFilters.countries?.length) ||
        Boolean(ruleFilters.grapes?.length) ||
        Boolean(ruleFilters.sweetness?.length) ||
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
      const preFilters = {};

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
      const hardCategorySet = new Set(hardColorCats.length > 0 ? hardColorCats : hardTypeCats);

      // NOTE: We intentionally do not push parsed category/type into vector pre-filter.
      // Atlas filter mappings can be brittle across catalog shapes; we enforce these as post-filters.

      // Use merged filters for cleaning so "אדום/ישראלי/יבש" doesn't dominate the embedding.
      const cleanedQuery = this.parser.cleanQuery(query.query, mergedFilters);
      timings.parsing = Date.now() - startParsing;

      // 2. Hybrid: try strict textual match first, fallback to semantic
      const startTextSearch = Date.now();
      const textResults = await this.vectorSearch.textSearch(
        query.query,
        preFilterObj,
        50
      );
      let usedText = textResults.length > 0;
      timings.vectorSearch = Date.now() - startTextSearch;

      let baseResults: any[] = textResults;

      // Fast category fallback for mixed-intent queries when strict text search misses.
      // This avoids unnecessary embedding calls and prevents zero-results on known categories.
      if (!usedText && hardCategorySet.size > 0) {
        const categoryFastFallback = await this.vectorSearch.fetchProductsByCategories(
          Array.from(hardCategorySet),
          50
        );
        if (categoryFastFallback.length > 0) {
          baseResults = categoryFastFallback;
          usedText = true;
        }
      }

      if (!usedText) {
        // 3. Semantic search
        const startEmbedding = Date.now();
        const embedding = await this.embeddingService.generateEmbedding(cleanedQuery);
        timings.embedding = Date.now() - startEmbedding;

        const startVectorSearch = Date.now();
        baseResults = await this.vectorSearch.search(
          embedding,
          query.merchantId,
          preFilterObj,
          50 // Retrieve more candidates for reranking
        );
        timings.vectorSearch = Date.now() - startVectorSearch;
      }

      // Apply HARD filters again after retrieval to guarantee strictness
      const applyHardCategoryFilter = (results: any[]) =>
        results.filter((p: any) => {
          const productCategories = Array.isArray(p.category)
            ? p.category
            : typeof p.category === "string"
              ? [p.category]
              : [];
          if (hardCategorySet.size > 0) {
            const hasCategory = productCategories.some((c: string) => hardCategorySet.has(c));
            if (!hasCategory) return false;
          }
          if (mergedFilters.kosher !== undefined && p.kosher !== mergedFilters.kosher) return false;
          if (mergedFilters.priceRange) {
            if (mergedFilters.priceRange.min && p.price < mergedFilters.priceRange.min) return false;
            if (mergedFilters.priceRange.max && p.price > mergedFilters.priceRange.max) return false;
          }
          return true;
        });
      let hardFilteredResults = applyHardCategoryFilter(baseResults);

      // Semantic fallback for mixed-intent queries (e.g. "יין אדום לפיצה"):
      // if vector path produced no results after hard filtering, fallback by explicit category fetch.
      if (!usedText && hardFilteredResults.length === 0 && hardCategorySet.size > 0) {
        const categoryFallbackResults = await this.vectorSearch.fetchProductsByCategories(
          Array.from(hardCategorySet),
          50
        );
        if (categoryFallbackResults.length > 0) {
          hardFilteredResults = applyHardCategoryFilter(categoryFallbackResults as any[]);
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
          timings,
        },
      };
    } catch (error) {
      console.error("Search failed:", error);
      throw error;
    }
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
