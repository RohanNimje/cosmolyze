/**
 * routes/scan.js — Cosmolyze Scan Routes
 *
 * Endpoints:
 *   POST /api/scan/save          → Persist a scan result + update user streak
 *   GET  /api/scan/history       → Return last 20 scans for the authed user
 *   POST /api/scan/product-image → Resolve a commercial product packshot.
 *                                   Layer 1: MongoDB TTL cache   (~50ms)
 *                                   Layer 2: Bing Image Search scraper (~800ms, zero-cost)
 *                                            Extracts full-res source URLs from Bing's
 *                                            murl data island using iPhone UA. Falls back
 *                                            to Bing thumbnail CDN if no source URL found.
 *                                   Layer 3: { imageUrl: null, query } signal
 *                                            → client resolves from browser IP
 *   POST /api/scan/cache-image   → Client backfills MongoDB after browser-side
 *                                   resolve, so next user gets cache HIT.
 */

const express = require('express');
const protect = require('../middleware/auth');
const ScanResult = require('../models/ScanResult');
const User = require('../models/User');
const CachedProduct = require('../models/CachedProduct');

const router = express.Router();

// ── Inflight stagger — prevents burst-drop under simultaneous requests ─────────
// A lightweight 50ms gate ensures concurrent image lookups don't all hammer
// Bing at the exact same millisecond, which can trigger rate limiting.
const inflightRequests = new Map();
const STAGGER_MS = 50;
let lastFetchAt = 0;

async function staggeredFetch(productKey, fetcher) {
  // Coalesce duplicate in-flight requests for the same product
  if (inflightRequests.has(productKey)) {
    return inflightRequests.get(productKey);
  }
  // Apply 50ms stagger between requests
  const now = Date.now();
  const gap = now - lastFetchAt;
  if (gap < STAGGER_MS) {
    await new Promise((r) => setTimeout(r, STAGGER_MS - gap));
  }
  lastFetchAt = Date.now();

  const promise = fetcher().finally(() => inflightRequests.delete(productKey));
  inflightRequests.set(productKey, promise);
  return promise;
}

// ── Fallback image (UI only — never written to MongoDB) ───────────────────────
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

// ── Bing Image Search Scraper ─────────────────────────────────────────────────
/**
 * Fetch a product packshot from Bing Image Search HTML.
 *
 * Uses an iPhone User-Agent so Bing serves a leaner mobile page while still
 * embedding full-resolution murl (media URL) entries in its JSON data island.
 * These are the actual source image URLs hosted on third-party sites.
 *
 * Resolution order:
 *   1. murl pattern  — full-res source image (e.g. from shopify/wordpress CDNs)
 *      Pattern: murl&quot;:&quot;<url>&quot; in the page's HTML source.
 *   2. Bing thumbnail CDN (tse*.mm.bing.net) — smaller but always https, always 200.
 *
 * Bing does NOT apply ASN-level blocks to datacenter IPs, making this
 * Render/Railway/Fly.io-safe. Zero cost, no API key required.
 *
 * @param {string} productName — normalised product name
 * @returns {Promise<string|null>} — https:// image URL, or null on miss/error
 */
async function fetchFromBing(productName) {
  try {
    const q = encodeURIComponent(productName + ' skincare product');
    const url = `https://www.bing.com/images/search?q=${q}&form=HDRSC3&first=1`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) {
      console.warn(`[Bing] HTTP ${res.status} for "${productName}"`);
      return null;
    }

    const html = await res.text();

    // Primary: full-resolution source images embedded in Bing's JSON data island.
    // murl = "media URL" — the original host's image, URL-encoded inside the HTML.
    // Excludes Bing's own CDN (bing.net, microsoft.com) to prefer third-party sources.
    const murlRe = /murl&quot;:&quot;(https?:\/\/[^&"]+\.(?:jpe?g|png|webp)(?:\?[^&"]*)?)/gi;
    let m;
    while ((m = murlRe.exec(html)) !== null) {
      const img = m[1];
      if (
        img &&
        img.startsWith('https://') &&
        !/bing\.net|microsoft\.com|bing\.com/i.test(img)
      ) {
        console.log(`[Bing] Resolved "${productName}" → ${img}`);
        return img;
      }
    }

    // Fallback: Bing thumbnail CDN — smaller resolution but guaranteed https + 200
    const tbnRe = /https:\/\/tse\d+\.mm\.bing\.net\/th\/id\/[A-Za-z0-9._%-]+/gi;
    const tbnMatches = html.match(tbnRe);
    if (tbnMatches && tbnMatches[0]) {
      const tbnUrl = tbnMatches[0];
      console.log(`[Bing] Thumbnail fallback for "${productName}" → ${tbnUrl}`);
      return tbnUrl;
    }

    console.warn(`[Bing] No image found for "${productName}" (HTML: ${html.length} bytes)`);
    return null;
  } catch (err) {
    console.warn(`[Bing] Fetch error for "${productName}": ${err.message}`);
    return null;
  }
}

/**
 * Persist a REAL product image URL to MongoDB cache.
 *
 * IMPORTANT: Deliberately skips the write when `imageUrl` is the local
 * fallback placeholder. Writing fallback URLs poisons the cache — the next
 * request would get a cache HIT on a placeholder and never retry the network.
 * Leaving the document absent is correct: the cache miss logic triggers
 * a fresh lookup on the very next request.
 */
async function persistProductImageCache(productKey, imageUrl) {
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
//  Body:     { productName: string }
//  Response: { success: true, imageUrl: string|null, fromCache: boolean, query?: string }
//
//  Resolution layers:
//    1. MongoDB TTL cache     — instant (~50ms), skips dummy/fallback entries
//    2. Bing Image Search     — ~800ms, zero-cost, Render-safe (no ASN block)
//                               Extracts murl (full-res source) from HTML data island;
//                               falls back to Bing thumbnail CDN on miss.
//    3. Null signal           — { imageUrl: null, query } tells the browser to
//                               resolve client-side, then backfill via /cache-image
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

    // ── Layer 1: MongoDB Cache ────────────────────────────────────────────────
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
    } catch (cacheErr) {
      console.warn('[Scan] MongoDB cache read failed (non-fatal):', cacheErr.message);
    }

    // ── Layer 2: Bing Image Search (with 50ms inflight stagger) ──────────────
    const imageUrl = await staggeredFetch(productKey, () => fetchFromBing(productKey));

    if (imageUrl) {
      // Persist so the next request for this product is a cache HIT
      await persistProductImageCache(productKey, imageUrl);
      return res.status(200).json({ success: true, imageUrl, fromCache: false });
    }

    // ── Layer 3: Signal client-side fallback ──────────────────────────────────
    // Return null + the original query string. The browser resolves client-side
    // using the user's residential IP, then backfills MongoDB via /cache-image.
    console.log(`[Scan] Bing miss for "${productKey}" — delegating to client-side resolver`);
    return res.status(200).json({
      success: true,
      imageUrl: null,
      query: productName.trim(),
      fromCache: false,
    });
  } catch (err) {
    console.error('[Scan ProductImage Error]', err);
    return res.status(200).json({
      success: true,
      imageUrl: null,
      query: req.body?.productName?.trim() || '',
      fromCache: false,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/scan/cache-image
//  Body: { productName: string, imageUrl: string }
//
//  Called silently by the browser after a client-side resolve succeeds.
//  Persists the URL to MongoDB so future requests get a server-side cache HIT
//  instead of triggering another client-side fetch.
//
//  Strict validation: only https:// raster URLs (.jpg/.jpeg/.png/.webp) accepted.
//  Cache poisoning guard: FALLBACK_IMAGE is never written to MongoDB.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/cache-image', async (req, res) => {
  try {
    const { productName, imageUrl } = req.body;

    if (!productName || typeof productName !== 'string' || productName.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'productName required.' });
    }
    if (
      !imageUrl ||
      typeof imageUrl !== 'string' ||
      !imageUrl.startsWith('https://') ||
      !/\.(jpe?g|png|webp)(\?.*)?$/i.test(imageUrl)
    ) {
      return res.status(400).json({ success: false, message: 'Invalid imageUrl — must be https:// raster.' });
    }

    const productKey = productName.trim().toLowerCase();
    await persistProductImageCache(productKey, imageUrl);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.warn('[Scan CacheImage Error]', err.message);
    return res.status(200).json({ success: false });
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
