import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { MongoClient } from "mongodb";

// Load .env from workspace root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

async function inspectImages() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("❌ MONGO_URI not found");
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    console.log("✅ Connected\n");

    const geffenDb = client.db("Geffen");
    const storesCollection = geffenDb.collection("stores.bana");

    // Get first product with image data
    const product = await storesCollection.findOne({
      image: { $exists: true, $ne: null }
    });

    if (product) {
      console.log("📸 Product with image field:");
      console.log(`Name: ${product.name}\n`);
      console.log("Image field type:", typeof product.image);
      console.log("Image value:", JSON.stringify(product.image, null, 2));
      
      if (product.images) {
        console.log("\nImages field (array):");
        console.log("Type:", typeof product.images);
        console.log("Array length:", Array.isArray(product.images) ? product.images.length : "not array");
        console.log("First item:", JSON.stringify(product.images[0], null, 2));
      }
    }

  } catch (error) {
    console.error("❌ Error:", error.message);
  } finally {
    await client.close();
  }
}

inspectImages();
