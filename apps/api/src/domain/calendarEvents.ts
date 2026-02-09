/**
 * Calendar events relevant to wine & beverage commerce in Israel.
 *
 * Each event defines:
 *  - name: human-readable label
 *  - months: which months (1-12) this event typically falls in
 *  - keywords: Hebrew + English query fragments that correlate with this event
 *  - campaignHint: a short actionable suggestion
 */

export type CalendarEvent = {
  name: string;
  nameHe: string;
  months: number[];
  keywords: string[];
  campaignHint: string;
};

export const CALENDAR_EVENTS: CalendarEvent[] = [
  {
    name: "Valentine's Day",
    nameHe: "ולנטיין",
    months: [2],
    keywords: [
      "רוזה", "rosé", "rose", "רוזא", "שמפניה", "champagne",
      "מתנה", "gift", "רומנטי", "romantic", "זוגי", "couple",
      "פרוסקו", "prosecco", "בועות", "bubbles"
    ],
    campaignHint: "Create a Valentine's wine bundle — rosé + champagne gift sets"
  },
  {
    name: "Purim",
    nameHe: "פורים",
    months: [3],
    keywords: [
      "יין", "משלוח מנות", "משקה", "ויסקי", "וויסקי", "whisky", "whiskey",
      "וודקה", "vodka", "ליקר", "liqueur", "מסיבה", "party",
      "מתנה", "gift", "ארוז", "package"
    ],
    campaignHint: "Push gift packages, spirits, and party bundles for Purim"
  },
  {
    name: "Pesach",
    nameHe: "פסח",
    months: [3, 4],
    keywords: [
      "כשר לפסח", "kosher", "פסח", "pesach", "passover",
      "יין אדום", "red wine", "הגדה", "seder",
      "מצה", "ארבע כוסות", "four cups"
    ],
    campaignHint: "Highlight kosher-for-Pesach wines and Seder wine recommendations"
  },
  {
    name: "Summer BBQ Season",
    nameHe: "קיץ ומנגל",
    months: [6, 7, 8],
    keywords: [
      "רוזה", "rosé", "rose", "בירה", "beer", "קל", "light",
      "מנגל", "bbq", "grill", "קיץ", "summer",
      "לבן", "white", "קר", "cold", "מרענן", "refreshing",
      "סנגריה", "sangria", "ספריץ", "spritz", "אפרול", "aperol"
    ],
    campaignHint: "Feature chilled rosés, light whites, and BBQ-pairing reds"
  },
  {
    name: "Tu B'Av",
    nameHe: "טו באב",
    months: [7, 8],
    keywords: [
      "רוזה", "rosé", "rose", "רומנטי", "romantic",
      "שמפניה", "champagne", "בועות", "bubbles",
      "פרוסקו", "prosecco", "אהבה", "love"
    ],
    campaignHint: "Promote romantic wine experiences — rosé and sparkling for Tu B'Av"
  },
  {
    name: "Rosh Hashana",
    nameHe: "ראש השנה",
    months: [9, 10],
    keywords: [
      "יין מתוק", "sweet wine", "ראש השנה", "rosh hashana",
      "חג", "holiday", "פרימיום", "premium",
      "יקב", "winery", "מתנה", "gift",
      "יין אדום", "red wine", "קידוש", "kiddush"
    ],
    campaignHint: "Push premium wines, sweet wines, and holiday gift sets for Rosh Hashana"
  },
  {
    name: "Sukkot",
    nameHe: "סוכות",
    months: [10],
    keywords: [
      "חג", "holiday", "סוכות", "sukkot",
      "יין", "wine", "קידוש", "kiddush",
      "שמחת תורה", "simchat"
    ],
    campaignHint: "Continue holiday wine promotions through Sukkot"
  },
  {
    name: "Christmas & New Year",
    nameHe: "חג המולד וסילבסטר",
    months: [12, 1],
    keywords: [
      "שמפניה", "champagne", "בועות", "bubbles",
      "פרוסקו", "prosecco", "סילבסטר", "new year",
      "christmas", "חג המולד", "מתנה", "gift",
      "ויסקי", "וויסקי", "whisky", "whiskey",
      "קאווה", "cava"
    ],
    campaignHint: "Feature champagne, sparkling wines, and premium spirits for NYE celebrations"
  }
];

/**
 * Check if a normalized query matches any calendar event keyword.
 * Returns matched events (can be multiple).
 */
export function matchCalendarEvents(queryNorm: string): CalendarEvent[] {
  const lower = queryNorm.toLowerCase();
  return CALENDAR_EVENTS.filter((event) =>
    event.keywords.some((kw) => lower.includes(kw.toLowerCase()))
  );
}
