/**
 * routes/scan.js — Cosmolyze Scan Routes
 *
 * Endpoints:
 *   POST /api/scan/save          → Persist a scan result + update user streak
 *   GET  /api/scan/history       → Return last 20 scans for the authed user
 *   POST /api/scan/product-image → Resolve a commercial product packshot.
 *                                   Layer 1: MongoDB TTL cache        (~50ms)
 *                                   Layer 2: Bing Image Search scraper (~800ms)
 *                                     • Strict query: quoted product name + negatives
 *                                     • Tier 1: murl data island → full-res retail CDN
 *                                       (PACKSHOT_ALLOW / PACKSHOT_DENY classification)
 *                                     • Tier 2: Bing CDN thumbnail (th.bing.com or
 *                                       tse*.mm.bing.net) — always https, always 200
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

// ── Inflight stagger — eliminates Bing rate-limiting during 5-card burst ────────
// Delay is proportional to current concurrency (120ms × inflight count, max 600ms).
// Duplicate requests for the same productKey are coalesced onto one promise.
const inflightRequests = new Map();
const STAGGER_MS = 120;

async function staggeredFetch(productKey, fetcher) {
  // Coalesce duplicate in-flight requests for the same product
  if (inflightRequests.has(productKey)) {
    return inflightRequests.get(productKey);
  }
  // Stagger proportional to concurrent load, capped at 600ms
  const delay = Math.min(inflightRequests.size * STAGGER_MS, 600);
  if (delay > 0) {
    await new Promise((r) => setTimeout(r, delay));
  }

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
 * Tier 1 domain allow/deny lists for murl candidates.
 *
 * PACKSHOT_ALLOW: URL path signals strongly indicating a retail product image
 *   (e-commerce CDN slugs, brand slugs, well-known packaging keywords).
 * PACKSHOT_DENY:  Sites that exclusively serve stock photos, AI art,
 *   wallpapers, or food content — never a real product packshot.
 */
const PACKSHOT_ALLOW =
  /cdn\.|shop\.|product|catalog|media|img\d*\.|images\d*\.|static\.|assets\.|store\.|upload|wp-content|wp-uploads|gallery|ecommerce|buyonline|pharma|beauty|health|loreal|neutrogena|cerave|ordinary|minimalist|mamaearth|dotandkey|plum|lakme|himalaya|beardo|wow|vlcc|forest|khadi|biotique|innisfree|inkey|garnier|nivea|olay|ponds|vaseline|dove|stridex|skinceuticals|paulaschoice|cocokind|glow|supergoop|tatcha|kiehl|laneige|cosrx|pacifica|acnefree|clearasil|bioderma|la.roche|vichy|avene|caudalie|murad|dermalogica|clinique|estee|lancome|shiseido/i;

const PACKSHOT_DENY =
  /wallpaper|recipe|school|anime|meme|food\.(?:com|net|org)|nutrition|cooking|restaurant|vecteezy|freepik\.com|shutterstock|alamy\.com|istockphoto|gettyimages|dreamstime|stockphoto|vectorstock|stablediffusion|midjourney|dalle|pixabay\.com|pexels\.com|unsplash\.com|mockupcloud|pinshop\.com|depositphotos|123rf\.com|bigstockphoto|pngwing|pngtree|cleanpng|freepnglogos|kindpng|clipart/i;

/**
 * Fetch a product packshot from Bing Image Search HTML.
 *
 * Query is tuned for maximum retail relevance:
 *   - Quoted product name → exact phrase match
 *   - "skincare serum bottle" → biases Bing toward product photography
 *   - Negative keywords → eliminates food, wallpaper, anime, recipes
 *   - qft photo filter → forces actual photographs, not graphic banners
 *
 * Resolution tiers (no HEAD validation — geo-CDNs return 404/405 on HEAD
 * but serve images correctly on GET; HEAD checks cause false negatives):
 *   Tier 1 (strict)  — murl matching PACKSHOT_ALLOW, not PACKSHOT_DENY
 *   Tier 1 (relaxed) — any non-denied murl (if strict finds nothing)
 *   Tier 2           — Bing CDN thumbnail: th.bing.com or tse*.mm.bing.net
 *                      Smaller resolution but guaranteed https + 200.
 *
 * @param {string} productName — normalised product name
 * @returns {Promise<string|null>} — https:// image URL, or null on total miss
 */
async function fetchFromBing(productName) {
  try {
    // Strict retail query: quoted name + packshot signal + negatives + photo filter
    const q = encodeURIComponent(
      '"' + productName + '" skincare serum bottle -food -recipe -wallpaper -anime'
    );
    const url = 'https://www.bing.com/images/search?q=' + q + '&form=HDRSC3&first=1&qft=+filterui:photo-photo';

    const res = await fetch(url, {
      signal: AbortSignal.timeout(7000),
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

    // ── Tier 1: murl data island — full-res source images ─────────────────────
    // Bing embeds media URLs in a JSON island as HTML-entity-encoded strings.
    // Scan ALL candidates; classify by ALLOW/DENY; return first strict pass.
    // Relaxed list collects non-denied candidates as fallback if strict fails.
    const murlRe = /murl&quot;:&quot;(https?:\/\/[^&"]+\.(?:jpe?g|png|webp)(?:\?[^&"]*)?)/gi;
    let m;
    const relaxedCandidates = [];

    while ((m = murlRe.exec(html)) !== null) {
      const img = m[1];
      if (!img || !img.startsWith('https://') || /bing\.net|microsoft\.com|bing\.com/i.test(img)) continue;
      if (PACKSHOT_DENY.test(img)) continue; // hard reject: stock / AI / food sites

      if (PACKSHOT_ALLOW.test(img)) {
        console.log(`[Bing T1] Resolved "${productName}" → ${img}`);
        return img;
      }
      relaxedCandidates.push(img);
    }

    // Tier 1 relaxed: non-denied murl (general CDN not in allow list)
    if (relaxedCandidates.length > 0) {
      console.log(`[Bing T1r] Resolved "${productName}" → ${relaxedCandidates[0]}`);
      return relaxedCandidates[0];
    }

    // ── Tier 2: Bing CDN thumbnail ─────────────────────────────────────────────
    // th.bing.com: modern Bing CDN; tse*.mm.bing.net: legacy mobile CDN.
    // Both are always https:// and return 200 on GET.
    const bingCdnRe = /https:\/\/(?:th\.bing\.com\/th\/id|tse\d+\.mm\.bing\.net\/th\/id)\/[A-Za-z0-9._%-]+(?:\?[^"&\s]*)?/gi;
    const cdnMatches = html.match(bingCdnRe);
    if (cdnMatches && cdnMatches[0]) {
      console.log(`[Bing T2] CDN thumbnail for "${productName}" → ${cdnMatches[0]}`);
      return cdnMatches[0];
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
