import * as dotenv from 'dotenv';
dotenv.config();
import { MongoClient } from 'mongodb';

// Simple embedding generation - using sum of character codes as a pseudo-embedding
// In production, you'd use OpenAI, Gemini, or another embedding service
const generateQuickEmbedding = (text) => {
  // Create a simple deterministic embedding based on text
  // This is just for testing - NOT suitable for production
  const embedding = new Array(384).fill(0); // 384-dimensional vector
  
  const hash = (str) => {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h = h & h; // Convert to 32bit integer
    }
    return Math.abs(h);
  };
  
  const baseHash = hash(text);
  
  // Create deterministic embedding using text hash
  for (let i = 0; i < embedding.length; i++) {
    const seed = baseHash + i;
    // Pseudo-random number from seed
    const x = Math.sin(seed) * 10000;
    embedding[i] = x - Math.floor(x);
  }
  
  // Normalize to unit vector
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] = embedding[i] / norm;
    }
  }
  
  return embedding;
};

const client = new MongoClient(process.env.MONGO_URI);

try {
  await client.connect();
  console.log('✅ Connected to MongoDB Atlas');
  
  const db = client.db(process.env.MONGO_DB);
  const collection = db.collection(process.env.MONGO_COLLECTION);
  
  const total = await collection.countDocuments();
  const withEmbedding = await collection.countDocuments({ embedding: { $exists: true } });
  const needsEmbedding = total - withEmbedding;
  
  console.log(`📊 Embedding Status:`);
  console.log(`  Total products: ${total}`);
  console.log(`  Already have embeddings: ${withEmbedding}`);
  console.log(`  Need embeddings: ${needsEmbedding}`);
  
  if (needsEmbedding === 0) {
    console.log(`\n✅ All products already have embeddings!`);
    await client.close();
    process.exit(0);
  }
  
  console.log(`\n⏳ Generating embeddings for ${needsEmbedding} products...`);
  
  const batchSize = 100;
  let processed = 0;
  let updated = 0;
  
  // Use cursor to avoid loading all documents at once
  const cursor = collection.find({ embedding: { $exists: false } });
  cursor.project({ _id: 1, name: 1, description: 1, category: 1 });
  const products = await cursor.toArray();
  
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, Math.min(i + batchSize, products.length));
    
    const bulkOps = batch.map(product => {
      const text = [product.name, product.description, product.category]
        .filter(Boolean)
        .join(' ');
      const embedding = generateQuickEmbedding(text);
      
      return {
        updateOne: {
          filter: { _id: product._id },
          update: { $set: { embedding } }
        }
      };
    });
    
    const result = await collection.bulkWrite(bulkOps);
    processed += batch.length;
    updated += result.modifiedCount;
    
    console.log(`  ✓ Batch ${(i / batchSize) + 1}: ${processed}/${products.length} products processed`);
  }
  
  console.log(`\n✅ Embedding population complete!`);
  console.log(`  Updated: ${updated} products`);
  
  // Verify
  const finalWithEmbedding = await collection.countDocuments({ embedding: { $exists: true } });
  console.log(`  Total with embeddings now: ${finalWithEmbedding}/${total}`);
  
} finally {
  await client.close();
}
