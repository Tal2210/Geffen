import { MongoClient, ObjectId, type Db, type Collection } from "mongodb";
import type { ExtractedFilters, VectorSearchHit, Env } from "../types/index.js";

/**
 * MongoDB Atlas Vector Search Service
 * Performs ANN search with pre-filtering for multi-tenant support
 */
export class VectorSearchService {
  private client: MongoClient;
  private db!: Db;
  private collection!: Collection;
  private collectionName: string;

  constructor(private env: Env) {
    this.client = new MongoClient(env.MONGO_URI);
    this.collectionName = env.MONGO_COLLECTION;
  }

  /**
   * Connect to MongoDB
   */
  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.env.MONGO_DB);
    this.collection = this.db.collection(this.collectionName);
    console.log(`✅ Connected to MongoDB: ${this.env.MONGO_DB}.${this.collectionName}`);
  }

  /**
   * Close MongoDB connection
   */
  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Perform vector search with optional pre-filters
   * Returns Top-K results based on cosine similarity
   */
  async search(
    embedding: number[],
    merchantId: string,
    extractedFilters: ExtractedFilters,
    limit: number = 50
  ): Promise<VectorSearchHit[]> {
    const preFilter = this.buildPreFilter(extractedFilters);

    // MongoDB Atlas Vector Search aggregation pipeline
    const pipeline = [
      {
        $vectorSearch: {
          index: "wine_vector_index", // Atlas Search vector index name
          path: "embedding", // Field containing the embedding
          queryVector: embedding,
          numCandidates: Math.min(limit * 3, 150), // Search 3x candidates, max 150
          limit: limit,
          filter: preFilter, // Pre-filtering for performance & multi-tenancy
        },
      },
      {
        $addFields: {
          score: { $meta: "vectorSearchScore" }, // Add similarity score
        },
      },
      {
        $project: {
          _id: 1,
          merchantId: 1,
          name: 1,
          description: 1,
          price: 1,
          currency: 1,
          color: 1,
          country: 1,
          region: 1,
          grapes: 1,
          vintage: 1,
          sweetness: 1,
          kosher: 1,
          alcohol: 1,
          volume: 1,
          imageUrl: 1,
          image_url: 1,
          image: 1,
          images: 1,
          featuredImage: 1,
          featured_image: 1,
          thumbnail: 1,
          inStock: 1,
          stockCount: 1,
          rating: 1,
          reviewCount: 1,
          salesCount30d: 1,
          viewCount30d: 1,
          popularity: 1,
          category: 1,
          softCategory: 1,
          score: 1,
          createdAt: 1,
          updatedAt: 1
        }
      },
    ];

    try {
      const results = await this.collection.aggregate(pipeline).toArray();
      return results.map((doc) => this.normalizeImageFields(doc)) as VectorSearchHit[];
    } catch (error) {
      console.error("Vector search failed:", error);

      // If we hit a dimension mismatch, do NOT fall back silently — this is a configuration bug.
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
      if (message.includes("dimensions") && message.includes("indexed") && message.includes("queried")) {
        throw error;
      }

      // If vector search is not available for some other reason, fallback to text search
      console.warn("⚠️  Vector search failed, falling back to text search");
      return this.fallbackTextSearch(merchantId, extractedFilters, limit);
    }
  }

  /**
   * Textual search for hybrid "text-first" mode.
   * If any textual matches are found, semantic search is skipped.
   */
  async textSearch(
    query: string,
    extractedFilters: ExtractedFilters,
    limit: number = 50
  ): Promise<VectorSearchHit[]> {
    const preFilter = this.buildPreFilter(extractedFilters);
    const textQuery = this.buildTextQuery(query);
    if (!textQuery) return [];

    const match: any =
      Object.keys(preFilter).length > 0 ? { $and: [preFilter, textQuery] } : textQuery;

    const results = await this.collection
      .find(match)
      .project({
        category: 1,
        softCategory: 1,
        name: 1,
        description: 1,
        short_description: 1,
        price: 1,
        currency: 1,
        color: 1,
        country: 1,
        region: 1,
        grapes: 1,
        vintage: 1,
        sweetness: 1,
        kosher: 1,
        alcohol: 1,
        volume: 1,
        imageUrl: 1,
        image_url: 1,
        image: 1,
        images: 1,
        featuredImage: 1,
        featured_image: 1,
        thumbnail: 1,
        inStock: 1,
        stockCount: 1,
        rating: 1,
        reviewCount: 1,
        salesCount30d: 1,
        viewCount30d: 1,
        popularity: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .limit(limit)
      .toArray();

    return results.map((doc) => {
      const normalized = this.normalizeImageFields(doc);
      return {
        ...normalized,
        _id: doc._id.toString(),
        score: 1.0,
      };
    }) as VectorSearchHit[];
  }

  async fetchProductsByIds(productIds: string[]): Promise<VectorSearchHit[]> {
    if (productIds.length === 0) return [];

    const uniqueIds = Array.from(new Set(productIds.map((id) => String(id)).filter(Boolean)));
    const objectIds = uniqueIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));

    const docs = await this.collection
      .find({
        $or: [{ _id: { $in: uniqueIds as any[] } }, { _id: { $in: objectIds as any[] } }],
      })
      .project({
        _id: 1,
        merchantId: 1,
        name: 1,
        description: 1,
        price: 1,
        currency: 1,
        color: 1,
        country: 1,
        region: 1,
        grapes: 1,
        vintage: 1,
        sweetness: 1,
        kosher: 1,
        alcohol: 1,
        volume: 1,
        imageUrl: 1,
        image_url: 1,
        image: 1,
        images: 1,
        featuredImage: 1,
        featured_image: 1,
        thumbnail: 1,
        inStock: 1,
        stockCount: 1,
        rating: 1,
        reviewCount: 1,
        salesCount30d: 1,
        viewCount30d: 1,
        popularity: 1,
        category: 1,
        softCategory: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .toArray();

    const byId = new Map(docs.map((d: any) => [String(d._id), d]));
    return uniqueIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((doc: any) => ({
        ...this.normalizeImageFields(doc),
        _id: doc._id.toString(),
        score: 0.0001,
      })) as VectorSearchHit[];
  }

  async fetchProductsByCategories(categories: string[], limit = 50): Promise<VectorSearchHit[]> {
    const cats = Array.from(new Set((categories || []).map((c) => String(c).trim()).filter(Boolean)));
    if (cats.length === 0) return [];

    const docs = await this.collection
      .find({
        category: { $in: cats },
      })
      .project({
        _id: 1,
        merchantId: 1,
        name: 1,
        description: 1,
        price: 1,
        currency: 1,
        color: 1,
        country: 1,
        region: 1,
        grapes: 1,
        vintage: 1,
        sweetness: 1,
        kosher: 1,
        alcohol: 1,
        volume: 1,
        imageUrl: 1,
        image_url: 1,
        image: 1,
        images: 1,
        featuredImage: 1,
        featured_image: 1,
        thumbnail: 1,
        inStock: 1,
        stockCount: 1,
        rating: 1,
        reviewCount: 1,
        salesCount30d: 1,
        viewCount30d: 1,
        popularity: 1,
        category: 1,
        softCategory: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .limit(Math.max(1, Math.min(limit, 100)))
      .toArray();

    return docs.map((doc: any) => ({
      ...this.normalizeImageFields(doc),
      _id: doc._id.toString(),
      score: 0.0001,
    })) as VectorSearchHit[];
  }

  /**
   * Fallback to text search if vector search is not available
   * This allows the API to work even without vector index
   */
  private async fallbackTextSearch(
    merchantId: string,
    filters: ExtractedFilters,
    limit: number
  ): Promise<VectorSearchHit[]> {
    const preFilter = this.buildPreFilter(filters);
    const results = await this.collection
      .find(preFilter)
      .project({ embedding: 0 }) // Exclude embedding from results
      .limit(limit)
      .toArray();

    return results.map((doc) => ({
      ...this.normalizeImageFields(doc),
      _id: doc._id.toString(),
      score: 0.5, // Default score for fallback
    })) as VectorSearchHit[];
  }

  private normalizeImageFields(doc: any): any {
    const imageField =
      typeof doc?.image === "string" ? doc.image : doc?.image?.url || doc?.image?.src;
    const firstImage =
      imageField ||
      doc?.featuredImage?.url ||
      doc?.featuredImage?.src ||
      doc?.featured_image?.url ||
      doc?.featured_image?.src ||
      doc?.thumbnail ||
      (Array.isArray(doc?.images)
        ? typeof doc.images[0] === "string"
          ? doc.images[0]
          : doc.images[0]?.url || doc.images[0]?.src
        : undefined);

    return {
      ...doc,
      imageUrl: doc?.imageUrl || doc?.image_url || firstImage,
    };
  }

  private buildPreFilter(extractedFilters: ExtractedFilters): Record<string, any> {
    const preFilter: any = {};
    if (extractedFilters.countries && extractedFilters.countries.length > 0) {
      preFilter.country = { $in: extractedFilters.countries };
    }
    if (extractedFilters.grapes && extractedFilters.grapes.length > 0) {
      preFilter.grapes = { $in: extractedFilters.grapes };
    }
    if (extractedFilters.sweetness && extractedFilters.sweetness.length > 0) {
      preFilter.sweetness = { $in: extractedFilters.sweetness };
    }
    if (extractedFilters.category && extractedFilters.category.length > 0) {
      preFilter.category = { $in: extractedFilters.category };
    }
    if (extractedFilters.kosher !== undefined) {
      preFilter.kosher = extractedFilters.kosher;
    }
    if (extractedFilters.priceRange) {
      if (extractedFilters.priceRange.min) {
        preFilter.price = { ...preFilter.price, $gte: extractedFilters.priceRange.min };
      }
      if (extractedFilters.priceRange.max) {
        preFilter.price = { ...preFilter.price, $lte: extractedFilters.priceRange.max };
      }
    }
    if (extractedFilters.regions && extractedFilters.regions.length > 0) {
      preFilter.region = { $in: extractedFilters.regions };
    }
    return preFilter;
  }

  private buildTextQuery(query: string): Record<string, any> | null {
    const normalizedQuery = query
      .replace(/[\u0591-\u05C7]/g, "") // Remove Hebrew diacritics
      .replace(/ש?מתאי(?:ם|מה|מות|מים)?/g, " ")
      .replace(/ל?ארוח(?:ה|ות)/g, " אוכל ")
      .replace(/ל?מאכל(?:ים)?/g, " אוכל ")
      .replace(/איטלקי(?:ת|ות)/g, " איטלקי ")
      .replace(/ל?פיצ(?:ה|ות)/g, " פיצה ")
      .replace(/ל?דג(?:ים)?/g, " דגים ")
      .replace(/ל?גבינ(?:ה|ות)/g, " גבינות ")
      .replace(/ל?בשר/g, " בשר ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    const stopTerms = new Set([
      "ש",
      "של",
      "עם",
      "את",
      "על",
      "זה",
      "זאת",
      "for",
      "with",
      "and",
      "or",
      "the",
      "that",
      "this",
    ]);

    const synonymMap: Record<string, string[]> = {
      אוכל: ["אוכל", "ארוחה", "מנות", "מנה"],
      איטלקי: ["איטלקי", "איטליה", "italian", "italy"],
      צרפתי: ["צרפתי", "צרפת", "french", "france"],
      ישראלי: ["ישראלי", "ישראל", "israeli", "israel"],
      פיצה: ["פיצה", "pizza", "מנות איטלקיות"],
      דגים: ["דגים", "דג", "fish", "seafood", "פירות ים"],
      גבינות: ["גבינות", "גבינה", "cheese"],
      בשר: ["בשר", "meat", "beef", "steak"],
    };

    const terms = normalizedQuery
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t): t is string => Boolean(t) && t.length > 1 && !stopTerms.has(t));
    if (terms.length === 0) return null;

    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const perTerm = terms.map((term) => {
      const variants = Array.from(new Set([term, ...(synonymMap[term] || [])]));
      const re = new RegExp(variants.map(escape).join("|"), "i");
      return {
        $or: [
          { name: re },
          { description: re },
          { short_description: re },
          { category: re },
          { softCategory: re },
        ],
      };
    });

    if (perTerm.length === 1) return perTerm[0] as Record<string, any>;
    return { $and: perTerm };
  }

  /**
   * NOTE: We intentionally do not auto-add catalog-specific filters like `inStock`
   * unless the upstream request explicitly provides them. Some merchant catalogs
   * simply don't populate these fields consistently, which would lead to 0 results.
   */
}
