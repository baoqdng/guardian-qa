import { GoogleGenAI, Type, Schema } from '@google/genai';
import { chromium } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// 1. ĐỊNH NGHĨA STRUCTURED OUTPUTS SCHEMA
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
        test_name: { type: Type.STRING, description: 'Tên bài test ngắn gọn bằng tiếng Anh' },
        is_feasible: {
            type: Type.BOOLEAN,
            description: 'Trả về false nếu tính năng yêu cầu KHÔNG tồn tại trên DOM trang web',
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
                    selector: { type: Type.STRING, description: 'Playwright selector chính xác' },
                    value: { type: Type.STRING, description: 'URL, text nhập vào, hoặc text kỳ vọng' },
                    reason: { type: Type.STRING, description: 'Lý do chọn bước này' },
                },
                required: ['action', 'reason'],
            },
        },
    },
    required: ['test_name', 'is_feasible', 'steps'],
};

// 2. MẮT THẦN: Quét DOM thực tế bằng Playwright
async function getCleanDom(url: string): Promise<string> {
    console.log(`🔍 Đang quét DOM từ: ${url} ...`);
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

// Hàm gọi API có tự động Retry + Fallback model khi server 503 quá tải
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
                    console.log(`⏳ [${modelName}] đang quá tải (${err.status}). Đợi ${attempt * 2}s rồi thử lại lần ${attempt}/3...`);
                    await new Promise((res) => setTimeout(res, attempt * 2000));
                } else {
                    throw err;
                }
            }
        }
        console.log(`🔄 Chuyển sang model dự phòng tiếp theo...`);
    }
    throw new Error('Tất cả các model đều đang quá tải, vui lòng thử lại sau ít phút.');
}

// 3. BỘ NÃO AI: Sinh TestPlan qua Gemini Structured Outputs
async function generateTestPlan(url: string, userPrompt: string): Promise<TestPlan> {
    const domContext = await getCleanDom(url);
    const ai = new GoogleGenAI();

    const systemInstruction = `Bạn là một Senior SDET & AI Quality Engineer.
Nhiệm vụ: Đọc DOM thực tế của trang web và tạo kế hoạch kiểm thử Playwright.
QUY TẮC BẮT BUỘC:
1. Chỉ dùng selector CÓ THẬT trong DOM (ưu tiên [data-test="..."] hoặc #id).
2. Nếu tính năng người dùng yêu cầu không tồn tại trên trang web, đặt is_feasible = false.
3. Với trang SPA như SauceDemo, sau khi bấm Login trang sẽ chuyển sang màn hình sản phẩm ([data-test="title"] chứa chữ "Products"). Hãy thêm bước assert ở cuối.`;

    console.log('🧠 AI đang suy luận và thiết kế kịch bản test...');
    const prompt = `Target URL: ${url}\nUser Requirement: ${userPrompt}\n\nReal DOM Elements:\n${domContext}`;

    const response = await generateWithFallback(ai, prompt, systemInstruction);
    return JSON.parse(response.text!) as TestPlan;
}

// 4. TRÌNH BIÊN DỊCH: Xuất ra file .spec.ts
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
    console.log(`📝 Đã xuất file test TypeScript tại: ${outputPath}`);
}

// 5. CHẠY LUỒNG CHÍNH
async function main() {
    const TARGET_URL = 'https://www.saucedemo.com/';
    const REQUIREMENT =
        'Đăng nhập bằng tài khoản standard_user, mật khẩu secret_sauce, sau đó kiểm tra xem có chuyển sang trang sản phẩm không.';

    const plan = await generateTestPlan(TARGET_URL, REQUIREMENT);

    if (!plan.is_feasible) {
        console.log('⚠️ Cảnh báo: AI phát hiện yêu cầu không khả thi trên trang web này!');
        return;
    }

    const tsFile = path.join(__dirname, 'tests', 'ai_generated.spec.ts');
    compileToTypeScript(plan, tsFile);

    console.log('🚀 Đang kích hoạt Playwright để chạy bài test AI vừa viết...');
    try {
        const output = execSync('npx playwright test tests/ai_generated.spec.ts', {
            encoding: 'utf-8',
        });
        console.log(output);
    } catch (err: any) {
        console.error('❌ Test thất bại:\n', err.stdout || err.message);
    }
}

main();