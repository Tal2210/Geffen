import { MongoClient } from "mongodb";
import { loadEnv } from "../env.js";

declare global {
  // eslint-disable-next-line no-var
  var __mongoClient: MongoClient | undefined;
}

let connectOnce: Promise<void> | null = null;
let indexesOnce: Promise<void> | null = null;

export function getClient() {
  const env = loadEnv();
  const client =
    globalThis.__mongoClient ??
    new MongoClient(env.MONGO_URI, {
      // Node.js 20 LTS with OpenSSL 1.1.1 works fine with MongoDB Atlas
    });

  if (process.env.NODE_ENV !== "production") globalThis.__mongoClient = client;

  const db = client.db(env.MONGO_DB);

  const privateCollectionName = env.MONGO_EVENTS_COLLECTION ?? env.MONGO_PRIVATE_COLLECTION;
  const globalCollectionName = env.MONGO_GLOBAL_COLLECTION;

  const collections = {
    privateEvents: db.collection(privateCollectionName),
    globalEvents: db.collection(globalCollectionName)
  } as const;

  async function connectAndEnsureIndexes() {
    connectOnce ??= client.connect().then(() => {});
    await connectOnce;

    // Ensure indexes once per process.
    indexesOnce ??= (async () => {
      // Private events: tenantId is required, and we enforce idempotency for purchases.
      await collections.privateEvents.createIndexes([
        { key: { tenantId: 1, ts: 1 } },
        { key: { tenantId: 1, type: 1, ts: 1 } },
        { key: { tenantId: 1, type: 1, queryNorm: 1, ts: 1 } },
        { key: { tenantId: 1, type: 1, productId: 1, ts: 1 } },
        { key: { tenantId: 1, type: 1, orderId: 1 }, unique: true }
      ]);

      // Global events: sanitized (no tenantId). No unique constraint on orderId because
      // different tenants may have overlapping order IDs.
      await collections.globalEvents.createIndexes([
        { key: { ts: 1 } },
        { key: { type: 1, ts: 1 } },
        { key: { type: 1, queryNorm: 1, ts: 1 } },
        { key: { type: 1, productId: 1, ts: 1 } }
      ]);
    })().then(() => {});
    await indexesOnce;
  }

  return {
    client,
    db,
    collections,
    privateCollectionName,
    globalCollectionName,
    connectAndEnsureIndexes
  };
}

