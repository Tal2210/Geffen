import { MongoClient, type Collection, type Db } from "mongodb";
import type {
  Env,
  OnboardingDemoSearchResult,
  OnboardingIndexedProduct,
} from "../types/index.js";
import { EmbeddingService } from "./embeddingService.js";

type OnboardingProductDoc = Omit<OnboardingIndexedProduct, "_id"> & {
  _id: any;
};

export class OnboardingSearchService {
  private client: MongoClient;
  private db!: Db;
  private products!: Collection<OnboardingProductDoc>;
  private embeddingService: EmbeddingService;
  private readonly vectorIndex = "onboarding_vector_index";

  constructor(private env: Env) {
    this.client = new MongoClient(env.MONGO_URI);
    this.embeddingService = new EmbeddingService(env);
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
    offset = 0
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
    const normalizedQuery = this.normalizeForTextSearch(query);
    const terms = normalizedQuery
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1);

    const textStart = Date.now();
    const textCandidates = await this.textSearch(demoId, terms, Math.max(cappedLimit * 3, 60));
    timings.textSearch = Date.now() - textStart;

    const useTextOnly = this.isTextStrongEnough(textCandidates, cappedLimit);

    let vectorCandidates: OnboardingIndexedProduct[] = [];
    let vectorStatus: "ok" | "empty" | "embedding_failed" | "vector_failed" = useTextOnly
      ? "empty"
      : "vector_failed";

    if (!useTextOnly) {
      const embedStart = Date.now();
      const embeddingResult = await Promise.resolve(
        this.embeddingService.generateEmbedding(query)
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
    }

    const mergeStart = Date.now();
    const merged = useTextOnly
      ? this.mergeHybridCandidates([], textCandidates)
      : this.mergeHybridCandidates(vectorCandidates, textCandidates);
    timings.merge = Date.now() - mergeStart;

    timings.total = Date.now() - startTotal;

    const paginated = merged.slice(offset, offset + cappedLimit);

    return {
      products: paginated,
      metadata: {
        query,
        totalResults: merged.length,
        returnedCount: paginated.length,
        retrieval: {
          vectorCandidates: vectorCandidates.length,
          textCandidates: textCandidates.length,
          mergedCandidates: merged.length,
          mode: useTextOnly ? "text_only" : "hybrid",
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
    textResults: OnboardingIndexedProduct[]
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

        let retrievalScore = semanticScore * 0.74 + textScore * 0.26;
        if (hasSemantic && hasText) retrievalScore += 0.07;
        if (!hasSemantic && hasText) retrievalScore = 0.22 + textScore * 0.55;
        if (hasSemantic && !hasText) retrievalScore = Math.max(retrievalScore, semanticScore * 0.72);

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
    const candidate = this.normalizeForTextSearch(
      [
        product.name,
        product.description || "",
        product.brand || "",
        product.category || "",
        this.attributesText(product.raw?.attributes as Record<string, unknown> | undefined),
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
