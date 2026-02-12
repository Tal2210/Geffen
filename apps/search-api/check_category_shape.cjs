const { MongoClient } = require('mongodb');

(async () => {
  const c = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  await c.connect();
  const db = c.db(process.env.MONGO_DB || 'wine');
  const col = db.collection(process.env.MONGO_COLLECTION || 'stores.bana');

  const hasEmbedding = { embedding: { $exists: true, $type: 'array' } };
  const redToken = {
    $or: [
      { category: { $regex: 'אדום' } },
      { category: { $elemMatch: { $regex: 'אדום' } } },
    ],
  };

  const [redEmb, redEmbCatArray, redEmbCatString] = await Promise.all([
    col.countDocuments({ ...hasEmbedding, ...redToken }),
    col.countDocuments({ ...hasEmbedding, ...redToken, category: { $type: 'array' } }),
    col.countDocuments({ ...hasEmbedding, ...redToken, category: { $type: 'string' } }),
  ]);

  const samples = await col
    .find({ ...hasEmbedding, ...redToken }, { projection: { name: 1, category: 1 } })
    .limit(8)
    .toArray();

  console.log(JSON.stringify({ redEmb, redEmbCatArray, redEmbCatString, samples }, null, 2));
  await c.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
