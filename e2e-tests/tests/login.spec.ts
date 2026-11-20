import { test, expect } from '@playwright/test';

test('Verify successful login on SauceDemo', async ({ page }) => {
  // 1. Mở trang web mục tiêu
  await page.goto('https://www.saucedemo.com/');

  // 2. Nhập username và password (dùng locator chuẩn của Playwright)
  await page.locator('[data-test="username"]').fill('standard_user');
  await page.locator('[data-test="password"]').fill('secret_sauce');

  // 3. Bấm nút Login
  await page.locator('[data-test="login-button"]').click();

  // 4. Assertion: Kiểm tra URL chuyển sang trang inventory và chữ "Products" hiển thị
  await expect(page).toHaveURL(/.*inventory\.html/);
  await expect(page.locator('[data-test="title"]')).toHaveText('Products');
});