/**
 * routes/scan.js — Cosmolyze Scan Routes
 *
 * Endpoints:
 *   POST /api/scan/save          → Persist a scan result + update user streak
 *   GET  /api/scan/history       → Return last 20 scans for the authed user
 *   POST /api/scan/product-image → Fetch a commercial product packshot via
 *                                   the Python image sidecar (FastAPI +
 *                                   duckduckgo_search) at IMAGE_SERVICE_URL.
 *                                   Falls over to FALLBACK_IMAGE if the
 *                                   sidecar is unreachable or returns 404.
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

/**
 * Base URL of the Python image sidecar (FastAPI + duckduckgo_search).
 * In production on Render set IMAGE_SERVICE_URL to the internal address
 * of the sidecar web service (e.g. http://cosmolyze-imgsvc:8001).
 * Defaults to localhost for local development.
 */
const IMAGE_SERVICE_URL = (process.env.IMAGE_SERVICE_URL || 'http://localhost:8001').replace(/\/$/, '');

// ── Strict media rejection filter ────────────────────────────────────────────
/**
 * Returns true if the title or URL indicates a non-product asset that should
 * never appear on a product card (newspaper clippings, portraits, documents,
 * logos, hand-held review photos, diagrams, etc.).
 *
 * Also enforces a raster-only extension allowlist: .jpg / .jpeg / .png / .webp.
 *
 * @param {string} [title=''] — file title or alt text from the API
 * @param {string} [url='']   — candidate image URL
 * @returns {boolean} true = reject this candidate
 */
function isInvalidProductMedia(title = '', url = '') {
  const BLACKLIST_TERMS = [
    'newspaper', 'letter', 'article', 'journal', 'officer', 'military',
    'portrait', 'founder', 'ceo', 'building', 'document', 'paper',
    'text', 'screenshot', 'hand', 'holding', 'review', 'user',
    'banner', 'logo', 'icon', 'diagram', 'chart',
  ];

  const haystack = `${title} ${url}`.toLowerCase();

  if (BLACKLIST_TERMS.some((term) => haystack.includes(term))) return true;

  // Only accept standard raster formats — reject SVG, GIF, PDF, TIFF, etc.
  if (!/\.(jpe?g|png|webp)(\?.*)?$/i.test(url)) return true;

  return false;
}

// ── Commercial Packshot Image Engine ───────────────────────────────────────────
/**
 * Single-call packshot resolver: delegates to the Python image sidecar.
 *
 * The sidecar (image_service/main.py) uses the `duckduckgo_search` library
 * which manages vqd token acquisition, cookie jars, and retry backoff
 * internally via a persistent requests.Session. This is what allows it to
 * work from Render datacenter IPs where Node.js raw fetch() is ASN-blocked.
 *
 * Returns null (→ FALLBACK_IMAGE at call site) when:
 *   - The sidecar is unreachable (network error / not yet started)
 *   - The sidecar returns 404 (no valid image found)
 *   - The sidecar returns 502 (upstream DDG error)
 *
 * Never throws.
 *
 * @param {string} productName — already normalised (trim + lowercase)
 * @returns {Promise<string|null>}
 */
async function fetchImageFromCSE(productName) {
  try {
    console.log(`[ImageEngine] Requesting sidecar for: "${productName}"`);

    const res = await fetch(`${IMAGE_SERVICE_URL}/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_name: productName }),
      signal: AbortSignal.timeout(20000), // sidecar may need up to ~15s for DDG
    });

    if (res.status === 404) {
      console.warn(`[ImageEngine] Sidecar: no image found for "${productName}"`);
      return null;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[ImageEngine] Sidecar returned HTTP ${res.status} for "${productName}": ${body}`);
      return null;
    }

    const data = await res.json().catch(() => null);
    if (data?.image_url) {
      console.log(`[ImageEngine] Resolved ${productName} -> ${data.image_url}`);
      return data.image_url;
    }

    console.warn(`[ImageEngine] Sidecar response missing image_url for: "${productName}"`);
    return null;
  } catch (err) {
    // AbortError means the sidecar timed out; any other error means it's not running.
    console.warn(`[ImageEngine] Sidecar unreachable for "${productName}": ${err.message}`);
    return null;
  }
}

/**
 * Persist a REAL product image URL to MongoDB cache.
 *
 * IMPORTANT: Deliberately skips the write when `imageUrl` is the local
 * fallback placeholder. Writing fallback URLs poisons the cache — the next
 * request would get a cache HIT on a placeholder and never retry the network.
 * Leaving the document absent is correct: the TTL cache miss logic triggers
 * a fresh lookup on the very next request.
 */
async function persistProductImageCache(productKey, imageUrl) {
  // Skip write for fallback/dummy URLs — never poison the cache.
  if (!imageUrl || isDummyCachedImage(imageUrl)) {
    console.log(`[Scan] Cache write SKIPPED for fallback URL: "${productKey}"`);
    return false;
  }
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

      // ── Layer 4: Persist to MongoDB — only for real URLs, never fallback ──
      if (imageUrl !== FALLBACK_IMAGE) {
        await persistProductImageCache(productKey, imageUrl);
      }
      resolveInflight(imageUrl);
    } catch (unexpectedErr) {
      console.warn('[Scan] DuckDuckGo lookup failed, falling back safely:', unexpectedErr.message);
      imageUrl = FALLBACK_IMAGE;
      // Do NOT persist the fallback — let the cache stay empty so the next
      // request triggers a fresh network attempt.
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
