# Geffen Brain (MVP)

Deterministic decision engine for wine & beverage commerce.

- **Raw behavioral events live in MongoDB** (source of truth), in two streams:
  - **private**: per-tenant events, keyed by an opaque `tenantId` (not a store name)
  - **global**: a **sanitized pooled dataset** with no tenant identifiers
- **Analysis is deterministic** (jobs compute aggregations/signals/CTAs in Postgres).
- **LLM is voice-only** (JSON copy generation), never used for analysis.
- Output is a small set of **recommended actions** (CTAs), not a dashboard.

## Prereqs

- Node.js (Corepack available)
- `pnpm` via Corepack (no global install required)
- MongoDB + Postgres (recommended: Docker)

Notes:
- This repo includes `docker-compose.yml`, but if `docker` isn’t installed on your machine, you can run Mongo/Postgres however you prefer (just set `MONGO_URI`, `MONGO_DB`, `DATABASE_URL`).

## Setup

1. Install deps

```bash
corepack pnpm install
```

2. Create `.env`

Copy `.env.example` to `.env` and set `DATABASE_URL`, `MONGO_URI`, `MONGO_DB`.
(If `.env.example` is hidden on your system, you can also use `env.example`.)

3. Start Postgres (optional via Docker)

```bash
docker compose up -d
```

4. Apply migrations

```bash
corepack pnpm exec prisma migrate deploy
```

5. Run API + Web

```bash
corepack pnpm dev:api
corepack pnpm dev:web
```

## End-to-end demo flow (API)

### 1) Ingest demo events

```bash
corepack pnpm --filter @geffen-brain/api seed:demo
```

Note: `POST /events` returns a `tenant_id`. Use that tenant id for tenant-specific jobs.\n+
### 2) Run pipeline

Pick a `week_start` (ISO date string) that matches your current ISO week start (UTC Monday). Then run:

```bash
# Aggregations (week defaults to current ISO week UTC)
curl -X POST http://localhost:4000/jobs/run-aggregations \
  -H 'content-type: application/json' \
  -d '{"store_id":"demo-store"}'

curl -X POST http://localhost:4000/jobs/run-signals \
  -H 'content-type: application/json' \
  -d '{"store_id":"demo-store","week_start":"2026-02-02"}'

curl -X POST http://localhost:4000/jobs/run-decisions \
  -H 'content-type: application/json' \
  -d '{"store_id":"demo-store","week_start":"2026-02-02"}'
```

### 3) (Optional) Generate voice copy via LLM

Set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, then:

```bash
curl -X POST http://localhost:4000/jobs/run-llm \
  -H 'content-type: application/json' \
  -d '{"store_id":"demo-store","week_start":"2026-02-02","audience":"retailer"}'
```

### 4) Fetch insights

```bash
curl "http://localhost:4000/insights?store_id=demo-store"
```

### Global insights

Use `store_id=global` to compute and view global pooled insights:

```bash
curl -X POST http://localhost:4000/jobs/run-aggregations \
  -H 'content-type: application/json' \
  -d '{"store_id":"global"}'

curl "http://localhost:4000/insights?store_id=global"
```

## UI

The web app shows one screen: **Recommended Actions This Week**.

Configuration via `apps/web` env:
- `VITE_API_BASE` (default `http://localhost:4000`)
- `VITE_STORE_ID` (default `demo-store`)

You can copy `apps/web/env.example` to `apps/web/.env` to override these.

