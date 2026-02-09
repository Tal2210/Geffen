/**
 * Trends Pipeline: reads search_events from Mongo, runs the trends engine
 * in-memory, and persists insights to Postgres.
 *
 * No API server needed. Run with: pnpm --filter @geffen-brain/api run:auto
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const candidates = [
  ".env",
  "env.example",
  path.resolve("..", "..", ".env"),
  path.resolve("..", "..", "env.example")
];
for (const p of candidates) {
  if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
}

import { getClient as getMongo } from "../db/mongo.js";
import { prisma } from "../db/prisma.js";
import { buildTimeSeries, analyzeTrends, DEFAULT_TRENDS_CONFIG } from "../engines/trendsEngine.js";
import { startOfIsoWeek, toDateOnlyUtc } from "../domain/week.js";
import type { Prisma } from "@prisma/client";

async function main() {
  console.log("=== Geffen Brain — Search Trends Pipeline ===\n");

  const mongo = getMongo();
  await mongo.connectAndEnsureIndexes();
  const db = mongo.db;
  const searchCol = db.collection("search_events");

  const totalDocs = await searchCol.estimatedDocumentCount();
  console.log(`search_events: ${totalDocs.toLocaleString()} documents\n`);

  // Read all search events (only query + timestamp fields).
  console.log("Reading search events from Mongo...");
  const t0 = Date.now();
  const rawDocs = await searchCol
    .find({}, { projection: { query: 1, search_query: 1, timestamp: 1, ts: 1 } })
    .toArray();
  console.log(`  Read ${rawDocs.length.toLocaleString()} docs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Build time series in memory.
  console.log("\nBuilding time series...");
  const t1 = Date.now();
  const series = buildTimeSeries(rawDocs);
  console.log(`  ${series.size.toLocaleString()} unique queries in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // Analyze trends.
  console.log("\nAnalyzing trends...");
  const t2 = Date.now();
  const insights = analyzeTrends(series, {
    ...DEFAULT_TRENDS_CONFIG,
    minVolume: 10,
    recentWeeks: 4,
    velocityThresholdPct: 25,
    emergingMaxWeeks: 6,
    emergingMinVolume: 5,
    maxPerType: 5
  });
  console.log(`  ${insights.length} insights in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

  // Print results.
  console.log("\n" + "=".repeat(60));
  console.log("               SEARCH TREND INSIGHTS");
  console.log("=".repeat(60));

  const groupedByType = new Map<string, typeof insights>();
  for (const ins of insights) {
    if (!groupedByType.has(ins.type)) groupedByType.set(ins.type, []);
    groupedByType.get(ins.type)!.push(ins);
  }

  const typeLabels: Record<string, string> = {
    TRENDING_UP: "TRENDING UP",
    TRENDING_DOWN: "TRENDING DOWN",
    SEASONAL_OPPORTUNITY: "SEASONAL OPPORTUNITY",
    EMERGING_QUERY: "EMERGING QUERY",
    PEAK_HOURS: "PEAK HOURS",
    EVERGREEN_LEADER: "EVERGREEN LEADER"
  };

  for (const [type, items] of groupedByType) {
    console.log(`\n--- ${typeLabels[type] ?? type} ---\n`);
    for (const ins of items) {
      console.log(`  "${ins.entityKey}"`);
      console.log(`  Confidence: ${(ins.confidence * 100).toFixed(0)}%`);
      console.log(`  ${ins.recommendedAction}`);
      // Show key evidence numbers.
      const ev = ins.evidence;
      const parts: string[] = [];
      if (ev.totalVolume != null) parts.push(`total: ${ev.totalVolume}`);
      if (ev.pctChange != null) parts.push(`change: ${ev.pctChange > 0 ? "+" : ""}${ev.pctChange}%`);
      if (ev.recentVolume != null) parts.push(`recent: ${ev.recentVolume}`);
      if (ev.previousVolume != null) parts.push(`prev: ${ev.previousVolume}`);
      if (ev.calendarEvent != null) parts.push(`event: ${ev.calendarEvent}`);
      if (ev.avgMonthlySearches != null) parts.push(`avg/mo: ${ev.avgMonthlySearches}`);
      if (ev.windowPctOfTotal != null) parts.push(`${ev.windowPctOfTotal}% of all traffic`);
      if (ev.weeksOld != null) parts.push(`${ev.weeksOld} week(s) old`);
      if (parts.length > 0) console.log(`  Evidence: ${parts.join(" | ")}`);
      console.log();
    }
  }

  // Persist to Postgres.
  console.log("Saving insights to Postgres...");
  const storeId = "global";
  const weekStart = toDateOnlyUtc(startOfIsoWeek(new Date()));

  // Ensure store row exists.
  await prisma.store.upsert({
    where: { id: storeId },
    update: {},
    create: { id: storeId, name: "Global Trends" }
  });

  // Clear ALL insights for this store+week to avoid mixing old and new types.
  await prisma.insight.deleteMany({
    where: { storeId, weekStart }
  });

  let saved = 0;
  for (let i = 0; i < insights.length; i++) {
    const ins = insights[i]!;
    await prisma.insight.create({
      data: {
        storeId,
        weekStart,
        ctaType: ins.type,
        entityType: "query",
        entityKey: ins.entityKey,
        priority: i + 1,
        confidence: ins.confidence,
        evidenceJson: ins.evidence as Prisma.InputJsonValue,
        recommendedAction: ins.recommendedAction,
        status: "ACTIVE"
      }
    });
    saved++;
  }

  console.log(`  Saved ${saved} insights.\n`);
  console.log(`Done! View in GUI: http://localhost:5173/?store_id=${encodeURIComponent(storeId)}`);

  await cleanup();
}

async function cleanup() {
  const mongo = getMongo();
  await mongo.client.close().catch(() => {});
  await prisma.$disconnect().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await cleanup();
  process.exit(1);
});
