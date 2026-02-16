import { useEffect, useState, useCallback } from "react";
import { Routes, Route, Link, useNavigate } from "react-router-dom";
import { fetchInsights, generateReport, groupByType, type Insight } from "./api/client";
import { InsightCard } from "./components/InsightCard";
import { SectionHeader } from "./components/SectionHeader";
import { SearchDemo } from "./components/SearchDemo";
import { ProductsBoost } from "./components/ProductsBoost";
import { AcademyChat } from "./components/AcademyChat";
import { OnboardingFunnel } from "./components/OnboardingFunnel";
import { OnboardingDemo } from "./components/OnboardingDemo";

const SECTION_ORDER = ["PROMOTE_THIS_THEME", "FIX_THIS_ISSUE", "TALK_ABOUT_THIS"];

const SECTION_DESCRIPTIONS: Record<string, string> = {
  PROMOTE_THIS_THEME: "What to push this week based on customer demand",
  FIX_THIS_ISSUE: "What to fix to avoid losing sales",
  TALK_ABOUT_THIS: "What to communicate with customers"
};

function InsightsPage() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [banner, setBanner] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { insights: data } = await fetchInsights();
      setInsights(data);
    } catch (e) {
      setBanner({ type: "error", text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleGenerate = async () => {
    setGenerating(true);
    setBanner(null);
    try {
      const result = await generateReport();
      setBanner({
        type: result.errors ? "error" : "success",
        text: `Generated content for ${result.generated} action${result.generated !== 1 ? "s" : ""}${result.errors ? ` (${result.errors.length} error${result.errors.length !== 1 ? "s" : ""})` : ""}`
      });
      await load();
    } catch (e) {
      setBanner({ type: "error", text: (e as Error).message });
    } finally {
      setGenerating(false);
    }
  };

  const grouped = groupByType(insights);
  const hasAnyCopy = insights.some((i) => i.copy.length > 0);

  return (
    <div className="min-h-screen bg-[#f5f5f7]">
      {/* Header */}
      <header className="bg-white border-b border-gray-200/70 sticky top-0 z-30">
        <div className="px-6 lg:px-10 xl:px-16 py-4 flex items-center justify-between max-w-[1600px] mx-auto">
          <div>
            <div className="flex items-center gap-4">
              <img src="/logo.png" alt="Geffen" className="h-7" />
              <div className="h-5 w-px bg-gray-200 hidden sm:block" />
              <div className="hidden sm:block">
                <h1 className="text-[15px] font-semibold text-gray-900">Recommended Actions</h1>
                <p className="text-[11px] text-gray-400">Based on customer behavior this week</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {!loading && insights.length > 0 && (
              <span className="text-[13px] text-gray-400 hidden md:block">
                {insights.length} action{insights.length !== 1 ? "s" : ""}
              </span>
            )}
            <Link
              to="/search-demo"
              className="rounded-full px-4 py-2 text-[13px] font-semibold transition-all bg-purple-600 text-white hover:bg-purple-700 active:scale-[0.97] shadow-sm"
            >
              🍷 Search Demo
            </Link>
            <Link
              to="/onboarding"
              className="rounded-full px-4 py-2 text-[13px] font-semibold transition-all bg-emerald-600 text-white hover:bg-emerald-700 active:scale-[0.97] shadow-sm"
            >
              Onboarding Demo
            </Link>
            <Link
              to="/products-boost"
              className="rounded-full px-4 py-2 text-[13px] font-semibold transition-all bg-geffen-600 text-white hover:bg-geffen-700 active:scale-[0.97] shadow-sm"
            >
              Products Boost
            </Link>
            <Link
              to="/academy"
              className="rounded-full px-4 py-2 text-[13px] font-semibold transition-all bg-slate-900 text-white hover:bg-slate-700 active:scale-[0.97] shadow-sm"
            >
              Academy
            </Link>
            <button
              onClick={handleGenerate}
              disabled={generating || insights.length === 0}
              className={`rounded-full px-5 py-2 text-[13px] font-semibold transition-all ${
                generating
                  ? "bg-gray-100 text-gray-400 cursor-wait"
                  : "bg-geffen text-white hover:bg-geffen-700 active:scale-[0.97] shadow-sm"
              }`}
            >
              {generating ? "Generating..." : hasAnyCopy ? "Regenerate Content" : "Generate Content"}
            </button>
          </div>
        </div>
      </header>

      {/* Banner */}
      {banner && (
        <div className="px-6 lg:px-10 xl:px-16 pt-5 max-w-[1600px] mx-auto">
          <div className={`rounded-lg px-4 py-2.5 text-[13px] flex items-center justify-between ${
            banner.type === "success"
              ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
              : "bg-red-50 text-red-700 border border-red-100"
          }`}>
            <span>{banner.text}</span>
            <button className="text-[11px] font-medium opacity-60 hover:opacity-100 ml-3" onClick={() => setBanner(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main */}
      <main className="px-6 lg:px-10 xl:px-16 py-8 max-w-[1600px] mx-auto">
        {loading && (
          <div className="flex items-center justify-center py-32">
            <div className="spinner" />
          </div>
        )}

        {!loading && insights.length === 0 && (
          <div className="text-center py-32">
            <p className="text-gray-500 text-base">No recommendations yet</p>
            <p className="text-gray-300 text-sm mt-1">Run the trends pipeline to generate insights</p>
          </div>
        )}

        {!loading && insights.length > 0 && (
          <div className="space-y-12">
            {SECTION_ORDER.map((type) => {
              const group = grouped.get(type);
              if (!group || group.length === 0) return null;
              return (
                <section key={type}>
                  <SectionHeader ctaType={type} count={group.length} />
                  <p className="text-[13px] text-gray-400 mb-4">{SECTION_DESCRIPTIONS[type]}</p>
                  <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
                    {group.map((ins) => (
                      <InsightCard key={ins.id} insight={ins} />
                    ))}
                  </div>
                </section>
              );
            })}

            {/* Catch any types not in order */}
            {Array.from(grouped.entries())
              .filter(([t]) => !SECTION_ORDER.includes(t))
              .map(([type, group]) => (
                <section key={type}>
                  <SectionHeader ctaType={type} count={group.length} />
                  <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
                    {group.map((ins) => (
                      <InsightCard key={ins.id} insight={ins} />
                    ))}
                  </div>
                </section>
              ))}
          </div>
        )}
      </main>
    </div>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<InsightsPage />} />
      <Route path="/search-demo" element={<SearchDemo onBack={() => window.history.back()} />} />
      <Route path="/products-boost" element={<ProductsBoost onBack={() => window.history.back()} />} />
      <Route path="/academy" element={<AcademyChat onBack={() => window.history.back()} />} />
      <Route path="/onboarding" element={<OnboardingFunnel />} />
      <Route path="/onboarding/demo/:token" element={<OnboardingDemo />} />
    </Routes>
  );
}

export default App;
