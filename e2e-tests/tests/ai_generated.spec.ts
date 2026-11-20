import { test, expect } from '@playwright/test';

test('Login with standard user and verify products page', async ({ page }) => {
  // Navigate to the login page
  await page.goto('https://www.saucedemo.com/');
  // Enter standard_user in username field
  await page.locator('[data-test="username"]').fill('standard_user');
  // Enter secret_sauce in password field
  await page.locator('[data-test="password"]').fill('secret_sauce');
  // Click login button to submit credentials
  await page.locator('[data-test="login-button"]').click();
  // Verify successful login by checking Products title on inventory page
  await expect(page.locator('[data-test="title"]')).toContainText('Products');
});
