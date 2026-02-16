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
  const pathname = getPathname(request);
  const isPublicOnboardingRoute =
    isOnboardingRoute(pathname) && !isOnboardingInternalRoute(pathname);

  // Skip auth for health, CORS preflight and public onboarding routes.
  if (request.method === "OPTIONS" || pathname.endsWith("/health") || isPublicOnboardingRoute) {
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

function getPathname(request: FastifyRequest): string {
  const raw = String(request.raw.url || request.url || "").trim();
  if (!raw) return "/";
  const withoutQuery = raw.split("?")[0] || "/";
  if (withoutQuery.startsWith("http://") || withoutQuery.startsWith("https://")) {
    try {
      return new URL(withoutQuery).pathname || "/";
    } catch {
      return withoutQuery;
    }
  }
  return withoutQuery;
}

function isOnboardingRoute(pathname: string): boolean {
  return /(?:^|\/)onboarding(?:\/|$)/.test(pathname);
}

function isOnboardingInternalRoute(pathname: string): boolean {
  return /(?:^|\/)onboarding\/internal(?:\/|$)/.test(pathname);
}
