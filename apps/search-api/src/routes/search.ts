import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ImageSearchRequestSchema, SearchQuerySchema } from "../types/index.js";
import type { SearchService } from "../services/searchService.js";
import type { ProductExplanationService } from "../services/productExplanationService.js";
import type { BoostRuleService } from "../services/boostRuleService.js";
import type { ProductCatalogService } from "../services/productCatalogService.js";
import type { AcademyChatService } from "../services/academyChatService.js";
import type { AcademyMetricsService } from "../services/academyMetricsService.js";
import type { WineImageSearchService } from "../services/wineImageSearchService.js";
import { getMerchantId } from "../middleware/auth.js";

const ExplainRequestSchema = z.object({
  query: z.string().min(1).max(500),
  products: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        color: z.string().optional(),
        country: z.string().optional(),
        grapes: z.array(z.string()).optional(),
      })
    )
    .min(1)
    .max(12),
});

const BoostRuleCreateSchema = z.object({
  productId: z.string().min(1),
  productName: z.string().min(1),
  triggerQuery: z.string().min(1).max(500),
  matchMode: z.enum(["contains", "exact"]).default("contains"),
  boostPercent: z.number().min(0).max(200).default(25),
  pinToTop: z.boolean().default(false),
  active: z.boolean().default(true),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional(),
});

const BoostRuleUpdateSchema = z.object({
  triggerQuery: z.string().min(1).max(500).optional(),
  matchMode: z.enum(["contains", "exact"]).optional(),
  boostPercent: z.number().min(0).max(200).optional(),
  pinToTop: z.boolean().optional(),
  active: z.boolean().optional(),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional(),
});

const AcademyChatSchema = z.object({
  question: z.string().min(2).max(1200),
});

const AcademySearchEventSchema = z.object({
  question: z.string().min(2).max(1200),
  userId: z.string().min(1).max(120).optional(),
  resultProductIds: z.array(z.string().min(1)).max(40).default([]),
  selectedProductIds: z.array(z.string().min(1)).max(40).default([]),
  ts: z.string().datetime().optional(),
});

const AcademyClickEventSchema = z.object({
  productId: z.string().min(1),
  query: z.string().max(1200).optional(),
  userId: z.string().min(1).max(120).optional(),
  ts: z.string().datetime().optional(),
});

const AcademyOrderEventSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive().max(100).default(1),
  amount: z.number().min(0).optional(),
  userId: z.string().min(1).max(120).optional(),
  ts: z.string().datetime().optional(),
});

const AcademyRecomputeSchema = z.object({
  weekStart: z.string().datetime().optional(),
});

const AcademyPopularQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(5),
  weekStart: z.string().datetime().optional(),
});

export function createSearchRoutes(
  searchService: SearchService,
  productExplanationService: ProductExplanationService,
  boostRuleService: BoostRuleService,
  productCatalogService: ProductCatalogService,
  academyChatService: AcademyChatService,
  academyMetricsService: AcademyMetricsService,
  wineImageSearchService: WineImageSearchService
): FastifyPluginAsync {
  return async (server) => {
    /**
     * POST /search
     * Semantic search for wine products
     */
    server.post("/search", async (request, reply) => {
      const merchantId = getMerchantId(request);

      // Parse and validate request body
      const body = request.body as any;
      const parsed = SearchQuerySchema.safeParse({
        ...body,
        merchantId, // Override with authenticated merchantId
      });

      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }

      try {
        const result = await searchService.search(parsed.data);
        server.log.info(
          {
            merchantId,
            query: parsed.data.query,
            totalResults: result.metadata.totalResults,
            retrieval: result.metadata.retrieval,
            timings: result.metadata.timings,
          },
          "Search completed"
        );

        // Add performance headers
        reply.header("X-Search-Time", result.metadata.timings.total.toString());
        reply.header(
          "X-Vector-Search-Time",
          result.metadata.timings.vectorSearch.toString()
        );

        return reply.send(result);
      } catch (error) {
        server.log.error({ error, merchantId, query: parsed.data.query }, "Search failed");

        return reply.status(500).send({
          error: "search_failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    server.post("/search/by-image", async (request, reply) => {
      const merchantId = getMerchantId(request);
      const parsed = ImageSearchRequestSchema.safeParse(request.body as any);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }

      try {
        const result = await wineImageSearchService.searchByImage({
          imageDataUrl: parsed.data.imageDataUrl,
          queryHint: parsed.data.queryHint,
          merchantId,
          limit: parsed.data.limit,
        });

        server.log.info(
          {
            merchantId,
            decision: result.metadata.decision,
            reason: result.metadata.reason,
            exactMatch: result.exactMatch ? String((result.exactMatch as any)._id) : null,
            textualCount: result.textualMatches.length,
            alternativesCount: result.alternatives.length,
            vectorAttempted: result.metadata.vectorAttempted,
            vectorUsedAsFallback: result.metadata.vectorUsedAsFallback,
            timings: result.metadata.timings,
          },
          "Image search completed"
        );

        return reply.send(result);
      } catch (error) {
        const normalized = wineImageSearchService.toPublicError(error);
        server.log.error(
          { error, merchantId, code: normalized.code, statusCode: normalized.statusCode },
          "Image search failed"
        );
        return reply.status(normalized.statusCode).send({
          error: normalized.code,
          message: normalized.message,
        });
      }
    });

    /**
     * POST /search/explain
     * Generate short explanation text for why returned products fit the query
     */
    server.post("/search/explain", async (request, reply) => {
      const merchantId = getMerchantId(request);
      const body = request.body as any;
      const parsed = ExplainRequestSchema.safeParse(body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }

      try {
        const result = await productExplanationService.explain(
          parsed.data.query,
          parsed.data.products
        );
        return reply.send(result);
      } catch (error) {
        server.log.error({ error, merchantId }, "Explanation generation failed");
        return reply.status(500).send({
          error: "explain_failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    server.post("/academy/chat", async (request, reply) => {
      getMerchantId(request);
      const parsed = AcademyChatSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }
      try {
        const result = await academyChatService.ask(parsed.data.question);
        return reply.send(result);
      } catch (error) {
        server.log.error({ error }, "Academy chat failed");
        return reply.status(500).send({
          error: "academy_chat_failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    server.post("/academy/events/search", async (request, reply) => {
      getMerchantId(request);
      const parsed = AcademySearchEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }
      try {
        await academyMetricsService.trackSearch(parsed.data);
        return reply.status(202).send({ ok: true });
      } catch (error) {
        server.log.error({ error }, "Academy search event failed");
        return reply.status(500).send({
          error: "academy_event_failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    server.post("/academy/events/click", async (request, reply) => {
      getMerchantId(request);
      const parsed = AcademyClickEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }
      try {
        await academyMetricsService.trackClick(parsed.data);
        return reply.status(202).send({ ok: true });
      } catch (error) {
        server.log.error({ error }, "Academy click event failed");
        return reply.status(500).send({
          error: "academy_event_failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    server.post("/academy/events/order", async (request, reply) => {
      getMerchantId(request);
      const parsed = AcademyOrderEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }
      try {
        await academyMetricsService.trackOrder(parsed.data);
        return reply.status(202).send({ ok: true });
      } catch (error) {
        server.log.error({ error }, "Academy order event failed");
        return reply.status(500).send({
          error: "academy_event_failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    server.post("/academy/metrics/recompute-weekly", async (request, reply) => {
      getMerchantId(request);
      const parsed = AcademyRecomputeSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }
      try {
        const result = await academyMetricsService.recomputeWeekly(parsed.data.weekStart);
        return reply.send({ ok: true, ...result });
      } catch (error) {
        server.log.error({ error }, "Academy recompute failed");
        return reply.status(500).send({
          error: "academy_metrics_failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    server.get("/academy/metrics/popular-week", async (request, reply) => {
      getMerchantId(request);
      const parsed = AcademyPopularQuerySchema.safeParse(request.query || {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }
      try {
        const products = await academyMetricsService.getPopularWeek(
          parsed.data.limit,
          parsed.data.weekStart
        );
        return reply.send({
          weekStart: parsed.data.weekStart,
          products,
        });
      } catch (error) {
        server.log.error({ error }, "Academy popular-week failed");
        return reply.status(500).send({
          error: "academy_metrics_failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    server.get("/products/by-name", async (request, reply) => {
      const merchantId = getMerchantId(request);
      const query = (request.query as any)?.q;
      const limitRaw = (request.query as any)?.limit;
      const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 20;

      if (!query || typeof query !== "string" || !query.trim()) {
        return reply.status(400).send({ error: "invalid_request", message: "Missing query param q" });
      }

      try {
        // Try semantic search first
        const result = await searchService.search({
          query,
          merchantId,
          limit: Math.min(Math.max(limit, 1), 50),
          offset: 0,
        });
        
        // If we got results from semantic search, return them
        if (result.products && result.products.length > 0) {
          return reply.send({ products: result.products });
        }
      } catch (error) {
        // Semantic search failed (likely no embeddings or index issues)
        server.log.warn({ error, merchantId, query }, "Semantic search failed, falling back to name search");
      }
      
      // Fallback to simple name search
      const products = await productCatalogService.searchByName(query, limit);
      return reply.send({ products });
    });

    server.get("/boost-rules", async (request, reply) => {
      const merchantId = getMerchantId(request);
      const rules = await boostRuleService.list(merchantId);
      return reply.send({ rules });
    });

    server.post("/boost-rules", async (request, reply) => {
      const merchantId = getMerchantId(request);
      const parsed = BoostRuleCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }

      const created = await boostRuleService.create(merchantId, parsed.data);
      return reply.status(201).send(created);
    });

    server.put("/boost-rules/:id", async (request, reply) => {
      const merchantId = getMerchantId(request);
      const params = request.params as { id?: string };
      if (!params?.id) {
        return reply.status(400).send({ error: "invalid_request", message: "Missing id" });
      }

      const parsed = BoostRuleUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }

      const updated = await boostRuleService.update(merchantId, params.id, parsed.data);
      if (!updated) {
        return reply.status(404).send({ error: "not_found" });
      }
      return reply.send(updated);
    });

    server.delete("/boost-rules/:id", async (request, reply) => {
      const merchantId = getMerchantId(request);
      const params = request.params as { id?: string };
      if (!params?.id) {
        return reply.status(400).send({ error: "invalid_request", message: "Missing id" });
      }
      const deleted = await boostRuleService.delete(merchantId, params.id);
      if (!deleted) {
        return reply.status(404).send({ error: "not_found" });
      }
      return reply.status(204).send();
    });

    /**
     * GET /health
     * Health check endpoint
     */
    server.get("/health", async () => {
      return {
        ok: true,
        service: "wine-search-api",
        timestamp: new Date().toISOString(),
      };
    });

    /**
     * GET /debug/boost-rules
     * Debug endpoint to test boost rule matching
     */
    server.get<{ Querystring: { query: string } }>("/debug/boost-rules", async (request, reply) => {
      const merchantId = getMerchantId(request);
      const testQuery = (request.query as any)?.query || "";

      if (!testQuery) {
        return reply.status(400).send({
          error: "missing_query",
          message: "Provide ?query=... parameter",
        });
      }

      try {
        const allRules = await boostRuleService.list(merchantId);
        const relevantRules = await boostRuleService.getRelevantRules(merchantId, testQuery);

        return reply.send({
          testQuery,
          merchantId,
          allRules: allRules.map((r) => ({
            id: r._id,
            triggerQuery: r.triggerQuery,
            matchMode: r.matchMode,
            active: r.active,
            productId: r.productId,
            productName: r.productName,
          })),
          matchingRules: relevantRules.map((r) => ({
            id: r._id,
            triggerQuery: r.triggerQuery,
            matchMode: r.matchMode,
            productId: r.productId,
          })),
          matchCount: relevantRules.length,
        });
      } catch (error) {
        server.log.error({ error, merchantId, testQuery }, "Debug boost rules failed");
        return reply.status(500).send({
          error: "debug_failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    /**
     * GET /metrics
     * Basic metrics endpoint (can be expanded for monitoring)
     */
    server.get("/metrics", async (request, reply) => {
      const merchantId = getMerchantId(request);

      // TODO: Implement real metrics collection
      return reply.send({
        merchantId,
        metrics: {
          // Placeholder - implement real metrics
          searches24h: 0,
          avgLatency: 0,
          errorRate: 0,
        },
      });
    });
  };
}
