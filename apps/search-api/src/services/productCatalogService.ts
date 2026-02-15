import { MongoClient, type Collection, type Db } from "mongodb";
import type { Env } from "../types/index.js";

type CatalogProduct = {
  _id: string;
  name: string;
  description?: string;
  price: number;
  color?: string;
  country?: string;
  region?: string;
  grapes?: string[];
  vintage?: number;
  sweetness?: string;
  category?: string[] | string;
  softCategory?: string[] | string;
  inStock?: boolean;
  stockCount?: number;
  imageUrl?: string;
  image_url?: string;
  image?: { url?: string; src?: string } | string;
  images?: Array<{ url?: string; src?: string }>;
  featuredImage?: { url?: string; src?: string };
  featured_image?: { url?: string; src?: string };
  thumbnail?: string;
};

export class ProductCatalogService {
  private client: MongoClient;
  private db!: Db;
  private collection!: Collection<CatalogProduct>;

  constructor(private env: Env) {
    this.client = new MongoClient(env.MONGO_URI);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.env.MONGO_DB);
    this.collection = this.db.collection<CatalogProduct>(this.env.MONGO_COLLECTION);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async searchByName(query: string, limit = 20): Promise<Array<CatalogProduct & { _id: string }>> {
    const q = query.trim();
    if (!q) return [];

    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const terms = q.split(/\s+/).filter(Boolean);

    const orConditions = terms.map(t => ({
      $or: [
        { name: { $regex: escape(t), $options: "i" } },
        { description: { $regex: escape(t), $options: "i" } },
        { category: { $regex: escape(t), $options: "i" } }
      ]
    }));

    // Use OR so that matching any field works, and AND across terms for ranking quality
    const match = orConditions.length > 0
      ? { $and: orConditions }
      : {};

    const docs = await this.collection
      .find(match)
      .project({
        name: 1,
        description: 1,
        price: 1,
        color: 1,
        country: 1,
        region: 1,
        grapes: 1,
        vintage: 1,
        sweetness: 1,
        category: 1,
        softCategory: 1,
        inStock: 1,
        stockCount: 1,
        imageUrl: 1,
        image_url: 1,
        image: 1,
        images: 1,
        featuredImage: 1,
        featured_image: 1,
        thumbnail: 1,
      })
      .limit(Math.min(Math.max(limit, 1), 50))
      .toArray();

    const normalizedLimit = Math.min(Math.max(limit, 1), 50);
    const baseResults = docs.map((doc: any) => {
      const normalized = this.normalizeImageFields(doc);
      return {
        ...normalized,
        _id: String(doc._id),
      };
    });

    // Cross-script fallback (e.g. "pelter" <-> "פלטר") when regex-based retrieval misses.
    const shouldRunCrossScriptFallback = docs.length < normalizedLimit && /[A-Za-z\u0590-\u05FF]/.test(q);
    if (!shouldRunCrossScriptFallback) {
      return baseResults.slice(0, normalizedLimit);
    }

    const fallbackResults = await this.crossScriptFallbackSearch(q, normalizedLimit * 8, normalizedLimit);
    if (fallbackResults.length === 0) {
      return baseResults.slice(0, normalizedLimit);
    }

    const deduped = new Map<string, CatalogProduct & { _id: string }>();
    for (const product of [...baseResults, ...fallbackResults]) {
      deduped.set(String(product._id), product);
      if (deduped.size >= normalizedLimit) break;
    }
    return Array.from(deduped.values()).slice(0, normalizedLimit);
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

  private async crossScriptFallbackSearch(
    query: string,
    candidateLimit: number,
    resultLimit: number
  ): Promise<Array<CatalogProduct & { _id: string }>> {
    const candidates = await this.collection
      .find({})
      .project({
        name: 1,
        description: 1,
        price: 1,
        color: 1,
        country: 1,
        region: 1,
        grapes: 1,
        vintage: 1,
        sweetness: 1,
        category: 1,
        softCategory: 1,
        inStock: 1,
        stockCount: 1,
        imageUrl: 1,
        image_url: 1,
        image: 1,
        images: 1,
        featuredImage: 1,
        featured_image: 1,
        thumbnail: 1,
      })
      .limit(Math.min(Math.max(candidateLimit, 50), 800))
      .toArray();

    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];
    const queryKeyTokens = queryTokens.map((token) => this.toCrossScriptKey(token)).filter((token) => token.length >= 3);
    const normalizedQuery = this.normalizeForSearch(query);
    const queryKeyPhrase = this.toCrossScriptKey(query);

    const scored = candidates
      .map((doc) => {
        const haystack = [
          doc?.name,
          doc?.description,
          doc?.country,
          doc?.region,
          ...(Array.isArray(doc?.category) ? doc.category : [doc?.category]),
          ...(Array.isArray(doc?.softCategory) ? doc.softCategory : [doc?.softCategory]),
          ...(Array.isArray(doc?.grapes) ? doc.grapes : []),
        ]
          .filter((v): v is string => typeof v === "string")
          .join(" ");

        const normalizedHaystack = this.normalizeForSearch(haystack);
        if (!normalizedHaystack) return null;
        const keyHaystack = this.toCrossScriptKey(haystack);
        const candidateTokens = this.tokenize(haystack);
        const candidateKeyTokens = candidateTokens
          .map((token) => this.toCrossScriptKey(token))
          .filter((token) => token.length >= 3);

        let weightedHits = 0;
        for (const token of queryTokens) {
          if (token.length < 2) continue;
          const normalizedToken = this.normalizeForSearch(token);
          if (!normalizedToken) continue;
          let tokenScore = 0;
          if (candidateTokens.includes(normalizedToken) || normalizedHaystack.includes(normalizedToken)) {
            tokenScore = 1;
          }
          const tokenKey = this.toCrossScriptKey(token);
          if (tokenScore === 0 && tokenKey.length >= 3 && keyHaystack.includes(tokenKey)) {
            tokenScore = 0.85;
          }
          if (tokenScore === 0) {
            tokenScore = this.computeBestFuzzyTokenMatch(normalizedToken, candidateTokens);
          }
          if (tokenScore === 0 && tokenKey.length >= 3) {
            tokenScore = this.computeBestFuzzyTokenMatch(tokenKey, candidateKeyTokens, true);
          }

          weightedHits += tokenScore;
        }

        if (weightedHits <= 0) return null;

        const directPhraseBonus = normalizedQuery && normalizedHaystack.includes(normalizedQuery) ? 0.12 : 0;
        const keyPhraseBonus =
          queryKeyPhrase.length >= 3 && keyHaystack.includes(queryKeyPhrase) ? 0.18 : 0;
        const fuzzyPhraseBonus =
          normalizedQuery.length >= 4 &&
          this.computeBestFuzzyTokenMatch(
            normalizedQuery.replace(/\s+/g, ""),
            candidateTokens.map((t) => t.replace(/\s+/g, ""))
          ) >= 0.7
            ? 0.08
            : 0;
        const keyTermCoverage =
          queryKeyTokens.length > 0
            ? queryKeyTokens.filter((token) => keyHaystack.includes(token)).length / queryKeyTokens.length
            : 0;
        const score = Math.min(
          1,
          0.22 +
            (weightedHits / Math.max(1, queryTokens.length)) * 0.58 +
            keyTermCoverage * 0.1 +
            directPhraseBonus +
            keyPhraseBonus +
            fuzzyPhraseBonus
        );
        if (score < 0.4) return null;

        return {
          product: {
            ...this.normalizeImageFields(doc),
            _id: String((doc as any)._id),
          } as CatalogProduct & { _id: string },
          score,
        };
      })
      .filter((row): row is { product: CatalogProduct & { _id: string }; score: number } => Boolean(row))
      .sort((a, b) => b.score - a.score)
      .slice(0, resultLimit)
      .map((row) => row.product);

    return scored;
  }

  private tokenize(value: string): string[] {
    return this.normalizeForSearch(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1);
  }

  private normalizeForSearch(value: string): string {
    return String(value || "")
      .toLowerCase()
      .replace(/[\u0591-\u05C7]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private toCrossScriptKey(value: string): string {
    const normalized = this.normalizeForSearch(value);
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
    if (!term || term.length < 4 || candidates.length === 0) return 0;

    let best = 0;
    for (const rawCandidate of candidates) {
      const candidate = String(rawCandidate || "").trim();
      if (!candidate) continue;
      const maxLen = Math.max(term.length, candidate.length);
      const lenDiff = Math.abs(term.length - candidate.length);
      if ((strictLength && lenDiff > 2) || (!strictLength && lenDiff > 3)) continue;
      if (maxLen <= 1) continue;

      const ratio = this.levenshteinDistance(term, candidate) / maxLen;
      let score = 0;
      if (ratio <= 0.12) score = 0.9;
      else if (ratio <= 0.2) score = 0.78;
      else if (ratio <= 0.3) score = 0.64;
      else if (ratio <= 0.36) score = 0.52;

      if (score > best) best = score;
      if (best >= 0.9) break;
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
}
