import { test, expect } from '@playwright/test';

test('Login with broken selector', async ({ page }) => {
    await page.goto('https://www.saucedemo.com/');
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    // Intentionally use a broken selector to trigger Self-Healing
    await page.locator('[data-test="btn-submit-v2"]').click();
    await expect(page).toHaveURL(/inventory\.html/);
});
