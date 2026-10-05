// renderlinks.js <KEY> [--lanes 4] [--wait 2500] [--discover] [--seed file] — supplement for sites whose pages are rendered by
// JavaScript (CivicPlus HCMS "Official Website | Official Website" sites, OCV/myocv single-page apps, etc.): S2 reads raw HTML, so it
// sees only the navigation (or nothing) and records 0 documents.
// Run after crawl.js: renders every page in cr.json in headless Chromium, refreshes the page's title/headings/text, and adds the
// document links it finds to CR.files in S2's row shape {text, ctx, heading, src, pageTitle} — including documents served from a
// CMS asset host (content.civicplus.com/api/assets/..., cdn.myocv.com/.../files/...). Then run classify.js as usual (add the op
// ["recheckNode","*status0"], since cross-host links fail the in-page check). Read-only on the site; `lanes` pages at a time.
// --discover: also follow same-host links found in the rendered pages (S2's skip and news rules, RUN.maxPages cap), adding new
//   pages to CR.pages and external links to CR.ext — for an app shell whose raw HTML has no links at all.
// --seed <file>: extra start URLs, one per line (e.g. the routes listed in an OCV app's int_webManifest.json); implies --discover.
const path = require('path');
const fs = require('fs');
const L = require('./lib');

const DOC = /\.(pdf|docx?|xlsx?|pptx?|zip|dwg|dxf|kmz|csv|rtf|txt)(\?|#|$)/i;
const ASSET = /(content\.civicplus\.com\/api\/assets\/|\/DocumentCenter\/View\/|\/files\/assets\/|\/Archive\.aspx\?ADID=|\/AgendaCenter\/ViewFile\/)/i;
// S2's rules (snippets/S2.js), so a discovered crawl skips what S2 would skip.
const SKIP = /\/(wp-json|feed|wp-login|wp-admin|xmlrpc|login|logout|cart|checkout|account|my-account)(\/|$|\?)|\/(calendar|events?|event-list|photo-?gallery|galleries|album|albums|staff-directory|directory\.aspx|jobs?|employment|careers)(\/|$|\?)|[?&](ical|outlook-ical|tribe|eventDisplay|replytocom|share|sort|order|dir|print|month|day|week|lang)=|\/tag\/|\/author\/|\/page\/\d+|\.(jpg|jpeg|png|gif|svg|webp|ico|bmp|tiff?|mp4|mp3|wav|avi|mov|css|js|json|xml|rss|woff2?|ttf|eot)(\?|#|$)/i;
const NEWS = /\/(news|newsroom|news-?releases?|press|blog|announcements?|newsDigestList)(\/|$|\?)/i;

(async () => {
  const key = process.argv[2];
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? +process.argv[i + 1] : d; };
  const lanes = arg('--lanes', 4), wait = arg('--wait', 2500);
  const seedIdx = process.argv.indexOf('--seed');
  const discover = process.argv.includes('--discover') || seedIdx > 0;
  const dir = L.stateDir(key);
  const CR = L.readJSON(path.join(dir, 'cr.json'));
  const RUN = L.readJSON(path.join(dir, 'run.json')) || {};
  const hosts = new Set(CR.hosts || [CR.host]);
  const urls = Object.keys(CR.pages);
  const queued = new Set(urls);
  if (seedIdx > 0) for (const u of fs.readFileSync(process.argv[seedIdx + 1], 'utf8').split(/\s+/).filter(Boolean)) if (!queued.has(u)) { queued.add(u); urls.push(u); }
  const maxPages = RUN.maxPages || 20000;
  const { browser, ctx } = await L.launch();
  let i = 0, done = 0, added = 0, refreshed = 0, newPages = 0, skippedNews = 0;
  async function lane() {
    const page = await ctx.newPage();
    for (;;) {
      if (i >= urls.length) { if (discover && running > 0) { await page.waitForTimeout(1000); continue; } break; }
      const u = urls[i++]; running++;
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
          const docs = [], links = [];
          for (const a of document.querySelectorAll('a[href]')) {
            const h = a.href; if (!/^https?:/i.test(h)) continue;
            const c = a.closest('li,td,p,tr,dd,dt,figcaption,div');
            const row = [h.split('#')[0], clean(a.textContent || a.title || a.getAttribute('aria-label')).slice(0, 200), clean(c ? c.textContent : '').slice(0, 240), prevHeading(a)];
            (DOC.test(h) || ASSET.test(h) ? docs : links).push(row);
          }
          const iframes = [...document.querySelectorAll('iframe[src]')].map(f => f.src).filter(s => /^https?:/i.test(s));
          return { url: location.href.split('#')[0], title, doctitle: clean(document.title), heads, text: clean(main.textContent).slice(0, 3000), docs, links, iframes };
        }, [DOC.source, ASSET.source]);
        let p = CR.pages[u];
        if (!p) { p = CR.pages[u] = { title: r.title, doctitle: r.doctitle, crumb: '', heads: r.heads, text: r.text, iframes: r.iframes, nDocs: 0, nMaps: 0 }; newPages++; delete (CR.failed || {})[u]; }
        else if (r.text.length > (p.text || '').length) { Object.assign(p, { title: r.title || p.title, doctitle: r.doctitle || p.doctitle, heads: r.heads, text: r.text }); refreshed++; }
        if (r.iframes.length) p.iframes = [...new Set([...(p.iframes || []), ...r.iframes])];
        p.nDocs = Math.max(p.nDocs || 0, r.docs.length);
        for (const [h, text, ctxt, heading] of r.docs) {
          if (!CR.files[h]) { CR.files[h] = { text: '', ctx: '', heading: '', src: [], pageTitle: '' }; added++; }
          const f = CR.files[h];
          if (text && !f.text) f.text = text; if (!f.ctx) f.ctx = ctxt; if (!f.heading) f.heading = heading; if (!f.pageTitle) f.pageTitle = p.title || r.title;
          if (f.src.length < 5 && !f.src.includes(u)) f.src.push(u);
        }
        if (discover) for (const [h, text, ctxt, heading] of r.links) {
          let host; try { host = new URL(h).host; } catch (e) { continue; }
          if (hosts.has(host)) {
            if (queued.has(h) || SKIP.test(h)) continue;
            if (NEWS.test(h) && !RUN.crawlNews) { queued.add(h); skippedNews++; continue; }
            if (queued.size < maxPages) { queued.add(h); urls.push(h); }
          } else {
            if (!CR.ext[h]) CR.ext[h] = { text, ctx: ctxt, heading, src: [], pageTitle: p.title || r.title, host };
            const e = CR.ext[h]; if (e.src.length < 5 && !e.src.includes(u)) e.src.push(u);
          }
        }
      } catch (e) { /* page that will not render: keep S2's record */ }
      running--;
      if (++done % 50 === 0) L.log('rendered', done, 'of', urls.length, '| files added', added, '| new pages', newPages);
    }
    await page.close();
  }
  let running = 0;
  await Promise.all([...Array(lanes)].map(lane));
  CR.rendered = { pages: done, filesAdded: added, pagesRefreshed: refreshed, pagesDiscovered: newPages, discover };
  if (discover) CR.skippedNews = (CR.skippedNews || 0) + skippedNews;
  L.writeJSON(path.join(dir, 'cr.json'), CR);
  L.log('renderlinks done', JSON.stringify(CR.rendered), '| pages now', Object.keys(CR.pages).length, '| files now', Object.keys(CR.files).length);
  await browser.close();
})().catch(e => { console.error('RENDER ERROR', e); process.exit(1); });
