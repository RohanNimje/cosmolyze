const mongoose = require('mongoose');

const clinicalProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true, // one profile per user
      index: true,
    },
    skin_type: {
      type: String,
      enum: ['Oily', 'Dry', 'Combination', 'Normal', 'Sensitive'],
      default: null,
    },
    sensitivity: {
      type: String,
      enum: ['Very Resilient', 'Moderately Sensitive', 'Highly Reactive', 'Rosacea-Prone'],
      default: null,
    },
    allergies: {
      type: [String], // e.g. ['Fragrance', 'Essential Oils']
      default: [],
    },
    budget_min: {
      type: Number,
      default: 100,
    },
    budget_max: {
      type: Number,
      default: 3000,
    },
    routine_focus: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('ClinicalProfile', clinicalProfileSchema);
