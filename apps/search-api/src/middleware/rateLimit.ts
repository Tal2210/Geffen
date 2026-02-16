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
const PUBLIC_ONBOARDING_WINDOW_MS = 60 * 1000;
const PUBLIC_ONBOARDING_MAX_REQUESTS = 120;
const PUBLIC_ONBOARDING_START_WINDOW_MS = 10 * 60 * 1000;
const PUBLIC_ONBOARDING_START_MAX_REQUESTS = 10;

const onboardingRateLimitStore = new Map<string, RateLimitEntry>();
const onboardingStartRateLimitStore = new Map<string, RateLimitEntry>();

export async function rateLimitMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const pathname = getPathname(request);
  const isPublicOnboardingRoute =
    isOnboardingRoute(pathname) && !isOnboardingInternalRoute(pathname);

  // Skip rate limiting for health check
  if (request.method === "OPTIONS" || pathname.endsWith("/health")) {
    return;
  }

  if (isPublicOnboardingRoute) {
    const ip =
      request.ip ||
      String(request.headers["x-forwarded-for"] || request.headers["x-real-ip"] || "unknown");
    const now = Date.now();
    const isStartRoute = isOnboardingStartRoute(pathname);

    const shared = consumeRateLimit(onboardingRateLimitStore, ip, now, PUBLIC_ONBOARDING_WINDOW_MS);
    if (shared.count > PUBLIC_ONBOARDING_MAX_REQUESTS) {
      return reply.status(429).send({
        error: "rate_limit_exceeded",
        message: `Rate limit exceeded. Max ${PUBLIC_ONBOARDING_MAX_REQUESTS} onboarding requests per minute.`,
        retryAfter: Math.ceil((shared.resetAt - now) / 1000),
      });
    }

    if (isStartRoute) {
      const start = consumeRateLimit(
        onboardingStartRateLimitStore,
        ip,
        now,
        PUBLIC_ONBOARDING_START_WINDOW_MS
      );
      if (start.count > PUBLIC_ONBOARDING_START_MAX_REQUESTS) {
        return reply.status(429).send({
          error: "rate_limit_exceeded",
          message: `Rate limit exceeded. Max ${PUBLIC_ONBOARDING_START_MAX_REQUESTS} onboarding starts per 10 minutes.`,
          retryAfter: Math.ceil((start.resetAt - now) / 1000),
        });
      }
    }

    reply.header("X-RateLimit-Limit", PUBLIC_ONBOARDING_MAX_REQUESTS.toString());
    reply.header(
      "X-RateLimit-Remaining",
      Math.max(0, PUBLIC_ONBOARDING_MAX_REQUESTS - shared.count).toString()
    );
    reply.header("X-RateLimit-Reset", new Date(shared.resetAt).toISOString());
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

function isOnboardingStartRoute(pathname: string): boolean {
  return /(?:^|\/)onboarding\/start(?:\/|$)/.test(pathname);
}

function consumeRateLimit(
  store: Map<string, RateLimitEntry>,
  key: string,
  now: number,
  windowMs: number
): RateLimitEntry {
  const entry = store.get(key);
  if (!entry || now > entry.resetAt) {
    const next: RateLimitEntry = {
      count: 1,
      resetAt: now + windowMs,
    };
    store.set(key, next);
    return next;
  }

  entry.count += 1;
  return entry;
}
