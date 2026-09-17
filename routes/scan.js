/**
 * routes/scan.js — Cosmolyze Scan Routes
 *
 * Endpoints:
 *   POST /api/scan/save          → Persist a scan result + update user streak
 *   GET  /api/scan/history       → Return last 20 scans for the authed user
 *   POST /api/scan/product-image → Resolve a packshot via Google CSE (DDG
 *                                   fallback), MongoDB TTL cache, whitelist
 *                                   gate, sequential rate-limit, inflight dedup.
 *                                   Fallback paths are NEVER written to MongoDB.
 */

const express = require('express');
const protect = require('../middleware/auth');
const ScanResult = require('../models/ScanResult');
const User = require('../models/User');
const CachedProduct = require('../models/CachedProduct');

const router = express.Router();

// ── In-Memory Concurrency Lock (Thundering Herd prevention) ──────────────────
// Maps cache key → Promise<string|null> (live https URL or null on miss).
const inflightRequests = new Map();

// ── Sequential rate-limit queue (1000ms between product image fetches) ───────
const IMAGE_FETCH_GAP_MS = 1000;
const SEARCH_TIMEOUT_MS = 8000;
let imageFetchChain = Promise.resolve();
let lastImageFetchAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function enqueueSequentialImageFetch(taskFn) {
  const run = async () => {
    const elapsed = Date.now() - lastImageFetchAt;
    const waitMs = Math.max(0, IMAGE_FETCH_GAP_MS - elapsed);
    if (waitMs > 0) {
      console.log(`[Scan] Sequential image delay ${waitMs}ms before next product fetch...`);
      await sleep(waitMs);
    }
    lastImageFetchAt = Date.now();
    return taskFn();
  };

  const next = imageFetchChain.then(run, run);
  imageFetchChain = next.catch(() => null);
  return next;
}

// ── Client-only fallback — never persisted to CachedProduct ──────────────────
const FALLBACK_IMAGE = '/images/default-clinical-bottle.png';

const IMAGE_HOST_ALLOWLIST = [
  'media-amazon.com',
  'ssl-images-amazon.com',
  'images-amazon.com',
  'amazon.com',
  'amazon.in',
  'nykaa.com',
  'images-static.nykaa.com',
  'purplle.com',
  'flixcart.com',
  'rukminim1.flixcart.com',
  'rukminim2.flixcart.com',
  'myntassets.com',
  'myntra.com',
  'sephora.com',
  'ulta.com',
  'cdn.shopify.com',
  'cloudinary.com',
  'googleusercontent.com',
  'loreal.com',
  'lorealparisusa.com',
  'lorealparis.co.in',
  'cerave.com',
  'bioderma.com',
  'theordinary.com',
  'deciem.com',
  'laroche-posay.us',
  'laroche-posay.in',
  'laroche-posay.com',
  'cetaphil.com',
  'neutrogena.com',
  'dotandkey.com',
  'beminimalist.co',
  'minimalist.com',
  'plumgoodness.com',
  'mamaearth.in',
];

/** Answer strings that were mistakenly saved as card titles */
const JUNK_SCAN_TITLES = new Set([
  'yes, clearly visible',
  'yes clearly visible',
  'no',
  'somewhat',
  'barely noticeable',
  'not sure',
  'no specific preference',
  'minimal routine',
  'none known',
  'general analysis',
]);

/**
 * Derive a clean dashboard card title from AI analysis + stored category.
 * Never uses raw questionnaire answers like "Yes, clearly visible".
 */
function resolveScanDisplayTitle(rawTitle, aiResult = {}) {
  const blob = [
    rawTitle,
    ...(Array.isArray(aiResult.detected_concerns) ? aiResult.detected_concerns : []),
    aiResult.top_winner?.product_name,
    aiResult.top_winner?.what_it_is,
    aiResult.top_winner?.expert_verdict,
    ...(Array.isArray(aiResult.top_winner?.key_benefits) ? aiResult.top_winner.key_benefits : []),
    ...(Array.isArray(aiResult.top_winner?.key_actives) ? aiResult.top_winner.key_actives : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/\b(acne|pimple|pimples|blemishes?|comedones?)\b/.test(blob)) {
    return 'Acne & Pimple Analysis';
  }
  if (/\b(texture|rough|pores?|uneven)\b/.test(blob)) {
    return 'Skin Texture Report';
  }

  const trimmed = String(rawTitle || '').trim();
  const normalized = trimmed.toLowerCase();

  // Legacy junk titles → clean clinical default
  if (!trimmed || JUNK_SCAN_TITLES.has(normalized) || /^(yes|no)\b/i.test(trimmed)) {
    return 'Clinical Skin Analysis';
  }

  // Keep already-good clinical titles
  if (/acne|pimple/i.test(trimmed)) return 'Acne & Pimple Analysis';
  if (/texture/i.test(trimmed)) return 'Skin Texture Report';
  if (/clinical|skin|analysis|report|hyperpigmentation|dryness|aging|blemish/i.test(trimmed)) {
    return trimmed;
  }

  return 'Clinical Skin Analysis';
}

function isDummyCachedImage(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return true;
  const normalized = imageUrl.trim().toLowerCase();
  return (
    !normalized.startsWith('https://') ||
    normalized === FALLBACK_IMAGE.toLowerCase() ||
    normalized.endsWith('/images/default-clinical-bottle.png') ||
    normalized.includes('default-clinical-bottle') ||
    normalized.startsWith('data:') ||
    normalized.includes('placeholder')
  );
}

function hostMatchesAllowlist(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return IMAGE_HOST_ALLOWLIST.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

/** Only live https packshots on verified retail / brand CDNs may be cached. */
function isCachableImageUrl(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return false;
  const trimmed = imageUrl.trim();
  if (isDummyCachedImage(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    return hostMatchesAllowlist(parsed.hostname);
  } catch {
    return false;
  }
}

function foldBrand(brand) {
  return String(brand || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’‘´`]/g, "'")
    .trim();
}

function sanitizeProductName(productName) {
  return String(productName || '')
    .replace(/%/g, ' ')
    .replace(/\+/g, ' ')
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|ml|mL|l|ltr|litres?|liters?|kg|g|gm|gr|grams?|oz)\b/gi,
      ' '
    )
    .replace(/[^a-zA-Z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildImageSearchQuery(brand, productName) {
  const cleanBrand = foldBrand(brand);
  const cleanName = sanitizeProductName(productName);
  const merged = [cleanBrand, cleanName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return `${merged} official packaging`;
}

function buildCacheKey(brand, productName) {
  return [foldBrand(brand), String(productName || '').trim()]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function fallbackPayload() {
  return {
    success: true,
    imageUrl: FALLBACK_IMAGE,
    fallback: true,
    fromCache: false,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const DDG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://duckduckgo.com/',
};

/**
 * Obtain a DuckDuckGo vqd token required by the i.js image endpoint.
 * @returns {Promise<string|null>}
 */
async function fetchDuckDuckGoVqd(query) {
  try {
    const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        ...DDG_HEADERS,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!res.ok) {
      console.warn(`[Scan] DDG vqd page failed with status ${res.status}`);
      return null;
    }

    const html = await res.text();
    const patterns = [
      /vqd=["']([^"']+)["']/i,
      /vqd=([\d-]+)&/i,
      /"vqd"\s*:\s*"([^"]+)"/i,
    ];

    for (const re of patterns) {
      const match = html.match(re);
      if (match && match[1]) return match[1];
    }

    console.warn('[Scan] DDG vqd token not found in response HTML');
    return null;
  } catch (err) {
    console.warn('[Scan] DDG vqd fetch error:', err.message);
    return null;
  }
}

function pickWhitelistedCandidate(candidates, logLabel) {
  for (const candidate of candidates) {
    if (isCachableImageUrl(candidate)) {
      console.log(`[Scan] ${logLabel} image accepted: ${candidate}`);
      return candidate;
    }
  }
  return null;
}

async function fetchImageFromGoogleCSE(searchQuery) {
  const apiKey = String(process.env.GOOGLE_CSE_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  const cx = String(process.env.GOOGLE_CSE_CX || process.env.GOOGLE_CSE_ID || '').trim();
  if (!apiKey || !cx) return null;

  const endpoint =
    'https://www.googleapis.com/customsearch/v1?' +
    new URLSearchParams({
      key: apiKey,
      cx,
      q: searchQuery,
      searchType: 'image',
      num: '8',
      safe: 'active',
      imgType: 'photo',
    }).toString();

  const res = await fetchWithTimeout(endpoint, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    console.warn(`[Scan] Google CSE failed — status ${res.status}`);
    return null;
  }

  const data = await res.json().catch(() => null);
  const items = Array.isArray(data?.items) ? data.items : [];
  const candidates = items
    .map((item) => item?.link)
    .filter((url) => typeof url === 'string');

  return pickWhitelistedCandidate(candidates, 'Google CSE');
}

async function fetchImageFromDuckDuckGo(searchQuery) {
  const vqd = await fetchDuckDuckGoVqd(searchQuery);
  if (!vqd) {
    console.warn('[Scan] DuckDuckGo lookup failed, falling back safely — missing vqd');
    return null;
  }

  const ijsUrl =
    `https://duckduckgo.com/i.js` +
    `?l=us-en` +
    `&o=json` +
    `&q=${encodeURIComponent(searchQuery)}` +
    `&vqd=${encodeURIComponent(vqd)}` +
    `&f=,,,` +
    `&p=1`;

  const res = await fetchWithTimeout(ijsUrl, { method: 'GET', headers: DDG_HEADERS });
  if (!res.ok) {
    console.warn(`[Scan] DuckDuckGo lookup failed, falling back safely — i.js status ${res.status}`);
    return null;
  }

  const data = await res.json().catch(() => null);
  const results = Array.isArray(data?.results) ? data.results : [];
  const candidates = results.flatMap((item) =>
    [item?.image, item?.thumbnail, item?.url].filter((url) => typeof url === 'string')
  );

  return pickWhitelistedCandidate(candidates, 'DuckDuckGo');
}

/**
 * Resolve a live packshot URL. Never throws.
 * @returns {Promise<string|null>}
 */
async function fetchImageFromCSE(searchQuery) {
  try {
    console.log(`[Scan] Image lookup query: "${searchQuery}"`);
    const cseResult = await fetchImageFromGoogleCSE(searchQuery);
    if (cseResult) return cseResult;

    console.warn('[Scan] Google CSE miss/unavailable — trying DuckDuckGo fallback');
    const ddgResult = await fetchImageFromDuckDuckGo(searchQuery);
    if (ddgResult) return ddgResult;

    console.warn(`[Scan] No whitelisted image for query: "${searchQuery}"`);
    return null;
  } catch (err) {
    console.warn('[Scan] Image lookup failed, falling back safely:', err.message);
    return null;
  }
}

/**
 * Persist ONLY verified live https URLs. Dummy/null/http never touch MongoDB.
 */
async function persistProductImageCache(productKey, imageUrl) {
  if (!isCachableImageUrl(imageUrl)) {
    console.log(`[Scan] Skip cache write (not a live whitelisted URL) for: "${productKey}"`);
    return false;
  }
  try {
    await CachedProduct.findOneAndUpdate(
      { productName: productKey },
      { productName: productKey, imageUrl: imageUrl.trim() },
      { upsert: true, returnDocument: 'after' }
    );
    console.log(`[Scan] Cached image for: "${productKey}" → ${imageUrl}`);
    return true;
  } catch (writeErr) {
    console.warn('[Scan] MongoDB cache write failed (non-fatal):', writeErr.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/scan/product-image
//  Body: { productName: string, brand: string }
//  Response: { success: true, imageUrl: string, fromCache: boolean, fallback?: true }
//
//  Flow:
//    1. Dedup inflight requests for the same brand+name (before any await)
//    2. Mongo HIT only for live https whitelist URLs
//    3. Sequential Google CSE fetch (sanitized brand + name)
//    4. Persist ONLY cachable https URLs — never fallback/null
//    5. Miss → return FALLBACK_IMAGE with fallback:true, no DB write
// ─────────────────────────────────────────────────────────────────────────────
router.post('/product-image', async (req, res) => {
  try {
    const { productName, brand } = req.body;

    if (!productName || typeof productName !== 'string' || productName.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: 'productName is required and must be at least 2 characters.',
      });
    }

    const productKey = buildCacheKey(brand, productName);
    const searchQuery = buildImageSearchQuery(brand, productName);

    if (inflightRequests.has(productKey)) {
      console.log(`[Scan] Dedup lock HIT — awaiting existing promise for: "${productKey}"`);
      try {
        const liveUrl = await inflightRequests.get(productKey);
        if (isCachableImageUrl(liveUrl)) {
          return res.status(200).json({
            success: true,
            imageUrl: liveUrl,
            fromCache: false,
          });
        }
        return res.status(200).json(fallbackPayload());
      } catch {
        return res.status(200).json(fallbackPayload());
      }
    }

    let resolveInflight = () => { };
    const inflightPromise = new Promise((resolve) => {
      resolveInflight = resolve;
    });
    inflightRequests.set(productKey, inflightPromise);

    try {
      try {
        const cached = await CachedProduct.findOne({ productName: productKey }).lean();
        if (cached && isCachableImageUrl(cached.imageUrl)) {
          console.log(`[Scan] Cache HIT for: "${productKey}"`);
          resolveInflight(cached.imageUrl);
          return res.status(200).json({
            success: true,
            imageUrl: cached.imageUrl,
            fromCache: true,
          });
        }
        if (cached) {
          console.log(
            `[Scan] Cache MISS (uncacheable/dummy) for: "${productKey}" — re-fetching live image`
          );
        }
      } catch (cacheErr) {
        console.warn('[Scan] MongoDB cache read failed (non-fatal):', cacheErr.message);
      }

      const liveUrl = await enqueueSequentialImageFetch(() => fetchImageFromCSE(searchQuery));

      if (isCachableImageUrl(liveUrl)) {
        await persistProductImageCache(productKey, liveUrl);
        resolveInflight(liveUrl);
        return res.status(200).json({
          success: true,
          imageUrl: liveUrl,
          fromCache: false,
        });
      }

      console.log(`[Scan] Using client-only fallback for: "${productKey}" (no DB write)`);
      resolveInflight(null);
      return res.status(200).json(fallbackPayload());
    } catch (unexpectedErr) {
      console.warn('[Scan] Image lookup failed, falling back safely:', unexpectedErr.message);
      resolveInflight(null);
      return res.status(200).json(fallbackPayload());
    } finally {
      inflightRequests.delete(productKey);
    }
  } catch (err) {
    console.error('[Scan ProductImage Error]', err);
    return res.status(200).json(fallbackPayload());
  }
});

// ── POST /api/scan/save ──────────────────────────────────────────────────────
router.post('/save', protect, async (req, res) => {
  try {
    const { ai_full_json_result = {} } = req.body;
    let { concern_category, scan_image_url = null } = req.body;

    if (!concern_category) {
      return res.status(400).json({ success: false, message: 'concern_category is required.' });
    }

    // Prefer AI-derived clinical title over raw questionnaire answers
    concern_category = resolveScanDisplayTitle(concern_category, ai_full_json_result);

    if (!scan_image_url || typeof scan_image_url !== 'string' || !scan_image_url.trim()) {
      scan_image_url = FALLBACK_IMAGE;
    }

    const scanResult = await ScanResult.create({
      userId: req.userId,
      concern_category,
      ai_full_json_result,
      scan_image_url,
    });

    const today = new Date().toISOString().slice(0, 10);
    const user = await User.findById(req.userId).select('streak_count last_scan_date');

    if (user && user.last_scan_date !== today) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      const newStreak =
        user.last_scan_date === yesterdayStr ? (user.streak_count || 0) + 1 : 1;

      await User.findByIdAndUpdate(req.userId, {
        streak_count: newStreak,
        last_scan_date: today,
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Scan result saved successfully.',
      data: {
        id: scanResult._id,
        concern_category: scanResult.concern_category,
        scan_image_url: scanResult.scan_image_url,
        created_at: scanResult.createdAt,
      },
    });
  } catch (err) {
    console.error('[Scan Save Error]', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ── GET /api/scan/history ────────────────────────────────────────────────────
router.get('/history', protect, async (req, res) => {
  try {
    const scans = await ScanResult.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('concern_category createdAt ai_full_json_result scan_image_url')
      .lean();

    // On-the-fly title cleanup for legacy junk titles ("Yes, clearly visible", "No", …)
    const normalizedScans = scans.map((scan) => ({
      ...scan,
      concern_category: resolveScanDisplayTitle(scan.concern_category, scan.ai_full_json_result),
    }));

    const user = await User.findById(req.userId).select('streak_count').lean();

    return res.status(200).json({
      success: true,
      data: {
        scans: normalizedScans,
        streak_count: user ? user.streak_count : 0,
      },
    });
  } catch (err) {
    console.error('[Scan History Error]', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

module.exports = router;
