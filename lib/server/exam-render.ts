import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export async function renderOnServer(origin: string, method: string, arg: unknown): Promise<any> {
  const executablePath = process.env.EXAM_STORE === "local" && process.env.EXAM_CHROMIUM_PATH
    ? process.env.EXAM_CHROMIUM_PATH : await chromium.executablePath();
  const browser = await puppeteer.launch({ executablePath, args: chromium.args, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(180_000);
    await page.goto(`${origin}/internal-render`, { waitUntil: "networkidle0", timeout: 90_000 });
    await page.waitForFunction(() => typeof (window as any).examRenderer === "function");
    return await page.evaluate(async ({ method, arg }) => (window as any).examRenderer(method, arg), { method, arg });
  } finally {
    await browser.close();
  }
}
