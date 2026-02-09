export function clamp01(n: number) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function confidenceFromVolumeAndEffect(
  volume: number,
  effectPercent: number
): number {
  // Deterministic confidence proxy:
  // - More volume increases confidence slowly (log scale)
  // - Bigger effect sizes increase confidence
  const volumeScore = clamp01(Math.log10(Math.max(1, volume)) / 3); // ~1.0 at 1000+
  const effectScore = clamp01(Math.abs(effectPercent) / 100); // 100% change ~= 1.0
  return clamp01(0.6 * volumeScore + 0.4 * effectScore);
}

