import type { FastifyPluginAsync } from "fastify";
import {
  OnboardingDemoSearchRequestSchema,
  OnboardingStartRequestSchema,
  OnboardingTrackEventSchema,
} from "../types/index.js";
import type { OnboardingService } from "../services/onboardingService.js";
import type { OnboardingWorker } from "../services/onboardingWorker.js";
import { getMerchantId } from "../middleware/auth.js";

export function createOnboardingRoutes(
  onboardingService: OnboardingService,
  onboardingWorker: OnboardingWorker
): FastifyPluginAsync {
  return async (server) => {
    server.get("/onboarding/categories", async () => {
      return {
        categories: onboardingService.listCategories(),
      };
    });

    server.post("/onboarding/start", async (request, reply) => {
      const parsed = OnboardingStartRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }

      try {
        const result = await onboardingService.startJob(parsed.data, {
          ip: request.ip,
          userAgent: String(request.headers["user-agent"] || ""),
        });
        server.log.info(
          {
            jobId: result.jobId,
            websiteUrl: parsed.data.websiteUrl,
            category: parsed.data.category,
          },
          "Onboarding job created"
        );
        return reply.status(202).send(result);
      } catch (error) {
        const code = mapOnboardingErrorCode(error);
        return reply.status(code === "rate_limit_exceeded" ? 429 : 400).send({
          error: code,
          message: toOnboardingErrorMessage(code),
        });
      }
    });

    server.get<{ Params: { jobId: string } }>("/onboarding/jobs/:jobId", async (request, reply) => {
      const jobId = String(request.params?.jobId || "").trim();
      if (!jobId) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "Missing jobId",
        });
      }

      const status = await onboardingService.getJobStatus(jobId);
      if (!status) {
        return reply.status(404).send({
          error: "not_found",
          message: "Job not found",
        });
      }

      return reply.send(status);
    });

    server.get<{ Params: { token: string } }>("/onboarding/demos/:token", async (request, reply) => {
      const token = String(request.params?.token || "").trim();
      if (!token) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "Missing demo token",
        });
      }

      const demo = await onboardingService.getDemoByToken(token);
      if (!demo) {
        return reply.status(410).send({
          error: "token_expired",
          message: "Demo link expired or invalid",
        });
      }

      return reply.send(demo);
    });

    server.post<{ Params: { token: string } }>(
      "/onboarding/demos/:token/search",
      async (request, reply) => {
        const token = String(request.params?.token || "").trim();
        if (!token) {
          return reply.status(400).send({
            error: "invalid_request",
            message: "Missing demo token",
          });
        }

        const parsed = OnboardingDemoSearchRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            error: "invalid_request",
            issues: parsed.error.issues,
          });
        }

        const result = await onboardingService.searchDemoByToken(token, parsed.data);
        if (!result) {
          return reply.status(410).send({
            error: "token_expired",
            message: "Demo link expired or invalid",
          });
        }

        return reply.send(result);
      }
    );

    server.post("/onboarding/track", async (request, reply) => {
      const parsed = OnboardingTrackEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsed.error.issues,
        });
      }

      await onboardingService.trackEvent(parsed.data, {
        ip: request.ip,
        userAgent: String(request.headers["user-agent"] || ""),
      });

      return reply.status(202).send({ ok: true });
    });

    // Protected endpoint (auth middleware still applies).
    server.get("/onboarding/internal/health", async (request, reply) => {
      getMerchantId(request);
      return reply.send({
        ok: true,
        worker: onboardingWorker.getHealth(),
        stats: await onboardingService.getWorkerHealth(),
      });
    });
  };
}

function mapOnboardingErrorCode(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  if (message.includes("rate_limit_exceeded")) return "rate_limit_exceeded";
  if (message.includes("invalid_url")) return "invalid_url";
  return "invalid_request";
}

function toOnboardingErrorMessage(code: string): string {
  switch (code) {
    case "rate_limit_exceeded":
      return "Too many onboarding attempts. Please wait a few minutes.";
    case "invalid_url":
      return "Please provide a valid public website URL.";
    default:
      return "Invalid onboarding request.";
  }
}
