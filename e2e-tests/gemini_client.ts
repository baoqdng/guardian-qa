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

// Prioritize gemini-3.5-flash and gemini-3.5-flash-lite (stable quotas), fallback to gemini-3.8-flash
export const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];

/**
 * Calls Gemini API with automatic Retry (Exponential Backoff),
 * Fallback to backup models on 503/429/Timeout,
 * and immediate model transition when Daily Quota is exceeded.
 */
export async function callGeminiWithRetry(
    ai: GoogleGenAI,
    contents: string,
    schema?: Schema,
    options: CallGeminiOptions = {}
) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'YOUR_KEY' || apiKey.trim() === '') {
        console.error('\n[ERROR] [API KEY ERROR]: Valid GEMINI_API_KEY was not provided (current value: ' + (apiKey ? `"${apiKey}"` : 'undefined') + ').');
        console.error('[GUIDE] How to run container with API Key:');
        console.error('   - Option 1 (Recommended): docker run --rm --env-file .env guardian-qa:latest');
        console.error('   - Option 2: docker run --rm -e GEMINI_API_KEY="AIzaSy..." guardian-qa:latest\n');
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
                console.log(`[AI] [${modelName}] Sending request (attempt ${attempt}/${maxRetries})...`);

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

                // If API Key is invalid (400 API_KEY_INVALID), stop immediately (do not fallback pointlessly)
                const isApiKeyInvalid =
                    status === 400 &&
                    (errMsg.includes('API key not valid') ||
                     errMsg.includes('API_KEY_INVALID') ||
                     errMsg.includes('INVALID_ARGUMENT'));

                if (isApiKeyInvalid) {
                    console.error(
                        `\n[ERROR] [AUTH ERROR]: Google API rejected API Key (API_KEY_INVALID).`
                    );
                    console.error(`[GUIDE] How to run container with correct API Key:`);
                    console.error(`   - Option 1 (Recommended): docker run --rm --env-file .env guardian-qa:latest`);
                    console.error(`   - Option 2: docker run --rm -e GEMINI_API_KEY="AIzaSy..." guardian-qa:latest\n`);
                    throw err;
                }

                // If daily free-tier quota is exceeded, switch model immediately without retrying
                const isDailyQuotaExhausted =
                    errMsg.includes('per day limit exceeded') ||
                    errMsg.includes('free_tier_requests') ||
                    errMsg.includes('RESOURCE_EXHAUSTED') ||
                    (status === 429 && errMsg.includes('Quota exceeded'));

                if (isDailyQuotaExhausted) {
                    console.warn(
                        `[WARN] [${modelName}] daily free-tier quota exceeded. Immediately falling back to next model...`
                    );
                    break;
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
                            `[RETRY] [${modelName}] encountered transient issue (${err.name === 'AbortError' ? 'Timeout' : status ? `HTTP ${status}` : 'overloaded'}). Waiting ${waitSec}s before retrying (${attempt}/${maxRetries})...`
                        );
                        await new Promise((resolve) => setTimeout(resolve, delay));
                        delay = Math.round(delay * backoffFactor);
                    } else {
                        console.warn(`[WARN] [${modelName}] failed after ${maxRetries} attempts.`);
                    }
                } else {
                    console.error(`[ERROR] [${modelName}] encountered unretryable error:`, errMsg);
                    break;
                }
            }
        }

        if (mIdx < models.length - 1) {
            console.log(`[FALLBACK] Automatically switching to next backup model: [${models[mIdx + 1]}]...`);
        }
    }

    throw lastError || new Error('All Gemini models in fallback list failed to respond.');
}
