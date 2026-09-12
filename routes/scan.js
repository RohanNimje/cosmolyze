/**
 * routes/scan.js — Cosmolyze Scan Routes
 *
 * Endpoints:
 *   POST /api/scan/save          → Persist a scan result + update user streak
 *   GET  /api/scan/history       → Return last 20 scans for the authed user
 *   POST /api/scan/product-image → Resolve a commercial product packshot.
 *                                   Layer 1: MongoDB TTL cache        (~50ms)
 *                                   Layer 2: Google Custom Search API  (~600ms)
 *                                   Layer 3: { imageUrl: null } signal
 *                                            → client renders fallback image
 *   POST /api/scan/cache-image   → Client backfills MongoDB after browser-side
 *                                   resolve, so next user gets cache HIT.
 */

const express = require('express');
const protect = require('../middleware/auth');
const ScanResult = require('../models/ScanResult');
const User = require('../models/User');
const CachedProduct = require('../models/CachedProduct');

const router = express.Router();

// ── Fallback image (UI only — never written to MongoDB) ───────────────────────
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

/**
 * Derive a clean dashboard card title from AI analysis + stored category.
 * Never uses raw questionnaire answers as card titles.
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

  if (!trimmed || /^(yes|no)\b/i.test(trimmed)) {
    return 'Clinical Skin Analysis';
  }

  if (/acne|pimple/i.test(trimmed)) return 'Acne & Pimple Analysis';
  if (/texture/i.test(trimmed)) return 'Skin Texture Report';
  if (/clinical|skin|analysis|report|hyperpigmentation|dryness|aging|blemish/i.test(trimmed)) {
    return trimmed;
  }

  return 'Clinical Skin Analysis';
}

// ── Product Image Resolution Engines ──────────────────────────────────────────

/**
 * Fetch a product packshot via the official Google Custom Search API.
 *
 * @param {string} productName — normalised product name
 * @returns {Promise<string|null>} — https:// image URL, or null on any failure
 */
async function fetchFromGoogleCSE(productName) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY?.replace(/^"|"$/g, '').trim();
  const cseId = process.env.GOOGLE_CSE_ID?.replace(/^"|"$/g, '').trim();

  if (!apiKey || !cseId) {
    console.warn('[CSE] GOOGLE_SEARCH_API_KEY or GOOGLE_CSE_ID not configured.');
    return null;
  }

  try {
    const cleaned = productName.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const query = encodeURIComponent(`${cleaned} cosmetic packaging bottle`);
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${query}&searchType=image&num=1`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(3500),
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
      console.warn(`[CSE] API responded ${res.status} (${res.statusText}) for "${productName}"`);
      return null;
    }

    const data = await res.json();
    const items = data?.items;

    if (!items || items.length === 0) {
      console.warn(`[CSE] No results for "${productName}"`);
      return null;
    }

    const imageUrl = items[0]?.link;
    if (!imageUrl || !imageUrl.startsWith('https://')) {
      console.warn(`[CSE] Invalid link in response for "${productName}"`);
      return null;
    }

    console.log(`[CSE] Resolved "${productName}" → ${imageUrl}`);
    return imageUrl;
  } catch (err) {
    console.warn(`[CSE] Fetch error for "${productName}": ${err.message}`);
    return null;
  }
}

/**
 * High-reliability secondary image engine (zero quota limits, fast fallback).
 *
 * @param {string} productName — normalised product name
 * @returns {Promise<string|null>} — https:// image URL, or null on any failure
 */
async function fetchFromSecondaryEngine(productName) {
  try {
    const cleaned = productName.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const q = `${cleaned} cosmetic packshot bottle`;

    const tokenRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`, {
      signal: AbortSignal.timeout(3500),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const html = await tokenRes.text();
    const vqdMatch = html.match(/vqd=([\d-]+)/) || html.match(/vqd=["']([\d-]+)["']/);
    if (!vqdMatch) return null;
    const vqd = vqdMatch[1];

    const imgRes = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(q)}&vqd=${vqd}&f=,,,`, {
      signal: AbortSignal.timeout(3500),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://duckduckgo.com/',
      },
    });

    const data = await imgRes.json();
    const results = data?.results || [];

    for (const item of results) {
      if (item?.image && item.image.startsWith('https://') && /\.(jpe?g|png|webp)(\?.*)?$/i.test(item.image)) {
        console.log(`[Secondary Engine] Resolved "${productName}" → ${item.image}`);
        return item.image;
      }
    }

    if (results[0]?.image && results[0].image.startsWith('https://')) {
      console.log(`[Secondary Engine] Resolved "${productName}" → ${results[0].image}`);
      return results[0].image;
    }

    return null;
  } catch (err) {
    console.warn(`[Secondary Engine] Fetch error for "${productName}": ${err.message}`);
    return null;
  }
}

/**
 * Persist a REAL product image URL to MongoDB cache.
 *
 * Deliberately skips the write when `imageUrl` is the local fallback placeholder.
 * Writing fallback URLs poisons the cache — leaving the document absent is correct:
 * the cache miss logic triggers a fresh lookup on the very next request.
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
//  Response: { success: true, imageUrl: string|null, fromCache: boolean }
//
//  Resolution layers:
//    1. MongoDB TTL cache     — instant (~15-50ms), skips dummy/fallback entries
//    2. Google CSE API        — primary official search API (~400ms)
//    3. Secondary Engine      — high-speed zero-quota fallback (~800ms)
//    4. Null signal           — { imageUrl: null } — client renders fallback image
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

    // ── Layer 2: Google Custom Search API ────────────────────────────────────
    let imageUrl = await fetchFromGoogleCSE(productKey);

    // ── Layer 3: Secondary Resilient Engine ──────────────────────────────────
    if (!imageUrl) {
      imageUrl = await fetchFromSecondaryEngine(productKey);
    }

    if (imageUrl) {
      // Persist to MongoDB so the next request for this product is a cache HIT (~20ms)
      await persistProductImageCache(productKey, imageUrl);
      return res.status(200).json({ success: true, imageUrl, fromCache: false });
    }

    // ── Layer 4: No result — return null signal ───────────────────────────────
    console.log(`[Scan] Resolution miss for "${productKey}" — returning null signal`);
    return res.status(200).json({
      success: true,
      imageUrl: null,
      fromCache: false,
    });
  } catch (err) {
    console.error('[Scan ProductImage Error]', err);
    return res.status(200).json({
      success: true,
      imageUrl: null,
      fromCache: false,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/scan/cache-image
//  Body: { productName: string, imageUrl: string }
//
//  Called silently by the browser after a client-side resolve succeeds.
//  Persists the URL to MongoDB so future requests get a server-side cache HIT.
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

    // On-the-fly title cleanup for legacy junk titles
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
