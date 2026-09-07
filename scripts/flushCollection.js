const { MilvusClient } = require('@zilliz/milvus2-sdk-node');
require('dotenv').config();

async function run() {
  const client = new MilvusClient({
    address: process.env.MILVUS_ENDPOINT,
    token: process.env.MILVUS_TOKEN,
  });

  console.log('Flushing collection...');
  await client.flush({ collection_names: ['lva_record_series'] });
  console.log('Flush complete.');

  const stats = await client.getCollectionStatistics({
    collection_name: 'lva_record_series',
  });
  console.log('Confirmed row count after flush:', stats.data.row_count);
}

run().catch((err) => console.error('Error:', err.message));