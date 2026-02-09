import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { runAggregations } from "../jobs/runAggregations.js";
import { runSignals } from "../engines/signalsEngine.js";
import { runDecisions } from "../engines/decisionEngine.js";
import { runLlm } from "../jobs/runLlm.js";

const RunAggregationsBody = z.object({
  store_id: z.string().min(1),
  week_start: z.string().optional() // ISO date; optional
});

const RunSignalsBody = z.object({
  store_id: z.string().min(1),
  week_start: z.string().min(1)
});

const RunDecisionsBody = z.object({
  store_id: z.string().min(1),
  week_start: z.string().min(1)
});

const RunLlmBody = z.object({
  store_id: z.string().min(1),
  week_start: z.string().optional(),
  audience: z.enum(["retailer", "winery", "bar"]).default("retailer")
});

export const jobsRoutes: FastifyPluginAsync = async (server) => {
  server.post("/jobs/run-aggregations", async (req, reply) => {
    const parsed = RunAggregationsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues
      });
    }

    const weekStart = parsed.data.week_start
      ? new Date(parsed.data.week_start)
      : undefined;

    const result = await runAggregations({
      storeId: parsed.data.store_id,
      weekStart
    });

    return reply.send(result);
  });

  server.post("/jobs/run-signals", async (req, reply) => {
    const parsed = RunSignalsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues
      });
    }

    const result = await runSignals({
      storeId: parsed.data.store_id,
      weekStart: new Date(parsed.data.week_start)
    });

    return reply.send(result);
  });

  server.post("/jobs/run-decisions", async (req, reply) => {
    const parsed = RunDecisionsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues
      });
    }

    const result = await runDecisions({
      storeId: parsed.data.store_id,
      weekStart: new Date(parsed.data.week_start)
    });

    return reply.send(result);
  });

  server.post("/jobs/run-llm", async (req, reply) => {
    const parsed = RunLlmBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues
      });
    }

    // If week_start not provided, auto-detect from latest active insights
    let weekStart: Date;
    if (parsed.data.week_start) {
      weekStart = new Date(parsed.data.week_start);
    } else {
      const latest = await import("../db/prisma.js").then(m => m.prisma.insight.findFirst({
        where: { storeId: parsed.data.store_id, status: "ACTIVE" },
        orderBy: { weekStart: "desc" },
        select: { weekStart: true }
      }));
      if (!latest) {
        return reply.status(404).send({ error: "No active insights found for this store" });
      }
      weekStart = latest.weekStart;
    }

    const result = await runLlm({
      storeId: parsed.data.store_id,
      weekStart,
      audience: parsed.data.audience
    });

    return reply.send(result);
  });
};

