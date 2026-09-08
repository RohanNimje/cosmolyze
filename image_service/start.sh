#!/bin/bash
# Cosmolyze Image Service — Startup Script
# Installs dependencies and starts the FastAPI sidecar on port 8001.
set -e
echo "[ImageSvc] Installing Python dependencies..."
pip install -r "$(dirname "$0")/requirements.txt" -q
echo "[ImageSvc] Starting FastAPI on port 8001..."
uvicorn image_service.main:app --host 0.0.0.0 --port 8001 --workers 1
