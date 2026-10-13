// Browser end-to-end checks with Playwright (Chromium). Starts the mock ground station itself.
//   node tests/e2e.mjs            (needs the `playwright` package: local, or global via `npm i -g playwright`)
// Demo runs at ×6 speed. Each check prints PASS/FAIL; the exit code is the number of failures.
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(execSync('npm root -g').toString().trim() + '/playwright')); }

const PORT = 19000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}/`;
const server = spawn(process.execPath, [new URL('../server/gcs-mock.mjs', import.meta.url).pathname, '--port', String(PORT), '--auto-approve', '--operator-token', 'e2e-operator-token-000000'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => server.stdout.on('data', d => /ground station/.test(d) && r()));

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const browser = await chromium.launch();
const newPage = async (opts = {}, init = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ...opts });
  await ctx.addInitScript(o => { for (const [k, v] of Object.entries(o)) localStorage.setItem('navi.' + k, JSON.stringify(v)); }, { demoSpeed: 6, ...init });
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(BASE); await page.waitForSelector('.sheet h1');
  return { ctx, page };
};
const state = page => page.evaluate(() => ({ screen: document.getElementById('app').dataset.screen, status: document.querySelector('.status-card b')?.textContent || '', h: document.querySelector('.sheet h1,.sheet h2')?.textContent || '', banners: [...document.querySelectorAll('.banner b')].map(b => b.textContent), pill: document.getElementById('mode-pill').textContent }));
const waitFor = async (page, pred, ms = 120000) => { const t = Date.now(); for (;;) { const s = await state(page); if (pred(s)) return s; if (Date.now() - t > ms) throw new Error('timeout; last ' + JSON.stringify(s)); await page.waitForTimeout(250); } };
const toPreview = async (page, from, to) => {
  await page.click('text=Choose a place'); await page.fill('#place-q', from); await page.click('.pick >> nth=0'); await page.click('text=Confirm starting point');
  await page.fill('#dest-q', to); await page.click('.pick >> nth=0'); await page.waitForSelector('.sheet-foot .btn');
};
const demoToggle = async (page, sel) => { await page.click('#btn-demo'); await page.click(sel); await page.click('.dialog [data-act=close]'); };

try {
  /* 1. demo journey */
  {
    const { ctx, page } = await newPage();
    check('demo label is persistent', /Demo · no aircraft connected/i.test((await state(page)).pill));
    await toPreview(page, 'gate pad', 'gazebo');
    const txt = await page.textContent('.sheet');
    check('preview shows transfer, guided leg and estimate', /Walk to South Pad/.test(txt) && /guides you to the entrance/.test(txt) && /0\.8 m\/s/.test(txt));
    await page.click('#request');
    await page.waitForSelector('[data-act=share]', { timeout: 20000 });
    check('sharing is not active before consent', /Not shared/i.test(await page.textContent('.sheet')));
    await page.click('[data-act=share]'); await page.click('[data-act=share-yes]');
    await page.waitForFunction(() => /Sharing active/i.test(document.querySelector('.sheet')?.innerText || '') || document.getElementById('app').dataset.screen === 'guidance', null, { timeout: 15000 });
    check('sharing becomes active after an acknowledged sample', true);
    await waitFor(page, s => /Leading/.test(s.status));
    check('guidance shows confirmed leading status', true);
    const s = await waitFor(page, s => s.screen === 'arrival');
    check('arrival says "Demo journey complete"', /Demo journey complete/.test(s.h));
    await page.click('[data-act=finish]');
    check('finish returns to the start', (await state(page)).screen === 'welcome');
    check('no page errors (journey)', !page.errors.length, page.errors.join('; '));
    await ctx.close();
  }

  /* 2. controls and faults */
  {
    const { ctx, page } = await newPage();
    await toPreview(page, 'east pad', 'sedaxis'); await page.click('#request');
    await page.waitForSelector('[data-act=share]', { timeout: 20000 }); await page.click('[data-act=share]'); await page.click('[data-act=share-yes]');
    await waitFor(page, s => /Leading/.test(s.status));
    await page.click('[data-act=cmd][data-cmd=pause]');
    check('"Wait for me" shows "Pause requested" before confirmation', /Pause requested/.test((await state(page)).status));
    await waitFor(page, s => /^Paused/.test(s.status), 20000);
    check('pause confirmed by the ground station', true);
    await page.click('[data-act=cmd][data-cmd=resume]'); await waitFor(page, s => /Leading/.test(s.status), 30000);
    await demoToggle(page, '[data-act=demo-visitor][data-k=dropout]');
    const st = await waitFor(page, s => s.banners.some(b => /No position from your phone/.test(b)), 30000);
    check('stale position alert after 30 s and server hold', /No visitor position/.test(await page.textContent('.status-card small')), JSON.stringify(st.banners));
    await demoToggle(page, '[data-act=demo-visitor][data-k=dropout]'); await waitFor(page, s => /Leading/.test(s.status), 40000);
    await demoToggle(page, '[data-act=demo-link]');
    await page.click('[data-act=estop]'); await page.waitForTimeout(4600);
    check('unconfirmed emergency stop shows the exact warning', (await page.textContent('#banners')).includes('Could not confirm the request.Stay clear of the aircraft and contact the operator.'));
    check('no false "returning" while unconfirmed', !/Returning/.test((await state(page)).status));
    await demoToggle(page, '[data-act=demo-link]'); await page.waitForTimeout(1500);
    await page.click('#banners [data-act=estop]');
    await waitFor(page, s => /Returning|Ending/.test(s.status), 15000);
    check('emergency stop confirmed path shows returning', true);
    const end = await waitFor(page, s => s.screen === 'ended', 120000);
    check('guidance ended after landing', /Guidance ended/.test(end.h));
    check('no page errors (faults)', !page.errors.length, page.errors.join('; '));
    await ctx.close();
  }

  /* 3. stop sharing mid-trip */
  {
    const { ctx, page } = await newPage();
    await toPreview(page, 'south pad', 'gazebo'); await page.click('#request');
    await page.waitForSelector('[data-act=share]', { timeout: 20000 }); await page.click('[data-act=share]'); await page.click('[data-act=share-yes]');
    await waitFor(page, s => /Leading/.test(s.status));
    await page.click('#details summary'); await page.click('[data-act=stop-share]'); await page.click('[data-act=stop-share-yes]');
    const s = await waitFor(page, s => s.banners.includes('Location sharing is off'), 5000);
    check('stopping sharing is explicit and explains the consequence', !!s);
    await waitFor(page, s => /Returning|Waiting/.test(s.status), 60000);
    check('ground station holds / returns without positions', true);
    await ctx.close();
  }

  /* 4. live mode against the mock server, with the browser's geolocation */
  {
    const { ctx, page } = await newPage({ permissions: ['geolocation'], geolocation: { latitude: 12.840475, longitude: 80.154658, accuracy: 8 } }, { mode: 'live' });
    const s = await state(page);
    check('live mode labels the simulated aircraft', /Live · simulated aircraft/i.test(s.pill), s.pill);
    await toPreview(page, 'south pad', 'gazebo');
    check('route validated by the ground station', /Validated by the ground station/.test(await page.textContent('.sheet')));
    await page.click('#request'); await page.waitForSelector('[data-act=share]', { timeout: 20000 });
    await page.click('[data-act=share]'); await page.click('[data-act=share-yes]');
    await waitFor(page, s => s.screen === 'guidance', 20000);
    await page.waitForFunction(() => /active/.test(document.querySelector('[data-k=share]')?.textContent || ''), null, { timeout: 15000 });
    check('live sharing active only after server acknowledgement', true);
    check('no page errors (live)', !page.errors.length, page.errors.join('; '));
    await ctx.close();
  }

  /* 5. disconnected live mode never falls back to simulation */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/api/**', r => r.fulfill({ status: 404, body: '{}' }));
    await ctx.addInitScript(() => localStorage.setItem('navi.mode', '"live"'));
    const page = await ctx.newPage(); await page.goto(BASE); await page.waitForSelector('.sheet h1');
    const s = await state(page);
    check('disconnected live mode is labelled, not simulated', /Not connected/i.test(s.pill) && s.banners.some(b => /No NAVI ground station/.test(b)), s.pill);
    await toPreview(page, 'gate pad', 'gazebo');
    const txt = await page.textContent('.sheet');
    check('offline estimate is labelled and guide is disabled', /Offline estimate/.test(txt) && /Guide unavailable/.test(txt));
    await ctx.close();
  }

  /* 6. offline shell */
  {
    const { ctx, page } = await newPage();
    await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await page.waitForSelector('.sheet h1');
    await ctx.setOffline(true); await page.reload(); await page.waitForSelector('.sheet h1', { timeout: 10000 });
    check('app shell and campus data load offline', /Where are you starting/.test(await page.textContent('.sheet h1')));
    const posts = await page.evaluate(async () => { try { await fetch('/api/visitor-sessions', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }); return 'sent'; } catch { return 'failed'; } });
    check('control requests are not served or queued offline', posts === 'failed');
    await ctx.close();
  }

  /* 7. hostile query parameters */
  {
    const { ctx, page } = await newPage();
    await page.goto(BASE + '?pad=<img src=x onerror=alert(1)>&gcs=https://evil.example'); await page.waitForSelector('.sheet h1');
    check('unknown QR pad ids are ignored', !(await page.$('[data-act=use-qr]')));
    await page.goto(BASE + '?pad=east'); await page.waitForSelector('.sheet h1');
    check('a known pad QR suggests the pad without marking presence', /Starting at East Pad/.test(await page.textContent('.sheet')));
    await ctx.close();
  }
} catch (e) { check('unexpected error', false, e.message); }

await browser.close(); server.kill();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures);
