import { prisma } from "../db/prisma.js";
import type { Prisma } from "@prisma/client";

export type DecisionConfig = {
  maxCtasPerWeek: number;
  cooldownDays: number;
  minSearches: number;
};

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  maxCtasPerWeek: 3,
  cooldownDays: 10,
  minSearches: 25
};

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / (1000 * 60 * 60 * 24);
}

async function hasAnyInventory(storeId: string): Promise<boolean> {
  const row = await prisma.inventory.aggregate({
    where: { storeId, stockQty: { gt: 0 } },
    _count: { _all: true }
  });
  return (row._count._all ?? 0) > 0;
}

function recommendedActionFor(ctaType: "PUSH_THIS_WEEK" | "FIX_THIS" | "REPOSITION_THIS", entity: { entityType: string; entityKey: string }) {
  switch (ctaType) {
    case "PUSH_THIS_WEEK":
      return `Merchandise and feature "${entity.entityKey}" prominently this week (homepage/search suggestions/collections).`;
    case "FIX_THIS":
      return `Fix the gap for "${entity.entityKey}": add relevant products, improve synonyms, and ensure search returns results.`;
    case "REPOSITION_THIS":
      return `Reposition "${entity.entityKey}": review pricing, placement, and product content to convert existing interest.`;
  }
}

export async function runDecisions(params: {
  storeId: string;
  weekStart: Date;
  config?: Partial<DecisionConfig>;
}) {
  const cfg: DecisionConfig = { ...DEFAULT_DECISION_CONFIG, ...(params.config ?? {}) };

  const signals = await prisma.signal.findMany({
    where: { storeId: params.storeId, weekStart: params.weekStart }
  });

  const cooldowns = await prisma.insightCooldown.findMany({
    where: { storeId: params.storeId }
  });

  const cooldownMap = new Map<string, { lastGeneratedAt: Date | null }>();
  for (const c of cooldowns) {
    cooldownMap.set(`${c.entityType}:${c.entityKey}`, { lastGeneratedAt: c.lastGeneratedAt ?? null });
  }

  const inventoryOk = await hasAnyInventory(params.storeId);

  type Candidate = {
    ctaType: "PUSH_THIS_WEEK" | "FIX_THIS" | "REPOSITION_THIS";
    entityType: "query" | "topic" | "product";
    entityKey: string;
    evidenceJson: Prisma.InputJsonValue;
    confidence: number;
    priorityScore: number;
  };

  const candidates: Candidate[] = [];

  for (const s of signals) {
    // Minimum volume guardrail re-check (based on evidence, if present)
    const searches = typeof (s.evidenceJson as any)?.searches === "number" ? (s.evidenceJson as any).searches : undefined;
    if (searches != null && searches < cfg.minSearches) continue;

    // Cooldown guardrail
    const key = `${s.entityType}:${s.entityKey}`;
    const lastGen = cooldownMap.get(key)?.lastGeneratedAt ?? null;
    if (lastGen && daysBetween(new Date(), lastGen) < cfg.cooldownDays) continue;

    let ctaType: Candidate["ctaType"] | null = null;
    if (s.type === "SPIKE_DEMAND") {
      if (!inventoryOk) continue;
      ctaType = "PUSH_THIS_WEEK";
    } else if (s.type === "NO_RESULTS_SPIKE") {
      ctaType = "FIX_THIS";
    } else if (s.type === "HIGH_INTEREST_LOW_CONVERSION") {
      ctaType = "REPOSITION_THIS";
    }

    if (!ctaType) continue;

    // Priority proxy: confidence + effect size + volume (if available)
    const delta = typeof (s.evidenceJson as any)?.delta_wow_pct === "number" ? (s.evidenceJson as any).delta_wow_pct : 0;
    const volume = typeof searches === "number" ? searches : 0;
    const priorityScore = s.confidence * 100 + Math.min(200, Math.abs(delta)) + Math.log10(Math.max(1, volume)) * 10;

    candidates.push({
      ctaType,
      entityType: s.entityType,
      entityKey: s.entityKey,
      evidenceJson: (s.evidenceJson ?? {}) as Prisma.InputJsonValue,
      confidence: s.confidence,
      priorityScore
    });
  }

  // Deduplicate by (entityType, entityKey): keep highest priorityScore
  const bestByEntity = new Map<string, Candidate>();
  for (const c of candidates) {
    const k = `${c.entityType}:${c.entityKey}`;
    const existing = bestByEntity.get(k);
    if (!existing || c.priorityScore > existing.priorityScore) bestByEntity.set(k, c);
  }

  const deduped = Array.from(bestByEntity.values()).sort(
    (a, b) => b.priorityScore - a.priorityScore
  );

  const selected = deduped.slice(0, cfg.maxCtasPerWeek);

  // Persist (no wrapping transaction for Neon compat — upserts are idempotent)
  let upserted = 0;
  for (let idx = 0; idx < selected.length; idx++) {
    const c = selected[idx]!;
    const priority = idx + 1;
    const recommendedAction = recommendedActionFor(c.ctaType, c);

    await prisma.insight.upsert({
      where: {
        storeId_weekStart_ctaType_entityType_entityKey: {
          storeId: params.storeId,
          weekStart: params.weekStart,
          ctaType: c.ctaType,
          entityType: c.entityType,
          entityKey: c.entityKey
        }
      },
      create: {
        storeId: params.storeId,
        weekStart: params.weekStart,
        ctaType: c.ctaType,
        entityType: c.entityType,
        entityKey: c.entityKey,
        priority,
        confidence: c.confidence,
        evidenceJson: c.evidenceJson,
        recommendedAction,
        status: "ACTIVE"
      },
      update: {
        priority,
        confidence: c.confidence,
        evidenceJson: c.evidenceJson,
        recommendedAction,
        status: "ACTIVE"
      }
    });

    await prisma.insightCooldown.upsert({
      where: {
        storeId_entityType_entityKey: {
          storeId: params.storeId,
          entityType: c.entityType,
          entityKey: c.entityKey
        }
      },
      create: {
        storeId: params.storeId,
        entityType: c.entityType,
        entityKey: c.entityKey,
        lastGeneratedAt: new Date()
      },
      update: {
        lastGeneratedAt: new Date()
      }
    });

    upserted += 1;
  }

  return {
    ok: true,
    storeId: params.storeId,
    weekStart: params.weekStart,
    candidates: candidates.length,
    selected: selected.length,
    insightsUpserted: upserted
  };
}

