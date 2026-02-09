import { normalizeQuery } from "./queryNorm.js";

const VARIETALS = [
  "cabernet sauvignon",
  "cabernet",
  "pinot noir",
  "pinot",
  "chardonnay",
  "sauvignon blanc",
  "syrah",
  "shiraz",
  "merlot",
  "riesling",
  "malbec",
  "nebbiolo",
  "sangiovese",
  "grenache",
  "tempranillo",
  "zinfandel",
  "rosé",
  "rose",
  "sparkling",
  "prosecco",
  "champagne"
] as const;

export function classifyTopicFromQuery(
  queryRaw: string,
  wineryNames: string[]
): string {
  const q = normalizeQuery(queryRaw);
  if (!q) return "other";

  // Winery match (store-specific).
  const normWineries = wineryNames
    .map((w) => normalizeQuery(w))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const w of normWineries) {
    if (w.length >= 3 && q.includes(w)) return w;
  }

  // Varietal taxonomy (global).
  for (const v of VARIETALS) {
    const vn = normalizeQuery(v);
    if (vn && q.includes(vn)) return vn;
  }

  return "other";
}

