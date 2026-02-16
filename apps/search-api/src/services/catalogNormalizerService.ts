import type { OnboardingCategory, OnboardingNormalizedProduct } from "../types/index.js";
import type { ScrapedProduct } from "./platformAdapters/types.js";

const CATEGORY_HINTS: Record<OnboardingCategory, string[]> = {
  fashion: ["fashion", "clothing", "dress", "shirt", "jeans", "אופנה", "בגד"],
  footwear: ["shoe", "sneaker", "boot", "sandal", "נעל", "הנעלה"],
  wine: ["wine", "winery", "יין", "יקב"],
  furniture: ["furniture", "chair", "table", "sofa", "רהיט", "ריהוט"],
  beauty: ["beauty", "skincare", "cosmetic", "איפור", "טיפוח"],
  electronics: ["electronics", "phone", "laptop", "tablet", "אלקטרוניקה"],
  jewelry: ["jewelry", "ring", "necklace", "bracelet", "תכשיט"],
  home_decor: ["decor", "home", "lamp", "vase", "דקור", "בית"],
  sports: ["sport", "fitness", "running", "gym", "ספורט"],
  pets: ["pet", "dog", "cat", "חתול", "כלב"],
  toys: ["toy", "game", "lego", "צעצוע"],
  kids: ["kids", "baby", "child", "ילדים"],
  food: ["food", "snack", "coffee", "תה", "מזון"],
  supplements: ["supplement", "vitamin", "protein", "תוסף"],
  books: ["book", "novel", "reader", "ספר"],
  automotive: ["car", "auto", "vehicle", "רכב"],
  garden: ["garden", "plant", "outdoor", "גינה"],
  travel: ["travel", "trip", "luggage", "נסיעות"],
  bags: ["bag", "backpack", "wallet", "תיק"],
  lingerie: ["lingerie", "underwear", "bra", "הלבשה תחתונה"],
};

export class CatalogNormalizerService {
  normalizeAndSample(
    products: ScrapedProduct[],
    category: OnboardingCategory,
    baseUrl: string,
    min = 30,
    target = 40,
    max = 50
  ): {
    products: OnboardingNormalizedProduct[];
    isPartial: boolean;
  } {
    const normalized = products
      .map((p) => this.normalizeProduct(p, category, baseUrl))
      .filter((p): p is OnboardingNormalizedProduct => Boolean(p));

    const deduped = this.dedupe(normalized);
    const ranked = this.rankByPriority(deduped, category);
    const capped = ranked.slice(0, Math.max(1, Math.min(max, 50)));

    let sampled = capped;
    if (capped.length > target) sampled = capped.slice(0, target);

    const isPartial = sampled.length > 0 && sampled.length < min;
    return {
      products: sampled,
      isPartial,
    };
  }

  private normalizeProduct(
    product: ScrapedProduct,
    category: OnboardingCategory,
    baseUrl: string
  ): OnboardingNormalizedProduct | null {
    const name = this.cleanText(product.name);
    if (!name) return null;

    const url =
      this.toAbsoluteUrl(product.productUrl, baseUrl) ||
      this.buildSyntheticProductUrl(baseUrl, name, product.brand);

    const price = Number(product.price);
    const normalizedPrice = Number.isFinite(price) && price > 0 ? price : 0;

    const description = this.cleanText(product.description, 1800);
    const imageUrl = this.toAbsoluteUrl(product.imageUrl, baseUrl);

    return {
      name,
      description: description || undefined,
      price: normalizedPrice,
      currency: this.cleanText(product.currency, 12) || undefined,
      imageUrl: imageUrl || undefined,
      productUrl: url,
      brand: this.cleanText(product.brand, 140) || undefined,
      category: this.cleanText(product.category, 140) || category,
      inStock: typeof product.inStock === "boolean" ? product.inStock : undefined,
      source: product.source,
      raw: product.raw,
    };
  }

  private dedupe(products: OnboardingNormalizedProduct[]): OnboardingNormalizedProduct[] {
    const byUrl = new Map<string, OnboardingNormalizedProduct>();
    const byNameBrand = new Map<string, OnboardingNormalizedProduct>();

    for (const product of products) {
      const urlKey = this.normalizeKey(product.productUrl);
      if (urlKey && !byUrl.has(urlKey)) {
        byUrl.set(urlKey, product);
        continue;
      }

      const nbKey = this.normalizeKey(`${product.name} ${product.brand || ""}`);
      if (nbKey && !byNameBrand.has(nbKey)) {
        byNameBrand.set(nbKey, product);
      }
    }

    return [...byUrl.values(), ...byNameBrand.values()];
  }

  private rankByPriority(
    products: OnboardingNormalizedProduct[],
    category: OnboardingCategory
  ): OnboardingNormalizedProduct[] {
    const hints = CATEGORY_HINTS[category] || [];
    const normalize = (v: string) =>
      v
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

    const scored = products.map((product) => {
      let score = 0;
      if (product.inStock === true) score += 3;
      if (product.imageUrl) score += 2;
      if (Number.isFinite(product.price) && product.price > 0) score += 2;
      if (product.description && product.description.length >= 40) score += 2;

      const haystack = normalize(
        `${product.name} ${product.brand || ""} ${product.category || ""} ${product.description || ""}`
      );
      const relevanceHits = hints.filter((hint) => haystack.includes(normalize(hint))).length;
      score += Math.min(3, relevanceHits * 0.8);

      return { product, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map((item) => item.product);
  }

  private cleanText(value: unknown, maxLength = 400): string {
    const text = String(value || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    return text.slice(0, maxLength);
  }

  private toAbsoluteUrl(value: unknown, baseUrl: string): string {
    const raw = String(value || "").trim();
    if (!raw) return "";

    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      return "";
    }
  }

  private normalizeKey(value: string): string {
    return String(value || "")
      .toLowerCase()
      .replace(/[?#].*$/, "")
      .replace(/[^\p{L}\p{N}\s/.-]/gu, "")
      .trim();
  }

  private buildSyntheticProductUrl(baseUrl: string, name: string, brand?: string): string {
    const slug = this.normalizeKey(`${name} ${brand || ""}`)
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 96);
    const safeSlug = slug || `product-${Date.now()}`;
    return `${baseUrl.replace(/\/$/, "")}/onboarding-product/${safeSlug}`;
  }
}
