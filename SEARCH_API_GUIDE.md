# 🚀 Wine Search API - Quick Start Guide

## ✅ מה בנינו?

**Search API נפרד ומוכן לייצור** שמאפשר חיפוש סמנטי במוצרי יין עבור מספר חנויות (multi-tenant).

## 📂 המבנה

```
apps/
├── api/              ← API ראשי (קיים)
├── search-api/       ← 🆕 API חיפוש חדש!
│   ├── src/
│   │   ├── services/     # לוגיקת חיפוש
│   │   ├── routes/       # נתיבי API
│   │   ├── middleware/   # אימות + rate limiting
│   │   └── types/        # TypeScript types
│   └── package.json
└── web/              ← Frontend (קיים)
```

## 🏃 הרצה מקומית

### שלב 1: התחל את ה-Search API

```bash
cd apps/search-api
corepack pnpm dev
```

השרת יעלה על: **http://localhost:3000**

### שלב 2: בדוק שהשרת עובד

```bash
curl http://localhost:3000/health
```

תקבל:
```json
{
  "ok": true,
  "service": "wine-search-api",
  "timestamp": "2026-02-08T..."
}
```

### שלב 3: נסה חיפוש

```bash
curl -X POST http://localhost:3000/search \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test_key_store_a" \
  -d '{
    "query": "יין אדום מצרפת",
    "merchantId": "store_a",
    "limit": 10
  }'
```

## 🔑 API Keys (Development)

```
test_key_store_a  → merchantId: store_a
test_key_store_b  → merchantId: store_b
dev_key_123       → merchantId: demo_merchant
```

## 🗄️ הכנת MongoDB Atlas

### 1. צור Vector Index

ב-MongoDB Atlas Dashboard:
1. לך ל-**Atlas Search** → **Create Index**
2. בחר **JSON Editor**
3. שם Index: `wine_vector_index`
4. הדבק את ה-JSON:

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
      "path": "price"
    },
    {
      "type": "filter",
      "path": "inStock"
    }
  ]
}
```

### 2. הוסף Embeddings למוצרים

המוצרים ב-`bana.stores` צריכים שדה `embedding` (מערך של 768 מספרים).

אם אין להם, ה-API יעבוד במצב fallback (חיפוש טקסט רגיל).

## 🚀 Deploy ל-Render

### אופציה 1: Auto-Deploy (מומלץ)

הפרויקט כולל `render.yaml` מוכן!

```bash
# פשוט תעשה push ל-GitHub
git add .
git commit -m "Add search API"
git push origin main
```

Render יזהה את ה-`render.yaml` וידפלוי אוטומטית **2 services**:
- `geffen-brain-api` (main API)
- `geffen-brain-search-api` (search API)

### אופציה 2: Manual

1. לך ל-https://render.com/dashboard
2. **New +** → **Web Service**
3. בחר את ה-repo
4. הגדרות:
   - **Name:** `geffen-brain-search-api`
   - **Region:** Frankfurt (EU)
   - **Root Directory:** `apps/search-api`
   - **Build:** `corepack pnpm install && corepack pnpm build`
   - **Start:** `corepack pnpm start`
   - **Plan:** Starter ($7/month)

5. Environment Variables:
```
MONGO_URI=mongodb+srv://...
MONGO_DB=Geffen
MONGO_COLLECTION=bana.stores
LLM_API_KEY=your-gemini-key
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
EMBEDDING_MODEL=text-embedding-004
PORT=3000
NODE_ENV=production
```

## 📡 שימוש מהחנויות

```typescript
// בקוד של חנות היין:
async function searchWines(query: string) {
  const response = await fetch('https://your-search-api.onrender.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'YOUR_STORE_API_KEY'  // כל חנות מקבלת key
    },
    body: JSON.stringify({
      query: query,
      merchantId: 'store_a',  // או אוטומטית מה-API key
      limit: 24
    })
  });
  
  return response.json();
}
```

## 🎯 דוגמאות שאילתות

```javascript
// חיפוש פשוט
{ "query": "יין אדום", "merchantId": "store_a" }

// עם פילטרים
{
  "query": "יין מתוק מצרפת",
  "merchantId": "store_a",
  "maxPrice": 100,
  "colors": ["white"],
  "kosher": true
}

// חיפוש מתקדם
{
  "query": "cabernet sauvignon from napa valley under $50",
  "merchantId": "store_a",
  "limit": 12
}
```

## 📊 Performance

Expected latency (p95):
- **Parsing:** < 5ms
- **Embedding:** 50-150ms
- **Vector Search:** 20-50ms
- **Reranking:** < 10ms
- **Total:** **100-250ms**

## 🔧 Troubleshooting

### שגיאה: "Vector search failed"

**פתרון:** ה-API עובד במצב fallback. תיצור vector index ב-MongoDB Atlas.

### שגיאה: "Rate limit exceeded"

**פתרון:** ברירת מחדל 60 requests/minute. ערוך `src/middleware/rateLimit.ts`.

### שגיאה: "Invalid API key"

**פתרון:** השתמש באחד מה-keys של development או הוסף חדש ב-`src/middleware/auth.ts`.

## 📝 הצעדים הבאים

1. ✅ **הרץ locally** - `cd apps/search-api && pnpm dev`
2. ✅ **בדוק עם curl** - ראה דוגמאות למעלה
3. 🔲 **צור vector index** - ב-MongoDB Atlas
4. 🔲 **הוסף embeddings** - למוצרים קיימים
5. 🔲 **Deploy ל-Render** - push to GitHub
6. 🔲 **חבר מהחנויות** - השתמש ב-API

## 💡 Tips

- **Development:** השתמש ב-`test_key_store_a` לבדיקות
- **Production:** צור API keys אמיתיים בDB
- **Monitoring:** בדוק `/metrics` endpoint
- **Scaling:** Render auto-scales עד 5 instances

## 🆘 צריך עזרה?

ראה `apps/search-api/README.md` לתיעוד מלא!
