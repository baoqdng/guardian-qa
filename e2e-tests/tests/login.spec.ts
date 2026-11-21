import { test, expect } from '@playwright/test';

test('Verify successful login on SauceDemo', async ({ page }) => {
  // 1. Navigate to target URL
  await page.goto('https://www.saucedemo.com/');

  // 2. Enter username and password using standard Playwright locators
  await page.locator('[data-test="username"]').fill('standard_user');
  await page.locator('[data-test="password"]').fill('secret_sauce');

  // 3. Click Login button
  await page.locator('[data-test="login-button"]').click();

  // 4. Assertion: Verify URL redirects to inventory page and "Products" title is visible
  await expect(page).toHaveURL(/.*inventory\.html/);
  await expect(page.locator('[data-test="title"]')).toHaveText('Products');
});
