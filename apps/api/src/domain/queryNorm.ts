export function normalizeQuery(raw: string): string {
  // Deterministic normalization that preserves Hebrew + Latin + digits:
  // - Unicode normalize + strip diacritics (niqqud)
  // - Lowercase Latin letters
  // - Keep Hebrew (U+0590–U+05FF), Latin a–z, and digits 0–9
  // - Collapse whitespace to single space, trim
  const s = raw
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^\u0590-\u05FFa-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return s;
}

