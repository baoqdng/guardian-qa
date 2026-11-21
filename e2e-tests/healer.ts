import { execSync } from 'child_process';
import * as fs from 'fs';
import { chromium } from 'playwright';
import { GoogleGenAI, Type, Schema } from '@google/genai';
import * as dotenv from 'dotenv';
import { callGeminiWithRetry } from './gemini_client';
import { evaluateQualityGate } from './quality_gate';

dotenv.config();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Định nghĩa Schema bắt buộc AI trả về bản vá rõ ràng (tránh viết lan man)
const healSchema: Schema = {
    type: Type.OBJECT,
    properties: {
        diagnosis: {
            type: Type.STRING,
            description: 'Nguyên nhân gốc rễ khiến locator cũ bị lỗi.',
        },
        broken_locator: {
            type: Type.STRING,
            description: 'Đoạn locator cũ bị lỗi trong code.',
        },
        healed_locator: {
            type: Type.STRING,
            description: 'Đoạn locator mới khớp với DOM hiện tại (ưu tiên data-test, id, role).',
        },
        fixed_code: {
            type: Type.STRING,
            description: 'Toàn bộ nội dung file .spec.ts đã được sửa hoàn chỉnh.',
        },
    },
    required: ['diagnosis', 'broken_locator', 'healed_locator', 'fixed_code'],
};

// 2. Hàm chạy Playwright và lấy kết quả JSON
function runPlaywrightTest(specFile: string): { passed: boolean; errorLog: string } {
    try {
        // Giảm timeout xuống 5000ms khi heal để không phải chờ 30s mặc định
        execSync(`npx playwright test ${specFile} --reporter=json --timeout=5000`, {
            encoding: 'utf-8',
            stdio: 'pipe',
        });
        return { passed: true, errorLog: '' };
    } catch (err: any) {
        // Playwright trả về exit code != 0 khi fail, stdout vẫn chứa JSON report
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

// 3. Hàm cào DOM sạch (chỉ lấy thẻ tương tác để tiết kiệm token & chống nhiễu)
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

// 4. Vòng lặp Self-Healing chính
async function selfHealLoop(specFile: string, targetUrl: string, maxRetries = 2) {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        console.log(`\n🚀 [Lần chạy ${attempt}] Đang kiểm thử: ${specFile}...`);
        const result = runPlaywrightTest(specFile);

        if (result.passed) {
            console.log(`✅ TEST PASSED ở lần chạy thứ ${attempt}!`);
            process.exit(0);
        }

        if (attempt > maxRetries) {
            console.error(`❌ Đã đạt giới hạn ${maxRetries} lần tự chữa lành nhưng vẫn thất bại.`);
            process.exit(1);
        }

        console.warn(`⚠️ Phát hiện lỗi Locator:\n${result.errorLog.split('\n')[0]}`);
        console.log(`🔍 Đang quét lại DOM thực tế tại ${targetUrl}...`);

        const currentCode = fs.readFileSync(specFile, 'utf-8');
        const freshDom = await getInteractiveDOM(targetUrl);

        const prompt = `
Bạn là chuyên gia Self-Healing Test Automation (Playwright TypeScript).
Bài test bị lỗi do giao diện thay đổi (UI Drift). Hãy phân tích log lỗi, đối chiếu với DOM thực tế và sửa lại locator trong code.

QUY TẮC BẮT BUỘC:
1. Chỉ sửa locator bị hỏng, GIỮ NGUYÊN toàn bộ logic kiểm thử và các câu lệnh expect() gốc.
2. Không tự ý xóa assertion để ép test pass giả (False Pass).

--- CODE HIỆN TẠI (${specFile}) ---
${currentCode}

--- LOG LỖI PLAYWRIGHT ---
${result.errorLog}

--- DOM THỰC TẾ HIỆN TẠI ---
${freshDom}
`;

        const { response, modelUsed } = await callGeminiWithRetry(ai, prompt, healSchema);

        const rawText = response.text || '';
        const cleanJson = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        const patch = JSON.parse(cleanJson);

        console.log(`\n🩺 [CHẨN ĐOÁN AI - ${modelUsed}]: ${patch.diagnosis}`);
        console.log(`   - Cũ : ${patch.broken_locator}`);
        console.log(`   + Mới: ${patch.healed_locator}`);

        // Lưu file log diff để làm bằng chứng cho báo cáo / demo
        const diffLog = `[${new Date().toISOString()}] Model: ${modelUsed} | File: ${specFile}\nDiagnosis: ${patch.diagnosis}\n- ${patch.broken_locator}\n+ ${patch.healed_locator}\n-------------------\n`;
        fs.appendFileSync('healing_history.log', diffLog);

        // ... bên trong selfHealLoop sau khi nhận `patch` từ Gemini:
        const gateCheck = evaluateQualityGate({
            newCode: patch.fixed_code,
            originalCode: currentCode,
            liveDomSnapshot: freshDom,
        });

        if (!gateCheck.passed) {
            console.error(`🛑 [AI QUALITY GATE BLOCKED] Bản vá bị từ chối vì vi phạm quy tắc chất lượng:`);
            gateCheck.violations.forEach((v) => console.error(`   - ${v}`));
            process.exit(1);
        }
        console.log(`🛡️ [AI QUALITY GATE PASSED] Đã xác thực ${gateCheck.metrics.newExpectCount} assertions & ${gateCheck.metrics.locatorsChecked} locators khớp DOM.`);
        // Ghi đè code đã vá vào file test
        fs.writeFileSync(specFile, patch.fixed_code, 'utf-8');
        console.log(`💾 Đã cập nhật bản vá vào ${specFile}. Tiến hành chạy lại...`);
    }
}

// Chạy thử nghiệm
selfHealLoop('tests/broken_login.spec.ts', 'https://www.saucedemo.com/')
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('❌ Lỗi không xác định:', err);
        process.exit(1);
    });