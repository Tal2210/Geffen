import { MongoClient, type Collection, type Db } from "mongodb";
import type { Env } from "../types/index.js";
import { EmbeddingService } from "./embeddingService.js";
import type { AcademyMetricsService } from "./academyMetricsService.js";

type AcademyProduct = {
  _id: string;
  name?: string;
  description?: string;
  price?: number;
  imageUrl?: string;
  image?: string;
  category?: string[];
  softCategory?: string[];
  onSale?: boolean;
  specialSales?: Array<{ name?: string }>;
  lastSeenAt?: string;
  updatedAt?: string;
  embedding?: number[];
  score?: number;
};

type AcademyAnswer = {
  answer: string;
  products: Array<{
    _id: string;
    name: string;
    description?: string;
    price?: number;
    imageUrl?: string;
    reason: string;
  }>;
  mode: "popular_week" | "recommendation";
  teachingPlan: Array<{
    title: string;
    text: string;
  }>;
};

export class AcademyChatService {
  private client: MongoClient;
  private db!: Db;
  private collection!: Collection<AcademyProduct>;
  private embeddingService: EmbeddingService;
  private readonly dbName: string;
  private readonly collectionName: string;
  private readonly vectorIndex: string;

  constructor(
    private env: Env,
    private academyMetricsService?: AcademyMetricsService
  ) {
    this.client = new MongoClient(env.MONGO_URI);
    this.embeddingService = new EmbeddingService(env);
    this.dbName = process.env.ACADEMY_DB || "manovino";
    this.collectionName = process.env.ACADEMY_COLLECTION || "academy.products";
    this.vectorIndex = process.env.ACADEMY_VECTOR_INDEX || "wine_vector_index";
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection(this.collectionName);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async ask(question: string): Promise<AcademyAnswer> {
    const q = question.trim();
    const isPopularWeek = /פופולרי|popular|most popular|הכי/.test(q.toLowerCase()) && /שבוע|week/.test(q.toLowerCase());

    if (isPopularWeek) {
      return this.answerPopularWeek();
    }

    return this.answerRecommendation(q);
  }

  private async answerPopularWeek(): Promise<AcademyAnswer> {
    if (this.academyMetricsService) {
      const metricProducts = await this.academyMetricsService.getPopularWeek(5);
      const safeProducts = metricProducts.filter((p: any) => Boolean(p)) as any[];
      const teachingInput = safeProducts as Array<{ name?: string; reason?: string }>;
      if (safeProducts.length > 0) {
        return {
          mode: "popular_week",
          answer:
            "המוצרים הבאים מובילים השבוע לפי אירועי חיפוש, קליקים ורכישות. כל כרטיס כולל סיבה שיווקית שאפשר להשתמש בה בשיחה עם לקוח.",
          products: safeProducts.map((p: any) => ({
            _id: p._id,
            name: p.name,
            description: p.description,
            price: p.price,
            imageUrl: p.imageUrl,
            reason: p.reason,
          })),
          teachingPlan: this.buildTeachingPlan("popular", "popular_week", teachingInput),
        };
      }
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const docs = await this.collection
      .find({})
      .project({
        name: 1,
        description: 1,
        price: 1,
        imageUrl: 1,
        image: 1,
        onSale: 1,
        specialSales: 1,
        lastSeenAt: 1,
        updatedAt: 1,
      })
      .limit(300)
      .toArray();

    const scored = docs
      .map((d: any) => {
        const seenRecent = d.lastSeenAt && d.lastSeenAt >= sevenDaysAgo ? 1 : 0;
        const updatedRecent = d.updatedAt && d.updatedAt >= sevenDaysAgo ? 1 : 0;
        const onSale = d.onSale ? 1 : 0;
        const specials = Array.isArray(d.specialSales) ? Math.min(d.specialSales.length, 3) : 0;
        const score = seenRecent * 3 + updatedRecent * 2 + onSale * 2 + specials;
        return { doc: d, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const products = scored.map(({ doc }) => ({
      _id: String(doc._id),
      name: String(doc.name || "מוצר ללא שם"),
      description: this.toPlainText(doc.description),
      price: typeof doc.price === "number" ? doc.price : undefined,
      imageUrl: doc.imageUrl || doc.image,
      reason: "מדורג גבוה השבוע לפי עדכניות פריט, זמינות ומבצעים פעילים.",
    }));

    return {
      mode: "popular_week",
      answer:
        "עדיין אין מספיק אירועי שימוש אמיתיים, אז דירגתי פופולריות שבועית לפי אינדיקציות זמינות: עדכניות, נראות ומבצעים.",
      products,
      teachingPlan: this.buildTeachingPlan("popular", "popular_week", products),
    };
  }

  private async answerRecommendation(question: string): Promise<AcademyAnswer> {
    const filters = this.extractFilters(question);
    const products = await this.semanticOrTextSearch(question, filters, 5);

    const enriched = products.map((doc: any) => ({
      _id: String(doc._id),
      name: String(doc.name || "מוצר ללא שם"),
      description: this.toPlainText(doc.description),
      price: typeof doc.price === "number" ? doc.price : undefined,
      imageUrl: doc.imageUrl || doc.image,
      reason: this.buildReason(doc, filters),
    }));

    return {
      mode: "recommendation",
      answer:
        enriched.length > 0
          ? "אלה היינות המתאימים ביותר לשאלה שלך. השתמש בסיבות שעל כל כרטיס כדי להסביר לעובד חדש איך להתאים יין לצורך של הלקוח."
          : "לא נמצאו התאמות מספיק טובות לשאלה הזו כרגע.",
      products: enriched,
      teachingPlan: this.buildTeachingPlan(question, "recommendation", enriched),
    };
  }

  private async semanticOrTextSearch(
    question: string,
    filters: { category?: string; tags: string[] },
    limit: number
  ): Promise<AcademyProduct[]> {
    const preFilter = this.buildVectorPreFilter(filters);
    const hasFilter = Object.keys(preFilter).length > 0;

    try {
      const embedding = await this.embeddingService.generateEmbedding(question);
      const withFilter = await this.runVectorSearch(embedding, hasFilter ? preFilter : undefined, hasFilter ? 12 : 20);
      if (withFilter.length > 0 || !hasFilter) {
        return withFilter.slice(0, limit) as AcademyProduct[];
      }

      // If strict parsed filter produced no matches, keep semantic quality but relax metadata filter.
      const relaxed = await this.runVectorSearch(embedding, undefined, 20);
      if (relaxed.length > 0) {
        return relaxed.slice(0, limit) as AcademyProduct[];
      }

      // Last LLM-based fallback: rank by cosine similarity from a structured candidate pool.
      return await this.localEmbeddingFallback(embedding, preFilter, limit);
    } catch (error) {
      throw new Error(
        `academy_llm_required: embedding/vector search failed (${error instanceof Error ? error.message : "unknown"})`
      );
    }
  }

  private async runVectorSearch(
    embedding: number[],
    preFilter?: Record<string, unknown>,
    vectorLimit = 20
  ): Promise<AcademyProduct[]> {
    const pipeline: any[] = [
      {
        $vectorSearch: {
          index: this.vectorIndex,
          path: "embedding",
          queryVector: embedding,
          numCandidates: preFilter ? 60 : 90,
          limit: vectorLimit,
          ...(preFilter ? { filter: preFilter } : {}),
        },
      },
      { $addFields: { score: { $meta: "vectorSearchScore" } } },
      {
        $project: {
          name: 1,
          description: 1,
          price: 1,
          imageUrl: 1,
          image: 1,
          category: 1,
          softCategory: 1,
          score: 1,
        },
      },
    ];
    return (await this.collection.aggregate(pipeline).toArray()) as AcademyProduct[];
  }

  private async localEmbeddingFallback(
    queryEmbedding: number[],
    preFilter: Record<string, unknown>,
    limit: number
  ): Promise<AcademyProduct[]> {
    const candidates = (await this.collection
      .find({
        ...(Object.keys(preFilter).length > 0 ? preFilter : {}),
        embedding: { $exists: true, $type: "array", $ne: [] },
      })
      .project({
        name: 1,
        description: 1,
        price: 1,
        imageUrl: 1,
        image: 1,
        category: 1,
        softCategory: 1,
        color: 1,
        embedding: 1,
      })
      .limit(500)
      .toArray()) as AcademyProduct[];

    const scored = candidates
      .map((doc) => {
        const emb = Array.isArray(doc.embedding) ? doc.embedding : [];
        const score = this.cosineSimilarity(queryEmbedding, emb);
        return { ...doc, score };
      })
      .filter((d) => Number.isFinite(d.score) && (d.score || 0) > 0)
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    if (scored.length > 0) {
      return scored.slice(0, limit);
    }

    // If strict structured filters yielded nothing at all, retry on global embedding pool.
    const broad = (await this.collection
      .find({ embedding: { $exists: true, $type: "array", $ne: [] } })
      .project({
        name: 1,
        description: 1,
        price: 1,
        imageUrl: 1,
        image: 1,
        category: 1,
        softCategory: 1,
        color: 1,
        embedding: 1,
      })
      .limit(500)
      .toArray()) as AcademyProduct[];

    return broad
      .map((doc) => {
        const emb = Array.isArray(doc.embedding) ? doc.embedding : [];
        const score = this.cosineSimilarity(queryEmbedding, emb);
        return { ...doc, score };
      })
      .filter((d) => Number.isFinite(d.score) && (d.score || 0) > 0)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, limit);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0 || a.length !== b.length) {
      return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      dot += x * y;
      normA += x * x;
      normB += y * y;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  private extractFilters(question: string): { category?: string; tags: string[] } {
    const q = question.toLowerCase();
    const tags: string[] = [];
    let category: string | undefined;

    if (/לבן|white/.test(q)) category = "יין לבן";
    if (/אדום|red/.test(q)) category = "יין אדום";
    if (/מבעבע|sparkling/.test(q)) category = "יין מבעבע";
    if (/ישראל|israel/.test(q)) tags.push("ישראל");
    if (/בשר|meat|סטייק/.test(q)) tags.push("בשר");
    if (/דג|fish/.test(q)) tags.push("דגים");
    if (/גבינ|cheese/.test(q)) tags.push("גבינות");
    if (/יבש|dry/.test(q)) tags.push("יבש");

    return { category, tags };
  }

  private buildVectorPreFilter(filters: { category?: string; tags: string[] }): Record<string, unknown> {
    const andFilters: Array<Record<string, unknown>> = [];

    if (filters.category) {
      const categoryTokens = this.categoryTokens(filters.category);
      andFilters.push({
        $or: [
          { category: filters.category },
          { category: { $in: categoryTokens } },
          { softCategory: { $in: categoryTokens } },
          { color: { $in: categoryTokens } },
        ],
      });
    }

    // Only keep strict metadata filters that are likely structured in the DB.
    if (filters.tags.includes("ישראל")) {
      andFilters.push({
        $or: [{ country: "ישראל" }, { country: "israel" }, { softCategory: { $in: ["ישראל", "israel"] } }],
      });
    }

    if (filters.tags.includes("יבש")) {
      andFilters.push({
        $or: [{ sweetness: "dry" }, { sweetness: "יבש" }, { softCategory: { $in: ["יבש", "dry"] } }],
      });
    }

    if (andFilters.length === 0) return {};
    if (andFilters.length === 1) return andFilters[0]!;
    return { $and: andFilters };
  }

  private categoryTokens(category: string): string[] {
    switch (category) {
      case "יין אדום":
        return ["יין אדום", "אדום", "red"];
      case "יין לבן":
        return ["יין לבן", "לבן", "white"];
      case "יין מבעבע":
        return ["יין מבעבע", "מבעבע", "sparkling"];
      default:
        return [category];
    }
  }

  private buildReason(doc: any, filters: { category?: string; tags: string[] }): string {
    const reasons: string[] = [];
    const categories = Array.isArray(doc.category) ? doc.category : [];
    const soft = Array.isArray(doc.softCategory) ? doc.softCategory : [];
    const colorValue = typeof doc.color === "string" ? doc.color.toLowerCase() : "";
    if (filters.category && (categories.includes(filters.category) || this.categoryTokens(filters.category).some((t) => colorValue.includes(t.toLowerCase())))) {
      reasons.push(`סוג יין: ${filters.category}`);
    }
    for (const t of filters.tags) {
      if (soft.includes(t)) reasons.push(`מתאים ל-${t}`);
    }
    const desc = this.toPlainText(doc.description || "");
    if (reasons.length === 0) {
      if (desc) {
        return `התאמה סמנטית גבוהה לתיאור: "${desc.slice(0, 90)}..."`;
      }
      return "התאמה סמנטית גבוהה לשאלה ולתיאור המוצר.";
    }
    const guidance = this.trainingTip(filters);
    return `${reasons.join(", ")}. ${guidance}`;
  }

  private trainingTip(filters: { category?: string; tags: string[] }): string {
    if (filters.tags.includes("בשר")) {
      return "טיפ מכירה: הדגש גוף, טאנינים ואיזון מול שומן הבשר.";
    }
    if (filters.tags.includes("דגים")) {
      return "טיפ מכירה: ציין חומציות ורעננות שמאזנות מנות דג.";
    }
    if (filters.tags.includes("גבינות")) {
      return "טיפ מכירה: בנה התאמה לפי עוצמת הגבינה מול עוצמת היין.";
    }
    if (filters.tags.includes("יבש")) {
      return "טיפ מכירה: ודא מול הלקוח העדפה ליבש מלא מול חצי-יבש.";
    }
    return "טיפ מכירה: שאל שאלת המשך על מנה/תקציב כדי לדייק את ההמלצה.";
  }

  private buildTeachingPlan(
    question: string,
    mode: "popular_week" | "recommendation",
    products: Array<{ name?: string; reason?: string }>
  ): Array<{ title: string; text: string }> {
    const first = products[0]?.name || "המוצר המוביל";
    if (mode === "popular_week") {
      return [
        {
          title: "למה זה חשוב",
          text: "אלו מוצרים עם ביקוש מוכח השבוע, ולכן הם בסיס טוב להצעה ראשונה ללקוח.",
        },
        {
          title: "איך להציג ללקוח",
          text: `התחל עם ${first} והסבר בקצרה שזה יין מבוקש ומאוזן שמתאים לרוב הלקוחות.`,
        },
        {
          title: "שאלת המשך מומלצת",
          text: "האם חשוב לך יין קליל ורענן, או גוף מלא ועוצמתי יותר?",
        },
      ];
    }

    const focus =
      /בשר|סטייק/.test(question) ? "בשר" : /דג|fish/.test(question) ? "דגים" : /יבש|dry/.test(question) ? "יינות יבשים" : "העדפה אישית";
    return [
      {
        title: "למה זה מתאים",
        text: `הבחירה נשענת על התאמה סמנטית לשאלה ועל מאפייני המוצר, עם דגש על ${focus}.`,
      },
      {
        title: "איך להציג ללקוח",
        text: `בחר 2 אפשרויות מתוך הרשימה (למשל ${first}) והצג הבדל ברור ביניהן: טעם, גוף ומחיר.`,
      },
      {
        title: "שאלת המשך מומלצת",
        text: "מה התקציב שלך לבקבוק, ולאיזו ארוחה היין מיועד?",
      },
    ];
  }

  private toPlainText(value?: string): string {
    if (!value) return "";
    return value
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
  }

}
