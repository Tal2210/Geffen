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
  private model: string;
  private enabled: boolean;

  constructor(env: Env) {
    this.apiKey = env.LLM_API_KEY || "";
    this.model = env.NER_MODEL || "models/gemini-2.0-flash-lite";
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
      const modelPath = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
      const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${this.apiKey}`;

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

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
          },
        }),
      });

      if (!res.ok) {
        return this.fallback(query, products);
      }

      const data: any = await res.json();
      const text: string | undefined =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ??
        data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).join("") ??
        undefined;

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
    } catch {
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

