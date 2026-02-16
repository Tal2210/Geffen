import type { ScrapedProduct } from "./types.js";

export class WooCommerceAdapter {
  private readonly browserLikeUserAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

  async extract(origin: string, limit = 50): Promise<ScrapedProduct[]> {
    const capped = Math.max(1, Math.min(limit, 50));
    const base = origin.replace(/\/$/, "");
    const endpoints = [
      `${base}/wp-json/wc/store/v1/products?per_page=${capped}`,
      `${base}/wp-json/wp/v2/product?per_page=${capped}`,
      `${base}/wp-json/wp/v2/product?per_page=${capped}&_embed=1`,
      `${base}/wp-json/wp/v2/products?per_page=${capped}`,
    ];

    for (const endpoint of endpoints) {
      const response = await fetch(endpoint, {
        headers: {
          "User-Agent": this.browserLikeUserAgent,
          Accept: "application/json, text/plain, */*",
        },
      }).catch(() => null);

      if (!response || !response.ok) continue;
      const rows = (await response.json().catch(() => [])) as Array<Record<string, any>>;
      if (!Array.isArray(rows) || rows.length === 0) continue;

      return rows.map((row) => {
        const images = Array.isArray(row?.images) ? row.images : [];
        const firstImage = images[0] || {};
        const prices = row?.prices || {};
        const rawPrice =
          prices?.price ||
          row?.price ||
          row?.regular_price ||
          row?.sale_price ||
          row?.min_price;
        const numericPrice = this.parsePriceLoose(String(rawPrice || ""));

        const titleObj = row?.title;
        const title =
          typeof titleObj === "string"
            ? titleObj
            : typeof titleObj?.rendered === "string"
              ? titleObj.rendered
              : "";
        const descObj = row?.description;
        const description =
          typeof descObj === "string"
            ? descObj
            : typeof descObj?.rendered === "string"
              ? descObj.rendered
              : "";

        return {
          name: String(title || row?.name || "").trim() || undefined,
          description: String(description || row?.short_description || "").trim() || undefined,
          price:
            Number.isFinite(Number(numericPrice))
              ? Number(numericPrice) / (Number(numericPrice) > 10000 ? 100 : 1)
              : undefined,
          currency: String(prices?.currency_code || row?.currency || "").trim() || undefined,
          imageUrl:
            String(firstImage?.src || firstImage?.thumbnail || row?.images?.[0]?.src || "").trim() ||
            undefined,
          productUrl: String(row?.permalink || row?.link || row?.slug || "").trim() || undefined,
          brand: String(row?.brand || row?.vendor || "").trim() || undefined,
          category:
            String(
              row?.categories?.[0]?.name || row?.type || row?.product_type || ""
            ).trim() || undefined,
          inStock:
            typeof row?.is_in_stock === "boolean"
              ? row.is_in_stock
              : typeof row?.stock_status === "string"
                ? row.stock_status === "instock"
                : undefined,
          source: "woocommerce",
          raw: {
            id: row?.id,
            type: row?.type,
          },
        } satisfies ScrapedProduct;
      });
    }

    return [];
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
