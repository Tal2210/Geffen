import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { buildDemoCatchphrase, getCategoryPlaceholders } from "../constants/onboardingPlaceholders";
import { resolveProductImageUrl } from "../utils/productImage";

interface DemoProduct {
  _id: string;
  name: string;
  description?: string;
  price: number;
  currency?: string;
  imageUrl?: string;
  productUrl?: string;
  brand?: string;
  category?: string;
  inStock?: boolean;
  score?: number;
  finalScore?: number;
}

interface DemoMetadataResponse {
  demoId: string;
  websiteUrl: string;
  category: string;
  productCount: number;
  status: "ready" | "partial_ready";
  createdAt: string;
  expiresAt: string;
  previewProducts: DemoProduct[];
}

interface DemoSearchResponse {
  products: DemoProduct[];
  metadata: {
    query: string;
    totalResults: number;
    returnedCount: number;
    retrieval: {
      mode: "text_only" | "hybrid";
      textCandidates: number;
      vectorCandidates: number;
      mergedCandidates: number;
      vectorStatus: string;
    };
    timings: {
      total: number;
      textSearch: number;
      embedding: number;
      vectorSearch: number;
      merge: number;
    };
  };
}

function formatIls(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "Price unavailable";
  }
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

function safeHostname(rawUrl?: string): string {
  const input = String(rawUrl || "").trim();
  if (!input) return "your-store.com";
  try {
    return new URL(input).hostname;
  } catch {
    return "your-store.com";
  }
}

export function OnboardingDemo() {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [demo, setDemo] = useState<DemoMetadataResponse | null>(null);
  const [results, setResults] = useState<DemoSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);

  const API_URL = import.meta.env.VITE_SEARCH_API_URL || "https://geffen.onrender.com";

  useEffect(() => {
    const load = async () => {
      if (!token) return;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${API_URL}/onboarding/demos/${encodeURIComponent(token)}`);
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.message || `Error ${response.status}`);
        }
        setDemo(payload as DemoMetadataResponse);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed loading demo");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [API_URL, token]);

  const placeholders = useMemo(() => {
    return getCategoryPlaceholders(demo?.category);
  }, [demo?.category]);

  const activePlaceholder = useMemo(() => {
    if (placeholders.length === 0) return "Search your products semantically...";
    return placeholders[placeholderIndex % placeholders.length];
  }, [placeholderIndex, placeholders]);

  useEffect(() => {
    setPlaceholderIndex(0);
  }, [demo?.category]);

  useEffect(() => {
    if (query.trim()) return;
    if (!placeholders.length) return;
    const timer = window.setInterval(() => {
      setPlaceholderIndex((prev) => (prev + 1) % placeholders.length);
    }, 2800);
    return () => window.clearInterval(timer);
  }, [placeholders, query]);

  const runSearch = async (nextQuery?: string) => {
    const effectiveQuery = String(nextQuery ?? query).trim();
    if (!token || !effectiveQuery) return;
    if (nextQuery) setQuery(effectiveQuery);

    setSearching(true);
    setError(null);

    try {
      const response = await fetch(`${API_URL}/onboarding/demos/${encodeURIComponent(token)}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: effectiveQuery, limit: 24, offset: 0 }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.message || `Error ${response.status}`);
      }

      setResults(payload as DemoSearchResponse);
    } catch (err) {
      setResults(null);
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const activeProducts = useMemo(() => {
    if (results?.products?.length) return results.products;
    return demo?.previewProducts || [];
  }, [demo?.previewProducts, results?.products]);

  const domain = useMemo(() => safeHostname(demo?.websiteUrl), [demo?.websiteUrl]);

  const catchphrase = useMemo(() => {
    return buildDemoCatchphrase({
      domain,
      category: demo?.category,
      productCount: demo?.productCount,
    });
  }, [demo?.category, demo?.productCount, domain]);

  return (
    <div className="min-h-screen bg-[#fffdfd] px-6 py-8 text-slate-900 lg:px-10">
      <div className="mx-auto max-w-[1400px] space-y-5">
        <section className="overflow-hidden rounded-3xl border border-geffen-100 bg-gradient-to-br from-geffen-50 via-white to-emerald-50 p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs uppercase tracking-[0.15em] text-geffen-700">Semantic Demo</p>
              <h1 className="mt-1 text-3xl font-semibold text-slate-900">Demo for {domain}</h1>
              <p className="mt-2 text-sm text-slate-600">{catchphrase}</p>
            </div>

            <div className="flex items-center gap-2">
              <Link
                to="/onboarding"
                className="rounded-full border border-geffen-200 bg-white px-4 py-2 text-xs font-semibold text-geffen-700 hover:border-geffen-400"
              >
                New Demo
              </Link>
            </div>
          </div>

          {demo && (
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
              <div className="rounded-xl border border-geffen-100 bg-white/90 p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Domain</p>
                <p className="text-sm font-semibold text-slate-900">{domain}</p>
              </div>
              <div className="rounded-xl border border-geffen-100 bg-white/90 p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Category</p>
                <p className="text-sm font-semibold text-slate-900">{demo.category}</p>
              </div>
              <div className="rounded-xl border border-geffen-100 bg-white/90 p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Products</p>
                <p className="text-sm font-semibold text-slate-900">{demo.productCount}</p>
              </div>
              <div className="rounded-xl border border-geffen-100 bg-white/90 p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Status</p>
                <p className="text-sm font-semibold text-slate-900">{demo.status}</p>
              </div>
            </div>
          )}
        </section>

        {error && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>
        )}

        {loading ? (
          <div className="rounded-2xl border border-geffen-100 bg-white p-8 text-sm text-slate-500">
            Loading demo...
          </div>
        ) : (
          <>
            <section className="rounded-2xl border border-geffen-100 bg-white p-4 shadow-sm">
              <div className="flex gap-3">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void runSearch();
                    }
                  }}
                  placeholder={activePlaceholder}
                  className="h-11 flex-1 rounded-xl border border-geffen-200 px-3 text-sm outline-none focus:border-geffen-400"
                />
                <button
                  type="button"
                  onClick={() => {
                    void runSearch();
                  }}
                  disabled={searching || !query.trim()}
                  className="h-11 rounded-xl border border-geffen-600 bg-geffen-600 px-5 text-sm font-semibold text-white hover:bg-geffen-700 disabled:opacity-60"
                >
                  {searching ? "Searching..." : "Search"}
                </button>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {placeholders.slice(0, 3).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      void runSearch(item);
                    }}
                    className="rounded-full border border-geffen-200 bg-geffen-50 px-3 py-1 text-xs text-geffen-800 hover:border-geffen-400"
                  >
                    {item}
                  </button>
                ))}
              </div>

              {results?.metadata && (
                <div className="mt-3 rounded-xl border border-geffen-100 bg-geffen-50/60 p-3 text-xs text-slate-600">
                  <span className="font-semibold text-geffen-700">Retrieval</span>: {results.metadata.retrieval.mode} |
                  text {results.metadata.retrieval.textCandidates} | vector {results.metadata.retrieval.vectorCandidates} |
                  merged {results.metadata.retrieval.mergedCandidates} | total {results.metadata.timings.total}ms
                </div>
              )}
            </section>

            {activeProducts.length === 0 ? (
              <div className="rounded-2xl border border-geffen-100 bg-white py-20 text-center">
                <p className="text-lg text-slate-700">No products found</p>
                <p className="mt-2 text-sm text-slate-500">Try another query.</p>
              </div>
            ) : (
              <section className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {activeProducts.map((product) => {
                  const imageSrc = resolveProductImageUrl(product);
                  return (
                    <article
                      key={product._id}
                      className="group overflow-hidden rounded-2xl border border-geffen-100 bg-white transition hover:border-geffen-300 hover:shadow-lg"
                    >
                      <div className="relative flex h-44 items-center justify-center border-b border-geffen-100 bg-gradient-to-b from-geffen-50 to-white">
                        {imageSrc ? (
                          <img src={imageSrc} alt={product.name} className="h-full w-full object-contain p-1" />
                        ) : (
                          <span className="text-xs uppercase tracking-[0.14em] text-geffen-500">No image</span>
                        )}
                      </div>

                      <div className="p-4">
                        <h3 className="mb-1 line-clamp-2 text-sm font-semibold text-slate-900">{product.name}</h3>
                        {product.brand && <p className="mb-2 text-xs text-slate-500">Brand: {product.brand}</p>}

                        {product.description && (
                          <p className="mb-3 line-clamp-3 text-xs text-slate-500">{toPlainText(product.description)}</p>
                        )}

                        <div className="flex items-end justify-between border-t border-geffen-100 pt-3">
                          <p className="text-xl font-semibold text-geffen-700">{formatIls(product.price)}</p>
                          {typeof product.finalScore === "number" && (
                            <p className="text-xs text-slate-500">{Math.round(product.finalScore * 100)}%</p>
                          )}
                        </div>

                        {product.productUrl && (
                          <a
                            href={product.productUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-3 inline-flex text-xs font-semibold text-geffen-700 underline-offset-2 hover:underline"
                          >
                            Open product page
                          </a>
                        )}
                      </div>
                    </article>
                  );
                })}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
