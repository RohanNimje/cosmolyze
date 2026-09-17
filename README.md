# Cosmolyze

> **Next-Generation Dermatological Intelligence & Multimodal Cosmetic Formulation Analysis Engine.**

[![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express-5.x-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose%209.x-47A248?style=flat-square&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![WebRTC](https://img.shields.io/badge/Capture-WebRTC%20%2F%20HTML5-333333?style=flat-square&logo=webrtc&logoColor=white)](https://webrtc.org/)
[![Computer Vision](https://img.shields.io/badge/Vision-Google%20Gemini%20%2F%20Groq-4285F4?style=flat-square&logo=google&logoColor=white)](https://ai.google.dev/)
[![Tailwind CSS](https://img.shields.io/badge/UI-Tailwind%20CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)

> 📖 **Comprehensive System Documentation:**  
> For deep-dive architectural breakdowns, INCI audit mechanisms, API schemas, and resilience fallbacks, explore the [Cosmolyze Architecture DeepWiki](https://deepwiki.com/RohanNimje/cosmolyze/7-glossary).
---

## 1. Overview & Value Proposition

**Cosmolyze** is an enterprise-grade dermatological AI platform engineered to bridge the gap between clinical skin diagnostics and commercial cosmetic formulation analysis. By uniting real-time computer vision, large language model clinical reasoning, and automated ingredient safety auditing, Cosmolyze provides precision skincare recommendations tailored to individual skin biomarkers and chemical tolerances.

### Core Capabilities
- **Facial Biomarker Detection**: Extracts facial topography indicators (comedones, active inflammatory acne, skin barrier texture, hyperpigmentation) via edge-optimized face detection (`face-api.js`) and multimodal vision models.
- **Dynamic 2-Stage Diagnostic Pipeline**: Conducts preliminary visual dermal analysis (Stage 1), dynamically structures customized clinical follow-up questions, and synthesizes answers into actionable dermatological verdicts with ranked product matches (Stage 2).
- **INCI Formula & Chemical Risk Audit**: Parses complex cosmetic International Nomenclature Cosmetic Ingredient (INCI) declarations to identify irritants, comedogenic ratings, allergen profiles, and functional actives.
- **Digital Shelf & Streak Analytics**: Tracks daily patient scan adherence, maintains longitudinal diagnosis history, and bookmarks clinically matched products.

---

## 2. System Architecture & Core Pipelines

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                         COSMOLYZE SYSTEM TOPOLOGY                           │
 └─────────────────────────────────────────────────────────────────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
         [Desktop / Laptop Client]             [Mobile Device Client]
         WebRTC Live Video Stream              HTML5 Native Camera API
         Mirror Feed + Face Guide              Direct OS Hardware Capture
                    │                                     │
                    └──────────────────┬──────────────────┘
                                       │
                                       ▼
                       [Client Preprocessing & Face-API]
                       - TinyFaceDetector Landmark Scan
                       - 20% Padded Smart Bounding Box Crop
                       - Normalised 512x512 Canvas Payload
                                       │
                                       ▼
                      [Express 5.x API Gateway Engine]
                                       │
         ┌─────────────────────────────┼─────────────────────────────┐
         ▼                             ▼                             ▼
  /api/ai/analyze-face       /api/scan/product-image       /api/ai/analyze-formula
  [Multimodal Cascade]       [Multi-Tier Packshot Engine]  [INCI Chemical Auditing]
  - Gemini Vision Flash      - Tier 1: Open Beauty Facts   - Comedogenic Index
  - OpenRouter Vision        - Tier 2: DDG + Proxy Engine  - Irritancy / Safety Scan
  - Groq Multi-Model         - In-Flight Concurrency Lock  - Active Compound Profiling
  - Fallback Protection      - MongoDB TTL Cache Layer     - Drug Interaction Rules
         │                             │                             │
         └─────────────────────────────┼─────────────────────────────┘
                                       │
                                       ▼
                             [MongoDB Persistence]
                             - Users & Daily Streak Engine
                             - Diagnostic Scan Records
                             - Digital Shelf Catalog
                             - 7-Day Asset Cache
```

### 2.1. Dual-Mode Hardware Capture Engine
The client interface implements a deterministic, device-aware capture workflow:
- **Desktop & Laptop Devices**: Intercepts camera triggers to launch a hardware-accelerated **WebRTC live video stream modal** (`navigator.mediaDevices.getUserMedia`). Features a real-time mirrored canvas, circular face alignment reticle, hardware device enumerator (`switchCamera`), and off-screen canvas rasterizer that captures frames to standard JPEG payloads with zero OS file explorer friction.
- **Mobile Handsets (iOS / Android)**: Leverages native HTML5 media capture (`<input type="file" accept="image/*" capture="environment">`) to delegate straight to the mobile OS hardware camera app.

### 2.2. Resilient Multi-Tier Product Image Pipeline
To prevent broken product packshots and evade datacenter IP blocks, `/api/scan/product-image` executes a resilient, multi-tiered discovery engine:
1. **Tier 1 — Open Beauty Facts Official Database**: Queries the open-source cosmetic registry (`world.openbeautyfacts.org`) using normalized product nomenclature to extract verified studio packaging shots (`image_front_url`).
2. **Tier 2 — Commercial Packshot Engine with Proxy Fallback**: If Tier 1 yields no assets, executes a commercial packshot query against DuckDuckGo (`i.js`) equipped with modern browser emulation headers (`Sec-Fetch-*`, Chrome 122 user-agents). If direct upstream requests face rate limits (HTTP 403), traffic automatically falls back through an unblocked endpoint proxy.
3. **`isInvalidProductMedia` Content-Type Gate**: Every candidate URL is scrutinized against a negative filter that instantly rejects historical portraits, newspaper scans, user review selfies, and non-raster formats (`.svg`, `.gif`, `.pdf`).
4. **Concurrency Deduplication & TTL Caching**: Employs an in-memory `Map` lock to eliminate thundering-herd duplicate fetches, a 1000ms sequential queue to guard IP reputation, and a 7-day MongoDB TTL cache (`CachedProduct`).

### 2.3. Multimodal Diagnostic AI Cascade
- **Stage 1 (Vision Analysis)**: Executes against high-throughput vision models (Google Gemini Vision `gemini-2.5-flash` / OpenRouter / Groq) to extract quantitative biomarker scores.
- **Stage 2 (Clinical Synthesis)**: Ingests the patient's lifestyle answers, budget constraints, and Stage 1 biomarkers to formulate a ranked comparison table containing a winning product recommendation, alternative formulations, key active concentrations, and clinical warnings.

---

## 3. Technology Stack Breakdown

| Layer | Technologies / Libraries | Purpose |
| :--- | :--- | :--- |
| **Runtime & Framework** | Node.js (v18+ LTS), Express 5.x | High-performance asynchronous REST API server |
| **Database & Caching** | MongoDB, Mongoose 9.x | Schematized persistence for profiles, scans, shelf items, and TTL asset caches |
| **Authentication** | JSON Web Tokens (`jsonwebtoken`), `bcryptjs` | Stateless session management with 7-day signed tokens and salted hashing |
| **Computer Vision** | `face-api.js` (Client-side), Google Gemini 2.5 Flash Vision | Real-time face detection, facial crop normalization, and dermal feature analysis |
| **LLM Reasoning** | Google Gemini API, Groq Cloud (`llama-3.3-70b-versatile`), OpenRouter | Dynamic multi-provider failover engine for formula parsing and clinical verdicts |
| **Frontend Architecture** | Modern Vanilla JavaScript, HTML5 WebRTC, Canvas API | High-speed SPA with zero client-side bundling overhead |
| **Styling & Design** | Tailwind CSS (CDN Plugins), Material Symbols | Glassmorphic clinical UI with light/dark theme persistence |

---

## 4. Project Directory Structure

```
cosmolyze/
├── images/                       # Static branding and clinical placeholder assets
│   └── default-clinical-bottle.png
├── middleware/                   # Express request middleware
│   └── auth.js                   # JWT bearer token verification guard
├── models/                       # Mongoose ODM schemas
│   ├── CachedProduct.js          # 7-day TTL cache for product packshot URLs
│   ├── ClinicalProfile.js        # User skin typology, budget, and sensitivity records
│   ├── DigitalShelf.js           # Bookmarked products per authenticated user
│   ├── ScanResult.js             # Diagnostic reports, AI top winner, and alternatives
│   └── User.js                   # User credentials, activity timestamps, and streaks
├── routes/                       # Modular REST API endpoints
│   ├── ai.js                     # Multimodal vision cascade, formula audits, and verdicts
│   ├── auth.js                   # User registration and authentication handlers
│   ├── scan.js                   # Scan persistence, history retrieval, and image pipeline
│   └── shelf.js                  # Digital shelf CRUD operations
├── .env                          # Local environment variable configuration (Untracked)
├── index.html                    # Single-Page Application (SPA) frontend interface
├── package.json                  # NPM dependencies and execution scripts
├── prompts.js                    # Clinical system prompts and structured JSON templates
└── server.js                     # Express application entrypoint and MongoDB connection
```

---

## 5. Getting Started & Local Setup

### 5.1. Prerequisites
- **Node.js**: `v18.0.0` or higher ([Download Node.js](https://nodejs.org/))
- **MongoDB**: Active local instance (`mongodb://localhost:27017`) or [MongoDB Atlas URI](https://www.mongodb.com/cloud/atlas)
- **API Keys**: Google Gemini API key and/or Groq API key

### 5.2. Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/RohanNimje/cosmolyze.git
   cd cosmolyze
   ```

2. **Install project dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   Create a `.env` file in the root directory (refer to [Section 6](#6-environment-variables)):
   ```bash
   cp .env.example .env   # Or create .env manually
   ```

4. **Launch the development server:**
   ```bash
   # Production run
   npm start

   # Development run with auto-reload
   npm run dev
   ```

5. **Access the application:**
   - **Frontend Interface**: `http://localhost:5000/`
   - **API Health Check**: `http://localhost:5000/api`

---

## 6. Environment Variables

Create a `.env` file in the project root. **Never commit real credentials to source control.**

```ini
# ==============================================================================
# COSMOLYZE APPLICATION ENVIRONMENT CONFIGURATION
# ==============================================================================

# Server Network Configuration
PORT=5000

# MongoDB Connection String (Local or Atlas Replica Set)
MONGODB_URI=mongodb://localhost:27017/cosmolyze

# JWT Authentication Secret Key
JWT_SECRET=your_jwt_super_secret_signing_key_here

# ------------------------------------------------------------------------------
# MULTIMODAL AI & VISION PROVIDERS
# ------------------------------------------------------------------------------

# Google Gemini API
GEMINI_API_KEY_CURRENT=your_primary_gemini_api_key_here
GEMINI_API_KEY_NEW=your_secondary_gemini_api_key_here
GEMINI_VISION_MODEL_1=gemini-2.5-flash
GEMINI_TEXT_MODEL_1=gemini-2.5-flash

# Groq Cloud API
GROQ_API_KEY=your_primary_groq_api_key_here
GROQ_API_KEY_NEW=your_secondary_groq_api_key_here
GROQ_TEXT_MODEL=llama-3.3-70b-versatile

# OpenRouter API (Fallback Provider)
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENROUTER_VISION_MODEL_1=google/gemini-2.5-flash
OPENROUTER_TEXT_MODEL_1=meta-llama/llama-3.3-70b-instruct

# Optional Providers (Future Guard)
OPENAI_API_KEY=your_openai_api_key_here
DEEPSEEK_API_KEY=your_deepseek_api_key_here
```

---

## 7. API Specification Reference

### 7.1. Authentication (`/api/auth`)
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `POST` | `/api/auth/signup` | Register new user (`name`, `email`, `password`) | No |
| `POST` | `/api/auth/login` | Authenticate user & issue signed 7-day JWT token | No |

### 7.2. Clinical Scanning & Imagery (`/api/scan`)
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `POST` | `/api/scan/save` | Persist completed scan report & update daily user streak | **Yes** |
| `GET` | `/api/scan/history` | Retrieve the last 20 diagnostic reports for user | **Yes** |
| `POST` | `/api/scan/product-image` | Multi-tier packshot search with rate-limiting & caching | No |

### 7.3. Multimodal AI Engine (`/api/ai`)
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `POST` | `/api/ai/analyze-face` | **Stage 1**: Vision biomarker extraction & dynamic questionnaire | No |
| `POST` | `/api/ai/generate-verdict` | **Stage 2**: Clinical synthesis, top winner selection & alternatives | No |
| `POST` | `/api/ai/analyze-formula` | INCI cosmetic formulation parsing & chemical safety audit | No |
| `POST` | `/api/ai/search-ingredient` | Deep pharmacological profile lookup for specific ingredients | No |

### 7.4. Digital Shelf (`/api/shelf`)
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `GET` | `/api/shelf` | Retrieve bookmarked products on user's shelf | **Yes** |
| `POST` | `/api/shelf/save` | Bookmark / update product in personal catalog | **Yes** |
| `DELETE` | `/api/shelf/:name` | Remove saved product by name | **Yes** |

---

## 8. Security & Ethical Considerations

- **Strict Credential Hygiene**: All external AI provider tokens and database secrets are ingested strictly through runtime process environment variables.
- **Client-Side Data Minimization**: Face images captured via WebRTC/HTML5 are cropped to relevant dermatological bounding boxes on local canvas contexts before base64 transmission.
- **Non-Diagnostic Disclaimer**: Cosmolyze is designed as an analytical decision-support and ingredient literacy tool. It is not a replacement for board-certified clinical dermatology consultation.

---

## 9. License

This project is licensed under the [ISC License](LICENSE).
