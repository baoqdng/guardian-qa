# GuardianQA - PowerShell Automated Setup
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "        GuardianQA - Automated One-Click Setup" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

Set-Location -Path $PSScriptRoot

# 1. Environment file check
Write-Host "`n[1/5] Checking environment configuration (.env)..." -ForegroundColor Yellow
if (-not (Test-Path "e2e-tests\.env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" "e2e-tests\.env"
        Write-Host "[INFO] Created e2e-tests\.env from .env.example." -ForegroundColor Green
        Write-Host "[WARN] Please update e2e-tests\.env with your real GEMINI_API_KEY!" -ForegroundColor Magenta
    }
} else {
    Write-Host "[OK] e2e-tests\.env found." -ForegroundColor Green
}

# 2. Node.js dependencies
Write-Host "`n[2/5] Installing Node.js dependencies in e2e-tests..." -ForegroundColor Yellow
Push-Location "e2e-tests"
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] npm install failed. Please ensure Node.js is installed." -ForegroundColor Red
    Pop-Location
    exit $LASTEXITCODE
}

# 3. Playwright browser install
Write-Host "`n[3/5] Installing Playwright Chromium browser binary..." -ForegroundColor Yellow
npx playwright install chromium
Pop-Location

# 4. Python setup
Write-Host "`n[4/5] Checking Python & installing Python requirements..." -ForegroundColor Yellow
if (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Host "[INFO] Python detected. Installing requirements.txt..." -ForegroundColor Green
    python -m pip install -r requirements.txt
    python -m playwright install chromium
} else {
    Write-Host "[INFO] Python not found in PATH. Skipping Python backend setup." -ForegroundColor Gray
}

# 5. Docker check
Write-Host "`n[5/5] Checking Docker readiness..." -ForegroundColor Yellow
if (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host "[OK] Docker is installed and available." -ForegroundColor Green
} else {
    Write-Host "[INFO] Docker not detected. Local environment will be used." -ForegroundColor Gray
}

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host "            GuardianQA Setup Completed!" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "You can now run:"
Write-Host "  - Run E2E Test:        npm test" -ForegroundColor White
Write-Host "  - Run Self-Healer:     npm run heal" -ForegroundColor White
Write-Host "  - Run Eval Benchmark:  npm run eval" -ForegroundColor White
Write-Host "  - Docker (zero-setup): docker compose up --build" -ForegroundColor White
Write-Host "========================================================" -ForegroundColor Cyan
