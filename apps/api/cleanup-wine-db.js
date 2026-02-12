import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { MongoClient } from "mongodb";

// Load .env from workspace root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

async function cleanupWineDB() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("❌ MONGO_URI not found");
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    console.log("✅ Connected to MongoDB Atlas\n");

    const wineDb = client.db("wine");

    // Get all collections from "wine" DB
    const collections = await wineDb.listCollections().toArray();
    console.log(`📦 Found ${collections.length} collections in "wine" DB:`);
    collections.forEach((c) => console.log(`   - ${c.name}`));

    console.log("\n⏳ Deleting collections to free up space...");

    for (const collInfo of collections) {
      const collName = collInfo.name;
      console.log(`\n   Deleting "${collName}"...`);
      await wineDb.collection(collName).deleteMany({});
      console.log(`   ✅ Deleted`);
    }

    console.log("\n🎉 Cleanup complete! Space freed up.");
    console.log("\nNow the Geffen DB should have all your products in 'stores.bana' collection");

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

cleanupWineDB();
