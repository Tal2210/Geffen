import { prisma } from "../db/prisma.js";
import { confidenceFromVolumeAndEffect } from "./confidence.js";
import type { Prisma } from "@prisma/client";

export type SignalsConfig = {
  minSearches: number;
  spikeDemandDeltaPct: number;
  noResultsAvgThreshold: number;
  minCtr: number;
  maxConversionRate: number;
};

export const DEFAULT_SIGNALS_CONFIG: SignalsConfig = {
  minSearches: 25,
  spikeDemandDeltaPct: 30,
  noResultsAvgThreshold: 0,
  minCtr: 0.25,
  maxConversionRate: 0.01
};

export async function runSignals(params: {
  storeId: string;
  weekStart: Date;
  config?: Partial<SignalsConfig>;
}) {
  const cfg: SignalsConfig = { ...DEFAULT_SIGNALS_CONFIG, ...(params.config ?? {}) };

  const [aggQueries, aggTopics] = await Promise.all([
    prisma.aggQuery.findMany({
      where: { storeId: params.storeId, weekStart: params.weekStart }
    }),
    prisma.aggTopic.findMany({
      where: { storeId: params.storeId, weekStart: params.weekStart }
    })
  ]);

  const signals: Array<{
    type: "SPIKE_DEMAND" | "NO_RESULTS_SPIKE" | "HIGH_INTEREST_LOW_CONVERSION";
    entityType: "query" | "topic";
    entityKey: string;
    confidence: number;
    evidenceJson: Prisma.InputJsonValue;
  }> = [];

  // SPIKE_DEMAND (topics and queries)
  for (const t of aggTopics) {
    if (t.searches < cfg.minSearches) continue;
    if (t.deltaWoW <= cfg.spikeDemandDeltaPct) continue;
    signals.push({
      type: "SPIKE_DEMAND",
      entityType: "topic",
      entityKey: t.topic,
      confidence: confidenceFromVolumeAndEffect(t.searches, t.deltaWoW),
      evidenceJson: {
        searches: t.searches,
        delta_wow_pct: t.deltaWoW,
        week_start: params.weekStart.toISOString().slice(0, 10)
      }
    });
  }

  for (const q of aggQueries) {
    if (q.searches < cfg.minSearches) continue;
    if (q.deltaWoW <= cfg.spikeDemandDeltaPct) continue;
    signals.push({
      type: "SPIKE_DEMAND",
      entityType: "query",
      entityKey: q.queryNorm,
      confidence: confidenceFromVolumeAndEffect(q.searches, q.deltaWoW),
      evidenceJson: {
        searches: q.searches,
        delta_wow_pct: q.deltaWoW,
        ctr: q.ctr,
        avg_results_count: q.avgResultsCount,
        week_start: params.weekStart.toISOString().slice(0, 10)
      }
    });
  }

  // NO_RESULTS_SPIKE (queries)
  for (const q of aggQueries) {
    if (q.searches < cfg.minSearches) continue;
    if (q.avgResultsCount > cfg.noResultsAvgThreshold) continue;
    signals.push({
      type: "NO_RESULTS_SPIKE",
      entityType: "query",
      entityKey: q.queryNorm,
      confidence: confidenceFromVolumeAndEffect(q.searches, q.deltaWoW),
      evidenceJson: {
        searches: q.searches,
        avg_results_count: q.avgResultsCount,
        delta_wow_pct: q.deltaWoW,
        week_start: params.weekStart.toISOString().slice(0, 10)
      }
    });
  }

  // HIGH_INTEREST_LOW_CONVERSION (queries)
  for (const q of aggQueries) {
    if (q.searches < cfg.minSearches) continue;
    if (q.ctr < cfg.minCtr) continue;
    if (q.conversionRate > cfg.maxConversionRate) continue;
    signals.push({
      type: "HIGH_INTEREST_LOW_CONVERSION",
      entityType: "query",
      entityKey: q.queryNorm,
      confidence: confidenceFromVolumeAndEffect(q.searches, q.deltaWoW),
      evidenceJson: {
        searches: q.searches,
        ctr: q.ctr,
        conversion_rate: q.conversionRate,
        delta_wow_pct: q.deltaWoW,
        week_start: params.weekStart.toISOString().slice(0, 10)
      }
    });
  }

  // Persist (idempotent via unique constraint, no wrapping transaction for Neon compat)
  let created = 0;
  for (const s of signals) {
    await prisma.signal.upsert({
      where: {
        storeId_weekStart_type_entityType_entityKey: {
          storeId: params.storeId,
          weekStart: params.weekStart,
          type: s.type,
          entityType: s.entityType,
          entityKey: s.entityKey
        }
      },
      create: {
        storeId: params.storeId,
        weekStart: params.weekStart,
        type: s.type,
        entityType: s.entityType,
        entityKey: s.entityKey,
        evidenceJson: s.evidenceJson,
        confidence: s.confidence
      },
      update: {
        evidenceJson: s.evidenceJson,
        confidence: s.confidence
      }
    });
    created += 1;
  }

  return {
    ok: true,
    storeId: params.storeId,
    weekStart: params.weekStart,
    signalsDetected: signals.length,
    signalsUpserted: created
  };
}

