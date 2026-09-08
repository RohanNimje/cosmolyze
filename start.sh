#!/bin/bash
# =============================================================================
# Cosmolyze — Production Startup Script
# Runs on Render (single web service, Ubuntu environment).
#
# Launch order:
#   1. Start the Python FastAPI image sidecar on port 8001 (background)
#   2. Wait up to 10s for the sidecar to be ready
#   3. Start the Node.js / Express API server (foreground — keeps service alive)
#
# If the Node process exits for any reason, the sidecar is also killed so
# Render detects the failure and restarts the service cleanly.
# =============================================================================
set -e

echo "=== [Startup] Cosmolyze Production Boot ==="

# ── 1. Start Python sidecar in background ────────────────────────────────────
echo "[Startup] Launching image sidecar (uvicorn) on port 8001..."
uvicorn image_service.main:app --host 0.0.0.0 --port 8001 --workers 1 &
SIDECAR_PID=$!
echo "[Startup] Sidecar PID: $SIDECAR_PID"

# ── 2. Wait for sidecar health endpoint to respond ───────────────────────────
echo "[Startup] Waiting for sidecar to be ready..."
for i in $(seq 1 10); do
  if curl -sf http://localhost:8001/health > /dev/null 2>&1; then
    echo "[Startup] Sidecar is healthy after ${i}s"
    break
  fi
  echo "[Startup] ... attempt $i/10"
  sleep 1
done

# ── 3. Start Node.js server (foreground — keeps Render process alive) ─────────
echo "[Startup] Launching Node.js server..."
node server.js
EXIT_CODE=$?

# ── Cleanup: kill sidecar when Node exits ────────────────────────────────────
echo "[Startup] Node exited (code $EXIT_CODE) — stopping sidecar..."
kill $SIDECAR_PID 2>/dev/null || true
exit $EXIT_CODE
