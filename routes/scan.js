/**
 * routes/scan.js — Cosmolyze Scan Routes
 *
 * Endpoints:
 *   POST /api/scan/save          → Persist a scan result + update user streak
 *   GET  /api/scan/history       → Return last 20 scans for the authed user
 *   POST /api/scan/product-image → Fetch a commercial product packshot via
 *                                   DuckDuckGo with MongoDB TTL caching,
 *                                   sequential rate-limit, and concurrency dedup.
 *                                   On datacenter-IP 403s, auto-fails over
 *                                   through allorigins.win → corsproxy.io.
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

/** Full modern-browser emulation headers — reduces datacenter-IP bot rejection. */
const DDG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  Referer: 'https://duckduckgo.com/',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  Connection: 'keep-alive',
};

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

// ── DuckDuckGo — Commercial Product Packshot Search ─────────────────────────
/**
 * Obtain a DuckDuckGo vqd token required by the i.js image endpoint.
 * Uses modern browser-emulation headers to reduce bot-detection rejections.
 * @returns {Promise<string|null>}
 */
async function fetchDuckDuckGoVqd(query) {
  try {
    const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...DDG_HEADERS,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[Scan][T2] DDG vqd page failed with status ${res.status}`);
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

    console.warn('[Scan][T2] DDG vqd token not found in response HTML');
    return null;
  } catch (err) {
    console.warn('[Scan][T2] DDG vqd fetch error:', err.message);
    return null;
  }
}

/**
 * Parse and validate DDG i.js JSON results into the first clean image URL.
 * Shared between the direct fetch and the proxy-retry path.
 *
 * @param {string} responseText — raw response body text
 * @param {string} productName  — used for logging
 * @returns {string|null}
 */
/**
 * Top cosmetic retail CDN hostnames, in priority order.
 * Results whose URL contains one of these hosts are surfaced first.
 */
const PRIORITY_CDN_HOSTS = [
  'nykaa.com',
  'sephora.com',
  'amazon.com',
  'tirabeauty.com',
  'myntra.com',
  'purplle.com',
];

function extractDDGImageFromResponseText(responseText, productName) {
  let data = null;
  try { data = JSON.parse(responseText); } catch { return null; }

  const results = Array.isArray(data?.results) ? data.results : [];

  // Collect all valid candidates first so we can apply the CDN priority gate.
  const valid = [];
  for (const item of results) {
    const candidate = item?.image || item?.thumbnail || item?.url;
    const title = item?.title || '';
    if (
      typeof candidate === 'string' &&
      /^https?:\/\//i.test(candidate) &&
      !isInvalidProductMedia(title, candidate)
    ) {
      valid.push({ url: candidate, title });
    } else if (candidate) {
      console.log(`[Scan][DDG] Rejected invalid media: "${title}"`);
    }
  }

  if (valid.length === 0) return null;

  // ── Domain priority gate: prefer top cosmetic retail CDNs ────────────────
  for (const host of PRIORITY_CDN_HOSTS) {
    const prioritized = valid.find((v) => v.url.includes(host));
    if (prioritized) {
      console.log(`[Scan][DDG] Priority CDN match (${host}) for: "${productName}"`);
      return prioritized.url;
    }
  }

  // Fallback: first passing candidate regardless of host
  console.log(`[Scan][DDG] Image found (no priority CDN) for: "${productName}"`);
  return valid[0].url;
}

/**
 * DuckDuckGo i.js commercial product packshot search.
 *
 * Query is retailer-anchored to surface official e-commerce listing images
 * (Sephora, Nykaa, Amazon, Tira Beauty, Myntra, Purplle) rather than
 * user reviews or encyclopedic assets.
 *
 * On HTTP 403 (datacenter IP ban), retries sequentially through:
 *   1. allorigins.win CORS proxy
 *   2. corsproxy.io CORS proxy
 *
 * @param {string} productName — already normalised (trim + lowercase)
 * @returns {Promise<string|null>}
 */
async function fetchImageFromDDG(productName) {
  try {
    // Retailer-anchored query with negative keywords to eliminate newspaper
    // clippings, article scans, and PDF thumbnails from results.
    const query =
      `"${productName}" product packaging bottle sephora nykaa amazon -newspaper -letter -article -pdf`;

    console.log(`[Scan][T2] DuckDuckGo image lookup for: "${productName}"`);

    const vqd = await fetchDuckDuckGoVqd(query);
    if (!vqd) {
      console.warn('[Scan][T2] DDG lookup — missing vqd, skipping');
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

    // ── Attempt 1: Direct fetch with full modern browser-emulation headers ────
    const DDG_FULL_HEADERS = {
      ...DDG_HEADERS,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'X-Requested-With': 'XMLHttpRequest',
    };

    let responseText = null;
    const directRes = await fetch(ijsUrl, {
      method: 'GET',
      headers: DDG_FULL_HEADERS,
      signal: AbortSignal.timeout(8000),
    });

    if (directRes.ok) {
      responseText = await directRes.text().catch(() => null);
    } else if (directRes.status === 403) {
      // ── Attempt 2: 403 → retry via allorigins.win ────────────────────────
      console.warn('[Scan][DDG] i.js returned 403 — retrying via allorigins.win proxy');
      const proxy1Url = `https://api.allorigins.win/raw?url=${encodeURIComponent(ijsUrl)}`;
      try {
        const proxy1Res = await fetch(proxy1Url, {
          method: 'GET',
          headers: { 'User-Agent': COSMOLYZE_UA },
          signal: AbortSignal.timeout(10000),
        });
        if (proxy1Res.ok) {
          responseText = await proxy1Res.text().catch(() => null);
          console.log('[Scan][DDG] allorigins.win proxy fetch succeeded');
        } else {
          console.warn(`[Scan][DDG] allorigins.win proxy returned HTTP ${proxy1Res.status} — trying corsproxy.io`);
        }
      } catch (proxy1Err) {
        console.warn(`[Scan][DDG] allorigins.win proxy error: ${proxy1Err.message} — trying corsproxy.io`);
      }

      // ── Attempt 3: still no response → corsproxy.io ──────────────────────
      if (!responseText) {
        const proxy2Url = `https://corsproxy.io/?url=${encodeURIComponent(ijsUrl)}`;
        try {
          const proxy2Res = await fetch(proxy2Url, {
            method: 'GET',
            headers: { 'User-Agent': COSMOLYZE_UA },
            signal: AbortSignal.timeout(10000),
          });
          if (proxy2Res.ok) {
            responseText = await proxy2Res.text().catch(() => null);
            console.log('[Scan][DDG] corsproxy.io proxy fetch succeeded');
          } else {
            console.warn(`[Scan][DDG] corsproxy.io proxy returned HTTP ${proxy2Res.status}`);
          }
        } catch (proxy2Err) {
          console.warn(`[Scan][DDG] corsproxy.io proxy error: ${proxy2Err.message}`);
        }
      }
    } else {
      console.warn(`[Scan][DDG] i.js returned HTTP ${directRes.status}`);
    }

    if (!responseText) {
      console.warn(`[Scan][DDG] No usable response for: "${productName}"`);
      return null;
    }

    const found = extractDDGImageFromResponseText(responseText, productName);
    if (!found) {
      console.warn(`[Scan][DDG] No valid product image in results for: "${productName}"`);
    }
    return found;
  } catch (err) {
    console.warn('[Scan][DDG] Fetch error:', err.message);
    return null;
  }
}

// ── Commercial Packshot Image Engine (public entry point) ────────────────────
/**
 * Pure DuckDuckGo commercial packshot pipeline.
 * Function name retained for call-site compatibility.
 *
 * Query targets official e-commerce product listing images from top cosmetic
 * retailers (Sephora, Nykaa, Amazon, Tira Beauty, Myntra, Purplle).
 * Results are filtered through isInvalidProductMedia() and ranked by
 * a CDN priority gate before being accepted.
 *
 * On datacenter-IP 403s the engine fails over through:
 *   allorigins.win → corsproxy.io
 *
 * Returns null (→ FALLBACK_IMAGE at call site) only when all attempts fail.
 * Never throws.
 *
 * @param {string} productName — already normalised (trim + lowercase)
 * @returns {Promise<string|null>}
 */
async function fetchImageFromCSE(productName) {
  const result = await fetchImageFromDDG(productName);

  if (result) {
    console.log(`[ImageEngine] Resolved ${productName} -> ${result}`);
    return result;
  }

  console.warn(`[ImageEngine] All attempts exhausted for: "${productName}" — falling back to placeholder`);
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
