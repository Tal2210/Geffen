import type { ExtractedFilters } from "../types/index.js";

/**
 * Wine-specific patterns for natural language query parsing
 * Supports English and Hebrew (basic)
 */
const PATTERNS = {
  // Color categories (treated as hard category, not a separate "color" field)
  colorCategory: {
    red: /(?:\b(red|rouge|tinto|rosso)\b|אדום|אודם)/i,
    white: /(?:\b(white|blanc|blanco|bianco|chardonnay)\b|לבן|לבנה)/i,
    rosé: /(?:\b(ros[eé]|pink)\b|רוזה|רוזי)/i,
    sparkling: /(?:\b(sparkling|champagne|prosecco|cava|cremant)\b|מבעבע|קאווה|שמפניה)/i,
  },
  
  // Countries
  countries: {
    france: /(?:\b(france|french|français)\b|צרפת|צרפתי(?:ת|ים|ות)?)/i,
    italy: /(?:\b(italy|italian|italiano)\b|איטליה|איטלקי(?:ת|ים|ות)?)/i,
    spain: /(?:\b(spain|spanish|español)\b|ספרד|ספרדי(?:ת|ים|ות)?)/i,
    usa: /\b(usa|america|california|oregon|washington|ארה"ב|אמריק)\b/i,
    argentina: /\b(argentina|argentinian|ארגנטינה)\b/i,
    chile: /\b(chile|chilean|צ'ילה)\b/i,
    australia: /\b(australia|australian|אוסטרליה)\b/i,
    germany: /\b(germany|german|deutsch|גרמניה|גרמני)\b/i,
    portugal: /\b(portugal|portuguese|פורטוגל)\b/i,
    israel: /\b(israel|israeli|ישראל|ישראלי)\b/i,
  },
  
  // Regions
  regions: {
    bordeaux: /\b(bordeaux|בורדו)\b/i,
    burgundy: /\b(burgundy|bourgogne|בורגונדי)\b/i,
    champagne: /\b(champagne|שמפניה)\b/i,
    tuscany: /\b(tuscany|toscana|chianti|טוסקנה)\b/i,
    rioja: /\b(rioja|ריוחה)\b/i,
    napa: /\b(napa|נאפה)\b/i,
    barolo: /\b(barolo|בארולו)\b/i,
  },
  
  // Grape varieties
  grapes: {
    "cabernet sauvignon": /\b(cabernet\s*sauvignon|cab\s*sauv|קברנה)\b/i,
    merlot: /\b(merlot|מרלו)\b/i,
    "pinot noir": /\b(pinot\s*noir|פינו\s*נואר)\b/i,
    syrah: /\b(syrah|shiraz|שיראז|סירה)\b/i,
    chardonnay: /\b(chardonnay|שרדונה)\b/i,
    "sauvignon blanc": /\b(sauvignon\s*blanc|סוביניון\s*בלאן)\b/i,
    riesling: /\b(riesling|ריזלינג)\b/i,
    malbec: /\b(malbec|מאלבק)\b/i,
    tempranillo: /\b(tempranillo|טמפרניו)\b/i,
    "pinot grigio": /\b(pinot\s*grigio|pinot\s*gris|פינו\s*גריג'ו)\b/i,
  },
  
  // Sweetness
  sweetness: {
    dry: /\b(dry|sec|seco|secco|brut|יבש)\b/i,
    "semi-dry": /\b(semi[- ]dry|demi[- ]sec|off[- ]dry|חצי\s*יבש)\b/i,
    sweet: /\b(sweet|doux|dulce|dolce|dessert|מתוק)\b/i,
  },

  // Category / product type
  type: {
    wine: /(?:\b(wine|vino|vin)\b|יין)/i,
    beer: /(?:\b(beer|ale|lager)\b|בירה)/i,
    vodka: /(?:\b(vodka)\b|וודקה)/i,
    whiskey: /(?:\b(whisky|whiskey)\b|וויסקי)/i,
    liqueur: /(?:\b(liqueur)\b|ליקר)/i,
    gin: /(?:\b(gin)\b|ג׳ין|גין)/i,
    rum: /(?:\b(rum)\b|רום)/i,
    tequila: /(?:\b(tequila)\b|טקילה)/i,
    brandy: /(?:\b(brandy)\b|ברנדי|קוניאק)/i,
    soda: /(?:\b(soda|soft\s*drink)\b|משקאות\s*קלים)/i,
  },

  // Soft intent tags (food pairing / context)
  softTags: {
    "italian food": /(?:\b(italian\s*food|italian\s*cuisine)\b|אוכל\s*איטלקי|ארוחה\s*איטלקית|לאוכל\s*איטלקי)/i,
    pizza: /(?:\b(pizza)\b|ל?פיצ(?:ה|ות))/i,
    fish: /(?:\b(fish|seafood)\b|ל?דג(?:ים)?|פירות\s*ים)/i,
    meat: /(?:\b(meat|beef|steak)\b|ל?בשר)/i,
    cheese: /(?:\b(cheese)\b|ל?גבינ(?:ה|ות))/i,
    pasta: /(?:\b(pasta)\b|ל?פסט(?:ה|ות))/i,
  },
  
  // Price patterns
  price: {
    under20: /\b(under|below|less\s*than|cheaper\s*than|עד|פחות\s*מ)\s*[$€£₪]?\s*20\b/i,
    under30: /\b(under|below|less\s*than|עד|פחות\s*מ)\s*[$€£₪]?\s*30\b/i,
    under50: /\b(under|below|less\s*than|עד|פחות\s*מ)\s*[$€£₪]?\s*50\b/i,
    under100: /\b(under|below|less\s*than|עד|פחות\s*מ)\s*[$€£₪]?\s*100\b/i,
    budget: /\b(budget|cheap|affordable|inexpensive|זול|בזול|משתלם)\b/i,
    premium: /\b(premium|expensive|luxury|fine|יקר|איכותי|פרימיום)\b/i,
    range: /[$€£₪]?(\d+)[-–][$€£₪]?(\d+)|(\d+)[-–](\d+)\s*(dollars?|euros?|shekels?|₪)/i,
  },
  
  // Kosher
  kosher: /\b(kosher|kashrut|כשר|כשרה)\b/i,
};

/**
 * Fast rule-based query parser for wine search
 * Extracts filters from natural language queries
 */
export class QueryParser {
  /**
   * Parse natural language query and extract structured filters
   */
  parse(query: string): ExtractedFilters {
    const filters: ExtractedFilters = {};

    // Extract color categories as hard category
    const colorCategory = Object.entries(PATTERNS.colorCategory)
      .filter(([_, pattern]) => pattern.test(query))
      .map(([color]) => color);
    if (colorCategory.length > 0) filters.category = colorCategory;

    // Extract countries
    const countries = Object.entries(PATTERNS.countries)
      .filter(([_, pattern]) => pattern.test(query))
      .map(([country]) => country);
    if (countries.length > 0) filters.countries = countries;

    // Extract regions
    const regions = Object.entries(PATTERNS.regions)
      .filter(([_, pattern]) => pattern.test(query))
      .map(([region]) => region);
    if (regions.length > 0) filters.regions = regions;

    // Extract grapes
    const grapes = Object.entries(PATTERNS.grapes)
      .filter(([_, pattern]) => pattern.test(query))
      .map(([grape]) => grape);
    if (grapes.length > 0) filters.grapes = grapes;

    // Extract sweetness
    const sweetness = Object.entries(PATTERNS.sweetness)
      .filter(([_, pattern]) => pattern.test(query))
      .map(([sweet]) => sweet);
    if (sweetness.length > 0) filters.sweetness = sweetness;

  // Extract type / product class
  const type = Object.entries(PATTERNS.type)
    .filter(([_, pattern]) => pattern.test(query))
    .map(([cat]) => cat);
  if (type.length > 0) filters.type = type;

  // Extract soft intent tags
  const softTags = Object.entries(PATTERNS.softTags)
    .filter(([_, pattern]) => pattern.test(query))
    .map(([tag]) => tag);
  if (softTags.length > 0) filters.softTags = softTags;

  // Hard color category already captured above

    // Extract price range
    const priceRange = this.extractPriceRange(query);
    if (priceRange) filters.priceRange = priceRange;

    // Extract kosher
    if (PATTERNS.kosher.test(query)) {
      filters.kosher = true;
    }

    return filters;
  }

  /**
   * Extract price range from query
   */
  private extractPriceRange(query: string): { min?: number; max?: number } | undefined {
    // Check for explicit range pattern: "$20-$50" or "20-50 dollars"
    const rangeMatch = query.match(PATTERNS.price.range);
    if (rangeMatch) {
      const min = parseInt(rangeMatch[1] || rangeMatch[3] || "0");
      const max = parseInt(rangeMatch[2] || rangeMatch[4] || "0");
      return { min, max };
    }

    // Check for "under X" patterns
    if (PATTERNS.price.under20.test(query)) {
      return { max: 20 };
    }
    if (PATTERNS.price.under30.test(query)) {
      return { max: 30 };
    }
    if (PATTERNS.price.under50.test(query)) {
      return { max: 50 };
    }
    if (PATTERNS.price.under100.test(query)) {
      return { max: 100 };
    }

    // Check for budget/premium keywords
    if (PATTERNS.price.budget.test(query)) {
      return { max: 30 };
    }
    if (PATTERNS.price.premium.test(query)) {
      return { min: 80 };
    }

    return undefined;
  }

  /**
   * Clean query by removing extracted filter terms
   * This helps the embedding focus on semantic meaning
   */
  cleanQuery(query: string, filters: ExtractedFilters): string {
    let cleaned = query;

    // Normalize common Hebrew phrasing so semantically equivalent queries
    // collapse to similar embeddings (e.g., "לאוכל איטלקי" vs "לארוחה איטלקית").
    cleaned = cleaned
      .replace(/[\u0591-\u05C7]/g, "")
      .replace(/ש?מתאי(?:ם|מה|מות|מים)?/g, " ")
      .replace(/ל?ארוח(?:ה|ות)/g, " אוכל ")
      .replace(/ל?מאכל(?:ים)?/g, " אוכל ")
      .replace(/איטלקי(?:ת|ות)/g, " איטלקי ")
      .replace(/ל?פיצ(?:ה|ות)/g, " פיצה ")
      .replace(/ל?דג(?:ים)?/g, " דגים ")
      .replace(/ל?גבינ(?:ה|ות)/g, " גבינות ")
      .replace(/ל?בשר/g, " בשר ");

    // Remove price mentions
    cleaned = cleaned.replace(
      /\$?\d+[-–]\$?\d+|\$\d+|under \$?\d+|budget|cheap|premium|expensive|עד \d+|פחות מ \d+|זול|יקר/gi,
      ""
    );

    // Remove kosher (if extracted)
    if (filters.kosher) {
      cleaned = cleaned.replace(/\b(kosher|כשר|כשרה)\b/gi, "");
    }

    // Clean up multiple spaces
    cleaned = cleaned.replace(/\s+/g, " ").trim();

    return cleaned || query; // fallback to original if too much removed
  }
}
