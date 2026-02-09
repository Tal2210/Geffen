import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Simple in-memory rate limiter
 * Limits requests per merchant per time window
 * 
 * TODO: In production, use Redis for distributed rate limiting
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Store rate limit data per merchantId
const rateLimitStore = new Map<string, RateLimitEntry>();

// Configuration
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const DEFAULT_MAX_REQUESTS = 60; // 60 requests per minute

export async function rateLimitMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Skip rate limiting for health check
  if (request.url === "/health") {
    return;
  }

  const merchantId = (request as any).merchantId;

  if (!merchantId) {
    // No merchantId means auth middleware didn't run
    return;
  }

  const now = Date.now();
  const entry = rateLimitStore.get(merchantId);

  if (!entry || now > entry.resetAt) {
    // Start new window
    rateLimitStore.set(merchantId, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    
    // Add rate limit headers
    reply.header("X-RateLimit-Limit", DEFAULT_MAX_REQUESTS.toString());
    reply.header("X-RateLimit-Remaining", (DEFAULT_MAX_REQUESTS - 1).toString());
    reply.header("X-RateLimit-Reset", new Date(now + RATE_LIMIT_WINDOW_MS).toISOString());
    
    return;
  }

  // Increment counter
  entry.count++;

  // Add rate limit headers
  reply.header("X-RateLimit-Limit", DEFAULT_MAX_REQUESTS.toString());
  reply.header(
    "X-RateLimit-Remaining",
    Math.max(0, DEFAULT_MAX_REQUESTS - entry.count).toString()
  );
  reply.header("X-RateLimit-Reset", new Date(entry.resetAt).toISOString());

  if (entry.count > DEFAULT_MAX_REQUESTS) {
    return reply.status(429).send({
      error: "rate_limit_exceeded",
      message: `Rate limit exceeded. Max ${DEFAULT_MAX_REQUESTS} requests per minute.`,
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    });
  }
}
