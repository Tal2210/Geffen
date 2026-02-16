import type { ScrapedProduct } from "./types.js";

export class ShopifyAdapter {
  async extract(origin: string, limit = 50): Promise<ScrapedProduct[]> {
    const capped = Math.max(1, Math.min(limit, 50));
    const endpoint = `${origin.replace(/\/$/, "")}/products.json?limit=${capped}`;
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "Geffen-Onboarding-Bot/1.0",
        Accept: "application/json, text/plain, */*",
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json().catch(() => ({}))) as {
      products?: Array<Record<string, any>>;
    };

    const rows = Array.isArray(data.products) ? data.products : [];
    const products: ScrapedProduct[] = [];

    for (const row of rows) {
      const variants = Array.isArray(row?.variants) ? row.variants : [];
      const firstVariant = variants[0] || {};
      const images = Array.isArray(row?.images) ? row.images : [];
      const firstImage = images[0] || {};

      const handle = String(row?.handle || "").trim();
      const productUrl = handle ? `${origin.replace(/\/$/, "")}/products/${handle}` : undefined;
      const priceValue = Number(firstVariant?.price ?? row?.price ?? NaN);

      products.push({
        name: String(row?.title || "").trim() || undefined,
        description: String(row?.body_html || row?.description || "").trim() || undefined,
        price: Number.isFinite(priceValue) ? priceValue : undefined,
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
}
