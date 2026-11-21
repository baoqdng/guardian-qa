# 🛡️ GuardianQA — Autonomous Playwright Agent with Hallucination Gate

An AI-powered End-to-End (E2E) test automation framework built in **TypeScript**, **Playwright**, and **Gemini Structured Outputs**. Designed to eliminate flaky locators via closed-loop **Self-Healing** while preventing LLM **False Passes** and **DOM Hallucinations** through a deterministic **2-Layer AI Quality Gate**.

## 🏗️ System Architecture
1. **DOM-Grounded Test Generator (`agent.ts`):** Extracts interactive DOM nodes and compiles validated JSON test plans into executable `.spec.ts` files.
2. **Closed-Loop Self-Healer (`healer.ts`):** Captures Playwright JSON failure traces, re-snapshots live DOM, generates minimal locator patches with diff logging (`healing_history.log`), and re-executes.
3. **2-Layer AI Quality Gate (`quality_gate.ts`):**
   - **Layer 1 (Static/AST Guardrail):** Blocks assertion deletion (`expect()` count drop), tautologies (`expect(true).toBe(true)`), and `{ force: true }` bypasses.
   - **Layer 2 (DOM Grounding & Feasibility):** Verifies every generated selector against live DOM attributes and rejects unfeasible test prompts (`is_feasible: false`).

## 📊 Benchmark Results (`eval_suite.ts`)
Evaluated across **15 adversarial & functional scenarios** (5 Happy Path, 5 False-Pass Attacks, 5 Adversarial Hallucinations):

| Metric | Result |
| :--- | :--- |
| **Overall Gate Accuracy** | **100.0% (15/15)** |
| **False-Pass Block Rate** | **100.0% (5/5)** |
| **DOM Hallucination Block Rate** | **100.0% (5/5)** |
| **Mean Self-Healing Latency** | **~3.2s per broken locator** |

## 🚀 Quick Start
\`\`\`bash
cd e2e-tests
npm install
npx tsx eval_suite.ts
\`\`\`