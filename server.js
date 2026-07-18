require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const authRoutes = require('./routes/auth');
const scanRoutes = require('./routes/scan');
const aiRoutes = require('./routes/ai');
const shelfRoutes = require('./routes/shelf');

// ═══════════════════════════════════════════════════════════════════════════════
//  SYSTEM PROMPTS — defined in ./prompts.js for easy editing without touching
//  API logic. routes/ai.js imports them directly from there.
// ═══════════════════════════════════════════════════════════════════════════════

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 10mb to handle base64 image payloads
app.use(express.static(path.join(__dirname))); // serve index.html + assets

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── API Routes ──────────────────────────────────────────────────────────────
app.get('/api', (req, res) => {
  res.json({ success: true, message: '🚀 Cosmolyze API is running.' });
});

app.use('/api/auth', authRoutes);
app.use('/api/scan', scanRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/shelf', shelfRoutes);

// ── SPA Fallback — serve index.html for non-API routes ─────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 404 Handler (API routes only) ────────────────────────────────────
app.use('/api/*path', (req, res) => {
  res.status(404).json({ success: false, message: 'API route not found.' });
});

// ── Global Error Handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error.',
  });
});

// ── Database + Start Server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
// Support both MONGODB_URI (canonical) and MONGO_URI (legacy alias)
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ Database URI is not defined in .env — set MONGODB_URI (or MONGO_URI)');
  process.exit(1);
}

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`🌐 Server listening on http://localhost:${PORT}`);
      console.log(`📄 Frontend: http://localhost:${PORT}/`);
      console.log(`🔗 API Base: http://localhost:${PORT}/api`);
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
