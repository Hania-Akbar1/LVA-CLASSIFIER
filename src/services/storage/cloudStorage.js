const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase credentials in environment variables.');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const BUCKET_NAME = 'lva-document';

function metaFilePath(filename) {
  return `meta/${filename}.json`;
}

function textFilePath(filename) {
  return `text/${filename}.json`;
}

async function readOwnMetadata(filename) {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .download(metaFilePath(filename));
  if (error || !data) return null;
  try {
    const text = await data.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeOwnMetadata(filename, meta) {
  const json = JSON.stringify(meta, null, 2);
  const blob = Buffer.from(json, 'utf-8');
  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(metaFilePath(filename), blob, {
      contentType: 'application/json',
      upsert: true,
    });
  if (error) {
    throw new Error(`Could not save metadata: ${error.message}`);
  }
}

async function saveFile(file) {
  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(file.filename, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });
  if (error) {
    throw new Error(`Cloud upload failed: ${error.message}`);
  }

  const uploadedAt = new Date().toISOString();
  const meta = {
    originalName: file.originalName,
    uploadedAt,
    size: file.buffer.length,
    status: 'processing',
  };

  // CHANGED: if the metadata write fails after the file upload succeeded,
  // we now surface that clearly instead of leaving an orphaned file with no
  // tracked metadata. We don't attempt to delete the just-uploaded file
  // automatically (that's its own failure mode) — we throw so the caller
  // knows this upload did not fully succeed.
  try {
    await writeOwnMetadata(file.filename, meta);
  } catch (metaErr) {
    throw new Error(
      `File was uploaded but metadata could not be saved (${metaErr.message}). ` +
      `The file "${file.filename}" may now be orphaned in storage — manual cleanup may be required.`
    );
  }

  return {
    filename: file.filename,
    originalName: file.originalName,
    size: file.buffer.length,
    uploadedAt,
    status: 'processing',
  };
}

async function listFiles() {
  // Increase limit beyond Supabase's default page size of 100
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .list('', { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });

  if (error) {
    throw new Error(`Could not list cloud files: ${error.message}`);
  }

  const documentFiles = data.filter(
    (item) =>
      item.id !== null &&
      item.metadata !== null &&
      item.name !== 'meta' &&
      item.name !== 'text' &&
      item.name !== '.emptyFolderPlaceholder'
  );

  const results = await Promise.all(
    documentFiles.map(async (item) => {
      const meta = await readOwnMetadata(item.name);
      return {
        filename: item.name,
        originalName: meta?.originalName || item.name,
        size: meta?.size ?? item.metadata?.size ?? 0,
        uploadedAt: meta?.uploadedAt || item.created_at,
        status: meta?.status || 'ready',
      };
    })
  );

  return results;
}

async function updateExtractedText(filename, extractedText) {
  const json = JSON.stringify({ extractedText }, null, 2);
  const blob = Buffer.from(json, 'utf-8');
  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(textFilePath(filename), blob, {
      contentType: 'application/json',
      upsert: true,
    });
  if (error) {
    throw new Error(`Could not save extracted text: ${error.message}`);
  }

  let existingMeta = await readOwnMetadata(filename);
  if (!existingMeta) {
    existingMeta = {
      originalName: filename,
      uploadedAt: new Date().toISOString(),
      size: 0,
    };
  }
  existingMeta.status = 'ready';
  await writeOwnMetadata(filename, existingMeta);
}

// CHANGED: previously returned a single `null` for three different
// situations (still processing / corrupted data / transient download
// error), which meant a permanently corrupted file would retry forever
// with a "still processing" message and no way to surface that it was
// actually broken. Now returns a status so the caller can tell these apart.
//
// Return shape:
//   { status: 'ok', text: '<extracted text>' }
//   { status: 'not_found' }   -> extraction hasn't finished yet, or file doesn't exist
//   { status: 'corrupted' }   -> the stored text file exists but is malformed/unreadable
async function getExtractedText(filename) {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .download(textFilePath(filename));

  if (error || !data) {
    return { status: 'not_found' };
  }

  try {
    const text = await data.text();
    const parsed = JSON.parse(text);
    if (typeof parsed.extractedText !== 'string') {
      return { status: 'corrupted' };
    }
    return { status: 'ok', text: parsed.extractedText };
  } catch {
    return { status: 'corrupted' };
  }
}

async function getSignedUrl(filename) {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(filename, 60);
  if (error) {
    throw new Error(`Could not create link: ${error.message}`);
  }
  return data.signedUrl;
}

async function downloadFile(filename) {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .download(filename);
  if (error) {
    throw new Error(`Download failed: ${error.message}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function deleteFile(filename) {
  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .remove([filename, textFilePath(filename), metaFilePath(filename)]);
  if (error) {
    throw new Error(`Cloud delete failed: ${error.message}`);
  }
}

module.exports = {
  saveFile,
  listFiles,
  deleteFile,
  getExtractedText,
  downloadFile,
  getSignedUrl,
  updateExtractedText,
};