const { MongoClient } = require('mongodb');

(async () => {
  const c = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  await c.connect();
  const db = c.db(process.env.MONGO_DB || 'wine');
  const col = db.collection(process.env.MONGO_COLLECTION || 'stores.bana');

  const wineMatch = {
    $or: [
      { category: { $regex: 'יין' } },
      { category: { $elemMatch: { $regex: 'יין' } } },
    ],
  };
  const redMatch = {
    $or: [
      { category: { $regex: 'אדום' } },
      { category: { $elemMatch: { $regex: 'אדום' } } },
    ],
  };
  const hasEmbedding = { embedding: { $exists: true, $type: 'array' } };

  const [
    allDocs,
    allWithEmbeddings,
    wineDocs,
    wineWithEmbeddings,
    redDocs,
    redWithEmbeddings,
  ] = await Promise.all([
    col.countDocuments({}),
    col.countDocuments(hasEmbedding),
    col.countDocuments(wineMatch),
    col.countDocuments({ ...wineMatch, ...hasEmbedding }),
    col.countDocuments(redMatch),
    col.countDocuments({ ...redMatch, ...hasEmbedding }),
  ]);

  console.log(JSON.stringify({ allDocs, allWithEmbeddings, wineDocs, wineWithEmbeddings, redDocs, redWithEmbeddings }, null, 2));
  await c.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
