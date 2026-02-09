import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  MONGO_URI: z.string().min(1),
  MONGO_DB: z.string().min(1),
  // Global pool + per-tenant design:
  // - private events include tenantId (opaque UUID) and live in MONGO_PRIVATE_COLLECTION
  // - global events are sanitized (no tenantId) and live in MONGO_GLOBAL_COLLECTION
  MONGO_PRIVATE_COLLECTION: z.string().min(1).default("events_private"),
  MONGO_GLOBAL_COLLECTION: z.string().min(1).default("events_global"),
  // Legacy support: single-collection mode (deprecated). If set, we treat it as
  // the private events collection name.
  MONGO_EVENTS_COLLECTION: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional()
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment variables: ${message}`);
  }
  return parsed.data;
}

