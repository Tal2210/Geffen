import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { EmbeddingService } from "../services/embeddingService.js";
import { EnvSchema, type Env } from "../types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnv(): Env {
  const candidates = [
    ".env",
    path.resolve("..", "..", ".env"),
    path.resolve(__dirname, "..", "..", ".env"),
    path.resolve(__dirname, "..", "..", "..", ".env"),
  ];

  for (const p of candidates) {
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

function toText(doc: any): string {
  const name = String(doc.name || doc.Name || "").trim();
  const desc = String(doc.description || doc.Description || "").trim();
  const category = Array.isArray(doc.category) ? doc.category.join(", ") : String(doc.category || "");
  const grapes = Array.isArray(doc.grapes) ? doc.grapes.join(", ") : "";

  return [name, desc, category, grapes].filter(Boolean).join(" | ").slice(0, 6000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateWithRetry(
  embeddingService: EmbeddingService,
  text: string,
  maxAttempts = 6
): Promise<number[]> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await embeddingService.generateEmbedding(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRateLimit = message.includes("429") || message.includes("RESOURCE_EXHAUSTED");
      if (!isRateLimit || attempt >= maxAttempts) {
        throw error;
      }

      const retryMatch = message.match(/retry in\s+([0-9.]+)s/i);
      const retrySeconds = retryMatch ? Number(retryMatch[1]) : 45;
      const waitMs = Math.ceil(retrySeconds * 1000) + 1000;
      console.log(
        `[academy-embed] rate limited (attempt ${attempt}/${maxAttempts}), waiting ${Math.ceil(
          waitMs / 1000
        )}s`
      );
      await sleep(waitMs);
    }
  }
  throw new Error("Unreachable retry state");
}

async function main() {
  const env = loadEnv();
  const dbName = process.env.ACADEMY_DB || "manovino";
  const collectionName = process.env.ACADEMY_COLLECTION || "academy.products";
  const limit = Number(process.env.ACADEMY_LIMIT || "200");
  const dryRun = process.env.ACADEMY_DRY_RUN === "1";
  const reembedAll = process.env.ACADEMY_REEMBED_ALL === "1";
  const reembedStale = process.env.ACADEMY_REEMBED_STALE === "1";
  const targetProvider = process.env.EMBEDDING_PROVIDER || "openai";
  const targetModel = process.env.EMBEDDING_MODEL || "text-embedding-3-large";
  const repeatUntilDone = process.env.ACADEMY_REPEAT_UNTIL_DONE === "1";

  const client = new MongoClient(env.MONGO_URI);
  const embeddingService = new EmbeddingService(env);

  await client.connect();
  const collection = client.db(dbName).collection(collectionName);

  const missingQuery = {
    $or: [
      { embedding: { $exists: false } },
      { embedding: null },
      { embedding: { $size: 0 } },
    ],
  };
  const staleQuery = {
    $or: [
      { embeddingProvider: { $ne: targetProvider } },
      { embeddingModel: { $ne: targetModel } },
      { embedding: { $exists: false } },
      { embedding: null },
      { embedding: { $size: 0 } },
    ],
  };

  const query = reembedAll ? {} : reembedStale ? staleQuery : missingQuery;

  const totalMissing = await collection.countDocuments(missingQuery);
  const batchSize = limit > 0 ? limit : totalMissing;

  const runOneBatch = async () => {
    const docs = await collection.find(query).limit(batchSize).toArray();
    console.log(
      `[academy-embed] db=${dbName} collection=${collectionName} reembedAll=${reembedAll} reembedStale=${reembedStale} missing=${totalMissing} to_process=${docs.length} batchSize=${batchSize} dryRun=${dryRun}`
    );

    let updated = 0;
    for (const doc of docs) {
      const text = toText(doc);
      if (!text) continue;

      if (dryRun) {
        console.log(
          `[dry-run] would embed: ${String(doc._id)} :: ${String(doc.name || doc.Name || "").slice(0, 80)}`
        );
        continue;
      }

      const embedding = await generateWithRetry(embeddingService, text);
      await collection.updateOne(
        { _id: doc._id },
        {
          $set: {
            embedding,
            embeddingUpdatedAt: new Date().toISOString(),
            embeddingProvider: targetProvider,
            embeddingModel: targetModel,
          },
        }
      );
      updated += 1;
      if (updated % 10 === 0) {
        console.log(`[academy-embed] updated ${updated}/${docs.length}`);
      }
    }

    console.log(`[academy-embed] done updated=${updated}`);
    return { docs: docs.length, updated };
  };

  if (repeatUntilDone) {
    let totalUpdated = 0;
    let batches = 0;
    while (true) {
      const { docs, updated } = await runOneBatch();
      batches += 1;
      totalUpdated += updated;
      if (docs === 0 || updated === 0 || docs < batchSize) {
        console.log(`[academy-embed] repeat complete batches=${batches} totalUpdated=${totalUpdated}`);
        break;
      }
    }
  } else {
    await runOneBatch();
  }
  await client.close();
}

main().catch((error) => {
  console.error("[academy-embed] failed:", error);
  process.exit(1);
});
