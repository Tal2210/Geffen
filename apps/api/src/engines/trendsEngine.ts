/**
 * Trends Engine — Google-Trends-style analysis of raw search queries.
 *
 * Reads search_events from Mongo, normalizes queries, builds time series,
 * and detects: velocity (rising/declining), seasonal patterns, peak hours,
 * emerging queries, and evergreen leaders.
 *
 * All analysis is deterministic (no LLM). Pure math on timestamps + query strings.
 */

import { normalizeQuery } from "../domain/queryNorm.js";
import { CALENDAR_EVENTS, matchCalendarEvents, type CalendarEvent } from "../domain/calendarEvents.js";

// ── Types ────────────────────────────────────────────────────

export type RawSearch = {
  query: string;
  timestamp: Date;
};

export type TrendDirection = "RISING" | "STABLE" | "DECLINING";

export type QueryTimeSeries = {
  queryNorm: string;
  queryRaw: string; // most common raw form
  totalVolume: number;
  /** Weekly buckets: ISO week string → count */
  weekly: Map<string, number>;
  /** Monthly buckets: "YYYY-MM" → count */
  monthly: Map<string, number>;
  /** Hourly buckets: 0–23 → count */
  hourly: number[];
  /** First seen date */
  firstSeen: Date;
  /** Last seen date */
  lastSeen: Date;
};

export type TrendInsight = {
  type: "PROMOTE_THIS_THEME" | "FIX_THIS_ISSUE" | "TALK_ABOUT_THIS";
  entityKey: string;
  confidence: number;
  evidence: Record<string, unknown>;
  recommendedAction: string;
};

// ── Helpers ──────────────────────────────────────────────────

function toIsoWeek(d: Date): string {
  // ISO week: Monday-based. Returns "YYYY-Www".
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function toMonthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function extractTs(doc: any): Date | null {
  const raw = doc.ts ?? doc.timestamp ?? doc.createdAt;
  if (!raw) return null;
  if (typeof raw === "number") {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = raw instanceof Date ? raw : new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** Standard deviation */
function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sq = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(sq.reduce((a, b) => a + b, 0) / values.length);
}

/** Coefficient of variation (lower = more consistent) */
function coeffOfVariation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  return stddev(values) / mean;
}

// ── Core Engine ──────────────────────────────────────────────

export type TrendsConfig = {
  /** Minimum total searches for a query to be considered */
  minVolume: number;
  /** Number of recent weeks to consider "recent" for velocity */
  recentWeeks: number;
  /** Velocity threshold (%) to count as rising/declining */
  velocityThresholdPct: number;
  /** Max weeks since first appearance to count as "emerging" */
  emergingMaxWeeks: number;
  /** Min volume for an emerging query to be interesting */
  emergingMinVolume: number;
  /** Max insights to return per type */
  maxPerType: number;
};

export const DEFAULT_TRENDS_CONFIG: TrendsConfig = {
  minVolume: 10,
  recentWeeks: 4,
  velocityThresholdPct: 25,
  emergingMaxWeeks: 6,
  emergingMinVolume: 5,
  maxPerType: 5
};

/**
 * Build time series for each normalized query from raw Mongo documents.
 */
export function buildTimeSeries(docs: any[]): Map<string, QueryTimeSeries> {
  const series = new Map<string, QueryTimeSeries>();
  // Track the most common raw form per normalized query.
  const rawCounts = new Map<string, Map<string, number>>();

  for (const doc of docs) {
    const rawQuery: string = doc.query ?? doc.search_query ?? "";
    if (!rawQuery) continue;
    const ts = extractTs(doc);
    if (!ts) continue;

    const norm = normalizeQuery(rawQuery);
    if (!norm) continue;

    // Track raw form frequency.
    if (!rawCounts.has(norm)) rawCounts.set(norm, new Map());
    const rc = rawCounts.get(norm)!;
    rc.set(rawQuery, (rc.get(rawQuery) ?? 0) + 1);

    const weekKey = toIsoWeek(ts);
    const monthKey = toMonthKey(ts);
    const hour = ts.getUTCHours();

    let entry = series.get(norm);
    if (!entry) {
      entry = {
        queryNorm: norm,
        queryRaw: rawQuery,
        totalVolume: 0,
        weekly: new Map(),
        monthly: new Map(),
        hourly: new Array(24).fill(0),
        firstSeen: ts,
        lastSeen: ts
      };
      series.set(norm, entry);
    }

    entry.totalVolume += 1;
    entry.weekly.set(weekKey, (entry.weekly.get(weekKey) ?? 0) + 1);
    entry.monthly.set(monthKey, (entry.monthly.get(monthKey) ?? 0) + 1);
    entry.hourly[hour] += 1;
    if (ts < entry.firstSeen) entry.firstSeen = ts;
    if (ts > entry.lastSeen) entry.lastSeen = ts;
  }

  // Set queryRaw to the most common raw form.
  for (const [norm, entry] of series) {
    const rc = rawCounts.get(norm);
    if (rc) {
      let bestRaw = entry.queryRaw;
      let bestCount = 0;
      for (const [raw, count] of rc) {
        if (count > bestCount) {
          bestRaw = raw;
          bestCount = count;
        }
      }
      entry.queryRaw = bestRaw;
    }
  }

  return series;
}

/**
 * Compute velocity: compare recent N weeks to the N weeks before that.
 * Returns percent change.
 */
function computeVelocity(
  weekly: Map<string, number>,
  allWeekKeys: string[],
  recentWeeks: number
): { direction: TrendDirection; pctChange: number; recentVol: number; prevVol: number } {
  const n = allWeekKeys.length;
  if (n < recentWeeks * 2) {
    return { direction: "STABLE", pctChange: 0, recentVol: 0, prevVol: 0 };
  }

  const recentKeys = allWeekKeys.slice(-recentWeeks);
  const prevKeys = allWeekKeys.slice(-recentWeeks * 2, -recentWeeks);

  const recentVol = recentKeys.reduce((s, k) => s + (weekly.get(k) ?? 0), 0);
  const prevVol = prevKeys.reduce((s, k) => s + (weekly.get(k) ?? 0), 0);

  let pctChange = 0;
  if (prevVol > 0) {
    pctChange = ((recentVol - prevVol) / prevVol) * 100;
  } else if (recentVol > 0) {
    pctChange = 999;
  }

  const direction: TrendDirection =
    pctChange > 25 ? "RISING" : pctChange < -25 ? "DECLINING" : "STABLE";

  return { direction, pctChange, recentVol, prevVol };
}

/**
 * Main analysis: produce trend insights from time series data.
 */
export function analyzeTrends(
  series: Map<string, QueryTimeSeries>,
  config: TrendsConfig = DEFAULT_TRENDS_CONFIG
): TrendInsight[] {
  const insights: TrendInsight[] = [];

  // Get all week keys sorted chronologically.
  const allWeekKeys = new Set<string>();
  const allMonthKeys = new Set<string>();
  for (const entry of series.values()) {
    for (const k of entry.weekly.keys()) allWeekKeys.add(k);
    for (const k of entry.monthly.keys()) allMonthKeys.add(k);
  }
  const sortedWeeks = [...allWeekKeys].sort();
  const sortedMonths = [...allMonthKeys].sort();

  const now = new Date();
  const nowWeek = toIsoWeek(now);

  // Filter to queries with enough volume.
  const qualified = [...series.values()].filter((e) => e.totalVolume >= config.minVolume);

  // ── 1. Velocity: TRENDING_UP / TRENDING_DOWN ──────────────

  const velocities: Array<{ entry: QueryTimeSeries; vel: ReturnType<typeof computeVelocity> }> = [];
  for (const entry of qualified) {
    const vel = computeVelocity(entry.weekly, sortedWeeks, config.recentWeeks);
    velocities.push({ entry, vel });
  }

  // Top rising
  const rising = velocities
    .filter((v) => v.vel.direction === "RISING" && v.vel.recentVol >= config.minVolume)
    .sort((a, b) => b.vel.pctChange - a.vel.pctChange)
    .slice(0, config.maxPerType);

  for (const { entry, vel } of rising) {
    insights.push({
      type: "PROMOTE_THIS_THEME",
      entityKey: entry.queryRaw,
      confidence: Math.min(0.95, 0.5 + (vel.recentVol / 200) + (vel.pctChange / 1000)),
      evidence: {
        query: entry.queryRaw,
        queryNorm: entry.queryNorm,
        recentVolume: vel.recentVol,
        previousVolume: vel.prevVol,
        pctChange: Math.round(vel.pctChange),
        totalVolume: entry.totalVolume,
        period: `last ${config.recentWeeks} weeks vs previous ${config.recentWeeks} weeks`
      },
      recommendedAction: `Customer searches for "${entry.queryRaw}" are surging (up ${Math.round(vel.pctChange)}%) — feature this theme in homepage, campaigns, and search suggestions this week.`
    });
  }

  // Top declining
  const declining = velocities
    .filter((v) => v.vel.direction === "DECLINING" && v.vel.prevVol >= config.minVolume)
    .sort((a, b) => a.vel.pctChange - b.vel.pctChange)
    .slice(0, config.maxPerType);

  for (const { entry, vel } of declining) {
    insights.push({
      type: "FIX_THIS_ISSUE",
      entityKey: entry.queryRaw,
      confidence: Math.min(0.9, 0.4 + (vel.prevVol / 200) + Math.abs(vel.pctChange) / 1000),
      evidence: {
        query: entry.queryRaw,
        queryNorm: entry.queryNorm,
        recentVolume: vel.recentVol,
        previousVolume: vel.prevVol,
        pctChange: Math.round(vel.pctChange),
        totalVolume: entry.totalVolume,
        period: `last ${config.recentWeeks} weeks vs previous ${config.recentWeeks} weeks`
      },
      recommendedAction: `Interest in "${entry.queryRaw}" is declining (down ${Math.abs(Math.round(vel.pctChange))}%) — review product positioning, search relevance, or category placement to recover demand.`
    });
  }

  // ── 2. Seasonal / Calendar ────────────────────────────────

  // For each query, check if it has months where volume spikes AND those months
  // match a calendar event.
  for (const entry of qualified) {
    if (entry.totalVolume < config.minVolume * 2) continue;

    const monthlyVals = sortedMonths.map((m) => entry.monthly.get(m) ?? 0);
    const avgMonthly = monthlyVals.reduce((a, b) => a + b, 0) / Math.max(1, monthlyVals.length);
    if (avgMonthly < 2) continue;

    // Find months where this query spikes (>2x average).
    const spikeMonths: number[] = [];
    for (const [monthKey, vol] of entry.monthly) {
      if (vol > avgMonthly * 2) {
        const month = parseInt(monthKey.split("-")[1], 10);
        if (!spikeMonths.includes(month)) spikeMonths.push(month);
      }
    }

    if (spikeMonths.length === 0) continue;

    // Check if the query text matches any calendar event keywords.
    const calendarMatches = matchCalendarEvents(entry.queryNorm);
    // Also check if the spike months align with a calendar event's months.
    const monthAlignedEvents = CALENDAR_EVENTS.filter((ev) =>
      ev.months.some((m) => spikeMonths.includes(m))
    );

    // Combine: events that match both keywords AND month alignment.
    const strongMatches = calendarMatches.filter((ev) =>
      monthAlignedEvents.includes(ev)
    );

    if (strongMatches.length > 0) {
      const bestEvent = strongMatches[0]!;
      insights.push({
        type: "PROMOTE_THIS_THEME",
        entityKey: entry.queryRaw,
        confidence: Math.min(0.9, 0.6 + (entry.totalVolume / 500)),
        evidence: {
          query: entry.queryRaw,
          queryNorm: entry.queryNorm,
          totalVolume: entry.totalVolume,
          spikeMonths: spikeMonths.map((m) =>
            ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]
          ),
          calendarEvent: bestEvent.name,
          calendarEventHe: bestEvent.nameHe,
          avgMonthlySearches: Math.round(avgMonthly),
          monthlyBreakdown: Object.fromEntries(entry.monthly)
        },
        recommendedAction: `${bestEvent.campaignHint}. "${entry.queryRaw}" peaks around ${bestEvent.name} (${bestEvent.nameHe}) — feature it in campaigns, homepage, and social content now.`
      });
    }
  }

  // Deduplicate seasonal insights (keep top per calendar event) within PROMOTE_THIS_THEME.
  const seasonalByEvent = new Map<string, TrendInsight>();
  const nonSeasonal: TrendInsight[] = [];
  for (const ins of insights) {
    if (ins.type === "PROMOTE_THIS_THEME" && (ins.evidence as any).calendarEvent) {
      const evName = (ins.evidence as any).calendarEvent;
      const existing = seasonalByEvent.get(evName);
      if (!existing || ins.confidence > existing.confidence) {
        seasonalByEvent.set(evName, ins);
      }
    } else {
      nonSeasonal.push(ins);
    }
  }
  // Rebuild insights with deduplicated seasonal.
  insights.length = 0;
  insights.push(...nonSeasonal, ...([...seasonalByEvent.values()].slice(0, config.maxPerType)));

  // ── 3. Peak Hours ─────────────────────────────────────────

  // Global hourly distribution.
  const globalHourly = new Array(24).fill(0);
  for (const entry of series.values()) {
    for (let h = 0; h < 24; h++) globalHourly[h] += entry.hourly[h];
  }

  const totalSearches = globalHourly.reduce((a: number, b: number) => a + b, 0);
  const peakHour = globalHourly.indexOf(Math.max(...globalHourly));
  // Find the 3-hour window with highest volume.
  let bestWindowStart = 0;
  let bestWindowVol = 0;
  for (let start = 0; start < 24; start++) {
    const vol =
      globalHourly[start] +
      globalHourly[(start + 1) % 24] +
      globalHourly[(start + 2) % 24];
    if (vol > bestWindowVol) {
      bestWindowVol = vol;
      bestWindowStart = start;
    }
  }
  const windowEnd = (bestWindowStart + 3) % 24;
  const windowPct = totalSearches > 0 ? Math.round((bestWindowVol / totalSearches) * 100) : 0;

  insights.push({
    type: "TALK_ABOUT_THIS",
    entityKey: `Peak Hours ${String(bestWindowStart).padStart(2, "0")}:00-${String(windowEnd).padStart(2, "0")}:00`,
    confidence: 0.85,
    evidence: {
      peakHour,
      bestWindow: `${String(bestWindowStart).padStart(2, "0")}:00-${String(windowEnd).padStart(2, "0")}:00`,
      windowVolume: bestWindowVol,
      windowPctOfTotal: windowPct,
      totalSearches,
      hourlyDistribution: globalHourly
    },
    recommendedAction: `${windowPct}% of customer searches happen between ${String(bestWindowStart).padStart(2, "0")}:00-${String(windowEnd).padStart(2, "0")}:00. Use this timing insight for scheduling social posts, newsletter sends, and promotional content.`
  });

  // ── 4. Emerging Queries ───────────────────────────────────

  const weeksAgoThreshold = config.emergingMaxWeeks;
  const cutoffDate = new Date(now.getTime() - weeksAgoThreshold * 7 * 24 * 60 * 60 * 1000);

  const emerging = qualified
    .filter((e) => e.firstSeen >= cutoffDate && e.totalVolume >= config.emergingMinVolume)
    .sort((a, b) => b.totalVolume - a.totalVolume)
    .slice(0, config.maxPerType);

  for (const entry of emerging) {
    const weeksOld = Math.round((now.getTime() - entry.firstSeen.getTime()) / (7 * 24 * 60 * 60 * 1000));
    insights.push({
      type: "PROMOTE_THIS_THEME",
      entityKey: entry.queryRaw,
      confidence: Math.min(0.85, 0.5 + (entry.totalVolume / 100)),
      evidence: {
        query: entry.queryRaw,
        queryNorm: entry.queryNorm,
        totalVolume: entry.totalVolume,
        firstSeen: entry.firstSeen.toISOString().slice(0, 10),
        weeksOld,
        weeklyBreakdown: Object.fromEntries(entry.weekly)
      },
      recommendedAction: `"${entry.queryRaw}" is an emerging search term (${entry.totalVolume} searches in ${weeksOld} week(s)). Feature it prominently in search suggestions and homepage now to capture growing demand.`
    });
  }

  // ── 5. Evergreen Leaders ──────────────────────────────────

  // Queries with consistent *share* of monthly traffic (not raw volume,
  // because total monthly traffic varies wildly across months).
  // Compute monthly totals first.
  const monthlyTotals = new Map<string, number>();
  for (const entry of series.values()) {
    for (const [m, vol] of entry.monthly) {
      monthlyTotals.set(m, (monthlyTotals.get(m) ?? 0) + vol);
    }
  }

  // Only consider months with meaningful traffic (>100 searches).
  const significantMonths = sortedMonths.filter((m) => (monthlyTotals.get(m) ?? 0) > 100);

  const evergreenCandidates = qualified
    .filter((e) => e.monthly.size >= 3 && e.totalVolume >= config.minVolume * 5)
    .map((entry) => {
      // Compute share of voice per month, then check consistency.
      const shares = significantMonths.map((m) => {
        const total = monthlyTotals.get(m) ?? 1;
        const vol = entry.monthly.get(m) ?? 0;
        return vol / total;
      });
      const cv = coeffOfVariation(shares);
      return { entry, cv, avgShare: shares.reduce((a, b) => a + b, 0) / Math.max(1, shares.length) };
    })
    .filter((e) => e.cv < 0.8) // Consistent share of voice
    .sort((a, b) => b.entry.totalVolume - a.entry.totalVolume)
    .slice(0, config.maxPerType);

  for (const { entry, cv, avgShare } of evergreenCandidates) {
    const avgMonthly = entry.totalVolume / Math.max(1, entry.monthly.size);
    const sharePct = (avgShare * 100).toFixed(1);
    insights.push({
      type: "PROMOTE_THIS_THEME",
      entityKey: entry.queryRaw,
      confidence: Math.min(0.95, 0.7 + (entry.totalVolume / 2000)),
      evidence: {
        query: entry.queryRaw,
        queryNorm: entry.queryNorm,
        totalVolume: entry.totalVolume,
        monthsActive: entry.monthly.size,
        avgMonthlySearches: Math.round(avgMonthly),
        avgShareOfTraffic: sharePct + "%",
        shareConsistency: Math.round((1 - cv) * 100) + "%",
        monthlyBreakdown: Object.fromEntries(entry.monthly)
      },
      recommendedAction: `"${entry.queryRaw}" captures ~${sharePct}% of all searches every month consistently. Keep it prominently featured in navigation, homepage, and search suggestions year-round.`
    });
  }

  // ── Sort all insights by confidence descending ────────────

  insights.sort((a, b) => b.confidence - a.confidence);

  return insights;
}
