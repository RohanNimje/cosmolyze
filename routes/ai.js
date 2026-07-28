/**
 * routes/ai.js — Cosmolyze Hybrid AI Engine
 *
 * Dynamic Multi-Provider Failover Architecture:
 *   ┌─────────────────────────────────────────────────────────────────────────┐
 *   │  STAGE 1  POST /analyze-face  (Dynamic Vision Cascade)                  │
 *   │    Step 1 → Gemini Direct  (GEMINI_API_KEY_CURRENT × GEMINI_VISION_MODEL_N) │
 *   │    Step 2 → Gemini Direct  (GEMINI_API_KEY_NEW     × GEMINI_VISION_MODEL_N) │
 *   │    Step 3 → OpenAI Direct  (OPENAI_API_KEY         × OPENAI_VISION_MODEL_N) │
 *   │             [Future Guard — skipped silently if key/models absent]      │
 *   │    Step 4 → DeepSeek Direct (DEEPSEEK_API_KEY      × DEEPSEEK_VISION_MODEL_N)│
 *   │             [Future Guard — skipped silently if key/models absent]      │
 *   │    Step 5 → OpenRouter     (OPENROUTER_API_KEY     × OPENROUTER_VISION_MODEL_N)│
 *   │    Step 6 → Groq           (GROQ_API_KEY_NEW|GROQ_API_KEY × GROQ_TEXT_MODEL_1)│
 *   │                                                                         │
 *   │  STAGE 2  POST /generate-verdict (Dynamic Text-Only Cascade)            │
 *   │    Step 1 → Gemini Direct  (GEMINI_API_KEY_CURRENT × GEMINI_TEXT_MODEL_N)    │
 *   │    Step 2 → Gemini Direct  (GEMINI_API_KEY_NEW     × GEMINI_TEXT_MODEL_N)    │
 *   │    Step 3 → OpenAI Direct  [Future Guard]                               │
 *   │    Step 4 → DeepSeek Direct [Future Guard]                              │
 *   │    Step 5 → OpenRouter     (OPENROUTER_TEXT_MODEL_N)                    │
 *   │    Step 6 → Groq           Final Fallback                               │
 *   │                                                                         │
 *   │  STABLE   POST /analyze-formula  → GROQ_API_KEY + GROQ_TEXT_MODEL       │
 *   │  LIBRARY  POST /search-ingredient → GROQ_API_KEY + GROQ_TEXT_MODEL      │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 * Model discovery: getModelsByPrefix('GEMINI_VISION_MODEL_') scans process.env
 * for _1, _2, _3 … suffixed keys and returns them in sorted numeric order.
 *
 * Future provider guard: OpenAI Direct and DeepSeek Direct are only activated
 * when both their API key AND at least one numbered model key are present in
 * process.env. If either is absent the provider is silently skipped (no throw).
 *
 * Policy: exactly 1 attempt per tier. No rigid request timeouts — connections
 * stay open until the engine streams its full response payload.
 */

const express = require('express');
const router = express.Router();

const {
  FACE_ANALYSIS_SYSTEM_PROMPT,
  VERDICT_SYSTEM_PROMPT,
  FORMULA_SYSTEM_PROMPT,
} = require('../prompts');

// ── Env helpers — trim so spaced .env values (e.g. " KEY") still bind ────────
const env = (key) => String(process.env[key] ?? '').trim();

const getKeys = () => ({
  groq: env('GROQ_API_KEY'),
  groqNew: env('GROQ_API_KEY_NEW'),
  geminiCurrent: env('GEMINI_API_KEY_CURRENT'),
  geminiNew: env('GEMINI_API_KEY_NEW'),
  openrouter: env('OPENROUTER_API_KEY'),
  openai: env('OPENAI_API_KEY'),       // Future guard — empty string = disabled
  deepseek: env('DEEPSEEK_API_KEY'),   // Future guard — empty string = disabled
});

/**
 * Scan process.env for all keys that start with `prefix`, sort them numerically
 * by their numeric suffix (_1, _2, _3 …), and return an ordered array of the
 * resolved model name strings (empty values are filtered out).
 *
 * @param {string} prefix  e.g. 'GEMINI_VISION_MODEL_'
 * @returns {string[]}     e.g. ['gemini-3.6-flash', 'gemini-3.5-flash-lite']
 */
function getModelsByPrefix(prefix) {
  return Object.keys(process.env)
    .filter((k) => k.startsWith(prefix))
    .sort((a, b) => {
      const numA = parseInt(a.slice(prefix.length), 10);
      const numB = parseInt(b.slice(prefix.length), 10);
      return (isNaN(numA) ? 999 : numA) - (isNaN(numB) ? 999 : numB);
    })
    .map((k) => env(k))
    .filter(Boolean);
}

/** Legacy static model map — used ONLY by the stable /analyze-formula and
 *  /search-ingredient routes which are not part of the dynamic cascade. */
const getModels = () => ({
  gemini:                    env('GEMINI_MODEL')                      || 'gemini-3.5-flash',
  geminiVisionPrimary:       env('GEMINI_VISION_MODEL_PRIMARY')       || 'gemini-2.5-flash',
  geminiVisionSecondary:     env('GEMINI_VISION_MODEL_SECONDARY')     || 'gemini-3.5-flash',
  openrouterVisionPrimary:   env('OPENROUTER_VISION_MODEL_PRIMARY')   || 'google/gemini-2.5-flash',
  openrouterVisionSecondary: env('OPENROUTER_VISION_MODEL_SECONDARY') || 'google/gemini-3.5-flash',
  groqText:                  env('GROQ_TEXT_MODEL')                   || 'llama-3.3-70b-versatile',
});

// Transient / quota / auth / server-side failures that should trip failover
const FAILOVER_STATUSES = new Set([401, 404, 429, 500, 502, 503, 504]);

// ── Fallback payloads (keep the UI alive when AI JSON is unrecoverable) ──────
const FACE_ANALYSIS_FALLBACK = {
  skin_type: 'combination',
  severity: 'mild',
  zones: ['full face'],
  detected_concerns: ['General skin assessment'],
  questions: [
    {
      id: 'q1',
      question: 'What is your primary skin concern right now?',
      options: ['Active breakouts / acne', 'Dryness or flaking', 'Oiliness or shine', 'Uneven tone or texture'],
    },
    {
      id: 'q2',
      question: 'How sensitive is your skin to new active ingredients?',
      options: ['Very reactive — burns or stings easily', 'Mildly sensitive — occasional redness', 'Normal — tolerates most products', 'Not sure — never tested actives'],
    },
    {
      id: 'q3',
      question: 'What does your current morning and night skincare routine look like?',
      options: ['Minimal — just cleanser & moisturiser', 'Intermediate — 3–5 targeted products', 'Advanced — multiple serums & actives', 'No routine at the moment'],
    },
    {
      id: 'q4',
      question: 'Do you have any known ingredient allergies or sensitivities?',
      options: ['Fragrance or essential oils', 'Nuts, seeds or plant extracts', 'Acids (AHAs / BHAs / retinol)', 'None known'],
    },
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

const LIBRARY_SEARCH_FALLBACK = {
  ingredients: [],
  _fallback: true,
};

// Prompt overlay for Ingredient Library search — reuses FORMULA schema keys
const LIBRARY_SEARCH_SYSTEM_PROMPT = `${FORMULA_SYSTEM_PROMPT}

ADDITIONAL LIBRARY SEARCH RULES:
- The user is searching the Ingredient Library by name/token, NOT submitting a full product formula.
- Return a JSON object with an "ingredients" array of 1–6 matching cosmetic ingredients.
- Each ingredient object MUST use these exact keys (library card contract):
  "name", "rating", "function", "notes"
- Optionally include "keywords" (space-separated search tokens) for UI filtering.
- "notes" is the short clinical description shown on the library card.
- "function" is the Function line on the library card.
- "rating" must be one of: "safe", "caution", "avoid".
- Ignore product_name / overall_score / overall_rating / summary / concerns / positives
  if not relevant — but ALWAYS return a top-level "ingredients" array.
- Prefer well-known INCI / cosmetic ingredient matches for the search tokens.`;

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

function isEmptyObject(value) {
  return (
    value == null ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  );
}

/**
 * Normalise the `questions` array from an AI response into a guaranteed
 * array of exactly 4 objects: { id, question, options[4] }.
 *
 * Handles all degraded formats the LLM might return:
 *   – Plain string  → converted to object; context-safe defaults injected for options
 *   – Object with missing / short options array → options filled with context-safe defaults
 *   – Fewer than 4 items → padded with fallback question objects
 *   – More than 4 items → truncated to 4
 */
const SAFE_DEFAULT_OPTIONS = [
  'Yes, significantly',
  'Moderate / Sometimes',
  'Mild / Rarely',
  'No / Not applicable',
];

function sanitizeQuestions(rawQuestions) {
  const fallbackQs = FACE_ANALYSIS_FALLBACK.questions;

  // Ensure we have an array to work with
  let questions = Array.isArray(rawQuestions) ? rawQuestions : [];

  // Normalise each element to { id, question, options[4] }
  questions = questions.map((item, idx) => {
    let id, questionText, options;

    if (typeof item === 'string') {
      // Legacy / degraded: plain string question, no options
      id = `q${idx + 1}`;
      questionText = item.trim();
      options = null;
    } else if (item && typeof item === 'object') {
      id = String(item.id || `q${idx + 1}`);
      questionText = String(item.question || item.text || item.q || '').trim();
      options = item.options;
    } else {
      id = `q${idx + 1}`;
      questionText = '';
      options = null;
    }

    // Fall back to fallback question text if empty
    if (!questionText) {
      questionText = (fallbackQs[idx] || fallbackQs[0]).question;
    }

    // Sanitise options array
    if (!Array.isArray(options) || options.length < 2) {
      // Use fallback question's options if available, otherwise generic safe defaults
      options = (fallbackQs[idx] && Array.isArray(fallbackQs[idx].options))
        ? fallbackQs[idx].options
        : [...SAFE_DEFAULT_OPTIONS];
    } else {
      // Normalise each option to a non-empty string; pad if needed
      options = options
        .map((o) => String(o ?? '').trim())
        .filter((o) => o.length > 0)
        .slice(0, 4);
      while (options.length < 4) {
        options.push(SAFE_DEFAULT_OPTIONS[options.length] || 'N/A');
      }
    }

    return { id, question: questionText, options };
  });

  // Pad to exactly 4 if fewer questions came back
  while (questions.length < 4) {
    const fb = fallbackQs[questions.length] || fallbackQs[0];
    questions.push({ ...fb });
  }

  // Cap at exactly 4
  return questions.slice(0, 4);
}

/** Quiet schema check used by Stage 2 tier validate (no console spam). */
function isValidVerdictPayload(rawText) {
  if (!rawText || !String(rawText).trim()) return false;
  try {
    const cleaned = basicSanitize(extractJSONObject(stripMarkdownFences(String(rawText))));
    const parsed = JSON.parse(cleaned);
    return !isEmptyObject(parsed) && !!parsed.top_winner && Array.isArray(parsed.alternatives);
  } catch {
    return false;
  }
}

/**
 * Run tiers sequentially — exactly 1 attempt each.
 * On HTTP/quota/server failure the error is caught silently and the next tier runs.
 */
async function runTripleFailover(label, tiers) {
  let lastError;

  for (const tier of tiers) {
    try {
      console.log(`[AI] ${tier.name}...`);
      const result = await tier.run();
      if (tier.validate && !tier.validate(result)) {
        throw new Error(`${tier.name} returned an empty or invalid payload`);
      }
      console.log(`[AI] ${tier.name} ✓ succeeded`);
      return result;
    } catch (err) {
      lastError = err;
      console.warn(`[AI] ${tier.name} ✗ failed — ${err.message}`);
      // Continue silently to next tier
    }
  }

  throw lastError || new Error(`${label}: all failover tiers exhausted`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  GEMINI ENGINE — single-shot (1 attempt). Stage 1 & Stage 2 Gemini tiers.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} systemPrompt
 * @param {string} userText
 * @param {string|null} imageBase64
 * @param {string} apiKey          - GEMINI_API_KEY_CURRENT or GEMINI_API_KEY_NEW
 * @param {string} [modelOverride] - Override the default model (e.g. 'gemini-2.5-flash')
 * @returns {Promise<string>}
 */
async function callGemini(systemPrompt, userText, imageBase64, apiKey, modelOverride) {
  const { gemini: defaultModel } = getModels();
  const model = modelOverride || defaultModel;

  if (!apiKey) {
    throw new Error('Gemini API key is not configured in .env');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

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

  // No AbortController timeout — stay open until the engine finishes streaming.
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    const err = new Error(`Gemini API error ${res.status}: ${errBody}`);
    err.status = res.status;
    err.transient = FAILOVER_STATUSES.has(res.status);
    throw err;
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response body');
  return text;
}

// ═════════════════════════════════════════════════════════════════════════════
//  OPENROUTER ENGINE — single-shot vision. OpenAI-compatible REST via openrouter.ai.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userText
 * @param {string} opts.apiKey       - OPENROUTER_API_KEY
 * @param {string} opts.model        - e.g. 'google/gemini-2.5-flash'
 * @param {string|null} [opts.imageBase64]
 * @returns {Promise<string>}
 */
async function callOpenRouter({ systemPrompt, userText, apiKey, model, imageBase64 = null }) {
  if (!apiKey) {
    throw new Error('OpenRouter API key is not configured in .env (OPENROUTER_API_KEY)');
  }
  if (!model) {
    throw new Error('OpenRouter model name is required');
  }

  const endpoint = 'https://openrouter.ai/api/v1/chat/completions';

  let userContent;
  if (imageBase64) {
    userContent = [
      { type: 'text', text: userText },
      { type: 'image_url', image_url: { url: imageBase64 } },
    ];
  } else {
    userContent = userText;
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
  };

  // No AbortController timeout — stay open until the engine finishes streaming.
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://cosmolyze.app',
      'X-Title': 'Cosmolyze',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    const err = new Error(`OpenRouter API error ${res.status}: ${errBody}`);
    err.status = res.status;
    err.transient = FAILOVER_STATUSES.has(res.status);
    throw err;
  }

  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter returned an empty response body');
  return text;
}

// ═════════════════════════════════════════════════════════════════════════════
//  GROQ ENGINE — single-shot text + optional vision. OpenAI-compatible REST.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userText
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string|null} [opts.imageBase64]
 * @returns {Promise<string>}
 */
async function callGroq({ systemPrompt, userText, apiKey, model, imageBase64 = null }) {
  if (!apiKey) {
    throw new Error('Groq API key is not configured in .env');
  }
  if (!model) {
    throw new Error('Groq model is not configured in .env');
  }

  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';

  let userContent;
  if (imageBase64) {
    userContent = [
      { type: 'text', text: userText },
      { type: 'image_url', image_url: { url: imageBase64 } },
    ];
  } else {
    userContent = userText;
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
  };

  // No AbortController timeout — stay open until the engine finishes streaming.
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    const err = new Error(`Groq API error ${res.status}: ${errBody}`);
    err.status = res.status;
    err.transient = FAILOVER_STATUSES.has(res.status);
    throw err;
  }

  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned an empty response body');
  return text;
}

// ═════════════════════════════════════════════════════════════════════════════
//  OPENAI-COMPATIBLE ENGINE — covers both OpenAI Direct and DeepSeek Direct.
//  Pass baseURL='https://api.deepseek.com' for DeepSeek.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userText
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string|null} [opts.imageBase64]
 * @param {string} [opts.baseURL]  Defaults to 'https://api.openai.com/v1'
 * @returns {Promise<string>}
 */
async function callOpenAI({
  systemPrompt,
  userText,
  apiKey,
  model,
  imageBase64 = null,
  baseURL = 'https://api.openai.com/v1',
}) {
  if (!apiKey) throw new Error('OpenAI-compatible API key is not configured');
  if (!model)  throw new Error('OpenAI-compatible model name is required');

  const endpoint = `${baseURL.replace(/\/$/, '')}/chat/completions`;

  let userContent;
  if (imageBase64) {
    userContent = [
      { type: 'text', text: userText },
      { type: 'image_url', image_url: { url: imageBase64 } },
    ];
  } else {
    userContent = userText;
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
  };

  // No AbortController timeout — stay open until the engine finishes streaming.
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    const err = new Error(`OpenAI-compatible API error ${res.status}: ${errBody}`);
    err.status = res.status;
    err.transient = FAILOVER_STATUSES.has(res.status);
    throw err;
  }

  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI-compatible API returned an empty response body');
  return text;
}

/** Stable formula / library path — original GROQ_API_KEY + GROQ_TEXT_MODEL */
async function callGroqStable(systemPrompt, userText) {
  const keys = getKeys();
  const models = getModels();
  return callGroq({
    systemPrompt,
    userText,
    apiKey: keys.groq,
    model: models.groqText,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/ai/analyze-face  — STAGE 1 Dynamic Multi-Provider Vision Cascade
//  Body:   { imageBase64: "data:image/jpeg;base64,..." }
//  Response: { success: true, data: { detected_concerns, questions } }
//
//  Cascade order (built dynamically at request time from process.env):
//    Step 1 — Gemini Direct × GEMINI_VISION_MODEL_N (Current Key)
//    Step 2 — Gemini Direct × GEMINI_VISION_MODEL_N (New Key)
//    Step 3 — OpenAI Direct × OPENAI_VISION_MODEL_N  [future guard]
//    Step 4 — DeepSeek      × DEEPSEEK_VISION_MODEL_N [future guard]
//    Step 5 — OpenRouter    × OPENROUTER_VISION_MODEL_N
//    Step 6 — Groq          × GROQ_TEXT_MODEL_1 (final fallback)
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
    const keys = getKeys();

    // ── Resolve dynamic model lists from process.env ───────────────────────
    const geminiVisionModels   = getModelsByPrefix('GEMINI_VISION_MODEL_');
    const openaiVisionModels   = getModelsByPrefix('OPENAI_VISION_MODEL_');
    const deepseekVisionModels = getModelsByPrefix('DEEPSEEK_VISION_MODEL_');
    const orVisionModels       = getModelsByPrefix('OPENROUTER_VISION_MODEL_');
    const groqTextModels       = getModelsByPrefix('GROQ_TEXT_MODEL_');

    // Groq final fallback: prefer GROQ_TEXT_MODEL_1, else legacy GROQ_TEXT_MODEL
    const groqModel = groqTextModels[0] || env('GROQ_TEXT_MODEL') || 'llama-3.3-70b-versatile';
    const groqKey   = keys.groqNew || keys.groq;

    console.log('[AI] analyze-face: Stage 1 dynamic multi-provider cascade starting...');
    console.log(`[AI] Vision models — Gemini: [${geminiVisionModels}] | OR: [${orVisionModels}] | Groq fallback: ${groqModel}`);

    // ── Build the ordered tier list ────────────────────────────────────────
    const tiers = [];

    // Step 1: Gemini Direct — CURRENT key × all numbered GEMINI_VISION_MODEL_N
    for (const model of geminiVisionModels) {
      const m = model; // capture for closure
      tiers.push({
        name: `Stage 1 Attempting: ${m} via Current Key`,
        run: () => callGemini(FACE_ANALYSIS_SYSTEM_PROMPT, userText, imageBase64, keys.geminiCurrent, m),
      });
    }

    // Step 2: Gemini Direct — NEW key × all numbered GEMINI_VISION_MODEL_N
    for (const model of geminiVisionModels) {
      const m = model;
      tiers.push({
        name: `Stage 1 Attempting: ${m} via New Key`,
        run: () => callGemini(FACE_ANALYSIS_SYSTEM_PROMPT, userText, imageBase64, keys.geminiNew, m),
      });
    }

    // Step 3: OpenAI Direct — future guard (only when key + models are present)
    if (keys.openai && openaiVisionModels.length > 0) {
      for (const model of openaiVisionModels) {
        const m = model;
        tiers.push({
          name: `Stage 1 Attempting: ${m} via OpenAI Direct`,
          run: () =>
            callOpenAI({
              systemPrompt: FACE_ANALYSIS_SYSTEM_PROMPT,
              userText,
              apiKey: keys.openai,
              model: m,
              imageBase64,
            }),
        });
      }
    }

    // Step 4: DeepSeek Direct — future guard (only when key + models are present)
    if (keys.deepseek && deepseekVisionModels.length > 0) {
      for (const model of deepseekVisionModels) {
        const m = model;
        tiers.push({
          name: `Stage 1 Attempting: ${m} via DeepSeek Direct`,
          run: () =>
            callOpenAI({
              systemPrompt: FACE_ANALYSIS_SYSTEM_PROMPT,
              userText,
              apiKey: keys.deepseek,
              model: m,
              imageBase64,
              baseURL: 'https://api.deepseek.com',
            }),
        });
      }
    }

    // Step 5: OpenRouter — all numbered OPENROUTER_VISION_MODEL_N
    if (keys.openrouter && orVisionModels.length > 0) {
      for (const model of orVisionModels) {
        const m = model;
        tiers.push({
          name: `Stage 1 Attempting: ${m} via OpenRouter`,
          run: () =>
            callOpenRouter({
              systemPrompt: FACE_ANALYSIS_SYSTEM_PROMPT,
              userText,
              apiKey: keys.openrouter,
              model: m,
              imageBase64,
            }),
        });
      }
    }

    // Step 6: Groq — final fallback
    tiers.push({
      name: `Stage 1 Attempting: ${groqModel} via Groq (Final Fallback)`,
      run: () =>
        callGroq({
          systemPrompt: FACE_ANALYSIS_SYSTEM_PROMPT,
          userText,
          apiKey: groqKey,
          model: groqModel,
          imageBase64,
        }),
    });

    const raw = await runTripleFailover('analyze-face', tiers);

    let parsed;
    try {
      parsed = parseAIJSON(raw, FACE_ANALYSIS_FALLBACK, 'analyze-face');
    } catch (parseErr) {
      console.error('[AI] analyze-face unrecoverable parse:', parseErr.message);
      console.error('[AI] analyze-face raw_response:\n', raw);
      parsed = { ...FACE_ANALYSIS_FALLBACK };
    }

    // Sanitize questions — normalises strings, injects missing options, pads/trims to exactly 4
    parsed.questions = sanitizeQuestions(parsed.questions);

    if (parsed.questions.length !== 4) {
      console.warn('[AI] analyze-face: sanitizeQuestions could not produce 4 items — using fallback questions');
      parsed.questions = FACE_ANALYSIS_FALLBACK.questions;
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
        skin_type: parsed.skin_type || FACE_ANALYSIS_FALLBACK.skin_type,
        severity: parsed.severity || FACE_ANALYSIS_FALLBACK.severity,
        zones: Array.isArray(parsed.zones) ? parsed.zones : FACE_ANALYSIS_FALLBACK.zones,
        detected_concerns: parsed.detected_concerns || [],
        questions: parsed.questions,
        ...(parsed._fallback ? { fallback: true } : {}),
      },
    });
  } catch (err) {
    console.error('[AI analyze-face Error]', err.message);
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
//  POST /api/ai/generate-verdict  — STAGE 2 Dynamic Multi-Provider Text Cascade
//  Body:   { answers: [str×4], budgetMin, budgetMax, faceReport: Stage1JSON }
//  CRITICAL: No imageBase64 — Stage 2 uses Stage 1 report + Q&A + budget only.
//  Response: { success: true, data: { top_winner, alternatives } }
//
//  Cascade order (built dynamically at request time from process.env):
//    Step 1 — Gemini Direct × GEMINI_TEXT_MODEL_N (Current Key)
//    Step 2 — Gemini Direct × GEMINI_TEXT_MODEL_N (New Key)
//    Step 3 — OpenAI Direct × OPENAI_TEXT_MODEL_N  [future guard]
//    Step 4 — DeepSeek      × DEEPSEEK_TEXT_MODEL_N [future guard]
//    Step 5 — OpenRouter    × OPENROUTER_TEXT_MODEL_N
//    Step 6 — Groq          × GROQ_TEXT_MODEL_1 (final fallback)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/generate-verdict', async (req, res) => {
  try {
    const {
      answers,
      budgetMin = 100,
      budgetMax = 3000,
      faceReport = null,
      stage1Report = null,
    } = req.body;

    // Reject accidental image payloads — Stage 2 is text-only
    if (req.body.imageBase64) {
      console.warn('[AI] generate-verdict: ignoring imageBase64 (Stage 2 is text-only)');
    }

    if (!Array.isArray(answers) || answers.length !== 4) {
      return res.status(400).json({
        success: false,
        message: 'answers must be an array of exactly 4 strings.',
      });
    }

    const report = faceReport || stage1Report || {};
    const reportJson = JSON.stringify(report);

    const userText = `
Stage 1 Clinical Face Report (JSON):
${reportJson}

Patient Diagnostic Questionnaire Responses:
1. ${answers[0] || 'No answer provided'}
2. ${answers[1] || 'No answer provided'}
3. ${answers[2] || 'No answer provided'}
4. ${answers[3] || 'No answer provided'}

Patient Budget Range: ₹${budgetMin} – ₹${budgetMax} INR

Using ONLY the Stage 1 report, questionnaire answers, and budget above (no image), generate the full clinical verdict JSON as instructed (top_winner + exactly 4 alternatives).
`.trim();

    const keys = getKeys();

    // ── Resolve dynamic model lists from process.env ───────────────────────
    const geminiTextModels   = getModelsByPrefix('GEMINI_TEXT_MODEL_');
    const openaiTextModels   = getModelsByPrefix('OPENAI_TEXT_MODEL_');
    const deepseekTextModels = getModelsByPrefix('DEEPSEEK_TEXT_MODEL_');
    const orTextModels       = getModelsByPrefix('OPENROUTER_TEXT_MODEL_');
    const groqTextModels     = getModelsByPrefix('GROQ_TEXT_MODEL_');

    // If no numbered GEMINI_TEXT_MODEL_N keys exist, fall back to legacy GEMINI_MODEL
    const geminiModelFallback = env('GEMINI_MODEL') || 'gemini-3.5-flash';
    const effectiveGeminiModels = geminiTextModels.length > 0 ? geminiTextModels : [geminiModelFallback];

    // Groq final fallback: prefer GROQ_TEXT_MODEL_1, else legacy GROQ_TEXT_MODEL
    const groqModel = groqTextModels[0] || env('GROQ_TEXT_MODEL') || 'llama-3.3-70b-versatile';
    const groqKey   = keys.groqNew || keys.groq;

    console.log('[AI] generate-verdict: Stage 2 dynamic multi-provider cascade (text-only), budget ₹', budgetMin, '–', budgetMax);
    console.log(`[AI] Text models — Gemini: [${effectiveGeminiModels}] | OR: [${orTextModels}] | Groq fallback: ${groqModel}`);

    // ── Build the ordered tier list ────────────────────────────────────────
    const tiers = [];

    // Step 1: Gemini Direct — CURRENT key × all effective Gemini text models
    for (const model of effectiveGeminiModels) {
      const m = model;
      tiers.push({
        name: `Stage 2 Attempting: ${m} via Current Key`,
        run: () => callGemini(VERDICT_SYSTEM_PROMPT, userText, null, keys.geminiCurrent, m),
        validate: (text) => isValidVerdictPayload(text),
      });
    }

    // Step 2: Gemini Direct — NEW key × all effective Gemini text models
    for (const model of effectiveGeminiModels) {
      const m = model;
      tiers.push({
        name: `Stage 2 Attempting: ${m} via New Key`,
        run: () => callGemini(VERDICT_SYSTEM_PROMPT, userText, null, keys.geminiNew, m),
        validate: (text) => isValidVerdictPayload(text),
      });
    }

    // Step 3: OpenAI Direct — future guard (only when key + models are present)
    if (keys.openai && openaiTextModels.length > 0) {
      for (const model of openaiTextModels) {
        const m = model;
        tiers.push({
          name: `Stage 2 Attempting: ${m} via OpenAI Direct`,
          run: () =>
            callOpenAI({
              systemPrompt: VERDICT_SYSTEM_PROMPT,
              userText,
              apiKey: keys.openai,
              model: m,
            }),
          validate: (text) => isValidVerdictPayload(text),
        });
      }
    }

    // Step 4: DeepSeek Direct — future guard (only when key + models are present)
    if (keys.deepseek && deepseekTextModels.length > 0) {
      for (const model of deepseekTextModels) {
        const m = model;
        tiers.push({
          name: `Stage 2 Attempting: ${m} via DeepSeek Direct`,
          run: () =>
            callOpenAI({
              systemPrompt: VERDICT_SYSTEM_PROMPT,
              userText,
              apiKey: keys.deepseek,
              model: m,
              baseURL: 'https://api.deepseek.com',
            }),
          validate: (text) => isValidVerdictPayload(text),
        });
      }
    }

    // Step 5: OpenRouter — all numbered OPENROUTER_TEXT_MODEL_N
    if (keys.openrouter && orTextModels.length > 0) {
      for (const model of orTextModels) {
        const m = model;
        tiers.push({
          name: `Stage 2 Attempting: ${m} via OpenRouter`,
          run: () =>
            callOpenRouter({
              systemPrompt: VERDICT_SYSTEM_PROMPT,
              userText,
              apiKey: keys.openrouter,
              model: m,
            }),
          validate: (text) => isValidVerdictPayload(text),
        });
      }
    }

    // Step 6: Groq — final fallback (no validate — accept whatever Groq returns)
    tiers.push({
      name: `Stage 2 Attempting: ${groqModel} via Groq (Final Fallback)`,
      run: () =>
        callGroq({
          systemPrompt: VERDICT_SYSTEM_PROMPT,
          userText,
          apiKey: groqKey,
          model: groqModel,
        }),
    });

    const raw = await runTripleFailover('generate-verdict', tiers);

    let parsed;
    try {
      parsed = parseAIJSON(raw, VERDICT_FALLBACK, 'generate-verdict');
    } catch (parseErr) {
      console.error('[AI] generate-verdict unrecoverable parse:', parseErr.message);
      console.error('[AI] generate-verdict raw_response:\n', raw);
      parsed = { ...VERDICT_FALLBACK };
    }

    if (!parsed.top_winner || !Array.isArray(parsed.alternatives) || isEmptyObject(parsed)) {
      console.warn('[AI] generate-verdict: unexpected shape — applying full verdict fallback');
      parsed = { ...VERDICT_FALLBACK };
    }

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
    return res.status(200).json({
      success: true,
      data: { ...VERDICT_FALLBACK },
      fallback: true,
      message: `Verdict generation degraded: ${err.message}`,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/ai/analyze-formula  — STABLE (unchanged behaviour)
//  Engine: GROQ_API_KEY + GROQ_TEXT_MODEL
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

    console.log('[AI] analyze-formula: routing to Groq stable (GROQ_API_KEY) for:', productName || 'unnamed product');
    const raw = await callGroqStable(FORMULA_SYSTEM_PROMPT, userText);

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
    return res.status(200).json({
      success: true,
      data: {
        ...FORMULA_FALLBACK,
        product_name: (req.body && req.body.productName) || 'Unknown Product',
        summary: `Formula analysis degraded: ${err.message}`,
      },
      fallback: true,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/ai/search-ingredient  — Ingredient Library Engine
//  Engine: GROQ_API_KEY + GROQ_TEXT_MODEL (FORMULA_SYSTEM_PROMPT structure)
//  Body:   { query: string }
//  Response: { success: true, data: { ingredients: [{ name, rating, function, notes, keywords }] } }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/search-ingredient', async (req, res) => {
  try {
    const query = String(req.body?.query ?? req.body?.q ?? req.body?.search ?? '').trim();

    if (!query || query.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'query is required and must be at least 2 characters.',
      });
    }

    const userText = `
Ingredient Library search tokens: "${query}"

Analyse these search tokens and return a JSON object whose "ingredients" array lists the best-matching cosmetic ingredients for the library cards.
Each item must include: name, rating, function, notes (and optionally keywords).
`.trim();

    console.log('[AI] search-ingredient: Groq stable library lookup for:', query);
    const raw = await callGroqStable(LIBRARY_SEARCH_SYSTEM_PROMPT, userText);

    let parsed;
    try {
      parsed = parseAIJSON(raw, LIBRARY_SEARCH_FALLBACK, 'search-ingredient');
    } catch (parseErr) {
      console.error('[AI] search-ingredient unrecoverable parse:', parseErr.message);
      console.error('[AI] search-ingredient raw_response:\n', raw);
      parsed = { ...LIBRARY_SEARCH_FALLBACK };
    }

    // Normalize to library card keys expected by the frontend grid
    let ingredients = Array.isArray(parsed.ingredients) ? parsed.ingredients : [];
    ingredients = ingredients
      .filter((ing) => ing && (ing.name || ing.ingredient_name))
      .map((ing) => {
        const name = String(ing.name || ing.ingredient_name || '').trim();
        const rating = ['safe', 'caution', 'avoid'].includes(String(ing.rating || '').toLowerCase())
          ? String(ing.rating).toLowerCase()
          : 'safe';
        const fn = String(ing.function || ing.func || 'Active ingredient').trim();
        const notes = String(ing.notes || ing.description || ing.summary || '').trim();
        const keywords = String(
          ing.keywords ||
          [name, fn, rating, query].filter(Boolean).join(' ')
        )
          .toLowerCase()
          .trim();

        return {
          name,
          rating,
          function: fn,
          notes,
          keywords,
          // Aliases that mirror static library card fields
          description: notes,
        };
      });

    console.log('[AI] search-ingredient: success —', ingredients.length, 'results for', query);
    return res.status(200).json({
      success: true,
      data: {
        query,
        ingredients,
        ...(parsed._fallback ? { fallback: true } : {}),
      },
    });
  } catch (err) {
    console.error('[AI search-ingredient Error]', err.message);
    return res.status(200).json({
      success: true,
      data: {
        query: String(req.body?.query ?? ''),
        ingredients: [],
        fallback: true,
        message: `Ingredient search degraded: ${err.message}`,
      },
    });
  }
});

module.exports = router;
