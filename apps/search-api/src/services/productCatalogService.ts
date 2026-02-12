import { MongoClient, type Collection, type Db } from "mongodb";
import type { Env } from "../types/index.js";

type CatalogProduct = {
  _id: string;
  name: string;
  description?: string;
  price: number;
  imageUrl?: string;
  image_url?: string;
  image?: { url?: string; src?: string } | string;
  images?: Array<{ url?: string; src?: string }>;
  featuredImage?: { url?: string; src?: string };
  featured_image?: { url?: string; src?: string };
  thumbnail?: string;
};

export class ProductCatalogService {
  private client: MongoClient;
  private db!: Db;
  private collection!: Collection<CatalogProduct>;

  constructor(private env: Env) {
    this.client = new MongoClient(env.MONGO_URI);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.env.MONGO_DB);
    this.collection = this.db.collection<CatalogProduct>(this.env.MONGO_COLLECTION);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async searchByName(query: string, limit = 20): Promise<Array<CatalogProduct & { _id: string }>> {
    const q = query.trim();
    if (!q) return [];

    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const terms = q.split(/\s+/).filter(Boolean);
    
    // Build a regex that matches ANY term (OR logic)
    // This is better for natural language queries like "red wine for pasta"
    const regex = terms.map(t => `(?=.*${escape(t)})`).join('');
    const orConditions = terms.map(t => ({
      $or: [
        { name: { $regex: escape(t), $options: "i" } },
        { description: { $regex: escape(t), $options: "i" } },
        { category: { $regex: escape(t), $options: "i" } }
      ]
    }));

    // Use OR so that matching any field works, and AND across terms for ranking quality
    const match = orConditions.length > 0
      ? { $and: orConditions }
      : {};

    const docs = await this.collection
      .find(match)
      .project({
        name: 1,
        description: 1,
        price: 1,
        imageUrl: 1,
        image_url: 1,
        image: 1,
        images: 1,
        featuredImage: 1,
        featured_image: 1,
        thumbnail: 1,
      })
      .limit(Math.min(Math.max(limit, 1), 50))
      .toArray();

    return docs.map((doc: any) => {
      const normalized = this.normalizeImageFields(doc);
      return {
        ...normalized,
        _id: String(doc._id),
      };
    });
  }

  private normalizeImageFields(doc: any): any {
    const imageField =
      typeof doc?.image === "string" ? doc.image : doc?.image?.url || doc?.image?.src;
    const firstImage =
      imageField ||
      doc?.featuredImage?.url ||
      doc?.featuredImage?.src ||
      doc?.featured_image?.url ||
      doc?.featured_image?.src ||
      doc?.thumbnail ||
      (Array.isArray(doc?.images)
        ? typeof doc.images[0] === "string"
          ? doc.images[0]
          : doc.images[0]?.url || doc.images[0]?.src
        : undefined);

    return {
      ...doc,
      imageUrl: doc?.imageUrl || doc?.image_url || firstImage,
    };
  }
}
