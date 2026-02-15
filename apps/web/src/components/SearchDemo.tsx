import { Link } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
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
  retrieval?: {
    vectorCandidates: number;
    textCandidates: number;
    mergedCandidates: number;
    mode?: "text_only" | "hybrid";
    vectorStatus?: "ok" | "empty" | "skipped_text_strong" | "embedding_failed";
  };
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

interface DetectedWine {
  name: string;
  producer?: string;
  vintage?: number;
  wineColor?: "red" | "white" | "rose" | "sparkling";
  country?: string;
  region?: string;
  grapes?: string[];
  styleTags?: string[];
  confidence?: number;
}

interface ImageSearchResponse {
  detectedWine: DetectedWine;
  exactMatch: WineProduct | null;
  textualMatches: WineProduct[];
  alternatives: WineProduct[];
  metadata: {
    decision: "exact" | "alternatives";
    searchStrategy?: "text_first_then_vector";
    reason: string;
    textualCount?: number;
    alternativesCount?: number;
    vectorAttempted?: boolean;
    vectorUsedAsFallback?: boolean;
    messages?: {
      textualSection?: string;
      alternativesSection?: string;
    };
    derivedTags: string[];
    tagSource: "llm_catalog_context" | "catalog_fallback";
    timings: {
      analysis: number;
      matching: number;
      tagging: number;
      total: number;
    };
  };
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

function normalizeForAutocomplete(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTextMatchedAutocompleteOptions(products: WineProduct[], query: string): string[] {
  const normalizedQuery = normalizeForAutocomplete(query);
  if (!normalizedQuery) return [];
  const queryTerms = normalizedQuery.split(/\s+/).filter((term) => term.length > 1);
  if (queryTerms.length === 0) return [];

  return Array.from(
    new Set(
      (products || [])
        .map((product) => product.name?.trim())
        .filter((name): name is string => Boolean(name))
        .filter((name) => {
          const normalizedName = normalizeForAutocomplete(name);
          return queryTerms.some((term) => normalizedName.includes(term));
        })
    )
  ).slice(0, 8);
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
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imageSearching, setImageSearching] = useState(false);
  const [imageResult, setImageResult] = useState<ImageSearchResponse | null>(null);
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
      setImageResult(null);
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
      setImageResult(null);
      const hasTextMatches = (data.metadata?.retrieval?.textCandidates || 0) > 0;
      setAutocompleteOptions(
        hasTextMatches ? buildTextMatchedAutocompleteOptions(data.products || [], q) : []
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
      setImageResult(null);
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

  const prepareImageDataUrl = useCallback(async (file: File): Promise<string> => {
    const fileDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed reading image"));
      reader.readAsDataURL(file);
    });

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Invalid image file"));
      img.src = fileDataUrl;
    });

    const maxDim = 1400;
    const scale = Math.min(1, maxDim / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image processing failed");
    ctx.drawImage(image, 0, 0, width, height);

    return canvas.toDataURL("image/jpeg", 0.84);
  }, []);

  const handleImageSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        setError(null);
        const dataUrl = await prepareImageDataUrl(file);
        setImageDataUrl(dataUrl);
        setImagePreviewUrl(dataUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Image preparation failed");
      } finally {
        event.target.value = "";
      }
    },
    [prepareImageDataUrl]
  );

  const runImageSearch = useCallback(async () => {
    if (!imageDataUrl) return;
    setImageSearching(true);
    setError(null);
    setReasonsById({});
    setExplanationIntro("");
    try {
      const response = await fetch(`${API_URL}/search/by-image`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify({
          imageDataUrl,
          queryHint: query.trim() || undefined,
          limit: 12,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.message || `Error ${response.status}`);
      }

      setImageResult(payload as ImageSearchResponse);
      setResults(null);
      setAutocompleteOptions([]);
    } catch (err) {
      setImageResult(null);
      setError(err instanceof Error ? err.message : "Image search failed");
    } finally {
      setImageSearching(false);
    }
  }, [API_KEY, API_URL, imageDataUrl, query]);

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
    const q = normalizeForAutocomplete(query);
    if (!q) return [];
    const queryTerms = q.split(/\s+/).filter((t) => t.length > 1);

    const scored = autocompleteOptions.map((name) => {
      const normalizedName = normalizeForAutocomplete(name);
      if (normalizedName.includes(q)) return { name, score: 100 };
      const termHits = queryTerms.reduce(
        (sum, term) => sum + (normalizedName.includes(term) ? 1 : 0),
        0
      );
      return { name, score: termHits };
    });

    const matched = scored
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.name)
      .slice(0, 6);

    if (matched.length > 0) return matched;
    return autocompleteOptions.slice(0, 6);
  }, [autocompleteOptions, query]);

  const imageTextualMatches = useMemo(() => {
    if (!imageResult) return [];
    if (Array.isArray(imageResult.textualMatches) && imageResult.textualMatches.length > 0) {
      return imageResult.textualMatches;
    }
    return imageResult.exactMatch ? [imageResult.exactMatch] : [];
  }, [imageResult]);

  const imageAlternativeProducts = useMemo(() => {
    if (!imageResult) return [];
    const textualIds = new Set(imageTextualMatches.map((p) => String(p._id)));
    return (imageResult.alternatives || []).filter((p) => !textualIds.has(String(p._id)));
  }, [imageResult, imageTextualMatches]);

  const activeProducts = results?.products ?? [];
  const hasResultsPanel = Boolean(results || imageResult);
  const renderProductCard = (product: WineProduct, opts?: { showExactBadge?: boolean }) => {
    const imageSrc = resolveProductImageUrl(product);
    const isExactMatch =
      Boolean(opts?.showExactBadge) &&
      Boolean(imageResult?.exactMatch) &&
      String(imageResult?.exactMatch?._id) === String(product._id);

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
          {isExactMatch && (
            <span className="mb-2 inline-flex rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
              Exact Match
            </span>
          )}
          <h3 className="mb-1 line-clamp-2 text-sm font-semibold text-slate-900">{product.name}</h3>

          {product.description && (
            <p className="mb-3 line-clamp-3 text-xs text-slate-500">{toPlainText(product.description)}</p>
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
  };

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
            <p className="mb-3 text-xs text-slate-500">
              Ask in natural language. Example: red wine from bordeaux under ₪220
            </p>
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
            <div className="mt-3 flex flex-col gap-3 rounded-xl border border-geffen-100 bg-geffen-50/40 p-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-3">
                <label className="inline-flex cursor-pointer items-center rounded-lg border border-geffen-200 bg-white px-3 py-2 text-xs font-semibold text-geffen-700 transition hover:border-geffen-400">
                  Upload Or Camera
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleImageSelected}
                    className="hidden"
                  />
                </label>
                {imagePreviewUrl && (
                  <img
                    src={imagePreviewUrl}
                    alt="Wine preview"
                    className="h-12 w-12 rounded-lg border border-geffen-200 object-cover"
                  />
                )}
                <span className="text-xs text-slate-500">
                  {imageDataUrl ? "Image ready for semantic wine scan." : "Upload a wine bottle image to detect and match."}
                </span>
              </div>
              <button
                onClick={() => {
                  void runImageSearch();
                }}
                disabled={!imageDataUrl || imageSearching}
                className={`h-10 rounded-lg px-5 text-xs font-semibold transition ${
                  !imageDataUrl || imageSearching
                    ? "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400"
                    : "border border-geffen-600 bg-geffen-600 text-white hover:bg-geffen-700"
                }`}
              >
                {imageSearching ? "Scanning..." : "Scan Wine Image"}
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

        {hasResultsPanel && (
          <>
            <section className="mb-8 rounded-2xl border border-geffen-100 bg-white p-4 shadow-xl shadow-geffen-100/30">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <div className="rounded-xl border border-geffen-100 bg-geffen-50 p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-geffen-700">Results</p>
                  <p className="text-2xl font-semibold text-geffen-700">
                    {imageResult
                      ? imageTextualMatches.length + imageAlternativeProducts.length
                      : results?.metadata.totalResults || 0}
                  </p>
                </div>
                <div className="rounded-xl border border-geffen-100 bg-white p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    {imageResult ? "Analysis" : "Parsing"}
                  </p>
                  <p className="text-2xl font-semibold text-slate-800">
                    {imageResult ? `${imageResult.metadata.timings.analysis}ms` : `${results?.metadata.timings.parsing || 0}ms`}
                  </p>
                </div>
                <div className="rounded-xl border border-geffen-100 bg-white p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    {imageResult ? "Matching" : "Embedding"}
                  </p>
                  <p className="text-2xl font-semibold text-slate-800">
                    {imageResult ? `${imageResult.metadata.timings.matching}ms` : `${results?.metadata.timings.embedding || 0}ms`}
                  </p>
                </div>
                <div className="rounded-xl border border-geffen-100 bg-white p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">
                    {imageResult ? "Decision" : "Vector"}
                  </p>
                  <p className="text-sm font-semibold text-slate-800 md:text-2xl">
                    {imageResult
                      ? imageResult.metadata.vectorUsedAsFallback
                        ? "Vector Fallback"
                        : "Text First"
                      : `${results?.metadata.timings.vectorSearch || 0}ms`}
                  </p>
                </div>
                <div className="rounded-xl border border-geffen-200 bg-geffen-50 p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-geffen-700">Total</p>
                  <p className="text-2xl font-semibold text-geffen-700">
                    {imageResult ? `${imageResult.metadata.timings.total}ms` : `${results?.metadata.timings.total || 0}ms`}
                  </p>
                </div>
              </div>

              {results && Object.keys(results.metadata.appliedFilters).length > 0 && (
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

              {results && results.metadata.retrieval && (
                <div className="mt-4 rounded-xl border border-geffen-100 bg-white p-3 text-xs text-slate-600">
                  <span className="font-semibold text-geffen-700">Hybrid retrieval</span>: vector {results.metadata.retrieval.vectorCandidates}, text{" "}
                  {results.metadata.retrieval.textCandidates}, merged {results.metadata.retrieval.mergedCandidates}
                  {results.metadata.retrieval.mode && (
                    <span> | mode: {results.metadata.retrieval.mode}</span>
                  )}
                  {results.metadata.retrieval.vectorStatus && (
                    <span> | vector: {results.metadata.retrieval.vectorStatus}</span>
                  )}
                </div>
              )}

              {imageResult && (
                <div className="mt-4 rounded-xl border border-geffen-100 bg-white p-3 text-xs text-slate-600">
                  <span className="font-semibold text-geffen-700">Image strategy</span>: textual {imageTextualMatches.length}, alternatives{" "}
                  {imageAlternativeProducts.length}
                  {typeof imageResult.metadata.vectorAttempted === "boolean" && (
                    <span> | vector attempted: {imageResult.metadata.vectorAttempted ? "yes" : "no"}</span>
                  )}
                  {typeof imageResult.metadata.vectorUsedAsFallback === "boolean" && (
                    <span> | vector fallback: {imageResult.metadata.vectorUsedAsFallback ? "yes" : "no"}</span>
                  )}
                </div>
              )}
            </section>

            {imageResult && (
              <section className="mb-6 rounded-2xl border border-geffen-100 bg-white p-4 shadow-sm">
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-geffen-700">
                  Detected Wine
                </p>
                <div className="grid grid-cols-1 gap-2 text-sm text-slate-700 md:grid-cols-2">
                  <p>
                    Name: <span className="font-semibold text-slate-900">{imageResult.detectedWine.name}</span>
                  </p>
                  {imageResult.detectedWine.producer && (
                    <p>
                      Producer: <span className="font-semibold text-slate-900">{imageResult.detectedWine.producer}</span>
                    </p>
                  )}
                  {imageResult.detectedWine.country && (
                    <p>
                      Country: <span className="font-semibold text-slate-900">{imageResult.detectedWine.country}</span>
                    </p>
                  )}
                  {imageResult.detectedWine.wineColor && (
                    <p>
                      Color: <span className="font-semibold capitalize text-slate-900">{imageResult.detectedWine.wineColor}</span>
                    </p>
                  )}
                  {imageResult.detectedWine.region && (
                    <p>
                      Region: <span className="font-semibold text-slate-900">{imageResult.detectedWine.region}</span>
                    </p>
                  )}
                  {typeof imageResult.detectedWine.confidence === "number" && (
                    <p>
                      Confidence:{" "}
                      <span className="font-semibold text-slate-900">
                        {Math.round(imageResult.detectedWine.confidence * 100)}%
                      </span>
                    </p>
                  )}
                  {imageResult.detectedWine.styleTags && imageResult.detectedWine.styleTags.length > 0 && (
                    <p>
                      Style:{" "}
                      <span className="font-semibold text-slate-900">
                        {imageResult.detectedWine.styleTags.slice(0, 5).join(", ")}
                      </span>
                    </p>
                  )}
                </div>
                {imageResult.metadata.derivedTags && imageResult.metadata.derivedTags.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-geffen-700">
                      Wine Tags ({imageResult.metadata.tagSource === "llm_catalog_context" ? "LLM+Catalog" : "Catalog"})
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {imageResult.metadata.derivedTags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-geffen-200 bg-geffen-50 px-2.5 py-1 text-xs text-geffen-800"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

            {imageResult ? (
              <div className="space-y-6">
                <section className="rounded-2xl border border-geffen-100 bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-geffen-700">
                      התאמה טקסטואלית במלאי
                    </h3>
                    <span className="text-xs text-slate-500">{imageTextualMatches.length} מוצרים</span>
                  </div>
                  {imageTextualMatches.length === 0 ? (
                    <div className="rounded-xl border border-geffen-100 bg-geffen-50/40 px-4 py-6 text-center">
                      <p className="text-sm text-slate-700">
                        {imageResult.metadata.messages?.textualSection || "לא מצאנו בדיוק את מה שחיפשת"}
                      </p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {imageTextualMatches.map((product) =>
                        renderProductCard(product, { showExactBadge: true })
                      )}
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-geffen-100 bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-geffen-700">
                      {imageTextualMatches.length === 0
                        ? "לא מצאנו בדיוק את מה שחיפשת, הנה חלופות מתאימות"
                        : "חלופות דומות"}
                    </h3>
                    <span className="text-xs text-slate-500">{imageAlternativeProducts.length} מוצרים</span>
                  </div>
                  <p className="mb-3 text-xs text-slate-500">
                    {imageResult.metadata.messages?.alternativesSection || "הנה משהו שמתאים"}
                  </p>
                  {imageAlternativeProducts.length === 0 ? (
                    <div className="rounded-xl border border-geffen-100 bg-geffen-50/40 px-4 py-6 text-center">
                      <p className="text-sm text-slate-700">לא נמצאו כרגע חלופות מתאימות</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {imageAlternativeProducts.map((product) => renderProductCard(product))}
                    </div>
                  )}
                </section>
              </div>
            ) : activeProducts.length === 0 ? (
              <div className="py-20 text-center">
                <p className="text-lg text-slate-700">No wines found</p>
                <p className="mt-2 text-sm text-slate-500">Try a broader query or remove filters</p>
              </div>
            ) : (
              <section className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {activeProducts.map((product) => renderProductCard(product))}
              </section>
            )}

            {results && explanationIntro && (
              <div className="mt-5 rounded-xl border border-geffen-200 bg-geffen-50/70 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
                  סיכום התאמה (LLM)
                </p>
                <p className="mt-1 text-sm text-geffen-800">{explanationIntro}</p>
              </div>
            )}
          </>
        )}

        {!hasResultsPanel && !error && !loading && !imageSearching && (
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
