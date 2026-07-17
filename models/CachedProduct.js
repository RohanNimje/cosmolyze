/**
 * models/CachedProduct.js — MongoDB TTL Cache for Product Images
 *
 * Stores the resolved DuckDuckGo image URL keyed by normalised product name.
 * TTL index auto-expires documents after 30 days (2592000 seconds) so the
 * cache stays fresh without any manual cleanup jobs.
 *
 * Note: local fallback paths (default-clinical-bottle.png) are treated as
 * cache misses by routes/scan.js and will be overwritten with live URLs.
 */

const mongoose = require('mongoose');

const cachedProductSchema = new mongoose.Schema(
  {
    // Normalised key: always stored as .trim().toLowerCase()
    productName: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      lowercase: true,
    },
    imageUrl: {
      type: String,
      required: true,
    },
  },
  {
    // createdAt is the field the TTL index watches
    timestamps: true,
  }
);

// ── 30-day TTL index ─────────────────────────────────────────────────────────
// MongoDB's TTL thread will automatically delete documents where
// createdAt is older than 2592000 seconds (30 days).
cachedProductSchema.index({ createdAt: 1 }, { expires: 2592000 });

module.exports = mongoose.model('CachedProduct', cachedProductSchema);
