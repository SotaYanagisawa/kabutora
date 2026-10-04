import { expect, test, type Page } from "./strict-fixture";
import { installSyntheticPortfolio, syntheticPortfolio } from "./reliability-fixture";

const marketFilter = (page: Page) => page.getByRole("combobox", { name: /資産区分(?:と国)?で絞り込み/u }).locator("visible=true").first();
const navButton = (page: Page, name: RegExp) => page.getByRole("button", { name }).locator("visible=true").first();

test("reopening the app restores the last main menu page and its filter selections", async ({ page }) => {
  await installSyntheticPortfolio(page, syntheticPortfolio(6, 40, 200));
  await page.goto("/");
  await expect(page.locator("main.workspace")).toBeVisible({ timeout: 20_000 });

  await marketFilter(page).selectOption("US");
  await page.getByRole("combobox", { name: "表示通貨" }).locator("visible=true").first().selectOption("USD");
  await navButton(page, /^配当金?$/u).click();
  await expect(page.locator(".view-cache.active .dividends-page")).toBeVisible();

  await page.reload();
  await expect(page.locator("main.workspace")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".view-cache.active .dividends-page")).toBeVisible();
  await expect(navButton(page, /^配当金?$/u)).toHaveClass(/active/u);

  await navButton(page, /^一覧$/u).click();
  await expect(marketFilter(page)).toHaveValue("US");
  await expect(page.getByRole("combobox", { name: "表示通貨" }).locator("visible=true").first()).toHaveValue("USD");
});
