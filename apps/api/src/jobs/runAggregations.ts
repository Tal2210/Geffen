import { prisma } from "../db/prisma.js";
import { getClient as getMongo } from "../db/mongo.js";
import { addDays, startOfIsoWeek, toDateOnlyUtc } from "../domain/week.js";
import { classifyTopicFromQuery } from "../domain/topicClassifier.js";
import { normalizeQuery } from "../domain/queryNorm.js";

type AggregationsParams = {
  storeId: string;
  weekStart?: Date;
  /** Max events to read per collection (for speed on remote DBs). 0 = unlimited. */
  limit?: number;
};

function safePercentChange(current: number, previous: number): number {
  if (previous <= 0 && current <= 0) return 0;
  if (previous <= 0) return 999; // effectively "infinite" growth
  return ((current - previous) / previous) * 100;
}

// ── Flexible field extractors ────────────────────────────────
// Handle multiple naming conventions from different Mongo schemas.

function extractTs(doc: any): Date | null {
  const raw = doc.ts ?? doc.timestamp ?? doc.createdAt ?? doc.created_at;
  if (!raw) return null;
  // Handle Unix epoch (seconds) — numbers > 1e9 and < 1e13 are seconds.
  if (typeof raw === "number") {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = raw instanceof Date ? raw : new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function extractQuery(doc: any): string {
  return doc.queryNorm ?? doc.search_query ?? doc.query ?? "";
}

function extractProductId(doc: any): string | null {
  const v = doc.productId ?? doc.product_id;
  return v != null ? String(v) : null;
}

function extractRevenueCents(doc: any): number {
  if (typeof doc.revenueCents === "number") return doc.revenueCents;
  if (typeof doc.revenue === "number") return Math.round(doc.revenue * 100);
  if (typeof doc.revenue_cents === "number") return doc.revenue_cents;
  // alcohome checkouts store price as string like "2499.0000"
  if (typeof doc.product_price === "string") {
    const f = parseFloat(doc.product_price);
    if (!isNaN(f)) return Math.round(f * 100);
  }
  if (typeof doc.product_price === "number") return Math.round(doc.product_price * 100);
  return 0;
}

function extractResultsCount(doc: any): number {
  if (typeof doc.resultsCount === "number") return doc.resultsCount;
  if (typeof doc.results_count === "number") return doc.results_count;
  return 0;
}

export async function runAggregations(params: AggregationsParams) {
  const mongo = getMongo();
  await mongo.connectAndEnsureIndexes();

  // Ensure tenant row exists.
  await prisma.store.upsert({
    where: { id: params.storeId },
    update: {},
    create: { id: params.storeId, name: params.storeId }
  });

  const now = new Date();
  const weekStart = toDateOnlyUtc(params.weekStart ?? startOfIsoWeek(now));
  const prevWeekStart = addDays(weekStart, -7);
  const weekEnd = addDays(weekStart, 7);
  const limit = params.limit ?? 0;

  const db = mongo.db;
  const isGlobal = params.storeId === "global";

  // Collections containing actual data.
  const searchCol = db.collection("search_events");
  const clickCol = db.collection("click_events");
  // "alcohome checkouts" = purchase/add-to-cart events.
  const checkoutsCol = db.collection("alcohome checkouts");

  const tenantFilter: Record<string, unknown> = isGlobal ? {} : { tenantId: params.storeId };

  // Time filters that work with Date objects, ISO strings, AND Unix epoch numbers.
  const weekStartEpoch = weekStart.getTime() / 1000;
  const weekEndEpoch = weekEnd.getTime() / 1000;
  const prevWeekStartEpoch = prevWeekStart.getTime() / 1000;

  const timeFilterThisWeek = {
    $or: [
      { ts: { $gte: weekStart, $lt: weekEnd } },
      { timestamp: { $gte: weekStart, $lt: weekEnd } },
      // Unix epoch (seconds) for alcohome checkouts
      { timestamp: { $gte: weekStartEpoch, $lt: weekEndEpoch } }
    ]
  };
  const timeFilterPrevWeek = {
    $or: [
      { ts: { $gte: prevWeekStart, $lt: weekStart } },
      { timestamp: { $gte: prevWeekStart, $lt: weekStart } },
      { timestamp: { $gte: prevWeekStartEpoch, $lt: weekStartEpoch } }
    ]
  };

  // Helper to build a cursor with optional limit.
  function findWithLimit(col: any, filter: any, projection?: any) {
    let cursor = col.find(filter, projection ? { projection } : undefined);
    if (limit > 0) cursor = cursor.limit(limit);
    return cursor.toArray();
  }

  const [
    wineryRows,
    searchesThisWeekRaw,
    searchesPrevWeekRaw,
    clicksThisWeekRaw,
    clicksPrevWeekRaw,
    checkoutsThisWeekRaw,
    checkoutsPrevWeekRaw
  ] = await Promise.all([
    prisma.product.findMany({
      where: { storeId: params.storeId, winery: { not: null } },
      select: { winery: true }
    }),
    findWithLimit(searchCol, { ...tenantFilter, ...timeFilterThisWeek }),
    findWithLimit(searchCol, { ...tenantFilter, ...timeFilterPrevWeek }),
    findWithLimit(clickCol, { ...tenantFilter, ...timeFilterThisWeek }),
    findWithLimit(clickCol, { ...tenantFilter, ...timeFilterPrevWeek }),
    findWithLimit(checkoutsCol, { ...tenantFilter, ...timeFilterThisWeek }),
    findWithLimit(checkoutsCol, { ...tenantFilter, ...timeFilterPrevWeek })
  ]);

  const wineries = wineryRows
    .map((r) => r.winery)
    .filter((w): w is string => Boolean(w));

  // ── Build query aggregates ────────────────────────────────

  const qStats = new Map<
    string,
    { searches: number; clicks: number; purchases: number; avgResultsSum: number; avgResultsN: number }
  >();

  // 1. Explicit search events → searches.
  for (const s of searchesThisWeekRaw) {
    const q = normalizeQuery(extractQuery(s));
    if (!q) continue;
    const cur = qStats.get(q) ?? { searches: 0, clicks: 0, purchases: 0, avgResultsSum: 0, avgResultsN: 0 };
    cur.searches += 1;
    cur.avgResultsSum += extractResultsCount(s);
    cur.avgResultsN += 1;
    qStats.set(q, cur);
  }

  // 2. Click events → clicks (+ implicit searches if no explicit search events).
  for (const c of clicksThisWeekRaw) {
    const q = normalizeQuery(extractQuery(c));
    if (!q) continue;
    const cur = qStats.get(q) ?? { searches: 0, clicks: 0, purchases: 0, avgResultsSum: 0, avgResultsN: 0 };
    if (searchesThisWeekRaw.length === 0) {
      cur.searches += 1; // Treat clicks as implicit searches when no search data.
    }
    cur.clicks += 1;
    qStats.set(q, cur);
  }

  // 3. Checkout events → purchases (by query).
  for (const p of checkoutsThisWeekRaw) {
    const q = normalizeQuery(extractQuery(p));
    if (!q) continue;
    const cur = qStats.get(q) ?? { searches: 0, clicks: 0, purchases: 0, avgResultsSum: 0, avgResultsN: 0 };
    cur.purchases += 1;
    qStats.set(q, cur);
  }

  // Previous week counts.
  const prevSearchCounts = new Map<string, number>();
  for (const s of searchesPrevWeekRaw) {
    const q = normalizeQuery(extractQuery(s));
    if (!q) continue;
    prevSearchCounts.set(q, (prevSearchCounts.get(q) ?? 0) + 1);
  }
  if (searchesPrevWeekRaw.length === 0) {
    for (const c of clicksPrevWeekRaw) {
      const q = normalizeQuery(extractQuery(c));
      if (!q) continue;
      prevSearchCounts.set(q, (prevSearchCounts.get(q) ?? 0) + 1);
    }
  }

  // Revenue from checkouts.
  const storeRevenueThis = checkoutsThisWeekRaw.reduce(
    (sum: number, p: any) => sum + extractRevenueCents(p), 0
  );
  const storeRevenuePrev = checkoutsPrevWeekRaw.reduce(
    (sum: number, p: any) => sum + extractRevenueCents(p), 0
  );
  const storeDelta = safePercentChange(storeRevenueThis, storeRevenuePrev);

  // Build aggregated query rows.
  const aggQueries = Array.from(qStats.entries()).map(([queryNorm, s]) => {
    const prevSearches = prevSearchCounts.get(queryNorm) ?? 0;
    const deltaWoW = safePercentChange(s.searches, prevSearches);
    const ctr = s.searches > 0 ? s.clicks / s.searches : 0;
    const conversionRate = s.searches > 0 ? s.purchases / s.searches : 0;
    const avgResultsCount = s.avgResultsN > 0 ? s.avgResultsSum / s.avgResultsN : 0;
    return {
      storeId: params.storeId,
      weekStart,
      queryNorm,
      searches: s.searches,
      ctr,
      conversionRate,
      revenueCents: 0,
      deltaWoW,
      avgResultsCount
    };
  });

  // ── Topic aggregates ────────────────────────────────
  const topicStats = new Map<string, { searches: number }>();
  for (const aq of aggQueries) {
    const topic = classifyTopicFromQuery(aq.queryNorm, wineries);
    topicStats.set(topic, {
      searches: (topicStats.get(topic)?.searches ?? 0) + aq.searches
    });
  }

  const prevTopicCounts = new Map<string, number>();
  for (const [q, cnt] of prevSearchCounts.entries()) {
    const topic = classifyTopicFromQuery(q, wineries);
    prevTopicCounts.set(topic, (prevTopicCounts.get(topic) ?? 0) + cnt);
  }

  const aggTopics = Array.from(topicStats.entries()).map(([topic, s]) => {
    const prev = prevTopicCounts.get(topic) ?? 0;
    return {
      storeId: params.storeId,
      weekStart,
      topic,
      searches: s.searches,
      conversionRate: 0,
      deltaWoW: safePercentChange(s.searches, prev)
    };
  });

  // ── Product aggregates (views from clicks, purchases from checkouts) ──
  const prodViews = new Map<string, { views: number; purchases: number; revenueCents: number }>();
  for (const c of clicksThisWeekRaw) {
    const pid = extractProductId(c);
    if (!pid) continue;
    const cur = prodViews.get(pid) ?? { views: 0, purchases: 0, revenueCents: 0 };
    cur.views += 1;
    prodViews.set(pid, cur);
  }
  for (const p of checkoutsThisWeekRaw) {
    const pid = extractProductId(p);
    if (!pid) continue;
    const cur = prodViews.get(pid) ?? { views: 0, purchases: 0, revenueCents: 0 };
    cur.purchases += 1;
    cur.revenueCents += extractRevenueCents(p);
    prodViews.set(pid, cur);
  }

  const prevProdViews = new Map<string, number>();
  for (const c of clicksPrevWeekRaw) {
    const pid = extractProductId(c);
    if (!pid) continue;
    prevProdViews.set(pid, (prevProdViews.get(pid) ?? 0) + 1);
  }

  const aggProducts = Array.from(prodViews.entries()).map(([productId, s]) => {
    const prev = prevProdViews.get(productId) ?? 0;
    return {
      storeId: params.storeId,
      weekStart,
      productId,
      views: s.views,
      purchases: s.purchases,
      revenueCents: s.revenueCents,
      deltaWoW: safePercentChange(s.views, prev)
    };
  });

  // ── Persist to Postgres (idempotent upserts, no wrapping transaction) ──
  for (const row of aggQueries) {
    await prisma.aggQuery.upsert({
      where: {
        storeId_weekStart_queryNorm: {
          storeId: row.storeId,
          weekStart: row.weekStart,
          queryNorm: row.queryNorm
        }
      },
      create: row,
      update: row
    });
  }

  for (const row of aggTopics) {
    await prisma.aggTopic.upsert({
      where: {
        storeId_weekStart_topic: {
          storeId: row.storeId,
          weekStart: row.weekStart,
          topic: row.topic
        }
      },
      create: row,
      update: row
    });
  }

  for (const row of aggProducts) {
    const exists = await prisma.product.findUnique({
      where: { storeId_productId: { storeId: row.storeId, productId: row.productId } },
      select: { productId: true }
    });
    if (!exists) continue;

    await prisma.aggProduct.upsert({
      where: {
        storeId_weekStart_productId: {
          storeId: row.storeId,
          weekStart: row.weekStart,
          productId: row.productId
        }
      },
      create: row,
      update: row
    });
  }

  return {
    ok: true,
    storeId: params.storeId,
    weekStart,
    storeRevenueThisWeekCents: storeRevenueThis,
    storeRevenueDeltaWoWPercent: storeDelta,
    eventCounts: {
      searches: { thisWeek: searchesThisWeekRaw.length, prevWeek: searchesPrevWeekRaw.length },
      clicks: { thisWeek: clicksThisWeekRaw.length, prevWeek: clicksPrevWeekRaw.length },
      checkouts: { thisWeek: checkoutsThisWeekRaw.length, prevWeek: checkoutsPrevWeekRaw.length }
    },
    rows: {
      agg_queries: aggQueries.length,
      agg_topics: aggTopics.length,
      agg_products: aggProducts.length
    }
  };
}
