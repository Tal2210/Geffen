# 📋 Deployment Checklist - Wine Search API

## ✅ מה נבנה

**Search API מלא ומוכן לייצור** עם:
- ✅ Semantic search עם vector embeddings
- ✅ Multi-tenant architecture (merchantId isolation)
- ✅ Query parsing & NER (English + Hebrew)
- ✅ MongoDB Atlas Vector Search
- ✅ Rule-based reranking
- ✅ API key authentication
- ✅ Rate limiting (60 req/min per merchant)
- ✅ Health checks & metrics
- ✅ Render deployment config

## 🚀 Pre-Deployment Checklist

### 1. MongoDB Atlas Setup

- [ ] **Create Vector Index** `wine_vector_index`
  - Go to Atlas Search → Create Index
  - Use JSON config from `SEARCH_API_GUIDE.md`
  - Wait for index to build (~5-10 minutes)

- [ ] **Verify Products Collection**
  - Collection: `bana.stores`
  - Required fields:
    - `merchantId` (string) - CRITICAL for multi-tenancy!
    - `name` (string)
    - `price` (number)
    - `embedding` (array of 768 numbers) - optional but recommended
  
- [ ] **Add Sample Products** (if needed)
  ```javascript
  // Example product structure:
  {
    "_id": "product_123",
    "merchantId": "store_a",  // ← CRITICAL!
    "name": "Château Margaux 2018",
    "description": "Full-bodied red wine from Bordeaux",
    "price": 89.99,
    "color": "red",
    "country": "france",
    "region": "bordeaux",
    "grapes": ["cabernet sauvignon", "merlot"],
    "vintage": 2018,
    "kosher": false,
    "inStock": true,
    "stockCount": 25,
    "embedding": [0.123, 0.456, ...] // 768 numbers
  }
  ```

### 2. Environment Variables

Create these in Render Dashboard:

```bash
# MongoDB
MONGO_URI="mongodb+srv://USER:PASS@cluster.mongodb.net/?retryWrites=true&w=majority"
MONGO_DB="Geffen"
MONGO_COLLECTION="bana.stores"

# LLM / Embeddings
LLM_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai"
LLM_API_KEY="your-gemini-api-key-here"
EMBEDDING_MODEL="text-embedding-004"

# Server
PORT=3000
NODE_ENV="production"
CORS_ORIGIN="*"  # Or your specific domain
```

### 3. API Keys Management

**Development Keys** (in code):
```
test_key_store_a  → store_a
test_key_store_b  → store_b
dev_key_123       → demo_merchant
```

**Production Keys** (TODO):
- [ ] Create database table for API keys
- [ ] Implement key generation endpoint
- [ ] Add key expiration logic
- [ ] Add usage tracking

### 4. GitHub Repository

- [ ] Commit all changes:
  ```bash
  git add .
  git commit -m "Add Wine Search API with multi-tenant support"
  git push origin main
  ```

- [ ] Verify `render.yaml` is in root

## 🌐 Render Deployment

### Option A: Auto-Deploy (Recommended)

1. [ ] Push to GitHub (done above)
2. [ ] Go to https://render.com/dashboard
3. [ ] Click **New +** → **Blueprint**
4. [ ] Select your repo
5. [ ] Render will detect `render.yaml` and create **2 services**:
   - `geffen-brain-api` (existing)
   - `geffen-brain-search-api` (new)
6. [ ] Add environment variables in dashboard
7. [ ] Click **Apply**

### Option B: Manual Deploy

1. [ ] Go to https://render.com/dashboard
2. [ ] **New +** → **Web Service**
3. [ ] Connect GitHub repo
4. [ ] Configure:
   - Name: `geffen-brain-search-api`
   - Region: **Frankfurt (EU)**
   - Root Directory: `apps/search-api`
   - Build: `corepack pnpm install && corepack pnpm build`
   - Start: `corepack pnpm start`
   - Plan: **Starter** ($7/month)
5. [ ] Add environment variables (see above)
6. [ ] Deploy!

## 🧪 Post-Deployment Testing

### 1. Health Check

```bash
curl https://your-search-api.onrender.com/health
```

Expected:
```json
{
  "ok": true,
  "service": "wine-search-api",
  "timestamp": "..."
}
```

### 2. Test Search

```bash
curl -X POST https://your-search-api.onrender.com/search \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test_key_store_a" \
  -d '{
    "query": "red wine from france",
    "merchantId": "store_a",
    "limit": 5
  }'
```

### 3. Check Performance

Look for `X-Search-Time` header in response.
Target: < 250ms (p95)

### 4. Test Rate Limiting

Make 61 requests in 1 minute → should get 429 error

## 📊 Monitoring

### Render Dashboard

- [ ] Check logs for errors
- [ ] Monitor response times
- [ ] Check memory usage
- [ ] Set up alerts

### Custom Metrics (TODO)

- [ ] Implement `/metrics` endpoint properly
- [ ] Track searches per merchant
- [ ] Track average latency
- [ ] Track error rates

## 🔐 Security Checklist

- [ ] **API Keys:** Move to database (not hardcoded)
- [ ] **Rate Limiting:** Consider Redis for distributed limiting
- [ ] **CORS:** Set specific origins (not `*`)
- [ ] **Secrets:** All sensitive data in Render env vars
- [ ] **MongoDB:** Verify IP whitelist includes Render IPs
- [ ] **HTTPS:** Enabled by default on Render ✅

## 💰 Cost Estimation

### Render Costs:
- **Search API:** $7/month (Starter plan)
- **Main API:** $7/month (if not already deployed)
- **Total:** $14/month for both services

### MongoDB Atlas:
- **M0 (Free):** Up to 512MB storage
- **M10 ($57/month):** 10GB storage, better performance
- **Recommended:** Start with M0, upgrade when needed

### Gemini API:
- **Embeddings:** ~$0.00002 per 1K tokens
- **Example:** 10,000 searches/month = ~$2/month

**Total Estimated Cost:** $16-75/month depending on scale

## 📈 Scaling Plan

### When to Scale Up:

**Indicators:**
- Response time > 500ms (p95)
- Error rate > 1%
- CPU usage > 80%
- Memory usage > 80%

**Actions:**
1. Upgrade Render plan (Starter → Standard → Pro)
2. Enable auto-scaling (up to 5 instances)
3. Add Redis for caching
4. Upgrade MongoDB Atlas tier

## 🎯 Next Steps After Deployment

1. [ ] **Generate Embeddings** for existing products
2. [ ] **Create Admin Dashboard** for API key management
3. [ ] **Implement Analytics** - track usage per merchant
4. [ ] **Add Caching** - Redis for popular queries
5. [ ] **A/B Testing** - test different reranking weights
6. [ ] **Documentation** - API docs for store owners
7. [ ] **Billing System** - charge per search or tier

## 📞 Support

- **Logs:** Render Dashboard → Logs tab
- **Errors:** Check `/health` endpoint
- **Performance:** Check `X-Search-Time` headers
- **MongoDB:** Atlas Dashboard → Metrics

## ✅ Final Checklist

Before going live:

- [ ] MongoDB vector index created and ready
- [ ] Sample products exist with merchantId
- [ ] Environment variables set in Render
- [ ] Deployed to Render successfully
- [ ] Health check passes
- [ ] Test search works
- [ ] Rate limiting works
- [ ] CORS configured correctly
- [ ] Monitoring set up
- [ ] Documentation shared with team

---

**Ready to deploy?** Follow the steps above and you're good to go! 🚀
