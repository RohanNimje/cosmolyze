const mongoose = require('mongoose');

const savedProductSchema = new mongoose.Schema(
  {
    product_name: { type: String, required: true },
    brand: { type: String, default: '' },
    price: { type: Number, default: 0 },
    // Canonical key — matches POST /api/scan/product-image response shape
    imageUrl: { type: String, default: '/images/default-clinical-bottle.png' },
    // Legacy alias retained for older documents
    image_url: { type: String, default: '' },
    amazon_url: { type: String, default: '' },
    clinical_match_score: { type: Number, default: 0 }, // 0–100
    added_at: { type: Date, default: Date.now },
  },
  { _id: false } // embedded sub-docs don't need their own _id
);

const digitalShelfSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    saved_products: {
      type: [savedProductSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('DigitalShelf', digitalShelfSchema);
