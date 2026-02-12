import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { MongoClient } from "mongodb";

// Load .env from workspace root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

async function migrateDatabase() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("❌ MONGO_URI not found in environment variables");
    console.error("Attempted to load from:", envPath);
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);
  
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB Atlas");

    const wineDb = client.db("wine");
    const geffenDb = client.db("Geffen");

    // Get all collections from "wine" DB
    const collections = await wineDb.listCollections().toArray();
    console.log(`\n📦 Found ${collections.length} collections in "wine" DB:`);
    collections.forEach(c => console.log(`   - ${c.name}`));

    // Migrate each collection
    for (const collInfo of collections) {
      const collName = collInfo.name;
      console.log(`\n⏳ Migrating "${collName}"...`);

      // Get source and destination collections
      const sourceCollection = wineDb.collection(collName);
      const destCollection = geffenDb.collection(collName);

      // Count documents
      const count = await sourceCollection.countDocuments();
      console.log(`   Source: ${count} documents`);

      if (count === 0) {
        console.log(`   ✅ Skipped (empty)`);
        continue;
      }

      // Get all documents from source with pagination to show progress
      const batchSize = 500;
      const batches = Math.ceil(count / batchSize);
      console.log(`   Reading documents in ${batches} batches...`);

      const documents = [];
      for (let i = 0; i < batches; i++) {
        const skip = i * batchSize;
        const batch = await sourceCollection
          .find({})
          .skip(skip)
          .limit(batchSize)
          .toArray();
        documents.push(...batch);
        console.log(`   Loaded: ${i + 1}/${batches} batches (${documents.length}/${count})`);
      }

      // Insert into destination (replace if exists)
      // First, delete existing
      console.log(`   Clearing destination collection...`);
      await destCollection.deleteMany({});

      // Then insert all in batches to avoid memory issues
      console.log(`   Inserting documents...`);
      const insertBatchSize = 1000;
      const insertBatches = Math.ceil(documents.length / insertBatchSize);
      
      for (let i = 0; i < insertBatches; i++) {
        const start = i * insertBatchSize;
        const end = Math.min((i + 1) * insertBatchSize, documents.length);
        const batch = documents.slice(start, end);
        await destCollection.insertMany(batch);
        console.log(`   Inserted: ${i + 1}/${insertBatches} batches (${end}/${documents.length})`);
      }

      console.log(`   ✅ Migrated ${documents.length} documents`);
    }

    console.log("\n🎉 Migration complete!");
    console.log(`\nVerifying in "Geffen" DB:`);
    
    const geffenCollections = await geffenDb.listCollections().toArray();
    console.log(`Total collections: ${geffenCollections.length}`);
    geffenCollections.forEach(c => console.log(`   - ${c.name}`));

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

migrateDatabase();
