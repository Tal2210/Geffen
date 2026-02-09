import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../db/prisma.js";
import { getClient as getMongo } from "../db/mongo.js";
import { normalizeQuery } from "../domain/queryNorm.js";

const TimestampSchema = z.union([
  z.string().datetime(),
  z.string().min(1), // fallback: Date.parse compatible
  z.number().int().positive(),
  z.date()
]);

function toDate(value: z.infer<typeof TimestampSchema>): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  return new Date(value);
}

const SearchEventSchema = z.object({
  type: z.literal("search_event"),
  timestamp: TimestampSchema,
  query: z.string().min(1).max(500),
  results_count: z.number().int().min(0)
});

const ClickEventSchema = z.object({
  type: z.literal("click_event"),
  timestamp: TimestampSchema,
  product_id: z.string().min(1).optional(),
  query: z.string().min(1).max(500).optional()
});

const PurchaseEventSchema = z.object({
  type: z.literal("purchase_event"),
  timestamp: TimestampSchema,
  order_id: z.string().min(1),
  revenue: z.number().nonnegative()
});

const ProductSchema = z.object({
  type: z.literal("product"),
  product_id: z.string().min(1),
  title: z.string().min(1),
  winery: z.string().min(1).optional(),
  varietal: z.string().min(1).optional(),
  price: z.number().nonnegative().optional(),
  tags: z.array(z.string().min(1)).optional()
});

const InventorySchema = z.object({
  type: z.literal("inventory"),
  product_id: z.string().min(1),
  stock_qty: z.number().int()
});

const EventSchema = z.discriminatedUnion("type", [
  SearchEventSchema,
  ClickEventSchema,
  PurchaseEventSchema,
  ProductSchema,
  InventorySchema
]);

const BodySchema = z.object({
  // `tenant_id` is the opaque identifier used for tenant-specific insights.
  // For backward compatibility, we also accept `store_id` as an alias.
  tenant_id: z.string().min(1).optional(),
  store_id: z.string().min(1).optional(),
  events: z.array(EventSchema).min(1).max(10_000)
});

export const eventsRoutes: FastifyPluginAsync = async (server) => {
  server.post("/events", async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues
      });
    }

    const tenantId = parsed.data.tenant_id ?? parsed.data.store_id ?? crypto.randomUUID();
    const { events } = parsed.data;

    const mongo = getMongo();
    await mongo.connectAndEnsureIndexes();

    // Ensure store exists (client-supplied store IDs are allowed).
    await prisma.store.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: tenantId }
    });

    const searches: Array<{
      tenantId: string;
      ts: Date;
      query: string;
      queryNorm: string;
      resultsCount: number;
    }> = [];

    const clicks: Array<{
      tenantId: string;
      ts: Date;
      query?: string | null;
      queryNorm?: string | null;
      productId?: string | null;
    }> = [];

    const purchases: Array<{
      tenantId: string;
      ts: Date;
      orderId: string;
      revenueCents: number;
    }> = [];

    const products: Array<z.infer<typeof ProductSchema>> = [];
    const inventory: Array<z.infer<typeof InventorySchema>> = [];

    for (const ev of events) {
      switch (ev.type) {
        case "search_event": {
          const qn = normalizeQuery(ev.query);
          if (!qn) break;
          searches.push({
            tenantId,
            ts: toDate(ev.timestamp),
            query: ev.query,
            queryNorm: qn,
            resultsCount: ev.results_count
          });
          break;
        }
        case "click_event": {
          const qn = ev.query ? normalizeQuery(ev.query) : null;
          clicks.push({
            tenantId,
            ts: toDate(ev.timestamp),
            query: ev.query ?? null,
            queryNorm: qn && qn.length ? qn : null,
            productId: ev.product_id ?? null
          });
          break;
        }
        case "purchase_event": {
          purchases.push({
            tenantId,
            ts: toDate(ev.timestamp),
            orderId: ev.order_id,
            revenueCents: Math.round(ev.revenue * 100)
          });
          break;
        }
        case "product": {
          products.push(ev);
          break;
        }
        case "inventory": {
          inventory.push(ev);
          break;
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      // Upsert products first (so inventory FK is satisfied).
      for (const p of products) {
        await tx.product.upsert({
          where: { storeId_productId: { storeId: tenantId, productId: p.product_id } },
          create: {
            storeId: tenantId,
            productId: p.product_id,
            title: p.title,
            winery: p.winery,
            varietal: p.varietal,
            priceCents: p.price == null ? null : Math.round(p.price * 100),
            tagsJson: p.tags ?? undefined
          },
          update: {
            title: p.title,
            winery: p.winery,
            varietal: p.varietal,
            priceCents: p.price == null ? null : Math.round(p.price * 100),
            tagsJson: p.tags ?? undefined
          }
        });
      }

      // Ensure products exist for inventory updates (create placeholder if missing).
      for (const inv of inventory) {
        await tx.product.upsert({
          where: { storeId_productId: { storeId: tenantId, productId: inv.product_id } },
          create: {
            storeId: tenantId,
            productId: inv.product_id,
            title: inv.product_id
          },
          update: {}
        });

        await tx.inventory.upsert({
          where: { storeId_productId: { storeId: tenantId, productId: inv.product_id } },
          create: {
            storeId: tenantId,
            productId: inv.product_id,
            stockQty: inv.stock_qty
          },
          update: {
            stockQty: inv.stock_qty
          }
        });
      }

      // Raw behavioral events are stored in Mongo (source of truth).
    });

    // Write raw events to Mongo:
    // - private pool: includes tenantId
    // - global pool: sanitized (no tenantId)
    const privateDocs: any[] = [];
    const globalDocs: any[] = [];

    for (const s of searches) {
      const doc = {
        type: "search_event",
        tenantId: s.tenantId,
        ts: s.ts,
        query: s.query,
        queryNorm: s.queryNorm,
        resultsCount: s.resultsCount
      };
      privateDocs.push(doc);
      globalDocs.push({ ...doc, tenantId: undefined });
    }

    for (const c of clicks) {
      const doc = {
        type: "click_event",
        tenantId: c.tenantId,
        ts: c.ts,
        query: c.query ?? null,
        queryNorm: c.queryNorm ?? null,
        productId: c.productId ?? null
      };
      privateDocs.push(doc);
      globalDocs.push({ ...doc, tenantId: undefined });
    }

    // Purchases are written with idempotency in the private pool.
    if (purchases.length) {
      await mongo.collections.privateEvents.bulkWrite(
        purchases.map((p) => ({
          updateOne: {
            filter: { tenantId: p.tenantId, type: "purchase_event", orderId: p.orderId },
            update: {
              $setOnInsert: {
                type: "purchase_event",
                tenantId: p.tenantId,
                ts: p.ts,
                orderId: p.orderId,
                revenueCents: p.revenueCents
              }
            },
            upsert: true
          }
        })),
        { ordered: false }
      );

      // Global pool: append-only (no idempotency, because orderId may collide across tenants).
      await mongo.collections.globalEvents.insertMany(
        purchases.map((p) => ({
          type: "purchase_event",
          ts: p.ts,
          orderId: p.orderId,
          revenueCents: p.revenueCents
        })),
        { ordered: false }
      );
    }

    if (privateDocs.length) {
      await mongo.collections.privateEvents.insertMany(privateDocs, { ordered: false });
    }
    if (globalDocs.length) {
      // Remove tenantId key entirely for sanitized pool.
      await mongo.collections.globalEvents.insertMany(
        globalDocs.map((d) => {
          const { tenantId: _t, ...rest } = d;
          return rest;
        }),
        { ordered: false }
      );
    }

    return reply.send({
      ok: true,
      tenant_id: tenantId,
      ingested: {
        search_events: searches.length,
        click_events: clicks.length,
        purchase_events: purchases.length,
        products: products.length,
        inventory: inventory.length
      }
    });
  });
};

