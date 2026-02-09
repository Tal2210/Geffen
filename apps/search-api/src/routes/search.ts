import type { FastifyPluginAsync } from "fastify";
import { SearchQuerySchema } from "../types/index.js";
import type { SearchService } from "../services/searchService.js";
import { getMerchantId } from "../middleware/auth.js";

export function createSearchRoutes(searchService: SearchService): FastifyPluginAsync {
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
