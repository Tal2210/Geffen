import { MongoClient, ObjectId, type Collection, type Db } from "mongodb";
import type { Env } from "../types/index.js";

type SearchEvent = {
  _id?: string;
  ts: string;
  question: string;
  userId?: string;
  resultProductIds?: string[];
  selectedProductIds?: string[];
};

type ClickEvent = {
  _id?: string;
  ts: string;
  productId: string;
  query?: string;
  userId?: string;
};

type OrderEvent = {
  _id?: string;
  ts: string;
  productId: string;
  quantity: number;
  amount?: number;
  userId?: string;
};

type WeeklyMetric = {
  weekStart: string;
  productId: string;
  searchCount: number;
  clickCount: number;
  orderCount: number;
  revenue: number;
  popularityScore: number;
  updatedAt: string;
};

export class AcademyMetricsService {
  private client: MongoClient;
  private db!: Db;
  private readonly dbName: string;
  private readonly productsCollectionName: string;
  private searchEvents!: Collection<SearchEvent>;
  private clickEvents!: Collection<ClickEvent>;
  private orderEvents!: Collection<OrderEvent>;
  private weeklyMetrics!: Collection<WeeklyMetric>;
  private products!: Collection<any>;

  constructor(private env: Env) {
    this.client = new MongoClient(env.MONGO_URI);
    this.dbName = process.env.ACADEMY_DB || "manovino";
    this.productsCollectionName = process.env.ACADEMY_COLLECTION || "academy.products";
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.products = this.db.collection(this.productsCollectionName);
    this.searchEvents = this.db.collection("academy.search_events");
    this.clickEvents = this.db.collection("academy.click_events");
    this.orderEvents = this.db.collection("academy.order_events");
    this.weeklyMetrics = this.db.collection("academy.product_metrics_weekly");

    await Promise.all([
      this.searchEvents.createIndex({ ts: -1 }),
      this.clickEvents.createIndex({ ts: -1, productId: 1 }),
      this.orderEvents.createIndex({ ts: -1, productId: 1 }),
      this.weeklyMetrics.createIndex({ weekStart: 1, productId: 1 }, { unique: true }),
      this.weeklyMetrics.createIndex({ weekStart: 1, popularityScore: -1 }),
    ]);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async trackSearch(event: Omit<SearchEvent, "ts"> & { ts?: string }) {
    const doc: SearchEvent = {
      ts: event.ts || new Date().toISOString(),
      question: event.question,
      userId: event.userId,
      resultProductIds: event.resultProductIds || [],
      selectedProductIds: event.selectedProductIds || [],
    };
    await this.searchEvents.insertOne(doc);
  }

  async trackClick(event: Omit<ClickEvent, "ts"> & { ts?: string }) {
    const doc: ClickEvent = {
      ts: event.ts || new Date().toISOString(),
      productId: event.productId,
      query: event.query,
      userId: event.userId,
    };
    await this.clickEvents.insertOne(doc);
  }

  async trackOrder(event: Omit<OrderEvent, "ts"> & { ts?: string }) {
    const doc: OrderEvent = {
      ts: event.ts || new Date().toISOString(),
      productId: event.productId,
      quantity: event.quantity,
      amount: event.amount,
      userId: event.userId,
    };
    await this.orderEvents.insertOne(doc);
  }

  async recomputeWeekly(weekStart?: string) {
    const start = this.normalizeWeekStart(weekStart);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    const [clickAgg, orderAgg, searchAgg] = await Promise.all([
      this.clickEvents
        .aggregate([
          { $match: { ts: { $gte: startIso, $lt: endIso } } },
          { $group: { _id: "$productId", clickCount: { $sum: 1 } } },
        ])
        .toArray(),
      this.orderEvents
        .aggregate([
          { $match: { ts: { $gte: startIso, $lt: endIso } } },
          {
            $group: {
              _id: "$productId",
              orderCount: { $sum: { $ifNull: ["$quantity", 1] } },
              revenue: { $sum: { $ifNull: ["$amount", 0] } },
            },
          },
        ])
        .toArray(),
      this.searchEvents
        .aggregate([
          { $match: { ts: { $gte: startIso, $lt: endIso } } },
          { $unwind: "$resultProductIds" },
          { $group: { _id: "$resultProductIds", searchCount: { $sum: 1 } } },
        ])
        .toArray(),
    ]);

    const byProduct = new Map<
      string,
      { searchCount: number; clickCount: number; orderCount: number; revenue: number }
    >();
    const ensure = (id: string) => {
      if (!byProduct.has(id)) {
        byProduct.set(id, { searchCount: 0, clickCount: 0, orderCount: 0, revenue: 0 });
      }
      return byProduct.get(id)!;
    };

    for (const row of searchAgg as any[]) ensure(String(row._id)).searchCount = Number(row.searchCount || 0);
    for (const row of clickAgg as any[]) ensure(String(row._id)).clickCount = Number(row.clickCount || 0);
    for (const row of orderAgg as any[]) {
      const p = ensure(String(row._id));
      p.orderCount = Number(row.orderCount || 0);
      p.revenue = Number(row.revenue || 0);
    }

    const now = new Date().toISOString();
    const bulk = Array.from(byProduct.entries()).map(([productId, m]) => {
      const ctr = m.searchCount > 0 ? m.clickCount / m.searchCount : 0;
      const popularityScore = m.clickCount * 1 + m.orderCount * 4 + ctr * 25 + Math.min(m.revenue / 50, 30);
      return {
        updateOne: {
          filter: { weekStart: startIso, productId },
          update: {
            $set: {
              weekStart: startIso,
              productId,
              searchCount: m.searchCount,
              clickCount: m.clickCount,
              orderCount: m.orderCount,
              revenue: m.revenue,
              popularityScore: Number(popularityScore.toFixed(4)),
              updatedAt: now,
            },
          },
          upsert: true,
        },
      };
    });

    if (bulk.length > 0) {
      await this.weeklyMetrics.bulkWrite(bulk);
    }

    return {
      weekStart: startIso,
      products: bulk.length,
    };
  }

  async getPopularWeek(limit = 5, weekStart?: string) {
    const start = this.normalizeWeekStart(weekStart);
    const startIso = start.toISOString();

    const metrics = await this.weeklyMetrics
      .find({ weekStart: startIso })
      .sort({ popularityScore: -1 })
      .limit(Math.max(1, Math.min(limit, 30)))
      .toArray();

    if (metrics.length === 0) return [];
    const ids = metrics.map((m) => m.productId);
    const objectIds = ids
      .filter((id) => ObjectId.isValid(id))
      .map((id) => new ObjectId(id));
    const idQuery = objectIds.length > 0 ? { $in: [...ids, ...objectIds] as any[] } : { $in: ids };
    const products = await this.products
      .find({ _id: idQuery as any })
      .project({ name: 1, description: 1, price: 1, imageUrl: 1, image: 1, softCategory: 1, category: 1 })
      .toArray();

    const byId = new Map(products.map((p: any) => [String(p._id), p]));
    return metrics
      .map((m) => {
        const p: any = byId.get(String(m.productId));
        if (!p) return null;
        return {
          _id: String(p._id),
          name: String(p.name || "מוצר ללא שם"),
          description: this.toPlainText(p.description),
          price: typeof p.price === "number" ? p.price : undefined,
          imageUrl: p.imageUrl || p.image,
          reason: `מדד שבועי: ${m.popularityScore.toFixed(2)} · clicks ${m.clickCount} · orders ${m.orderCount}`,
          metrics: m,
        };
      })
      .filter(Boolean);
  }

  private normalizeWeekStart(weekStart?: string): Date {
    if (weekStart) {
      const d = new Date(weekStart);
      if (!Number.isNaN(d.getTime())) return this.toUtcMonday(d);
    }
    return this.toUtcMonday(new Date());
  }

  private toUtcMonday(date: Date): Date {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay(); // 0..6
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private toPlainText(value?: string): string {
    if (!value) return "";
    return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  }
}
