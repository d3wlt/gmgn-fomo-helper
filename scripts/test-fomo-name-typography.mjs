// Isolated production name controller/CSS: no live account or network.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const root = new URL('../', import.meta.url);
const source = fs.readFileSync(process.env.FOMO_NAME_SOURCE || new URL('content.js', root), 'utf8');
const css = fs.readFileSync(new URL('styles.css', root), 'utf8');
const output = new URL('test-results/', root).pathname;
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
 await page.route('**/*', r => r.abort());
 await page.setContent('<body style="margin:0;background:#101114;color:#ddd;font:14px/21px sans-serif;font-feature-settings: &quot;tnum&quot;"><div id="cards"></div></body>');
 await page.addStyleTag({ content: css });
 // The live host's inherited family/features: Geist, 13px/600, tnum.
 // Pinned upstream Geist (not a claim of byte identity with GMGN's build).
 await page.route('https://fixture.invalid/geist.ttf', r => r.fulfill({body:fs.readFileSync(new URL('scripts/fixtures/geist/Geist-Variable.ttf',root)),contentType:'font/ttf',headers:{'access-control-allow-origin':'*'}}));
 await page.addStyleTag({content:'@font-face {font-family:Geist;src:url(https://fixture.invalid/geist.ttf)} #cards {font-family:Geist,sans-serif,"Microsoft YaHei"}'});
 await page.evaluate(() => document.fonts.load('600 13px Geist'));
 await page.addScriptTag({ content: source.slice(source.indexOf('  const fomoNameNodes'), source.indexOf('  function buildFomoFeedTableRow')) + `
 window.mountName = (full, table = true) => {
  const card = document.createElement('div'); card.className = 'gdh-fomofeed' + (table ? ' is-table' : '');
  card.innerHTML = table ? '<div class="gdh-fomofeed__trow"><span class="gdh-fomofeed__tcell gdh-fomofeed__ttime">3m</span><span class="gdh-fomofeed__tcell gdh-fomofeed__twho"><span class="gdh-fomofeed__av">F</span><span class="gdh-fomofeed__name"></span></span><span class="gdh-fomofeed__tcell">MPAIR Buy</span><span class="gdh-fomofeed__tcell">$100</span><span class="gdh-fomofeed__tcell">$112.8K</span></div>' : '<div class="gdh-fomofeed__r1"><span class="gdh-fomofeed__av">F</span><span class="gdh-fomofeed__name"></span><span>Buy</span><span class="gdh-fomofeed__time">3m</span></div><div class="gdh-fomofeed__r2">MPAIR $100</div>';
  setupFomoFeedName(card.querySelector('.gdh-fomofeed__name'), full, {title:'Profile'});
  document.querySelector('#cards').append(card);
 };` });
 const metrics = () => page.locator('.gdh-fomofeed__name').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, full: n.getAttribute('aria-label'), width: n.clientWidth, height: n.clientHeight, scrollHeight: n.scrollHeight, truncated: n.dataset.truncated, font: getComputedStyle(n).fontFamily, lineHeight: getComputedStyle(n).lineHeight })));
 await page.evaluate(() => { for (const table of [true,false]) for (const full of ['frankdegods','ReturnOfTheKing','C0brahan_full_name']) mountName(full, table); });
 await page.waitForTimeout(100);
 const host = await metrics();
 console.log('Host family at 13px:', JSON.stringify(host));
 await page.screenshot({path:output+'fomo-name-geist-'+(process.env.FOMO_NAME_SOURCE?'before':'after')+'.png'});
 assert.ok(host.every(n=>n.text===n.full), 'full ordinary usernames with host Geist typography');
 // Fractional font-ink rounding with the host's normal 13px Geist is enough:
 // at 2x CSS zoom Chromium reports scrollHeight 16 for a 14px line box.
 await page.locator('#cards').evaluate(n=>n.style.zoom='2');
 await page.waitForTimeout(100);
 console.log('Host Geist at 2x zoom:', JSON.stringify(await metrics()));
 await page.screenshot({path:output+'fomo-name-geist-zoom-'+(process.env.FOMO_NAME_SOURCE?'before':'after')+'.png'});
 assert.ok((await metrics()).every(n=>n.text===n.full),'host font at non-default zoom must never reduce ordinary names to dots');
 await page.locator('#cards').evaluate(n=>n.style.removeProperty('zoom'));
 await page.waitForTimeout(80);
 // An oversized inherited font has glyph ink beyond the fixed 14px line box.
 // This reproduces the real controller failure even with hundreds of spare pixels.
 await page.addStyleTag({ content: '#cards {font-family:Arial,sans-serif} #cards .gdh-fomofeed__name {font-size:24px}' });
 await page.waitForTimeout(100);
 const before = await metrics();
 console.log('Inherited typography:', JSON.stringify(before));
 await page.screenshot({ path: output + 'fomo-name-host-typography-'+(process.env.FOMO_NAME_SOURCE?'before':'after')+'.png' });
 assert.ok(before.every(n => n.text === n.full), 'ordinary usernames must never be replaced with dots by font ink/line-box overflow');
 // Height-only changes at constant width must not destroy or freeze the text.
 const widths = (await metrics()).map(n=>n.width);
 await page.locator('.gdh-fomofeed__name').evaluateAll(nodes => nodes.forEach(n => n.style.maxHeight = '1px'));
 await page.waitForFunction(()=>[...document.querySelectorAll('.gdh-fomofeed__name')].every(n=>n.dataset.truncated==='true'),null,{timeout:1000});
 assert.ok((await metrics()).every(n => n.text === n.full && n.truncated === 'true'), 'temporary collapsed height preserves source text and updates overflow');
 assert.deepEqual((await metrics()).map(n=>n.width), widths);
 await page.locator('.gdh-fomofeed__name').evaluateAll(nodes => nodes.forEach(n => n.style.removeProperty('max-height')));
 await page.waitForFunction(()=>[...document.querySelectorAll('.gdh-fomofeed__name')].every(n=>n.dataset.truncated==='false'),null,{timeout:1000});
 assert.ok((await metrics()).every(n => n.text === n.full && n.truncated === 'false'), 'height-only recovery updates overflow without a width change');
 assert.deepEqual((await metrics()).map(n=>n.width), widths);
 // Late typography and transformed ancestors do not require cached-width refits.
 await page.addStyleTag({ content: '#cards .gdh-fomofeed__name {font-size:13px} #cards {font-family:Georgia,serif;transform:scale(.9);transform-origin:top left}' });
 await page.waitForTimeout(80);
 assert.ok((await metrics()).every(n => n.text === n.full && n.truncated === 'false'));
 // A real delayed FontFace load, not just a synthetic loadingdone event.
 await page.route('https://fixture.invalid/delayed.ttf', async r => {await new Promise(resolve=>setTimeout(resolve,60));await r.fulfill({body:fs.readFileSync(new URL('scripts/fixtures/geist/Geist-Variable.ttf',root)),contentType:'font/ttf',headers:{'access-control-allow-origin':'*'}});});
 await page.addStyleTag({content:'@font-face {font-family:DelayedGeist;src:url(https://fixture.invalid/delayed.ttf)} #cards {font-family:DelayedGeist,sans-serif}'});
 await page.evaluate(()=>document.fonts.ready);
 await page.waitForTimeout(80);
 assert.ok(await page.evaluate(()=>document.fonts.check('600 13px DelayedGeist')));
 assert.ok((await metrics()).every(n => n.text === n.full && n.truncated === 'false'));
 assert.ok(await page.locator('.gdh-fomofeed').evaluateAll(nodes=>nodes.every(n=>Math.abs(n.getBoundingClientRect().height/.9-(n.classList.contains('is-table')?45:64.5))<.01)));
 console.log('PASS host Geist typography, transient height-only collapse/recovery, delayed FontFace load and transform; source text intact.');
} finally { await browser.close(); }
