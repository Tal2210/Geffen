import { useEffect, useMemo, useState } from "react";

type FieldMode = "text" | "src";

interface AssistPreviewResponse {
  normalizedUrl: string;
  baseUrl: string;
  html: string;
}

interface AssistExtractSampleResponse {
  sampleProduct: {
    name?: string;
    price?: number;
    currency?: string;
    imageUrl?: string;
    description?: string;
    inStock?: boolean;
    attributes: Record<string, string>;
  };
  missingFields: string[];
}

interface CategoryPresetField {
  key: string;
  label: string;
}

interface FieldItem {
  key: string;
  label: string;
  mode: FieldMode;
  required?: boolean;
  isCustom?: boolean;
  selector?: string;
  sampleText?: string;
}

export interface GuideTemplatePayload {
  websiteUrl: string;
  productUrl: string;
  category: string;
  selectors: {
    name: { selector: string; mode: FieldMode };
    price?: { selector: string; mode: FieldMode };
    image?: { selector: string; mode: FieldMode };
    description?: { selector: string; mode: FieldMode };
    inStock?: { selector: string; mode: FieldMode };
  };
  customFields: Array<{
    key: string;
    label: string;
    selector: { selector: string; mode: FieldMode };
  }>;
}

interface Props {
  apiUrl: string;
  websiteUrl: string;
  category: string;
  onSampleReady: (data: {
    templatePayload: GuideTemplatePayload;
    sampleResult: AssistExtractSampleResponse;
    capturedCount: number;
    requiredCount: number;
  }) => void;
}

const FALLBACK_PRESETS: Record<string, CategoryPresetField[]> = {
  wine: [
    { key: "country", label: "מוצא" },
    { key: "grape", label: "זן ענבים" },
    { key: "volume", label: "נפח" },
    { key: "alcohol", label: "אחוז אלכוהול" },
    { key: "kosher", label: "כשרות" },
    { key: "winery", label: "יקב" },
    { key: "vintage", label: "בציר" },
  ],
};

const BASE_FIELDS: FieldItem[] = [
  { key: "name", label: "שם המוצר", mode: "text", required: true },
  { key: "price", label: "מחיר", mode: "text", required: true },
  { key: "description", label: "תיאור", mode: "text", required: true },
  { key: "image", label: "תמונה", mode: "src", required: true },
  { key: "inStock", label: "מצב מלאי", mode: "text" },
];

export function OnboardingAssistTrainer({
  apiUrl,
  websiteUrl,
  category,
  onSampleReady,
}: Props) {
  const [productUrl, setProductUrl] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewBaseUrl, setPreviewBaseUrl] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const [autoTried, setAutoTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [presetFields, setPresetFields] = useState<CategoryPresetField[]>([]);
  const [fields, setFields] = useState<FieldItem[]>(BASE_FIELDS);
  const [activeFieldKey, setActiveFieldKey] = useState<string>("name");
  const [newCustomLabel, setNewCustomLabel] = useState("");

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = event.data as any;
      if (!payload || payload.type !== "assist-click") return;
      const selector = String(payload.simpleSelector || payload.fullSelector || "").trim();
      if (!selector) return;

      const sampleText = String(payload.text || payload.src || payload.href || "").trim();
      setFields((prev) =>
        prev.map((item) =>
          item.key === activeFieldKey
            ? {
                ...item,
                selector,
                mode:
                  item.key === "image" && String(payload.tag || "").toLowerCase() === "img"
                    ? "src"
                    : item.mode,
                sampleText: sampleText.slice(0, 180),
              }
            : item
        )
      );
      setError(null);
      setSuccess("השדה נקלט. אפשר להמשיך לשדה הבא.");
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [activeFieldKey]);

  useEffect(() => {
    setPreviewHtml("");
    setPreviewBaseUrl("");
    setProductUrl("");
    setAutoTried(false);
    setError(null);
    setSuccess(null);
    setFields(BASE_FIELDS);
    setActiveFieldKey("name");
  }, [websiteUrl, category]);

  useEffect(() => {
    const run = async () => {
      if (!category) return;
      try {
        const response = await fetch(
          `${apiUrl}/onboarding/categories/${encodeURIComponent(category)}/fields`
        );
        const payload = await response.json();
        if (!response.ok) throw new Error();
        const rows = Array.isArray(payload?.fields) ? payload.fields : [];
        if (rows.length > 0) {
          setPresetFields(
            rows
              .map((item: any) => ({
                key: String(item?.key || "").trim(),
                label: String(item?.label || "").trim(),
              }))
              .filter((item: CategoryPresetField) => item.key && item.label)
          );
          return;
        }
      } catch {
        // fallback below
      }
      setPresetFields(FALLBACK_PRESETS[category] || []);
    };

    void run();
  }, [apiUrl, category]);

  useEffect(() => {
    if (!websiteUrl.trim()) return;
    if (autoTried) return;
    if (previewHtml) return;
    setAutoTried(true);
    void loadAutoPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [websiteUrl, autoTried, previewHtml]);

  const requiredCount = useMemo(
    () => fields.filter((item) => item.required).length,
    [fields]
  );

  const capturedRequiredCount = useMemo(
    () => fields.filter((item) => item.required && item.selector).length,
    [fields]
  );

  const capturedCount = useMemo(
    () => fields.filter((item) => item.selector).length,
    [fields]
  );

  const canCheckSample =
    Boolean(productUrl.trim()) && capturedRequiredCount >= requiredCount && !loadingPreview;

  const srcDoc = useMemo(() => {
    if (!previewHtml) return "";
    return buildPreviewDoc(previewHtml, previewBaseUrl);
  }, [previewHtml, previewBaseUrl]);

  const loadAutoPreview = async () => {
    setLoadingPreview(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch(`${apiUrl}/onboarding/assist/auto-preview`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ websiteUrl: normalizeHttpUrl(websiteUrl) }),
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<AssistPreviewResponse> & {
        message?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.message || payload.error || `Error ${response.status}`);
      }

      setPreviewHtml(String(payload.html || ""));
      setPreviewBaseUrl(String(payload.baseUrl || ""));
      if (payload.normalizedUrl) {
        setProductUrl(String(payload.normalizedUrl));
      }
      setSuccess("דף מוצר לדוגמה נטען אוטומטית. עכשיו לחץ על השדות בצד שמאל ואז על האלמנטים בתוך הדף.");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "לא הצלחנו לזהות דף מוצר אוטומטית. אפשר להזין URL ידני למוצר."
      );
    } finally {
      setLoadingPreview(false);
    }
  };

  const loadManualPreview = async () => {
    if (!productUrl.trim()) return;
    setLoadingPreview(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch(`${apiUrl}/onboarding/assist/preview`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productUrl: normalizeHttpUrl(productUrl) }),
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<AssistPreviewResponse> & {
        message?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.message || payload.error || `Error ${response.status}`);
      }

      setPreviewHtml(String(payload.html || ""));
      setPreviewBaseUrl(String(payload.baseUrl || ""));
      if (payload.normalizedUrl) {
        setProductUrl(String(payload.normalizedUrl));
      }
      setSuccess("הדף נטען. המשך לבחור שדות וללחוץ על האלמנטים המתאימים.");
    } catch (err) {
      setPreviewHtml("");
      setPreviewBaseUrl("");
      setError(err instanceof Error ? err.message : "שגיאה בטעינת הדף");
    } finally {
      setLoadingPreview(false);
    }
  };

  const addCustomField = () => {
    const label = String(newCustomLabel || "").trim();
    if (!label) return;
    const key = toFieldKey(label);
    if (!key) return;

    setFields((prev) => {
      if (prev.some((item) => item.key === key)) return prev;
      return [...prev, { key, label, mode: "text", isCustom: true }];
    });
    setNewCustomLabel("");
    setActiveFieldKey(key);
  };

  const removeCustomField = (key: string) => {
    setFields((prev) => prev.filter((item) => item.key !== key));
    if (activeFieldKey === key) {
      setActiveFieldKey("name");
    }
  };

  const addPresetField = (field: CategoryPresetField) => {
    setFields((prev) => {
      if (prev.some((item) => item.key === field.key)) return prev;
      return [...prev, { key: field.key, label: field.label, mode: "text", isCustom: true }];
    });
    setActiveFieldKey(field.key);
  };

  const buildTemplatePayload = (): GuideTemplatePayload => {
    const byKey = new Map(fields.map((item) => [item.key, item]));
    const name = byKey.get("name")?.selector || "";

    const customFields = fields
      .filter(
        (item) =>
          item.isCustom &&
          !["name", "price", "description", "image", "inStock"].includes(item.key) &&
          item.selector
      )
      .map((item) => ({
        key: item.key,
        label: item.label,
        selector: {
          selector: String(item.selector || ""),
          mode: item.mode,
        },
      }));

    return {
      websiteUrl: normalizeHttpUrl(websiteUrl),
      productUrl: normalizeHttpUrl(productUrl),
      category,
      selectors: {
        name: {
          selector: name,
          mode: "text",
        },
        price: byKey.get("price")?.selector
          ? { selector: String(byKey.get("price")?.selector || ""), mode: "text" }
          : undefined,
        image: byKey.get("image")?.selector
          ? {
              selector: String(byKey.get("image")?.selector || ""),
              mode: byKey.get("image")?.mode === "src" ? "src" : "text",
            }
          : undefined,
        description: byKey.get("description")?.selector
          ? { selector: String(byKey.get("description")?.selector || ""), mode: "text" }
          : undefined,
        inStock: byKey.get("inStock")?.selector
          ? { selector: String(byKey.get("inStock")?.selector || ""), mode: "text" }
          : undefined,
      },
      customFields,
    };
  };

  const checkSample = async () => {
    if (!canCheckSample) return;
    setLoadingSample(true);
    setError(null);
    setSuccess(null);

    try {
      const payload = buildTemplatePayload();
      const response = await fetch(`${apiUrl}/onboarding/assist/extract-sample`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const sample = (await response.json().catch(() => ({}))) as AssistExtractSampleResponse & {
        error?: string;
        message?: string;
      };

      if (!response.ok) {
        throw new Error(sample.message || sample.error || `Error ${response.status}`);
      }

      onSampleReady({
        templatePayload: payload,
        sampleResult: sample,
        capturedCount,
        requiredCount,
      });
      setSuccess("מצוין, קיבלנו דוגמת מוצר. אפשר לאשר ולהתחיל אינדוקס.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה בבדיקת דוגמת המוצר");
    } finally {
      setLoadingSample(false);
    }
  };

  return (
    <section className="rounded-2xl border border-geffen-100 bg-geffen-50/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
            הדרכת סקרייפר
          </p>
          <p className="mt-1 text-sm text-slate-600">
            לחץ על שם, מחיר, תיאור, תמונה (ושדות נוספים שתרצה) כדי ללמד את הסקרייפר איך האתר שלך בנוי.
          </p>
        </div>
        <div className="rounded-full border border-geffen-200 bg-white px-3 py-1 text-xs font-semibold text-geffen-700">
          {capturedRequiredCount}/{requiredCount} חובה
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
            URL של דף מוצר לדוגמה
          </span>
          <div className="flex flex-col gap-2 md:flex-row">
            <input
              value={productUrl}
              onChange={(e) => setProductUrl(e.target.value)}
              placeholder={`למשל: ${normalizeDomainExample(websiteUrl)}`}
              className="h-11 w-full rounded-xl border border-geffen-200 px-3 text-sm outline-none focus:border-geffen-400"
            />
            <button
              type="button"
              onClick={() => {
                void loadManualPreview();
              }}
              disabled={loadingPreview || !productUrl.trim()}
              className="h-11 rounded-xl border border-geffen-600 bg-geffen-600 px-4 text-sm font-semibold text-white hover:bg-geffen-700 disabled:opacity-60"
            >
              {loadingPreview ? "טוען..." : "טען דף זה"}
            </button>
          </div>
        </label>

        <div className="rounded-xl border border-geffen-100 bg-white p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
            שדות מהירים לפי קטגוריה
          </p>
          <div className="flex flex-wrap gap-2">
            {presetFields.length === 0 && (
              <span className="text-xs text-slate-500">אין שדות ברירת מחדל לקטגוריה זו.</span>
            )}
            {presetFields.map((field) => {
              const exists = fields.some((item) => item.key === field.key);
              return (
                <button
                  key={field.key}
                  type="button"
                  onClick={() => addPresetField(field)}
                  disabled={exists}
                  className="rounded-full border border-geffen-200 bg-geffen-50 px-3 py-1 text-xs text-geffen-800 hover:border-geffen-400 disabled:opacity-40"
                >
                  {exists ? "✓ " : "+ "}
                  {field.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-geffen-100 bg-white p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">הוסף שדה משלך</p>
          <div className="flex gap-2">
            <input
              value={newCustomLabel}
              onChange={(e) => setNewCustomLabel(e.target.value)}
              placeholder="לדוגמה: ארומה / סוג עץ / זמן יישון"
              className="h-10 w-full rounded-lg border border-geffen-200 px-3 text-sm outline-none focus:border-geffen-400"
            />
            <button
              type="button"
              onClick={addCustomField}
              disabled={!newCustomLabel.trim()}
              className="h-10 rounded-lg border border-geffen-600 bg-geffen-600 px-4 text-xs font-semibold text-white hover:bg-geffen-700 disabled:opacity-60"
            >
              + הוסף
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}

        {success && (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {success}
          </div>
        )}

        {previewHtml && (
          <div className="grid gap-4 lg:grid-cols-[320px,1fr]">
            <div className="space-y-3 rounded-xl border border-geffen-100 bg-white p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                Checklist
              </p>
              <p className="text-xs text-slate-500">
                בחר שדה ואז לחץ עליו בתוך הדף. אפשר תמיד לחזור וללחוץ מחדש על שדה כדי לשפר דיוק.
              </p>

              <div className="max-h-[460px] space-y-2 overflow-auto pr-1">
                {fields.map((field) => {
                  const captured = Boolean(field.selector);
                  return (
                    <button
                      key={field.key}
                      type="button"
                      onClick={() => setActiveFieldKey(field.key)}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-xs ${
                        activeFieldKey === field.key
                          ? "border-geffen-500 bg-geffen-50 text-geffen-800"
                          : "border-geffen-100 bg-white text-slate-700 hover:border-geffen-300"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span>
                          {field.label}
                          {field.required ? " *" : ""}
                        </span>
                        <span className="text-[10px] uppercase tracking-[0.08em]">
                          {captured ? "captured" : "pending"}
                        </span>
                      </div>
                      {field.selector && (
                        <p className="mt-1 truncate text-[11px] text-slate-500">{field.selector}</p>
                      )}
                      {field.sampleText && (
                        <p className="mt-1 truncate text-[11px] text-slate-400">{field.sampleText}</p>
                      )}

                      {field.isCustom && (
                        <div className="mt-2">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              removeCustomField(field.key);
                            }}
                            className="rounded-md border border-red-200 px-2 py-1 text-[10px] text-red-700 hover:bg-red-50"
                          >
                            הסר שדה
                          </button>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => {
                  void checkSample();
                }}
                disabled={!canCheckSample || loadingSample}
                className="h-10 w-full rounded-lg border border-geffen-600 bg-geffen-600 px-4 text-xs font-semibold text-white hover:bg-geffen-700 disabled:opacity-60"
              >
                {loadingSample ? "בודק דוגמת מוצר..." : "בדוק דוגמת מוצר"}
              </button>
            </div>

            <div className="rounded-xl border border-geffen-100 bg-white p-2">
              <iframe
                title="Product page preview"
                srcDoc={srcDoc}
                className="h-[660px] w-full rounded-lg border border-geffen-100"
                sandbox="allow-scripts allow-same-origin allow-forms"
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function buildPreviewDoc(rawHtml: string, baseUrl: string): string {
  const cleaned = String(rawHtml || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  const baseTag = `<base href="${escapeHtmlAttribute(baseUrl)}">`;
  const helperScript = `
<script>
(() => {
  const style = document.createElement('style');
  style.textContent = '[data-geffen-selected="1"]{outline:2px solid #10b981 !important; outline-offset:2px !important;}';
  document.head.appendChild(style);

  function cssEscape(value) {
    return String(value || '').replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
  }

  function fullSelector(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += '#' + cssEscape(node.id);
        parts.unshift(part);
        break;
      }
      const cls = Array.from(node.classList || []).filter(Boolean).slice(0, 2);
      if (cls.length) part += '.' + cls.map(cssEscape).join('.');
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function simpleSelector(el) {
    if (!el || !el.tagName) return '';
    if (el.id) return '#' + cssEscape(el.id);
    const classes = Array.from(el.classList || []).filter(Boolean);
    if (classes.length) return '.' + cssEscape(classes[0]);
    return String(el.tagName || '').toLowerCase();
  }

  let selected = null;
  document.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const el = event.target;
    if (!el || !el.tagName) return;
    if (selected) selected.removeAttribute('data-geffen-selected');
    selected = el;
    selected.setAttribute('data-geffen-selected', '1');
    const text = (el.innerText || el.textContent || '').trim().slice(0, 200);
    const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
    const href = el.getAttribute('href') || '';
    window.parent.postMessage({
      type: 'assist-click',
      fullSelector: fullSelector(el),
      simpleSelector: simpleSelector(el),
      text,
      src,
      href,
      tag: String(el.tagName || '').toLowerCase()
    }, '*');
  }, true);
})();
</script>
`;

  if (cleaned.includes("<head")) {
    return cleaned.replace(/<head[^>]*>/i, (head) => `${head}${baseTag}${helperScript}`);
  }

  return `
<!doctype html>
<html>
  <head>
    ${baseTag}
    ${helperScript}
  </head>
  <body>${cleaned}</body>
</html>`;
}

function escapeHtmlAttribute(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeHttpUrl(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function toFieldKey(label: string): string {
  const normalized = String(label || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalized) return "";
  const ascii = normalized.replace(/[^a-zA-Z0-9_:-]/g, "");
  return (ascii || `field_${Math.random().toString(36).slice(2, 8)}`).slice(0, 80);
}

function normalizeDomainExample(websiteUrl: string): string {
  const raw = normalizeHttpUrl(websiteUrl);
  if (!raw) return "https://example.com/products/sample";
  try {
    const url = new URL(raw);
    return `${url.origin}/products/sample-item`;
  } catch {
    return "https://example.com/products/sample-item";
  }
}
