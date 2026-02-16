import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  OnboardingAssistTrainer,
  type GuideTemplatePayload,
} from "./OnboardingAssistTrainer";
import { resolveProductImageUrl } from "../utils/productImage";

interface CategoryOption {
  value: string;
  label: string;
}

const FALLBACK_CATEGORIES: CategoryOption[] = [
  { value: "wine", label: "Wine" },
  { value: "fashion", label: "Fashion" },
  { value: "footwear", label: "Footwear" },
  { value: "furniture", label: "Furniture" },
  { value: "beauty", label: "Beauty" },
  { value: "electronics", label: "Electronics" },
  { value: "jewelry", label: "Jewelry" },
  { value: "home_decor", label: "Home Decor" },
  { value: "sports", label: "Sports" },
  { value: "pets", label: "Pets" },
  { value: "toys", label: "Toys" },
  { value: "kids", label: "Kids" },
  { value: "food", label: "Food" },
  { value: "supplements", label: "Supplements" },
  { value: "books", label: "Books" },
  { value: "automotive", label: "Automotive" },
  { value: "garden", label: "Garden" },
  { value: "travel", label: "Travel" },
  { value: "bags", label: "Bags" },
  { value: "lingerie", label: "Lingerie" },
];

interface StartResponse {
  jobId: string;
  status: string;
  pollUrl: string;
  createdAt: string;
}

interface JobProgress {
  step: string;
  percent: number;
  message?: string;
}

interface JobStatusResponse {
  jobId: string;
  websiteUrl: string;
  category: string;
  email: string;
  status: "queued" | "running" | "ready" | "partial_ready" | "failed";
  progress: JobProgress;
  errorCode?: string;
  errorMessage?: string;
  demoToken?: string;
  demoUrl?: string;
  demoId?: string;
  productCount?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface LiveProduct {
  _id: string;
  name: string;
  description?: string;
  imageUrl?: string;
  price: number;
  currency?: string;
  productUrl?: string;
}

interface JobLiveResponse {
  jobId: string;
  status: JobStatusResponse["status"];
  progress: JobProgress;
  counters: {
    extracted: number;
    normalized: number;
    embedded: number;
    indexed: number;
  };
  recentProducts: LiveProduct[];
}

interface SampleResult {
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

type WizardStep = "details" | "guide" | "preview-confirm" | "indexing-live";

function formatIls(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "Price unavailable";
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function toPlainText(value?: string): string {
  if (!value) return "";
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

const STEP_ORDER = ["discover", "extract", "normalize", "sample", "embed", "index", "finalize", "done"];
const STEP_LABELS: Record<string, string> = {
  discover: "Connecting to your store",
  extract: "Finding products",
  normalize: "Cleaning product data",
  sample: "Selecting best products",
  embed: "Preparing smart search",
  index: "Publishing your demo catalog",
  finalize: "Finalizing demo link",
  done: "Done",
  queued: "Queued",
  running: "Building your demo",
};

export function OnboardingFunnel() {
  const navigate = useNavigate();
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState("wine");
  const [categories, setCategories] = useState<CategoryOption[]>(FALLBACK_CATEGORIES);
  const [step, setStep] = useState<WizardStep>("details");
  const [sampleCheck, setSampleCheck] = useState<{
    templatePayload: GuideTemplatePayload;
    sampleResult: SampleResult;
    capturedCount: number;
    requiredCount: number;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [job, setJob] = useState<JobStatusResponse | null>(null);
  const [live, setLive] = useState<JobLiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<number | null>(null);

  const API_URL = import.meta.env.VITE_SEARCH_API_URL || "https://geffen.onrender.com";

  useEffect(() => {
    const run = async () => {
      setLoadingCategories(true);
      try {
        const res = await fetch(`${API_URL}/onboarding/categories`);
        if (!res.ok) {
          throw new Error(`Failed loading categories (${res.status})`);
        }
        const payload = await res.json();
        const rows = Array.isArray(payload?.categories) ? payload.categories : [];
        if (rows.length > 0) {
          setCategories(rows);
          if (!rows.some((c: CategoryOption) => c.value === category)) {
            setCategory(rows[0].value);
          }
        }
      } catch {
        setCategories(FALLBACK_CATEGORIES);
      } finally {
        setLoadingCategories(false);
      }
    };

    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [API_URL]);

  useEffect(() => {
    if (step !== "indexing-live" || !job || !["queued", "running"].includes(job.status)) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void pollJob(job.jobId);
      void pollLive(job.jobId);
    }, 1500);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [job, step]);

  const progressPercent = useMemo(() => {
    return Math.max(0, Math.min(100, Number(job?.progress?.percent || live?.progress?.percent || 0)));
  }, [job, live]);

  const detailsValid = useMemo(() => {
    const normalizedWebsite = normalizeHttpUrl(websiteUrl);
    return (
      Boolean(category) &&
      isValidEmail(email) &&
      isPublicWebsiteUrl(normalizedWebsite)
    );
  }, [category, email, websiteUrl]);

  const goToGuide = () => {
    const normalizedWebsite = normalizeHttpUrl(websiteUrl);
    if (!isPublicWebsiteUrl(normalizedWebsite)) {
      setError("Please enter a valid public website URL (http/https).");
      return;
    }
    if (!isValidEmail(email)) {
      setError("Please enter a valid email.");
      return;
    }
    if (!category) {
      setError("Please choose a category.");
      return;
    }
    setError(null);
    setWebsiteUrl(normalizedWebsite);
    setEmail(String(email || "").trim());
    setSampleCheck(null);
    setStep("guide");
  };

  const startJob = async () => {
    setError(null);
    setStarting(true);
    setStep("indexing-live");

    try {
      const response = await fetch(`${API_URL}/onboarding/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ websiteUrl, category, email }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.message || payload?.error || `Error ${response.status}`);
      }

      const started = payload as StartResponse;
      await Promise.all([pollJob(started.jobId), pollLive(started.jobId)]);
    } catch (err) {
      setStep("preview-confirm");
      setError(err instanceof Error ? err.message : "Failed to start onboarding");
    } finally {
      setStarting(false);
    }
  };

  const confirmAndStart = async () => {
    if (!sampleCheck) return;
    setSavingTemplate(true);
    setError(null);
    try {
      const saveResponse = await fetch(`${API_URL}/onboarding/assist/template`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sampleCheck.templatePayload),
      });
      const savePayload = await saveResponse.json().catch(() => ({}));
      if (!saveResponse.ok) {
        throw new Error(savePayload?.message || savePayload?.error || `Error ${saveResponse.status}`);
      }

      await startJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save page setup");
    } finally {
      setSavingTemplate(false);
    }
  };

  const pollJob = async (jobId: string) => {
    const response = await fetch(`${API_URL}/onboarding/jobs/${encodeURIComponent(jobId)}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.message || `Error ${response.status}`);
    }

    const status = payload as JobStatusResponse;
    setJob(status);

    if (status.status === "ready" || status.status === "partial_ready") {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      const token = status.demoToken || status.demoUrl?.split("/").pop();
      if (token) {
        navigate(`/onboarding/demo/${encodeURIComponent(token)}`);
      }
    }
  };

  const pollLive = async (jobId: string) => {
    const response = await fetch(`${API_URL}/onboarding/jobs/${encodeURIComponent(jobId)}/live`);
    const payload = await response.json();
    if (!response.ok) return;
    setLive(payload as JobLiveResponse);
  };

  const currentTimelineStep = (live?.progress?.step || job?.progress?.step || "queued").toLowerCase();

  return (
    <div className="min-h-screen bg-[#fffdfd] px-6 py-8 text-slate-900 lg:px-10">
      <div className="mx-auto max-w-6xl rounded-3xl border border-geffen-100 bg-white p-6 shadow-xl shadow-geffen-100/40">
        <h1 className="mb-2 text-2xl font-semibold text-slate-900">Create your store demo</h1>
        <p className="mb-6 text-sm text-slate-500">
          Simple setup: store details, map one product page, review a sample, and launch your live demo.
        </p>

        <div className="mb-6 grid grid-cols-1 gap-2 md:grid-cols-4">
          <StepBadge active={step === "details"} done={step !== "details"} label="1. Store details" />
          <StepBadge active={step === "guide"} done={["preview-confirm", "indexing-live"].includes(step)} label="2. Map fields" />
          <StepBadge active={step === "preview-confirm"} done={step === "indexing-live"} label="3. Review sample" />
          <StepBadge
            active={step === "indexing-live"}
            done={Boolean(job && ["ready", "partial_ready"].includes(job.status))}
            label="4. Build demo"
          />
        </div>

        {error && (
          <div className="mb-5 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}

        {step === "details" && (
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                Website URL
              </span>
              <input
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://your-store.com"
                className="h-11 w-full rounded-xl border border-geffen-200 px-3 text-sm outline-none focus:border-geffen-400"
              />
              <p className="mt-1 text-xs text-slate-500">Use your public storefront URL (not admin pages).</p>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                Email
              </span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="h-11 w-full rounded-xl border border-geffen-200 px-3 text-sm outline-none focus:border-geffen-400"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                Store Category
              </span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={loadingCategories && categories.length === 0}
                className="h-11 w-full rounded-xl border border-geffen-200 px-3 text-sm outline-none focus:border-geffen-400"
              >
                {categories.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={goToGuide}
              disabled={!detailsValid}
              className="h-11 rounded-xl border border-geffen-600 bg-geffen-600 px-6 text-sm font-semibold text-white transition hover:bg-geffen-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Continue
            </button>
          </div>
        )}

        {step === "guide" && (
          <div className="space-y-4">
            <OnboardingAssistTrainer
              apiUrl={API_URL}
              websiteUrl={websiteUrl}
              category={category}
              onSampleReady={(data) => {
                setSampleCheck(data);
                setStep("preview-confirm");
              }}
            />

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => setStep("details")}
                className="h-11 rounded-xl border border-geffen-200 bg-white px-5 text-sm font-semibold text-geffen-700 hover:border-geffen-400"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {step === "preview-confirm" && sampleCheck && (
          <div className="space-y-4">
            <div className="rounded-xl border border-geffen-100 bg-geffen-50/60 p-4">
              <p className="text-xs uppercase tracking-[0.12em] text-geffen-700">Sample Product Preview</p>
              <p className="mt-1 text-sm text-slate-600">
                This is a sample product generated from your field mapping. If it looks good, continue to build the demo.
              </p>
            </div>

            <article className="overflow-hidden rounded-2xl border border-geffen-100 bg-white shadow-sm">
              <div className="grid gap-0 md:grid-cols-[320px,1fr]">
                <div className="flex h-64 items-center justify-center border-b border-geffen-100 bg-gradient-to-b from-geffen-50 to-white md:border-b-0 md:border-r">
                  {sampleCheck.sampleResult.sampleProduct.imageUrl ? (
                    <img
                      src={resolveProductImageUrl({ imageUrl: sampleCheck.sampleResult.sampleProduct.imageUrl } as any)}
                      alt={sampleCheck.sampleResult.sampleProduct.name || "Sample product"}
                      className="h-full w-full object-contain p-2"
                    />
                  ) : (
                    <span className="text-xs uppercase tracking-[0.14em] text-geffen-500">No image</span>
                  )}
                </div>

                <div className="p-5">
                  <h3 className="text-lg font-semibold text-slate-900">
                    {sampleCheck.sampleResult.sampleProduct.name || "No product name"}
                  </h3>
                  <p className="mt-2 text-2xl font-semibold text-geffen-700">
                    {formatIls(Number(sampleCheck.sampleResult.sampleProduct.price || 0))}
                  </p>
                  <p className="mt-3 text-sm text-slate-600">
                    {toPlainText(sampleCheck.sampleResult.sampleProduct.description) || "No description extracted"}
                  </p>

                  {Object.keys(sampleCheck.sampleResult.sampleProduct.attributes || {}).length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {Object.entries(sampleCheck.sampleResult.sampleProduct.attributes)
                        .filter(([, value]) => String(value || "").trim().length > 0)
                        .map(([key, value]) => (
                          <span
                            key={key}
                            className="rounded-full border border-geffen-200 bg-geffen-50 px-3 py-1 text-xs text-geffen-800"
                          >
                            {key}: {value}
                          </span>
                        ))}
                    </div>
                  )}

                  {sampleCheck.sampleResult.missingFields.length > 0 && (
                    <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Some fields are missing: {sampleCheck.sampleResult.missingFields.join(", ")}.
                      You can still continue.
                    </div>
                  )}
                </div>
              </div>
            </article>

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => setStep("guide")}
                className="h-11 rounded-xl border border-geffen-200 bg-white px-5 text-sm font-semibold text-geffen-700 hover:border-geffen-400"
              >
                Back to edit
              </button>
              <button
                type="button"
                onClick={() => {
                  void confirmAndStart();
                }}
                disabled={starting || savingTemplate}
                className="h-11 rounded-xl border border-geffen-600 bg-geffen-600 px-5 text-sm font-semibold text-white hover:bg-geffen-700 disabled:opacity-60"
              >
                {starting || savingTemplate ? "Starting..." : "Looks good, build demo"}
              </button>
            </div>
          </div>
        )}

        {step === "indexing-live" && (
          <div className="space-y-5">
            <div className="rounded-xl border border-geffen-100 bg-geffen-50/50 p-4">
              <p className="text-xs uppercase tracking-[0.12em] text-geffen-700">Current Status</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {readableStatus(job?.status || live?.status || "queued")}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                {readableStep(job?.progress?.step || live?.progress?.step || "queued")}
              </p>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                <span>Progress</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-geffen-100">
                <div
                  className="h-2 rounded-full bg-geffen-600 transition-all"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <LiveMetric label="Products Found" value={live?.counters?.extracted || 0} />
              <LiveMetric label="Products Cleaned" value={live?.counters?.normalized || 0} />
              <LiveMetric label="Search Ready" value={live?.counters?.embedded || 0} />
              <LiveMetric label="In Demo" value={live?.counters?.indexed || 0} />
            </div>

            <section className="rounded-2xl border border-geffen-100 bg-white p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">Progress Steps</p>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {STEP_ORDER.map((item) => {
                  const isDone = STEP_ORDER.indexOf(item) <= STEP_ORDER.indexOf(currentTimelineStep as any);
                  const isActive = item === currentTimelineStep;
                  return (
                    <div
                      key={item}
                      className={`rounded-lg border px-3 py-2 text-xs ${
                        isActive
                          ? "border-geffen-500 bg-geffen-50 text-geffen-800"
                          : isDone
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-geffen-100 bg-white text-slate-500"
                      }`}
                    >
                      {readableStep(item)}
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-geffen-100 bg-white p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                Products Added Live
              </p>

              {(live?.recentProducts || []).length === 0 ? (
                <div className="rounded-xl border border-geffen-100 bg-geffen-50/40 p-6 text-center text-sm text-slate-500">
                  Waiting for the first products...
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {(live?.recentProducts || []).map((product, index) => (
                    <article
                      key={`${product._id}-${index}`}
                      className="rounded-xl border border-geffen-100 bg-white p-3 shadow-sm transition-all duration-500 hover:border-geffen-300"
                    >
                      <div className="mb-2 flex h-28 items-center justify-center rounded-lg border border-geffen-100 bg-geffen-50/50">
                        {resolveProductImageUrl(product as any) ? (
                          <img
                            src={resolveProductImageUrl(product as any)}
                            alt={product.name}
                            className="h-full w-full object-contain p-1"
                          />
                        ) : (
                          <span className="text-[10px] uppercase tracking-[0.12em] text-geffen-500">No image</span>
                        )}
                      </div>
                      <p className="line-clamp-2 text-xs font-semibold text-slate-800">{product.name}</p>
                      <p className="mt-1 text-sm font-semibold text-geffen-700">{formatIls(product.price)}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>

            {((job && job.status === "failed") || job?.errorMessage) && (
              <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">
                {job?.errorMessage || "Onboarding failed"}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StepBadge({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
        active
          ? "border-geffen-600 bg-geffen-50 text-geffen-800"
          : done
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-geffen-100 bg-white text-slate-500"
      }`}
    >
      {label}
    </div>
  );
}

function LiveMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-geffen-100 bg-white p-3">
      <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-geffen-700">{value}</p>
    </div>
  );
}

function readableStep(step: string): string {
  const key = String(step || "").toLowerCase().trim();
  return STEP_LABELS[key] || "Working on your demo";
}

function readableStatus(status: string): string {
  const key = String(status || "").toLowerCase().trim();
  if (key === "ready") return "Demo ready";
  if (key === "partial_ready") return "Demo ready (partial catalog)";
  if (key === "failed") return "Setup failed";
  if (key === "running") return "Building your demo";
  return "Queued";
}

function normalizeHttpUrl(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function isValidEmail(value: string): boolean {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isPublicWebsiteUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (!host) return false;
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      if (host.startsWith("10.") || host.startsWith("127.") || host.startsWith("192.168.")) {
        return false;
      }
      const parts = host.split(".").map((n) => Number(n));
      const a = Number(parts[0] ?? -1);
      const b = Number(parts[1] ?? -1);
      if (a === 172 && b >= 16 && b <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}
