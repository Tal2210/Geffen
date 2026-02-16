import { useEffect, useMemo, useState } from "react";

type AssistFieldKey = "name" | "price" | "image" | "description" | "inStock";

interface AssistSelectorState {
  selector: string;
  mode: "text" | "src";
  sampleText?: string;
}

interface AssistPreviewResponse {
  normalizedUrl: string;
  baseUrl: string;
  html: string;
}

interface Props {
  apiUrl: string;
  websiteUrl: string;
}

const FIELD_CONFIG: Array<{
  key: AssistFieldKey;
  label: string;
  required?: boolean;
  defaultMode: "text" | "src";
}> = [
  { key: "name", label: "Product Name", required: true, defaultMode: "text" },
  { key: "price", label: "Price", defaultMode: "text" },
  { key: "image", label: "Main Image", defaultMode: "src" },
  { key: "description", label: "Description", defaultMode: "text" },
  { key: "inStock", label: "Stock Status", defaultMode: "text" },
];

export function OnboardingAssistTrainer({ apiUrl, websiteUrl }: Props) {
  const [open, setOpen] = useState(false);
  const [productUrl, setProductUrl] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewBaseUrl, setPreviewBaseUrl] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeField, setActiveField] = useState<AssistFieldKey>("name");
  const [selectors, setSelectors] = useState<Partial<Record<AssistFieldKey, AssistSelectorState>>>(
    {}
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = event.data as any;
      if (!payload || payload.type !== "assist-click") return;
      const field = activeField;
      const config = FIELD_CONFIG.find((item) => item.key === field);
      if (!config) return;

      const rawSelector = String(payload.simpleSelector || payload.fullSelector || "").trim();
      if (!rawSelector) return;
      const sampleText = String(payload.text || payload.src || payload.href || "").trim();

      setSelectors((prev) => ({
        ...prev,
        [field]: {
          selector: rawSelector,
          mode:
            config.key === "image" && String(payload.tag || "").toLowerCase() === "img"
              ? "src"
              : config.defaultMode,
          sampleText: sampleText.slice(0, 180),
        },
      }));
      setSuccess(null);
      setError(null);
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [activeField]);

  const srcDoc = useMemo(() => {
    if (!previewHtml) return "";
    return buildPreviewDoc(previewHtml, previewBaseUrl);
  }, [previewHtml, previewBaseUrl]);

  const canSave = Boolean(websiteUrl.trim() && productUrl.trim() && selectors.name?.selector);

  const loadPreview = async () => {
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
      setSuccess("Preview loaded. Choose a field and click the element inside the page.");
    } catch (err) {
      setPreviewHtml("");
      setPreviewBaseUrl("");
      setError(err instanceof Error ? err.message : "Failed loading preview");
    } finally {
      setLoadingPreview(false);
    }
  };

  const saveTemplate = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch(`${apiUrl}/onboarding/assist/template`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          websiteUrl: normalizeHttpUrl(websiteUrl),
          productUrl: normalizeHttpUrl(productUrl),
          selectors: {
            name: selectors.name,
            price: selectors.price,
            image: selectors.image,
            description: selectors.description,
            inStock: selectors.inStock,
          },
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!response.ok) {
        throw new Error(payload.message || payload.error || `Error ${response.status}`);
      }

      setSuccess("Saved. The next onboarding run will use your selectors as guided scraping hints.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed saving template");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-geffen-100 bg-geffen-50/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
            Optional Scraper Guidance
          </p>
          <p className="mt-1 text-sm text-slate-600">
            If your site is hard to scrape, help the system once by clicking key elements on one product page.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="rounded-full border border-geffen-200 bg-white px-3 py-1.5 text-xs font-semibold text-geffen-700 hover:border-geffen-400 hover:bg-geffen-50"
        >
          {open ? "Hide" : "Open"}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
              Sample Product URL
            </span>
            <div className="flex gap-2">
              <input
                value={productUrl}
                onChange={(e) => setProductUrl(e.target.value)}
                placeholder="https://your-store.com/products/example"
                className="h-11 w-full rounded-xl border border-geffen-200 px-3 text-sm outline-none focus:border-geffen-400"
              />
              <button
                type="button"
                onClick={() => {
                  void loadPreview();
                }}
                disabled={loadingPreview || !productUrl.trim()}
                className="h-11 rounded-xl border border-geffen-600 bg-geffen-600 px-4 text-sm font-semibold text-white hover:bg-geffen-700 disabled:opacity-60"
              >
                {loadingPreview ? "Loading..." : "Load"}
              </button>
            </div>
          </label>

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
            <div className="grid gap-4 lg:grid-cols-[300px,1fr]">
              <div className="space-y-3 rounded-xl border border-geffen-100 bg-white p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                  Step By Step
                </p>
                <p className="text-xs text-slate-500">
                  Choose a field, then click the matching element inside the preview.
                </p>
                <div className="space-y-2">
                  {FIELD_CONFIG.map((field) => {
                    const selected = selectors[field.key];
                    return (
                      <button
                        key={field.key}
                        type="button"
                        onClick={() => setActiveField(field.key)}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-xs ${
                          activeField === field.key
                            ? "border-geffen-500 bg-geffen-50 text-geffen-800"
                            : "border-geffen-100 bg-white text-slate-700 hover:border-geffen-300"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span>
                            {field.label} {field.required ? "*" : ""}
                          </span>
                          <span className="text-[10px] uppercase tracking-[0.08em]">
                            {selected?.selector ? "captured" : "pending"}
                          </span>
                        </div>
                        {selected?.selector && (
                          <p className="mt-1 truncate text-[11px] text-slate-500">{selected.selector}</p>
                        )}
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    void saveTemplate();
                  }}
                  disabled={!canSave || saving}
                  className="h-10 w-full rounded-lg border border-geffen-600 bg-geffen-600 px-4 text-xs font-semibold text-white hover:bg-geffen-700 disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save Guidance Template"}
                </button>
              </div>

              <div className="rounded-xl border border-geffen-100 bg-white p-2">
                <iframe
                  title="Product page preview"
                  srcDoc={srcDoc}
                  className="h-[620px] w-full rounded-lg border border-geffen-100"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                />
              </div>
            </div>
          )}
        </div>
      )}
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
