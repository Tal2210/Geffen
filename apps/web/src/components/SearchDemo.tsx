import { Link } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveProductImageUrl } from "../utils/productImage";

interface WineProduct {
  _id: string;
  name: string;
  description?: string;
  price: number;
  currency?: string;
  color?: string;
  country?: string;
  region?: string;
  grapes?: string[];
  vintage?: number;
  kosher?: boolean;
  imageUrl?: string;
  image_url?: string;
  image?: string | { url?: string; src?: string };
  images?: Array<string | { url?: string; src?: string }>;
  featuredImage?: { url?: string; src?: string };
  featured_image?: { url?: string; src?: string };
  thumbnail?: string;
  rating?: number;
  score: number;
  finalScore?: number;
}

interface SearchMetadata {
  query: string;
  appliedFilters: {
    colors?: string[];
    countries?: string[];
    priceRange?: { min?: number; max?: number };
    grapes?: string[];
    kosher?: boolean;
  };
  totalResults: number;
  returnedCount: number;
  timings: {
    parsing: number;
    embedding: number;
    vectorSearch: number;
    reranking: number;
    total: number;
  };
}

interface SearchResponse {
  products: WineProduct[];
  metadata: SearchMetadata;
}

interface SearchDemoProps {
  onBack?: () => void;
}

interface ExplanationResponse {
  intro: string;
  reasons: Array<{ id: string; reason: string }>;
}

const colorTone: Record<string, string> = {
  red: "bg-rose-500",
  white: "bg-amber-200",
  "rosé": "bg-pink-300",
  sparkling: "bg-geffen-200",
};

function toPlainText(value?: string): string {
  if (!value) return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatIls(value: number): string {
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

export function SearchDemo({ onBack }: SearchDemoProps) {
  const [query, setQuery] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [kosher, setKosher] = useState<boolean | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [autoSearching, setAutoSearching] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [reasonsById, setReasonsById] = useState<Record<string, string>>({});
  const [explanationIntro, setExplanationIntro] = useState<string>("");
  const [autocompleteOptions, setAutocompleteOptions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestCounterRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const skipNextAutoSearchRef = useRef(false);

  const API_URL = import.meta.env.VITE_SEARCH_API_URL || "https://geffen.onrender.com";
  const API_KEY = import.meta.env.VITE_SEARCH_API_KEY || "test_key_store_a";
  const MERCHANT_ID = import.meta.env.VITE_SEARCH_MERCHANT_ID || "store_a";

  const runSearch = useCallback(async (rawQuery: string, mode: "manual" | "auto" = "manual") => {
    const q = rawQuery.trim();
    if (!q) {
      setResults(null);
      setAutocompleteOptions([]);
      setReasonsById({});
      setExplanationIntro("");
      setError(null);
      return;
    }

    const requestId = ++requestCounterRef.current;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;

    if (mode === "manual") {
      setLoading(true);
    } else {
      setAutoSearching(true);
    }
    setError(null);

    try {
      const response = await fetch(`${API_URL}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify({
          query: q,
          merchantId: MERCHANT_ID,
          limit: 12,
          maxPrice: maxPrice ? parseInt(maxPrice, 10) : undefined,
          colors: selectedColors.length > 0 ? selectedColors : undefined,
          kosher,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || `Error ${response.status}`);
      }

      const data: SearchResponse = await response.json();
      if (requestId !== requestCounterRef.current) return;

      setResults(data);
      setAutocompleteOptions(
        Array.from(
          new Set(
            (data.products || [])
              .map((p) => p.name?.trim())
              .filter((name): name is string => Boolean(name))
          )
        ).slice(0, 8)
      );
      setReasonsById({});
      setExplanationIntro("");

      if (mode === "manual" && data.products.length > 0) {
        try {
          const explainResponse = await fetch(`${API_URL}/search/explain`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": API_KEY,
            },
            body: JSON.stringify({
              query: q,
              products: data.products.slice(0, 8).map((p) => ({
                id: p._id,
                name: p.name,
                description: p.description,
                color: p.color,
                country: p.country,
                grapes: p.grapes,
              })),
            }),
            signal: controller.signal,
          });

          if (explainResponse.ok) {
            const explainData: ExplanationResponse = await explainResponse.json();
            if (requestId !== requestCounterRef.current) return;
            const mapped = Object.fromEntries(
              explainData.reasons.map((r) => [r.id, r.reason])
            ) as Record<string, string>;
            setReasonsById(mapped);
            setExplanationIntro(explainData.intro || "");
          }
        } catch {
          // Keep search usable even if explanation generation fails.
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (requestId !== requestCounterRef.current) return;
      setError(err instanceof Error ? err.message : "Search failed");
      setResults(null);
      setAutocompleteOptions([]);
    } finally {
      if (mode === "manual") {
        setLoading(false);
      } else {
        setAutoSearching(false);
      }
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
      }
    }
  }, [API_KEY, API_URL, MERCHANT_ID, kosher, maxPrice, selectedColors]);

  const runManualSearchFor = useCallback(
    (nextQuery: string) => {
      skipNextAutoSearchRef.current = true;
      setQuery(nextQuery);
      void runSearch(nextQuery, "manual");
    },
    [runSearch]
  );

  const handleSearch = useCallback(() => {
    void runSearch(query, "manual");
  }, [query, runSearch]);

  useEffect(() => {
    if (skipNextAutoSearchRef.current) {
      skipNextAutoSearchRef.current = false;
      return;
    }

    const q = query.trim();
    if (!q) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setAutocompleteOptions([]);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSearch(q, "auto");
    }, 320);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, maxPrice, selectedColors, kosher, runSearch]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      activeRequestRef.current?.abort();
    };
  }, []);

  const toggleColor = (color: string) => {
    setSelectedColors((prev) =>
      prev.includes(color) ? prev.filter((c) => c !== color) : [...prev, color]
    );
  };

  const colors = ["red", "white", "rosé", "sparkling"];
  const visibleAutocompleteOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return autocompleteOptions
      .filter((name) => name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [autocompleteOptions, query]);

  return (
    <div className="min-h-screen bg-[#fffdfd] text-slate-900">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 right-[-120px] h-[420px] w-[420px] rounded-full bg-geffen-100 blur-3xl" />
        <div className="absolute bottom-[-180px] left-[-140px] h-[380px] w-[380px] rounded-full bg-geffen-200/70 blur-3xl" />
      </div>

      <header className="sticky top-0 z-30 border-b border-geffen-100 bg-white/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4 lg:px-10">
          <div className="flex items-center gap-4">
            <div className="rounded-xl border border-geffen-100 bg-white px-3 py-2 shadow-sm">
              <img src="/logo.png" alt="Geffen" className="h-5 w-auto" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-[0.2em] text-geffen-700">SEARCH DEMO</h1>
              <p className="text-xs text-slate-500">Minimal semantic wine retrieval</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/products-boost"
              className="rounded-full border border-geffen-600 bg-geffen-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-geffen-700"
            >
              Products Boost
            </Link>
            <button
              onClick={onBack}
              className="rounded-full border border-geffen-200 px-4 py-2 text-xs font-semibold text-geffen-700 transition hover:border-geffen-400 hover:bg-geffen-50"
            >
              Back to Insights
            </button>
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-[1400px] px-6 py-8 lg:px-10">
        <section className="mb-8 rounded-2xl border border-geffen-100 bg-white p-6 shadow-xl shadow-geffen-100/40">
          <div className="mb-5">
            <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-geffen-700">
              Query
            </label>
            <div className="flex flex-col gap-3 md:flex-row">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder="fruity red from france or יין לבן יבש"
                  className="h-11 w-full rounded-xl border border-geffen-200 bg-white px-4 text-sm text-slate-800 placeholder:text-slate-400 outline-none ring-geffen-200 transition focus:border-geffen-400 focus:ring-2"
                />
                {visibleAutocompleteOptions.length > 0 && (
                  <div className="absolute z-40 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-geffen-200 bg-white p-1 shadow-xl">
                    {visibleAutocompleteOptions.map((option) => (
                      <button
                        key={option}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => runManualSearchFor(option)}
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-geffen-50"
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={handleSearch}
                disabled={loading || !query.trim()}
                className={`h-11 rounded-xl px-7 text-sm font-semibold transition ${
                  loading || !query.trim()
                    ? "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400"
                    : "border border-geffen-600 bg-geffen-600 text-white hover:bg-geffen-700"
                }`}
              >
                {loading ? "Searching..." : "Run Search"}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              {autoSearching ? "מעדכן תוצאות תוך כדי הקלדה..." : "Autocomplete פעיל - אפשר לבחור תוצאה מהרשימה."}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                Color
              </label>
              <div className="flex flex-wrap gap-2">
                {colors.map((color) => (
                  <button
                    key={color}
                    onClick={() => toggleColor(color)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition ${
                      selectedColors.includes(color)
                        ? "border-geffen-600 bg-geffen-600 text-white"
                        : "border-geffen-200 bg-white text-geffen-700 hover:border-geffen-400"
                    }`}
                  >
                    {color}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                מחיר מקסימלי (₪)
              </label>
              <input
                type="number"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                placeholder="200"
                className="h-9 w-full rounded-lg border border-geffen-200 bg-white px-3 text-sm text-slate-800 placeholder:text-slate-400 outline-none ring-geffen-200 transition focus:border-geffen-400 focus:ring-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                Kosher
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setKosher(true)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                    kosher === true
                      ? "border-geffen-600 bg-geffen-600 text-white"
                      : "border-geffen-200 bg-white text-geffen-700 hover:border-geffen-400"
                  }`}
                >
                  Yes
                </button>
                <button
                  onClick={() => setKosher(undefined)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                    kosher === undefined
                      ? "border-geffen-600 bg-geffen-600 text-white"
                      : "border-geffen-200 bg-white text-geffen-700 hover:border-geffen-400"
                  }`}
                >
                  Any
                </button>
              </div>
            </div>
          </div>
        </section>

        {error && (
          <div className="mb-8 rounded-xl border border-red-300 bg-red-50 p-4">
            <p className="text-sm text-red-800">
              <strong>Error:</strong> {error}
            </p>
            <p className="mt-1 text-xs text-red-600">Check Search API availability and credentials.</p>
          </div>
        )}

        {results && (
          <>
            <section className="mb-8 rounded-2xl border border-geffen-100 bg-white p-4 shadow-xl shadow-geffen-100/30">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <div className="rounded-xl border border-geffen-100 bg-geffen-50 p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-geffen-700">Results</p>
                  <p className="text-2xl font-semibold text-geffen-700">{results.metadata.totalResults}</p>
                </div>
                <div className="rounded-xl border border-geffen-100 bg-white p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Parsing</p>
                  <p className="text-2xl font-semibold text-slate-800">{results.metadata.timings.parsing}ms</p>
                </div>
                <div className="rounded-xl border border-geffen-100 bg-white p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Embedding</p>
                  <p className="text-2xl font-semibold text-slate-800">{results.metadata.timings.embedding}ms</p>
                </div>
                <div className="rounded-xl border border-geffen-100 bg-white p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Vector</p>
                  <p className="text-2xl font-semibold text-slate-800">{results.metadata.timings.vectorSearch}ms</p>
                </div>
                <div className="rounded-xl border border-geffen-200 bg-geffen-50 p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-geffen-700">Total</p>
                  <p className="text-2xl font-semibold text-geffen-700">{results.metadata.timings.total}ms</p>
                </div>
              </div>

              {Object.keys(results.metadata.appliedFilters).length > 0 && (
                <div className="mt-4 rounded-xl border border-geffen-100 bg-geffen-50/60 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                    Active Filters
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {results.metadata.appliedFilters.colors?.map((c) => (
                      <span
                        key={c}
                        className="rounded-full border border-geffen-300 bg-white px-2.5 py-1 text-xs text-geffen-700"
                      >
                        color: {c}
                      </span>
                    ))}
                    {results.metadata.appliedFilters.countries?.map((c) => (
                      <span
                        key={c}
                        className="rounded-full border border-geffen-200 bg-white px-2.5 py-1 text-xs text-slate-700"
                      >
                        country: {c}
                      </span>
                    ))}
                    {results.metadata.appliedFilters.priceRange && (
                      <span className="rounded-full border border-geffen-200 bg-white px-2.5 py-1 text-xs text-slate-700">
                        מחיר: {formatIls(results.metadata.appliedFilters.priceRange.min || 0)} -{" "}
                        {results.metadata.appliedFilters.priceRange.max
                          ? formatIls(results.metadata.appliedFilters.priceRange.max)
                          : "ללא תקרה"}
                      </span>
                    )}
                    {results.metadata.appliedFilters.kosher && (
                      <span className="rounded-full border border-geffen-200 bg-white px-2.5 py-1 text-xs text-slate-700">
                        kosher
                      </span>
                    )}
                  </div>
                </div>
              )}
            </section>

            {results.products.length === 0 ? (
              <div className="py-20 text-center">
                <p className="text-lg text-slate-700">No wines found</p>
                <p className="mt-2 text-sm text-slate-500">Try a broader query or remove filters</p>
              </div>
            ) : (
              <section className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {results.products.map((product) => {
                  const imageSrc = resolveProductImageUrl(product);
                  return (
                    <article
                      key={product._id}
                      className="group overflow-hidden rounded-2xl border border-geffen-100 bg-white transition hover:border-geffen-300 hover:shadow-lg"
                    >
                      <div className="relative flex h-44 items-center justify-center border-b border-geffen-100 bg-gradient-to-b from-geffen-50 to-white">
                        {imageSrc ? (
                          <img
                            src={imageSrc}
                            alt={product.name}
                            className="h-full w-full object-contain p-1 opacity-95 transition group-hover:opacity-100"
                          />
                        ) : (
                          <div className="flex items-center gap-3 text-geffen-500">
                            <div className={`h-3 w-3 rounded-full ${colorTone[product.color || ""] || "bg-geffen-400"}`} />
                            <span className="text-xs uppercase tracking-[0.18em]">No Image</span>
                          </div>
                        )}
                      </div>

                      <div className="p-4">
                        <h3 className="mb-1 line-clamp-2 text-sm font-semibold text-slate-900">{product.name}</h3>

                        {product.description && (
                          <p className="mb-3 line-clamp-3 text-xs text-slate-500">
                            {toPlainText(product.description)}
                          </p>
                        )}

                        {reasonsById[product._id] && (
                          <div className="mb-3 rounded-lg border border-geffen-200 bg-geffen-50 px-2.5 py-2">
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-geffen-700">
                              למה זה מתאים לשאילתה
                            </p>
                            <p className="text-xs leading-5 text-geffen-800">{reasonsById[product._id]}</p>
                          </div>
                        )}

                        <div className="mb-3 space-y-1 text-xs text-slate-500">
                          {product.color && (
                            <p>
                              Color: <span className="capitalize text-slate-800">{product.color}</span>
                            </p>
                          )}
                          {product.country && (
                            <p>
                              Country: <span className="capitalize text-slate-800">{product.country}</span>
                            </p>
                          )}
                          {product.grapes && product.grapes.length > 0 && (
                            <p>
                              Grapes: <span className="capitalize text-slate-800">{product.grapes.slice(0, 2).join(", ")}</span>
                            </p>
                          )}
                        </div>

                        <div className="flex items-end justify-between border-t border-geffen-100 pt-3">
                          <p className="text-xl font-semibold text-geffen-700">{formatIls(product.price)}</p>
                          <div className="text-right">
                            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Match</p>
                            <p className="text-sm font-semibold text-geffen-700">
                              {Math.round((product.finalScore || product.score) * 100)}%
                            </p>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </section>
            )}

            {explanationIntro && (
              <div className="mt-5 rounded-xl border border-geffen-200 bg-geffen-50/70 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                  סיכום התאמה (LLM)
                </p>
                <p className="mt-1 text-sm text-geffen-800">{explanationIntro}</p>
              </div>
            )}
          </>
        )}

        {!results && !error && !loading && (
          <section className="py-24 text-center">
            <p className="mb-2 text-sm uppercase tracking-[0.18em] text-geffen-700">Geffen Search</p>
            <h2 className="mb-3 text-2xl font-semibold text-slate-900">Ask in natural language</h2>
            <p className="text-sm text-slate-500">Example: red wine from bordeaux under ₪220</p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 md:flex-row">
              <button
                onClick={() => {
                  runManualSearchFor("red wine from bordeaux");
                }}
                className="rounded-full border border-geffen-200 bg-white px-4 py-2 text-sm text-geffen-700 transition hover:border-geffen-400 hover:bg-geffen-50"
              >
                Try: Bordeaux Red
              </button>
              <button
                onClick={() => {
                  runManualSearchFor("יין לבן יבש");
                }}
                className="rounded-full border border-geffen-200 bg-white px-4 py-2 text-sm text-geffen-700 transition hover:border-geffen-400 hover:bg-geffen-50"
              >
                Try: יין לבן יבש
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
