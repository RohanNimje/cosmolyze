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

// ── Fallback payloads (keep the UI alive when AI JSON is unrecoverable) ──────
const FACE_ANALYSIS_FALLBACK = {
  detected_concerns: ['General skin assessment'],
  questions: [
    'What is your primary skin concern right now?',
    'How sensitive is your skin to new active ingredients?',
    'What does your current morning and night routine look like?',
    'Do you have any known allergies or ingredients you must avoid?',
  ],
  _fallback: true,
};

const VERDICT_FALLBACK = {
  top_winner: {
    product_name: 'CeraVe Moisturising Cream',
    brand: 'CeraVe',
    price_inr: 899,
    mrp_inr: 1099,
    clinical_match_pct: 88,
    what_it_is: 'A ceramide-rich barrier cream that restores moisture and supports a compromised skin barrier.',
    key_actives: ['Ceramides 1/3/6-II', 'Hyaluronic Acid', 'Cholesterol'],
    key_benefits: ['Barrier repair', 'Long-lasting hydration', 'Non-comedogenic'],
    expert_verdict: 'A clinically reliable barrier formula suitable as a safe default while a full AI verdict is unavailable.',
    amazon_url: 'https://www.amazon.in/s?k=CeraVe+Moisturising+Cream',
  },
  alternatives: [
    {
      product_name: 'Cetaphil Gentle Skin Cleanser',
      brand: 'Cetaphil',
      price_inr: 449,
      optimal_active: 'Mild surfactants for non-stripping cleanse',
      detected_sensitizer: null,
      medical_alert: 'Low-irritation cleanser; suitable for most sensitive profiles.',
      match_status: 'good',
      amazon_url: 'https://www.amazon.in/s?k=Cetaphil+Gentle+Skin+Cleanser',
    },
    {
      product_name: 'Minimalist 10% Niacinamide Serum',
      brand: 'Minimalist',
      price_inr: 399,
      optimal_active: 'Niacinamide for barrier support and texture',
      detected_sensitizer: null,
      medical_alert: 'Introduce slowly if skin is highly reactive.',
      match_status: 'neutral',
      amazon_url: 'https://www.amazon.in/s?k=Minimalist+Niacinamide+10',
    },
    {
      product_name: 'La Roche-Posay Cicaplast Baume B5',
      brand: 'La Roche-Posay',
      price_inr: 850,
      optimal_active: 'Panthenol + madecassoside for repair',
      detected_sensitizer: null,
      medical_alert: 'Excellent rescue balm for irritated or recovering skin.',
      match_status: 'good',
      amazon_url: 'https://www.amazon.in/s?k=La+Roche-Posay+Cicaplast+Baume+B5',
    },
    {
      product_name: 'The Ordinary AHA 30% + BHA 2% Peeling Solution',
      brand: 'The Ordinary',
      price_inr: 790,
      optimal_active: 'High-strength AHA/BHA chemical exfoliation',
      detected_sensitizer: 'Glycolic Acid / Salicylic Acid (high %)',
      medical_alert: 'Potent acids — avoid on compromised, sensitive, or barrier-impaired skin.',
      match_status: 'avoid',
      amazon_url: 'https://www.amazon.in/s?k=The+Ordinary+AHA+30+BHA+2',
    },
  ],
  _fallback: true,
};

const FORMULA_FALLBACK = {
  product_name: 'Unknown Product',
  overall_score: 70,
  overall_rating: 'Fair',
  summary: 'A complete clinical parse was unavailable. Please re-run the analysis for a full ingredient breakdown.',
  concerns: ['Automated parse incomplete — re-analyse for precise sensitizer detection'],
  positives: ['Re-submit the ingredient list to receive a full clinical audit'],
  ingredients: [],
  _fallback: true,
};

// ── JSON sanitization helpers ────────────────────────────────────────────────

/** Strip ```json ... ``` fences (leading, trailing, or wrapped). */
function stripMarkdownFences(raw) {
  let s = String(raw ?? '').trim();
  const fenced = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  s = s.replace(/^```(?:json|JSON)?\s*/i, '').replace(/```\s*$/i, '');
  return s.trim();
}

/** Slice from the first `{` to the last `}` so prose wrappers are dropped. */
function extractJSONObject(s) {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return s;
  return s.slice(start, end + 1);
}

/** Normalize smart quotes, BOM, and trailing commas. */
function basicSanitize(s) {
  return s
    .replace(/^\uFEFF/, '')
    .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*(?=[}\]])/g, '')
    .trim();
}

/**
 * Escape bare double-quotes and control characters that appear inside JSON strings.
 * Uses a simple state machine: if a `"` inside a string is not a valid terminator
 * (followed by , } ] : or end), treat it as content and escape it.
 */
function fixUnescapedQuotesAndControls(jsonStr) {
  let out = '';
  let inString = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const c = jsonStr[i];

    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }

    // Inside a string value
    if (c === '\\') {
      out += c + (jsonStr[i + 1] ?? '');
      i += 1;
      continue;
    }

    if (c === '"') {
      const look = jsonStr.slice(i + 1).match(/^\s*([,}\]:]|$)/);
      if (look) {
        inString = false;
        out += c;
      } else {
        out += '\\"';
      }
      continue;
    }

    if (c === '\n' || c === '\r') {
      out += '\\n';
      continue;
    }
    if (c === '\t') {
      out += '\\t';
      continue;
    }

    out += c;
  }

  return out;
}

/** Close truncated JSON by appending missing quotes / brackets / braces. */
function balanceBrackets(s) {
  let inString = false;
  let escape = false;
  let braces = 0;
  let brackets = 0;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') braces += 1;
    else if (c === '}') braces -= 1;
    else if (c === '[') brackets += 1;
    else if (c === ']') brackets -= 1;
  }

  let repaired = s;
  if (inString) repaired += '"';
  while (brackets > 0) {
    repaired += ']';
    brackets -= 1;
  }
  while (braces > 0) {
    repaired += '}';
    braces -= 1;
  }
  return repaired.replace(/,\s*(?=[}\]])/g, '');
}

/**
 * Fail-safe AI JSON parser.
 * 1) Strip markdown / extract object / basic sanitize
 * 2) Fix unescaped quotes & control chars
 * 3) Balance truncated brackets
 * On total failure: log raw_response and return `fallback` (never throw if fallback given).
 */
function parseAIJSON(raw, fallback = null, label = 'AI') {
  const raw_response = String(raw ?? '');

  const tryParse = (candidate, stage) => {
    try {
      return { ok: true, value: JSON.parse(candidate), stage };
    } catch (err) {
      return { ok: false, error: err, stage };
    }
  };

  let cleaned = basicSanitize(extractJSONObject(stripMarkdownFences(raw_response)));

  let result = tryParse(cleaned, 'basic-sanitize');
  if (result.ok) return result.value;

  const quoteFixed = fixUnescapedQuotesAndControls(cleaned);
  result = tryParse(quoteFixed, 'quote-fix');
  if (result.ok) return result.value;

  const balanced = balanceBrackets(quoteFixed);
  result = tryParse(balanced, 'balance-brackets');
  if (result.ok) return result.value;

  // Final attempt: sanitize the balanced form again
  const lastPass = basicSanitize(fixUnescapedQuotesAndControls(balanced));
  result = tryParse(lastPass, 'final-pass');
  if (result.ok) return result.value;

  console.error(`[AI] ${label} JSON.parse failed after sanitization: ${result.error.message}`);
  console.error(`[AI] ${label} raw_response (full):\n${raw_response}`);

  if (fallback && typeof fallback === 'object') {
    console.warn(`[AI] ${label}: returning structured fallback JSON (_fallback: true)`);
    return { ...fallback };
  }

  throw result.error;
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

    let parsed;
    try {
      parsed = parseAIJSON(raw, FACE_ANALYSIS_FALLBACK, 'analyze-face');
    } catch (parseErr) {
      // parseAIJSON only throws when no fallback is provided — defensive path
      console.error('[AI] analyze-face unrecoverable parse:', parseErr.message);
      console.error('[AI] analyze-face raw_response:\n', raw);
      parsed = { ...FACE_ANALYSIS_FALLBACK };
    }

    // Normalize shape if partially valid
    if (!Array.isArray(parsed.questions) || parsed.questions.length !== 4) {
      console.warn('[AI] analyze-face: invalid questions shape — applying fallback questions');
      parsed = {
        detected_concerns: Array.isArray(parsed.detected_concerns) && parsed.detected_concerns.length
          ? parsed.detected_concerns
          : FACE_ANALYSIS_FALLBACK.detected_concerns,
        questions: FACE_ANALYSIS_FALLBACK.questions,
        _fallback: true,
      };
    }

    console.log(
      '[AI] analyze-face: success',
      parsed._fallback ? '(fallback)' : '',
      'concerns:',
      parsed.detected_concerns
    );
    return res.status(200).json({
      success: true,
      data: {
        detected_concerns: parsed.detected_concerns || [],
        questions: parsed.questions,
        ...(parsed._fallback ? { fallback: true } : {}),
      },
    });

  } catch (err) {
    console.error('[AI analyze-face Error]', err.message);
    // Last-resort: never freeze the UI — return usable diagnostic questions
    return res.status(200).json({
      success: true,
      data: {
        ...FACE_ANALYSIS_FALLBACK,
        fallback: true,
        message: `AI face analysis degraded: ${err.message}`,
      },
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

    let parsed;
    try {
      parsed = parseAIJSON(raw, VERDICT_FALLBACK, 'generate-verdict');
    } catch (parseErr) {
      console.error('[AI] generate-verdict unrecoverable parse:', parseErr.message);
      console.error('[AI] generate-verdict raw_response:\n', raw);
      parsed = { ...VERDICT_FALLBACK };
    }

    if (!parsed.top_winner || !Array.isArray(parsed.alternatives)) {
      console.warn('[AI] generate-verdict: unexpected shape — applying full verdict fallback');
      parsed = { ...VERDICT_FALLBACK };
    }

    // Clamp to max 4 alternatives; pad if the model returned fewer
    if (!Array.isArray(parsed.alternatives)) parsed.alternatives = [];
    if (parsed.alternatives.length > 4) parsed.alternatives = parsed.alternatives.slice(0, 4);
    while (parsed.alternatives.length < 4) {
      parsed.alternatives.push(VERDICT_FALLBACK.alternatives[parsed.alternatives.length]);
    }

    console.log(
      '[AI] generate-verdict: success',
      parsed._fallback ? '(fallback)' : '',
      'winner:',
      parsed.top_winner.product_name
    );
    return res.status(200).json({
      success: true,
      data: parsed,
      ...(parsed._fallback ? { fallback: true } : {}),
    });

  } catch (err) {
    console.error('[AI generate-verdict Error]', err.message);
    // Last-resort: return a valid verdict payload so the results UI can render
    return res.status(200).json({
      success: true,
      data: { ...VERDICT_FALLBACK },
      fallback: true,
      message: `Verdict generation degraded: ${err.message}`,
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

    let parsed;
    try {
      parsed = parseAIJSON(raw, { ...FORMULA_FALLBACK, product_name: productName || 'Unknown Product' }, 'analyze-formula');
    } catch (parseErr) {
      console.error('[AI] analyze-formula unrecoverable parse:', parseErr.message);
      console.error('[AI] analyze-formula raw_response:\n', raw);
      parsed = { ...FORMULA_FALLBACK, product_name: productName || 'Unknown Product' };
    }

    if (!Array.isArray(parsed.ingredients)) {
      console.warn('[AI] analyze-formula: missing ingredients array — applying fallback');
      parsed = {
        ...FORMULA_FALLBACK,
        product_name: parsed.product_name || productName || 'Unknown Product',
        summary: parsed.summary || FORMULA_FALLBACK.summary,
      };
    }

    console.log(
      '[AI] analyze-formula: success',
      parsed._fallback ? '(fallback)' : '',
      ',',
      parsed.ingredients.length,
      'ingredients parsed.'
    );
    return res.status(200).json({
      success: true,
      data: parsed,
      ...(parsed._fallback ? { fallback: true } : {}),
    });

  } catch (err) {
    console.error('[AI analyze-formula Error]', err.message);
    const isTimeout = err.message.includes('timed out');
    // Degraded but renderable response — UI stays usable
    return res.status(200).json({
      success: true,
      data: {
        ...FORMULA_FALLBACK,
        product_name: (req.body && req.body.productName) || 'Unknown Product',
        summary: isTimeout
          ? 'The AI server timed out. Please retry the formula analysis in a moment.'
          : `Formula analysis degraded: ${err.message}`,
      },
      fallback: true,
    });
  }
});

module.exports = router;
