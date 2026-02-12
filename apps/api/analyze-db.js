import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { MongoClient } from "mongodb";

// Load .env from workspace root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

async function checkDatabase() {
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

    // Get all collections
    const collections = await geffenDb.listCollections().toArray();
    console.log(`📦 Collections in "Geffen" DB:`);
    collections.forEach((c) => console.log(`   - ${c.name}`));

    // Check stores.bana collection
    const storesCollection = geffenDb.collection("stores.bana");
    const count = await storesCollection.countDocuments();
    console.log(`\n📊 "stores.bana" collection: ${count} documents`);

    if (count > 0) {
      console.log("\n🔍 Sample products:");
      const samples = await storesCollection.find({}).limit(2).toArray();

      samples.forEach((p, i) => {
        console.log(`\n--- Product ${i + 1} ---`);
        console.log(`ID: ${p._id}`);
        console.log(`Name: ${p.name}`);
        console.log(`MerchantId: ${p.merchantId}`);
        console.log(`Price: ${p.price}`);
        console.log(`ImageUrl: ${p.imageUrl || "❌ MISSING"}`);
        console.log(`Image: ${p.image ? "✅ exists" : "❌ missing"}`);
        console.log(`Images: ${p.images ? "✅ exists" : "❌ missing"}`);
        console.log(`FeaturedImage: ${p.featuredImage ? "✅ exists" : "❌ missing"}`);
        console.log(`Thumbnail: ${p.thumbnail || "❌ missing"}`);
        
        // Show all fields
        console.log(`\nAll fields: ${Object.keys(p).join(", ")}`);
      });

      // Check merchantId distribution
      const merchantIds = await storesCollection
        .aggregate([{ $group: { _id: "$merchantId", count: { $sum: 1 } } }])
        .toArray();
      console.log(`\n👥 Products by merchantId:`);
      merchantIds.forEach((m) => console.log(`   ${m._id || "null"}: ${m.count}`));

      // Check imageUrl distribution
      const withImages = await storesCollection.countDocuments({
        imageUrl: { $exists: true, $ne: null, $ne: "" }
      });
      console.log(`\n🖼️  Products with imageUrl: ${withImages}/${count}`);
    }

    // Check boost rules
    const boostCollection = geffenDb.collection("product_boost_rules");
    const boostCount = await boostCollection.countDocuments();
    console.log(`\n⚙️  "product_boost_rules" collection: ${boostCount} documents`);

    if (boostCount > 0) {
      const boosts = await boostCollection.find({}).limit(3).toArray();
      console.log(`\nSample boost rules:`);
      boosts.forEach((b, i) => {
        console.log(
          `  ${i + 1}. "${b.triggerQuery}" → product "${b.productId}" (${b.matchMode}, ${b.active ? "active" : "inactive"})`
        );
      });
    }

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

checkDatabase();
