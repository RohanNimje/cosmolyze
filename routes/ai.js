/**
 * routes/ai.js — Cosmolyze Hybrid AI Engine
 *
 * AI Workload Routing:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  GEMINI (Vision)  →  analyze-face, generate-verdict        │
 *   │  GROQ   (Text)    →  analyze-formula                       │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Endpoints:
 *   POST /api/ai/analyze-face     → Gemini: visual triage → 4 diagnostic questions
 *   POST /api/ai/generate-verdict → Gemini: full clinical product verdict
 *   POST /api/ai/analyze-formula  → Groq:  text-based ingredient clinical audit
 *
 * Retry Policy (both engines):
 *   Attempt 1 → on 429/503 wait exactly 2000ms
 *   Attempt 2 → on 429/503 wait exactly 4000ms
 *   Attempt 3 → final fallback (no further wait)
 *   All retries are strictly sequential — Attempt N+1 never starts until
 *   Attempt N has fully failed and the backoff delay has elapsed.
 */

const express = require('express');
const router = express.Router();

// Import system prompts from the dedicated prompts.js module (no circular dep)
const {
  FACE_ANALYSIS_SYSTEM_PROMPT,
  VERDICT_SYSTEM_PROMPT,
  FORMULA_SYSTEM_PROMPT,
} = require('../prompts');

// ── API Configuration — read dynamically from process.env ────────────────────
// Keys and models are resolved at request-time so hot-reloading env works.
const getGeminiConfig = () => ({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
});

const getGroqConfig = () => ({
  apiKey: process.env.GROQ_API_KEY,
  model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
});

// ── Resilience Config ─────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 60000; // 60 s hard timeout per attempt
const MAX_ATTEMPTS = 3;          // 3 total attempts (2 retries)

// Sequential backoff delays in milliseconds, indexed by attempt number (1-based).
// Attempt 1 fails → wait BACKOFF_MS[1] = 2000ms before attempt 2
// Attempt 2 fails → wait BACKOFF_MS[2] = 4000ms before attempt 3
// Attempt 3 is the final — no backoff after it
const BACKOFF_MS = { 1: 2000, 2: 4000 };

// Transient HTTP status codes that trigger a retry
const TRANSIENT_STATUSES = new Set([429, 502, 503]);

// ── Helper: fetch with AbortController timeout ────────────────────────────────
function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .then(res => { clearTimeout(timer); return res; })
    .catch(err => { clearTimeout(timer); throw err; });
}

// ── Helper: strict sequential sleep ──────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Helper: safely strip markdown fences and parse JSON ──────────────────────
// Both Gemini and Groq may wrap JSON in ```json ... ``` fences.
function parseAIJSON(raw) {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

// ═════════════════════════════════════════════════════════════════════════════
//  GEMINI ENGINE — Multimodal Vision Tasks
//  Used for: analyze-face, generate-verdict
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Call the Gemini Generative Language API with strict sequential exponential backoff.
 *
 * Retry schedule:
 *   Attempt 1 → fail (transient) → WAIT 2000ms (sequential, blocking)
 *   Attempt 2 → fail (transient) → WAIT 4000ms (sequential, blocking)
 *   Attempt 3 → final (no further retry)
 *
 * @param {string} systemPrompt   - System instruction for Gemini
 * @param {string} userText       - User-facing prompt text
 * @param {string|null} imageBase64 - Full data URI (e.g. "data:image/jpeg;base64,...")
 * @returns {string} Raw text response from Gemini
 */
async function callGemini(systemPrompt, userText, imageBase64 = null) {
  const { apiKey, model } = getGeminiConfig();

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in .env');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Build parts array — text first, then optional inline image
  const parts = [{ text: userText }];
  if (imageBase64) {
    const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid imageBase64 format — expected a valid data URI');
    const [, mimeType, b64data] = match;
    parts.push({ inline_data: { mime_type: mimeType, data: b64data } });
  }

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    },
  };

  const fetchOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };

  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[AI] Gemini attempt ${attempt}/${MAX_ATTEMPTS} (model: ${model})...`);

      const res = await fetchWithTimeout(endpoint, fetchOptions, FETCH_TIMEOUT_MS);

      if (!res.ok) {
        const errBody = await res.text();

        if (!TRANSIENT_STATUSES.has(res.status)) {
          // Permanent error (400, 401, 404…) — no point retrying
          throw new Error(`Gemini API permanent error ${res.status}: ${errBody}`);
        }

        lastError = new Error(`Gemini transient error ${res.status} on attempt ${attempt}`);
        console.warn(`[AI] ${lastError.message}`);

        // Sequential backoff — WAIT before the next attempt begins
        if (attempt < MAX_ATTEMPTS) {
          const waitMs = BACKOFF_MS[attempt];
          console.log(`[AI] Waiting ${waitMs}ms before Gemini attempt ${attempt + 1}...`);
          await sleep(waitMs); // strictly sequential — execution pauses here
        }
        continue;
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini returned an empty response body');
      return text;

    } catch (err) {
      if (err.name === 'AbortError') {
        lastError = new Error(`Gemini timed out after ${FETCH_TIMEOUT_MS / 1000}s (attempt ${attempt})`);
        console.warn(`[AI] ${lastError.message}`);
      } else if (err !== lastError) {
        lastError = err;
        console.warn(`[AI] Gemini attempt ${attempt} threw:`, err.message);
      }

      // Network/timeout errors are also retriable
      if (attempt < MAX_ATTEMPTS && (err.name === 'AbortError' || err.name === 'FetchError' || err.name === 'TypeError')) {
        const waitMs = BACKOFF_MS[attempt];
        console.log(`[AI] Waiting ${waitMs}ms before Gemini retry ${attempt + 1}...`);
        await sleep(waitMs);
        continue;
      }

      // Permanent errors bubble immediately without waiting
      if (!TRANSIENT_STATUSES.has(err.status)) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error('Gemini failed after all attempts');
}

// ═════════════════════════════════════════════════════════════════════════════
//  GROQ ENGINE — Text-Only Tasks
//  Used for: analyze-formula, expert clinical verdicts, product comparisons
//  Protocol: OpenAI-compatible REST (no SDK needed)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Call the Groq OpenAI-compatible Chat Completions API with strict sequential
 * exponential backoff (identical retry schedule to callGemini).
 *
 * @param {string} systemPrompt - System instruction
 * @param {string} userText     - User message content
 * @returns {string} Raw text response from Groq
 */
async function callGroq(systemPrompt, userText) {
  const { apiKey, model } = getGroqConfig();

  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not configured in .env');
  }

  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    temperature: 0.3,
    max_tokens: 8192,
    response_format: { type: 'json_object' }, // Force JSON mode
  };

  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  };

  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[AI] Groq attempt ${attempt}/${MAX_ATTEMPTS} (model: ${model})...`);

      const res = await fetchWithTimeout(endpoint, fetchOptions, FETCH_TIMEOUT_MS);

      if (!res.ok) {
        const errBody = await res.text();

        if (!TRANSIENT_STATUSES.has(res.status)) {
          throw new Error(`Groq API permanent error ${res.status}: ${errBody}`);
        }

        lastError = new Error(`Groq transient error ${res.status} on attempt ${attempt}`);
        console.warn(`[AI] ${lastError.message}`);

        if (attempt < MAX_ATTEMPTS) {
          const waitMs = BACKOFF_MS[attempt];
          console.log(`[AI] Waiting ${waitMs}ms before Groq attempt ${attempt + 1}...`);
          await sleep(waitMs); // strictly sequential
        }
        continue;
      }

      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Groq returned an empty response body');
      return text;

    } catch (err) {
      if (err.name === 'AbortError') {
        lastError = new Error(`Groq timed out after ${FETCH_TIMEOUT_MS / 1000}s (attempt ${attempt})`);
        console.warn(`[AI] ${lastError.message}`);
      } else if (err !== lastError) {
        lastError = err;
        console.warn(`[AI] Groq attempt ${attempt} threw:`, err.message);
      }

      if (attempt < MAX_ATTEMPTS && (err.name === 'AbortError' || err.name === 'FetchError' || err.name === 'TypeError')) {
        const waitMs = BACKOFF_MS[attempt];
        console.log(`[AI] Waiting ${waitMs}ms before Groq retry ${attempt + 1}...`);
        await sleep(waitMs);
        continue;
      }

      if (!TRANSIENT_STATUSES.has(err.status)) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error('Groq failed after all attempts');
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/ai/analyze-face
//  Engine: GEMINI (multimodal vision)
//  Body:   { imageBase64: "data:image/jpeg;base64,..." }
//  Response: { success: true, data: { detected_concerns, questions } }
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

    console.log('[AI] analyze-face: routing to Gemini (vision task)...');
    const raw = await callGemini(FACE_ANALYSIS_SYSTEM_PROMPT, userText, imageBase64);
    const parsed = parseAIJSON(raw);

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
      message: `AI face analysis failed: ${err.message}`,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/ai/generate-verdict
//  Engine: GEMINI (multimodal vision + text)
//  Body:   { imageBase64, answers: [str×4], budgetMin: int, budgetMax: int }
//  Response: { success: true, data: { top_winner, alternatives } }
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

    const userText = `
Patient Diagnostic Questionnaire Responses:
1. ${answers[0] || 'No answer provided'}
2. ${answers[1] || 'No answer provided'}
3. ${answers[2] || 'No answer provided'}
4. ${answers[3] || 'No answer provided'}

Patient Budget Range: ₹${budgetMin} – ₹${budgetMax} INR

Please analyse the face image alongside these answers and generate the full clinical verdict JSON as instructed.
`.trim();

    console.log('[AI] generate-verdict: routing to Gemini (vision task), budget ₹', budgetMin, '–', budgetMax);
    const raw = await callGemini(VERDICT_SYSTEM_PROMPT, userText, imageBase64);
    const parsed = parseAIJSON(raw);

    if (!parsed.top_winner || !Array.isArray(parsed.alternatives)) {
      console.error('[AI] generate-verdict: unexpected response shape', JSON.stringify(parsed).slice(0, 300));
      return res.status(502).json({
        success: false,
        message: 'AI returned an unexpected response structure. Please try again.',
      });
    }

    // Clamp to max 4 alternatives
    if (parsed.alternatives.length > 4) parsed.alternatives = parsed.alternatives.slice(0, 4);

    console.log('[AI] generate-verdict: success, winner:', parsed.top_winner.product_name);
    return res.status(200).json({ success: true, data: parsed });

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
//  Engine: GROQ (text-only — no image; optimised for large-context ingredient lists)
//  Body:   { productName?: string, ingredientList: string }
//  Response: { success: true, data: { summary, ingredients, concerns, positives } }
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

    console.log('[AI] analyze-formula: routing to Groq (text task) for:', productName || 'unnamed product');
    const raw = await callGroq(FORMULA_SYSTEM_PROMPT, userText);
    const parsed = parseAIJSON(raw);

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
