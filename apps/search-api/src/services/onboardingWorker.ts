import type { Env, OnboardingCategory, OnboardingJobProgress } from "../types/index.js";
import { EmbeddingService } from "./embeddingService.js";
import { CatalogNormalizerService } from "./catalogNormalizerService.js";
import { ScraperOrchestratorService } from "./scraperOrchestratorService.js";
import { OnboardingService } from "./onboardingService.js";

export class OnboardingWorker {
  private readonly embeddingService: EmbeddingService;
  private readonly scraper: ScraperOrchestratorService;
  private readonly normalizer: CatalogNormalizerService;
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private loopActive = false;

  private readonly pollMs = 2500;
  private readonly totalJobTimeoutMs = 6 * 60 * 1000;

  constructor(private env: Env, private onboardingService: OnboardingService) {
    this.embeddingService = new EmbeddingService(env);
    this.scraper = new ScraperOrchestratorService();
    this.normalizer = new CatalogNormalizerService();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.interval = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getHealth(): { running: boolean; loopActive: boolean; timestamp: string } {
    return {
      running: this.running,
      loopActive: this.loopActive,
      timestamp: new Date().toISOString(),
    };
  }

  private async tick(): Promise<void> {
    if (!this.running || this.loopActive) return;
    this.loopActive = true;

    try {
      const job = await this.onboardingService.claimNextJob();
      if (!job) return;

      await this.processWithTimeout(job.jobId, async () => {
        await this.processJob({
          jobId: job.jobId,
          websiteUrl: job.websiteUrl,
          email: job.email,
          category: job.category,
        });
      });
    } catch {
      // Keep worker alive.
    } finally {
      this.loopActive = false;
    }
  }

  private async processWithTimeout(jobId: string, fn: () => Promise<void>): Promise<void> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("job_timeout")), this.totalJobTimeoutMs);
    });

    await Promise.race([fn(), timeoutPromise]).catch(async (error) => {
      const code = this.toErrorCode(error);
      const message = error instanceof Error ? error.message : String(error || "Job failed");
      await this.onboardingService.markJobFailed(jobId, code, message);
    });
  }

  private async processJob(job: {
    jobId: string;
    websiteUrl: string;
    email: string;
    category: OnboardingCategory;
  }): Promise<void> {
    await this.progress(job.jobId, "discover", 12, "Checking robots and detecting platform");
    await this.onboardingService.updateJobCounters(job.jobId, {
      extracted: 0,
      normalized: 0,
      embedded: 0,
      indexed: 0,
    });
    const discovery = await this.scraper.discover(job.websiteUrl);
    if (!discovery.robotsAllowed) {
      throw new Error(discovery.robotsReason || "robots_disallowed");
    }

    const assistTemplate = await this.onboardingService
      .getAssistTemplateForWebsite(job.websiteUrl)
      .catch(() => null);

    await this.progress(job.jobId, "extract", 26, "Extracting public products");
    const scraped = await this.scraper.extractProducts(
      discovery,
      job.category,
      50,
      assistTemplate || undefined
    );
    if (assistTemplate?.sampleProductUrl) {
      const sample = await this.scraper
        .extractSingleProductByTemplate(discovery, assistTemplate.sampleProductUrl, assistTemplate)
        .catch(() => null);
      if (sample?.sampleProduct?.name) {
        const sampleSeed = {
          name: sample.sampleProduct.name,
          description: sample.sampleProduct.description,
          price: Number(sample.sampleProduct.price || 0) || undefined,
          currency: sample.sampleProduct.currency,
          imageUrl: sample.sampleProduct.imageUrl,
          productUrl: assistTemplate.sampleProductUrl,
          inStock: sample.sampleProduct.inStock,
          source: "generic_static" as const,
          raw: {
            attributes: sample.sampleProduct.attributes || {},
            isGuideSeed: true,
          },
        };
        scraped.products.unshift(sampleSeed);
      }
    }
    await this.onboardingService.updateJobCounters(job.jobId, {
      extracted: scraped.products.length,
    });
    if (scraped.products.length === 0) {
      throw new Error("scrape_no_products");
    }

    await this.progress(job.jobId, "normalize", 44, "Normalizing catalog fields");
    const normalized = this.normalizer.normalizeAndSample(
      scraped.products,
      job.category,
      discovery.origin,
      30,
      40,
      50
    );
    const normalizedForSearch = normalized.products.map((product) =>
      this.enrichProductForSearch(product, job.category)
    );
    await this.onboardingService.updateJobCounters(job.jobId, {
      normalized: normalizedForSearch.length,
    });

    if (normalizedForSearch.length === 0) {
      throw new Error("scrape_no_products");
    }

    await this.onboardingService.setJobLivePreview(
      job.jobId,
      normalizedForSearch.slice(0, 12).map((item, idx) => ({
        _id: `preview-${idx}`,
        demoId: "",
        jobId: job.jobId,
        merchantId: `onboarding-preview:${job.jobId}`,
        name: item.name,
        description: item.description,
        price: item.price,
        currency: item.currency,
        imageUrl: item.imageUrl,
        productUrl: item.productUrl,
        brand: item.brand,
        category: item.category,
        inStock: item.inStock,
        source: item.source,
        raw: item.raw,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      }))
    );

    await this.progress(job.jobId, "sample", 56, `Sampled ${normalizedForSearch.length} products`);

    await this.progress(job.jobId, "embed", 72, "Generating embeddings");
    const withEmbeddings = await this.embedProducts(job.jobId, normalizedForSearch);
    await this.onboardingService.updateJobCounters(job.jobId, {
      embedded: withEmbeddings.length,
    });
    await this.onboardingService.setJobLivePreview(
      job.jobId,
      withEmbeddings.slice(0, 12).map((item, idx) => ({
        _id: `embedded-${idx}`,
        demoId: "",
        jobId: job.jobId,
        merchantId: `onboarding-preview:${job.jobId}`,
        name: item.name,
        description: item.description,
        price: item.price,
        currency: item.currency,
        imageUrl: item.imageUrl,
        productUrl: item.productUrl,
        brand: item.brand,
        category: item.category,
        inStock: item.inStock,
        source: item.source,
        raw: item.raw,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      }))
    );
    if (withEmbeddings.length === 0) {
      throw new Error("embedding_failed");
    }

    await this.progress(job.jobId, "index", 86, "Indexing demo products");
    await this.onboardingService.updateJobCounters(job.jobId, {
      indexed: withEmbeddings.length,
    });

    await this.progress(job.jobId, "finalize", 94, "Preparing demo URL");
    const partial = normalized.isPartial || withEmbeddings.length < 30;
    await this.onboardingService.finalizeJobSuccess({
      jobId: job.jobId,
      websiteUrl: job.websiteUrl,
      email: job.email,
      category: job.category,
      products: withEmbeddings,
      partial,
    });
  }

  private async embedProducts(jobId: string, products: Array<{
    name: string;
    description?: string;
    brand?: string;
    category?: string;
    price: number;
    currency?: string;
    imageUrl?: string;
    productUrl: string;
    inStock?: boolean;
    source: "shopify" | "woocommerce" | "generic_static" | "browser_fallback";
    raw?: Record<string, unknown>;
  }>): Promise<Array<{
    name: string;
    description?: string;
    brand?: string;
    category?: string;
    price: number;
    currency?: string;
    imageUrl?: string;
    productUrl: string;
    inStock?: boolean;
    source: "shopify" | "woocommerce" | "generic_static" | "browser_fallback";
    raw?: Record<string, unknown>;
    embedding: number[];
  }>> {
    const out: Array<any> = [];
    for (const product of products) {
      const text = [
        product.name,
        product.brand,
        product.category,
        product.description,
        product.raw?.softCategories
          ? (product.raw.softCategories as unknown[])
              .map((value) => String(value || "").trim())
              .filter(Boolean)
              .join(" | ")
          : "",
        product.raw?.attributes
          ? Object.entries(product.raw.attributes as Record<string, unknown>)
              .map(([k, v]) => `${k}: ${String(v || "")}`)
              .join(" | ")
          : "",
      ]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 4000);

      try {
        const embedding = await this.embeddingService.generateEmbedding(text);
        out.push({ ...product, embedding });
        await this.onboardingService.updateJobCounters(jobId, {
          embedded: out.length,
        });
      } catch {
        // Skip failed rows; keep pipeline resilient.
      }
    }
    return out;
  }

  private enrichProductForSearch(
    product: {
      name: string;
      description?: string;
      brand?: string;
      category?: string;
      price: number;
      currency?: string;
      imageUrl?: string;
      productUrl: string;
      inStock?: boolean;
      source: "shopify" | "woocommerce" | "generic_static" | "browser_fallback";
      raw?: Record<string, unknown>;
    },
    category: OnboardingCategory
  ) {
    if (category !== "wine") {
      return product;
    }

    const attributes =
      product.raw && typeof product.raw.attributes === "object" && product.raw.attributes
        ? ({ ...(product.raw.attributes as Record<string, unknown>) } as Record<string, unknown>)
        : {};

    const softCategories = this.deriveWineSoftCategories(
      [product.name, product.brand || "", product.description || "", String(attributes.pairing || "")].join(" | ")
    );

    if (softCategories.length === 0) {
      return product;
    }

    attributes.soft_categories = softCategories.join(" | ");
    const raw: Record<string, unknown> = {
      ...(product.raw || {}),
      attributes,
      softCategories,
    };

    return {
      ...product,
      raw,
    };
  }

  private deriveWineSoftCategories(text: string): string[] {
    const source = String(text || "").toLowerCase();
    if (!source.trim()) return [];

    const tags = new Set<string>();
    const add = (values: string[]) => {
      for (const value of values) {
        const clean = String(value || "").trim().toLowerCase();
        if (clean) tags.add(clean);
      }
    };

    if (/(fish|seafood|דג|דגים|פירות ים|סושי)/.test(source)) {
      add(["fish", "seafood", "pairing_fish", "דגים"]);
    }
    if (/(pizza|pasta|italian|איטלק|פיצה|פסטה)/.test(source)) {
      add(["italian_food", "pairing_italian", "pizza", "pasta", "איטלקי"]);
    }
    if (/(meat|steak|bbq|grill|בשר|סטייק|על האש|גריל)/.test(source)) {
      add(["meat", "bbq", "pairing_meat", "בשר"]);
    }
    if (/(crispy|crisp|fresh|zesty|acid|acidity|רענן|קריספי|חומצי|חומציות)/.test(source)) {
      add(["crisp", "fresh", "high_acidity", "רענן", "קריספי"]);
    }
    if (/(full[-\s]?bod|rich|bold|intense|גוף מלא|עשיר|עוצמתי)/.test(source)) {
      add(["full_body", "rich", "bold", "גוף מלא"]);
    }
    if (/(light[-\s]?bod|easy[-\s]?drinking|קליל|גוף קל)/.test(source)) {
      add(["light_body", "easy_drinking", "קליל"]);
    }
    if (/(dry|יבש)/.test(source)) {
      add(["dry", "יבש"]);
    }
    if (/(semi[-\s]?dry|off[-\s]?dry|חצי יבש)/.test(source)) {
      add(["semi_dry", "חצי יבש"]);
    }
    if (/(sweet|dessert|מתוק|קינוח)/.test(source)) {
      add(["sweet", "dessert_wine", "מתוק"]);
    }
    if (/(ros[eé]|רוזה)/.test(source)) {
      add(["rose", "רוזה"]);
    }
    if (/(sparkling|bubbles|מבעבע|בועות)/.test(source)) {
      add(["sparkling", "בועות"]);
    }
    if (/(kosher|כשר)/.test(source)) {
      add(["kosher", "כשר"]);
    }
    if (
      /(germany|austria|sweden|denmark|netherlands|belgium|scandinav|גרמניה|אוסטריה|סקנדינביה)/.test(
        source
      )
    ) {
      add(["north_europe", "צפון אירופה"]);
    }

    return Array.from(tags).slice(0, 30);
  }

  private async progress(
    jobId: string,
    step: OnboardingJobProgress["step"],
    percent: number,
    message: string
  ): Promise<void> {
    await this.onboardingService.updateJobProgress(jobId, {
      step,
      percent,
      message,
    });
  }

  private toErrorCode(error: unknown): string {
    const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
    if (message.includes("robots_disallowed")) return "robots_disallowed";
    if (message.includes("invalid_url")) return "invalid_url";
    if (message.includes("embedding")) return "embedding_failed";
    if (message.includes("timeout") || message.includes("job_timeout")) return "job_timeout";
    if (message.includes("rate_limit_exceeded")) return "rate_limit_exceeded";
    if (message.includes("unsupported_platform")) return "unsupported_platform";
    if (message.includes("scrape_no_products")) return "scrape_no_products";
    if (message.includes("scrape_partial_products")) return "scrape_partial_products";
    return "index_failed";
  }
}
