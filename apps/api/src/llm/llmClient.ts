import { loadEnv } from "../env.js";

export type ChatMessage = {
  role: "system" | "user";
  content: string;
};

export type LlmClient = {
  chatJson: (args: {
    messages: ChatMessage[];
    model?: string;
  }) => Promise<unknown>;
};

function buildUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export function createLlmClient(): LlmClient {
  const env = loadEnv();
  const baseUrl = env.LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? "";
  const apiKey = env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? "";
  const defaultModel = env.LLM_MODEL ?? "";

  async function chatJson(args: { messages: ChatMessage[]; model?: string }) {
    if (!baseUrl || !apiKey || !(args.model ?? defaultModel)) {
      throw new Error(
        "LLM is not configured. Set OPENAI_BASE_URL/OPENAI_API_KEY (or LLM_BASE_URL/LLM_API_KEY) and LLM_MODEL."
      );
    }

    const MAX_RETRIES = 5;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // OpenAI-compatible Chat Completions API.
      const res = await fetch(buildUrl(baseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: args.model ?? defaultModel,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: args.messages
        })
      });

      if (res.status === 429 && attempt < MAX_RETRIES) {
        // Parse retry delay from response if available, otherwise use exponential backoff
        const body = await res.text().catch(() => "");
        let delay = Math.min(2000 * Math.pow(2, attempt), 60000); // 2s, 4s, 8s, 16s, 32s, max 60s
        try {
          const parsed = JSON.parse(body);
          const retryInfo = parsed?.error?.details?.find((d: any) => d["@type"]?.includes("RetryInfo"));
          if (retryInfo?.retryDelay) {
            const seconds = parseInt(retryInfo.retryDelay, 10);
            if (seconds > 0) delay = (seconds + 1) * 1000;
          }
        } catch {}
        console.log(`LLM rate limited (429). Retrying in ${(delay / 1000).toFixed(0)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        lastError = new Error(`LLM request failed: 429 (rate limited)`);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LLM request failed: ${res.status} ${text}`);
      }

      const json = (await res.json()) as any;
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("LLM returned empty content");
      }

      try {
        return JSON.parse(content);
      } catch (e) {
        throw new Error(`LLM returned non-JSON content: ${(e as Error).message}`);
      }
    }

    throw lastError ?? new Error("LLM request failed after max retries");
  }

  return { chatJson };
}
