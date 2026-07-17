/**
 * routes/shelf.js — Cosmolyze Digital Shelf Routes
 *
 * Endpoints:
 *   GET  /api/shelf          → Return saved products for the authed user
 *   POST /api/shelf/save     → Bookmark a product onto the user's shelf
 *   DELETE /api/shelf/:name  → Remove a product by product_name
 */

const express = require('express');
const protect = require('../middleware/auth');
const DigitalShelf = require('../models/DigitalShelf');

const router = express.Router();

const FALLBACK_IMAGE = '/images/default-clinical-bottle.png';

/** Normalise incoming product payloads to the canonical imageUrl key. */
function normaliseProduct(body = {}) {
  const imageUrl =
    body.imageUrl ||
    body.image_url ||
    body.image ||
    FALLBACK_IMAGE;

  return {
    product_name: String(body.product_name || body.productName || '').trim(),
    brand: String(body.brand || '').trim(),
    price: Number(body.price || body.price_inr || 0) || 0,
    imageUrl,
    amazon_url: String(body.amazon_url || body.amazonUrl || '').trim(),
    clinical_match_score: Number(body.clinical_match_score || body.clinical_match_pct || 0) || 0,
    added_at: new Date(),
  };
}

// ── GET /api/shelf ───────────────────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    let shelf = await DigitalShelf.findOne({ userId: req.userId }).lean();
    if (!shelf) {
      shelf = { saved_products: [] };
    }

    // Always expose imageUrl (map legacy image_url if present)
    const products = (shelf.saved_products || []).map((p) => ({
      ...p,
      imageUrl: p.imageUrl || p.image_url || FALLBACK_IMAGE,
    }));

    return res.status(200).json({
      success: true,
      data: { products },
    });
  } catch (err) {
    console.error('[Shelf Get Error]', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ── POST /api/shelf/save ─────────────────────────────────────────────────────
router.post('/save', protect, async (req, res) => {
  try {
    const product = normaliseProduct(req.body);

    if (!product.product_name || product.product_name.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'product_name is required.',
      });
    }

    let shelf = await DigitalShelf.findOne({ userId: req.userId });
    if (!shelf) {
      shelf = new DigitalShelf({ userId: req.userId, saved_products: [] });
    }

    const existingIdx = shelf.saved_products.findIndex(
      (p) => p.product_name.toLowerCase() === product.product_name.toLowerCase()
    );

    if (existingIdx >= 0) {
      // Refresh image + metadata on re-save
      shelf.saved_products[existingIdx] = {
        ...shelf.saved_products[existingIdx].toObject?.() || shelf.saved_products[existingIdx],
        ...product,
      };
    } else {
      shelf.saved_products.unshift(product);
    }

    await shelf.save();

    return res.status(201).json({
      success: true,
      message: 'Product saved to My Digital Shelf.',
      data: {
        product: {
          ...product,
          imageUrl: product.imageUrl,
        },
      },
    });
  } catch (err) {
    console.error('[Shelf Save Error]', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ── DELETE /api/shelf/:name ──────────────────────────────────────────────────
router.delete('/:name', protect, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name || '').trim().toLowerCase();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Product name is required.' });
    }

    const shelf = await DigitalShelf.findOne({ userId: req.userId });
    if (!shelf) {
      return res.status(404).json({ success: false, message: 'Shelf not found.' });
    }

    const before = shelf.saved_products.length;
    shelf.saved_products = shelf.saved_products.filter(
      (p) => p.product_name.toLowerCase() !== name
    );

    if (shelf.saved_products.length === before) {
      return res.status(404).json({ success: false, message: 'Product not found on shelf.' });
    }

    await shelf.save();
    return res.status(200).json({ success: true, message: 'Product removed from shelf.' });
  } catch (err) {
    console.error('[Shelf Delete Error]', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

module.exports = router;
