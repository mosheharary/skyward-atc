// Scripted end-to-end run in real Chrome. Usage: node flow.mjs <baseUrl> <outDir> [scenario]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const [base = 'http://localhost:5173', outDir = '/tmp/flow', scenario = 'new'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: process.env.HEADFUL ? false : 'new',
  args: ['--window-size=1600,900', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1600, height: 900 },
  userDataDir: process.env.PROFILE_DIR || undefined,
});
const page = await browser.newPage();
page.on('console', (m) => { if (['error', 'warn'].includes(m.type()) || process.env.LOGALL) console.log(`[${m.type()}]`, m.text().slice(0, 400)); });
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.request().method(), r.url()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const shot = async (name) => {
  const p = `${outDir}/${String(++n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: p });
  console.log('shot', p);
};
const clickText = async (sel, text) => {
  const ok = await page.evaluate((sel, text) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
    if (!el) return false;
    el.click();
    return true;
  }, sel, text);
  if (!ok) console.log(`!! not found: ${sel} "${text}"`);
  return ok;
};
const ev = async (js) => {
  const r = await page.evaluate(js);
  console.log('[eval]', typeof r === 'string' ? r : JSON.stringify(r));
  return r;
};
const state = `(() => { const g = skyward.game; if (!g) return 'no game'; const w = g.world; return { t: Math.round(w.t), ac: w.aircraft.length, score: w.score, fps: g.fps, sel: g.selected, audio: skyward.audio.started, level: +skyward.audio.getLevel().toFixed(4), cam: skyward.renderer.mode, stats: w.stats }; })()`;

await page.goto(base, { waitUntil: 'load', timeout: 60000 });
await sleep(2500);

if (scenario === 'new') {
  await shot('sign-in');
  // Needs a server started with AUTH_TEST_LOGIN=1 (never available on Vercel); stands in for the Google round-trip.
  const who = process.env.NAME || 'Tester';
  const ok = await page.evaluate(async (name) => (await fetch('/api/auth/test-login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub: name.toLowerCase(), name }),
  })).ok, who);
  if (!ok) throw new Error('test-login failed: start the server with AUTH_TEST_LOGIN=1');
  await page.reload({ waitUntil: 'load' });
  await sleep(2500);
  await shot('main-menu');
  await page.click('#btn-career');
  await sleep(800);
  await shot('career');
  await page.click('#btn-start-shift');
  await sleep(6000);
  await shot('briefing');
  await page.click('#btn-begin');
  await sleep(8000);
  await shot('game-tower');
  await ev(state);
  if (process.env.JS) await ev(process.env.JS);
  if (process.env.STOP) { await browser.close(); process.exit(0); }
  // Select the first arrival that's airborne and give it a heading via the panel.
  await ev(`(() => { const w = skyward.game.world; const a = w.aircraft.find(a => !a.onGround) || w.aircraft[0]; skyward.game.select(a.id); return a.callsign + ' ' + a.phase; })()`);
  await sleep(600);
  await clickText('.cmd-btn', 'Heading');
  await sleep(400);
  await shot('heading-picker');
  await clickText('.cmd-btn', '+30');
  await clickText('.cmd-btn', 'Send heading');
  await sleep(3000);
  await shot('after-heading');
  await page.keyboard.press('2');
  await sleep(4000);
  await shot('orbit');
  await page.keyboard.press('3');
  await sleep(4000);
  await shot('follow');
  await page.keyboard.press('Tab');
  await sleep(1500);
  await shot('radar-big');
  await page.keyboard.press('Tab');
  await page.keyboard.press('1');
  await page.keyboard.press('F1');
  await sleep(800);
  await shot('help');
  await page.keyboard.press('Escape');
  await sleep(300);
  await ev(state);
  await sleep(Number(process.env.PLAY_MS || 10000));
  await ev(state);
  await shot('later');
} else if (scenario === 'ground') {
  // Assumes a profile exists (PROFILE_DIR); starts free play and runs a departure from gate to airborne.
  await page.click('#btn-free');
  await sleep(600);
  await page.click('#btn-start-free');
  await sleep(1000);
  await clickText('button', 'Start new session');
  await sleep(10000);
  await ev(state);
  const dep = await ev(`(() => { const w = skyward.game.world; const a = w.aircraft.find(a => a.onGround && w.available(a).has('pushback')); if (!a) return null; skyward.game.select(a.id); return a.id; })()`);
  if (dep) {
    await sleep(500);
    await shot('dep-selected');
    await clickText('.cmd-btn', 'Push');
    await page.keyboard.press('3');
    await page.keyboard.press('+'); await page.keyboard.press('+');
    const step = async (kind, label, extra = '') => {
      for (let i = 0; i < 90; i++) {
        const ok = await page.evaluate((id, kind) => skyward.game.world.aircraft.some(a => a.id === id && skyward.game.world.available(a).has(kind)), dep, kind);
        if (ok) break;
        await sleep(1000);
      }
      await ev(`(() => { const w = skyward.game.world; const a = w.aircraft.find(a => a.id === '${dep}'); return a ? a.callsign + ' ' + a.phase + ' avail=' + [...w.available(a)].join(',') : 'gone'; })()`);
      await clickText('.cmd-btn', label);
      await sleep(400);
      if (extra) await clickText(extra, '');
      await sleep(1500);
      await shot(kind);
    };
    await step('taxi', 'Taxi to', '.cmd-btn.suggest');
    await step('lineUp', 'Line up');
    await step('takeoff', 'take-off');
    await sleep(Number(process.env.AIR_MS || 40000));
    await ev(`(() => { const w = skyward.game.world; const a = w.aircraft.find(a => a.id === '${dep}'); return a ? a.callsign + ' ' + a.phase + ' alt=' + Math.round(a.altitude ?? a.alt) : 'gone'; })()`);
    await shot('airborne');
  }
  await ev(state);
} else if (scenario === 'continue') {
  await shot('menu');
  await page.click('#btn-continue');
  await sleep(6000);
  await shot('welcome-back');
  await ev(state);
  await page.click('#btn-resume');
  await sleep(5000);
  await ev(state);
  await shot('resumed');
} else if (scenario === 'eval') {
  await ev(process.env.JS || state);
  await shot('eval');
}
await browser.close();
