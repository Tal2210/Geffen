import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { MongoClient } from "mongodb";

// Load .env from workspace root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

async function cleanup() {
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
    const storesBanaCollection = geffenDb.collection("stores.bana");

    // Delete stores.bana collection
    console.log("🗑️  Deleting 'stores.bana' collection to free up space...");
    await storesBanaCollection.deleteMany({});
    console.log("✅ Collection cleared");

    // Verify
    const count = await storesBanaCollection.countDocuments();
    console.log(`✅ Verified: 'stores.bana' now has ${count} documents`);

    console.log("\n🎉 Cleanup complete!");
    console.log("💾 Space freed up in MongoDB Atlas");

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

cleanup();
