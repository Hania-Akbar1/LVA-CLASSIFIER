const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const storage = require('../services/storage/cloudStorage');
const { applyMaxRetentionRule } = require('../services/policyRouter');
const { extractText } = require('../services/textExtraction');
const { GoogleGenAI } = require('@google/genai');
const { MilvusClient } = require('@zilliz/milvus2-sdk-node');
require('dotenv').config();

const router = express.Router();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });


// MILVUS CONNECTION MANAGER


let milvusClientInstance = null;

function buildMilvusAddress() {
  let address = (process.env.MILVUS_ENDPOINT || '').trim().replace(/^https?:\/\//, '');
  if (!address.includes(':')) {
    address = `${address}:443`;
  }
  return address;
}

function createFreshMilvusClient() {
  return new MilvusClient({
    address: buildMilvusAddress(),
    token: process.env.MILVUS_TOKEN,
    ssl: true,
  });
}

function getMilvusClient() {
  if (!milvusClientInstance) {
    milvusClientInstance = createFreshMilvusClient();
  }
  return milvusClientInstance;
}

async function replaceDeadClient() {
  const dead = milvusClientInstance;
  milvusClientInstance = createFreshMilvusClient();
  if (dead && typeof dead.closeConnection === 'function') {
    try {
      await dead.closeConnection();
    } catch (_) {}
  }
  return milvusClientInstance;
}

function withTimeout(promise, ms, label = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function searchMilvusWithRetry(params, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = getMilvusClient();
    try {
      return await withTimeout(client.search(params), 8000, 'Milvus search');
    } catch (err) {
      lastErr = err;
      console.warn(`[MILVUS RECOVERY] Attempt ${attempt}/${maxAttempts} failed (${err.message})`);
      if (attempt < maxAttempts) {
        await replaceDeadClient();
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw lastErr;
}

function isValidStoredFilename(filename) {
  return /^[0-9a-f-]{36}\.[a-zA-Z0-9]{2,5}$/.test(filename);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = [
      '.pdf', '.docx', '.xls', '.xlsx',
      '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp',
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      return cb(new Error(`Unsupported file type: ${ext}. Allowed: PDF, DOCX, XLS, XLSX, JPG, JPEG, PNG, BMP, TIFF, TIF, WEBP. (Legacy .doc is not supported — please convert to .docx.)`));
    }
    cb(null, true);
  },
});


// ROUTES: FILE UPLOAD & MANAGEMENT


router.post('/', (req, res) => {
  upload.single('document')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Field name must be "document".' });
    }
    try {
      const ext = path.extname(req.file.originalname);
      const generatedFilename = `${uuidv4()}${ext}`;

      const saveStart = Date.now();
      const metadata = await storage.saveFile({
        filename: generatedFilename,
        originalName: req.file.originalname,
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
      });
      console.log(`[TIMING] File save to Supabase: ${Date.now() - saveStart}ms (size: ${req.file.buffer.length} bytes)`);

      res.status(201).json({
        message: 'Upload successful — processing text extraction in the background',
        document: metadata,
      });

      const EXTRACTION_TIMEOUT_MS = 30000;

      Promise.race([
        extractText(req.file.buffer, req.file.originalname),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Extraction timed out after 30s')), EXTRACTION_TIMEOUT_MS)
        ),
      ])
        .then(async (extractedText) => {
          try {
            await storage.updateExtractedText(generatedFilename, extractedText);
          } catch (updateErr) {
            console.error(`Failed to write extracted text for ${generatedFilename}:`, updateErr.message);
          }
        })
        .catch(async (extractErr) => {
          console.error(`Text extraction failed for ${generatedFilename}:`, extractErr.message);
          const fallback = `[This file could not be processed for text extraction. It may be corrupted or in an unsupported format. Technical detail: ${extractErr.message}]`;
          try {
            await storage.updateExtractedText(generatedFilename, fallback);
          } catch (updateErr) {
            console.error(`Failed to write fallback status for ${generatedFilename}:`, updateErr.message);
          }
        });
    } catch (saveErr) {
      console.error('[upload] Save failed:', saveErr);
      res.status(500).json({ error: 'Upload failed. Please try again.' });
    }
  });
});

router.get('/', async (req, res) => {
  try {
    const files = await storage.listFiles();
    res.json({ count: files.length, documents: files });
  } catch (err) {
    console.error('[list] Failed:', err);
    res.status(500).json({ error: 'Could not list files.' });
  }
});

router.get('/:filename/text', async (req, res) => {
  if (!isValidStoredFilename(req.params.filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    const result = await storage.getExtractedText(req.params.filename);

    if (result.status === 'not_found') {
      return res.status(404).json({ error: 'Text not found. Extraction may still be in progress.' });
    }
    if (result.status === 'corrupted') {
      return res.status(500).json({ error: 'Extracted text for this document is corrupted and could not be read.' });
    }

    res.json({ extractedText: result.text });
  } catch (err) {
    console.error('[text] Failed:', err);
    res.status(404).json({ error: 'File not found.' });
  }
});

router.get('/:filename/cloud-link', async (req, res) => {
  if (!isValidStoredFilename(req.params.filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    const url = await storage.getSignedUrl(req.params.filename);
    res.json({ url });
  } catch (err) {
    console.error('[cloud-link] Failed:', err);
    res.status(404).json({ error: 'File not found.' });
  }
});


// CHUNKING & EMBEDDING


const CHARS_PER_TOKEN_ESTIMATE = 3.2;
const MAX_TOKENS_PER_CHUNK = 1800;
const MAX_CHARS_PER_CHUNK = Math.floor(MAX_TOKENS_PER_CHUNK * CHARS_PER_TOKEN_ESTIMATE);
const CHUNK_OVERLAP_CHARS = 200;
const MAX_CHUNKS_TO_PROCESS = 40;
const EMBED_BATCH_SIZE = 20;
const SEARCH_BATCH_SIZE = 10;

function splitBySheet(text) {
  const parts = text.split(/(?=^--- Sheet: .+ ---$)/m).filter((p) => p.trim().length > 0);
  return parts.length > 1 ? parts : null;
}

function chunkSingleSegment(text) {
  if (text.length <= MAX_CHARS_PER_CHUNK) {
    return [text];
  }
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + MAX_CHARS_PER_CHUNK, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - CHUNK_OVERLAP_CHARS;
  }
  return chunks;
}

function chunkText(text) {
  const sheets = splitBySheet(text);
  if (!sheets) {
    return chunkSingleSegment(text);
  }
  return sheets.flatMap((sheet) => chunkSingleSegment(sheet));
}

async function embedChunkWithRetry(chunk, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: chunk,
        config: { outputDimensionality: 768, taskType: 'RETRIEVAL_QUERY' },
      });
    } catch (err) {
      lastErr = err;
      console.warn(`[EMBED RETRY] Attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  throw lastErr;
}

async function embedChunksWithConcurrencyLimit(chunks, batchSize = EMBED_BATCH_SIZE) {
  const results = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map((chunk) => embedChunkWithRetry(chunk))
    );
    results.push(...batchResults);
  }
  return results;
}


// CITATION EXTRACTION & RESOLUTION


function extractSelfCitation(text) {
  if (!text) return null;
  const pattern = /Per\s+(GS-\d+)[,\s]+(?:series\s+)?#?(\d+)/i;
  const match = text.match(pattern);
  if (!match) return null;
  return {
    scheduleNumber: match[1].toUpperCase(),
    seriesNumber: match[2],
  };
}

function normalizeId(s) {
  return (s || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function resolveCitationAgainstCandidates(citation, allMatchSets) {
  if (!citation) return null;
  const flatCandidates = allMatchSets.flat();
  return (
    flatCandidates.find(
      (c) =>
        normalizeId(c.scheduleNumber) === normalizeId(citation.scheduleNumber) &&
        normalizeId(c.seriesNumber) === normalizeId(citation.seriesNumber)
    ) || null
  );
}

function buildDirectMatchFromCitation(citedCandidate) {
  return {
    scheduleTitle: citedCandidate.scheduleTitle || null,
    scheduleNumber: citedCandidate.scheduleNumber,
    seriesTitle: citedCandidate.seriesTitle,
    seriesNumber: citedCandidate.seriesNumber,
    retentionPeriod: citedCandidate.retentionPeriod || 'Unknown',
    dispositionMethod: citedCandidate.dispositionMethod || 'Non-confidential Destruction',
    reasoningNote: `The document explicitly cites its own governing schedule ("${citedCandidate.scheduleNumber}, series ${citedCandidate.seriesNumber}"), which matches a record series loaded in this system. Matched directly from the citation rather than by semantic similarity.`,
    policyNote: null,
  };
}


// CONTRADICTION & REASONING PIPELINE


const NEGATION_PHRASES = [
  'none of the',
  'not among the candidate',
  'does not match',
  'do not match',
  'no candidate',
  'not accurately match',
  'not a genuine match',
  'is not among',
  'do not genuinely match',
  'does not genuinely match',
];

function reasoningContradictsMatch(reasoningResult) {
  if (!reasoningResult || !reasoningResult.finalMatch || !reasoningResult.reasoning) return false;
  const reasoningLower = reasoningResult.reasoning.toLowerCase();
  return NEGATION_PHRASES.some((phrase) => reasoningLower.includes(phrase));
}

function sanitizeReasoningText(reasoning) {
  if (!reasoning) return null;
  let text = reasoning
    .replace(/(?:,?\s*requiring|\s*and\s*requiring|\s*requiring\s+the\s+more\s+conservative|\s*resulting\s+in\s+a\s+retention).*$/i, '')
    .replace(/,?\s*which\s+requires\s+the\s+more\s+conservative.*$/i, '')
    .replace(/,?\s*and\s+touches\s+[^.]+?requiring.*$/i, '')
    .trim();

  if (text.length > 0 && !/[.!?]$/.test(text)) {
    text += '.';
  }
  return text;
}

const REASONING_TIMEOUT_MS = 20000;

async function classifyWithReasoning(extractedText, allMatchSets, originalIndices, totalChunks) {
  const perChunkSummary = allMatchSets
    .map((matchSet, i) => {
      const top = matchSet[0];
      const realChunkNum = originalIndices[i] + 1;
      if (!top) return `Chunk ${realChunkNum} of ${totalChunks}: no match found`;
      return `Chunk ${realChunkNum} of ${totalChunks}: "${top.seriesTitle}" (${top.scheduleNumber}, #${top.seriesNumber}) — similarity score ${top.score.toFixed(3)}`;
    })
    .join('\n');

  const uniqueCandidates = new Map();
  for (const matchSet of allMatchSets) {
    for (const m of matchSet) {
      const key = `${m.scheduleNumber}-${m.seriesNumber}`;
      if (!uniqueCandidates.has(key)) uniqueCandidates.set(key, m);
    }
  }

  const candidatesText = Array.from(uniqueCandidates.values())
    .map(
      (m, i) =>
        `${i + 1}. "${m.seriesTitle}" (${m.scheduleNumber}, #${m.seriesNumber}) — ${m.retentionPeriod}, ${m.dispositionMethod}\n   Description: ${m.seriesDescription || '(no description available for this candidate)'}`
    )
    .join('\n');

  const prompt = `You are helping classify a government document against a records retention schedule. This document was split into ${totalChunks} chunk(s) for processing; ${allMatchSets.length} of those chunks were successfully searched (some may have failed to process and are not represented below).

PER-CHUNK SEARCH RESULTS (this tells you what different SECTIONS of the document matched — chunk numbers reflect their real position in the document, not a re-numbered sequence):
${perChunkSummary}

FULL DOCUMENT TEXT (may be truncated):
"""
${extractedText.slice(0, 6000)}
"""

ALL CANDIDATE RECORD SERIES FOUND ACROSS THE DOCUMENT (ranked by vector similarity — NOT necessarily correct). Each candidate includes its full description — READ THE DESCRIPTION, not just the title, since two series can have similar-sounding titles but cover completely different kinds of records:
${candidatesText}

CRITICAL FIRST CHECK — perform this before anything else: Does this document represent a genuine organizational/government record, or is it completely unrelated (e.g., a personal CV/resume, a recipe, placeholder text, or gibberish)? If it is a personal document or otherwise lacks genuine relevance to organizational records, you MUST set "finalMatch" to null and explain why in "reasoning" — regardless of what the similarity search returned. A high similarity score to a candidate does NOT mean the document is an official record; the search only measures word patterns, not whether the document has genuine meaning. NEVER select a candidate "by default" just because it was the closest match.

STRUCTURED VERDICT REQUIREMENT: before writing "reasoning", first decide internally whether the top candidate's DESCRIPTION (not title) genuinely covers what this document actually is. Record that decision in the "descriptionGenuinelyMatches" field. Your "reasoning" text must be consistent with whatever you put in that field — if "descriptionGenuinelyMatches" is false, "finalMatch" MUST be null.

CRITICAL ALIGNMENT REQUIREMENT: Your "finalMatch" MUST be the exact category whose description you are defending and citing in your "reasoning" text. Do NOT assign one category as "finalMatch" and then write your "reasoning" text explaining why the document matches a completely different category.

1. Read the full document and the per-chunk results, and identify every category it genuinely touches.
2. Choose ONE final series that reflects the document's DOMINANT purpose (the main reason the record exists) and put it as "finalMatch".
3. If more than one category is genuinely involved, list them in "otherRelevantCategories".
4. If nothing genuinely matches any candidate, say so.

GROUNDING REQUIREMENT for your "reasoning" field: every claim you make must be traceable to actual wording in the document text above — do not write a general summary or paraphrase from memory. Where possible, reference a short, specific phrase that actually appears in the document.

STRICT RULE FOR REASONING FIELD: Your reasoning text must focus SOLELY on why the document's subject matter matches the series scope based on its text. NEVER discuss, restate, justify, or mention retention periods, disposition methods, or rule calculations in "reasoning" — those policy values are computed separately and deterministically outside your control.

Respond ONLY with valid JSON, no other text, in this exact format:
{
  "descriptionGenuinelyMatches": <true or false>,
  "touchesMultipleCategories": <true or false>,
  "finalMatch": {
    "seriesTitle": "<exact title from the candidate list — the PRIMARY/dominant category>",
    "scheduleNumber": "<exact schedule>",
    "seriesNumber": "<exact number>",
    "confidence": "<high|medium|low>",
    "effectiveRetentionPeriod": "<the retention period to actually apply>",
    "effectiveDispositionMethod": "<the disposition method to actually apply>"
  },
  "otherRelevantCategories": [
    { "seriesTitle": "<title>", "scheduleNumber": "<schedule>", "seriesNumber": "<number>" }
  ],
  "reasoning": "<1-3 sentences explaining WHY this category semantically matches the document's actual content — reference specific document wording. Do NOT explain, justify, or restate retention periods or disposition methods. If nothing matches, explain why here instead.>"
}
If nothing genuinely matches any candidate, set "finalMatch" to null, leave "otherRelevantCategories" empty, and explain why in "reasoning".`;

  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await withTimeout(
        ai.models.generateContent({
          model: 'gemini-3.5-flash-lite',
          contents: prompt,
          config: { temperature: 0 },
        }),
        REASONING_TIMEOUT_MS,
        'Reasoning call'
      );

      const responseText = result.text.trim();
      const cleaned = responseText.replace(/^```json\s*|\s*```$/g, '');
      const parsed = JSON.parse(cleaned);
      parsed._uniqueCandidates = Array.from(uniqueCandidates.values());

      if (reasoningContradictsMatch(parsed)) {
        console.warn(
          `[classify] Reasoning contradicts finalMatch — overriding to null. Reasoning: "${parsed.reasoning}"`
        );
        parsed.finalMatch = null;
        parsed.otherRelevantCategories = [];
      }

      if (parsed.descriptionGenuinelyMatches === false && parsed.finalMatch) {
        console.warn(
          `[classify] descriptionGenuinelyMatches=false but finalMatch was populated — overriding to null. Reasoning: "${parsed.reasoning}"`
        );
        parsed.finalMatch = null;
        parsed.otherRelevantCategories = [];
      }

      return parsed;
    } catch (err) {
      console.error(`Reasoning step failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  return null;
}


// ROUTE: CLASSIFY DOCUMENT


router.get('/:filename/classify', async (req, res) => {
  if (!isValidStoredFilename(req.params.filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const totalStart = Date.now();

  try {
    const textStart = Date.now();
    const textResult = await storage.getExtractedText(req.params.filename);

    console.log(`[TIMING classify] getExtractedText: ${Date.now() - textStart}ms`);

    if (textResult.status === 'not_found') {
      return res.status(409).json({ error: 'This document is still being processed. Please try again in a few seconds.' });
    }
    if (textResult.status === 'corrupted') {
      return res.status(500).json({ error: 'This document\'s extracted text is corrupted and cannot be classified. Please re-upload the document.' });
    }

    const extractedText = textResult.text;

    if (
      extractedText.startsWith('[OCR failed') ||
      extractedText.startsWith('[This file could not be processed') ||
      extractedText.startsWith('[EXTRACTION_FAILED]')
    ) {
      return res.status(400).json({ error: 'This document could not be read correctly, so it cannot be classified.' });
    }

    let chunks = chunkText(extractedText);
    if (chunks.length > MAX_CHUNKS_TO_PROCESS) {
      console.warn(`Document produced ${chunks.length} chunk(s) — capping at ${MAX_CHUNKS_TO_PROCESS}`);
      chunks = chunks.slice(0, MAX_CHUNKS_TO_PROCESS);
    }

    console.log(`[TIMING classify] Document split into ${chunks.length} chunk(s)`);

    const embedStart = Date.now();
    const embedSettled = await embedChunksWithConcurrencyLimit(chunks);

    const embedResultsWithIndex = embedSettled
      .map((r, i) => ({ ...r, originalIndex: i }))
      .filter((r) => r.status === 'fulfilled');
    const embedResults = embedResultsWithIndex.map((r) => r.value);
    const originalIndices = embedResultsWithIndex.map((r) => r.originalIndex);

    const failedCount = embedSettled.length - embedResults.length;
    if (failedCount > 0) {
      console.warn(`${failedCount} of ${chunks.length} chunk(s) failed to embed (after retry) — continuing with the rest`);
    }
    if (embedResults.length === 0) {
      return res.status(500).json({ error: 'All document chunks failed to embed. Please try again.' });
    }

    console.log(`[TIMING classify] Gemini embedding (${chunks.length} chunk(s), batched): ${Date.now() - embedStart}ms`);

    const searchStart = Date.now();
    const searchResults = [];
    for (let i = 0; i < embedResults.length; i += SEARCH_BATCH_SIZE) {
      const batch = embedResults.slice(i, i + SEARCH_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((embedResult) => {
          const queryEmbedding = embedResult.embeddings[0].values;
          return searchMilvusWithRetry({
            collection_name: 'lva_record_series',
            vector: queryEmbedding,
            limit: 3,
            output_fields: [
              'schedule_title',
              'schedule_number',
              'series_title',
              'series_number',
              'series_description',
              'retention_period',
              'disposition_method',
            ],
          });
        })
      );
      searchResults.push(...batchResults);
    }

    console.log(`[TIMING classify] Milvus search (${chunks.length} chunk(s), batched ${SEARCH_BATCH_SIZE}/batch): ${Date.now() - searchStart}ms`);

    const allMatchSets = searchResults.map((result) =>
      result.results.map((r) => ({
        scheduleTitle: r.schedule_title,
        scheduleNumber: r.schedule_number,
        seriesTitle: r.series_title,
        seriesNumber: r.series_number,
        seriesDescription: r.series_description,
        retentionPeriod: r.retention_period,
        dispositionMethod: r.disposition_method,
        score: r.score,
      }))
    );

    let bestMatches = allMatchSets[0];
    let bestTopScore = bestMatches[0]?.score ?? -Infinity;
    for (const matchSet of allMatchSets) {
      const topScore = matchSet[0]?.score ?? -Infinity;
      if (topScore > bestTopScore) {
        bestTopScore = topScore;
        bestMatches = matchSet;
      }
    }

    // SELF-CITATION CHECK
    const citation = extractSelfCitation(extractedText);
    if (citation) {
      const citedCandidate = resolveCitationAgainstCandidates(citation, allMatchSets);

      if (!citedCandidate) {
        console.log(`[classify] Document cites ${citation.scheduleNumber} #${citation.seriesNumber}, not found among retrieved candidates.`);
        return res.json({
          matches: [],
          noConfidentMatch: true,
          message: `This document cites its own governing schedule (${citation.scheduleNumber}, series ${citation.seriesNumber}), but that exact schedule/series is not currently loaded in this system. The correct classification may be missing from the indexed data — this needs manual review rather than a substitute match.`,
          closestGuesses: bestMatches,
          chunksProcessed: chunks.length,
        });
      }

      console.log(`[classify] Document cites ${citation.scheduleNumber} #${citation.seriesNumber}, resolved directly against an indexed candidate — skipping LLM reasoning call.`);
      const finalMatchCard = buildDirectMatchFromCitation(citedCandidate);
      console.log(`[TIMING classify] TOTAL (citation shortcut): ${Date.now() - totalStart}ms`);
      return res.json({
        matches: [finalMatchCard],
        touchesMultipleCategories: false,
        relatedCategories: [],
        alsoConsidered: [],
        chunksProcessed: chunks.length,
      });
    }

    const CONFIDENCE_FLOOR = 0.65;
    if (bestTopScore < CONFIDENCE_FLOOR) {
      console.log(`[classify] Rejected by vector score: ${bestTopScore} < ${CONFIDENCE_FLOOR}`);
      return res.json({
        matches: [],
        noConfidentMatch: true,
        message: 'This document does not appear to match any of the currently loaded record retention schedules with sufficient confidence.',
        closestGuesses: bestMatches,
        chunksProcessed: chunks.length,
      });
    }

    

    // REASONING STEP
    const reasoningStart = Date.now();
    const reasoningResult = await classifyWithReasoning(extractedText, allMatchSets, originalIndices, chunks.length);

    console.log(`[TIMING classify] Reasoning step: ${Date.now() - reasoningStart}ms`);
    console.log('[REASONING RESULT]', JSON.stringify(reasoningResult, null, 2));

    console.log(`[TIMING classify] TOTAL: ${Date.now() - totalStart}ms`);

    if (reasoningResult) {
      if (!reasoningResult.finalMatch) {
        return res.json({
          matches: [],
          noConfidentMatch: true,
          message: 'This document does not appear to match any of the currently loaded record retention schedules with sufficient confidence.',
          closestGuesses: bestMatches,
          reasoningNote: sanitizeReasoningText(reasoningResult.reasoning) || null,
          chunksProcessed: chunks.length,
        });
      }

      const allCandidates = reasoningResult._uniqueCandidates || [];

      const touchedCategories = [reasoningResult.finalMatch, ...(reasoningResult.otherRelevantCategories || [])]
        .map((c) => {
          const full = allCandidates.find(
            (cand) =>
              normalizeId(cand.scheduleNumber) === normalizeId(c.scheduleNumber) &&
              normalizeId(cand.seriesNumber) === normalizeId(c.seriesNumber)
          );
          return full ? { ...full, seriesTitle: c.seriesTitle || full.seriesTitle } : null;
        })
        .filter(Boolean);

      if (touchedCategories.length === 0) {
        console.warn(
          `[classify] Model proposed ${reasoningResult.finalMatch.scheduleNumber}-${reasoningResult.finalMatch.seriesNumber} ("${reasoningResult.finalMatch.seriesTitle}"), which does not match any retrieved candidate. Rejecting hallucinated match.`
        );
        return res.json({
          matches: [],
          noConfidentMatch: true,
          message: 'The classifier proposed a match that could not be verified against the indexed retention schedules. This document needs manual review — it may belong to a schedule that has not yet been loaded into this system.',
          closestGuesses: bestMatches,
          chunksProcessed: chunks.length,
        });
      }

      // ADDED: ambiguity detection. Some GS-17 offense categories share
      // nearly identical descriptions with no distinguishing detail in the
      // schedule itself (confirmed against the real GS-17 source text).
      // When the top two touched candidates score this close, the LLM's
      // "confidence: high" is not trustworthy — surface this honestly
      // instead of silently picking one.
      const AMBIGUITY_SCORE_MARGIN = 0.02; // tune based on more real test data

      const sortedByScore = [...touchedCategories].sort(
        (a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)
      );

      let isAmbiguous = false;
      if (sortedByScore.length >= 2) {
        const topScoreGap = (sortedByScore[0].score ?? -Infinity) - (sortedByScore[1].score ?? -Infinity);
        if (topScoreGap < AMBIGUITY_SCORE_MARGIN) {
          isAmbiguous = true;
        }
      }

      if (isAmbiguous) {
        const [topCandidate, secondCandidate] = sortedByScore;
        const safetyPolicy = applyMaxRetentionRule([topCandidate, secondCandidate]) || topCandidate;

        console.warn(
          `[classify] Ambiguous match: "${topCandidate.seriesTitle}" (${topCandidate.score?.toFixed(4)}) ` +
          `vs "${secondCandidate.seriesTitle}" (${secondCandidate.score?.toFixed(4)}) — gap too small to trust automatically.`
        );

        return res.json({
          matches: [],
          ambiguousMatch: true,
          message: 'This document scored nearly identically against two different record series, which the underlying schedule does not clearly distinguish based on document content alone. Manual review is required to determine the correct classification.',
          candidateOptions: sortedByScore.slice(0, 2).map((c) => ({
            scheduleTitle: c.scheduleTitle,
            scheduleNumber: c.scheduleNumber,
            seriesTitle: c.seriesTitle,
            seriesNumber: c.seriesNumber,
            retentionPeriod: c.retentionPeriod,
            dispositionMethod: c.dispositionMethod,
            score: c.score,
          })),
          safetyRetentionPeriod: safetyPolicy?.retentionPeriod || 'Unknown',
          safetyDispositionMethod: safetyPolicy?.dispositionMethod || 'Unknown',
          reasoningNote: sanitizeReasoningText(reasoningResult.reasoning) || null,
          chunksProcessed: chunks.length,
        });
      }

      const primaryCitedInReasoning = touchedCategories.find((c) =>
        reasoningResult.reasoning.toLowerCase().includes(c.seriesTitle.toLowerCase())
      );

      const chosenPrimaryCandidate = primaryCitedInReasoning || touchedCategories[0];
      const governingPolicy = applyMaxRetentionRule(touchedCategories) || chosenPrimaryCandidate;
      const cleanedReasoningNote = sanitizeReasoningText(reasoningResult.reasoning);

      const finalMatchCard = {
        scheduleTitle: governingPolicy?.scheduleTitle || chosenPrimaryCandidate.scheduleTitle || null,
        scheduleNumber: chosenPrimaryCandidate.scheduleNumber,
        seriesTitle: chosenPrimaryCandidate.seriesTitle,
        seriesNumber: chosenPrimaryCandidate.seriesNumber,
        retentionPeriod: governingPolicy?.retentionPeriod || chosenPrimaryCandidate.retentionPeriod || 'Unknown',
        dispositionMethod: governingPolicy?.dispositionMethod || chosenPrimaryCandidate.dispositionMethod || 'Unknown',
        reasoningNote: cleanedReasoningNote || null,
        policyNote: null,
      };

      const relatedCategoriesEnriched = touchedCategories
        .filter(
          (c) =>
            !(
              normalizeId(c.scheduleNumber) === normalizeId(chosenPrimaryCandidate.scheduleNumber) &&
              normalizeId(c.seriesNumber) === normalizeId(chosenPrimaryCandidate.seriesNumber)
            )
        )
        .map((c) => ({
          seriesTitle: c.seriesTitle,
          scheduleNumber: c.scheduleNumber,
          seriesNumber: c.seriesNumber,
        }));

      return res.json({
        matches: [finalMatchCard],
        touchesMultipleCategories: !!reasoningResult.touchesMultipleCategories || relatedCategoriesEnriched.length > 0,
        relatedCategories: relatedCategoriesEnriched,
        alsoConsidered: relatedCategoriesEnriched,
        chunksProcessed: chunks.length,
      });
    }

    console.error('[classify] Reasoning failed after retries — returning an error instead of an unvalidated vector-only match.');
    return res.status(503).json({
      error: 'Classification could not be completed right now — the reasoning service did not respond correctly after retrying. Please try again in a moment.',
    });
  } catch (err) {
    console.log(`[TIMING classify] FAILED after: ${Date.now() - totalStart}ms`);
    console.error('[classify] Internal error:', err);
    res.status(500).json({ error: 'Classification failed. Please try again or contact support if this persists.' });
  }
});

router.get('/:filename/download', async (req, res) => {
  if (!isValidStoredFilename(req.params.filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    const buffer = await storage.downloadFile(req.params.filename);
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[download] Failed:', err);
    res.status(404).json({ error: 'File not found.' });
  }
});

router.delete('/:filename', async (req, res) => {
  if (!isValidStoredFilename(req.params.filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    console.log(`[DELETE] Attempting to delete: ${req.params.filename}`);
    await storage.deleteFile(req.params.filename);
    console.log(`[DELETE] Successfully deleted: ${req.params.filename}`);
    res.json({ message: 'File deleted', filename: req.params.filename });
  } catch (err) {
    console.error(`[DELETE] Failed to delete ${req.params.filename}:`, err);
    res.status(404).json({ error: 'File not found.' });
  }
});

module.exports = router;