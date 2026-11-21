import { GoogleGenAI, Type, Schema } from '@google/genai';
import { chromium } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// 1. DEFINE STRUCTURED OUTPUTS SCHEMA
interface TestStep {
    action: 'goto' | 'fill' | 'click' | 'assert_visible' | 'assert_text';
    selector?: string;
    value?: string;
    reason: string;
}

interface TestPlan {
    test_name: string;
    is_feasible: boolean;
    steps: TestStep[];
}

const testPlanSchema: Schema = {
    type: Type.OBJECT,
    properties: {
        test_name: { type: Type.STRING, description: 'Short test name in English' },
        is_feasible: {
            type: Type.BOOLEAN,
            description: 'Return false if requested feature does NOT exist in the web DOM',
        },
        steps: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    action: {
                        type: Type.STRING,
                        enum: ['goto', 'fill', 'click', 'assert_visible', 'assert_text'],
                    },
                    selector: { type: Type.STRING, description: 'Precise Playwright selector' },
                    value: { type: Type.STRING, description: 'URL, text input, or expected assertion text' },
                    reason: { type: Type.STRING, description: 'Reason for selecting this step and selector' },
                },
                required: ['action', 'reason'],
            },
        },
    },
    required: ['test_name', 'is_feasible', 'steps'],
};

// 2. DOM EXTRACTOR: Scrape live DOM with Playwright
async function getCleanDom(url: string): Promise<string> {
    console.log(`[SCAN] Scanning DOM from: ${url} ...`);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });

    const elements = await page.evaluate(() => {
        const tags = ['input', 'button', 'a', 'select', 'h1', 'h2', 'span', 'div'];
        const results: any[] = [];
        document.querySelectorAll(tags.join(',')).forEach((el) => {
            const dataTest = el.getAttribute('data-test');
            const id = el.id;
            const name = el.getAttribute('name');
            const placeholder = el.getAttribute('placeholder');
            const text = (el as HTMLElement).innerText
                ? (el as HTMLElement).innerText.trim().slice(0, 40)
                : '';
            if (dataTest || id || name || placeholder || (el.tagName === 'BUTTON' && text)) {
                results.push({
                    tag: el.tagName.toLowerCase(),
                    id: id || null,
                    data_test: dataTest || null,
                    name: name || null,
                    placeholder: placeholder || null,
                    text: text || null,
                });
            }
        });
        return results;
    });

    await browser.close();
    return JSON.stringify(elements, null, 2);
}

// API caller with automatic Retry + Fallback models on 503/429
async function generateWithFallback(ai: GoogleGenAI, prompt: string, systemInstruction: string) {
    const models = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];

    for (const modelName of models) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                return await ai.models.generateContent({
                    model: modelName,
                    contents: prompt,
                    config: {
                        systemInstruction,
                        responseMimeType: 'application/json',
                        responseSchema: testPlanSchema,
                        temperature: 0.1,
                    },
                });
            } catch (err: any) {
                if (err.status === 503 || err.status === 429) {
                    console.log(`[RETRY] [${modelName}] overloaded (${err.status}). Waiting ${attempt * 2}s before attempt ${attempt}/3...`);
                    await new Promise((res) => setTimeout(res, attempt * 2000));
                } else {
                    throw err;
                }
            }
        }
        console.log(`[FALLBACK] Switching to next fallback model...`);
    }
    throw new Error('All models are currently overloaded. Please try again later.');
}

// 3. AI PLANNER: Generate TestPlan via Gemini Structured Outputs
async function generateTestPlan(url: string, userPrompt: string): Promise<TestPlan> {
    const domContext = await getCleanDom(url);
    const ai = new GoogleGenAI();

    const systemInstruction = `You are a Senior SDET & AI Quality Engineer.
Task: Read the live DOM elements of the website and generate an executable Playwright test plan.
MANDATORY RULES:
1. Only use REAL selectors present in the DOM (prioritize [data-test="..."] or #id).
2. If the user-requested feature does not exist on the page, set is_feasible = false.
3. For Single Page Applications (like SauceDemo), clicking Login transitions to the products page ([data-test="title"] contains "Products"). Add an assertion step at the end.`;

    console.log('[AI] AI is reasoning and designing the test scenario...');
    const prompt = `Target URL: ${url}\nUser Requirement: ${userPrompt}\n\nReal DOM Elements:\n${domContext}`;

    const response = await generateWithFallback(ai, prompt, systemInstruction);
    return JSON.parse(response.text!) as TestPlan;
}

// 4. COMPILER: Export to .spec.ts TypeScript file
function compileToTypeScript(plan: TestPlan, outputPath: string) {
    const esc = (s?: string) => (s ? s.replace(/'/g, "\\'") : '');

    const lines: string[] = [
        "import { test, expect } from '@playwright/test';",
        '',
        `test('${esc(plan.test_name)}', async ({ page }) => {`,
    ];

    for (const step of plan.steps) {
        lines.push(`  // ${step.reason}`);
        if (step.action === 'goto') {
            lines.push(`  await page.goto('${esc(step.value)}');`);
        } else if (step.action === 'fill') {
            lines.push(`  await page.locator('${esc(step.selector)}').fill('${esc(step.value)}');`);
        } else if (step.action === 'click') {
            lines.push(`  await page.locator('${esc(step.selector)}').click();`);
        } else if (step.action === 'assert_visible') {
            lines.push(`  await expect(page.locator('${esc(step.selector)}')).toBeVisible();`);
        } else if (step.action === 'assert_text') {
            lines.push(`  await expect(page.locator('${esc(step.selector)}')).toContainText('${esc(step.value)}');`);
        }
    }

    lines.push('});', '');
    fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
    console.log(`[SAVED] Exported TypeScript test file to: ${outputPath}`);
}

// 5. MAIN EXECUTION
async function main() {
    const TARGET_URL = 'https://www.saucedemo.com/';
    const REQUIREMENT =
        'Log in with standard_user, password secret_sauce, then verify navigation to the products page.';

    const plan = await generateTestPlan(TARGET_URL, REQUIREMENT);

    if (!plan.is_feasible) {
        console.log('[WARN] Warning: AI detected requirement is not feasible on this web page!');
        return;
    }

    const tsFile = path.join(__dirname, 'tests', 'ai_generated.spec.ts');
    compileToTypeScript(plan, tsFile);

    console.log('[RUN] Launching Playwright to execute the generated test...');
    try {
        const output = execSync('npx playwright test tests/ai_generated.spec.ts', {
            encoding: 'utf-8',
        });
        console.log(output);
    } catch (err: any) {
        console.error('[FAIL] Test failed:\n', err.stdout || err.message);
    }
}

main();
