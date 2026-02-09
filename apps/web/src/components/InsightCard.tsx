import { useState } from "react";
import type { Insight } from "../api/client";
import { getSectionMeta } from "./SectionHeader";

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="text-[11px] font-medium text-geffen-600 hover:text-geffen-800 transition-colors"
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1500);
      }}
    >
      {ok ? "Copied" : (label ?? "Copy")}
    </button>
  );
}

function ContentRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="py-2.5 border-b border-gray-50 last:border-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{label}</span>
        <CopyBtn text={text} />
      </div>
      <p className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-wrap" dir="rtl">{text}</p>
    </div>
  );
}

export function InsightCard({ insight }: { insight: Insight }) {
  const [open, setOpen] = useState(false);
  const copy = insight.copy[0] ?? null;
  const meta = getSectionMeta(insight.cta_type);

  const title = copy?.title ?? insight.entity_key;
  const explanation = copy?.explanation ?? insight.recommended_action;

  const evidence = insight.evidence as Record<string, unknown>;
  const pctChange = evidence.pctChange as number | undefined;

  return (
    <div
      className="bg-white rounded-xl border border-gray-100 hover:border-gray-200 hover:shadow-[0_4px_20px_rgba(0,0,0,0.05)] transition-all cursor-pointer flex flex-col"
      onClick={() => setOpen(!open)}
    >
      <div className="p-5 flex-1">
        {/* Top: colored indicator + confidence badge */}
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${meta.dotColor}`} />
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${meta.color}`}>
              {meta.label}
            </span>
          </div>
          <span className="text-[10px] font-medium text-gray-400 bg-gray-50 rounded px-2 py-0.5 tabular-nums">
            {Math.round(insight.confidence * 100)}% confidence
          </span>
        </div>

        {/* Title (entity or LLM-generated) */}
        <h3 className="text-[15px] font-semibold text-gray-900 leading-snug mb-1.5">{title}</h3>

        {/* Explanation */}
        <p className="text-[13px] text-gray-600 leading-relaxed">{explanation}</p>

        {/* Optional: Show key metric if present */}
        {pctChange !== undefined && pctChange !== 0 && (
          <div className="mt-3">
            <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded ${
              pctChange > 0
                ? "bg-emerald-50 text-emerald-600"
                : "bg-red-50 text-red-500"
            }`}>
              {pctChange > 0 ? "+" : ""}{pctChange > 999 ? "999+" : Math.round(pctChange)}% change
            </span>
          </div>
        )}
      </div>

      {/* Expanded AI content */}
      {open && copy && (
        <div className="border-t border-gray-100 px-5 pb-4 pt-1">
          <ContentRow label="Newsletter" text={`${copy.newsletter_subject}\n\n${copy.newsletter_body}`} />
          {copy.social_talking_points && <ContentRow label="Social Talking Points" text={copy.social_talking_points} />}
        </div>
      )}

      {open && !copy && (
        <div className="border-t border-gray-100 px-5 py-4 text-center">
          <p className="text-[13px] text-gray-400">Click "Generate Report" to create content for this action</p>
        </div>
      )}
    </div>
  );
}
