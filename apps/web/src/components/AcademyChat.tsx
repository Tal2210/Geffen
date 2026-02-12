import { useEffect, useState } from "react";

interface AcademyProduct {
  _id: string;
  name: string;
  description?: string;
  price?: number;
  imageUrl?: string;
  reason: string;
}

interface AcademyResponse {
  answer: string;
  products: AcademyProduct[];
  mode: "popular_week" | "recommendation";
  teachingPlan?: Array<{ title: string; text: string }>;
}

interface PopularWeekResponse {
  products: AcademyProduct[];
}

interface AcademyChatProps {
  onBack?: () => void;
}

type ChatMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      products?: AcademyProduct[];
      teachingPlan?: Array<{ title: string; text: string }>;
    };

function formatIls(value?: number): string | null {
  if (typeof value !== "number") return null;
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

export function AcademyChat({ onBack }: AcademyChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "אפשר לשאול אותי שאלות כמו: מה היין הכי פופולרי השבוע? או איזה יין ישראלי מתאים לבשר?",
    },
  ]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastQuestion, setLastQuestion] = useState("");
  const [popularWeek, setPopularWeek] = useState<AcademyProduct[]>([]);
  const [loadingPopularWeek, setLoadingPopularWeek] = useState(false);
  const [refreshingWeekly, setRefreshingWeekly] = useState(false);

  const API_URL = import.meta.env.VITE_SEARCH_API_URL || "https://geffen.onrender.com";
  const API_KEY = import.meta.env.VITE_SEARCH_API_KEY || "test_key_store_a";
  const quickQuestions = [
    "מה היין הכי פופולרי השבוע?",
    "איזה יין ישראלי מתאים לבשר?",
    "תן לי 3 יינות לבנים יבשים ללקוחות מתחילים",
    "איזה יין מתאים לדגים וארוחה קלילה?",
  ];

  const postEvent = async (path: string, payload: Record<string, unknown>) => {
    try {
      await fetch(`${API_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Best-effort telemetry only.
    }
  };

  const ask = async () => {
    const q = question.trim();
    if (!q || loading) return;

    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setQuestion("");
    setLastQuestion(q);
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/academy/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify({ question: q }),
      });

      if (!response.ok) {
        let serverMessage = "";
        let rawBody = "";
        try {
          rawBody = await response.text();
          const errorBody = rawBody ? JSON.parse(rawBody) : {};
          serverMessage = String(errorBody?.message || "");
        } catch {
          // Ignore parse errors and fall back to status-based text.
        }
        console.error("[AcademyChat] /academy/chat failed", {
          status: response.status,
          statusText: response.statusText,
          serverMessage,
          rawBody,
          apiUrl: `${API_URL}/academy/chat`,
        });
        if (serverMessage.includes("academy_llm_required")) {
          throw new Error("ה-LLM לא זמין כרגע (embedding/vector). בדוק מפתח API, quota וחיבור לרשת.");
        }
        throw new Error(serverMessage || `Academy chat failed (${response.status})`);
      }

      const data: AcademyResponse = await response.json();
      void postEvent("/academy/events/search", {
        question: q,
        resultProductIds: (data.products || []).map((p) => p._id),
      });
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: data.answer,
          products: data.products || [],
          teachingPlan: data.teachingPlan || [],
        },
      ]);
    } catch (error) {
      console.error("[AcademyChat] request error", error);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: error instanceof Error ? error.message : "אירעה שגיאה בשליחת השאלה.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const loadPopularWeek = async () => {
    setLoadingPopularWeek(true);
    try {
      const response = await fetch(`${API_URL}/academy/metrics/popular-week?limit=5`, {
        headers: { "X-API-Key": API_KEY },
      });
      if (!response.ok) throw new Error("Failed loading weekly ranking");
      const data: PopularWeekResponse = await response.json();
      setPopularWeek(data.products || []);
    } catch {
      setPopularWeek([]);
    } finally {
      setLoadingPopularWeek(false);
    }
  };

  const recomputeWeekly = async () => {
    setRefreshingWeekly(true);
    try {
      await fetch(`${API_URL}/academy/metrics/recompute-weekly`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify({}),
      });
      await loadPopularWeek();
    } finally {
      setRefreshingWeekly(false);
    }
  };

  useEffect(() => {
    void loadPopularWeek();
  }, []);

  return (
    <div className="min-h-screen bg-[#fffdfd] text-slate-900">
      <header className="sticky top-0 z-30 border-b border-geffen-100 bg-white/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4 lg:px-10">
          <div className="flex items-center gap-4">
            <div className="rounded-xl border border-geffen-100 bg-white px-3 py-2 shadow-sm">
              <img src="/logo.png" alt="Geffen" className="h-5 w-auto" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-[0.2em] text-geffen-700">ACADEMY CHAT</h1>
              <p className="text-xs text-slate-500">Ask questions about wines and product intelligence</p>
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

      <main className="mx-auto max-w-[1100px] px-6 py-8 lg:px-10">
        <section className="mb-5 rounded-2xl border border-geffen-100 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-geffen-700">Top wines this week</p>
            <button
              onClick={recomputeWeekly}
              disabled={refreshingWeekly}
              className="rounded-full border border-geffen-200 px-3 py-1 text-xs font-semibold text-geffen-700 hover:border-geffen-400 disabled:opacity-60"
            >
              {refreshingWeekly ? "Refreshing..." : "Refresh Weekly"}
            </button>
          </div>
          {loadingPopularWeek && <p className="text-xs text-slate-500">Loading weekly insights...</p>}
          {!loadingPopularWeek && popularWeek.length === 0 && (
            <p className="text-xs text-slate-500">No weekly metrics yet. Start chatting and clicking products to generate signals.</p>
          )}
          {!loadingPopularWeek && popularWeek.length > 0 && (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {popularWeek.map((p, idx) => (
                <div key={`wk-${p._id}`} className="rounded-xl border border-geffen-100 bg-geffen-50/40 p-3">
                  <p className="text-[11px] font-semibold text-geffen-700">#{idx + 1}</p>
                  <p className="line-clamp-2 text-sm font-semibold text-slate-900">{p.name}</p>
                  {formatIls(p.price) && <p className="text-xs text-geffen-700">{formatIls(p.price)}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="rounded-2xl border border-geffen-100 bg-white p-4 shadow-lg shadow-geffen-100/30">
          <div className="mb-4 flex flex-wrap gap-2">
            {quickQuestions.map((qq) => (
              <button
                key={qq}
                onClick={() => setQuestion(qq)}
                className="rounded-full border border-geffen-200 bg-geffen-50 px-3 py-1 text-xs font-medium text-geffen-700 transition hover:border-geffen-400"
              >
                {qq}
              </button>
            ))}
          </div>

          <div className="mb-4 max-h-[60vh] space-y-4 overflow-auto pr-1">
            {messages.map((msg, idx) => (
              <div key={idx} className={msg.role === "user" ? "text-right" : "text-left"}>
                <div
                  className={`inline-block max-w-[90%] rounded-2xl px-4 py-2 text-sm leading-6 ${
                    msg.role === "user"
                      ? "bg-geffen-600 text-white"
                      : "border border-geffen-100 bg-geffen-50/60 text-slate-800"
                  }`}
                >
                  {msg.text}
                </div>

                {msg.role === "assistant" && msg.products && msg.products.length > 0 && (
                  <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                    {msg.products.map((p) => (
                      <button
                        key={p._id}
                        onClick={() => {
                          void postEvent("/academy/events/click", {
                            productId: p._id,
                            query: lastQuestion,
                          });
                        }}
                        className="rounded-xl border border-geffen-100 bg-white p-3 text-left transition hover:border-geffen-300 hover:shadow-sm"
                      >
                        <div className="flex gap-3">
                          {p.imageUrl ? (
                            <img
                              src={p.imageUrl}
                              alt={p.name}
                              className="h-16 w-16 rounded-lg border border-geffen-100 object-contain"
                            />
                          ) : (
                            <div className="h-16 w-16 rounded-lg bg-geffen-100" />
                          )}
                          <div className="min-w-0">
                            <p className="line-clamp-2 text-sm font-semibold text-slate-900">{p.name}</p>
                            {formatIls(p.price) && (
                              <p className="text-xs font-medium text-geffen-700">{formatIls(p.price)}</p>
                            )}
                            <p className="mt-1 text-xs text-slate-500">{p.reason}</p>
                            <p className="mt-1 text-[11px] font-medium text-slate-400">
                              לימוד: לחץ על הכרטיס כדי לרשום אינטראקציה למדדי פופולריות.
                            </p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {msg.role === "assistant" && msg.teachingPlan && msg.teachingPlan.length > 0 && (
                  <div className="mt-3 rounded-xl border border-geffen-100 bg-geffen-50/40 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-geffen-700">Mini lesson</p>
                    <div className="space-y-2">
                      {msg.teachingPlan.map((item, i) => (
                        <div key={`${idx}-tp-${i}`} className="rounded-lg border border-geffen-100 bg-white px-3 py-2">
                          <p className="text-xs font-semibold text-slate-800">{item.title}</p>
                          <p className="text-xs text-slate-600">{item.text}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ask()}
              placeholder="למשל: איזה יין ישראלי מתאים לבשר?"
              className="h-11 flex-1 rounded-xl border border-geffen-200 bg-white px-4 text-sm outline-none focus:border-geffen-400"
            />
            <button
              onClick={ask}
              disabled={loading || !question.trim()}
              className="h-11 rounded-xl border border-geffen-600 bg-geffen-600 px-5 text-sm font-semibold text-white hover:bg-geffen-700 disabled:opacity-60"
            >
              {loading ? "Thinking..." : "Ask"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
