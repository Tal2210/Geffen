# 🍷 Geffen Brain - Wine Search API

Production-ready semantic search API for wine e-commerce. Multi-tenant SaaS architecture with vector search powered by MongoDB Atlas.

## 🎯 Features

- ✅ **Semantic Search** - Natural language queries with vector embeddings
- ✅ **Multi-Tenant** - Isolated search per merchant (store)
- ✅ **Smart Filtering** - Automatic extraction of price, color, country, grapes, etc.
- ✅ **Fast Performance** - MongoDB Atlas Vector Search with pre-filtering
- ✅ **Intelligent Reranking** - Combines similarity with business signals (popularity, ratings, stock)
- ✅ **Rate Limiting** - Per-merchant request limits
- ✅ **API Key Authentication** - Secure access control

## 🏗️ Architecture

```
Search Request
      ↓
  API Key Auth
      ↓
  Query Parser (NER) → Extract filters
      ↓
  Embedding Service → Generate vector
      ↓
  Vector Search → MongoDB Atlas (with pre-filters)
      ↓
  Reranker → Business logic
      ↓
  JSON Response
```

## 📦 Installation

```bash
# Install dependencies
cd apps/search-api
corepack pnpm install
```

## ⚙️ Configuration

Create `.env` file (copy from root `.env`):

```bash
# MongoDB
MONGO_URI="mongodb+srv://..."
MONGO_DB="Geffen"
MONGO_COLLECTION="bana.stores"

# Server
PORT=3000
NODE_ENV=development

# LLM / Embeddings
LLM_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai"
LLM_API_KEY="your-gemini-api-key"
EMBEDDING_MODEL="text-embedding-004"

# CORS
CORS_ORIGIN="http://localhost:5173"
```

## 🚀 Development

```bash
# Start development server
corepack pnpm dev

# Build for production
corepack pnpm build

# Run production build
corepack pnpm start
```

## 📡 API Endpoints

### `POST /search`

Semantic search for wine products.

**Headers:**
```
X-API-Key: your_api_key_here
Content-Type: application/json
```

**Request Body:**
```json
{
  "query": "fruity red wine from france under $30",
  "merchantId": "store_a",
  "limit": 24,
  "offset": 0,
  "minPrice": 10,
  "maxPrice": 30,
  "colors": ["red"],
  "countries": ["france"],
  "kosher": false
}
```

**Response:**
```json
{
  "products": [
    {
      "_id": "product_123",
      "name": "Château Margaux 2018",
      "price": 28.99,
      "color": "red",
      "country": "france",
      "grapes": ["cabernet sauvignon", "merlot"],
      "score": 0.92,
      "finalScore": 0.89
    }
  ],
  "metadata": {
    "query": "fruity red wine from france under $30",
    "appliedFilters": {
      "colors": ["red"],
      "countries": ["france"],
      "priceRange": { "max": 30 }
    },
    "totalResults": 47,
    "returnedCount": 24,
    "timings": {
      "parsing": 3,
      "embedding": 87,
      "vectorSearch": 42,
      "reranking": 8,
      "total": 145
    }
  }
}
```

### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "ok": true,
  "service": "wine-search-api",
  "timestamp": "2026-02-08T..."
}
```

## 🔑 Authentication

Each merchant gets a unique API key. Send it in the `X-API-Key` header.

**Development API Keys:**
```
test_key_store_a  → merchantId: store_a
test_key_store_b  → merchantId: store_b
dev_key_123       → merchantId: demo_merchant
```

## 🗄️ MongoDB Atlas Setup

### 1. Create Vector Search Index

In MongoDB Atlas:
1. Go to **Atlas Search** → **Create Index**
2. Choose **JSON Editor**
3. Index name: `wine_vector_index`
4. Use this configuration:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 768,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "merchantId"
    },
    {
      "type": "filter",
      "path": "color"
    },
    {
      "type": "filter",
      "path": "country"
    },
    {
      "type": "filter",
      "path": "grapes"
    },
    {
      "type": "filter",
      "path": "price"
    },
    {
      "type": "filter",
      "path": "kosher"
    },
    {
      "type": "filter",
      "path": "inStock"
    }
  ]
}
```

### 2. Generate Embeddings for Products

Run this script to generate embeddings for existing products:

```bash
# TODO: Create indexing script
corepack pnpm run index-products
```

## 🚀 Deployment to Render

### Option 1: Using render.yaml (Recommended)

The project includes `render.yaml` at the root:

```bash
# Just push to GitHub and Render will auto-deploy
git push origin main
```

### Option 2: Manual Setup

1. Go to https://render.com/dashboard
2. Click **New +** → **Web Service**
3. Connect your GitHub repo
4. Configure:
   - **Name:** `geffen-brain-search-api`
   - **Region:** Frankfurt (EU)
   - **Root Directory:** `apps/search-api`
   - **Build Command:** `corepack pnpm install && corepack pnpm build`
   - **Start Command:** `corepack pnpm start`
   - **Instance Type:** Starter ($7/month)
5. Add Environment Variables (see Configuration above)
6. Click **Create Web Service**

## 📊 Performance

Expected latencies (p95):
- **Query Parsing:** < 5ms
- **Embedding Generation:** 50-150ms (API dependent)
- **Vector Search:** 20-50ms (with pre-filters)
- **Reranking:** < 10ms
- **Total:** **100-250ms**

## 🔧 Troubleshooting

### Vector Search Not Working

If you get errors about vector search:
1. Check that vector index `wine_vector_index` exists in MongoDB Atlas
2. Verify products have `embedding` field
3. API will fallback to text search automatically

### Rate Limit Issues

Default: 60 requests/minute per merchant.

To adjust, edit `src/middleware/rateLimit.ts`.

## 📝 TODO

- [ ] Implement Redis for distributed rate limiting
- [ ] Add analytics/metrics collection
- [ ] Create product indexing script
- [ ] Implement caching layer
- [ ] Add A/B testing for reranking weights
- [ ] Add query suggestions/autocomplete

## 📄 License

Private - Geffen Brain
