const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const BUCKET_NAME = 'lva-document';
const LEGACY_METADATA_FILE = '_metadata.json';

function metaFilePath(filename) { return `meta/${filename}.json`; }
function textFilePath(filename) { return `text/${filename}.json`; }

async function run() {
  console.log('Downloading legacy _metadata.json...');
  const { data: legacyBlob, error: dlErr } = await supabase.storage.from(BUCKET_NAME).download(LEGACY_METADATA_FILE);
  if (dlErr || !legacyBlob) { console.log('No legacy metadata file found — nothing to migrate.'); return; }

  const legacyMetadata = JSON.parse(await legacyBlob.text());
  const filenames = Object.keys(legacyMetadata);
  console.log(`Found ${filenames.length} legacy document(s) to migrate.`);

  const { data: bucketList, error: listErr } = await supabase.storage.from(BUCKET_NAME).list();
  if (listErr) throw new Error(`Could not list bucket: ${listErr.message}`);
  const sizeByFilename = Object.fromEntries(bucketList.map((f) => [f.name, f.metadata?.size ?? 0]));

  let migrated = 0, failed = 0;
  for (const filename of filenames) {
    const old = legacyMetadata[filename];
    try {
      const newMeta = { originalName: old.originalName || filename, uploadedAt: old.uploadedAt || new Date().toISOString(), size: sizeByFilename[filename] ?? 0, status: old.status || 'ready' };
      const { error: metaErr } = await supabase.storage.from(BUCKET_NAME).upload(metaFilePath(filename), Buffer.from(JSON.stringify(newMeta, null, 2)), { contentType: 'application/json', upsert: true });
      if (metaErr) throw new Error(`meta write failed: ${metaErr.message}`);

      if (old.extractedText) {
        const { error: textErr } = await supabase.storage.from(BUCKET_NAME).upload(textFilePath(filename), Buffer.from(JSON.stringify({ extractedText: old.extractedText }, null, 2)), { contentType: 'application/json', upsert: true });
        if (textErr) throw new Error(`text write failed: ${textErr.message}`);
      }
      console.log(`  OK: ${filename} (${newMeta.originalName})`);
      migrated++;
    } catch (err) {
      console.error(`  FAILED: ${filename}: ${err.message}`);
      failed++;
    }
  }
  console.log(`\nDone. Migrated: ${migrated}, Failed: ${failed}`);
}

run().catch((err) => { console.error('Migration script crashed:', err); process.exit(1); });