require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db(process.env.MONGO_DB);
    const collection = db.collection(process.env.MONGO_COLLECTION);
    
    const total = await collection.countDocuments();
    const withEmbedding = await collection.countDocuments({ embedding: { $exists: true } });
    const withoutEmbedding = total - withEmbedding;
    
    // Get a sample of embedding data
    const samples = await collection.find().limit(3).toArray();
    
    console.log(`📊 Embedding Status:`);
    console.log(`  Total products: ${total}`);
    console.log(`  With embeddings: ${withEmbedding} (${((withEmbedding/total)*100).toFixed(1)}%)`);
    console.log(`  Without embeddings: ${withoutEmbedding}`);
    console.log(`\n📦 Sample products:`);
    samples.forEach((p, i) => {
      const hasEmbedding = p.embedding ? (Array.isArray(p.embedding) ? `✓ (${p.embedding.length} dims)` : '✗ (not array)') : '✗ (missing)';
      console.log(`  ${i+1}. "${p.name}" - Embedding: ${hasEmbedding}`);
    });
    
  } finally {
    await client.close();
  }
})().catch(console.error);
