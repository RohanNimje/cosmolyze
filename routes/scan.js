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

// ── Verified Retail & Packaging CDNs Whitelist ────────────────────────────────
const BRAND_DOMAINS = {
  'deconstruct': 'thedeconstruct.in',
  'minimalist': 'beminimalist.co',
  'beminimalist': 'beminimalist.co',
  'the derma co': 'thedermaco.com',
  'derma co': 'thedermaco.com',
  'dot & key': 'dotandkey.com',
  'plum': 'plumgoodness.com',
  'foxtale': 'foxtale.in',
  'chemist at play': 'chemistatplay.com',
  'dr sheth': 'drsheths.com',
  'aqualogica': 'aqualogica.in',
};

const TRUSTED_DOMAINS = [
  'media-amazon.com',
  'images-amazon.com',
  'ssl-images-amazon.com',
  'images-static.nykaa.com',
  'adn-life.nykaa.com',
  'nykaa.com',
  'cdn.shopify.com',
  'myshopify.com',
  'thedeconstruct.in',
  'beminimalist.co',
  'theordinary.com',
  'thedermaco.com',
  'cerave.com',
  'purplle.com',
  'tirabeauty.com',
  'flixcart.com',
  'flipkart.com',
  'sephora.in',
  'sephora.com',
  'myntra.com',
  'tatacliq.com',
  'openbeautyfacts.org',
  'clinikally.com',
  'kindlife.in',
  'vanitywagon.com',
];

// ── Strict Junk & Non-Product Denylist ─────────────────────────────────────────
const JUNK_DENYLIST = [
  'pinterest', 'pinimg', 'scotscoop', 'wordpress', 'wp-content', 'blogspot',
  'wikimedia', 'wikipedia', 'freepik', 'vector', 'shutterstock', 'istockphoto',
  'depositphotos', 'dreamstime', 'alamy', '123rf', 'diagram', 'infographic',
  'molecule', 'structure', 'cartoon', 'clipart', 'meme', 'reddit', 'facebook',
  'instagram', 'tiktok', 'youtube', 'ytimg', 'quora', 'medium.com', 'delmeds',
  'free-photo', 'stock-photo', 'background', 'banner', 'illustration', 'studyfinds',
];

const KNOWN_BRANDS = [
  'the ordinary', 'minimalist', 'beminimalist', 'deconstruct', 'cerave',
  'the derma co', 'derma co', 'dr sheth', 'dot & key', 'plum', 'cetaphil',
  'neutrogena', 'la roche posay', 'cosrx', 'paulas choice', 'bioderma',
  'chemist at play', 'foxtale', 'mamaearth', 'innisfree', 'laneige',
  'klairs', 'fixderma', 'requil', 'sebamed', 'aqualogica',
];

/** Extract brand name and core tokens from product name */
function extractBrandAndTokens(productName) {
  const norm = productName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  let foundBrand = '';
  for (const b of Object.keys(BRAND_DOMAINS).concat(KNOWN_BRANDS)) {
    if (norm.includes(b)) {
      foundBrand = b;
      break;
    }
  }

  let core = norm;
  if (foundBrand) {
    core = norm.replace(new RegExp(`\\b${foundBrand}\\b`, 'g'), ' ').replace(/\s+/g, ' ').trim();
  }

  return { brand: foundBrand, core };
}

// ── Product Image Resolution Engines ──────────────────────────────────────────

/**
 * Tier 1: Direct Brand Shopify Catalog API.
 * High-speed, guaranteed official e-commerce CDN image for brand stores.
 */
async function fetchFromBrandStore(brand, coreTokens) {
  const domain = BRAND_DOMAINS[brand];
  if (!domain) return null;

  // Extract clean keywords (strip numbers, %, and stop words)
  const queryTerms = coreTokens
    .replace(/\b\d+%\b|\b\d+\b/g, '')
    .replace(/\b(under|with|and|for|the|plus)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  try {
    const url = `https://${domain}/search/suggest.json?q=${encodeURIComponent(queryTerms)}&resources[type]=product`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!res.ok) return null;
    const data = await res.json();
    const products = data?.resources?.results?.products || [];

    for (const p of products) {
      if (p?.image && p.image.startsWith('https://')) {
        let img = p.image;
        if (img.startsWith('//')) img = 'https:' + img;
        const lower = img.toLowerCase();
        if (!JUNK_DENYLIST.some((j) => lower.includes(j))) {
          console.log(`[Brand Store] Resolved "${brand}" → ${img}`);
          return img;
        }
      }
    }
  } catch (err) {
    console.warn(`[Brand Store] Error for "${brand}": ${err.message}`);
  }
  return null;
}

/**
 * Tier 2: Open Beauty Facts Verified Cosmetic Database.
 */
async function fetchFromOpenBeautyFacts(brand, coreTokens) {
  try {
    const q = brand ? `${brand} ${coreTokens}` : coreTokens;
    const res = await fetch(`https://world.openbeautyfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1`, {
      signal: AbortSignal.timeout(3500),
      headers: { 'User-Agent': 'Cosmolyze/1.0' },
    });

    if (!res.ok) return null;
    const data = await res.json();
    const products = data?.products || [];

    for (const p of products) {
      const img = p?.image_front_url || p?.image_url || p?.image_small_url;
      if (img && img.startsWith('https://')) {
        const lower = img.toLowerCase();
        if (!JUNK_DENYLIST.some((j) => lower.includes(j))) {
          console.log(`[OpenBeautyFacts] Resolved "${q}" → ${img}`);
          return img;
        }
      }
    }
  } catch (err) {
    console.warn(`[OpenBeautyFacts] Error for "${brand}": ${err.message}`);
  }
  return null;
}

/**
 * Tier 3: Verified Search Engine Index with Domain Whitelist & Token Relevance.
 */
async function fetchProductPackshotLive(productName) {
  const { brand, core } = extractBrandAndTokens(productName);
  const q = `${brand ? brand + ' ' : ''}${core} packaging bottle`;

  try {
    const tokenRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`, {
      signal: AbortSignal.timeout(3500),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });

    if (!tokenRes.ok) return null;
    const html = await tokenRes.text();
    const vqdMatch = html.match(/vqd=["']?([\d-]+)["']?/);
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

    if (!imgRes.ok) return null;
    const data = await imgRes.json().catch(() => null);
    const results = data?.results || [];
    const scored = [];

    for (const item of results) {
      const imgUrl = (item.image || '').trim();
      const title = (item.title || '').toLowerCase();
      const pageUrl = (item.url || '').toLowerCase();

      if (!imgUrl || !imgUrl.startsWith('https://')) continue;

      const lowerImg = imgUrl.toLowerCase();

      // 1. Strict Junk Denylist Filter
      if (JUNK_DENYLIST.some((j) => lowerImg.includes(j) || title.includes(j) || pageUrl.includes(j))) continue;
      if (/\.(svg|ico|gif)(\?.*)?$/i.test(lowerImg)) continue;
      if (/logo|favicon|banner|icon|badge|clipart/i.test(lowerImg)) continue;

      let score = 0;

      // 2. Trusted Retail Domain / Verified CDN (+100)
      if (TRUSTED_DOMAINS.some((d) => lowerImg.includes(d) || pageUrl.includes(d))) {
        score += 100;
      }

      // 3. Brand Match (+50)
      if (brand && (title.includes(brand) || lowerImg.includes(brand) || pageUrl.includes(brand))) {
        score += 50;
      }

      // 4. Token Matches (+15 per matching word)
      const tokens = core.split(/\s+/).filter((t) => t.length > 2);
      for (const t of tokens) {
        if (title.includes(t) || lowerImg.includes(t) || pageUrl.includes(t)) {
          score += 15;
        }
      }

      if (score >= 60) {
        scored.push({ url: imgUrl, score, title, pageUrl });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      console.log(`[Image Engine] Resolved "${productName}" → ${scored[0].url} (Score: ${scored[0].score})`);
      return scored[0].url;
    }

    return null;
  } catch (err) {
    console.warn(`[Image Engine] Fetch error for "${productName}": ${err.message}`);
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
//    1. MongoDB TTL cache        — instant (~15-50ms), skips dummy/fallback entries
//    2. Brand Direct Store       — official Shopify catalog API (~250ms)
//    3. Open Beauty Facts        — verified cosmetic packaging database (~400ms)
//    4. Retail Search Engine     — search index with domain whitelist & relevance scoring (~900ms)
//    5. Null signal              — { imageUrl: null } — client renders fallback image
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

    const { brand, core } = extractBrandAndTokens(productKey);

    // ── Layer 2: Direct Brand Store API ──────────────────────────────────────
    let imageUrl = null;
    if (brand && BRAND_DOMAINS[brand]) {
      imageUrl = await fetchFromBrandStore(brand, core);
    }

    // ── Layer 3: Verified Cosmetic Database (Open Beauty Facts) ──────────────
    if (!imageUrl) {
      imageUrl = await fetchFromOpenBeautyFacts(brand, core);
    }

    // ── Layer 4: Live Commercial Search Engine with Domain Filter ────────────
    if (!imageUrl) {
      imageUrl = await fetchProductPackshotLive(productKey);
    }

    if (imageUrl) {
      // Persist to MongoDB so the next request for this product is a cache HIT (~20ms)
      await persistProductImageCache(productKey, imageUrl);
      return res.status(200).json({ success: true, imageUrl, fromCache: false });
    }

    // ── Layer 5: No result — return null signal ───────────────────────────────
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
