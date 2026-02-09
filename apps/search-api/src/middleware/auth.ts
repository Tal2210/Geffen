import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Simple API key authentication middleware
 * Each merchant gets a unique API key
 * 
 * TODO: In production, store API keys in database with:
 * - merchantId mapping
 * - rate limit tiers
 * - expiration dates
 * - usage analytics
 */

// Temporary in-memory store for development
// In production, use database
const API_KEYS = new Map<string, string>([
  ["test_key_store_a", "store_a"],
  ["test_key_store_b", "store_b"],
  ["dev_key_123", "demo_merchant"],
]);

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const apiKey = request.headers["x-api-key"] as string;

  // Skip auth for health check
  if (request.url === "/health") {
    return;
  }

  if (!apiKey) {
    return reply.status(401).send({
      error: "unauthorized",
      message: "Missing X-API-Key header",
    });
  }

  const merchantId = API_KEYS.get(apiKey);

  if (!merchantId) {
    return reply.status(401).send({
      error: "unauthorized",
      message: "Invalid API key",
    });
  }

  // Attach merchantId to request for use in routes
  (request as any).merchantId = merchantId;
}

/**
 * Helper to get merchantId from request
 */
export function getMerchantId(request: FastifyRequest): string {
  return (request as any).merchantId || "";
}
