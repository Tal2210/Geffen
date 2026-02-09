import { prisma } from "../db/prisma.js";
import { createLlmClient } from "../llm/llmClient.js";
import { LlmVoiceJsonSchema } from "../llm/schema.js";
import { buildVoicePrompt } from "../llm/prompt.js";

export async function runLlm(params: {
  storeId: string;
  weekStart: Date;
  audience: "retailer" | "winery" | "bar";
}) {
  const client = createLlmClient();

  const insights = await prisma.insight.findMany({
    where: {
      storeId: params.storeId,
      weekStart: params.weekStart,
      status: "ACTIVE"
    },
    orderBy: [{ priority: "asc" }]
  });

  let generated = 0;
  const errors: string[] = [];

  for (const insight of insights) {
    // Skip if copy already exists for this audience.
    const existing = await prisma.insightCopy.findUnique({
      where: {
        insightId_audience: { insightId: insight.id, audience: params.audience }
      }
    });
    if (existing) continue;

    const evidence = insight.evidenceJson as Record<string, unknown>;
    const evidenceSummary = Object.entries(evidence)
      .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(2) : JSON.stringify(v)}`)
      .join("\n");

    const { system, user } = buildVoicePrompt({
      ctaType: insight.ctaType,
      entityType: insight.entityType,
      entityKey: insight.entityKey,
      evidenceSummary,
      recommendedAction: insight.recommendedAction
    });

    try {
      const raw = await client.chatJson({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      });

      const parsed = LlmVoiceJsonSchema.safeParse(raw);
      if (!parsed.success) {
        errors.push(`Insight ${insight.id}: JSON validation failed — ${parsed.error.message}`);
        continue;
      }

      await prisma.insightCopy.create({
        data: {
          insightId: insight.id,
          audience: params.audience,
          title: parsed.data.title,
          explanation: parsed.data.explanation,
          newsletterSubject: parsed.data.newsletter_subject,
          newsletterBody: parsed.data.newsletter_body,
          socialTalkingPoints: parsed.data.social_talking_points,
          model: process.env.LLM_MODEL ?? "unknown"
        }
      });

      generated += 1;
      console.log(`[runLlm] Generated copy for insight ${insight.id} (${generated}/${insights.length})`);
      // Small delay between requests to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (e) {
      errors.push(`Insight ${insight.id}: ${(e as Error).message}`);
    }
  }

  return {
    ok: errors.length === 0,
    storeId: params.storeId,
    weekStart: params.weekStart,
    audience: params.audience,
    insights: insights.length,
    generated,
    errors: errors.length > 0 ? errors : undefined
  };
}
