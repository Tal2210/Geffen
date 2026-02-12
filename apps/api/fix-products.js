import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { MongoClient } from "mongodb";

// Load .env from workspace root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

async function fixProducts() {
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
    const storesCollection = geffenDb.collection("stores.bana");

    // Step 1: Add merchantId to all products
    console.log("⏳ Step 1: Adding merchantId='store_a' to all products...");
    const merchantIdResult = await storesCollection.updateMany(
      { merchantId: { $exists: false } },
      { $set: { merchantId: "store_a" } }
    );
    console.log(`✅ Updated ${merchantIdResult.modifiedCount} products with merchantId`);

    // Step 2: Extract imageUrl from image/images fields
    console.log("\n⏳ Step 2: Extracting imageUrl from image/images fields...");
    
    const products = await storesCollection.find({}).toArray();
    const bulkOps = [];

    for (const product of products) {
      // Prefer string image field, fallback to images[0].src
      let imageUrl = null;

      if (typeof product.image === "string" && product.image) {
        imageUrl = product.image;
      } else if (Array.isArray(product.images) && product.images.length > 0) {
        const firstImage = product.images[0];
        if (typeof firstImage === "string") {
          imageUrl = firstImage;
        } else if (firstImage && typeof firstImage === "object" && firstImage.src) {
          imageUrl = firstImage.src;
        }
      }

      if (imageUrl) {
        bulkOps.push({
          updateOne: {
            filter: { _id: product._id },
            update: { $set: { imageUrl } }
          }
        });

        // Execute in batches of 100
        if (bulkOps.length >= 100) {
          await storesCollection.bulkWrite(bulkOps);
          console.log(`✓ Processed ${bulkOps.length} products...`);
          bulkOps.length = 0;
        }
      }
    }

    // Final batch
    if (bulkOps.length > 0) {
      await storesCollection.bulkWrite(bulkOps);
    }

    // Step 3: Verify
    console.log("\n⏳ Step 3: Verifying fixes...");
    const withMerchantId = await storesCollection.countDocuments({
      merchantId: { $exists: true, $ne: null }
    });
    const withImageUrl = await storesCollection.countDocuments({
      imageUrl: { $exists: true, $ne: null, $ne: "" }
    });

    console.log(`✅ Products with merchantId: ${withMerchantId}`);
    console.log(`✅ Products with imageUrl: ${withImageUrl}`);

    console.log("\n🎉 All fixes complete!");
    console.log("Your products are now ready for:");
    console.log("  1. Boost rules (merchantId=store_a matches)");
    console.log("  2. Images (imageUrl field populated)");

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

fixProducts();
