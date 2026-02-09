const SECTIONS: Record<string, { label: string; color: string; dotColor: string }> = {
  PROMOTE_THIS_THEME: {
    label: "Promote This Theme",
    color: "text-emerald-700",
    dotColor: "bg-emerald-500"
  },
  FIX_THIS_ISSUE: {
    label: "Fix This Issue",
    color: "text-red-600",
    dotColor: "bg-red-500"
  },
  TALK_ABOUT_THIS: {
    label: "Talk About This",
    color: "text-blue-700",
    dotColor: "bg-blue-500"
  }
};

export function getSectionMeta(ctaType: string) {
  return SECTIONS[ctaType] ?? {
    label: ctaType.replaceAll("_", " "),
    color: "text-gray-700",
    dotColor: "bg-gray-400"
  };
}

export function SectionHeader({ ctaType, count }: { ctaType: string; count: number }) {
  const cfg = getSectionMeta(ctaType);
  return (
    <div className="flex items-center gap-3">
      <span className={`w-2 h-2 rounded-full ${cfg.dotColor}`} />
      <h2 className={`text-[17px] font-semibold ${cfg.color}`}>{cfg.label}</h2>
      <span className="text-xs font-medium text-gray-300 bg-gray-100 rounded-full px-2 py-0.5">{count}</span>
    </div>
  );
}
