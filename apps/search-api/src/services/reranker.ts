import type { VectorSearchHit } from "../types/index.js";

interface RerankingWeights {
  vectorScore: number;
  popularity: number;
  rating: number;
  inStock: number;
  freshness: number;
}

const DEFAULT_WEIGHTS: RerankingWeights = {
  vectorScore: 0.50, // 50% from semantic similarity
  popularity: 0.20, // 20% from sales/views
  rating: 0.15, // 15% from user ratings
  inStock: 0.10, // 10% stock availability boost
  freshness: 0.05, // 5% newer products get slight boost
};

/**
 * Rule-based reranking without LLM
 * Combines vector similarity with business signals
 */
export class Reranker {
  private weights: RerankingWeights;

  constructor(weights: RerankingWeights = DEFAULT_WEIGHTS) {
    this.weights = weights;
  }

  /**
   * Rerank search results using multiple signals
   */
  rerank(results: VectorSearchHit[], limit: number = 24): VectorSearchHit[] {
    if (results.length === 0) return [];

    // Normalize signals to 0-1 range
    const normalized = this.normalizeSignals(results);

    // Calculate composite score
    const reranked = normalized.map((product) => {
      const compositeScore =
        product.normalizedScore * this.weights.vectorScore +
        product.normalizedPopularity * this.weights.popularity +
        product.normalizedRating * this.weights.rating +
        product.stockBoost * this.weights.inStock +
        product.freshnessBoost * this.weights.freshness;

      return {
        ...product,
        finalScore: compositeScore,
      };
    });

    // Sort by composite score and return top results
    return reranked.sort((a, b) => b.finalScore - a.finalScore).slice(0, limit);
  }

  /**
   * Normalize all signals to 0-1 range for fair weighting
   */
  private normalizeSignals(results: VectorSearchHit[]) {
    // Find min/max for normalization
    const scores = results.map((r) => r.score);
    const popularities = results.map((r) => r.popularity || 0);
    const ratings = results.map((r) => r.rating || 0);
    const stockCounts = results.map((r) => r.stockCount || 0);
    const dates = results.map((r) =>
      r.createdAt ? new Date(r.createdAt).getTime() : Date.now()
    );

    const maxScore = Math.max(...scores, 1);
    const minScore = Math.min(...scores, 0);
    const maxPopularity = Math.max(...popularities, 1);
    const maxRating = 100; // Assuming 0-100 scale
    const maxStock = Math.max(...stockCounts, 1);
    const now = Date.now();
    const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;

    return results.map((product) => {
      // Normalize vector score
      const normalizedScore =
        maxScore === minScore ? 1 : (product.score - minScore) / (maxScore - minScore);

      // Normalize popularity (sales + views)
      const normalizedPopularity = (product.popularity || 0) / maxPopularity;

      // Normalize rating
      const normalizedRating = (product.rating || 0) / maxRating;

      // Stock boost (logarithmic to avoid over-emphasizing high stock)
      const stockBoost = Math.log((product.stockCount || 1) + 1) / Math.log(maxStock + 1);

      // Freshness boost (newer = higher)
      const productAge = product.createdAt ? new Date(product.createdAt).getTime() : now;
      const freshnessBoost = Math.max(0, (productAge - oneYearAgo) / (now - oneYearAgo));

      return {
        ...product,
        normalizedScore,
        normalizedPopularity,
        normalizedRating,
        stockBoost,
        freshnessBoost,
      } as any;
    });
  }

  /**
   * Apply business rules for specific scenarios
   */
  applyBusinessRules(results: VectorSearchHit[]): VectorSearchHit[] {
    return results.map((product) => {
      let boost = 1.0;

      // Boost products with high stock (avoid showing out-of-stock soon)
      if (product.stockCount && product.stockCount > 100) boost *= 1.1;
      if (product.stockCount && product.stockCount < 5) boost *= 0.8;

      // Boost highly rated products
      if (product.rating && product.rating > 80) boost *= 1.15;

      // Boost popular products
      if (product.salesCount30d && product.salesCount30d > 50) boost *= 1.1;

      const finalScore = (product as any).finalScore || product.score;

      return {
        ...product,
        finalScore: finalScore * boost,
      } as any;
    });
  }
}
