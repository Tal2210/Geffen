import Fastify from "fastify";
import cors from "@fastify/cors";
import { eventsRoutes } from "./routes/events.js";
import { jobsRoutes } from "./routes/jobs.js";
import { insightsRoutes } from "./routes/insights.js";
import { prisma } from "./db/prisma.js";
import { getClient as getMongo } from "./db/mongo.js";
import { loadEnv } from "./env.js";

export async function buildServer() {
  const env = loadEnv();
  const server = Fastify({
    logger: true
  });

  // Raw events live in Mongo; connect early so issues surface fast.
  const mongo = getMongo();
  await mongo.connectAndEnsureIndexes();
  server.log.info(
    {
      mongoDb: env.MONGO_DB,
      privateCollection: mongo.privateCollectionName,
      globalCollection: mongo.globalCollectionName
    },
    "mongo connected"
  );

  await server.register(cors, {
    origin: env.CORS_ORIGIN ? [env.CORS_ORIGIN] : true
  });

  server.addHook("onClose", async () => {
    await prisma.$disconnect();
    await mongo.client.close().catch(() => {});
  });

  server.get("/health", async () => ({ ok: true }));

  await server.register(eventsRoutes);
  await server.register(jobsRoutes);
  await server.register(insightsRoutes);

  return server;
}

