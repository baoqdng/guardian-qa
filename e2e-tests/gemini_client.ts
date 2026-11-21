import { GoogleGenAI, Schema } from '@google/genai';
import * as dotenv from 'dotenv';

dotenv.config();

export interface CallGeminiOptions {
    models?: string[];
    maxRetriesPerModel?: number;
    initialDelayMs?: number;
    backoffFactor?: number;
    timeoutMs?: number;
}

// Ưu tiên gemini-3.5-flash và gemini-3.5-flash-lite (hạn mức ổn định), fallback sang gemini-3.8-flash
export const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];

/**
 * Gọi API Gemini với cơ chế tự động Retry (Exponential Backoff),
 * Fallback sang model dự phòng khi gặp 503/429/Timeout,
 * và tự động chuyển model ngay lập tức nếu cạn Quota trong ngày (Daily Quota Exceeded).
 */
export async function callGeminiWithRetry(
    ai: GoogleGenAI,
    contents: string,
    schema?: Schema,
    options: CallGeminiOptions = {}
) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'YOUR_KEY' || apiKey.trim() === '') {
        console.error('\n❌ [LỖI API KEY]: Chưa truyền GEMINI_API_KEY hợp lệ (giá trị hiện tại: ' + (apiKey ? `"${apiKey}"` : 'undefined') + ').');
        console.error('💡 Hướng dẫn chạy container với API Key:');
        console.error('   👉 Cách 1 (Khuyên dùng): docker run --rm --env-file .env guardian-qa:latest');
        console.error('   👉 Cách 2: docker run --rm -e GEMINI_API_KEY="AIzaSy..." guardian-qa:latest\n');
        throw new Error('GEMINI_API_KEY is missing or invalid.');
    }

    const models = options.models || DEFAULT_MODELS;
    const maxRetries = options.maxRetriesPerModel ?? 3;
    const initialDelayMs = options.initialDelayMs ?? 2000;
    const backoffFactor = options.backoffFactor ?? 1.5;
    const timeoutMs = options.timeoutMs ?? 25000;

    let lastError: any = null;

    for (let mIdx = 0; mIdx < models.length; mIdx++) {
        const modelName = models[mIdx];
        let delay = initialDelayMs;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                controller.abort();
            }, timeoutMs);

            try {
                console.log(`🤖 [${modelName}] Đang gửi yêu cầu (lần thử ${attempt}/${maxRetries})...`);

                const config: any = {
                    temperature: 0.1,
                    abortSignal: controller.signal,
                    httpOptions: { timeout: timeoutMs },
                };
                if (schema) {
                    config.responseMimeType = 'application/json';
                    config.responseSchema = schema;
                }

                const response = await ai.models.generateContent({
                    model: modelName,
                    contents,
                    config,
                });

                clearTimeout(timeoutId);
                return { response, modelUsed: modelName };
            } catch (err: any) {
                clearTimeout(timeoutId);
                lastError = err;

                const status = err.status || err.statusCode || (err.error && err.error.code);
                const errMsg = err.message || '';

                // Nếu là lỗi API Key không hợp lệ (400 API_KEY_INVALID), dừng ngay lập tức (không fallback vô ích)
                const isApiKeyInvalid =
                    status === 400 &&
                    (errMsg.includes('API key not valid') ||
                     errMsg.includes('API_KEY_INVALID') ||
                     errMsg.includes('INVALID_ARGUMENT'));

                if (isApiKeyInvalid) {
                    console.error(
                        `\n❌ [LỖI XÁC THỰC]: Google API từ chối API Key (API_KEY_INVALID).`
                    );
                    console.error(`💡 Hướng dẫn chạy container với API Key đúng:`);
                    console.error(`   👉 Cách 1 (Khuyên dùng): docker run --rm --env-file .env guardian-qa:latest`);
                    console.error(`   👉 Cách 2: docker run --rm -e GEMINI_API_KEY="AIzaSy..." guardian-qa:latest\n`);
                    throw err;
                }

                // Nếu là lỗi hết hạn mức trong ngày (Daily Quota Exceeded trên Free Tier), chuyển model ngay lập tức
                const isDailyQuotaExhausted =
                    errMsg.includes('per day limit exceeded') ||
                    errMsg.includes('free_tier_requests') ||
                    errMsg.includes('RESOURCE_EXHAUSTED') ||
                    (status === 429 && errMsg.includes('Quota exceeded'));

                if (isDailyQuotaExhausted) {
                    console.warn(
                        `⚠️ [${modelName}] đã cạn hạn mức trong ngày (Daily Quota Exceeded). Tự động chuyển ngay sang model dự phòng...`
                    );
                    break; // Không retry model này nữa, chuyển sang fallback model kế tiếp
                }

                const isTransient =
                    status === 503 ||
                    status === 429 ||
                    status === 500 ||
                    status === 502 ||
                    status === 504 ||
                    err.name === 'AbortError' ||
                    errMsg.includes('aborted') ||
                    errMsg.includes('high demand') ||
                    errMsg.includes('UNAVAILABLE') ||
                    errMsg.includes('quota') ||
                    errMsg.includes('Timeout') ||
                    err.code === 'ECONNRESET' ||
                    err.code === 'ETIMEDOUT';

                if (isTransient) {
                    if (attempt < maxRetries) {
                        const waitSec = Math.round(delay / 1000);
                        console.warn(
                            `⏳ [${modelName}] gặp sự cố tạm thời (${err.name === 'AbortError' ? 'Timeout' : status ? `HTTP ${status}` : 'quá tải'}). Đợi ${waitSec}s rồi thử lại (${attempt}/${maxRetries})...`
                        );
                        await new Promise((resolve) => setTimeout(resolve, delay));
                        delay = Math.round(delay * backoffFactor);
                    } else {
                        console.warn(`⚠️ [${modelName}] không thành công sau ${maxRetries} lần thử.`);
                    }
                } else {
                    console.error(`❌ [${modelName}] gặp lỗi không thể retry:`, errMsg);
                    break;
                }
            }
        }

        if (mIdx < models.length - 1) {
            console.log(`🔄 Tự động chuyển sang model dự phòng tiếp theo: [${models[mIdx + 1]}]...`);
        }
    }

    throw lastError || new Error('Tất cả các model Gemini trong danh sách đều không phản hồi.');
}
