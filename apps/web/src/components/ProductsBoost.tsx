import { useCallback, useEffect, useMemo, useState } from "react";

interface WineProduct {
  _id: string;
  name: string;
  description?: string;
  price: number;
  imageUrl?: string;
}

interface ProductByNameResponse {
  products: WineProduct[];
}

interface BoostRule {
  _id: string;
  productId: string;
  productName: string;
  triggerQuery: string;
  matchMode: "contains" | "exact";
  boostPercent: number;
  pinToTop: boolean;
  active: boolean;
  startAt?: string;
  endAt?: string;
  updatedAt: string;
}

interface ProductsBoostProps {
  onBack?: () => void;
}

function formatIls(value: number): string {
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

export function ProductsBoost({ onBack }: ProductsBoostProps) {
  const [productOptions, setProductOptions] = useState<WineProduct[]>([]);
  const [loadingProductOptions, setLoadingProductOptions] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<WineProduct | null>(null);
  const [productNameLookup, setProductNameLookup] = useState("");
  const [triggerQuery, setTriggerQuery] = useState("יין לבן יבש");
  const [boostPercent, setBoostPercent] = useState("30");
  const [pinToTop, setPinToTop] = useState(false);
  const [matchMode, setMatchMode] = useState<"contains" | "exact">("contains");
  const [savingRule, setSavingRule] = useState(false);
  const [rules, setRules] = useState<BoostRule[]>([]);
  const [loadingRules, setLoadingRules] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const API_URL = import.meta.env.VITE_SEARCH_API_URL || "https://geffen.onrender.com";
  const API_KEY = import.meta.env.VITE_SEARCH_API_KEY || "test_key_store_a";
  const selectedSummary = useMemo(() => {
    if (!selectedProduct) return null;
    return `${selectedProduct.name} · ${formatIls(selectedProduct.price)}`;
  }, [selectedProduct]);

  const loadRules = useCallback(async () => {
    setLoadingRules(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/boost-rules`, {
        headers: { "X-API-Key": API_KEY },
      });
      if (!response.ok) {
        throw new Error(`Failed to load rules (${response.status})`);
      }
      const data = await response.json();
      setRules((data.rules || []) as BoostRule[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load rules");
    } finally {
      setLoadingRules(false);
    }
  }, [API_KEY, API_URL]);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const runProductSearch = useCallback(async (queryText: string) => {
    const q = queryText.trim();
    if (!q) return;
    setLoadingProductOptions(true);
    try {
      const response = await fetch(
        `${API_URL}/products/by-name?q=${encodeURIComponent(q)}&limit=12`,
        {
          headers: {
            "X-API-Key": API_KEY,
          },
        }
      );
      if (!response.ok) {
        throw new Error(`Search failed (${response.status})`);
      }
      const data: ProductByNameResponse = await response.json();
      setProductOptions(data.products || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoadingProductOptions(false);
    }
  }, [API_KEY, API_URL]);

  const matchingProducts = useMemo(() => {
    const q = productNameLookup.trim().toLowerCase();
    if (!q) return productOptions.slice(0, 6);
    return productOptions
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [productOptions, productNameLookup]);

  useEffect(() => {
    const q = productNameLookup.trim();
    if (q.length < 2) {
      setProductOptions([]);
      return;
    }
    const timer = setTimeout(() => {
      runProductSearch(q);
    }, 220);
    return () => clearTimeout(timer);
  }, [productNameLookup, runProductSearch]);

  const createRule = async () => {
    if (!selectedProduct || !triggerQuery.trim()) return;
    setSavingRule(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/boost-rules`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify({
          productId: selectedProduct._id,
          productName: selectedProduct.name,
          triggerQuery: triggerQuery.trim(),
          matchMode,
          boostPercent: Number(boostPercent) || 0,
          pinToTop,
          active: true,
        }),
      });
      if (!response.ok) {
        throw new Error(`Failed to create rule (${response.status})`);
      }
      await loadRules();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create rule");
    } finally {
      setSavingRule(false);
    }
  };

  const toggleRule = async (rule: BoostRule) => {
    try {
      const response = await fetch(`${API_URL}/boost-rules/${encodeURIComponent(rule._id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify({ active: !rule.active }),
      });
      if (!response.ok) throw new Error("Failed to update rule");
      await loadRules();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update rule");
    }
  };

  const deleteRule = async (rule: BoostRule) => {
    try {
      const response = await fetch(`${API_URL}/boost-rules/${encodeURIComponent(rule._id)}`, {
        method: "DELETE",
        headers: { "X-API-Key": API_KEY },
      });
      if (!response.ok && response.status !== 204) throw new Error("Failed to delete rule");
      await loadRules();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete rule");
    }
  };

  return (
    <div className="min-h-screen bg-[#fffdfd] text-slate-900">
      <header className="sticky top-0 z-30 border-b border-geffen-100 bg-white/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4 lg:px-10">
          <div className="flex items-center gap-4">
            <div className="rounded-xl border border-geffen-100 bg-white px-3 py-2 shadow-sm">
              <img src="/logo.png" alt="Geffen" className="h-5 w-auto" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-[0.2em] text-geffen-700">PRODUCTS BOOST</h1>
              <p className="text-xs text-slate-500">Control promoted wines by search intent</p>
            </div>
          </div>
          <button
            onClick={onBack}
            className="rounded-full border border-geffen-200 px-4 py-2 text-xs font-semibold text-geffen-700 transition hover:border-geffen-400 hover:bg-geffen-50"
          >
            Back
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-6 px-6 py-8 lg:px-10">
        {error && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>
        )}

        <section className="rounded-2xl border border-geffen-100 bg-white p-6 shadow-lg shadow-geffen-100/30">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
            1) Create Boost Rule
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs text-slate-500">Selected product</p>
              <div className="rounded-xl border border-geffen-100 bg-geffen-50/50 px-3 py-2">
                <input
                  value={productNameLookup}
                  onChange={(e) => {
                    setProductNameLookup(e.target.value);
                    if (!e.target.value.trim()) {
                      setSelectedProduct(null);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      runProductSearch(productNameLookup.trim());
                    }
                  }}
                  placeholder="חפש לפי שם מוצר..."
                  className="h-9 w-full rounded-lg border border-geffen-200 bg-white px-3 text-sm outline-none focus:border-geffen-400"
                />
                <div className="mt-2 max-h-36 space-y-1 overflow-auto">
                  {loadingProductOptions && (
                    <p className="px-2 py-1 text-xs text-slate-500">מחפש...</p>
                  )}
                  {matchingProducts.map((p) => (
                    <button
                      key={`match-${p._id}`}
                      onClick={() => {
                        setSelectedProduct(p);
                        setProductNameLookup(p.name);
                      }}
                      className={`w-full rounded-md px-2 py-1.5 text-left text-xs transition ${
                        selectedProduct?._id === p._id
                          ? "bg-geffen-100 text-geffen-800"
                          : "hover:bg-geffen-50 text-slate-700"
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                  {matchingProducts.length === 0 && (
                    <p className="px-2 py-1 text-xs text-slate-500">
                      אין התאמה מקומית. לחץ Enter כדי לחפש לפי השם.
                    </p>
                  )}
                </div>
                <p className="mt-2 text-xs text-geffen-700">
                  {selectedSummary || "לא נבחר מוצר עדיין"}
                </p>
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs text-slate-500">Trigger query</p>
              <input
                value={triggerQuery}
                onChange={(e) => setTriggerQuery(e.target.value)}
                placeholder="יין לבן יבש"
                className="h-10 w-full rounded-xl border border-geffen-200 px-3 text-sm outline-none focus:border-geffen-400"
              />
            </div>
            <div>
              <p className="mb-1 text-xs text-slate-500">Boost percent</p>
              <input
                type="number"
                value={boostPercent}
                onChange={(e) => setBoostPercent(e.target.value)}
                min={0}
                max={200}
                className="h-10 w-full rounded-xl border border-geffen-200 px-3 text-sm outline-none focus:border-geffen-400"
              />
            </div>
            <div>
              <p className="mb-1 text-xs text-slate-500">Match mode</p>
              <select
                value={matchMode}
                onChange={(e) => setMatchMode(e.target.value as "contains" | "exact")}
                className="h-10 w-full rounded-xl border border-geffen-200 px-3 text-sm outline-none focus:border-geffen-400"
              >
                <option value="contains">contains</option>
                <option value="exact">exact</option>
              </select>
            </div>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={pinToTop}
              onChange={(e) => setPinToTop(e.target.checked)}
              className="h-4 w-4 accent-geffen-600"
            />
            Pin to top when rule matches
          </label>
          <button
            onClick={createRule}
            disabled={!selectedProduct || !triggerQuery.trim() || savingRule}
            className="mt-4 rounded-xl border border-geffen-600 bg-geffen-600 px-5 py-2 text-sm font-semibold text-white hover:bg-geffen-700 disabled:opacity-60"
          >
            {savingRule ? "Saving..." : "Create Boost Rule"}
          </button>
        </section>

        <section className="rounded-2xl border border-geffen-100 bg-white p-6 shadow-lg shadow-geffen-100/30">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">
              2) Active Rules
            </p>
            <button
              onClick={loadRules}
              disabled={loadingRules}
              className="rounded-lg border border-geffen-200 px-3 py-1.5 text-xs text-geffen-700 hover:bg-geffen-50 disabled:opacity-60"
            >
              Refresh
            </button>
          </div>
          <div className="space-y-2">
            {rules.length === 0 && <p className="text-sm text-slate-500">No boost rules yet.</p>}
            {rules.map((rule) => (
              <div key={rule._id} className="rounded-xl border border-geffen-100 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{rule.productName}</p>
                    <p className="text-xs text-slate-500">
                      trigger: "{rule.triggerQuery}" · {rule.matchMode} · +{rule.boostPercent}%
                      {rule.pinToTop ? " · PIN" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleRule(rule)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                        rule.active
                          ? "border border-emerald-300 bg-emerald-50 text-emerald-700"
                          : "border border-slate-300 bg-slate-50 text-slate-600"
                      }`}
                    >
                      {rule.active ? "Active" : "Paused"}
                    </button>
                    <button
                      onClick={() => deleteRule(rule)}
                      className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
