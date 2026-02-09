import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db/prisma.js";

const GetInsightsQuery = z.object({
  store_id: z.string().min(1)
});

const FeedbackBody = z.object({
  kind: z.enum(["EXECUTED", "NOT_RELEVANT"]),
  note: z.string().max(2000).optional()
});

export const insightsRoutes: FastifyPluginAsync = async (server) => {
  server.get("/insights", async (req, reply) => {
    const parsed = GetInsightsQuery.safeParse((req as any).query ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues
      });
    }

    const storeId = parsed.data.store_id;

    const insights = await prisma.insight.findMany({
      where: { storeId, status: "ACTIVE" },
      orderBy: [{ weekStart: "desc" }, { priority: "asc" }],
      take: 50,
      include: {
        copy: true
      }
    });

    return reply.send({
      ok: true,
      store_id: storeId,
      insights: insights.map((i) => ({
        id: i.id,
        week_start: i.weekStart.toISOString().slice(0, 10),
        cta_type: i.ctaType,
        entity_type: i.entityType,
        entity_key: i.entityKey,
        priority: i.priority,
        confidence: i.confidence,
        evidence: i.evidenceJson,
        recommended_action: i.recommendedAction,
        status: i.status,
        copy: i.copy.map((c) => ({
          audience: c.audience,
          title: c.title,
          explanation: c.explanation,
          newsletter_subject: c.newsletterSubject,
          newsletter_body: c.newsletterBody,
          social_talking_points: c.socialTalkingPoints,
          model: c.model,
          created_at: c.createdAt.toISOString()
        }))
      }))
    });
  });

  server.post("/insights/:id/feedback", async (req, reply) => {
    const id = (req as any).params?.id as string | undefined;
    if (!id) return reply.status(400).send({ error: "invalid_request" });

    const parsed = FeedbackBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues
      });
    }

    const insight = await prisma.insight.findUnique({ where: { id } });
    if (!insight) return reply.status(404).send({ error: "not_found" });

    const nextStatus =
      parsed.data.kind === "EXECUTED" ? "EXECUTED" : "DISMISSED";

    await prisma.$transaction(async (tx) => {
      await tx.insight.update({
        where: { id },
        data: { status: nextStatus }
      });

      await tx.insightFeedback.create({
        data: {
          insightId: id,
          storeId: insight.storeId,
          kind: parsed.data.kind,
          note: parsed.data.note
        }
      });

      if (parsed.data.kind === "EXECUTED") {
        await tx.insightCooldown.upsert({
          where: {
            storeId_entityType_entityKey: {
              storeId: insight.storeId,
              entityType: insight.entityType,
              entityKey: insight.entityKey
            }
          },
          create: {
            storeId: insight.storeId,
            entityType: insight.entityType,
            entityKey: insight.entityKey,
            lastExecutedAt: new Date()
          },
          update: {
            lastExecutedAt: new Date()
          }
        });
      }
    });

    return reply.send({ ok: true });
  });
};

