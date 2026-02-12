import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { MongoClient } from "mongodb";

// Load .env from workspace root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

async function migrateToProducts() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("❌ MONGO_URI not found");
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    console.log("✅ Connected to MongoDB Atlas\n");

    const geffenDb = client.db("Geffen");
    const sourceCollection = geffenDb.collection("stores.bana");
    const destCollection = geffenDb.collection("products");

    // Count documents
    const count = await sourceCollection.countDocuments();
    console.log(`📦 Found ${count} documents in "stores.bana"`);

    if (count === 0) {
      console.log("No documents to migrate.");
      process.exit(0);
    }

    // Step 1: Check if products collection has data
    const destCount = await destCollection.countDocuments();
    if (destCount > 0) {
      console.log(`\n⚠️  "products" collection already has ${destCount} documents`);
      console.log("⏳ Clearing destination collection...");
      await destCollection.deleteMany({});
      console.log("✅ Cleared");
    }

    // Step 2: Copy data in batches
    console.log(`\n⏳ Migrating ${count} documents to "products"...`);
    const batchSize = 500;
    const batches = Math.ceil(count / batchSize);

    for (let i = 0; i < batches; i++) {
      const skip = i * batchSize;
      const documents = await sourceCollection
        .find({})
        .skip(skip)
        .limit(batchSize)
        .toArray();

      if (documents.length > 0) {
        await destCollection.insertMany(documents);
        console.log(`✓ Batch ${i + 1}/${batches} (${documents.length} documents)`);
      }
    }

    // Step 3: Verify
    console.log("\n⏳ Verifying migration...");
    const finalCount = await destCollection.countDocuments();
    console.log(`✅ "products" collection now has ${finalCount} documents`);

    if (finalCount === count) {
      console.log("\n✨ Migration successful!");
      console.log(`\nNext steps:`);
      console.log(`1. Update .env: MONGO_COLLECTION="products"`);
      console.log(`2. Restart the search-api server`);
      console.log(`3. (Optional) Delete "stores.bana" collection to free up space`);
    }

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

migrateToProducts();
