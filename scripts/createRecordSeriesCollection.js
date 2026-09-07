const { MilvusClient, DataType } = require('@zilliz/milvus2-sdk-node');
require('dotenv').config();

const COLLECTION_NAME = 'lva_record_series';

async function createCollection() {
  const client = new MilvusClient({
    address: process.env.MILVUS_ENDPOINT,
    token: process.env.MILVUS_TOKEN,
  });

  const exists = await client.hasCollection({ collection_name: COLLECTION_NAME });
  if (exists.value) {
    console.log(`Collection "${COLLECTION_NAME}" already exists. Dropping it to recreate cleanly...`);
    await client.dropCollection({ collection_name: COLLECTION_NAME });
  }

  console.log('Creating collection with schema matching project brief...');

  await client.createCollection({
    collection_name: COLLECTION_NAME,
    fields: [
      {
        name: 'id',
        data_type: DataType.Int64,
        is_primary_key: true,
        autoID: true,
      },
      {
        name: 'schedule_title',
        data_type: DataType.VarChar,
        max_length: 200,
      },
      {
        name: 'schedule_number',
        data_type: DataType.VarChar,
        max_length: 50,
      },
      {
        name: 'series_title',
        data_type: DataType.VarChar,
        max_length: 200,
      },
      {
        name: 'series_number',
        data_type: DataType.VarChar,
        max_length: 50,
      },
      {
        name: 'series_description',
        data_type: DataType.VarChar,
        max_length: 2000,
      },
      {
        name: 'retention_period',
        data_type: DataType.VarChar,
        max_length: 200,
      },
      {
        name: 'disposition_method',
        data_type: DataType.VarChar,
        max_length: 100,
      },
      {
        name: 'text_to_embed',
        data_type: DataType.VarChar,
        max_length: 2000,
      },
      {
        name: 'embedding',
        data_type: DataType.FloatVector,
        dim: 768, // placeholder - will confirm exact size once embedding model is chosen
      },
    ],
  });

  console.log('Collection created successfully.');

  console.log('Creating index on the embedding field (HNSW)...');
  await client.createIndex({
    collection_name: COLLECTION_NAME,
    field_name: 'embedding',
    index_type: 'HNSW',
    metric_type: 'COSINE',
    params: { M: 16, efConstruction: 200 },
  });

  await client.loadCollection({ collection_name: COLLECTION_NAME });
  console.log('Collection loaded and ready.');

  const description = await client.describeCollection({ collection_name: COLLECTION_NAME });
  console.log('\nSchema summary:');
  description.schema.fields.forEach((f) => {
    console.log(`- ${f.name}: ${f.data_type}${f.dim ? ` (dim: ${f.dim})` : ''}`);
  });
}

createCollection().catch((err) => console.error('Error:', err.message));