const { MongoClient } = require('mongodb');
(async () => {
  const c = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  await c.connect();
  const col = c.db(process.env.MONGO_DB || 'wine').collection(process.env.MONGO_COLLECTION || 'stores.bana');
  const exact = await col.countDocuments({ category: { $in: ['יין אדום'] } });
  const regex = await col.countDocuments({ $or: [{ category: { $regex: 'אדום' } }, { category: { $elemMatch: { $regex: 'אדום' } } }] });
  console.log(JSON.stringify({ exact, regex }, null, 2));
  const sample = await col.find({ $or: [{ category: { $regex: 'אדום' } }, { category: { $elemMatch: { $regex: 'אדום' } } }] }, { projection: { category: 1, name: 1 } }).limit(10).toArray();
  console.log(JSON.stringify(sample, null, 2));
  await c.close();
})().catch((e) => { console.error(e); process.exit(1); });
