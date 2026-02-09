export type InsightCopy = {
  audience: "retailer" | "winery" | "bar";
  title: string;
  explanation: string;
  newsletter_subject: string;
  newsletter_body: string;
  social_talking_points: string;
  model: string;
  created_at: string;
};

export type Insight = {
  id: string;
  week_start: string;
  cta_type: string;
  entity_type: string;
  entity_key: string;
  priority: number;
  confidence: number;
  evidence: Record<string, unknown>;
  recommended_action: string;
  status: string;
  copy: InsightCopy[];
};

const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "http://localhost:4000";

function getStoreId(): string {
  const fromQuery = new URLSearchParams(window.location.search).get("store_id");
  return (
    fromQuery ??
    (import.meta as any).env?.VITE_STORE_ID ??
    "global"
  );
}

export async function fetchInsights(): Promise<{ storeId: string; insights: Insight[] }> {
  const storeId = getStoreId();
  const res = await fetch(`${API_BASE}/insights?store_id=${encodeURIComponent(storeId)}`);
  if (!res.ok) throw new Error(`Failed to fetch insights: ${res.status}`);
  const json = await res.json();
  return { storeId, insights: json.insights as Insight[] };
}

export async function generateReport(storeId?: string): Promise<{ generated: number; errors?: string[] }> {
  const sid = storeId ?? getStoreId();
  const res = await fetch(`${API_BASE}/jobs/run-llm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ store_id: sid, audience: "retailer" })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to generate report: ${res.status} ${text}`);
  }
  return res.json();
}

export async function sendFeedback(insightId: string, kind: "EXECUTED" | "NOT_RELEVANT") {
  const res = await fetch(`${API_BASE}/insights/${encodeURIComponent(insightId)}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind })
  });
  if (!res.ok) throw new Error(`Failed to send feedback: ${res.status}`);
}

export function groupByType(insights: Insight[]): Map<string, Insight[]> {
  const map = new Map<string, Insight[]>();
  for (const ins of insights) {
    if (!map.has(ins.cta_type)) map.set(ins.cta_type, []);
    map.get(ins.cta_type)!.push(ins);
  }
  return map;
}
