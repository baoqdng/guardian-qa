@echo off
setlocal enabledelayedexpansion

echo ========================================================
echo         GuardianQA - Automated One-Click Setup
echo ========================================================

cd /d "%~dp0"

echo [1/5] Checking environment configuration (.env)...
if not exist "e2e-tests\.env" (
    if exist ".env.example" (
        copy ".env.example" "e2e-tests\.env" >nul
        echo [INFO] Created e2e-tests\.env from .env.example.
        echo [WARN] Please update e2e-tests\.env with your real GEMINI_API_KEY!
    )
) else (
    echo [OK] e2e-tests\.env found.
)

echo.
echo [2/5] Installing Node.js dependencies in e2e-tests...
cd e2e-tests
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed. Please ensure Node.js is installed.
    cd /d "%~dp0"
    pause
    exit /b %errorlevel%
)

echo.
echo [3/5] Installing Playwright Chromium browser binary...
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo [WARN] Playwright browser installation encountered a warning. Continuing...
)
cd /d "%~dp0"

echo.
echo [4/5] Checking Python & installing Python requirements...
where python >nul 2>nul
if %errorlevel% equ 0 (
    echo [INFO] Python detected. Installing requirements.txt...
    python -m pip install -r requirements.txt
    python -m playwright install chromium >nul 2>nul
) else (
    echo [INFO] Python not found in PATH. Skipping Python backend setup (TypeScript suite ready).
)

echo.
echo [5/5] Checking Docker readiness...
where docker >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Docker is installed and available.
) else (
    echo [INFO] Docker not detected. Local environment will be used.
)

echo.
echo ========================================================
echo             GuardianQA Setup Completed!
echo ========================================================
echo You can now run:
echo   - Run E2E Test:        npm test
echo   - Run Self-Healer:     npm run heal
echo   - Run Eval Benchmark:  npm run eval
echo   - Docker (zero-setup): docker compose up --build
echo ========================================================
