import { mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { log } from "../log.js";

const MARKETPLACE_URL = "https://www.facebook.com/marketplace/";

export class NotLoggedInError extends Error {
  constructor() {
    super(
      "Not logged in to Facebook (or hit a checkpoint). Run `famabot login` and complete the login in the browser window.",
    );
    this.name = "NotLoggedInError";
  }
}

export async function launchContext(
  profileDir: string,
  headless: boolean,
): Promise<BrowserContext> {
  mkdirSync(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1366, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

/** True when the page looks like a logged-in Facebook session. */
async function looksLoggedIn(page: Page): Promise<boolean> {
  if (page.url().includes("/checkpoint")) return false;
  const loginForm = await page.$('input[name="email"]');
  if (loginForm) return false;
  // A logged-in marketplace page has the left-hand category rail / search box.
  const marker = await page.$(
    'a[href*="/marketplace/"], [aria-label="Marketplace sidebar"], input[aria-label*="Marketplace"]',
  );
  return marker !== null;
}

/** Navigate to Marketplace and throw NotLoggedInError if the session is dead. */
export async function ensureLoggedIn(page: Page): Promise<void> {
  await page.goto(MARKETPLACE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const ok = await looksLoggedIn(page);
  log.debug(`login check: ${ok ? "ok" : "NOT logged in"} (url ${page.url()})`);
  if (!ok) throw new NotLoggedInError();
}

/**
 * Open a headed browser on facebook.com and wait (up to `timeoutMs`) for the
 * user to finish logging in. Session is persisted in the profile dir.
 */
export async function interactiveLogin(
  profileDir: string,
  timeoutMs = 5 * 60_000,
): Promise<void> {
  const ctx = await launchContext(profileDir, false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://www.facebook.com/", {
    waitUntil: "domcontentloaded",
  });
  console.log("Log in to Facebook in the browser window. Waiting…");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    try {
      if (await looksLoggedIn(page)) {
        console.log("Logged in. Session saved.");
        await ctx.close();
        return;
      }
    } catch {
      /* page may be mid-navigation; retry */
    }
  }
  await ctx.close();
  throw new Error("Timed out waiting for login.");
}
