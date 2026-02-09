import type { Env, ExtractedFilters } from "../types/index.js";

type NerResult = {
  filters: ExtractedFilters;
  confidence?: number;
  language?: "he" | "en" | "mixed" | "unknown";
};

/**
 * LLM-backed entity extraction (NER-ish) for wine search queries.
 *
 * Returns structured filters (color/country/sweetness/grapes/price/kosher/regions)
 * without relying purely on regex rules.
 *
 * Uses Google Gemini REST API directly.
 */
export class EntityExtractionService {
  private apiKey: string;
  private model: string;
  private enabled: boolean;

  constructor(env: Env) {
    this.apiKey = env.LLM_API_KEY || "";
    this.model = env.NER_MODEL || "models/gemini-2.0-flash-lite";
    this.enabled = Boolean(env.NER_ENABLED) && Boolean(this.apiKey);
  }

  isEnabled() {
    return this.enabled;
  }

  async extract(query: string): Promise<NerResult> {
    if (!this.enabled) {
      return { filters: {} };
    }

    // Hard timeout so search never hangs on NER.
    const controller = new AbortController();
    const timeoutMs = 2500;
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const modelPath = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
      const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${this.apiKey}`;

      const prompt = [
        "You are an NER engine for a wine e-commerce search query.",
        "Extract structured filters from the query. Output ONLY valid JSON.",
        "Do not wrap the JSON in markdown code fences.",
        "",
        "Schema:",
        "{",
        '  "filters": {',
        '    "countries"?: string[],',
        '    "regions"?: string[],',
        '    "grapes"?: string[],',
        '    "sweetness"?: string[],',
        '    "type"?: string[],',
        '    "category"?: string[],',
        '    "softTags"?: string[],',
        '    "kosher"?: boolean,',
        '    "priceRange"?: { "min"?: number, "max"?: number }',
        "  },",
        '  "confidence"?: number,',
        '  "language"?: "he"|"en"|"mixed"|"unknown"',
        "}",
        "",
        "Rules:",
        "- Prefer canonical values:",
        "  sweetness: dry|semi-dry|sweet",
        "  type: wine|beer|vodka|whiskey|liqueur|gin|rum|tequila|brandy|soda",
        "  category: red|white|rosé|sparkling",
        "  softTags: free-form tags like pizza, portugal, bordeaux, etc.",
        "  countries: france|italy|spain|usa|argentina|chile|australia|germany|portugal|israel",
        "- If user asks 'עד 100' or 'under 100' set priceRange.max=100",
        "- If uncertain, omit the field.",
        "- Hebrew examples:",
        "  'יין אדום ישראלי יבש' => countries:['israel'], sweetness:['dry'], type:['wine'], category:['red']",
        "  'וודקה איכותית מרוסיה' => type:['vodka'], countries:['russia']",
        "  'בירה בלגית קלה' => type:['beer'], countries:['belgium']",
        "  'יין מפורטוגל לפיצה' => type:['wine'], softTags:['portugal','pizza']",
        "",
        `Query: ${query}`,
      ].join("\n");

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Fail open: no NER.
        return { filters: {} };
      }

      const data: any = await res.json();
      const text: string | undefined =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ??
        data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).join("") ??
        undefined;

      if (!text) return { filters: {} };

      // Be robust: model may wrap JSON in markdown fences or add commentary.
      const cleaned = this.extractJson(text);
      if (!cleaned) return { filters: {} };
      const parsed = JSON.parse(cleaned);
      const filters = (parsed?.filters ?? {}) as ExtractedFilters;

      return {
        filters,
        confidence: typeof parsed?.confidence === "number" ? parsed.confidence : undefined,
        language: parsed?.language,
      };
    } catch {
      return { filters: {} };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Extract a JSON object string from model output.
   * Handles cases like:
   * ```json
   * { ... }
   * ```
   */
  private extractJson(raw: string): string | null {
    let s = raw.trim();

    // Strip markdown code fences if present
    if (s.startsWith("```")) {
      // remove leading ```json / ``` and trailing ```
      s = s.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```$/m, "").trim();
    }

    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return s.slice(start, end + 1);
  }
}

