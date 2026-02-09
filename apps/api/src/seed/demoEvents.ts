export function buildDemoEvents() {
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  const store_id = "demo-store";

  const events: any[] = [];

  // Products + inventory
  events.push(
    {
      type: "product",
      product_id: "p-001",
      title: "Pinot Noir (Coastal)",
      winery: "Seabreeze",
      varietal: "Pinot Noir",
      price: 28,
      tags: ["pinot noir", "red"]
    },
    {
      type: "inventory",
      product_id: "p-001",
      stock_qty: 24
    },
    {
      type: "product",
      product_id: "p-002",
      title: "Cabernet Sauvignon (Reserve)",
      winery: "Canyon Ridge",
      varietal: "Cabernet Sauvignon",
      price: 42,
      tags: ["cabernet", "red"]
    },
    {
      type: "inventory",
      product_id: "p-002",
      stock_qty: 8
    }
  );

  // Last week: fewer pinot searches, some cabernet, and some no-results query.
  for (let i = 1; i <= 25; i++) {
    events.push({
      type: "search_event",
      timestamp: new Date(now.getTime() - (10 * dayMs + i * 1000)).toISOString(),
      query: "pinot noir",
      results_count: 12
    });
  }
  for (let i = 1; i <= 30; i++) {
    events.push({
      type: "search_event",
      timestamp: new Date(now.getTime() - (10 * dayMs + i * 1200)).toISOString(),
      query: "orange wine",
      results_count: 0
    });
  }

  // This week: spike pinot searches + clicks; keep orange wine no-results.
  for (let i = 1; i <= 80; i++) {
    events.push({
      type: "search_event",
      timestamp: new Date(now.getTime() - (2 * dayMs + i * 800)).toISOString(),
      query: "pinot noir",
      results_count: 14
    });
    if (i % 2 === 0) {
      events.push({
        type: "click_event",
        timestamp: new Date(now.getTime() - (2 * dayMs + i * 800 + 200)).toISOString(),
        query: "pinot noir",
        product_id: "p-001"
      });
    }
  }

  for (let i = 1; i <= 45; i++) {
    events.push({
      type: "search_event",
      timestamp: new Date(now.getTime() - (3 * dayMs + i * 900)).toISOString(),
      query: "orange wine",
      results_count: 0
    });
  }

  // Purchases this week (store-level only in MVP)
  events.push(
    {
      type: "purchase_event",
      timestamp: new Date(now.getTime() - 2 * dayMs).toISOString(),
      order_id: "o-1001",
      revenue: 86.0
    },
    {
      type: "purchase_event",
      timestamp: new Date(now.getTime() - 1 * dayMs).toISOString(),
      order_id: "o-1002",
      revenue: 42.0
    }
  );

  return { store_id, events };
}

