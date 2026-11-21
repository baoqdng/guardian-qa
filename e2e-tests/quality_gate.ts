export interface GateResult {
    passed: boolean;
    violations: string[];
    metrics: {
        originalExpectCount: number;
        newExpectCount: number;
        locatorsChecked: number;
        hallucinatedLocators: string[];
    };
}

export function evaluateQualityGate(params: {
    newCode: string;
    originalCode?: string;
    liveDomSnapshot?: string;
}): GateResult {
    const { newCode, originalCode, liveDomSnapshot } = params;
    const violations: string[] = [];

    // 1. Đếm số lượng câu lệnh expect() để chặn xóa assertion (False Pass)
    const countExpects = (code: string) => (code.match(/\bexpect\s*\(/g) || []).length;
    const newExpectCount = countExpects(newCode);
    const originalExpectCount = originalCode ? countExpects(originalCode) : 1;

    if (newExpectCount === 0) {
        violations.push('FALSE_PASS_RISK: Code không chứa bất kỳ câu lệnh expect() nào.');
    } else if (originalCode && newExpectCount < originalExpectCount) {
        violations.push(
            `ASSERTION_DROPPED: Số lượng expect() giảm từ ${originalExpectCount} xuống ${newExpectCount}.`
        );
    }

    // 2. Chặn Assertion vô nghĩa (Tautology)
    const tautologyPatterns = [
        /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/,
        /expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)/,
    ];
    for (const pattern of tautologyPatterns) {
        if (pattern.test(newCode)) {
            violations.push('TAUTOLOGY_ASSERTION: Phát hiện expect(true).toBe(true) nhằm ép test pass giả.');
        }
    }

    // 3. Chặn hành vi gian lận của Playwright (force: true để click xuyên element bị che)
    if (/force\s*:\s*true/.test(newCode)) {
        violations.push('BYPASS_DETECTED: Sử dụng { force: true } bỏ qua kiểm tra khả năng tương tác UI.');
    }

    // 4. Kiểm tra Hallucination: Đối chiếu attribute locator ([data-test="..."], #id) với DOM thật
    const hallucinatedLocators: string[] = [];
    let locatorsChecked = 0;

    if (liveDomSnapshot) {
        // Trích xuất các selector dạng [data-test="..."] hoặc [id="..."]
        const attrRegex = /\[(data-test|id|name)=["']([^"']+)["']\]/g;
        let match: RegExpExecArray | null;

        while ((match = attrRegex.exec(newCode)) !== null) {
            locatorsChecked++;
            const attrName = match[1];
            const attrVal = match[2];
            const expectedInDom = `${attrName}="${attrVal}"`;

            if (!liveDomSnapshot.includes(expectedInDom)) {
                hallucinatedLocators.push(`[${expectedInDom}]`);
            }
        }

        if (hallucinatedLocators.length > 0) {
            violations.push(
                `DOM_HALLUCINATION: Locator không tồn tại trên DOM thật: ${hallucinatedLocators.join(', ')}`
            );
        }
    }

    return {
        passed: violations.length === 0,
        violations,
        metrics: {
            originalExpectCount,
            newExpectCount,
            locatorsChecked,
            hallucinatedLocators,
        },
    };
}