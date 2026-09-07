/**
 * routes/scan.js — Cosmolyze Scan Routes
 *
 * Endpoints:
 *   POST /api/scan/save          → Persist a scan result + update user streak
 *   GET  /api/scan/history       → Return last 20 scans for the authed user
 *   POST /api/scan/product-image → Fetch a product image via DuckDuckGo with
 *                                   MongoDB TTL caching, sequential rate-limit,
 *                                   and concurrency dedup
 */

const express = require('express');
const protect = require('../middleware/auth');
const ScanResult = require('../models/ScanResult');
const User = require('../models/User');
const CachedProduct = require('../models/CachedProduct');

const router = express.Router();

// ── In-Memory Concurrency Lock (Thundering Herd prevention) ──────────────────
// Maps a normalised productName → Promise<string> (the inflight DDG fetch).
const inflightRequests = new Map();

// ── Sequential rate-limit queue (1000ms between product image fetches) ───────
const DDG_FETCH_GAP_MS = 1000;
let imageFetchChain = Promise.resolve();
let lastDdgFetchAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run image lookups strictly one-after-another with a 1000ms gap.
 * Protects the local server IP from DuckDuckGo rate limits when
 * hydrating ~5 product cards after a scan.
 */
function enqueueSequentialImageFetch(taskFn) {
  const run = async () => {
    const elapsed = Date.now() - lastDdgFetchAt;
    const waitMs = Math.max(0, DDG_FETCH_GAP_MS - elapsed);
    if (waitMs > 0) {
      console.log(`[Scan] Sequential DDG delay ${waitMs}ms before next product fetch...`);
      await sleep(waitMs);
    }
    lastDdgFetchAt = Date.now();
    return taskFn();
  };

  const next = imageFetchChain.then(run, run);
  // Keep the chain alive even if a task fails
  imageFetchChain = next.catch(() => null);
  return next;
}

// ── Fallback image when DuckDuckGo returns nothing usable ────────────────────
const FALLBACK_IMAGE = '/images/default-clinical-bottle.png';

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

/** Dummy/local fallback paths are treated as CACHE MISS so we re-fetch live URLs. */
function isDummyCachedImage(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return true;
  const normalized = imageUrl.trim().toLowerCase();
  return (
    normalized === FALLBACK_IMAGE.toLowerCase() ||
    normalized.endsWith('/images/default-clinical-bottle.png') ||
    normalized.includes('default-clinical-bottle')
  );
}

// ── Shared constants ─────────────────────────────────────────────────────────
const COSMOLYZE_UA = 'Cosmolyze - Production Engine';

const DDG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://duckduckgo.com/',
};

// ── TIER 1: Open Beauty Facts ─────────────────────────────────────────────────
/**
 * Query world.openbeautyfacts.org for a product image.
 * Uses the public JSON search endpoint — no API key required.
 *
 * @param {string} productName — normalised (trim + lowercase)
 * @returns {Promise<string|null>} — live image URL or null
 */
async function fetchImageFromOpenBeautyFacts(productName) {
  try {
    const url =
      `https://world.openbeautyfacts.org/cgi/search.pl` +
      `?search_terms=${encodeURIComponent(productName)}` +
      `&search_simple=1` +
      `&action=process` +
      `&json=1` +
      `&page_size=5` +
      `&fields=image_front_url,image_url,product_name`;

    console.log(`[Scan][T1] OpenBeautyFacts lookup for: "${productName}"`);

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': COSMOLYZE_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[Scan][T1] OpenBeautyFacts returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json().catch(() => null);
    const products = Array.isArray(data?.products) ? data.products : [];

    for (const p of products) {
      const candidate = p?.image_front_url || p?.image_url;
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
        console.log(`[Scan][T1] OpenBeautyFacts image found for: "${productName}"`);
        return candidate;
      }
    }

    console.warn(`[Scan][T1] OpenBeautyFacts — no usable image for: "${productName}"`);
    return null;
  } catch (err) {
    console.warn(`[Scan][T1] OpenBeautyFacts error: ${err.message}`);
    return null;
  }
}

// ── TIER 2: Wikimedia Commons ─────────────────────────────────────────────────
/**
 * Query the Wikimedia Commons API for a public image matching the product name.
 * Uses the generator=search + iiprop=url approach — no API key required.
 *
 * @param {string} productName — normalised (trim + lowercase)
 * @returns {Promise<string|null>} — live image URL or null
 */
async function fetchImageFromWikimedia(productName) {
  try {
    // Target: high-quality cosmetic product photos hosted on Commons
    const searchQuery = `${productName} cosmetic product`;
    const url =
      `https://commons.wikimedia.org/w/api.php` +
      `?action=query` +
      `&generator=search` +
      `&gsrnamespace=6` +
      `&gsrsearch=${encodeURIComponent(searchQuery)}` +
      `&gsrlimit=5` +
      `&prop=imageinfo` +
      `&iiprop=url` +
      `&iiurlwidth=600` +
      `&format=json` +
      `&origin=*`;

    console.log(`[Scan][T2] Wikimedia Commons lookup for: "${productName}"`);

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': COSMOLYZE_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[Scan][T2] Wikimedia returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json().catch(() => null);
    const pages = data?.query?.pages;

    if (!pages || typeof pages !== 'object') {
      console.warn(`[Scan][T2] Wikimedia — no pages in response for: "${productName}"`);
      return null;
    }

    for (const page of Object.values(pages)) {
      const imageInfo = Array.isArray(page?.imageinfo) ? page.imageinfo : [];
      for (const info of imageInfo) {
        const candidate = info?.thumburl || info?.url;
        // Skip SVG, maps, and non-image files
        if (
          typeof candidate === 'string' &&
          /^https?:\/\//i.test(candidate) &&
          !/\.svg$/i.test(candidate)
        ) {
          console.log(`[Scan][T2] Wikimedia image found for: "${productName}"`);
          return candidate;
        }
      }
    }

    console.warn(`[Scan][T2] Wikimedia — no usable image for: "${productName}"`);
    return null;
  } catch (err) {
    console.warn(`[Scan][T2] Wikimedia error: ${err.message}`);
    return null;
  }
}

// ── TIER 3: DuckDuckGo Scraper (last resort) ──────────────────────────────────
/**
 * Obtain a DuckDuckGo vqd token required by the i.js image endpoint.
 * @returns {Promise<string|null>}
 */
async function fetchDuckDuckGoVqd(query) {
  try {
    const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...DDG_HEADERS,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[Scan][T3] DDG vqd page failed with status ${res.status}`);
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

    console.warn('[Scan][T3] DDG vqd token not found in response HTML');
    return null;
  } catch (err) {
    console.warn('[Scan][T3] DDG vqd fetch error:', err.message);
    return null;
  }
}

/**
 * Tier 3 internal: DuckDuckGo i.js image scraper.
 * @param {string} productName — already normalised
 * @returns {Promise<string|null>}
 */
async function fetchImageFromDDG(productName) {
  try {
    const query = `${productName} product packaging bottle`;
    console.log(`[Scan][T3] DuckDuckGo image lookup for: "${productName}"`);

    const vqd = await fetchDuckDuckGoVqd(query);
    if (!vqd) {
      console.warn('[Scan][T3] DDG lookup — missing vqd, skipping');
      return null;
    }

    const ijsUrl =
      `https://duckduckgo.com/i.js` +
      `?l=us-en` +
      `&o=json` +
      `&q=${encodeURIComponent(query)}` +
      `&vqd=${encodeURIComponent(vqd)}` +
      `&f=,,,` +
      `&p=1`;

    const res = await fetch(ijsUrl, {
      method: 'GET',
      headers: DDG_HEADERS,
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[Scan][T3] DDG i.js returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json().catch(() => null);
    const results = Array.isArray(data?.results) ? data.results : [];

    for (const item of results) {
      const candidate = item?.image || item?.thumbnail || item?.url;
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
        console.log(`[Scan][T3] DuckDuckGo image found for: "${productName}"`);
        return candidate;
      }
    }

    console.warn(`[Scan][T3] DDG — no image results for: "${productName}"`);
    return null;
  } catch (err) {
    console.warn('[Scan][T3] DDG error:', err.message);
    return null;
  }
}

// ── Multi-Tier Image Engine (public entry point) ───────────────────────────────
/**
 * 3-Tier resilient image lookup. Function name retained for call-site compatibility.
 *
 * Tier 1 → Open Beauty Facts  (purpose-built cosmetics database, zero auth)
 * Tier 2 → Wikimedia Commons  (public domain image repository, zero auth)
 * Tier 3 → DuckDuckGo scraper (last resort; may be rate-limited on cloud IPs)
 *
 * Never throws — returns a live image URL string, or null if all tiers fail.
 *
 * @param {string} productName — already normalised (trim + lowercase)
 * @returns {Promise<string|null>}
 */
async function fetchImageFromCSE(productName) {
  // ── Tier 1: Open Beauty Facts ────────────────────────────────────────────
  const t1 = await fetchImageFromOpenBeautyFacts(productName);
  if (t1) return t1;

  // ── Tier 2: Wikimedia Commons ─────────────────────────────────────────────
  const t2 = await fetchImageFromWikimedia(productName);
  if (t2) return t2;

  // ── Tier 3: DuckDuckGo (last resort) ─────────────────────────────────────
  const t3 = await fetchImageFromDDG(productName);
  if (t3) return t3;

  console.warn(`[Scan] All 3 image tiers exhausted for: "${productName}"`);
  return null;
}

/**
 * Persist product image (real or fallback) to MongoDB cache.
 * Always runs — never skips the DB write pipeline.
 */
async function persistProductImageCache(productKey, imageUrl) {
  try {
    await CachedProduct.findOneAndUpdate(
      { productName: productKey },
      { productName: productKey, imageUrl },
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
//  Body: { productName: string }
//  Response: { success: true, imageUrl: string, fromCache: boolean }
//
//  Flow:
//    1. Check MongoDB cache — dummy fallback paths count as CACHE MISS
//    2. Dedup inflight requests for the same product
//    3. Sequential DuckDuckGo fetch (1000ms gap between products)
//    4. Assign FALLBACK_IMAGE when DDG returns null
//    5. ALWAYS overwrite MongoDB with the resolved imageUrl
// ─────────────────────────────────────────────────────────────────────────────
router.post('/product-image', async (req, res) => {
  try {
    const { productName } = req.body;

    if (!productName || typeof productName !== 'string' || productName.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: 'productName is required and must be at least 2 characters.',
      });
    }

    const productKey = productName.trim().toLowerCase();

    // ── Layer 1: MongoDB Cache Hit (dummy fallback = CACHE MISS) ─────────────
    try {
      const cached = await CachedProduct.findOne({ productName: productKey }).lean();
      if (cached && cached.imageUrl && !isDummyCachedImage(cached.imageUrl)) {
        console.log(`[Scan] Cache HIT for: "${productKey}"`);
        return res.status(200).json({
          success: true,
          imageUrl: cached.imageUrl,
          fromCache: true,
        });
      }
      if (cached && isDummyCachedImage(cached.imageUrl)) {
        console.log(
          `[Scan] Cache MISS (dummy fallback) for: "${productKey}" — re-fetching from DuckDuckGo`
        );
      }
    } catch (cacheErr) {
      console.warn('[Scan] MongoDB cache read failed (non-fatal):', cacheErr.message);
    }

    // ── Layer 2: In-Flight Deduplication Lock ─────────────────────────────────
    if (inflightRequests.has(productKey)) {
      console.log(`[Scan] Dedup lock HIT — awaiting existing promise for: "${productKey}"`);
      try {
        const imageUrl = (await inflightRequests.get(productKey)) || FALLBACK_IMAGE;
        return res.status(200).json({ success: true, imageUrl, fromCache: false });
      } catch {
        return res.status(200).json({
          success: true,
          imageUrl: FALLBACK_IMAGE,
          fromCache: false,
        });
      }
    }

    // ── Layer 3: Sequential DuckDuckGo fetch ──────────────────────────────────
    let resolveInflight = () => { };
    const inflightPromise = new Promise((resolve) => {
      resolveInflight = resolve;
    });
    inflightRequests.set(productKey, inflightPromise);

    let imageUrl = FALLBACK_IMAGE;
    try {
      const ddgResult = await enqueueSequentialImageFetch(() => fetchImageFromCSE(productKey));

      if (!ddgResult || isDummyCachedImage(ddgResult)) {
        imageUrl = FALLBACK_IMAGE;
        console.log(`[Scan] Using fallback image for: "${productKey}" → ${FALLBACK_IMAGE}`);
      } else {
        imageUrl = ddgResult;
      }

      // ── Layer 4: ALWAYS overwrite MongoDB (live URL or fallback) ────────────
      await persistProductImageCache(productKey, imageUrl);
      resolveInflight(imageUrl);
    } catch (unexpectedErr) {
      console.warn('[Scan] DuckDuckGo lookup failed, falling back safely:', unexpectedErr.message);
      imageUrl = FALLBACK_IMAGE;
      await persistProductImageCache(productKey, imageUrl);
      resolveInflight(imageUrl);
    } finally {
      inflightRequests.delete(productKey);
    }

    return res.status(200).json({
      success: true,
      imageUrl,
      fromCache: false,
    });
  } catch (err) {
    console.error('[Scan ProductImage Error]', err);
    // Never hard-crash — JSON text / scan pipeline continues with fallback
    return res.status(200).json({
      success: true,
      imageUrl: FALLBACK_IMAGE,
      fromCache: false,
    });
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
