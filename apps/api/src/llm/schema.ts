import { z } from "zod";

export const LlmVoiceJsonSchema = z.object({
  title: z.string(),
  explanation: z.string(),
  newsletter_subject: z.string(),
  newsletter_body: z.string(),
  social_talking_points: z.string()
});

export type LlmVoiceJson = z.infer<typeof LlmVoiceJsonSchema>;
