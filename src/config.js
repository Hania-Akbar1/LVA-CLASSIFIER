require('dotenv').config();
const path = require('path');

// ADDED: fail fast at startup if required config is missing, instead of
// failing later with a confusing error on the first request that needs it.
const REQUIRED_VARS = ['MILVUS_ENDPOINT', 'MILVUS_TOKEN', 'GEMINI_API_KEY', 'SUPABASE_URL'];
const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`FATAL: Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('Server cannot start without these. Check your .env file.');
  process.exit(1);
}

if (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_KEY) {
  console.error('FATAL: No Supabase key found. Set SUPABASE_SECRET_KEY, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_KEY.');
  process.exit(1);
}

module.exports = {
  port: process.env.PORT || 3000,
  storageProvider: process.env.STORAGE_PROVIDER || 'local',
  uploadsDir: path.join(__dirname, '..', 'uploads'),

  // ADDED: centralized tuning constants for the fixes we're making.
  // Not yet wired into every file — upload.js and textExtraction.js
  // still use their own local constants for now. This is here so new
  // code (and future migration) has one place to read these from.
  confidenceFloor: 0.65,
  reasoningTimeoutMs: 20000,
  ocrConcurrencyLimit: 3,
};