const { GoogleGenAI } = require('@google/genai');
const { MilvusClient } = require('@zilliz/milvus2-sdk-node');
const fs = require('fs');
require('dotenv').config();

const COLLECTION_NAME = 'lva_record_series';
const JSON_PATH = process.argv[2] || 'C:\\Users\\DELL\\Downloads\\LVA\\gs17_data.json';

async function generateEmbedding(ai, text) {
  const result = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: text,
    config: { outputDimensionality: 768, taskType: 'RETRIEVAL_DOCUMENT' },
  });
  return result.embeddings[0].values;
}

function validateEntries(data) {
  const problems = [];
  data.forEach((entry, i) => {
    if (!entry.schedule_number || !entry.series_number || !entry.series_title) {
      problems.push(`Row ${i + 1}: missing schedule_number/series_number/series_title`);
    }
    if (entry.retention_period && /refer to|see series|see schedule/i.test(entry.retention_period)) {
      problems.push(`Row ${i + 1} (${entry.series_title}): retention_period looks like an unresolved cross-reference, not a real value: "${entry.retention_period}"`);
    }
  });
  return problems;
}

async function run() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const milvus = new MilvusClient({
    address: process.env.MILVUS_ENDPOINT,
    token: process.env.MILVUS_TOKEN,
  });

  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  console.log(`Loaded ${data.length} entries from ${JSON_PATH}`);

  const problems = validateEntries(data);
  if (problems.length > 0) {
    console.error('Ingestion aborted — fix these in the JSON before inserting:');
    problems.forEach((p) => console.error(`  - ${p}`));
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    try {
      console.log(`[${i + 1}/${data.length}] Embedding: ${entry.series_title}...`);

      const embedding = await generateEmbedding(ai, entry.text_to_embed);

      const dispositionMethod = entry.disposition_method || 'Not Applicable — Permanent Retention';

      await milvus.insert({
        collection_name: COLLECTION_NAME,
        data: [
          {
            schedule_title: entry.schedule_title,
            schedule_number: entry.schedule_number,
            series_title: entry.series_title,
            series_number: entry.series_number,
            series_description: entry.series_description,
            retention_period: entry.retention_period,
            disposition_method: dispositionMethod,
            text_to_embed: entry.text_to_embed,
            embedding: embedding,
          },
        ],
      });

      successCount++;
    } catch (err) {
      console.error(`Failed on entry ${i + 1} (${entry.series_title}):`, err.message);
      failCount++;
    }
  }

  console.log(`\nDone. ${successCount} inserted successfully, ${failCount} failed.`);

  // ADDED: flush automatically so newly inserted entries become searchable
  // immediately, instead of depending on someone remembering to separately
  // run flushCollection.js. If this insert had zero successes, skip the
  // flush — nothing changed, no point flushing.
  if (successCount > 0) {
    console.log('\nFlushing collection so new entries become searchable...');
    try {
      await milvus.flush({ collection_names: [COLLECTION_NAME] });
      const stats = await milvus.getCollectionStatistics({ collection_name: COLLECTION_NAME });
      console.log(`Flush complete. Total row count: ${stats.data.row_count}`);
    } catch (flushErr) {
      console.error(`WARNING: Insert succeeded but flush failed: ${flushErr.message}`);
      console.error('New entries may not be searchable yet — run flushCollection.js manually.');
    }
  }
}

run().catch((err) => console.error('Fatal error:', err.message));