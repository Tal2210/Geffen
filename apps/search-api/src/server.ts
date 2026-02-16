import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import { EnvSchema, type Env } from "./types/index.js";
import { SearchService } from "./services/searchService.js";
import { ProductExplanationService } from "./services/productExplanationService.js";
import { BoostRuleService } from "./services/boostRuleService.js";
import { ProductCatalogService } from "./services/productCatalogService.js";
import { AcademyChatService } from "./services/academyChatService.js";
import { AcademyMetricsService } from "./services/academyMetricsService.js";
import { WineImageSearchService } from "./services/wineImageSearchService.js";
import { createSearchRoutes } from "./routes/search.js";
import { createOnboardingRoutes } from "./routes/onboarding.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";
import { OnboardingService } from "./services/onboardingService.js";
import { OnboardingWorker } from "./services/onboardingWorker.js";

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load environment variables
 * Try multiple locations for .env file
 */
function loadEnv(): Env {
  const candidates = [
    // Always prefer the service-local env file first.
    path.resolve(__dirname, "..", ".env"),
    path.resolve(process.cwd(), "apps", "search-api", ".env"),
    // Workspace root env as fallback.
    path.resolve(process.cwd(), ".env"),
    path.resolve(__dirname, "..", "..", "..", ".env"),
  ];

  for (const p of Array.from(new Set(candidates))) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p, override: false });
    }
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment variables: ${message}`);
  }

  return parsed.data;
}

/**
 * Build and configure the Fastify server
 */
async function buildServer() {
  const env = loadEnv();

  const server = Fastify({
    // Onboarding demo tokens are longer than Fastify's default param length (100).
    routerOptions: {
      maxParamLength: 300,
    },
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      transport:
        env.NODE_ENV === "development"
          ? {
              target: "pino-pretty",
              options: {
                translateTime: "HH:MM:ss Z",
                ignore: "pid,hostname",
              },
            }
          : undefined,
    },
  });

  // Log CORS_ORIGIN for debugging
  server.log.info({ corsOrigin: env.CORS_ORIGIN }, "CORS_ORIGIN configured");

  // Initialize search service
  const boostRuleService = new BoostRuleService(env);
  const productCatalogService = new ProductCatalogService(env);
  const academyMetricsService = new AcademyMetricsService(env);
  const academyChatService = new AcademyChatService(env, academyMetricsService);
  const searchService = new SearchService(env, boostRuleService);
  const wineImageSearchService = new WineImageSearchService(env, searchService, productCatalogService);
  const onboardingService = new OnboardingService(env);
  const onboardingWorker = new OnboardingWorker(env, onboardingService);
  const productExplanationService = new ProductExplanationService(env);
  await boostRuleService.connect();
  await productCatalogService.connect();
  await academyMetricsService.connect();
  await academyChatService.connect();
  await searchService.initialize();
  await onboardingService.connect();
  onboardingWorker.start();
  server.log.info(
    { db: env.MONGO_DB, collection: env.MONGO_COLLECTION },
    "Search service initialized"
  );

  // Enable CORS
  await server.register(cors, {
    origin: env.CORS_ORIGIN || true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"], // Added X-API-Key
  });

  // Add global hooks for middleware
  server.addHook("onRequest", authMiddleware);
  server.addHook("onRequest", rateLimitMiddleware);

  // Register routes
  await server.register(
    createSearchRoutes(
      searchService,
      productExplanationService,
      boostRuleService,
      productCatalogService,
      academyChatService,
      academyMetricsService,
      wineImageSearchService
    )
  );
  await server.register(createOnboardingRoutes(onboardingService, onboardingWorker));

  // Graceful shutdown
  server.addHook("onClose", async () => {
    server.log.info("Closing search service...");
    await searchService.close();
    await boostRuleService.close();
    await productCatalogService.close();
    await academyMetricsService.close();
    await academyChatService.close();
    onboardingWorker.stop();
    await onboardingService.close();
  });

  return server;
}

/**
 * Start the server
 */
async function start() {
  const env = loadEnv();
  const port = env.PORT;
  const host = "0.0.0.0";

  try {
    const server = await buildServer();
    await server.listen({ port, host });

    server.log.info(
      {
        port,
        env: env.NODE_ENV,
        mongoDb: env.MONGO_DB,
        collection: env.MONGO_COLLECTION,
      },
      "🚀 Search API listening"
    );
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

// Start the server
start();
