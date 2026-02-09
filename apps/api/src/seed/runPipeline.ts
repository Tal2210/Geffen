import "dotenv/config";
import { startOfIsoWeek, toDateOnlyUtc } from "../domain/week.js";

const API_BASE = process.env.API_BASE ?? "http://localhost:4000";
const STORE_ID = process.env.STORE_ID ?? "demo-store";
const WEEK_START = process.env.WEEK_START
  ? new Date(process.env.WEEK_START)
  : toDateOnlyUtc(startOfIsoWeek(new Date()));

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function get(path: string) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const week_start = WEEK_START.toISOString().slice(0, 10);

  console.log(await post("/jobs/run-aggregations", { store_id: STORE_ID }));
  console.log(await post("/jobs/run-signals", { store_id: STORE_ID, week_start }));
  console.log(await post("/jobs/run-decisions", { store_id: STORE_ID, week_start }));

  if (process.env.RUN_LLM === "1") {
    console.log(
      await post("/jobs/run-llm", {
        store_id: STORE_ID,
        week_start,
        audience: process.env.AUDIENCE ?? "retailer"
      })
    );
  } else {
    console.log({ note: "Skipping LLM. Set RUN_LLM=1 to generate voice copy." });
  }

  console.log(await get(`/insights?store_id=${encodeURIComponent(STORE_ID)}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

