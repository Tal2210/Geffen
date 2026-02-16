import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { OnboardingAssistTrainer } from "./OnboardingAssistTrainer";

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

export function OnboardingFunnel() {
  const navigate = useNavigate();
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState("wine");
  const [categories, setCategories] = useState<CategoryOption[]>(FALLBACK_CATEGORIES);
  const [starting, setStarting] = useState(false);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [job, setJob] = useState<JobStatusResponse | null>(null);
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
  }, [API_URL, category]);

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void pollJob(job.jobId);
    }, 2000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [job]);

  const progressPercent = useMemo(() => {
    return Math.max(0, Math.min(100, Number(job?.progress?.percent || 0)));
  }, [job]);

  const start = async () => {
    setError(null);
    setStarting(true);

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
      await pollJob(started.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start onboarding");
    } finally {
      setStarting(false);
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

  return (
    <div className="min-h-screen bg-[#fffdfd] px-6 py-8 text-slate-900 lg:px-10">
      <div className="mx-auto max-w-4xl rounded-3xl border border-geffen-100 bg-white p-6 shadow-xl shadow-geffen-100/40">
        <h1 className="mb-2 text-2xl font-semibold text-slate-900">Build Your Semantic Demo</h1>
        <p className="mb-6 text-sm text-slate-500">
          Enter your website, choose a category, and we will generate a semantic search demo from up to 50 public products.
        </p>

        {error && (
          <div className="mb-5 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}

        {!job && (
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

            <OnboardingAssistTrainer apiUrl={API_URL} websiteUrl={websiteUrl} />

            <button
              type="button"
              onClick={() => {
                void start();
              }}
              disabled={starting || !websiteUrl.trim() || !email.trim()}
              className="h-11 rounded-xl border border-geffen-600 bg-geffen-600 px-6 text-sm font-semibold text-white transition hover:bg-geffen-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {starting ? "Starting..." : "Create Demo"}
            </button>
          </div>
        )}

        {job && (
          <div className="space-y-4">
            <div className="rounded-xl border border-geffen-100 bg-geffen-50/50 p-4">
              <p className="text-xs uppercase tracking-[0.12em] text-geffen-700">Status</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{job.status}</p>
              <p className="mt-1 text-sm text-slate-600">{job.progress?.message || "Working..."}</p>
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

            {(job.status === "failed" || job.errorMessage) && (
              <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">
                {job.errorMessage || "Onboarding failed"}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
