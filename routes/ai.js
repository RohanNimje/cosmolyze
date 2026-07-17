/**
 * routes/ai.js — Cosmolyze Multimodal AI Engine
 *
 * Endpoints:
 *   POST /api/ai/analyze-face     → Gemini vision: generates 4 personalised questions
 *   POST /api/ai/generate-verdict → Gemini vision: generates full clinical product verdict
 *
 * Both endpoints use native fetch (Node 18+) — no extra dependencies required.
 * System prompts are defined in server.js and imported here for clean separation.
 */

const express = require('express');
const router = express.Router();

// Import system prompts from the dedicated prompts.js module (no circular dep)
const {
  FACE_ANALYSIS_SYSTEM_PROMPT,
  VERDICT_SYSTEM_PROMPT,
  FORMULA_SYSTEM_PROMPT,
} = require('../prompts');

// ── Gemini API Configuration ─────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Model is read from .env (GEMINI_MODEL=...) so it can be swapped without a code change.
// Set GEMINI_MODEL in your .env to override (e.g. gemini-1.5-flash, gemini-2.0-flash, etc.)
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

// ── Resilience Config ────────────────────────────────────────────────────────
// Multimodal vision tasks on the free tier regularly take 15-25 s — 30 s gives
// a safe ceiling without cutting off legitimate slow responses.
const FETCH_TIMEOUT_MS = 60000; // 30 s hard timeout per attempt
const MAX_RETRIES = 2;     // Retry up to 2 times on transient failures
const BACKOFF_BASE_MS = 5000;  // 2 s base → back-off: 2 s, 4 s (gives API time to recover)

// ── Helper: fetch with AbortController timeout ───────────────────────────────
function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .then(res => { clearTimeout(timer); return res; })
    .catch(err => { clearTimeout(timer); throw err; });
}

// ── Helper: call Gemini with optional image, timeout + auto-retry ─────────────
/**
 * @param {string} systemPrompt  - The system instruction text
 * @param {string} userText      - The user-facing prompt text
 * @param {string|null} imageBase64 - Full data URI e.g. "data:image/jpeg;base64,..."
 * @returns {string} Raw text response from Gemini
 */
async function callGemini(systemPrompt, userText, imageBase64 = null) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in .env');
  }

  // Build the parts array — text always first, then inline image if provided
  const parts = [{ text: userText }];

  if (imageBase64) {
    // Strip the data URI prefix to get pure base64 + mime type
    const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid imageBase64 format — expected data URI');
    const [, mimeType, b64data] = match;
    parts.push({
      inline_data: { mime_type: mimeType, data: b64data },
    });
  }

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.3,        // Low temp for clinical precision
      maxOutputTokens: 8192,
      responseMimeType: 'application/json', // Force JSON output
    },
  };

  const fetchOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      console.log(`[AI] Gemini attempt ${attempt}/${MAX_RETRIES + 1}...`);
      const res = await fetchWithTimeout(GEMINI_ENDPOINT, fetchOptions, FETCH_TIMEOUT_MS);

      if (!res.ok) {
        const errBody = await res.text();
        // 429/503 are transient — retry; 400/404 are permanent — bail immediately
        const isTransient = res.status === 429 || res.status === 503 || res.status === 502;
        if (!isTransient) throw new Error(`Gemini API error ${res.status}: ${errBody}`);
        lastError = new Error(`Gemini API error ${res.status} (transient)`);
        console.warn(`[AI] Transient error on attempt ${attempt}:`, lastError.message);
        if (attempt <= MAX_RETRIES) {
          await new Promise(r => setTimeout(r, BACKOFF_BASE_MS * attempt)); // back-off: 2 s, 4 s
          continue;
        }
        throw lastError;
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini returned an empty response');
      return text;

    } catch (err) {
      const isTimeout = err.name === 'AbortError';
      if (isTimeout) {
        lastError = new Error(`Gemini request timed out after ${FETCH_TIMEOUT_MS / 1000}s (attempt ${attempt})`);
        console.warn('[AI]', lastError.message);
      } else if (!lastError || err !== lastError) {
        lastError = err;
      }
      if (attempt <= MAX_RETRIES && (isTimeout || err.name === 'FetchError')) {
        await new Promise(r => setTimeout(r, 800 * attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}

// ── Helper: safely parse JSON from Gemini output ─────────────────────────────
function parseGeminiJSON(raw) {
  // Gemini sometimes wraps JSON in markdown code fences — strip them
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/ai/analyze-face
//  Body: { imageBase64: "data:image/jpeg;base64,..." }
//  Response: { success: true, questions: ["Q1","Q2","Q3","Q4"], detected_concerns: [...] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/analyze-face', async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64 || !imageBase64.startsWith('data:image/')) {
      return res.status(400).json({
        success: false,
        message: 'imageBase64 is required and must be a valid image data URI.',
      });
    }

    const userText = 'Please analyze this patient face image and generate the 4 personalised diagnostic questions as instructed.';

    console.log('[AI] analyze-face: calling Gemini...');
    const raw = await callGemini(FACE_ANALYSIS_SYSTEM_PROMPT, userText, imageBase64);
    const parsed = parseGeminiJSON(raw);

    // Validate the expected shape
    if (!Array.isArray(parsed.questions) || parsed.questions.length !== 4) {
      console.error('[AI] analyze-face: unexpected response shape', parsed);
      return res.status(502).json({
        success: false,
        message: 'AI returned an unexpected response. Please try again.',
      });
    }

    console.log('[AI] analyze-face: success, concerns:', parsed.detected_concerns);

    return res.status(200).json({
      success: true,
      data: {
        detected_concerns: parsed.detected_concerns || [],
        questions: parsed.questions,
      },
    });

  } catch (err) {
    console.error('[AI analyze-face Error]', err.message);
    return res.status(500).json({
      success: false,
      message: `AI analysis failed: ${err.message}`,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/ai/generate-verdict
//  Body: { imageBase64, answers: [str, str, str, str], budgetMin: int, budgetMax: int }
//  Response: { success: true, data: { top_winner: {...}, alternatives: [...] } }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/generate-verdict', async (req, res) => {
  try {
    const { imageBase64, answers, budgetMin = 100, budgetMax = 3000 } = req.body;

    if (!imageBase64 || !imageBase64.startsWith('data:image/')) {
      return res.status(400).json({
        success: false,
        message: 'imageBase64 is required.',
      });
    }

    if (!Array.isArray(answers) || answers.length !== 4) {
      return res.status(400).json({
        success: false,
        message: 'answers must be an array of exactly 4 strings.',
      });
    }

    // Compose a structured user message with the patient's answers and budget
    const userText = `
Patient Diagnostic Questionnaire Responses:
1. ${answers[0] || 'No answer provided'}
2. ${answers[1] || 'No answer provided'}
3. ${answers[2] || 'No answer provided'}
4. ${answers[3] || 'No answer provided'}

Patient Budget Range: ₹${budgetMin} – ₹${budgetMax} INR

Please analyse the face image alongside these answers and generate the full clinical verdict JSON as instructed.
`.trim();

    console.log('[AI] generate-verdict: calling Gemini, budget ₹', budgetMin, '–', budgetMax);
    const raw = await callGemini(VERDICT_SYSTEM_PROMPT, userText, imageBase64);
    const parsed = parseGeminiJSON(raw);

    // Validate top-level shape
    if (!parsed.top_winner || !Array.isArray(parsed.alternatives)) {
      console.error('[AI] generate-verdict: unexpected response shape', JSON.stringify(parsed).slice(0, 300));
      return res.status(502).json({
        success: false,
        message: 'AI returned an unexpected response structure. Please try again.',
      });
    }

    // Ensure we have exactly 4 alternatives
    if (parsed.alternatives.length > 4) parsed.alternatives = parsed.alternatives.slice(0, 4);

    console.log('[AI] generate-verdict: success, winner:', parsed.top_winner.product_name);

    return res.status(200).json({
      success: true,
      data: parsed,
    });

  } catch (err) {
    console.error('[AI generate-verdict Error]', err.message);
    return res.status(500).json({
      success: false,
      message: `Verdict generation failed: ${err.message}`,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/ai/analyze-formula
//  Body: { productName?: string, ingredientList: string }
//  Response: { success: true, data: { summary, ingredients: [{name,rating,function,notes}], concerns: [], positives: [] } }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/analyze-formula', async (req, res) => {
  try {
    const { productName = '', ingredientList } = req.body;

    if (!ingredientList || ingredientList.trim().length < 5) {
      return res.status(400).json({
        success: false,
        message: 'ingredientList is required and must be non-empty.',
      });
    }

    const userText = `
Product Name: ${productName || 'Unknown Product'}

Ingredient List:
${ingredientList.trim()}

Please analyze this formula and return the full clinical JSON breakdown as instructed.
`.trim();

    console.log('[AI] analyze-formula: calling Gemini for', productName || 'unnamed product');
    const raw = await callGemini(FORMULA_SYSTEM_PROMPT, userText);
    const parsed = parseGeminiJSON(raw);

    // Basic shape validation
    if (!Array.isArray(parsed.ingredients)) {
      console.error('[AI] analyze-formula: unexpected response shape', JSON.stringify(parsed).slice(0, 200));
      return res.status(502).json({
        success: false,
        message: 'AI returned an unexpected response. Please try again.',
      });
    }

    console.log('[AI] analyze-formula: success,', parsed.ingredients.length, 'ingredients parsed.');
    return res.status(200).json({ success: true, data: parsed });

  } catch (err) {
    console.error('[AI analyze-formula Error]', err.message);
    const isTimeout = err.message.includes('timed out');
    return res.status(isTimeout ? 503 : 500).json({
      success: false,
      message: isTimeout
        ? 'The AI server is busy. Please try again in a moment.'
        : `Formula analysis failed: ${err.message}`,
    });
  }
});

module.exports = router;
