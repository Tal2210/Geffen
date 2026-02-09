import os
from pymongo import MongoClient
from google import genai
from dotenv import load_dotenv
import time
import sys

# Load environment variables
load_dotenv()

# MongoDB Configuration
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
MONGO_DB = os.getenv("MONGO_DB", "wine")
MONGO_COLLECTION = os.getenv("MONGO_COLLECTION", "stores.bana")
BATCH_SIZE = 10 # Adjust batch size based on your product count and API limits

# Gemini API Configuration
GEMINI_API_KEY = os.getenv("LLM_API_KEY")
if not GEMINI_API_KEY:
    raise ValueError("LLM_API_KEY environment variable not set.")

# Initialize Gemini client
client = genai.Client(api_key=GEMINI_API_KEY)

EMBEDDING_MODEL = "gemini-embedding-001"

def main():
    try:
        mongo_client = MongoClient(MONGO_URI)
        db = mongo_client[MONGO_DB]
        collection = db[MONGO_COLLECTION]
        print(f"Successfully connected to MongoDB: {MONGO_DB}.{MONGO_COLLECTION}")
    except Exception as e:
        print(f"Error connecting to MongoDB: {e}")
        mongo_client.close()
        sys.exit(1)

    query = {
        "$or": [
            {"embedding": {"$exists": False}},
            {"embedding": None},
            {"embedding": {"$size": 0}}
        ]
    }

    products_to_update = list(collection.find(query).limit(1000))
    total_products = len(products_to_update)
    print(f"Found {total_products} products without embeddings to update.")

    if not products_to_update:
        print("No products found without embeddings. Exiting.")
        mongo_client.close()
        sys.exit(0)

    updated_count = 0
    for i in range(0, total_products, BATCH_SIZE):
        batch = products_to_update[i:i + BATCH_SIZE]
        texts_to_embed = []
        product_ids = []

        for product in batch:
            text_to_embed = f"{product.get('name', '')} {product.get('description', '')}"
            texts_to_embed.append(text_to_embed)
            product_ids.append(product['_id'])

        if not texts_to_embed:
            continue

        try:
            print(f"DEBUG: Embedding batch with {len(texts_to_embed)} texts.")
            response = client.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=texts_to_embed
            )
            print(f"DEBUG: Raw API response: {response}") # Print raw response
            
            embeddings_data = [e.values for e in response.embeddings]

            for j, product_id in enumerate(product_ids):
                embedding = embeddings_data[j]
                if embedding:
                    collection.update_one(
                        {"_id": product_id},
                        {"$set": {"embedding": embedding}}
                    )
                    updated_count += 1
                    print(f"Updated product {product_id} with embedding.")
                else:
                    print(f"Skipping product {product_id} due to embedding generation error (embedding was empty).")

        except Exception as e:
            print(f"An error occurred processing batch {i // BATCH_SIZE}: {e}. Skipping batch.")
            if hasattr(e, 'response') and e.response:
                print(f"DEBUG: Error response details: {e.response.json()}") # Print error response if available

        # Removed: sys.exit(0) - no longer needed for debugging the first batch

        time.sleep(60) # Wait for 60 seconds between batches

    print(f"Finished. Total products updated: {updated_count}")
    mongo_client.close()

if __name__ == "__main__":
    main()