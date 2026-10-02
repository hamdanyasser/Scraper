// renderlinks.js <KEY> [--lanes 4] [--wait 2500] — supplement for sites whose pages are rendered by JavaScript (CivicPlus HCMS
// "Official Website | Official Website" sites, etc.): S2 reads raw HTML, so it sees only the navigation and records 0 documents.
// Run after crawl.js: renders every page in cr.json in headless Chromium, refreshes the page's title/headings/text, and adds the
// document links it finds to CR.files in S2's row shape {text, ctx, heading, src, pageTitle} — including documents served from a
// CMS asset host (content.civicplus.com/api/assets/...). Then run classify.js as usual (add the op ["recheckNode","*status0"],
// since cross-host links fail the in-page check). Read-only on the site; `lanes` pages at a time.
const path = require('path');
const L = require('./lib');

const DOC = /\.(pdf|docx?|xlsx?|pptx?|zip|dwg|dxf|kmz|csv|rtf|txt)(\?|#|$)/i;
const ASSET = /(content\.civicplus\.com\/api\/assets\/|\/DocumentCenter\/View\/|\/files\/assets\/|\/Archive\.aspx\?ADID=|\/AgendaCenter\/ViewFile\/)/i;

(async () => {
  const key = process.argv[2];
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? +process.argv[i + 1] : d; };
  const lanes = arg('--lanes', 4), wait = arg('--wait', 2500);
  const dir = L.stateDir(key);
  const CR = L.readJSON(path.join(dir, 'cr.json'));
  const urls = Object.keys(CR.pages);
  const { browser, ctx } = await L.launch();
  let i = 0, done = 0, added = 0, refreshed = 0;
  async function lane() {
    const page = await ctx.newPage();
    while (i < urls.length) {
      const u = urls[i++];
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(wait);
        const r = await page.evaluate(([docSrc, assetSrc]) => {
          const DOC = new RegExp(docSrc, 'i'), ASSET = new RegExp(assetSrc, 'i');
          const clean = s => (s || '').replace(/\s+/g, ' ').trim();
          document.querySelectorAll('script,style,noscript,svg').forEach(e => e.remove());
          const main = document.querySelector('main,article,#content,#main,.content,[role=main]') || document.body;
          const title = clean((document.querySelector('main h1,article h1,#content h1,h1') || {}).textContent || document.title);
          const heads = [...main.querySelectorAll('h2,h3')].map(h => clean(h.textContent)).filter(Boolean).slice(0, 25);
          const prevHeading = a => { let n = a; for (let k = 0; k < 400 && n; k++) { n = n.previousElementSibling || n.parentElement; if (n && /^H[1-4]$/.test(n.tagName)) return clean(n.textContent).slice(0, 160); } return ''; };
          const docs = [];
          for (const a of document.querySelectorAll('a[href]')) {
            const h = a.href; if (!/^https?:/i.test(h)) continue;
            if (!(DOC.test(h) || ASSET.test(h))) continue;
            const c = a.closest('li,td,p,tr,dd,dt,figcaption,div');
            docs.push([h.split('#')[0], clean(a.textContent || a.title || a.getAttribute('aria-label')).slice(0, 200), clean(c ? c.textContent : '').slice(0, 240), prevHeading(a)]);
          }
          return { title, doctitle: clean(document.title), heads, text: clean(main.textContent).slice(0, 3000), docs };
        }, [DOC.source, ASSET.source]);
        const p = CR.pages[u];
        if (r.text.length > (p.text || '').length) { Object.assign(p, { title: r.title || p.title, doctitle: r.doctitle || p.doctitle, heads: r.heads, text: r.text }); refreshed++; }
        p.nDocs = Math.max(p.nDocs || 0, r.docs.length);
        for (const [h, text, ctxt, heading] of r.docs) {
          if (!CR.files[h]) { CR.files[h] = { text: '', ctx: '', heading: '', src: [], pageTitle: '' }; added++; }
          const f = CR.files[h];
          if (text && !f.text) f.text = text; if (!f.ctx) f.ctx = ctxt; if (!f.heading) f.heading = heading; if (!f.pageTitle) f.pageTitle = p.title || r.title;
          if (f.src.length < 5 && !f.src.includes(u)) f.src.push(u);
        }
      } catch (e) { /* page that will not render: keep S2's record */ }
      if (++done % 50 === 0) L.log('rendered', done, 'of', urls.length, '| files added', added);
    }
    await page.close();
  }
  await Promise.all([...Array(lanes)].map(lane));
  CR.rendered = { pages: done, filesAdded: added, pagesRefreshed: refreshed };
  L.writeJSON(path.join(dir, 'cr.json'), CR);
  L.log('renderlinks done', JSON.stringify(CR.rendered), '| files now', Object.keys(CR.files).length);
  await browser.close();
})().catch(e => { console.error('RENDER ERROR', e); process.exit(1); });
