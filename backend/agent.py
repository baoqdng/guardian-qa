import os
import subprocess
from pathlib import Path
from typing import Literal, Optional
from dotenv import load_dotenv
from google import genai
from google.genai import types
from pydantic import BaseModel, Field
from playwright.sync_api import sync_playwright

load_dotenv()

# 1. DEFINE STRUCTURED OUTPUTS SCHEMA (Pydantic models)
class TestStep(BaseModel):
    action: Literal["goto", "fill", "click", "assert_visible", "assert_text"] = Field(
        description="Action to perform in the browser"
    )
    selector: Optional[str] = Field(
        default=None,
        description="Precise Playwright selector (prefer [data-test=\"...\"], #id, or role=...)"
    )
    value: Optional[str] = Field(
        default=None,
        description="URL (for goto), input text (for fill), or expected text (for assert_text)"
    )
    reason: str = Field(description="Concise reason for selecting this step and selector")

class TestPlan(BaseModel):
    test_name: str = Field(description="Short test name in English")
    is_feasible: bool = Field(
        description="Return False if requested test feature does NOT exist on the web page DOM"
    )
    steps: list[TestStep] = Field(description="Sequential list of test steps")


# 2. DOM EXTRACTOR: Scrape live DOM with Playwright
def get_clean_dom(url: str) -> str:
    print(f"[SCAN] Scanning DOM from: {url} ...")
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Exception:
            # Fallback to Edge on Windows if chromium download is blocked
            browser = p.chromium.launch(headless=True, channel="msedge")
            
        page = browser.new_page()
        page.goto(url, wait_until="networkidle")
        
        # Extract interactive elements
        elements = page.evaluate("""() => {
            const tags = ['input', 'button', 'a', 'select', 'h1', 'h2', 'span', 'div'];
            const results = [];
            document.querySelectorAll(tags.join(',')).forEach(el => {
                const dataTest = el.getAttribute('data-test');
                const id = el.id;
                const name = el.getAttribute('name');
                const placeholder = el.getAttribute('placeholder');
                const text = el.innerText ? el.innerText.trim().slice(0, 40) : '';
                if (dataTest || id || name || placeholder || (el.tagName === 'BUTTON' && text)) {
                    results.push({
                        tag: el.tagName.toLowerCase(),
                        id: id || null,
                        data_test: dataTest || null,
                        name: name || null,
                        placeholder: placeholder || null,
                        text: text || null
                    });
                }
            });
            return results;
        }""")
        browser.close()
        return str(elements)


# 3. AI PLANNER: Analyze DOM + Requirements -> Generate TestPlan
def generate_test_plan(url: str, user_prompt: str) -> TestPlan:
    dom_context = get_clean_dom(url)
    client = genai.Client()

    system_instruction = (
        "You are a Senior SDET & AI Quality Engineer. "
        "Task: Read the provided list of real DOM elements and generate an executable Playwright test plan. "
        "MANDATORY RULES:\n"
        "1. Only use REAL selectors present in the provided DOM (prioritize `[data-test=\"...\"]` or `#id`).\n"
        "2. Never invent selectors. If the requested feature does not exist on the page, set `is_feasible = False`.\n"
        "3. Important: For Single Page Apps (such as SauceDemo), clicking Login transitions to the next screen. "
        "If a verification step is on the next page (e.g. `.inventory_list` or `[data-test=\"title\"]`), reason reasonably based on standard Playwright web structures."
    )

    prompt = f"""
    Target URL: {url}
    User Requirement: {user_prompt}
    
    Real DOM Elements on Initial Page:
    {dom_context}
    """

    print("[AI] AI is reasoning and designing test plan...")
    response = client.models.generate_content(
        model="gemini-3.5-flash",
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=system_instruction,
            response_mime_type="application/json",
            response_schema=TestPlan,
            temperature=0.1,
        ),
    )
    return response.parsed


# 4. COMPILER: Convert TestPlan (JSON) into Playwright TypeScript (.spec.ts)
def compile_to_typescript(plan: TestPlan, output_path: Path):
    def esc(s: Optional[str]) -> str:
        return s.replace("'", "\\'") if s else ""

    lines = [
        "import { test, expect } from '@playwright/test';",
        "",
        f"test('{esc(plan.test_name)}', async ({{ page }}) => {{"
    ]

    for step in plan.steps:
        lines.append(f"  // {step.reason}")
        if step.action == "goto":
            lines.append(f"  await page.goto('{esc(step.value)}');")
        elif step.action == "fill":
            lines.append(f"  await page.locator('{esc(step.selector)}').fill('{esc(step.value)}');")
        elif step.action == "click":
            lines.append(f"  await page.locator('{esc(step.selector)}').click();")
        elif step.action == "assert_visible":
            lines.append(f"  await expect(page.locator('{esc(step.selector)}')).toBeVisible();")
        elif step.action == "assert_text":
            lines.append(f"  await expect(page.locator('{esc(step.selector)}')).toContainText('{esc(step.value)}');")

    lines.append("});")
    lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"[SAVED] Exported TypeScript test file to: {output_path}")


if __name__ == "__main__":
    TARGET_URL = "https://www.saucedemo.com/"
    REQUIREMENT = "Log in with standard_user, password secret_sauce, then verify navigation to the products page."

    plan = generate_test_plan(TARGET_URL, REQUIREMENT)
    
    if not plan.is_feasible:
        print("[WARN] Warning: AI detected requirement is not feasible on this web page!")
    else:
        ts_file = Path(__file__).resolve().parent.parent / "e2e-tests" / "tests" / "ai_generated.spec.ts"
        compile_to_typescript(plan, ts_file)

        print("[RUN] Executing generated Playwright TypeScript test...")
        result = subprocess.run(
            ["npx.cmd", "playwright", "test", "tests/ai_generated.spec.ts"],
            cwd=ts_file.parent.parent,
            capture_output=True,
            text=True,
            encoding="utf-8"
        )
        print(result.stdout)
        if result.returncode != 0:
            print("[FAIL] Test run failed:\n", result.stderr)
