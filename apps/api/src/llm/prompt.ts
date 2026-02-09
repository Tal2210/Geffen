import type { CtaType, EntityType } from "@prisma/client";

export function buildVoicePrompt(input: {
  ctaType: CtaType;
  entityType: EntityType;
  entityKey: string;
  evidenceSummary: string;
  recommendedAction: string;
}) {
  const system = `You are the voice layer for Geffen Brain, a decision co-pilot for wine & beverage e-commerce managers in Israel.

Your role: receive deterministic trend data (numbers, behavioral insights) and produce clear, actionable recommendations in HEBREW.

Voice & Tone:
- Write like a trusted advisor, not a salesperson
- Be calm, confident, and practical
- Focus on WHY something matters and WHAT to do next
- No hype, no buzzwords, no "AI predicts" or "algorithm recommends"
- Use language like: "This week, customer interest is shifting toward...", "We recommend focusing on...", "This is worth acting on now because..."

Rules:
- Write ALL content in Hebrew
- NO emojis anywhere
- Do NOT invent numbers or claims — only reference the provided evidence
- Do NOT mention inventory, restocking, or stock levels
- Return STRICT JSON only. No markdown, no extra keys.

The JSON must have EXACTLY these keys:
{
  "title": "כותרת קצרה וברורה בעברית",
  "explanation": "הסבר של 2-3 משפטים בעברית על מה קורה ולמה זה חשוב עכשיו",
  "newsletter_subject": "שורת נושא למייל ניוזלטר",
  "newsletter_body": "גוף המייל - 2-3 פסקאות בעברית, מקצועי וחם",
  "social_talking_points": "נקודות דיבור לפוסט ברשתות חברתיות - 3-5 נקודות קצרות, מופרדות בירידות שורה"
}`;

  const ctaContext: Record<string, string> = {
    PROMOTE_THIS_THEME: "המלצה לקדם נושא/קטגוריה — ההתנהגות של הלקוחות מראה ביקוש גובר או קבוע לנושא הזה. צריך להדגיש אותו בהומפייג', בקמפיינים, ובהמלצות.",
    FIX_THIS_ISSUE: "בעיה שצריכה תיקון — משהו פה לא עובד טוב. העניין יורד, או שאנשים מחפשים ולא מוצאים. צריך לבדוק מיצוב, רלוונטיות בחיפוש, או מבנה קטגוריות.",
    TALK_ABOUT_THIS: "זווית תוכן להשבוע — משהו רלוונטי עכשיו שכדאי להפוך לסיפור. בין אם זה עיתוי (שעות שיא), עונתיות, או נושא שצובר תאוצה. צריך לתקשר על זה בניוזלטר ובסושיאל."
  };

  const user = `סוג המלצה: ${input.ctaType}
הקשר: ${ctaContext[input.ctaType] ?? ""}

ישות: ${input.entityType} = "${input.entityKey}"

נתונים (דטרמיניסטיים, מבוססי מספרים):
${input.evidenceSummary}

פעולה מומלצת:
${input.recommendedAction}

כתוב את התוכן בעברית. ללא אימוג'ים. החזר JSON בלבד.`;

  return { system, user };
}
