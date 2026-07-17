const mongoose = require('mongoose');

const scanResultSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    concern_category: {
      type: String,
      required: [true, 'Concern category is required'],
      trim: true,
    },
    ai_full_json_result: {
      type: mongoose.Schema.Types.Mixed, // Flexible — stores full AI response object
      default: {},
    },
    scan_image_url: {
      type: String, // optional URL to stored scan image
      default: null,
    },
  },
  {
    timestamps: true, // createdAt = scan date
  }
);

// Compound index for fast per-user history queries (sorted by newest first)
scanResultSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('ScanResult', scanResultSchema);
