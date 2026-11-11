import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export async function renderOnServer(origin: string, method: string, arg: unknown): Promise<any> {
  const executablePath = process.env.EXAM_STORE === "local" && process.env.EXAM_CHROMIUM_PATH
    ? process.env.EXAM_CHROMIUM_PATH : await chromium.executablePath();
  const browser = await puppeteer.launch({ executablePath, args: chromium.args, headless: true });
  try {
    const page = await browser.newPage();
    // 배포 보호용 자격은 이 배포에만 전달한다. 원본 저장소 등 외부 요청에는 보내지 않는다.
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) {
      await page.setRequestInterception(true);
      page.on("request", request => {
        const headers = { ...request.headers() };
        delete headers["x-vercel-protection-bypass"];
        if (new URL(request.url()).origin === new URL(origin).origin) headers["x-vercel-protection-bypass"] = bypass;
        void request.continue({ headers });
      });
    }
    page.setDefaultTimeout(180_000);
    await page.goto(`${origin}/internal-render`, { waitUntil: "networkidle0", timeout: 90_000 });
    await page.waitForFunction(() => typeof (window as any).examRenderer === "function");
    return await page.evaluate(async ({ method, arg }) => (window as any).examRenderer(method, arg), { method, arg });
  } finally {
    await browser.close();
  }
}
