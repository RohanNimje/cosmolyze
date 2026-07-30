/**
 * routes/ai.js â€” Cosmolyze Hybrid AI Engine
 *
 * Dynamic Multi-Provider Failover Architecture:
 *   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
 *   â”‚  STAGE 1  POST /analyze-face  (Dynamic Vision Cascade)                  â”‚
 *   â”‚    Step 1 â†’ Gemini Direct  (GEMINI_API_KEY_CURRENT Ã— GEMINI_VISION_MODEL_N) â”‚
 *   â”‚    Step 2 â†’ Gemini Direct  (GEMINI_API_KEY_NEW     Ã— GEMINI_VISION_MODEL_N) â”‚
 *   â”‚    Step 3 â†’ OpenAI Direct  (OPENAI_API_KEY         Ã— OPENAI_VISION_MODEL_N) â”‚
 *   â”‚             [Future Guard â€” skipped silently if key/models absent]      â”‚
 *   â”‚    Step 4 â†’ DeepSeek Direct (DEEPSEEK_API_KEY      Ã— DEEPSEEK_VISION_MODEL_N)â”‚
 *   â”‚             [Future Guard â€” skipped silently if key/models absent]      â”‚
 *   â”‚    Step 5 â†’ OpenRouter     (OPENROUTER_API_KEY     Ã— OPENROUTER_VISION_MODEL_N)â”‚
 *   â”‚    Step 6 â†’ Groq           (GROQ_API_KEY_NEW|GROQ_API_KEY Ã— GROQ_TEXT_MODEL_1)â”‚
 *   â”‚                                                                         â”‚
 *   â”‚  STAGE 2  POST /generate-verdict (Dynamic Text-Only Cascade)            â”‚
 *   â”‚    Step 1 â†’ Gemini Direct  (GEMINI_API_KEY_CURRENT Ã— GEMINI_TEXT_MODEL_N)    â”‚
 *   â”‚    Step 2 â†’ Gemini Direct  (GEMINI_API_KEY_NEW     Ã— GEMINI_TEXT_MODEL_N)    â”‚
 *   â”‚    Step 3 â†’ OpenAI Direct  [Future Guard]                               â”‚
 *   â”‚    Step 4 â†’ DeepSeek Direct [Future Guard]                              â”‚
 *   â”‚    Step 5 â†’ OpenRouter     (OPENROUTER_TEXT_MODEL_N)                    â”‚
 *   â”‚    Step 6 â†’ Groq           Final Fallback                               â”‚
 *   â”‚                                                                         â”‚
 *   â”‚  STABLE   POST /analyze-formula  â†’ GROQ_API_KEY + GROQ_TEXT_MODEL       â”‚
 *   â”‚  LIBRARY  POST /search-ingredient â†’ GROQ_API_KEY + GROQ_TEXT_MODEL      â”‚
 *   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
 *
 * Model discovery: getModelsByPrefix('GEMINI_VISION_MODEL_') scans process.env
 * for _1, _2, _3 â€¦ suffixed keys and returns them in sorted numeric order.
 *
 * Future provider guard: OpenAI Direct and DeepSeek Direct are only activated
 * when both their API key AND at least one numbered model key are present in
 * process.env. If either is absent the provider is silently skipped (no throw).
 *
 * Policy: exactly 1 attempt per tier. No rigid request timeouts â€” connections
 * stay open until the engine streams its full response payload.
 */

const express = require('express');
const router = express.Router();

const {
  FACE_ANALYSIS_SYSTEM_PROMPT,
  VERDICT_SYSTEM_PROMPT,
  FORMULA_SYSTEM_PROMPT,
} = require('../prompts');

// â”€â”€ Env helpers â€” trim so spaced .env values (e.g. " KEY") still bind â”€â”€â”€â”€â”€â”€â”€â”€
const env = (key) => String(process.env[key] ?? '').trim();

const getKeys = () => ({
  groq: env('GROQ_API_KEY'),
  groqNew: env('GROQ_API_KEY_NEW'),
  geminiCurrent: env('GEMINI_API_KEY_CURRENT'),
  geminiNew: env('GEMINI_API_KEY_NEW'),
  openrouter: env('OPENROUTER_API_KEY'),
  openai: env('OPENAI_API_KEY'),       // Future guard â€” empty string = disabled
  deepseek: env('DEEPSEEK_API_KEY'),   // Future guard â€” empty string = disabled
});

/**
 * Scan process.env for all keys that start with `prefix`, sort them numerically
 * by their numeric suffix (_1, _2, _3 â€¦), and return an ordered array of the
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

/** Legacy static model map â€” used ONLY by the stable /analyze-formula and
 *  /search-ingredient routes which are not part of the dynamic cascade. */
const getModels = () => ({
  gemini: env('GEMINI_MODEL') || 'gemini-3.5-flash',
  geminiVisionPrimary: env('GEMINI_VISION_MODEL_PRIMARY') || 'gemini-2.5-flash',
  geminiVisionSecondary: env('GEMINI_VISION_MODEL_SECONDARY') || 'gemini-3.5-flash',
  openrouterVisionPrimary: env('OPENROUTER_VISION_MODEL_PRIMARY') || 'google/gemini-2.5-flash',
  openrouterVisionSecondary: env('OPENROUTER_VISION_MODEL_SECONDARY') || 'google/gemini-3.5-flash',
  groqText: env('GROQ_TEXT_MODEL') || 'llama-3.3-70b-versatile',
});

// Transient / quota / auth / server-side failures that should trip failover
const FAILOVER_STATUSES = new Set([401, 404, 429, 500, 502, 503, 504]);

// â”€â”€ Fallback payloads (keep the UI alive when AI JSON is unrecoverable) â”€â”€â”€â”€â”€â”€
const FACE_ANALYSIS_FALLBACK = {
  skin_type: 'combination',
  severity: 'mild',
  zones: ['full face'],
  detected_concerns: ['General skin assessment'],
  clinical_observation: 'Upon reviewing the localized scan, the skin presents with general surface irregularities. A full analysis requires additional context from your diagnostic questionnaire.',
  root_causes: [
    { title: 'Surface Layer Build-up', explanation: 'Accumulated dead skin cells and environmental residue can impair the skin barrier and affect overall clarity.' },
    { title: 'Hydration Imbalance', explanation: 'Disruption in the skin\'s natural moisture-retention capacity can exacerbate visible surface concerns.' },
  ],
  recovery_plan: [
    { title: 'STEP 1: LIFESTYLE & HABIT CORRECTION', details: 'Maintain adequate hydration and protect the affected area from unnecessary friction and UV exposure to prevent further aggravation of the detected concern.' },
    { title: 'STEP 2: TOPICAL HOME CARE', details: 'Apply specific localized treatments as recommended in the active ingredients section to safely target the root cause of the concern.' },
  ],
  required_actives: [
    { name: 'Niacinamide (10%)', function: 'Regulates sebum production, reduces surface redness, and strengthens the skin barrier over time.' },
    { name: 'Hyaluronic Acid (2%)', function: 'Draws moisture into the epidermis to plump and maintain healthy skin hydration levels.' },
  ],
  questions: [
    {
      id: 'q1',
      question: 'What is your primary skin concern right now?',
      options: ['Active breakouts / acne', 'Dryness or flaking', 'Oiliness or shine', 'Uneven tone or texture'],
    },
    {
      id: 'q2',
      question: 'How sensitive is your skin to new active ingredients?',
      options: ['Very reactive â€” burns or stings easily', 'Mildly sensitive â€” occasional redness', 'Normal â€” tolerates most products', 'Not sure â€” never tested actives'],
    },
    {
      id: 'q3',
      question: 'What does your current morning and night skincare routine look like?',
      options: ['Minimal â€” just cleanser & moisturiser', 'Intermediate â€” 3â€“5 targeted products', 'Advanced â€” multiple serums & actives', 'No routine at the moment'],
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
      medical_alert: 'Potent acids â€” avoid on compromised, sensitive, or barrier-impaired skin.',
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
  concerns: ['Automated parse incomplete â€” re-analyse for precise sensitizer detection'],
  positives: ['Re-submit the ingredient list to receive a full clinical audit'],
  ingredients: [],
  _fallback: true,
};

const LIBRARY_SEARCH_FALLBACK = {
  ingredients: [],
  _fallback: true,
};

// Prompt overlay for Ingredient Library search â€” reuses FORMULA schema keys
const LIBRARY_SEARCH_SYSTEM_PROMPT = `${FORMULA_SYSTEM_PROMPT}

ADDITIONAL LIBRARY SEARCH RULES:
- The user is searching the Ingredient Library by name/token, NOT submitting a full product formula.
- Return a JSON object with an "ingredients" array of 1â€“6 matching cosmetic ingredients.
- Each ingredient object MUST use these exact keys (library card contract):
  "name", "rating", "function", "notes"
- Optionally include "keywords" (space-separated search tokens) for UI filtering.
- "notes" is the short clinical description shown on the library card.
- "function" is the Function line on the library card.
- "rating" must be one of: "safe", "caution", "avoid".
- Ignore product_name / overall_score / overall_rating / summary / concerns / positives
  if not relevant â€” but ALWAYS return a top-level "ingredients" array.
- Prefer well-known INCI / cosmetic ingredient matches for the search tokens.`;

// â”€â”€ JSON sanitization helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
 *
 * Sanitization pipeline:
 *   Pass 1: Strip markdown fences → extract JSON object → basic sanitize (trailing commas, BOM, smart quotes)
 *   Pass 2: Fix unescaped quotes and control characters
 *   Pass 3: Balance unclosed brackets/braces
 *   Pass 4: Aggressive trailing-comma sweep + final quote fix + rebalance
 *   Pass 5: Full-pipeline re-run from scratch with aggressive comma stripping
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

  // Pass 1: standard sanitization chain
  let cleaned = basicSanitize(extractJSONObject(stripMarkdownFences(raw_response)));
  let result = tryParse(cleaned, 'basic-sanitize');
  if (result.ok) return result.value;

  // Pass 2: fix unescaped quotes and control chars
  const quoteFixed = fixUnescapedQuotesAndControls(cleaned);
  result = tryParse(quoteFixed, 'quote-fix');
  if (result.ok) return result.value;

  // Pass 3: balance brackets
  const balanced = balanceBrackets(quoteFixed);
  result = tryParse(balanced, 'balance-brackets');
  if (result.ok) return result.value;

  // Pass 4: re-run basicSanitize (re-strips trailing commas created by bracket balancing)
  const lastPass = basicSanitize(fixUnescapedQuotesAndControls(balanced));
  result = tryParse(lastPass, 'final-pass');
  if (result.ok) return result.value;

  // Pass 5: aggressive multi-pattern trailing comma strip → rebalance
  const aggressiveCleaned = lastPass
    .replace(/,\s*([}\]])/g, '$1')   // trailing commas before } or ]
    .replace(/([{[,])\s*,/g, '$1')   // double commas
    .replace(/,\s*,/g, ',');          // consecutive commas
  const aggressiveBalanced = balanceBrackets(aggressiveCleaned);
  result = tryParse(aggressiveBalanced, 'aggressive-pass');
  if (result.ok) return result.value;

  // All passes exhausted — log detailed diagnostics
  console.error(`[AI] ${label} JSON.parse failed after all ${5} sanitization passes.`);
  console.error(`[AI] ${label} Final parse error: ${result.error.message}`);
  console.error(`[AI] ${label} Response length: ${raw_response.length} chars`);
  console.error(`[AI] ${label} Response preview (first 500 chars):\n${raw_response.slice(0, 500)}`);
  if (raw_response.length > 500) {
    console.error(`[AI] ${label} Response tail (last 300 chars):\n${raw_response.slice(-300)}`);
  }

  if (fallback && typeof fallback === 'object') {
    console.warn(`[AI] ${label}: All parse passes failed — returning structured fallback JSON (_fallback: true)`);
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
 *   â€“ Plain string  â†’ converted to object; context-safe defaults injected for options
 *   â€“ Object with missing / short options array â†’ options filled with context-safe defaults
 *   â€“ Fewer than 4 items â†’ padded with fallback question objects
 *   â€“ More than 4 items â†’ truncated to 4
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
 * Run tiers sequentially â€” exactly 1 attempt each.
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
      console.log(`[AI] ${tier.name} [SUCCESS] succeeded`);
      return result;
    } catch (err) {
      lastError = err;
      console.warn(`[AI] ${tier.name} [FAILED] failed - ${err.message}`);
      // Continue silently to next tier
    }
  }

  throw lastError || new Error(`${label}: all failover tiers exhausted`);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  GEMINI ENGINE â€” single-shot (1 attempt). Stage 1 & Stage 2 Gemini tiers.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
    if (!match) throw new Error('Invalid imageBase64 format â€” expected a valid data URI');
    const [, mimeType, b64data] = match;
    parts.push({ inline_data: { mime_type: mimeType, data: b64data } });
  }

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    },
  };

  // No AbortController timeout â€” stay open until the engine finishes streaming.
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  OPENROUTER ENGINE â€” single-shot vision. OpenAI-compatible REST via openrouter.ai.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
    temperature: 0,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
  };

  // No AbortController timeout â€” stay open until the engine finishes streaming.
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  GROQ ENGINE â€” single-shot text + optional vision. OpenAI-compatible REST.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
    temperature: 0,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
  };

  // No AbortController timeout â€” stay open until the engine finishes streaming.
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  OPENAI-COMPATIBLE ENGINE â€” covers both OpenAI Direct and DeepSeek Direct.
//  Pass baseURL='https://api.deepseek.com' for DeepSeek.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
  if (!model) throw new Error('OpenAI-compatible model name is required');

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
    temperature: 0,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
  };

  // No AbortController timeout â€” stay open until the engine finishes streaming.
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

/** Stable formula / library path â€” original GROQ_API_KEY + GROQ_TEXT_MODEL */
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  ROUTES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  POST /api/ai/analyze-face  â€” STAGE 1 Dynamic Multi-Provider Vision Cascade
//  Body:   { imageBase64: "data:image/jpeg;base64,..." }
//  Response: { success: true, data: { detected_concerns, questions } }
//
//  Cascade order (built dynamically at request time from process.env):
//    Step 1 â€” Gemini Direct Ã— GEMINI_VISION_MODEL_N (Current Key)
//    Step 2 â€” Gemini Direct Ã— GEMINI_VISION_MODEL_N (New Key)
//    Step 3 â€” OpenAI Direct Ã— OPENAI_VISION_MODEL_N  [future guard]
//    Step 4 â€” DeepSeek      Ã— DEEPSEEK_VISION_MODEL_N [future guard]
//    Step 5 â€” OpenRouter    Ã— OPENROUTER_VISION_MODEL_N
//    Step 6 â€” Groq          Ã— GROQ_TEXT_MODEL_1 (final fallback)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Resolve dynamic model lists from process.env â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const geminiVisionModels = getModelsByPrefix('GEMINI_VISION_MODEL_');
    const openaiVisionModels = getModelsByPrefix('OPENAI_VISION_MODEL_');
    const deepseekVisionModels = getModelsByPrefix('DEEPSEEK_VISION_MODEL_');
    const orVisionModels = getModelsByPrefix('OPENROUTER_VISION_MODEL_');
    const groqTextModels = getModelsByPrefix('GROQ_TEXT_MODEL_');

    // Groq final fallback: prefer GROQ_TEXT_MODEL_1, else legacy GROQ_TEXT_MODEL
    const groqModel = groqTextModels[0] || env('GROQ_TEXT_MODEL') || 'llama-3.3-70b-versatile';
    const groqKey = keys.groqNew || keys.groq;

    console.log('[AI] analyze-face: Stage 1 dynamic multi-provider cascade starting...');
    console.log(`[AI] Vision models â€” Gemini: [${geminiVisionModels}] | OR: [${orVisionModels}] | Groq fallback: ${groqModel}`);

    // â”€â”€ Build the ordered tier list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const tiers = [];

    // Step 1: Gemini Direct â€” CURRENT key Ã— all numbered GEMINI_VISION_MODEL_N
    for (const model of geminiVisionModels) {
      const m = model; // capture for closure
      tiers.push({
        name: `Stage 1 Attempting: ${m} via Current Key`,
        run: () => callGemini(FACE_ANALYSIS_SYSTEM_PROMPT, userText, imageBase64, keys.geminiCurrent, m),
      });
    }

    // Step 2: Gemini Direct â€” NEW key Ã— all numbered GEMINI_VISION_MODEL_N
    for (const model of geminiVisionModels) {
      const m = model;
      tiers.push({
        name: `Stage 1 Attempting: ${m} via New Key`,
        run: () => callGemini(FACE_ANALYSIS_SYSTEM_PROMPT, userText, imageBase64, keys.geminiNew, m),
      });
    }

    // Step 3: OpenAI Direct â€” future guard (only when key + models are present)
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

    // Step 4: DeepSeek Direct â€” future guard (only when key + models are present)
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

    // Step 5: OpenRouter â€” all numbered OPENROUTER_VISION_MODEL_N
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

    // Step 6: Groq â€” final fallback
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

    // Sanitize questions â€” normalises strings, injects missing options, pads/trims to exactly 4
    parsed.questions = sanitizeQuestions(parsed.questions);

    if (parsed.questions.length !== 4) {
      console.warn('[AI] analyze-face: sanitizeQuestions could not produce 4 items â€” using fallback questions');
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
        // Core scan metadata
        skin_type: parsed.skin_type_assessment || parsed.skin_type || FACE_ANALYSIS_FALLBACK.skin_type,
        severity: parsed.severity_level || parsed.severity || FACE_ANALYSIS_FALLBACK.severity,
        zones: Array.isArray(parsed.affected_zones) ? parsed.affected_zones
          : Array.isArray(parsed.zones) ? parsed.zones
            : FACE_ANALYSIS_FALLBACK.zones,
        detected_concerns: Array.isArray(parsed.detected_concerns) ? parsed.detected_concerns : [],
        // Clinical diagnostic report fields (new â€” passed through verbatim)
        clinical_observation: parsed.clinical_observation || FACE_ANALYSIS_FALLBACK.clinical_observation,
        root_causes: Array.isArray(parsed.root_causes) && parsed.root_causes.length
          ? parsed.root_causes
          : FACE_ANALYSIS_FALLBACK.root_causes,
        recovery_plan: Array.isArray(parsed.recovery_plan) && parsed.recovery_plan.length
          ? parsed.recovery_plan
          : FACE_ANALYSIS_FALLBACK.recovery_plan,
        required_actives: Array.isArray(parsed.required_actives) && parsed.required_actives.length
          ? parsed.required_actives
          : FACE_ANALYSIS_FALLBACK.required_actives,
        // Diagnostic questions
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  POST /api/ai/generate-verdict  â€” STAGE 2 Dynamic Multi-Provider Text Cascade
//  Body:   { answers: [strÃ—4], budgetMin, budgetMax, faceReport: Stage1JSON }
//  CRITICAL: No imageBase64 â€” Stage 2 uses Stage 1 report + Q&A + budget only.
//  Response: { success: true, data: { top_winner, alternatives } }
//
//  Cascade order (built dynamically at request time from process.env):
//    Step 1 â€” Gemini Direct Ã— GEMINI_TEXT_MODEL_N (Current Key)
//    Step 2 â€” Gemini Direct Ã— GEMINI_TEXT_MODEL_N (New Key)
//    Step 3 â€” OpenAI Direct Ã— OPENAI_TEXT_MODEL_N  [future guard]
//    Step 4 â€” DeepSeek      Ã— DEEPSEEK_TEXT_MODEL_N [future guard]
//    Step 5 â€” OpenRouter    Ã— OPENROUTER_TEXT_MODEL_N
//    Step 6 â€” Groq          Ã— GROQ_TEXT_MODEL_1 (final fallback)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/generate-verdict', async (req, res) => {
  try {
    const {
      answers,
      budgetMin = 100,
      budgetMax = 3000,
      faceReport = null,
      stage1Report = null,
    } = req.body;

    // Reject accidental image payloads â€” Stage 2 is text-only
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

    // â”€â”€ Extract and surface key Stage 1 fields explicitly for the LLM â”€â”€â”€â”€â”€
    const clinicalObs = report.clinical_observation || 'Not available';
    const requiredActives = Array.isArray(report.required_actives) && report.required_actives.length
      ? report.required_actives.map(a => `${a.name}: ${a.function}`).join('\n')
      : 'Not available';
    const rootCausesText = Array.isArray(report.root_causes) && report.root_causes.length
      ? report.root_causes.map(r => `${r.title}: ${r.explanation}`).join('\n')
      : 'Not available';
    const detectedConcerns = Array.isArray(report.detected_concerns)
      ? report.detected_concerns.join(', ')
      : 'Not available';

    const userText = `
STAGE 1 CLINICAL REPORT SUMMARY (read this first â€” your product picks must be anchored to this):
- Detected Concerns: ${detectedConcerns}
- Clinical Observation: ${clinicalObs}
- Root Causes:
${rootCausesText}
- Required Active Ingredients (your top_winner MUST contain these):
${requiredActives}

Stage 1 Full Report (JSON for reference):
${JSON.stringify(report)}

Patient Diagnostic Questionnaire Responses:
1. ${answers[0] || 'No answer provided'}
2. ${answers[1] || 'No answer provided'}
3. ${answers[2] || 'No answer provided'}
4. ${answers[3] || 'No answer provided'}

Patient Budget Range: â‚¹${budgetMin} â€“ â‚¹${budgetMax} INR

Using ONLY the Stage 1 report, questionnaire answers, and budget above (no image), generate the full clinical verdict JSON as instructed (top_winner + exactly 4 alternatives).
`.trim();

    const keys = getKeys();

    // â”€â”€ Resolve dynamic model lists from process.env â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const geminiTextModels = getModelsByPrefix('GEMINI_TEXT_MODEL_');
    const openaiTextModels = getModelsByPrefix('OPENAI_TEXT_MODEL_');
    const deepseekTextModels = getModelsByPrefix('DEEPSEEK_TEXT_MODEL_');
    const orTextModels = getModelsByPrefix('OPENROUTER_TEXT_MODEL_');
    const groqTextModels = getModelsByPrefix('GROQ_TEXT_MODEL_');

    // If no numbered GEMINI_TEXT_MODEL_N keys exist, fall back to legacy GEMINI_MODEL
    const geminiModelFallback = env('GEMINI_MODEL') || 'gemini-3.5-flash';
    const effectiveGeminiModels = geminiTextModels.length > 0 ? geminiTextModels : [geminiModelFallback];

    // Groq final fallback: prefer GROQ_TEXT_MODEL_1, else legacy GROQ_TEXT_MODEL
    const groqModel = groqTextModels[0] || env('GROQ_TEXT_MODEL') || 'llama-3.3-70b-versatile';
    const groqKey = keys.groqNew || keys.groq;

    console.log('[AI] generate-verdict: Stage 2 dynamic multi-provider cascade (text-only), budget INR', budgetMin, '-', budgetMax);
    console.log(`[AI] Text models â€” Gemini: [${effectiveGeminiModels}] | OR: [${orTextModels}] | Groq fallback: ${groqModel}`);

    // â”€â”€ Build the ordered tier list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const tiers = [];

    // Step 1: Gemini Direct â€” CURRENT key Ã— all effective Gemini text models
    for (const model of effectiveGeminiModels) {
      const m = model;
      tiers.push({
        name: `Stage 2 Attempting: ${m} via Current Key`,
        run: () => callGemini(VERDICT_SYSTEM_PROMPT, userText, null, keys.geminiCurrent, m),
        validate: (text) => isValidVerdictPayload(text),
      });
    }

    // Step 2: Gemini Direct â€” NEW key Ã— all effective Gemini text models
    for (const model of effectiveGeminiModels) {
      const m = model;
      tiers.push({
        name: `Stage 2 Attempting: ${m} via New Key`,
        run: () => callGemini(VERDICT_SYSTEM_PROMPT, userText, null, keys.geminiNew, m),
        validate: (text) => isValidVerdictPayload(text),
      });
    }

    // Step 3: OpenAI Direct â€” future guard (only when key + models are present)
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

    // Step 4: DeepSeek Direct â€” future guard (only when key + models are present)
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

    // Step 5: OpenRouter â€” all numbered OPENROUTER_TEXT_MODEL_N
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

    // Step 6: Groq â€” final fallback (no validate â€” accept whatever Groq returns)
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
      console.warn('[AI] generate-verdict: unexpected shape â€” applying full verdict fallback');
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  POST /api/ai/analyze-formula  â€” STABLE (unchanged behaviour)
//  Engine: GROQ_API_KEY + GROQ_TEXT_MODEL
//  Body:   { productName?: string, ingredientList: string }
//  Response: { success: true, data: { summary, ingredients, concerns, positives } }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      console.warn('[AI] analyze-formula: missing ingredients array â€” applying fallback');
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  POST /api/ai/search-ingredient  â€” Ingredient Library Engine
//  Engine: GROQ_API_KEY + GROQ_TEXT_MODEL (FORMULA_SYSTEM_PROMPT structure)
//  Body:   { query: string }
//  Response: { success: true, data: { ingredients: [{ name, rating, function, notes, keywords }] } }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    console.log('[AI] search-ingredient: success â€”', ingredients.length, 'results for', query);
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
