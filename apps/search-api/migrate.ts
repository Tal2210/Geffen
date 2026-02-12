import "dotenv/config";
import { MongoClient } from "mongodb";

async function migrateDatabase() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error("MONGO_URI not set");

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    console.log("✅ Connected to MongoDB Atlas");

    const wineDb = client.db("wine");
    const geffenDb = client.db("Geffen");

    // Get all collections from "wine" DB
    const collections = await wineDb.listCollections().toArray();
    console.log(`\n📦 Found ${collections.length} collections in "wine" DB:`);
    collections.forEach((c) => console.log(`   - ${c.name}`));

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

      // Get all documents from source
      const documents = await sourceCollection.find({}).toArray();

      // Insert into destination (replace if exists)
      // First, delete existing
      await destCollection.deleteMany({});

      // Then insert all
      const result = await destCollection.insertMany(documents);
      console.log(`   ✅ Migrated ${result.insertedIds.length} documents`);
    }

    console.log("\n🎉 Migration complete!");
    console.log(`\nVerifying in "Geffen" DB:`);

    const geffenCollections = await geffenDb.listCollections().toArray();
    console.log(`Total collections: ${geffenCollections.length}`);
    geffenCollections.forEach((c) => console.log(`   - ${c.name}`));
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

migrateDatabase();
