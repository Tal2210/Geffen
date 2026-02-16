import type { OnboardingCategory } from "../types/index.js";
import type {
  OnboardingAssistRuntimeTemplate,
  OnboardingAssistSelector,
} from "./onboardingService.js";
import { ShopifyAdapter } from "./platformAdapters/shopifyAdapter.js";
import { WooCommerceAdapter } from "./platformAdapters/woocommerceAdapter.js";
import type { ScrapedProduct } from "./platformAdapters/types.js";

export type ScraperPlatform = "shopify" | "woocommerce" | "generic";

export interface ScraperDiscovery {
  origin: string;
  normalizedUrl: string;
  platform: ScraperPlatform;
  robotsAllowed: boolean;
  robotsReason?: string;
  homepageHtml?: string;
}

export interface ScraperResult {
  products: ScrapedProduct[];
  platform: ScraperPlatform;
  sourceBreakdown: Record<string, number>;
  usedBrowserFallback: boolean;
}

export class ScraperOrchestratorService {
  private readonly shopifyAdapter = new ShopifyAdapter();
  private readonly wooAdapter = new WooCommerceAdapter();
  private readonly fetchTimeoutMs = 15_000;
  private readonly browserLikeUserAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

  async discover(websiteUrl: string): Promise<ScraperDiscovery> {
    const normalized = this.normalizeWebsiteUrl(websiteUrl);
    const url = new URL(normalized);
    const origin = url.origin;

    const robots = await this.checkRobots(origin);
    const homepageHtml = await this.fetchText(normalized).catch(() => "");
    const platform = this.detectPlatform(normalized, homepageHtml);

    return {
      origin,
      normalizedUrl: normalized,
      platform,
      robotsAllowed: robots.allowed,
      robotsReason: robots.reason,
      homepageHtml,
    };
  }

  async extractProducts(
    discovery: ScraperDiscovery,
    category: OnboardingCategory,
    limit = 50,
    assistTemplate?: OnboardingAssistRuntimeTemplate
  ): Promise<ScraperResult> {
    const capped = Math.max(1, Math.min(limit, 50));
    const sources: ScrapedProduct[] = [];

    if (discovery.platform === "shopify") {
      sources.push(...(await this.shopifyAdapter.extract(discovery.origin, capped)));
    }

    if (discovery.platform === "woocommerce") {
      sources.push(...(await this.wooAdapter.extract(discovery.origin, capped)));
    }

    // Generic extraction always runs as enrichment, not replacement.
    const genericProducts = await this.extractGenericStatic(discovery, category, capped);
    sources.push(...genericProducts);

    let usedBrowserFallback = false;
    if (sources.length < Math.min(20, capped)) {
      const browserProducts = await this.extractWithBrowserFallback(discovery.normalizedUrl, capped);
      if (browserProducts.length > 0) {
        usedBrowserFallback = true;
        sources.push(...browserProducts);
      }
    }

    if (assistTemplate && sources.length < Math.min(20, capped)) {
      const assisted = await this.extractWithAssistTemplate(discovery, assistTemplate, capped);
      if (assisted.length > 0) {
        sources.push(...assisted);
      }
    }

    const sourceBreakdown: Record<string, number> = {};
    for (const product of sources) {
      sourceBreakdown[product.source] = (sourceBreakdown[product.source] || 0) + 1;
    }

    return {
      products: sources,
      platform: discovery.platform,
      sourceBreakdown,
      usedBrowserFallback,
    };
  }

  private normalizeWebsiteUrl(rawUrl: string): string {
    const trimmed = String(rawUrl || "").trim();
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withProtocol);
    url.hash = "";
    return url.toString();
  }

  private detectPlatform(normalizedUrl: string, homepageHtml: string): ScraperPlatform {
    const lowerUrl = normalizedUrl.toLowerCase();
    const lowerHtml = String(homepageHtml || "").toLowerCase();

    if (
      lowerHtml.includes("cdn.shopify.com") ||
      lowerHtml.includes("shopify") ||
      lowerUrl.includes("myshopify.com")
    ) {
      return "shopify";
    }

    if (
      lowerHtml.includes("woocommerce") ||
      lowerHtml.includes("wp-content") ||
      lowerHtml.includes("wp-json/wc") ||
      lowerUrl.includes("/product/")
    ) {
      return "woocommerce";
    }

    return "generic";
  }

  private async checkRobots(origin: string): Promise<{ allowed: boolean; reason?: string }> {
    const robotsUrl = `${origin.replace(/\/$/, "")}/robots.txt`;
    const text = await this.fetchText(robotsUrl).catch(() => "");
    if (!text) {
      // Missing robots -> allow by default.
      return { allowed: true };
    }

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("#")[0]?.trim() || "");

    let inGlobalAgent = false;
    for (const line of lines) {
      const [directiveRaw, valueRaw] = line.split(":", 2);
      const directive = String(directiveRaw || "").trim().toLowerCase();
      const value = String(valueRaw || "").trim();
      if (!directive) continue;

      if (directive === "user-agent") {
        inGlobalAgent = value === "*";
        continue;
      }

      if (inGlobalAgent && directive === "disallow") {
        if (value === "/") {
          return {
            allowed: false,
            reason: "robots_disallowed",
          };
        }
      }
    }

    return { allowed: true };
  }

  private async extractGenericStatic(
    discovery: ScraperDiscovery,
    category: OnboardingCategory,
    limit: number
  ): Promise<ScrapedProduct[]> {
    const urls = [
      discovery.normalizedUrl,
      `${discovery.origin}/collections/all`,
      `${discovery.origin}/collections`,
      `${discovery.origin}/shop`,
      `${discovery.origin}/products`,
      `${discovery.origin}/products?page=1`,
      `${discovery.origin}/catalog`,
      `${discovery.origin}/collections/all?view=all`,
    ];

    const dedupedUrls = Array.from(new Set(urls));
    const out: ScrapedProduct[] = [];

    for (const url of dedupedUrls) {
      const html =
        url === discovery.normalizedUrl && discovery.homepageHtml
          ? discovery.homepageHtml
          : await this.fetchText(url).catch(() => "");
      if (!html) continue;

      out.push(...this.extractFromJsonLd(html, discovery.origin));
      out.push(...this.extractFromCardPatterns(html, discovery.origin, category));

      if (out.length >= limit * 2) break;
    }

    return out.slice(0, Math.max(limit * 2, 80));
  }

  private extractFromJsonLd(html: string, origin: string): ScrapedProduct[] {
    const blocks: string[] = [];
    const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(html))) {
      const payload = String(match[1] || "").trim();
      if (payload) blocks.push(payload);
    }

    const products: ScrapedProduct[] = [];
    for (const block of blocks) {
      try {
        const parsed = JSON.parse(block);
        const nodes = this.flattenJsonLdNodes(parsed);
        for (const node of nodes) {
          const type = String(node?.["@type"] || "").toLowerCase();
          if (!type.includes("product")) continue;

          const image = node?.image;
          const imageUrl = Array.isArray(image)
            ? String(image[0] || "")
            : typeof image === "object"
              ? String(image?.url || "")
              : String(image || "");

          const offer = Array.isArray(node?.offers) ? node.offers[0] : node?.offers;
          const productUrl = String(node?.url || node?.["@id"] || offer?.url || "").trim();
          const price = this.parsePriceLoose(
            String(
              offer?.price ||
                offer?.priceSpecification?.price ||
                node?.price ||
                ""
            )
          );

          products.push({
            name: String(node?.name || "").trim() || undefined,
            description: String(node?.description || "").trim() || undefined,
            price: Number.isFinite(price) ? price : undefined,
            currency: String(offer?.priceCurrency || node?.priceCurrency || "").trim() || undefined,
            imageUrl: this.toAbsoluteUrl(imageUrl, origin),
            productUrl: this.toAbsoluteUrl(productUrl, origin),
            brand:
              typeof node?.brand === "string"
                ? node.brand
                : String(node?.brand?.name || "").trim() || undefined,
            category: String(node?.category || "").trim() || undefined,
            inStock:
              typeof offer?.availability === "string"
                ? offer.availability.toLowerCase().includes("instock")
                : undefined,
            source: "generic_static",
            raw: {
              type: node?.["@type"],
            },
          });
        }
      } catch {
        // Ignore malformed json-ld blocks.
      }
    }

    return products;
  }

  private extractFromCardPatterns(
    html: string,
    origin: string,
    category: OnboardingCategory
  ): ScrapedProduct[] {
    const cards: ScrapedProduct[] = [];
    const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = anchorRegex.exec(html))) {
      const href = String(match[1] || "").trim();
      const body = String(match[2] || "");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
      if (!/product|shop|item|sku|store|\/p\//i.test(href)) continue;

      const titleMatch = body.match(/(?:<h[1-6][^>]*>|<span[^>]*class=["'][^"']*(?:title|name)[^"']*["'][^>]*>)([\s\S]*?)(?:<\/h[1-6]>|<\/span>)/i);
      const title =
        this.stripHtml(titleMatch?.[1] || "").trim() ||
        this.stripHtml(body).slice(0, 180).trim();
      const price =
        this.parsePriceLoose(this.stripHtml(body)) ??
        this.parsePriceLoose(
          body.match(/(?:data-price|price|amount|content)=["']([^"']+)["']/i)?.[1] || ""
        );
      const imageMatch = body.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);

      if (!title) continue;

      cards.push({
        name: title,
        price: Number.isFinite(Number(price)) ? Number(price) : undefined,
        currency: this.detectCurrencyFromHtml(body),
        imageUrl: this.toAbsoluteUrl(imageMatch?.[1] || "", origin),
        productUrl: this.toAbsoluteUrl(href, origin),
        category,
        source: "generic_static",
      });
    }

    return cards;
  }

  private async extractWithBrowserFallback(
    targetUrl: string,
    limit: number
  ): Promise<ScrapedProduct[]> {
    const importer = new Function("return import('playwright')") as () => Promise<any>;
    const playwright = await importer().catch(() => null);
    if (!playwright?.chromium) {
      return [];
    }

    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        userAgent: this.browserLikeUserAgent,
      });
      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: this.fetchTimeoutMs });
      await page.waitForTimeout(1200);

      const extracted = await page.evaluate((maxRows: number) => {
        const rows: Array<Record<string, unknown>> = [];
        const doc = (globalThis as any).document;
        if (!doc) {
          return rows;
        }

        const scripts = Array.from(
          doc.querySelectorAll('script[type="application/ld+json"]') || []
        ) as any[];
        for (const script of scripts) {
          const text = script.textContent || "";
          if (!text.trim()) continue;
          rows.push({ source: "jsonld", text });
        }

        const cards = Array.from(
          doc.querySelectorAll("a[href*='product'], a[href*='shop'], a[href*='item']") || []
        ) as any[];
        for (const anchor of cards.slice(0, maxRows * 3)) {
          const href = String(anchor?.href || "");
          const title =
            anchor?.querySelector?.("h1,h2,h3,h4,.title,.name")?.textContent ||
            anchor?.textContent ||
            "";
          const priceText = anchor?.textContent || "";
          const img = anchor?.querySelector?.("img");
          rows.push({
            source: "card",
            href,
            title,
            priceText,
            imageUrl: String(img?.src || ""),
          });
        }

        return rows;
      }, limit);

      const out: ScrapedProduct[] = [];
      for (const row of extracted || []) {
        const source = String((row as any)?.source || "");
        if (source === "jsonld") {
          const text = String((row as any)?.text || "");
          out.push(...this.extractFromJsonLd(`<script type=\"application/ld+json\">${text}</script>`, new URL(targetUrl).origin));
          continue;
        }

        const title = this.stripHtml(String((row as any)?.title || "")).trim();
        const href = String((row as any)?.href || "").trim();
        const priceText = String((row as any)?.priceText || "");
        const price = this.parsePriceLoose(priceText);
        if (!title || !href) continue;

        out.push({
          name: title,
          price: Number.isFinite(Number(price)) ? Number(price) : undefined,
          currency: this.detectCurrencyFromHtml(priceText),
          imageUrl: String((row as any)?.imageUrl || "") || undefined,
          productUrl: href,
          source: "browser_fallback",
        });
      }

      return out.slice(0, Math.max(limit * 2, 80));
    } catch {
      return [];
    } finally {
      await browser.close();
    }
  }

  private async extractWithAssistTemplate(
    discovery: ScraperDiscovery,
    template: OnboardingAssistRuntimeTemplate,
    limit: number
  ): Promise<ScrapedProduct[]> {
    const urls = await this.discoverProductUrls(discovery, template.sampleProductUrl, limit);
    if (!urls.length) return [];

    const out: ScrapedProduct[] = [];
    for (const url of urls) {
      const html = await this.fetchText(url).catch(() => "");
      if (!html) continue;

      const name = this.extractFieldByAssistSelector(html, template.selectors.name, "text");
      if (!name) continue;

      const description = template.selectors.description
        ? this.extractFieldByAssistSelector(html, template.selectors.description, "text")
        : undefined;
      const imageUrlRaw = template.selectors.image
        ? this.extractFieldByAssistSelector(html, template.selectors.image, "src")
        : "";
      const imageUrl = this.toAbsoluteUrl(imageUrlRaw || "", discovery.origin);

      const priceRaw = template.selectors.price
        ? this.extractFieldByAssistSelector(html, template.selectors.price, "text")
        : "";
      const price =
        this.parsePriceLoose(priceRaw || "") ??
        this.parsePriceLoose(
          html.match(/(?:price|amount|product:price:amount|data-price)=["']([^"']+)["']/i)?.[1] || ""
        );

      const stockRaw = template.selectors.inStock
        ? this.extractFieldByAssistSelector(html, template.selectors.inStock, "text")
        : "";
      const inStock = this.parseInStock(stockRaw || html);

      if (!name || (!price && !description && !imageUrl)) continue;

      out.push({
        name,
        description: description || undefined,
        price: Number.isFinite(Number(price)) ? Number(price) : undefined,
        currency: this.detectCurrencyFromHtml(html),
        imageUrl: imageUrl || undefined,
        productUrl: url,
        inStock,
        source: "generic_static",
      });

      if (out.length >= Math.max(limit * 2, 80)) break;
    }

    return out;
  }

  private async discoverProductUrls(
    discovery: ScraperDiscovery,
    sampleProductUrl: string,
    limit: number
  ): Promise<string[]> {
    const maxUrls = Math.max(limit * 3, 120);
    const urls = new Set<string>();
    const origin = discovery.origin;

    const tryAdd = (raw: string | undefined) => {
      const abs = this.toAbsoluteUrl(raw || "", origin);
      if (!abs) return;
      try {
        const parsed = new URL(abs);
        if (parsed.origin !== origin) return;
        if (!this.looksLikeProductUrl(parsed.toString())) return;
        urls.add(parsed.toString());
      } catch {
        // ignore invalid
      }
    };

    tryAdd(sampleProductUrl);

    const sitemap = await this.fetchText(`${origin.replace(/\/$/, "")}/sitemap.xml`).catch(() => "");
    if (sitemap) {
      const locRegex = /<loc>\s*([^<]+)\s*<\/loc>/gi;
      let match: RegExpExecArray | null;
      while ((match = locRegex.exec(sitemap))) {
        tryAdd(String(match[1] || ""));
        if (urls.size >= maxUrls) break;
      }
    }

    const candidatePages = [
      discovery.normalizedUrl,
      `${origin}/collections/all`,
      `${origin}/collections`,
      `${origin}/shop`,
      `${origin}/products`,
      `${origin}/catalog`,
    ];
    for (const pageUrl of candidatePages) {
      if (urls.size >= maxUrls) break;
      const html =
        pageUrl === discovery.normalizedUrl && discovery.homepageHtml
          ? discovery.homepageHtml
          : await this.fetchText(pageUrl).catch(() => "");
      if (!html) continue;

      const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
      let match: RegExpExecArray | null;
      while ((match = anchorRegex.exec(html))) {
        tryAdd(String(match[1] || ""));
        if (urls.size >= maxUrls) break;
      }
    }

    return Array.from(urls).slice(0, maxUrls);
  }

  private extractFieldByAssistSelector(
    html: string,
    selector: OnboardingAssistSelector,
    expectedMode: "text" | "src"
  ): string {
    const mode = selector.mode === "src" ? "src" : "text";
    const desired = expectedMode === "src" ? "src" : mode;
    const token = this.resolveCandidateSelector(selector.selector);
    if (!token) return "";
    const element = this.findElementBySimpleSelector(html, token);
    if (!element) return "";

    if (desired === "src") {
      const src = element.attributes.src || element.attributes["data-src"] || element.attributes.content;
      return String(src || "").trim();
    }

    const textFromAttr = element.attributes.content || element.attributes["aria-label"];
    const text = this.stripHtml(textFromAttr || element.innerHtml || "");
    return text.slice(0, 1500);
  }

  private resolveCandidateSelector(selector: string): string {
    const raw = String(selector || "").trim();
    if (!raw) return "";
    const tokens = raw.split(/[\s>+~]+/).filter(Boolean);
    const token = tokens[tokens.length - 1] || raw;
    return token.trim();
  }

  private findElementBySimpleSelector(
    html: string,
    selectorToken: string
  ): { tag: string; attributes: Record<string, string>; innerHtml: string } | null {
    const selector = String(selectorToken || "").trim();
    if (!selector) return null;

    const criteria = this.parseSimpleSelector(selector);
    if (!criteria) return null;

    const openTagRegex = /<([a-zA-Z0-9:-]+)([^>]*)>/g;
    let match: RegExpExecArray | null;
    while ((match = openTagRegex.exec(html))) {
      const tag = String(match[1] || "").toLowerCase();
      const attrsRaw = String(match[2] || "");
      if (!tag || ["script", "style", "noscript"].includes(tag)) continue;

      const attributes = this.parseAttributesFromTag(attrsRaw);
      if (!this.selectorMatches(tag, attributes, criteria)) continue;

      const start = match.index + match[0].length;
      const closeTag = `</${tag}>`;
      const end = html.indexOf(closeTag, start);
      const innerHtml = end >= 0 ? html.slice(start, end) : "";
      return { tag, attributes, innerHtml };
    }

    return null;
  }

  private parseSimpleSelector(selector: string): null | {
    tag?: string;
    id?: string;
    className?: string;
    attrName?: string;
    attrValue?: string;
  } {
    const value = String(selector || "").trim();
    if (!value) return null;

    if (value.startsWith("#")) {
      return { id: value.slice(1) };
    }
    if (value.startsWith(".")) {
      return { className: value.slice(1) };
    }

    const attrMatch = value.match(/^\[([a-zA-Z0-9:_-]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
    if (attrMatch) {
      return {
        attrName: String(attrMatch[1] || "").toLowerCase(),
        attrValue: attrMatch[2] ? String(attrMatch[2]) : undefined,
      };
    }

    const tagClassMatch = value.match(/^([a-zA-Z0-9:-]+)\.([a-zA-Z0-9_-]+)$/);
    if (tagClassMatch) {
      return {
        tag: String(tagClassMatch[1] || "").toLowerCase(),
        className: String(tagClassMatch[2] || ""),
      };
    }

    const tagMatch = value.match(/^([a-zA-Z0-9:-]+)$/);
    if (tagMatch) {
      return {
        tag: String(tagMatch[1] || "").toLowerCase(),
      };
    }

    return null;
  }

  private parseAttributesFromTag(attrsRaw: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const regex = /([:@a-zA-Z0-9_-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(attrsRaw))) {
      const key = String(match[1] || "").toLowerCase();
      if (!key) continue;
      const value = String(match[3] || match[4] || match[5] || "").trim();
      attrs[key] = value;
    }
    return attrs;
  }

  private selectorMatches(
    tag: string,
    attributes: Record<string, string>,
    criteria: { tag?: string; id?: string; className?: string; attrName?: string; attrValue?: string }
  ): boolean {
    if (criteria.tag && tag !== criteria.tag) return false;
    if (criteria.id) {
      const id = String(attributes.id || "");
      if (id !== criteria.id) return false;
    }
    if (criteria.className) {
      const classes = String(attributes.class || "")
        .split(/\s+/)
        .filter(Boolean);
      if (!classes.includes(criteria.className)) return false;
    }
    if (criteria.attrName) {
      const attr = attributes[criteria.attrName];
      if (typeof attr === "undefined") return false;
      if (typeof criteria.attrValue === "string" && attr !== criteria.attrValue) return false;
    }
    return true;
  }

  private looksLikeProductUrl(url: string): boolean {
    const value = String(url || "").toLowerCase();
    return /\/(product|products|item|items|shop|wine|wines|sku|p)\b/.test(value);
  }

  private parseInStock(value: string): boolean | undefined {
    const text = this.stripHtml(String(value || "")).toLowerCase();
    if (!text) return undefined;
    if (/(in stock|available|מלאי|זמין|instock)/.test(text)) return true;
    if (/(out of stock|sold out|אזל|חסר|לא זמין|outofstock)/.test(text)) return false;
    return undefined;
  }

  private flattenJsonLdNodes(value: any): Record<string, any>[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.flattenJsonLdNodes(item));
    }
    if (typeof value !== "object") return [];

    const graph = Array.isArray(value["@graph"]) ? value["@graph"] : null;
    if (graph) {
      return graph.flatMap((item: any) => this.flattenJsonLdNodes(item));
    }

    return [value as Record<string, any>];
  }

  private detectCurrencyFromHtml(value: string): string | undefined {
    if (!value) return undefined;
    if (value.includes("₪")) return "ILS";
    if (value.includes("$")) return "USD";
    if (value.includes("€")) return "EUR";
    if (value.includes("£")) return "GBP";
    return undefined;
  }

  private stripHtml(value: string): string {
    return String(value || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private parsePriceLoose(value: string): number | undefined {
    const raw = String(value || "").trim();
    if (!raw) return undefined;

    const normalized = raw
      .replace(/&nbsp;|&#160;|\u00a0/gi, " ")
      .replace(/[^\d.,\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return undefined;

    const match = normalized.match(/\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/);
    if (!match?.[0]) return undefined;
    const token = match[0].trim();

    const hasDot = token.includes(".");
    const hasComma = token.includes(",");
    let canonical = token;
    if (hasDot && hasComma) {
      if (token.lastIndexOf(".") > token.lastIndexOf(",")) {
        canonical = token.replace(/,/g, "");
      } else {
        canonical = token.replace(/\./g, "").replace(",", ".");
      }
    } else if (hasComma) {
      const commaParts = token.split(",");
      canonical =
        commaParts.length === 2 && (commaParts[1]?.length || 0) <= 2
          ? token.replace(",", ".")
          : token.replace(/,/g, "");
    } else {
      canonical = token.replace(/\s/g, "");
    }

    const num = Number(canonical);
    if (!Number.isFinite(num) || num <= 0) return undefined;
    return num;
  }

  private toAbsoluteUrl(value: string, origin: string): string | undefined {
    const raw = String(value || "").trim();
    if (!raw) return undefined;
    try {
      return new URL(raw, origin).toString();
    } catch {
      return undefined;
    }
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": this.browserLikeUserAgent,
          Accept: "text/html,application/json,text/plain,*/*",
        },
      });
      if (!response.ok) return "";
      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }
}
