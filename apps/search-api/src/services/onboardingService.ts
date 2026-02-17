import crypto from "node:crypto";
import { MongoClient, type Collection, type Db, type WithId } from "mongodb";
import type {
  Env,
  OnboardingAssistCustomField,
  OnboardingAssistExtractSampleResult,
  OnboardingAssistSelector,
  OnboardingAssistTemplatePayload,
  OnboardingAssistRuntimeTemplate,
  OnboardingCategory,
  OnboardingDemoResponse,
  OnboardingDemoSearchResult,
  OnboardingIndexedProduct,
  OnboardingJobCounters,
  OnboardingJobLiveResponse,
  OnboardingJobProgress,
  OnboardingJobStatus,
  OnboardingJobStatusResponse,
  OnboardingNormalizedProduct,
  OnboardingSampleProduct,
  OnboardingStartRequest,
  OnboardingStartResponse,
  OnboardingTrackEvent,
} from "../types/index.js";
import { OnboardingSearchService } from "./onboardingSearchService.js";
import { ScraperOrchestratorService } from "./scraperOrchestratorService.js";

interface OnboardingJobDoc {
  jobId: string;
  websiteUrl: string;
  domain: string;
  email: string;
  category: OnboardingCategory;
  status: OnboardingJobStatus;
  progress: OnboardingJobProgress;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ip?: string;
  userAgent?: string;
  demoId?: string;
  demoToken?: string;
  productCount?: number;
  startedAt?: string;
  finishedAt?: string;
  counts?: OnboardingJobCounters;
}

interface OnboardingDemoDoc {
  demoId: string;
  jobId: string;
  websiteUrl: string;
  category: OnboardingCategory;
  email: string;
  productCount: number;
  tokenHash: string;
  tokenExp: string;
  status: "ready" | "partial_ready";
  createdAt: string;
  expiresAt: string;
}

interface OnboardingProductDoc extends Omit<OnboardingIndexedProduct, "_id"> {
  _id?: any;
  attributesText?: string;
}

interface OnboardingTrackDoc {
  eventId: string;
  event: string;
  jobId?: string;
  demoId?: string;
  websiteUrl?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  createdAt: string;
  expiresAt: string;
}

interface OnboardingAssistTemplateDoc {
  domain: string;
  websiteUrl: string;
  sampleProductUrl: string;
  category?: OnboardingCategory;
  selectors: {
    name: OnboardingAssistSelector;
    price?: OnboardingAssistSelector;
    image?: OnboardingAssistSelector;
    description?: OnboardingAssistSelector;
    inStock?: OnboardingAssistSelector;
  };
  customFields?: OnboardingAssistCustomField[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface OnboardingJobPreviewDoc {
  jobId: string;
  products: OnboardingIndexedProduct[];
  updatedAt: string;
  expiresAt: string;
}

export class OnboardingService {
  private client: MongoClient;
  private db!: Db;
  private jobs!: Collection<OnboardingJobDoc>;
  private demos!: Collection<OnboardingDemoDoc>;
  private products!: Collection<OnboardingProductDoc>;
  private track!: Collection<OnboardingTrackDoc>;
  private templates!: Collection<OnboardingAssistTemplateDoc>;
  private jobPreviews!: Collection<OnboardingJobPreviewDoc>;
  private searchService: OnboardingSearchService;
  private scraperService: ScraperOrchestratorService;

  private readonly tokenSecret: string;
  private readonly demoTtlDays: number;

  private readonly ipWindowMap = new Map<string, { count: number; resetAt: number }>();
  private readonly domainCooldownMap = new Map<string, number>();
  private readonly ipWindowMs = 10 * 60 * 1000;
  private readonly ipWindowLimit = 8;
  private readonly domainCooldownMs = 10 * 60 * 1000;

  constructor(private env: Env) {
    this.client = new MongoClient(env.MONGO_URI);
    this.searchService = new OnboardingSearchService(env);
    this.scraperService = new ScraperOrchestratorService();
    this.demoTtlDays = env.ONBOARDING_DEMO_TTL_DAYS || 14;
    this.tokenSecret = env.ONBOARDING_TOKEN_SECRET || "dev-onboarding-token-secret";
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.searchService.connect();

    this.db = this.client.db(this.env.MONGO_DB);
    this.jobs = this.db.collection<OnboardingJobDoc>("onboarding.jobs");
    this.demos = this.db.collection<OnboardingDemoDoc>("onboarding.demos");
    this.products = this.db.collection<OnboardingProductDoc>("onboarding.products");
    this.track = this.db.collection<OnboardingTrackDoc>("onboarding.track");
    this.templates = this.db.collection<OnboardingAssistTemplateDoc>("onboarding.templates");
    this.jobPreviews = this.db.collection<OnboardingJobPreviewDoc>("onboarding.job_previews");

    await this.ensureIndexes();
  }

  async close(): Promise<void> {
    await this.searchService.close();
    await this.client.close();
  }

  listCategories(): Array<{ value: OnboardingCategory; label: string }> {
    return [
      { value: "fashion", label: "Fashion" },
      { value: "footwear", label: "Footwear" },
      { value: "wine", label: "Wine" },
      { value: "furniture", label: "Furniture" },
      { value: "beauty", label: "Beauty" },
      { value: "electronics", label: "Electronics" },
      { value: "jewelry", label: "Jewelry" },
      { value: "home_decor", label: "Home Decor" },
      { value: "sports", label: "Sports" },
      { value: "pets", label: "Pets" },
      { value: "toys", label: "Toys" },
      { value: "kids", label: "Kids" },
      { value: "food", label: "Food" },
      { value: "supplements", label: "Supplements" },
      { value: "books", label: "Books" },
      { value: "automotive", label: "Automotive" },
      { value: "garden", label: "Garden" },
      { value: "travel", label: "Travel" },
      { value: "bags", label: "Bags" },
      { value: "lingerie", label: "Lingerie" },
    ];
  }

  listCategoryPresetFields(category: OnboardingCategory): Array<{ key: string; label: string }> {
    return this.scraperService.getCategoryPresetFields(category);
  }

  async startJob(
    input: OnboardingStartRequest,
    context: { ip?: string; userAgent?: string }
  ): Promise<OnboardingStartResponse> {
    const websiteUrl = this.normalizeWebsiteUrl(input.websiteUrl);
    const domain = new URL(websiteUrl).hostname.toLowerCase();

    this.assertPublicUrlSafe(websiteUrl);
    this.enforceAbuseGuard(domain, context.ip);

    const now = new Date();
    const expiresAt = this.makeExpiry(now, this.demoTtlDays);
    const jobId = crypto.randomUUID();

    const jobDoc: OnboardingJobDoc = {
      jobId,
      websiteUrl,
      domain,
      email: input.email.toLowerCase().trim(),
      category: input.category,
      status: "queued",
      progress: {
        step: "queued",
        percent: 3,
        message: "Job queued",
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt,
      ip: context.ip,
      userAgent: context.userAgent,
      counts: this.emptyCounters(),
    };

    await this.jobs.insertOne(jobDoc);

    return {
      jobId,
      status: "queued",
      pollUrl: `/onboarding/jobs/${jobId}`,
      createdAt: jobDoc.createdAt,
    };
  }

  async getJobStatus(jobId: string): Promise<OnboardingJobStatusResponse | null> {
    const doc = await this.jobs.findOne({ jobId: String(jobId || "") });
    if (!doc) return null;
    return this.toJobStatusResponse(doc);
  }

  async claimNextJob(): Promise<OnboardingJobStatusResponse | null> {
    const now = new Date().toISOString();
    const claimed = await this.jobs.findOneAndUpdate(
      { status: "queued" },
      {
        $set: {
          status: "running",
          startedAt: now,
          updatedAt: now,
          progress: {
            step: "discover",
            percent: 8,
            message: "Discovering platform",
          },
          counts: this.emptyCounters(),
        },
      },
      { sort: { createdAt: 1 }, returnDocument: "after" }
    );

    if (!claimed) return null;
    return this.toJobStatusResponse(claimed);
  }

  async updateJobProgress(jobId: string, progress: OnboardingJobProgress): Promise<void> {
    await this.jobs.updateOne(
      { jobId },
      {
        $set: {
          progress,
          updatedAt: new Date().toISOString(),
        },
      }
    );
  }

  async updateJobCounters(jobId: string, delta: Partial<OnboardingJobCounters>): Promise<void> {
    const current = await this.jobs.findOne(
      { jobId },
      { projection: { counts: 1 } }
    );
    const base = current?.counts || this.emptyCounters();
    const next: OnboardingJobCounters = {
      extracted: Math.max(0, Number(delta.extracted ?? base.extracted ?? 0)),
      normalized: Math.max(0, Number(delta.normalized ?? base.normalized ?? 0)),
      embedded: Math.max(0, Number(delta.embedded ?? base.embedded ?? 0)),
      indexed: Math.max(0, Number(delta.indexed ?? base.indexed ?? 0)),
    };

    await this.jobs.updateOne(
      { jobId },
      {
        $set: {
          counts: next,
          updatedAt: new Date().toISOString(),
        },
      }
    );
  }

  async setJobLivePreview(jobId: string, products: OnboardingIndexedProduct[]): Promise<void> {
    const now = new Date();
    await this.jobPreviews.updateOne(
      { jobId },
      {
        $set: {
          jobId,
          products: (products || []).slice(0, 12),
          updatedAt: now.toISOString(),
          expiresAt: this.makeExpiry(now, this.demoTtlDays),
        },
      },
      { upsert: true }
    );
  }

  async getJobLive(jobId: string): Promise<OnboardingJobLiveResponse | null> {
    const [job, preview] = await Promise.all([
      this.jobs.findOne({ jobId }),
      this.jobPreviews.findOne({ jobId }),
    ]);
    if (!job) return null;
    return {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      counters: job.counts || this.emptyCounters(),
      recentProducts: Array.isArray(preview?.products) ? preview!.products.slice(0, 12) : [],
    };
  }

  async markJobFailed(jobId: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.jobs.updateOne(
      { jobId },
      {
        $set: {
          status: "failed",
          errorCode,
          errorMessage: errorMessage.slice(0, 500),
          progress: {
            step: "failed",
            percent: 100,
            message: errorMessage.slice(0, 220),
          },
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }
    );
  }

  async finalizeJobSuccess(params: {
    jobId: string;
    websiteUrl: string;
    email: string;
    category: OnboardingCategory;
    products: Array<OnboardingNormalizedProduct & { embedding: number[] }>;
    partial: boolean;
  }): Promise<{ demoId: string; demoToken: string; status: "ready" | "partial_ready" }> {
    const now = new Date();
    const expiresAt = this.makeExpiry(now, this.demoTtlDays);
    const demoId = crypto.randomUUID();
    const demoToken = this.signDemoToken(demoId);
    const tokenHash = this.hashToken(demoToken);
    const status: "ready" | "partial_ready" = params.partial ? "partial_ready" : "ready";

    const documents: OnboardingProductDoc[] = params.products.map((product) => ({
      demoId,
      jobId: params.jobId,
      merchantId: `onboarding:${demoId}`,
      name: product.name,
      description: product.description,
      price: product.price,
      currency: product.currency,
      imageUrl: product.imageUrl,
      productUrl: product.productUrl,
      brand: product.brand,
      category: product.category,
      inStock: product.inStock,
      source: product.source,
      raw: product.raw,
      attributesText: this.toAttributesText(product.raw as Record<string, unknown> | undefined),
      embedding: product.embedding,
      createdAt: now.toISOString(),
      expiresAt,
    }));

    if (documents.length > 0) {
      await this.products.insertMany(documents, { ordered: false });
    }

    const demoDoc: OnboardingDemoDoc = {
      demoId,
      jobId: params.jobId,
      websiteUrl: params.websiteUrl,
      category: params.category,
      email: params.email,
      productCount: documents.length,
      tokenHash,
      tokenExp: expiresAt,
      status,
      createdAt: now.toISOString(),
      expiresAt,
    };

    await this.demos.insertOne(demoDoc);

    await this.jobs.updateOne(
      { jobId: params.jobId },
      {
        $set: {
          status,
          demoId,
          demoToken,
          productCount: documents.length,
          progress: {
            step: "done",
            percent: 100,
            message: status === "ready" ? "Demo is ready" : "Partial demo is ready",
          },
          counts: {
            extracted: documents.length,
            normalized: documents.length,
            embedded: documents.length,
            indexed: documents.length,
          },
          finishedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      }
    );

    return {
      demoId,
      demoToken,
      status,
    };
  }

  async getDemoByToken(token: string): Promise<OnboardingDemoResponse | null> {
    const tokenHash = this.hashToken(token);
    const nowIso = new Date().toISOString();

    const demo = await this.demos.findOne({ tokenHash, tokenExp: { $gt: nowIso } });
    if (!demo) return null;

    const previewProducts = await this.products
      .find({ demoId: demo.demoId })
      .sort({ inStock: -1, createdAt: -1 })
      .limit(12)
      .toArray();

    return {
      demoId: demo.demoId,
      websiteUrl: demo.websiteUrl,
      category: demo.category,
      productCount: demo.productCount,
      status: demo.status,
      createdAt: demo.createdAt,
      expiresAt: demo.expiresAt,
      previewProducts: previewProducts.map((p) => this.toIndexedProduct(p)),
    };
  }

  async searchDemoByToken(
    token: string,
    input: { query: string; limit: number; offset: number }
  ): Promise<OnboardingDemoSearchResult | null> {
    const tokenHash = this.hashToken(token);
    const nowIso = new Date().toISOString();
    const demo = await this.demos.findOne({ tokenHash, tokenExp: { $gt: nowIso } });
    if (!demo) return null;

    return this.searchService.search(demo.demoId, input.query, input.limit, input.offset, {
      demoCategory: demo.category,
    });
  }

  async trackEvent(event: OnboardingTrackEvent, context: { ip?: string; userAgent?: string }): Promise<void> {
    const now = new Date();
    const doc: OnboardingTrackDoc = {
      eventId: crypto.randomUUID(),
      event: event.event,
      jobId: event.jobId,
      demoId: event.demoId,
      websiteUrl: event.websiteUrl,
      metadata: event.metadata,
      ip: context.ip,
      userAgent: context.userAgent,
      createdAt: now.toISOString(),
      expiresAt: this.makeExpiry(now, this.demoTtlDays),
    };

    await this.track.insertOne(doc);
  }

  async getAssistPreview(productUrl: string): Promise<{
    normalizedUrl: string;
    baseUrl: string;
    html: string;
  }> {
    const normalizedUrl = this.normalizeWebsiteUrl(productUrl);
    this.assertPublicUrlSafe(normalizedUrl);
    const html = await this.fetchHtmlPreview(normalizedUrl);
    if (!html) {
      throw new Error("assist_preview_unavailable");
    }
    const baseUrl = new URL(normalizedUrl).origin;
    return {
      normalizedUrl,
      baseUrl,
      html,
    };
  }

  async getAssistAutoPreview(websiteUrl: string): Promise<{
    normalizedUrl: string;
    baseUrl: string;
    html: string;
  }> {
    const normalizedWebsiteUrl = this.normalizeWebsiteUrl(websiteUrl);
    this.assertPublicUrlSafe(normalizedWebsiteUrl);

    const sampleProductUrl = await this.findSampleProductUrl(normalizedWebsiteUrl);
    if (!sampleProductUrl) {
      throw new Error("assist_preview_unavailable");
    }

    return this.getAssistPreview(sampleProductUrl);
  }

  async saveAssistTemplate(
    input: OnboardingAssistTemplatePayload
  ): Promise<{ saved: true; domain: string }> {
    const websiteUrl = this.normalizeWebsiteUrl(input.websiteUrl);
    const productUrl = this.normalizeWebsiteUrl(input.productUrl);
    this.assertPublicUrlSafe(websiteUrl);
    this.assertPublicUrlSafe(productUrl);

    const websiteDomain = new URL(websiteUrl).hostname.toLowerCase();
    const productDomain = new URL(productUrl).hostname.toLowerCase();
    if (websiteDomain !== productDomain) {
      throw new Error("invalid_request");
    }

    const nameSelector = String(input.selectors?.name?.selector || "").trim();
    if (!nameSelector) {
      throw new Error("invalid_request");
    }

    const now = new Date();
    const expiresAt = this.makeExpiry(now, Math.max(this.demoTtlDays * 4, 30));
    const selectors: OnboardingAssistTemplateDoc["selectors"] = {
      name: {
        selector: nameSelector,
        mode: input.selectors.name.mode === "src" ? "src" : "text",
        sampleText: String(input.selectors.name.sampleText || "").trim().slice(0, 240) || undefined,
      },
    };

    if (input.selectors.price?.selector) {
      selectors.price = {
        selector: String(input.selectors.price.selector).trim(),
        mode: "text",
        sampleText: String(input.selectors.price.sampleText || "").trim().slice(0, 240) || undefined,
      };
    }
    if (input.selectors.image?.selector) {
      selectors.image = {
        selector: String(input.selectors.image.selector).trim(),
        mode: input.selectors.image.mode === "src" ? "src" : "text",
        sampleText: String(input.selectors.image.sampleText || "").trim().slice(0, 240) || undefined,
      };
    }
    if (input.selectors.description?.selector) {
      selectors.description = {
        selector: String(input.selectors.description.selector).trim(),
        mode: "text",
        sampleText:
          String(input.selectors.description.sampleText || "").trim().slice(0, 240) || undefined,
      };
    }
    if (input.selectors.inStock?.selector) {
      selectors.inStock = {
        selector: String(input.selectors.inStock.selector).trim(),
        mode: "text",
        sampleText: String(input.selectors.inStock.sampleText || "").trim().slice(0, 240) || undefined,
      };
    }

    const customFields = Array.isArray(input.customFields)
      ? input.customFields
          .map<OnboardingAssistCustomField>((field) => ({
            key: String(field.key || "").trim().slice(0, 80),
            label: String(field.label || "").trim().slice(0, 120),
            selector: {
              selector: String(field.selector?.selector || "").trim().slice(0, 400),
              mode: (field.selector?.mode === "src" ? "src" : "text") as "text" | "src",
              sampleText: String(field.selector?.sampleText || "").trim().slice(0, 240) || undefined,
            },
          }))
          .filter((field) => field.key && field.label && field.selector.selector)
          .slice(0, 20)
      : [];

    await this.templates.updateOne(
      { domain: websiteDomain },
      {
        $set: {
          domain: websiteDomain,
          websiteUrl,
          sampleProductUrl: productUrl,
          category: input.category,
          selectors,
          customFields,
          updatedAt: now.toISOString(),
          expiresAt,
        },
        $setOnInsert: {
          createdAt: now.toISOString(),
        },
      },
      { upsert: true }
    );

    return { saved: true, domain: websiteDomain };
  }

  async extractAssistSample(
    input: OnboardingAssistTemplatePayload
  ): Promise<OnboardingAssistExtractSampleResult> {
    const websiteUrl = this.normalizeWebsiteUrl(input.websiteUrl);
    const productUrl = this.normalizeWebsiteUrl(input.productUrl);
    this.assertPublicUrlSafe(websiteUrl);
    this.assertPublicUrlSafe(productUrl);

    const websiteDomain = new URL(websiteUrl).hostname.toLowerCase();
    const productDomain = new URL(productUrl).hostname.toLowerCase();
    if (websiteDomain !== productDomain) {
      throw new Error("invalid_request");
    }

    const template: OnboardingAssistRuntimeTemplate = {
      domain: websiteDomain,
      websiteUrl,
      sampleProductUrl: productUrl,
      category: input.category,
      selectors: {
        name: {
          selector: String(input.selectors?.name?.selector || "").trim(),
          mode: input.selectors?.name?.mode === "src" ? "src" : "text",
          sampleText: String(input.selectors?.name?.sampleText || "").trim().slice(0, 240) || undefined,
        },
        price: input.selectors?.price?.selector
          ? {
              selector: String(input.selectors.price.selector).trim(),
              mode: "text",
              sampleText: String(input.selectors.price.sampleText || "").trim().slice(0, 240) || undefined,
            }
          : undefined,
        image: input.selectors?.image?.selector
          ? {
              selector: String(input.selectors.image.selector).trim(),
              mode: input.selectors.image.mode === "src" ? "src" : "text",
              sampleText: String(input.selectors.image.sampleText || "").trim().slice(0, 240) || undefined,
            }
          : undefined,
        description: input.selectors?.description?.selector
          ? {
              selector: String(input.selectors.description.selector).trim(),
              mode: "text",
              sampleText:
                String(input.selectors.description.sampleText || "").trim().slice(0, 240) || undefined,
            }
          : undefined,
        inStock: input.selectors?.inStock?.selector
          ? {
              selector: String(input.selectors.inStock.selector).trim(),
              mode: "text",
              sampleText: String(input.selectors.inStock.sampleText || "").trim().slice(0, 240) || undefined,
            }
          : undefined,
      },
      customFields: Array.isArray(input.customFields)
        ? input.customFields
            .map<OnboardingAssistCustomField>((field) => ({
              key: String(field.key || "").trim().slice(0, 80),
              label: String(field.label || "").trim().slice(0, 120),
              selector: {
                selector: String(field.selector?.selector || "").trim().slice(0, 400),
                mode: (field.selector?.mode === "src" ? "src" : "text") as "text" | "src",
                sampleText: String(field.selector?.sampleText || "").trim().slice(0, 240) || undefined,
              },
            }))
            .filter((field) => field.key && field.label && field.selector.selector)
            .slice(0, 20)
        : [],
    };

    if (!template.selectors.name.selector) {
      throw new Error("invalid_request");
    }

    const discovery = await this.scraperService.discover(websiteUrl);
    if (!discovery.robotsAllowed) {
      throw new Error(discovery.robotsReason || "robots_disallowed");
    }

    return this.scraperService.extractSingleProductByTemplate(
      discovery,
      productUrl,
      template
    );
  }

  async getAssistTemplateForWebsite(websiteUrl: string): Promise<OnboardingAssistRuntimeTemplate | null> {
    const normalizedUrl = this.normalizeWebsiteUrl(websiteUrl);
    this.assertPublicUrlSafe(normalizedUrl);
    const domain = new URL(normalizedUrl).hostname.toLowerCase();
    const nowIso = new Date().toISOString();
    const doc = await this.templates.findOne({
      domain,
      expiresAt: { $gt: nowIso },
    });
    if (!doc) return null;
    return {
      domain: doc.domain,
      websiteUrl: doc.websiteUrl,
      sampleProductUrl: doc.sampleProductUrl,
      category: doc.category,
      selectors: doc.selectors,
      customFields: Array.isArray(doc.customFields) ? doc.customFields : [],
    };
  }

  async getWorkerHealth(): Promise<{
    queueSize: number;
    runningCount: number;
    readyCount: number;
    failedCount: number;
    timestamp: string;
  }> {
    const [queueSize, runningCount, readyCount, failedCount] = await Promise.all([
      this.jobs.countDocuments({ status: "queued" }),
      this.jobs.countDocuments({ status: "running" }),
      this.jobs.countDocuments({ status: { $in: ["ready", "partial_ready"] } }),
      this.jobs.countDocuments({ status: "failed" }),
    ]);

    return {
      queueSize,
      runningCount,
      readyCount,
      failedCount,
      timestamp: new Date().toISOString(),
    };
  }

  private toJobStatusResponse(doc: OnboardingJobDoc): OnboardingJobStatusResponse {
    return {
      jobId: doc.jobId,
      websiteUrl: doc.websiteUrl,
      category: doc.category,
      email: doc.email,
      status: doc.status,
      progress: doc.progress,
      errorCode: doc.errorCode,
      errorMessage: doc.errorMessage,
      demoToken: doc.demoToken,
      demoUrl: doc.demoToken ? `/onboarding/demo/${doc.demoToken}` : undefined,
      demoId: doc.demoId,
      productCount: doc.productCount,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      expiresAt: doc.expiresAt,
    };
  }

  private toIndexedProduct(doc: WithId<OnboardingProductDoc>): OnboardingIndexedProduct {
    return {
      _id: String(doc._id),
      demoId: doc.demoId,
      jobId: doc.jobId,
      merchantId: doc.merchantId,
      name: doc.name,
      description: doc.description,
      price: doc.price,
      currency: doc.currency,
      imageUrl: doc.imageUrl,
      productUrl: doc.productUrl,
      brand: doc.brand,
      category: doc.category,
      inStock: doc.inStock,
      source: doc.source,
      raw: doc.raw,
      embedding: doc.embedding,
      score: doc.score,
      finalScore: doc.finalScore,
      createdAt: doc.createdAt,
      expiresAt: doc.expiresAt,
    };
  }

  private enforceAbuseGuard(domain: string, ip?: string): void {
    const now = Date.now();
    const safeIp = String(ip || "unknown");

    const ipEntry = this.ipWindowMap.get(safeIp);
    if (!ipEntry || now > ipEntry.resetAt) {
      this.ipWindowMap.set(safeIp, {
        count: 1,
        resetAt: now + this.ipWindowMs,
      });
    } else {
      ipEntry.count += 1;
      if (ipEntry.count > this.ipWindowLimit) {
        throw new Error("rate_limit_exceeded");
      }
    }

    const cooldownUntil = this.domainCooldownMap.get(domain) || 0;
    if (cooldownUntil > now) {
      throw new Error("rate_limit_exceeded");
    }

    this.domainCooldownMap.set(domain, now + this.domainCooldownMs);
  }

  private assertPublicUrlSafe(websiteUrl: string): void {
    const url = new URL(websiteUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("invalid_url");
    }

    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host === "0.0.0.0" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      throw new Error("invalid_url");
    }
  }

  private normalizeWebsiteUrl(raw: string): string {
    const value = String(raw || "").trim();
    const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(withProtocol);
    url.hash = "";
    return url.toString();
  }

  private signDemoToken(demoId: string): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = `${demoId}.${nonce}`;
    const sig = crypto
      .createHmac("sha256", this.tokenSecret)
      .update(payload)
      .digest("hex")
      .slice(0, 48);
    return `${payload}.${sig}`;
  }

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private makeExpiry(now: Date, ttlDays: number): string {
    const copy = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    return copy.toISOString();
  }

  private emptyCounters(): OnboardingJobCounters {
    return {
      extracted: 0,
      normalized: 0,
      embedded: 0,
      indexed: 0,
    };
  }

  private toAttributesText(raw?: Record<string, unknown>): string | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const attributes =
      raw.attributes && typeof raw.attributes === "object"
        ? (raw.attributes as Record<string, unknown>)
        : {};
    const softCategories = Array.isArray(raw.softCategories)
      ? (raw.softCategories as unknown[])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : [];

    const text = [
      ...Object.entries(attributes).map(([key, value]) => `${key} ${String(value || "")}`.trim()),
      softCategories.join(" "),
    ]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 2000);
    return text || undefined;
  }

  private async fetchHtmlPreview(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      if (!response.ok) return "";
      const html = await response.text();
      // Keep payload bounded for preview transport.
      return html.slice(0, 1_000_000);
    } catch {
      return "";
    } finally {
      clearTimeout(timeout);
    }
  }

  private async findSampleProductUrl(websiteUrl: string): Promise<string | null> {
    const parsed = new URL(websiteUrl);
    const origin = parsed.origin;
    const candidates = new Set<string>();

    const tryAdd = (raw: string) => {
      const value = String(raw || "").trim();
      if (!value) return;
      try {
        const absolute = new URL(value, origin).toString();
        const url = new URL(absolute);
        if (url.origin !== origin) return;
        if (!this.looksLikeProductUrl(url.toString())) return;
        candidates.add(url.toString());
      } catch {
        // ignore invalid candidate
      }
    };

    const sitemap = await this.fetchHtmlPreview(`${origin.replace(/\/$/, "")}/sitemap.xml`);
    if (sitemap) {
      const locRegex = /<loc>\s*([^<]+)\s*<\/loc>/gi;
      let match: RegExpExecArray | null;
      while ((match = locRegex.exec(sitemap))) {
        tryAdd(String(match[1] || ""));
        if (candidates.size >= 40) break;
      }
    }

    const pages = [
      websiteUrl,
      `${origin}/collections/all`,
      `${origin}/collections`,
      `${origin}/shop`,
      `${origin}/products`,
      `${origin}/catalog`,
    ];

    for (const page of pages) {
      if (candidates.size >= 40) break;
      const html = await this.fetchHtmlPreview(page);
      if (!html) continue;

      const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
      let anchorMatch: RegExpExecArray | null;
      while ((anchorMatch = anchorRegex.exec(html))) {
        tryAdd(String(anchorMatch[1] || ""));
        if (candidates.size >= 40) break;
      }

      const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
      let jsonMatch: RegExpExecArray | null;
      while ((jsonMatch = jsonLdRegex.exec(html))) {
        const block = String(jsonMatch[1] || "");
        const urlRegex = /"url"\s*:\s*"([^"]+)"/gi;
        let urlMatch: RegExpExecArray | null;
        while ((urlMatch = urlRegex.exec(block))) {
          tryAdd(String(urlMatch[1] || ""));
          if (candidates.size >= 40) break;
        }
        if (candidates.size >= 40) break;
      }
    }

    return candidates.values().next().value || null;
  }

  private looksLikeProductUrl(url: string): boolean {
    const value = String(url || "").toLowerCase();
    if (!value) return false;
    if (value.endsWith(".xml")) return false;
    if (/\/sitemap[^/]*\.xml(?:$|\?)/.test(value)) return false;
    if (/\/(feed|rss)(?:$|[/?#])/.test(value)) return false;
    if (/[?&](format|output)=xml\b/.test(value)) return false;
    return (
      /\/(product|products|item|items|sku|p)\b/.test(value) ||
      /\/collections\/[^/]+\/products\//.test(value)
    );
  }

  private async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.createIndexSafe(this.jobs, { status: 1, createdAt: 1 }),
      this.createIndexSafe(this.jobs, { expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.createIndexSafe(this.jobs, { websiteUrl: 1 }),
      this.createIndexSafe(this.jobs, { email: 1 }),
      this.createIndexSafe(this.jobs, { jobId: 1 }, { unique: true }),

      this.createIndexSafe(this.products, { demoId: 1 }),
      this.createIndexSafe(this.products, { jobId: 1 }),
      this.createIndexSafe(this.products, { expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.createIndexSafe(
        this.products,
        {
          name: "text",
          description: "text",
          brand: "text",
          attributesText: "text",
        },
        undefined,
        { ignoreTextIndexConflict: true }
      ),

      this.createIndexSafe(this.demos, { tokenHash: 1 }, { unique: true }),
      this.createIndexSafe(this.demos, { demoId: 1 }, { unique: true }),
      this.createIndexSafe(this.demos, { expiresAt: 1 }, { expireAfterSeconds: 0 }),

      this.createIndexSafe(this.track, { expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.createIndexSafe(this.track, { event: 1, createdAt: -1 }),

      this.createIndexSafe(this.templates, { domain: 1 }, { unique: true }),
      this.createIndexSafe(this.templates, { expiresAt: 1 }, { expireAfterSeconds: 0 }),

      this.createIndexSafe(this.jobPreviews, { jobId: 1 }, { unique: true }),
      this.createIndexSafe(this.jobPreviews, { expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);

    await this.ensureVectorIndexBestEffort();
  }

  private async createIndexSafe(
    collection: Collection<any>,
    keys: Record<string, 1 | -1 | "text">,
    options?: Record<string, unknown>,
    flags?: { ignoreTextIndexConflict?: boolean }
  ): Promise<void> {
    try {
      await collection.createIndex(keys as any, options as any);
    } catch (error) {
      const code = Number((error as any)?.code || 0);
      const codeName = String((error as any)?.codeName || "");
      const message = String((error as any)?.message || "");
      const isTextConflict =
        code === 85 ||
        codeName === "IndexOptionsConflict" ||
        message.includes("An equivalent index already exists");

      if (flags?.ignoreTextIndexConflict && isTextConflict) {
        console.warn(
          `[onboarding] Reusing existing text index on ${collection.collectionName}: ${codeName || code}`
        );
        return;
      }
      throw error;
    }
  }

  private async ensureVectorIndexBestEffort(): Promise<void> {
    const dimensions = this.env.EMBEDDING_DIMENSIONS || 3072;
    try {
      await this.db.command({
        createSearchIndexes: "onboarding.products",
        indexes: [
          {
            name: "onboarding_vector_index",
            definition: {
              fields: [
                {
                  type: "vector",
                  path: "embedding",
                  numDimensions: dimensions,
                  similarity: "cosine",
                },
                {
                  type: "filter",
                  path: "demoId",
                },
              ],
            },
          },
        ],
      });
    } catch {
      // Search index creation may fail in local/dev or without Atlas privileges.
    }
  }
}
