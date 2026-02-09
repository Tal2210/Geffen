export function formatPercent(value: number) {
  const pct = value * 100;
  return `${pct.toFixed(1)}%`;
}

export function formatDeltaWoW(deltaPercent: number) {
  const sign = deltaPercent >= 0 ? "+" : "";
  return `${sign}${deltaPercent.toFixed(0)}% WoW`;
}

