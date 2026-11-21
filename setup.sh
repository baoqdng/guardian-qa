#!/usr/bin/env bash
set -e

echo "========================================================"
echo "        GuardianQA - Automated One-Click Setup"
echo "========================================================"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "[1/5] Checking environment configuration (.env)..."
if [ ! -f "e2e-tests/.env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example e2e-tests/.env
        echo "[INFO] Created e2e-tests/.env from .env.example."
        echo "[WARN] Please update e2e-tests/.env with your real GEMINI_API_KEY!"
    fi
else
    echo "[OK] e2e-tests/.env found."
fi

echo ""
echo "[2/5] Installing Node.js dependencies in e2e-tests..."
cd e2e-tests
npm install

echo ""
echo "[3/5] Installing Playwright Chromium browser binary..."
npx playwright install chromium --with-deps || npx playwright install chromium
cd "$SCRIPT_DIR"

echo ""
echo "[4/5] Checking Python & installing Python requirements..."
if command -v python3 &>/dev/null; then
    echo "[INFO] Python3 detected. Installing requirements.txt..."
    python3 -m pip install -r requirements.txt || true
    python3 -m playwright install chromium || true
elif command -v python &>/dev/null; then
    echo "[INFO] Python detected. Installing requirements.txt..."
    python -m pip install -r requirements.txt || true
    python -m playwright install chromium || true
else
    echo "[INFO] Python not found. Skipping Python backend setup."
fi

echo ""
echo "[5/5] Checking Docker readiness..."
if command -v docker &>/dev/null; then
    echo "[OK] Docker is installed and available."
else
    echo "[INFO] Docker not detected. Local environment will be used."
fi

echo ""
echo "========================================================"
echo "            GuardianQA Setup Completed!"
echo "========================================================"
echo "You can now run:"
echo "  - Run E2E Test:        npm test"
echo "  - Run Self-Healer:     npm run heal"
echo "  - Run Eval Benchmark:  npm run eval"
echo "  - Docker (zero-setup): docker compose up --build"
echo "========================================================"
