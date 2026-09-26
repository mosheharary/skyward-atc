// Drive the real Google Chrome: node shot.mjs <url> <out.png> [waitMs] [js-to-eval-after-load]
import puppeteer from 'puppeteer-core';
const [url, out = 'shot.png', wait = '4000', js] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: process.env.HEADFUL ? false : 'new',
  args: ['--window-size=1600,900', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('console', (m) => { if (['error', 'warn'].includes(m.type()) || process.env.LOGALL) console.log(`[${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await new Promise((r) => setTimeout(r, +wait));
if (js) {
  const res = await page.evaluate(js);
  console.log('[eval]', typeof res === 'string' ? res : JSON.stringify(res));
  await new Promise((r) => setTimeout(r, +(process.env.AFTER ?? 1500)));
}
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
