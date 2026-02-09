import "dotenv/config";
import { buildDemoEvents } from "./demoEvents.js";

const API_BASE = process.env.API_BASE ?? "http://localhost:4000";

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const demo = buildDemoEvents();
  console.log(await post("/events", demo));

  const weekStart = new Date(); // server calculates if omitted; here we send explicit ISO week start for signals/decisions/llm later.
  console.log({ note: "Run /jobs/run-aggregations next with store_id only (week defaults to current ISO week UTC)." });

  void weekStart;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

