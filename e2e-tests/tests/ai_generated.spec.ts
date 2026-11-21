import { test, expect } from '@playwright/test';

test('Successful Login to SauceDemo and Verify Products Page Navigation', async ({ page }) => {
  // Navigate to login page
  await page.goto('https://www.saucedemo.com/');
  // Enter standard username into the username field
  await page.locator('[data-test="username"]').fill('standard_user');
  // Enter password into the password field
  await page.locator('[data-test="password"]').fill('secret_sauce');
  // Click login button to submit credentials
  await page.locator('[data-test="login-button"]').click();
  // Verify navigation to products page by asserting title text
  await expect(page.locator('[data-test="title"]')).toContainText('Products');
});
