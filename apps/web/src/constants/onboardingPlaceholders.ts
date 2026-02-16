const DEFAULT_PLACEHOLDERS = [
  "Best value item with fast shipping",
  "Top-rated product customers love",
  "Everyday essential with strong reviews",
];

const PLACEHOLDERS_BY_CATEGORY: Record<string, string[]> = {
  wine: [
    "Kosher Israeli red wine up to 120 ILS",
    "Crisp Chardonnay for a fish dinner",
    "Dry medium-bodied wine for pasta",
  ],
  fashion: [
    "Elegant black dress for an evening event",
    "Oversized white shirt for summer",
    "Minimal everyday work outfit",
  ],
  footwear: [
    "Comfortable white sneakers for everyday wear",
    "Lightweight running shoes with support",
    "Elegant shoes for evening events",
  ],
  furniture: [
    "Modular sofa for a small living room",
    "Natural wood dining table for six",
    "Ergonomic desk chair with back support",
  ],
  beauty: [
    "Hydrating serum for dry sensitive skin",
    "Long-lasting makeup with a natural finish",
    "Minimal morning skincare routine",
  ],
  electronics: [
    "Wireless headphones with noise cancellation",
    "27-inch monitor for work setup",
    "Phone with great camera and battery life",
  ],
  jewelry: [
    "Delicate gold necklace for daily wear",
    "Classic earrings for an event",
    "Minimal ring for a gift",
  ],
  home_decor: [
    "Modern rug for a bright living room",
    "Decorative bedside table lamp",
    "Minimal vase for a living room shelf",
  ],
  sports: [
    "Thick non-slip yoga mat",
    "Light gym bag with multiple compartments",
    "Home workout gear for beginners",
  ],
  pets: [
    "High-quality food for a sensitive small dog",
    "Interactive toy for an energetic cat",
    "Orthopedic bed for a medium dog",
  ],
  toys: [
    "Creative educational toy for age six",
    "Challenging building set for curious kids",
    "Family board game for game night",
  ],
  kids: [
    "Comfortable kids clothes for school",
    "Light shoes for an active child",
    "Roomy quality backpack for kindergarten",
  ],
  food: [
    "Gourmet bundle for home hosting",
    "Healthy snacks with no added sugar",
    "Vegan products for quick cooking",
  ],
  supplements: [
    "Magnesium supplement for evening routine",
    "Clean protein powder post-workout",
    "Daily vitamins for a busy schedule",
  ],
  books: [
    "A new thriller you cannot put down",
    "Practical personal growth book",
    "Children's book with a positive message",
  ],
  automotive: [
    "Night-ready high-quality dash cam",
    "Value car cleaning accessories",
    "Stable in-car phone mount",
  ],
  garden: [
    "Low-maintenance indoor plants",
    "Basic gardening tools for beginners",
    "Smart watering setup for a balcony",
  ],
  travel: [
    "Light suitcase for a weekend trip",
    "Comfortable backpack for short hikes",
    "Space-saving travel accessories",
  ],
  bags: [
    "Stylish backpack for a 15-inch laptop",
    "Elegant shoulder bag for evenings",
    "Light everyday work bag",
  ],
  lingerie: [
    "Soft comfortable daily set",
    "Supportive wire-free bra",
    "Elegant bodysuit for layering",
  ],
};

export function getCategoryPlaceholders(category?: string): string[] {
  if (!category) return DEFAULT_PLACEHOLDERS;
  const key = String(category || "").toLowerCase().trim();
  return PLACEHOLDERS_BY_CATEGORY[key] || DEFAULT_PLACEHOLDERS;
}

function categoryDisplayName(category?: string): string {
  if (!category) return "your store";
  const key = String(category || "").trim();
  return key.replace(/_/g, " ");
}

export function buildDemoCatchphrase(params: {
  domain: string;
  category?: string;
  productCount?: number;
}): string {
  const { domain, category, productCount } = params;
  const categoryText = categoryDisplayName(category);
  if (typeof productCount === "number" && productCount > 0) {
    return `Your demo for ${domain} is ready: we found ${productCount} products in ${categoryText} and enabled natural-language search.`;
  }
  return `Your demo for ${domain} is ready: natural-language search is active and ready to explore products in real time.`;
}
