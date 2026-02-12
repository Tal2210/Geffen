import { MongoClient, ObjectId, type Collection, type Db } from "mongodb";
import type { Env, VectorSearchHit } from "../types/index.js";

export interface BoostRule {
  _id: string;
  merchantId: string;
  productId: string;
  productName: string;
  triggerQuery: string;
  matchMode: "contains" | "exact";
  boostPercent: number;
  pinToTop: boolean;
  active: boolean;
  startAt?: string;
  endAt?: string;
  createdAt: string;
  updatedAt: string;
}

type StoredBoostRule = Omit<BoostRule, "_id"> & { _id: ObjectId };

export class BoostRuleService {
  private client: MongoClient;
  private db!: Db;
  private collection!: Collection<StoredBoostRule>;
  private collectionName = "product_boost_rules";

  constructor(private env: Env) {
    this.client = new MongoClient(env.MONGO_URI);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.env.MONGO_DB);
    this.collection = this.db.collection<StoredBoostRule>(this.collectionName);
    await this.collection.createIndex({ merchantId: 1, active: 1, updatedAt: -1 });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async list(merchantId: string): Promise<BoostRule[]> {
    const docs = await this.collection.find({ merchantId }).sort({ updatedAt: -1 }).toArray();
    return docs.map(this.toPublicRule);
  }

  async create(
    merchantId: string,
    payload: {
      productId: string;
      productName: string;
      triggerQuery: string;
      matchMode: "contains" | "exact";
      boostPercent: number;
      pinToTop: boolean;
      active: boolean;
      startAt?: string;
      endAt?: string;
    }
  ): Promise<BoostRule> {
    const now = new Date().toISOString();
    const doc: StoredBoostRule = {
      _id: new ObjectId(),
      merchantId,
      productId: payload.productId,
      productName: payload.productName,
      triggerQuery: payload.triggerQuery.trim(),
      matchMode: payload.matchMode,
      boostPercent: payload.boostPercent,
      pinToTop: payload.pinToTop,
      active: payload.active,
      startAt: payload.startAt,
      endAt: payload.endAt,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc);
    return this.toPublicRule(doc);
  }

  async update(
    merchantId: string,
    id: string,
    payload: Partial<{
      triggerQuery: string;
      matchMode: "contains" | "exact";
      boostPercent: number;
      pinToTop: boolean;
      active: boolean;
      startAt?: string;
      endAt?: string;
    }>
  ): Promise<BoostRule | null> {
    const objectId = this.safeObjectId(id);
    if (!objectId) return null;

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (payload.triggerQuery !== undefined) updates.triggerQuery = payload.triggerQuery.trim();
    if (payload.matchMode !== undefined) updates.matchMode = payload.matchMode;
    if (payload.boostPercent !== undefined) updates.boostPercent = payload.boostPercent;
    if (payload.pinToTop !== undefined) updates.pinToTop = payload.pinToTop;
    if (payload.active !== undefined) updates.active = payload.active;
    if (payload.startAt !== undefined) updates.startAt = payload.startAt;
    if (payload.endAt !== undefined) updates.endAt = payload.endAt;

    const result = await this.collection.findOneAndUpdate(
      { _id: objectId, merchantId },
      { $set: updates },
      { returnDocument: "after" }
    );

    return result ? this.toPublicRule(result) : null;
  }

  async delete(merchantId: string, id: string): Promise<boolean> {
    const objectId = this.safeObjectId(id);
    if (!objectId) return false;
    const result = await this.collection.deleteOne({ _id: objectId, merchantId });
    return result.deletedCount > 0;
  }

  async applyBoosts(
    merchantId: string,
    query: string,
    products: VectorSearchHit[]
  ): Promise<VectorSearchHit[]> {
    if (products.length === 0) return products;

    const relevantRules = await this.getRelevantStoredRules(merchantId, query);
    if (relevantRules.length === 0) return products;

    const byProductId = new Map<string, StoredBoostRule[]>();
    for (const rule of relevantRules) {
      const existing = byProductId.get(rule.productId) || [];
      existing.push(rule);
      byProductId.set(rule.productId, existing);
    }

    const boosted = products.map((product) => {
      const productId = String(product._id);
      const rulesForProduct = byProductId.get(productId) || [];
      if (rulesForProduct.length === 0) return product;

      const totalPercent = Math.min(
        1.5,
        rulesForProduct.reduce((sum, r) => sum + Math.max(0, r.boostPercent), 0)
      );
      const hasPin = rulesForProduct.some((r) => r.pinToTop);
      const score = Number(product.score || 0) * (1 + totalPercent / 100);

      return {
        ...product,
        score,
        promoted: true,
        promotedReason: rulesForProduct[0]?.triggerQuery,
        promotedPin: hasPin,
      } as VectorSearchHit;
    });

    const pinned = boosted.filter((p: any) => p.promotedPin);
    const rest = boosted.filter((p: any) => !p.promotedPin);

    pinned.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    return [...pinned, ...rest];
  }

  async getRelevantRules(merchantId: string, query: string): Promise<BoostRule[]> {
    const rules = await this.getRelevantStoredRules(merchantId, query);
    return rules.map(this.toPublicRule);
  }

  private async getRelevantStoredRules(
    merchantId: string,
    query: string
  ): Promise<StoredBoostRule[]> {
    const now = new Date();
    const rules = await this.collection
      .find({ merchantId, active: true })
      .sort({ updatedAt: -1 })
      .toArray();

    if (rules.length === 0) return [];

    const normalizedQuery = query.trim().toLowerCase();
    return rules.filter((rule) => {
      if (!this.isRuleInWindow(rule, now)) return false;
      const trigger = rule.triggerQuery.trim().toLowerCase();
      if (!trigger) return false;
      if (rule.matchMode === "exact") return normalizedQuery === trigger;
      return normalizedQuery.includes(trigger);
    });
  }

  private isRuleInWindow(rule: StoredBoostRule, now: Date): boolean {
    const start = rule.startAt ? new Date(rule.startAt) : null;
    const end = rule.endAt ? new Date(rule.endAt) : null;
    if (start && !Number.isNaN(start.getTime()) && now < start) return false;
    if (end && !Number.isNaN(end.getTime()) && now > end) return false;
    return true;
  }

  private safeObjectId(id: string): ObjectId | null {
    try {
      return new ObjectId(id);
    } catch {
      return null;
    }
  }

  private toPublicRule(doc: StoredBoostRule): BoostRule {
    return {
      ...doc,
      _id: doc._id.toHexString(),
    };
  }
}
