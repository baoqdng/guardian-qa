import { execSync } from 'child_process';
import * as fs from 'fs';
import { chromium } from 'playwright';
import { GoogleGenAI, Type, Schema } from '@google/genai';
import * as dotenv from 'dotenv';
import { callGeminiWithRetry } from './gemini_client';
import { evaluateQualityGate } from './quality_gate';

dotenv.config();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Define Structured Output Schema requiring explicit healing patch
const healSchema: Schema = {
    type: Type.OBJECT,
    properties: {
        diagnosis: {
            type: Type.STRING,
            description: 'Root cause of why the locator failed.',
        },
        broken_locator: {
            type: Type.STRING,
            description: 'Broken locator string in the existing code.',
        },
        healed_locator: {
            type: Type.STRING,
            description: 'New locator matching the live DOM (prioritize data-test, id, role).',
        },
        fixed_code: {
            type: Type.STRING,
            description: 'Full content of the corrected .spec.ts file.',
        },
    },
    required: ['diagnosis', 'broken_locator', 'healed_locator', 'fixed_code'],
};

// 2. Execute Playwright test and extract JSON report
function runPlaywrightTest(specFile: string): { passed: boolean; errorLog: string } {
    try {
        // Lower timeout to 5000ms during healing to avoid waiting 30s default
        execSync(`npx playwright test ${specFile} --reporter=json --timeout=5000`, {
            encoding: 'utf-8',
            stdio: 'pipe',
        });
        return { passed: true, errorLog: '' };
    } catch (err: any) {
        // Playwright exits with code != 0 on failure; stdout contains JSON report
        const rawOutput = err.stdout || err.message;
        try {
            const report = JSON.parse(rawOutput);
            const errorMsg = report.suites?.[0]?.specs?.[0]?.tests?.[0]?.results?.[0]?.error?.message || rawOutput;
            return { passed: false, errorLog: errorMsg };
        } catch {
            return { passed: false, errorLog: rawOutput };
        }
    }
}

// 3. Extract interactive DOM elements (only interactive tags to save tokens & prevent noise)
async function getInteractiveDOM(url: string): Promise<string> {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });

    const domSnapshot = await page.evaluate(() => {
        const elements = document.querySelectorAll('input, button, a, select, textarea, [data-test], [role]');
        return Array.from(elements)
            .map((el) => el.outerHTML.replace(/>\s+</g, '><').trim())
            .join('\n');
    });

    await browser.close();
    return domSnapshot;
}

// 4. Main Self-Healing Loop
async function selfHealLoop(specFile: string, targetUrl: string, maxRetries = 2) {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        console.log(`\n[RUN] [Attempt ${attempt}] Testing: ${specFile}...`);
        const result = runPlaywrightTest(specFile);

        if (result.passed) {
            console.log(`[PASS] TEST PASSED on attempt ${attempt}!`);
            process.exit(0);
        }

        if (attempt > maxRetries) {
            console.error(`[FAIL] Maximum healing retries reached (${maxRetries}), test still failing.`);
            process.exit(1);
        }

        console.warn(`[WARN] Locator error detected:\n${result.errorLog.split('\n')[0]}`);
        console.log(`[SCAN] Scanning live DOM at ${targetUrl}...`);

        const currentCode = fs.readFileSync(specFile, 'utf-8');
        const freshDom = await getInteractiveDOM(targetUrl);

        const prompt = `
You are a Self-Healing Test Automation Specialist (Playwright TypeScript).
The test failed due to UI Drift. Analyze the failure log, inspect the live DOM, and fix the broken locator in the code.

MANDATORY RULES:
1. Only fix the broken locator. PRESERVE all original test logic and expect() assertions.
2. Never delete assertions to force a false pass.

--- CURRENT CODE (${specFile}) ---
${currentCode}

--- PLAYWRIGHT FAILURE LOG ---
${result.errorLog}

--- CURRENT LIVE DOM ---
${freshDom}
`;

        const { response, modelUsed } = await callGeminiWithRetry(ai, prompt, healSchema);

        const rawText = response.text || '';
        const cleanJson = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        const patch = JSON.parse(cleanJson);

        console.log(`\n[DIAGNOSIS - ${modelUsed}]: ${patch.diagnosis}`);
        console.log(`   - Broken : ${patch.broken_locator}`);
        console.log(`   + Healed : ${patch.healed_locator}`);

        // Save log diff for reporting and verification
        const diffLog = `[${new Date().toISOString()}] Model: ${modelUsed} | File: ${specFile}\nDiagnosis: ${patch.diagnosis}\n- ${patch.broken_locator}\n+ ${patch.healed_locator}\n-------------------\n`;
        fs.appendFileSync('healing_history.log', diffLog);

        // Quality Gate check on generated patch
        const gateCheck = evaluateQualityGate({
            newCode: patch.fixed_code,
            originalCode: currentCode,
            liveDomSnapshot: freshDom,
        });

        if (!gateCheck.passed) {
            console.error(`[BLOCKED] [AI QUALITY GATE BLOCKED] Patch rejected due to quality gate violation:`);
            gateCheck.violations.forEach((v) => console.error(`   - ${v}`));
            process.exit(1);
        }
        console.log(`[PASSED] [AI QUALITY GATE PASSED] Verified ${gateCheck.metrics.newExpectCount} assertions & ${gateCheck.metrics.locatorsChecked} locators matching DOM.`);

        // Overwrite test file with healed code
        fs.writeFileSync(specFile, patch.fixed_code, 'utf-8');
        console.log(`[SAVED] Updated test patch in ${specFile}. Rerunning test...`);
    }
}

// Execute self-healing
selfHealLoop('tests/broken_login.spec.ts', 'https://www.saucedemo.com/')
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[ERROR] Unhandled error:', err);
        process.exit(1);
    });
