const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const PizZip = require('pizzip');
require('dotenv').config();

const PDFIMAGES_PATH = process.env.PDFIMAGES_PATH;
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp'];

// ADDED: cap on how many images we OCR concurrently. Running all embedded
// images through Tesseract at once (previously unbounded Promise.all) spiked
// CPU hard and was a likely cause of inconsistent classification speed —
// especially for documents with many embedded images/logos/stamps.
const OCR_CONCURRENCY_LIMIT = 3;

/**
 * Clean extracted text while preserving critical punctuation,
 * schedule numbers, and structured bullet points.
 */
function cleanExtractedText(text) {
  if (!text) return text;
  return text
    .replace(/\[OCR completed but no text was detected\]/gi, '')
    .replace(/\[OCR failed:[^\]]+\]/gi, '')
    .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, '')
    .replace(/page\s+\d+\s+of\s+\d+/gi, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * Enhanced image preprocessing for OCR (Logos, stamps, small text)
 */
async function preprocessImageForOcr(buffer) {
  try {
    return await sharp(buffer)
      .resize({ width: 2500, height: 2500, fit: 'inside', withoutEnlargement: true })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
  } catch (err) {
    throw new Error(`Image preprocessing failed: ${err.message}`);
  }
}

/**
 * Run OCR on image buffers using Tesseract with preprocessed image.
 * CHANGED: now creates an explicit worker instead of using the one-shot
 * Tesseract.recognize() convenience call, so that on timeout we can actually
 * terminate() the worker instead of leaving it running in the background
 * consuming CPU after we've already moved on.
 */
async function extractWithOcr(buffer, originalName) {
  let worker = null;
  try {
    const processedBuffer = await preprocessImageForOcr(buffer);
    console.log(`Running local OCR on ${originalName}...`);

    worker = await Tesseract.createWorker('eng');

    const result = await Promise.race([
      worker.recognize(processedBuffer),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('OCR processing timed out')), 15000)
      ),
    ]);

    await worker.terminate();
    worker = null;

    return result.data.text.trim() || '[OCR completed but no text was detected]';
  } catch (ocrErr) {
    // ADDED: actually kill the worker on timeout/failure so it stops
    // consuming CPU in the background instead of running to completion
    // uselessly after we've already given up on it.
    if (worker) {
      try {
        await worker.terminate();
      } catch (_) {}
    }
    const message = ocrErr?.message || 'Unknown OCR failure';
    console.error(`OCR failed on ${originalName}:`, message);
    return `[OCR failed: ${message}]`;
  }
}

// ADDED: run a list of images through an OCR function in small concurrent
// batches instead of all at once. Same batching pattern already used for
// embeddings in upload.js — applying it here too for consistency.
async function runOcrBatched(images, namePrefix, concurrency = OCR_CONCURRENCY_LIMIT) {
  const results = [];
  for (let i = 0; i < images.length; i += concurrency) {
    const batch = images.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((img, idx) => extractWithOcr(img.data, `${namePrefix}-${i + idx + 1}.png`))
    );
    results.push(...batchResults);
  }
  return results;
}

function getImagePageNumbers(pdfPath) {
  return new Promise((resolve) => {
    if (!PDFIMAGES_PATH || !fs.existsSync(PDFIMAGES_PATH)) {
      return resolve([]);
    }
    execFile(PDFIMAGES_PATH, ['-list', pdfPath], { timeout: 15000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const lines = stdout.split('\n').slice(2);
      const pageNumbers = lines
        .map((line) => {
          const match = line.trim().match(/^(\d+)/);
          return match ? parseInt(match[1], 10) : null;
        })
        .filter((p) => p !== null);
      resolve(pageNumbers);
    });
  });
}

function extractImagesWithPdfimages(pdfBuffer) {
  return new Promise((resolve) => {
    if (!PDFIMAGES_PATH || !fs.existsSync(PDFIMAGES_PATH)) {
      console.warn('PDFIMAGES_PATH not set or binary not found. Skipping embedded PDF image extraction.');
      return resolve([]);
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfimg-'));
    const tempPdfPath = path.join(tempDir, 'input.pdf');
    fs.writeFileSync(tempPdfPath, pdfBuffer);
    const outputPrefix = path.join(tempDir, 'img');

    // CHANGED: added a timeout so a hung pdfimages process can't hang the
    // whole request indefinitely.
    execFile(PDFIMAGES_PATH, ['-png', tempPdfPath, outputPrefix], { timeout: 20000 }, async (err) => {
      if (err) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        return resolve([]);
      }
      try {
        const pageNumbers = await getImagePageNumbers(tempPdfPath);
        const files = fs.readdirSync(tempDir).filter((f) => f.startsWith('img') && f.endsWith('.png'));
        const images = files.map((f, i) => ({
          data: fs.readFileSync(path.join(tempDir, f)),
          page: pageNumbers[i] || null,
        }));
        fs.rmSync(tempDir, { recursive: true, force: true });
        resolve(images);
      } catch (readErr) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        resolve([]);
      }
    });
  });
}

function isValidPdfSignature(buffer) {
  if (!buffer || buffer.length < 8) return false;
  const header = buffer.slice(0, 8).toString('latin1');
  return header.startsWith('%PDF-');
}

/**
 * PDF Extraction: Digital text parsing with entire coordinate stream + OCR fallback
 */
async function extractFromPdf(buffer) {
  const extractionStart = Date.now();
  let output = '';
  let digitalParsingFailed = false;
  let parseErrorMessage = '';

  try {
    const parser = new PDFParse({ data: buffer });
    try {
      const data = await parser.getText();
      if (data?.text) {
        output += data.text + '\n';
      }
    } catch (pdfErr) {
      digitalParsingFailed = true;
      parseErrorMessage = pdfErr.message;
      console.error('Digital PDF text parsing failed:', pdfErr.message);
    } finally {
      if (typeof parser.destroy === 'function') {
        await parser.destroy();
      }
    }
  } catch (initErr) {
    digitalParsingFailed = true;
    parseErrorMessage = initErr.message;
    console.error('PDF parser initialization failed:', initErr.message);
  }

  // Extract embedded images/logos if binary configured
  const images = await extractImagesWithPdfimages(buffer);
  const MIN_IMAGE_BYTES = 500;
  const MAX_IMAGES_TO_PROCESS = 25;

  const seenHashes = new Set();
  const uniqueImages = images.filter((img) => {
    const hash = crypto.createHash('md5').update(img.data).digest('hex');
    if (seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    return true;
  });

  const significantImages = uniqueImages
    .filter((img) => img.data.length >= MIN_IMAGE_BYTES)
    .sort((a, b) => b.data.length - a.data.length)
    .slice(0, MAX_IMAGES_TO_PROCESS);

  // ADDED: if there's no usable digital text AND no images were found at
  // all, we can't tell "this PDF is genuinely blank" apart from "pdfimages
  // is missing/misconfigured and silently returned nothing". Either way, we
  // should not let this proceed to classification as if extraction
  // succeeded — throw here so the document gets flagged for manual review
  // instead of being classified against near-empty text.
  if (!output.trim() && significantImages.length === 0) {
    throw new Error(
      'No digital text found and no embedded images could be extracted. ' +
      'This may be a scanned document that could not be processed — verify PDFIMAGES_PATH is correctly configured.'
    );
  }

  if (significantImages.length > 0) {
    console.log(`Running OCR on ${significantImages.length} unique embedded image(s)...`);
    // CHANGED: batched instead of firing all images through OCR at once.
    const ocrResults = await runOcrBatched(significantImages, 'pdf-embedded-image');

    ocrResults.forEach((ocrText) => {
      if (ocrText && !ocrText.includes('[OCR completed but no text was detected]') && !ocrText.includes('[OCR failed')) {
        output += '\n[Embedded Image/Logo Text]:\n' + ocrText + '\n';
      }
    });
  }

  // If digital parsing failed completely and no OCR text was recovered, throw an explicit structure error
  if (digitalParsingFailed && !output.trim()) {
    throw new Error(`Invalid PDF structure: ${parseErrorMessage || 'Unable to parse document.'}`);
  }

  console.log(`[TIMING] PDF full extraction complete: ${Date.now() - extractionStart}ms`);
  return output;
}

/**
 * Extracts raw XML strings from docx headers and footers via PizZip
 */
function extractDocxHeaderFooterText(buffer) {
  try {
    const zip = new PizZip(buffer);
    let extractedText = '';

    Object.keys(zip.files).forEach((fileName) => {
      if (fileName.match(/^word\/(header|footer)\d+\.xml$/i)) {
        const xmlContent = zip.files[fileName].asText();
        const textMatches = xmlContent.match(/<w:t[^>]*>(.*?)<\/w:t>/g);
        if (textMatches) {
          const plainText = textMatches
            .map((val) => val.replace(/<[^>]+>/g, '').trim())
            .filter(Boolean)
            .join(' ');
          if (plainText) {
            extractedText += `\n${plainText}\n`;
          }
        }
      }
    });

    return extractedText;
  } catch (err) {
    console.error('Failed to parse DOCX header/footer XML:', err.message);
    return '';
  }
}

/**
 * DOCX Extraction: Body text + native Header/Footer extraction + OCR on embedded images
 */
async function extractFromDocx(buffer) {
  const rawTextResult = await mammoth.extractRawText({ buffer });
  let text = rawTextResult.value || '';

  const headerFooterText = extractDocxHeaderFooterText(buffer);
  if (headerFooterText) {
    text += '\n' + headerFooterText;
  }

  const imageBuffers = [];
  try {
    await mammoth.convertToHtml({ buffer }, {
      convertImage: mammoth.images.inline((element) => {
        return element.read().then((imageBuffer) => {
          imageBuffers.push(imageBuffer);
          return { src: '' };
        });
      })
    });
  } catch (err) {
    console.error('Failed to extract images from DOCX:', err.message);
  }

  if (imageBuffers.length > 0) {
    console.log(`Found ${imageBuffers.length} embedded image(s) in DOCX. Running OCR...`);
    const seenHashes = new Set();
    const uniqueBuffers = imageBuffers.filter((buf) => {
      const hash = crypto.createHash('md5').update(buf).digest('hex');
      if (seenHashes.has(hash)) return false;
      seenHashes.add(hash);
      return true;
    });

    // CHANGED: batched instead of firing all images through OCR at once.
    const wrappedImages = uniqueBuffers.map((data) => ({ data }));
    const ocrResults = await runOcrBatched(wrappedImages, 'docx-embedded-image');

    ocrResults.forEach((ocrText) => {
      if (ocrText && !ocrText.includes('[OCR completed but no text was detected]') && !ocrText.includes('[OCR failed')) {
        text += '\n[Embedded Image/Logo Text]:\n' + ocrText + '\n';
      }
    });
  }

  return text;
}

function cellToText(cellValue) {
  if (cellValue === null || cellValue === undefined) return '';
  if (typeof cellValue === 'object' && Array.isArray(cellValue.richText)) {
    return cellValue.richText.map((part) => part.text).join('');
  }
  if (typeof cellValue === 'object' && cellValue.error) {
    return `[Formula error: ${cellValue.error}]`;
  }
  if (typeof cellValue === 'object' && cellValue.text) {
    return cellValue.text;
  }
  if (typeof cellValue === 'object' && 'result' in cellValue) {
    if (cellValue.result && typeof cellValue.result === 'object' && cellValue.result.error) {
      return `[Formula error: ${cellValue.result.error}]`;
    }
    return String(cellValue.result ?? '');
  }
  if (cellValue instanceof Date) {
    return cellValue.toISOString().split('T')[0];
  }
  return String(cellValue);
}

function isPureNumericOrDateValue(v) {
  return /^-?\d+(\.\d+)?$/.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function looksLikeHeaderRow(values) {
  if (values.length < 2) return false;
  const nonEmpty = values.filter((v) => v && v.length > 0);
  if (nonEmpty.length < 2) return false;
  return nonEmpty.every((v) => v.length < 40 && !isPureNumericOrDateValue(v));
}

async function extractFromExcel(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  let allText = '';

  workbook.eachSheet((worksheet) => {
    allText += `--- Sheet: ${worksheet.name} ---\n`;
    let headers = null;

    worksheet.eachRow((row) => {
      const rawValues = row.values.slice(1).map(cellToText);

      while (rawValues.length > 0 && rawValues[rawValues.length - 1] === '') {
        rawValues.pop();
      }

      if (rawValues.length === 0) return;

      if (!headers && looksLikeHeaderRow(rawValues)) {
        headers = rawValues;
        allText += rawValues.join(' | ') + '\n';
        return;
      }

      if (headers) {
        const labeled = rawValues
          .map((val, i) => {
            const label = headers[i] || `Column ${i + 1}`;
            return val !== '' ? `${label}: ${val}` : null;
          })
          .filter(Boolean)
          .join('; ');
        allText += labeled + '\n';
      } else {
        allText += rawValues.join(' | ') + '\n';
      }
    });

    allText += '\n';
  });

  return allText.trim();
}

async function extractText(buffer, originalName) {
  const startTime = Date.now();
  const ext = path.extname(originalName).toLowerCase();
  let rawText = null;
  let method = 'unknown';

  if (ext === '.pdf') {
    if (!isValidPdfSignature(buffer)) {
      throw new Error('Invalid PDF format: file does not start with a valid %PDF signature.');
    }
    method = 'pdf-full-scan';
    rawText = await extractFromPdf(buffer);
  } else if (ext === '.docx') {
    // CHANGED: removed '.doc' from this branch. mammoth only supports .docx
    // (OOXML/zip format) — legacy .doc (binary OLE2 format) is a different
    // file format entirely and mammoth will always fail on it. .doc is also
    // removed from the multer allowlist in upload.js, so this branch should
    // no longer be reachable with a .doc file — this check stays as a safety net.
    method = 'docx-full-scan';
    rawText = await extractFromDocx(buffer);
  } else if (ext === '.xls' || ext === '.xlsx') {
    method = 'excel';
    rawText = await extractFromExcel(buffer);
  } else if (IMAGE_EXTENSIONS.includes(ext)) {
    method = 'image-ocr';
    rawText = await extractWithOcr(buffer, originalName);
  } else if (ext === '.doc') {
    // ADDED: explicit rejection instead of silently attempting extraction
    // and failing. mammoth cannot read legacy .doc format.
    throw new Error('Legacy .doc format is not currently supported. Please convert to .docx and re-upload.');
  } else {
    throw new Error(`Unsupported file extension for text extraction: ${ext}`);
  }

  const result = rawText ? cleanExtractedText(rawText) : rawText;
  const durationMs = Date.now() - startTime;
  console.log(`[TIMING] ${originalName} | method: ${method} | ${durationMs}ms`);

  return result;
}

module.exports = { extractText };