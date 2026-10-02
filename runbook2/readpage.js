// readpage.js <url> <outFile> [waitMs] — render one page in headless Chromium and write its visible text plus its links to a file.
// Used for Stage 2 (verify the official site), Stage 4 review (open a page to decide) and Stage 6 (code host pages). Read-only.
const fs = require('fs');
const L = require('./lib');

(async () => {
  const [url, out, waitMs] = process.argv.slice(2);
  const { browser, ctx } = await L.launch();
  const page = await ctx.newPage();
  let status = '';
  try { const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }); status = r ? r.status() : ''; } catch (e) { status = 'ERR ' + e.message.split('\n')[0]; }
  await page.waitForTimeout(+waitMs || 4000);
  const res = await page.evaluate(() => ({
    url: location.href, title: document.title,
    text: document.body ? document.body.innerText : '',
    links: [...document.querySelectorAll('a[href]')].map(a => (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) + ' -> ' + a.href),
    iframes: [...document.querySelectorAll('iframe[src]')].map(f => f.src),
  })).catch(e => ({ err: String(e) }));
  fs.writeFileSync(out, `STATUS ${status}\nURL ${res.url}\nTITLE ${res.title}\n\n${res.text}\n\n--- LINKS ---\n${(res.links || []).join('\n')}\n\n--- IFRAMES ---\n${(res.iframes || []).join('\n')}\n`);
  console.log(status, res.url, (res.text || '').length, 'chars,', (res.links || []).length, 'links');
  await browser.close();
})().catch(e => { console.error('READPAGE ERROR', e); process.exit(1); });
