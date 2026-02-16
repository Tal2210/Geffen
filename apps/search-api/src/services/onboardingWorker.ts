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
    const discovery = await this.scraper.discover(job.websiteUrl);
    if (!discovery.robotsAllowed) {
      throw new Error(discovery.robotsReason || "robots_disallowed");
    }

    await this.progress(job.jobId, "extract", 26, "Extracting public products");
    const scraped = await this.scraper.extractProducts(discovery, job.category, 50);
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

    if (normalized.products.length === 0) {
      throw new Error("scrape_no_products");
    }

    await this.progress(job.jobId, "sample", 56, `Sampled ${normalized.products.length} products`);

    await this.progress(job.jobId, "embed", 72, "Generating embeddings");
    const withEmbeddings = await this.embedProducts(normalized.products);
    if (withEmbeddings.length === 0) {
      throw new Error("embedding_failed");
    }

    await this.progress(job.jobId, "index", 86, "Indexing demo products");

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

  private async embedProducts(products: Array<{
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
      ]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 4000);

      try {
        const embedding = await this.embeddingService.generateEmbedding(text);
        out.push({ ...product, embedding });
      } catch {
        // Skip failed rows; keep pipeline resilient.
      }
    }
    return out;
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
