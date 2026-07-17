/**
 * routes/scan.js — Cosmolyze Scan Routes
 *
 * Endpoints:
 *   POST /api/scan/save          → Persist a scan result + update user streak
 *   GET  /api/scan/history       → Return last 20 scans for the authed user
 *   POST /api/scan/product-image → Fetch a product image via Google CSE with
 *                                   MongoDB TTL caching and concurrency dedup
 */

const express = require('express');
const protect = require('../middleware/auth');
const ScanResult = require('../models/ScanResult');
const User = require('../models/User');
const CachedProduct = require('../models/CachedProduct');

const router = express.Router();

// ── Google CSE Configuration ─────────────────────────────────────────────────
// API key pool — keys are hot-swapped automatically when a 429 quota error
// is received. Add more keys to the array to expand the rotation pool.
const CSE_KEY_POOL = [
  process.env.IMAGE_KEY_1,
  process.env.IMAGE_KEY_2,
].filter(Boolean); // drop any undefined/empty entries

const CSE_CX = process.env.GOOGLE_CSE_CX;

// ── In-Memory Concurrency Lock (Thundering Herd prevention) ──────────────────
// Maps a normalised productName → Promise<string> (the inflight CSE fetch).
// If two requests arrive for the same product simultaneously, the second one
// awaits the first promise instead of firing a duplicate CSE request.
const inflightRequests = new Map();

// ── Fallback image served when all CSE keys are exhausted ────────────────────
const FALLBACK_IMAGE = '/images/default-clinical-bottle.png';

// ── Helper: fetch a product image from Google CSE with key rotation ───────────
/**
 * Cycles through CSE_KEY_POOL until a valid image URL is returned.
 * On 429 (quota exceeded) or any network error, rotates to the next key.
 * Throws only after every key in the pool has been tried.
 *
 * @param {string} productName — already normalised (trim + lowercase)
 * @returns {string} image URL
 */
async function fetchImageFromCSE(productName) {
  if (!CSE_CX) throw new Error('GOOGLE_CSE_CX is not configured in .env');
  if (CSE_KEY_POOL.length === 0) throw new Error('No IMAGE_KEY_* keys configured in .env');

  let lastError;

  for (let keyIndex = 0; keyIndex < CSE_KEY_POOL.length; keyIndex++) {
    const apiKey = CSE_KEY_POOL[keyIndex];
    const searchQuery = encodeURIComponent(`${productName} product`);
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${CSE_CX}&q=${searchQuery}&searchType=image&num=1`;

    try {
      console.log(`[Scan] CSE image fetch attempt with key[${keyIndex + 1}/${CSE_KEY_POOL.length}] for: "${productName}"`);

      const res = await fetch(url);

      if (res.status === 429) {
        // Quota exceeded on this key — hot-swap to the next one
        console.warn(`[Scan] CSE key[${keyIndex + 1}] hit 429 quota limit, rotating to next key...`);
        lastError = new Error(`CSE key[${keyIndex + 1}] quota exceeded (429)`);
        continue; // try next key
      }

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`CSE API error ${res.status}: ${errBody}`);
      }

      const data = await res.json();
      const imageUrl = data?.items?.[0]?.link;

      if (!imageUrl) {
        throw new Error(`CSE returned no image results for: "${productName}"`);
      }

      console.log(`[Scan] CSE image fetched successfully for: "${productName}"`);
      return imageUrl;

    } catch (err) {
      // If error was not a quota rotation (already continued), record it
      if (!err.message.includes('quota exceeded')) {
        lastError = err;
        console.error(`[Scan] CSE key[${keyIndex + 1}] error:`, err.message);
        // For non-quota errors (network failures), also try next key
        continue;
      }
    }
  }

  // All keys exhausted
  throw lastError || new Error('All CSE API keys failed');
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/scan/product-image
//  Body: { productName: string }
//  Response: { success: true, imageUrl: string, fromCache: boolean }
//
//  Flow:
//    1. Check MongoDB TTL cache → return immediately if hit
//    2. Check inflightRequests Map → await existing promise if pending (dedup)
//    3. Fire Google CSE fetch with automatic key rotation on 429
//    4. Write successful result to MongoDB cache
//    5. Return fallback image if all keys exhausted
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

    // Normalise: always trim + lowercase for consistent cache keys
    const productKey = productName.trim().toLowerCase();

    // ── Layer 1: MongoDB Cache Hit ────────────────────────────────────────────
    try {
      const cached = await CachedProduct.findOne({ productName: productKey }).lean();
      if (cached) {
        console.log(`[Scan] Cache HIT for: "${productKey}"`);
        return res.status(200).json({
          success: true,
          imageUrl: cached.imageUrl,
          fromCache: true,
        });
      }
    } catch (cacheErr) {
      // Cache read failure is non-fatal — proceed to CSE fetch
      console.warn('[Scan] MongoDB cache read failed (non-fatal):', cacheErr.message);
    }

    // ── Layer 2: In-Flight Deduplication Lock ─────────────────────────────────
    if (inflightRequests.has(productKey)) {
      console.log(`[Scan] Dedup lock HIT — awaiting existing promise for: "${productKey}"`);
      try {
        const imageUrl = await inflightRequests.get(productKey);
        return res.status(200).json({ success: true, imageUrl, fromCache: false });
      } catch {
        // The existing inflight request also failed — fall through to fallback
        return res.status(200).json({
          success: true,
          imageUrl: FALLBACK_IMAGE,
          fromCache: false,
        });
      }
    }

    // ── Layer 3: CSE Fetch — register promise in lock BEFORE firing request ────
    let resolveInflight, rejectInflight;
    const inflightPromise = new Promise((resolve, reject) => {
      resolveInflight = resolve;
      rejectInflight = reject;
    });
    inflightRequests.set(productKey, inflightPromise);

    let imageUrl = FALLBACK_IMAGE;
    try {
      imageUrl = await fetchImageFromCSE(productKey);

      // ── Layer 4: Write to MongoDB Cache ────────────────────────────────────
      try {
        await CachedProduct.findOneAndUpdate(
          { productName: productKey },
          { productName: productKey, imageUrl },
          { upsert: true, new: true }
        );
        console.log(`[Scan] Cached image for: "${productKey}"`);
      } catch (writeErr) {
        // Cache write failure is non-fatal — still return the image
        console.warn('[Scan] MongoDB cache write failed (non-fatal):', writeErr.message);
      }

      resolveInflight(imageUrl);
    } catch (fetchErr) {
      // ── All CSE keys exhausted — use fallback ───────────────────────────────
      console.error(`[Scan] All CSE keys failed for: "${productKey}" →`, fetchErr.message);
      console.log(`[Scan] Using fallback image: ${FALLBACK_IMAGE}`);
      imageUrl = FALLBACK_IMAGE;
      rejectInflight(fetchErr); // signal waiting duplicates to also use fallback
    } finally {
      // CRITICAL: Always clear the lock — prevents Map memory leak
      inflightRequests.delete(productKey);
    }

    return res.status(200).json({
      success: true,
      imageUrl,
      fromCache: false,
    });

  } catch (err) {
    // Outer catch — this should never trigger, but guarantees crash safety
    console.error('[Scan ProductImage Error]', err);
    return res.status(200).json({
      success: true,
      imageUrl: FALLBACK_IMAGE,
      fromCache: false,
    });
  }
});

// ── POST /api/scan/save ──────────────────────────────────────────────────────
// Saves a scan result and updates the user's streak counter.
// Requires: Authorization: Bearer <token>
// Body: { concern_category, ai_full_json_result, scan_image_url? }
router.post('/save', protect, async (req, res) => {
  try {
    const { concern_category, ai_full_json_result = {}, scan_image_url = null } = req.body;

    if (!concern_category) {
      return res.status(400).json({ success: false, message: 'concern_category is required.' });
    }

    // Persist the scan result
    const scanResult = await ScanResult.create({
      userId: req.userId,
      concern_category,
      ai_full_json_result,
      scan_image_url,
    });

    // ── Streak Logic ──────────────────────────────────────────────────────
    // Compare today's date (YYYY-MM-DD) to last_scan_date on the user doc.
    // - Same day  → no change (already counted)
    // - Yesterday → streak_count += 1
    // - Older     → streak_count resets to 1
    const today = new Date().toISOString().slice(0, 10); // "2026-07-16"
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
        created_at: scanResult.createdAt,
      },
    });
  } catch (err) {
    console.error('[Scan Save Error]', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ── GET /api/scan/history ────────────────────────────────────────────────────
// Returns the last 20 scan results for the authenticated user.
// Requires: Authorization: Bearer <token>
router.get('/history', protect, async (req, res) => {
  try {
    const scans = await ScanResult.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('concern_category createdAt ai_full_json_result scan_image_url')
      .lean();

    // Also grab the current streak count
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
