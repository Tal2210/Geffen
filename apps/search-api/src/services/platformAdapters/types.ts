export interface ScrapedProduct {
  name?: string;
  description?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productUrl?: string;
  brand?: string;
  category?: string;
  inStock?: boolean;
  source: "shopify" | "woocommerce" | "generic_static" | "browser_fallback";
  raw?: Record<string, unknown>;
}
