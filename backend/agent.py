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

# 1. ĐỊNH NGHĨA STRUCTURED OUTPUTS (Ép AI trả về đúng format, không nói lan man)
class TestStep(BaseModel):
    action: Literal["goto", "fill", "click", "assert_visible", "assert_text"] = Field(
        description="Hành động cần thực hiện trên trình duyệt"
    )
    selector: Optional[str] = Field(
        default=None,
        description="Playwright selector chính xác (ưu tiên [data-test=\"...\"], #id, hoặc role=...)"
    )
    value: Optional[str] = Field(
        default=None,
        description="URL (nếu là goto), text cần nhập (nếu là fill), hoặc text kỳ vọng (nếu là assert_text)"
    )
    reason: str = Field(description="Giải thích ngắn gọn lý do chọn bước và selector này")

class TestPlan(BaseModel):
    test_name: str = Field(description="Tên bài test bằng tiếng Anh ngắn gọn")
    is_feasible: bool = Field(
        description="Trả về False nếu yêu cầu test tính năng KHÔNG tồn tại trên DOM trang web"
    )
    steps: list[TestStep] = Field(description="Danh sách tuần tự các bước kiểm thử")


# 2. MẮT THẦN: Lấy cấu trúc DOM thực tế của trang web để chống AI bịa selector
def get_clean_dom(url: str) -> str:
    print(f"🔍 Đang quét DOM từ: {url} ...")
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Exception:
            # Fallback dùng Edge có sẵn trên Windows nếu bị chính sách máy chặn tải Chromium
            browser = p.chromium.launch(headless=True, channel="msedge")
            
        page = browser.new_page()
        page.goto(url, wait_until="networkidle")
        
        # Trích xuất các thẻ tương tác quan trọng (đã sửa results.push chuẩn JS)
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


# 3. BỘ NÃO AI: Phân tích DOM + Yêu cầu -> Sinh TestPlan
def generate_test_plan(url: str, user_prompt: str) -> TestPlan:
    dom_context = get_clean_dom(url)
    client = genai.Client()

    system_instruction = (
        "Bạn là một Senior SDET & AI Quality Engineer. "
        "Nhiệm vụ của bạn là đọc danh sách các phần tử DOM thực tế của trang web và tạo kế hoạch kiểm thử Playwright. "
        "QUY TẮC BẮT BUỘC:\n"
        "1. Chỉ sử dụng các selector CÓ THẬT trong DOM được cung cấp (ưu tiên `[data-test=\"...\"]` hoặc `#id`).\n"
        "2. Không bao giờ bịa đặt selector. Nếu tính năng người dùng yêu cầu không có trên trang web, đặt `is_feasible = False`.\n"
        "3. Lưu ý quan trọng: Với các trang Single Page App (như SauceDemo), sau khi bấm nút Login trang mới chuyển sang màn hình tiếp theo. "
        "Nếu bước verify nằm ở trang sau (ví dụ `.inventory_list` hoặc `[data-test=\"title\"]`), hãy suy luận hợp lý dựa trên standard Playwright web structure."
    )

    prompt = f"""
    Target URL: {url}
    User Requirement: {user_prompt}
    
    Real DOM Elements on Initial Page:
    {dom_context}
    """

    print("🧠 AI đang suy luận và thiết kế kịch bản test...")
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


# 4. TRÌNH BIÊN DỊCH: Chuyển TestPlan (JSON) thành code Playwright TypeScript (.spec.ts)
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
    print(f"📝 Đã xuất file test TypeScript tại: {output_path}")


if __name__ == "__main__":
    TARGET_URL = "https://www.saucedemo.com/"
    REQUIREMENT = "Đăng nhập bằng tài khoản standard_user, mật khẩu secret_sauce, sau đó kiểm tra xem có chuyển sang trang sản phẩm không."

    plan = generate_test_plan(TARGET_URL, REQUIREMENT)
    
    if not plan.is_feasible:
        print("⚠️ Cảnh báo: AI phát hiện yêu cầu không khả thi trên trang web này!")
    else:
        ts_file = Path(__file__).resolve().parent.parent / "e2e-tests" / "tests" / "ai_generated.spec.ts"
        compile_to_typescript(plan, ts_file)

        print("🚀 Đang kích hoạt Playwright TypeScript để chạy bài test AI vừa viết...")
        result = subprocess.run(
            ["npx.cmd", "playwright", "test", "tests/ai_generated.spec.ts"],
            cwd=ts_file.parent.parent,
            capture_output=True,
            text=True,
            encoding="utf-8"
        )
        print(result.stdout)
        if result.returncode != 0:
            print("❌ Lỗi khi chạy test:\n", result.stderr)