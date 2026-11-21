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

    // 1. Count expect() statements to prevent assertion deletion (False Pass)
    const countExpects = (code: string) => (code.match(/\bexpect\s*\(/g) || []).length;
    const newExpectCount = countExpects(newCode);
    const originalExpectCount = originalCode ? countExpects(originalCode) : 1;

    if (newExpectCount === 0) {
        violations.push('FALSE_PASS_RISK: Code does not contain any expect() assertions.');
    } else if (originalCode && newExpectCount < originalExpectCount) {
        violations.push(
            `ASSERTION_DROPPED: Number of expect() statements decreased from ${originalExpectCount} to ${newExpectCount}.`
        );
    }

    // 2. Block meaningless tautology assertions
    const tautologyPatterns = [
        /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/,
        /expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)/,
    ];
    for (const pattern of tautologyPatterns) {
        if (pattern.test(newCode)) {
            violations.push('TAUTOLOGY_ASSERTION: Detected trivial tautology assertion to force false pass.');
        }
    }

    // 3. Block bypass cheats ({ force: true } clicking through overlays)
    if (/force\s*:\s*true/.test(newCode)) {
        violations.push('BYPASS_DETECTED: Using { force: true } bypasses UI interactivity checks.');
    }

    // 4. Check DOM Hallucination: Verify attributes ([data-test="..."], #id) against live DOM
    const hallucinatedLocators: string[] = [];
    let locatorsChecked = 0;

    if (liveDomSnapshot) {
        // Extract selectors matching [data-test="..."], [id="..."], or [name="..."]
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
                `DOM_HALLUCINATION: Locator does not exist in live DOM: ${hallucinatedLocators.join(', ')}`
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
