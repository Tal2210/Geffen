import type { Env } from "../types/index.js";

type ExplainInput = {
  id: string;
  name: string;
  description?: string;
  color?: string;
  country?: string;
  grapes?: string[];
};

type ExplainOutput = {
  intro: string;
  reasons: Array<{ id: string; reason: string }>;
};

export class ProductExplanationService {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private enabled: boolean;

  constructor(env: Env) {
    this.apiKey = env.LLM_API_KEY || env.OPENAI_API_KEY || "";
    this.baseUrl = (env.LLM_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    this.model = env.LLM_MODEL || env.NER_MODEL || "gpt-4.1-mini";
    this.enabled = Boolean(this.apiKey);
  }

  async explain(query: string, products: ExplainInput[]): Promise<ExplainOutput> {
    if (products.length === 0) {
      return {
        intro: "לא נמצאו מוצרים מתאימים כרגע.",
        reasons: [],
      };
    }

    if (!this.enabled) {
      return this.fallback(query, products);
    }

    try {
      const compactProducts = products.slice(0, 8).map((p) => ({
        id: p.id,
        name: p.name,
        description: this.toPlainText(p.description).slice(0, 260),
        color: p.color,
        country: p.country,
        grapes: p.grapes?.slice(0, 3),
      }));

      const prompt = [
        "אתה סומלייה דיגיטלי לחנות יין.",
        "כתוב הסבר קצר למה המוצרים מתאימים לשאילתת המשתמש.",
        "החזר JSON בלבד ללא markdown.",
        "",
        "Schema:",
        "{",
        '  "intro": "משפט קצר אחד בעברית",',
        '  "reasons": [',
        '    { "id": "product id", "reason": "עד 22 מילים בעברית, ברור ולא שיווקי מדי" }',
        "  ]",
        "}",
        "",
        `Query: ${query}`,
        `Products: ${JSON.stringify(compactProducts)}`,
      ].join("\n");

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        console.error("[ProductExplanationService] LLM non-OK response", {
          status: res.status,
          body: errorBody.slice(0, 500),
        });
        return this.fallback(query, products);
      }

      const data: any = await res.json();
      const text: string | undefined = data?.choices?.[0]?.message?.content ?? undefined;

      if (!text) return this.fallback(query, products);

      const cleaned = this.extractJson(text);
      if (!cleaned) return this.fallback(query, products);

      const parsed = JSON.parse(cleaned);
      const reasons = Array.isArray(parsed?.reasons)
        ? parsed.reasons
            .map((r: any) => ({
              id: String(r?.id || ""),
              reason: String(r?.reason || "").trim(),
            }))
            .filter((r: { id: string; reason: string }) => r.id && r.reason)
        : [];

      if (reasons.length === 0) return this.fallback(query, products);

      return {
        intro:
          typeof parsed?.intro === "string" && parsed.intro.trim()
            ? parsed.intro.trim()
            : "המוצרים נבחרו לפי התאמה לשאילתה ולמאפייני היין.",
        reasons,
      };
    } catch (error) {
      console.error(
        "[ProductExplanationService] LLM request failed",
        error instanceof Error ? error.message : error
      );
      return this.fallback(query, products);
    }
  }

  private fallback(query: string, products: ExplainInput[]): ExplainOutput {
    const q = query.toLowerCase();
    const reasons = products.map((p) => {
      const hints: string[] = [];
      if (p.color && q.includes(p.color.toLowerCase())) hints.push(`צבע ${p.color}`);
      if (p.country && q.includes(p.country.toLowerCase())) hints.push(`ארץ ${p.country}`);
      if (p.grapes?.length) hints.push(`זן ${p.grapes[0]}`);

      return {
        id: p.id,
        reason:
          hints.length > 0
            ? `מתאים לשאילתה בזכות ${hints.join(", ")} ותיאור פרופיל הטעם של המוצר.`
            : "מתאים לשאילתה לפי התאמה סמנטית בין הביטוי שחיפשת לבין תיאור היין.",
      };
    });

    return {
      intro: "ההמלצות מבוססות על התאמה סמנטית בין השאילתה שלך לבין תיאורי המוצרים.",
      reasons,
    };
  }

  private extractJson(raw: string): string | null {
    let s = raw.trim();
    if (s.startsWith("```")) {
      s = s.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```$/m, "").trim();
    }
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return s.slice(start, end + 1);
  }

  private toPlainText(value?: string): string {
    if (!value) return "";
    return value
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}
