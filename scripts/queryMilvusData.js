const { MilvusClient } = require('@zilliz/milvus2-sdk-node');
require('dotenv').config();

const COLLECTION_NAME = 'lva_record_series';

async function run() {
  const client = new MilvusClient({
    address: process.env.MILVUS_ENDPOINT,
    token: process.env.MILVUS_TOKEN,
  });

  // Fetch everything (id > 0 matches all real entries, since IDs are auto-generated positive numbers)
  const result = await client.query({
    collection_name: COLLECTION_NAME,
    filter: 'id > 0',
    output_fields: ['series_title', 'series_number', 'retention_period', 'disposition_method'],
    limit: 100,
  });

  console.log(`Total entries found: ${result.data.length}`);
  console.log('\nFirst 5 entries:');
  result.data.slice(0, 5).forEach((entry) => {
    console.log(`- [${entry.series_number}] ${entry.series_title} (${entry.retention_period}, ${entry.disposition_method})`);
  });
}

run().catch((err) => console.error('Error:', err.message));