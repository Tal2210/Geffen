import type { ScrapedProduct } from "./types.js";

export class ShopifyAdapter {
  private readonly browserLikeUserAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

  async extract(origin: string, limit = 50): Promise<ScrapedProduct[]> {
    const capped = Math.max(1, Math.min(limit, 50));
    const base = origin.replace(/\/$/, "");
    const endpoints = [
      `${base}/products.json?limit=${capped}`,
      `${base}/collections/all/products.json?limit=${capped}`,
      `${base}/products.json?limit=${capped}&page=1`,
    ];
    const rows: Array<Record<string, any>> = [];
    const seenIds = new Set<string>();

    for (const endpoint of endpoints) {
      const response = await fetch(endpoint, {
        headers: {
          "User-Agent": this.browserLikeUserAgent,
          Accept: "application/json, text/plain, */*",
        },
      }).catch(() => null);
      if (!response || !response.ok) continue;
      const data = (await response.json().catch(() => ({}))) as {
        products?: Array<Record<string, any>>;
      };
      const part = Array.isArray(data.products) ? data.products : [];
      for (const row of part) {
        const id = String(row?.id || row?.handle || "");
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        rows.push(row);
      }
      if (rows.length >= capped) break;
    }

    if (rows.length === 0) return [];
    const products: ScrapedProduct[] = [];

    for (const row of rows.slice(0, capped)) {
      const variants = Array.isArray(row?.variants) ? row.variants : [];
      const firstVariant = variants[0] || {};
      const images = Array.isArray(row?.images) ? row.images : [];
      const firstImage = images[0] || {};

      const handle = String(row?.handle || "").trim();
      const productUrl = handle ? `${origin.replace(/\/$/, "")}/products/${handle}` : undefined;
      const priceValue = this.parsePriceLoose(String(firstVariant?.price ?? row?.price ?? ""));

      products.push({
        name: String(row?.title || "").trim() || undefined,
        description: String(row?.body_html || row?.description || "").trim() || undefined,
        price: Number.isFinite(Number(priceValue)) ? Number(priceValue) : undefined,
        currency: String(firstVariant?.currency || row?.currency || "").trim() || undefined,
        imageUrl:
          String(row?.image?.src || firstImage?.src || row?.featured_image || "").trim() || undefined,
        productUrl,
        brand: String(row?.vendor || "").trim() || undefined,
        category: String(row?.product_type || "").trim() || undefined,
        inStock: typeof firstVariant?.available === "boolean" ? firstVariant.available : undefined,
        source: "shopify",
        raw: {
          id: row?.id,
          handle: row?.handle,
          tags: row?.tags,
        },
      });
    }

    return products;
  }

  private parsePriceLoose(value: string): number | undefined {
    const raw = String(value || "").trim();
    if (!raw) return undefined;
    const normalized = raw.replace(/[^\d.,]/g, "");
    if (!normalized) return undefined;
    const hasDot = normalized.includes(".");
    const hasComma = normalized.includes(",");
    let canonical = normalized;
    if (hasDot && hasComma) {
      canonical =
        normalized.lastIndexOf(".") > normalized.lastIndexOf(",")
          ? normalized.replace(/,/g, "")
          : normalized.replace(/\./g, "").replace(",", ".");
    } else if (hasComma) {
      canonical = normalized.replace(",", ".");
    }
    const num = Number(canonical);
    if (!Number.isFinite(num) || num <= 0) return undefined;
    return num;
  }
}
