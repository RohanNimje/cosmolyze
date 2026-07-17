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
    const res = await fetch(url, {
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

/**
 * Fetch a product image via DuckDuckGo's free i.js image endpoint.
 * Function name retained for call-site compatibility.
 * Never throws — returns a live image URL string, or null on any failure.
 *
 * @param {string} productName — already normalised (trim + lowercase)
 * @returns {Promise<string|null>}
 */
async function fetchImageFromCSE(productName) {
  try {
    const query = `${productName} product packaging bottle`;
    console.log(`[Scan] DuckDuckGo image lookup for: "${productName}"`);

    const vqd = await fetchDuckDuckGoVqd(query);
    if (!vqd) {
      console.warn('[Scan] DuckDuckGo lookup failed, falling back safely — missing vqd');
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

    const res = await fetch(ijsUrl, { method: 'GET', headers: DDG_HEADERS });

    if (!res.ok) {
      console.warn(
        `[Scan] DuckDuckGo lookup failed, falling back safely — i.js status ${res.status}`
      );
      return null;
    }

    const data = await res.json().catch(() => null);
    const results = Array.isArray(data?.results) ? data.results : [];

    // Prefer full-size `image`, then thumbnail
    for (const item of results) {
      const candidate = item?.image || item?.thumbnail || item?.url;
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
        console.log(`[Scan] DuckDuckGo image fetched successfully for: "${productName}"`);
        return candidate;
      }
    }

    console.warn(
      `[Scan] DuckDuckGo lookup failed, falling back safely — no image results for: "${productName}"`
    );
    return null;
  } catch (err) {
    console.warn('[Scan] DuckDuckGo lookup failed, falling back safely:', err.message);
    return null;
  }
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
      { upsert: true, new: true }
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
    let resolveInflight = () => {};
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
    const { concern_category, ai_full_json_result = {} } = req.body;
    let { scan_image_url = null } = req.body;

    if (!concern_category) {
      return res.status(400).json({ success: false, message: 'concern_category is required.' });
    }

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

    const user = await User.findById(req.userId).select('streak_count').lean();

    return res.status(200).json({
      success: true,
      data: {
        scans,
        streak_count: user ? user.streak_count : 0,
      },
    });
  } catch (err) {
    console.error('[Scan History Error]', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

module.exports = router;
