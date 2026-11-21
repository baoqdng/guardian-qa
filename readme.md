# GuardianQA — Autonomous Playwright Agent with Hallucination Gate

An AI-powered End-to-End (E2E) test automation framework built in **TypeScript**, **Playwright**, and **Gemini Structured Outputs**. Designed to eliminate flaky locators via closed-loop **Self-Healing** while preventing LLM **False Passes** and **DOM Hallucinations** through a deterministic **2-Layer AI Quality Gate**.

## System Architecture
1. **DOM-Grounded Test Generator (`agent.ts`):** Extracts interactive DOM nodes and compiles validated JSON test plans into executable `.spec.ts` files.
2. **Closed-Loop Self-Healer (`healer.ts`):** Captures Playwright JSON failure traces, re-snapshots live DOM, generates minimal locator patches with diff logging (`healing_history.log`), and re-executes.
3. **2-Layer AI Quality Gate (`quality_gate.ts`):**
   - **Layer 1 (Static/AST Guardrail):** Blocks assertion deletion (`expect()` count drop), tautologies (`expect(true).toBe(true)`), and `{ force: true }` bypasses.
   - **Layer 2 (DOM Grounding & Feasibility):** Verifies every generated selector against live DOM attributes and rejects unfeasible test prompts (`is_feasible: false`).

## Benchmark Results (`eval_suite.ts`)
Evaluated across **15 adversarial & functional scenarios** (5 Happy Path, 5 False-Pass Attacks, 5 Adversarial Hallucinations):

| Metric | Result |
| :--- | :--- |
| **Overall Gate Accuracy** | **100.0% (15/15)** |
| **False-Pass Block Rate** | **100.0% (5/5)** |
| **DOM Hallucination Block Rate** | **100.0% (5/5)** |
| **Mean Self-Healing Latency** | **~3.2s per broken locator** |

## Quick Start

### 1. Local Development
```bash
cd e2e-tests

# Install dependencies and Playwright browser
npm install
npx playwright install chromium

# Setup environment variable
# Create a .env file with your GEMINI_API_KEY
echo "GEMINI_API_KEY=your_gemini_api_key_here" > .env

# Run baseline Playwright test
npm run test:login

# Run Self-Healing on a broken test
npm run heal

# Run 15-Scenario AI Quality Gate Benchmark
npm run eval
```

### 2. Run with Docker
```bash
# Build Docker image from repo root
docker build -t guardian-qa:latest .

# Run container with environment file
docker run --rm --env-file e2e-tests/.env guardian-qa:latest

# Or run with inline API Key
docker run --rm -e GEMINI_API_KEY="AIzaSy..." guardian-qa:latest
```

## GitHub Actions CI/CD Pipeline

The repository includes a ready-to-run GitHub Actions workflow at [`.github/workflows/guardian-ci.yml`](.github/workflows/guardian-ci.yml).

### Required Setup on GitHub:
1. Go to your GitHub repository: **Settings** -> **Secrets and variables** -> **Actions**.
2. Click **New repository secret**.
3. Name: `GEMINI_API_KEY`
4. Value: `<your-gemini-api-key>`
5. Push to `main` branch or trigger manually via **Actions** -> **Run workflow**.

### Pipeline Stages:
- **Stage 1 (Baseline E2E):** Validates baseline login flow (`tests/login.spec.ts`).
- **Stage 2 (Self-Healing Loop):** Intentionally executes a broken test (`tests/broken_login.spec.ts`), captures failure trace, scrapes live DOM, synthesizes patch with Gemini, and re-runs to pass (`healer.ts`).
- **Stage 3 (AI Quality Gate Benchmark):** Evaluates 15 adversarial and functional test cases (`eval_suite.ts`).
- **Artifacts:** Automatically uploads `eval_report.json`, `healing_history.log`, and Playwright test reports.
