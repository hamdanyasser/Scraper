// crawl.js <KEY> [--resume] [--exclude regex] [--fetch-timeout] [--upgrade-http] [--no-retry] — Runbook 2 Stage 3 steps 1–3: S2 crawl in "Tab B", crawlHealth, one slow retryFailed pass.
// Needs <state>/<KEY>/run.json = window.RUN {key,city,state,county,site,date,maxPages,maxMinutes,crawlNews,etlHtml}.
// Checkpoints window.CR to cr.json every 2 minutes, so a crash never loses the crawl; --resume continues from cr.json.
const path = require('path');
const fs = require('fs');
const L = require('./lib');

(async () => {
  const key = process.argv[2];
  const resume = process.argv.includes('--resume');
  const dir = L.stateDir(key);
  const RUN = L.readJSON(path.join(dir, 'run.json'));
  if (!RUN) throw new Error('missing run.json in ' + dir);
  const { browser, ctx } = await L.launch();
  const page = await L.openSite(ctx, RUN);
  if (process.argv.includes('--fetch-timeout')) {
    // S2's fetches (crawl and retryFailed) have no timeout; abort any in-page fetch after 60 s so one dead server cannot hang the run.
    await page.evaluate(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), 60000);
      return orig(u, Object.assign({}, o || {}, { signal: c.signal })).finally(() => clearTimeout(t)); }; });
  }
  await L.inject(page, 'S2');
  if (resume && fs.existsSync(path.join(dir, 'cr.json'))) {
    // S2 has just created a fresh CR and is still reading sitemaps; swap the checkpoint in before its workers start.
    const prev = L.readJSON(path.join(dir, 'cr.json'));
    const elapsed = (prev.lastSave || Date.now()) - prev.started;
    await L.loadCR(page, dir);
    await page.evaluate(el => { CR.running = true; CR.finished = false; CR.active = 0; CR.started = Date.now() - el; }, elapsed);
    L.log('resumed from checkpoint', await page.evaluate(() => crawlStatus()));
  }
  // --exclude <regex>: drop matching URLs from CR.queue at every poll (a CMS crawl trap S2's skip list misses, e.g. Granicus
  // /i-want-to/advanced-components/ demo templates). Does not touch S2's code; the count is kept in CR.excluded for the comment.
  const exIdx = process.argv.indexOf('--exclude');
  const exclude = exIdx > 0 ? process.argv[exIdx + 1] : null;
  // --upgrade-http: the site links its own pages as http://, which the https page's in-page fetch blocks as mixed content
  // (status 0 "network" failures, e.g. Charleston WV Building Commission / Planning). Rewrite same-host http:// URLs in CR.queue
  // to https:// at every poll; with --resume, also move those failed http:// pages back to the queue as https://.
  const upgrade = process.argv.includes('--upgrade-http');
  const doUpgrade = () => page.evaluate(fromFailed => {
    const hosts = new Set(CR.hosts || [CR.host]); const isOwn = u => { try { const x = new URL(u); return x.protocol === 'http:' && hosts.has(x.host); } catch (e) { return false; } };
    const inQ = new Set(CR.queue); let n = 0;
    const add = u => { const h = 'https://' + u.slice(7); if (CR.pages[h] || inQ.has(h)) return; inQ.add(h); CR.seen.add(h); CR.queue.push(h); n++; };
    CR.queue = CR.queue.filter(u => { if (!isOwn(u)) return true; add(u); return false; });
    if (fromFailed) for (const u of Object.keys(CR.failed)) if (isOwn(u) && CR.failed[u].status === 0) { delete CR.failed[u]; add(u); }
    CR.upgradedHttp = (CR.upgradedHttp || 0) + n; return n;
  }, fromFailed);
  let fromFailed = resume;
  const purge = async () => {
    if (upgrade) { const n = await doUpgrade(); fromFailed = false; if (n) L.log('upgraded http:// to https://', n); }
    if (!exclude) return;
    const n = await page.evaluate(re => { const r = new RegExp(re, 'i'); const b = CR.queue.length; CR.queue = CR.queue.filter(u => !r.test(u)); CR.excluded = (CR.excluded || 0) + b - CR.queue.length; CR.excludeRe = re; return b - CR.queue.length; }, exclude);
    if (n) L.log('excluded from queue', n);
  };
  await purge();
  let lastSave = 0;
  const save = async () => { await page.evaluate(() => { CR.lastSave = Date.now(); }); await L.saveCR(page, dir); lastSave = Date.now(); };
  for (;;) {
    await page.waitForTimeout(exclude || upgrade ? 5000 : 30000);
    await purge();
    if ((exclude || upgrade) && (Date.now() - (save.lastLog || 0) < 30000)) continue;
    save.lastLog = Date.now();
    const s = JSON.parse(await page.evaluate(() => crawlStatus()));
    L.log('crawlStatus', JSON.stringify(s));
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(s));
    if (s.finished) break;
    if (Date.now() - lastSave > 120000) await save();
    // Watchdog: S2's fetches have no timeout, so a server that never answers can hang all workers. If nothing moved for
    // 5 minutes, checkpoint and exit 3; run under `until node crawl.js KEY --resume ...; [ $? -ne 3 ] && break; done`.
    if (s.done !== save.lastDone) { save.lastDone = s.done; save.lastMove = Date.now(); }
    else if (Date.now() - (save.lastMove || Date.now()) > 300000 && s.queue > 0) {
      await save(); L.log('stalled for 5 min with', s.queue, 'queued; exiting 3 to resume'); await browser.close(); process.exit(3);
    }
  }
  await save();
  let health = JSON.parse(await page.evaluate(() => crawlHealth()));
  L.log('crawlHealth', JSON.stringify(health));
  const out = { first: health, retry: null };
  // --no-retry: skip the slow pass on a resumed crawl whose one slow retry has already run (the runbook allows one pass only).
  if (health.verdict !== 'ok' && health.verdict !== 'blocked' && !process.argv.includes('--no-retry')) {
    // partial / heavy / challenge: the one slow second pass (2 lanes, 1.5 s pause), unattended.
    const r = await page.evaluate(() => retryFailed(2, 1500));
    L.log('retryFailed', r);
    out.retry = r;
    health = JSON.parse(await page.evaluate(() => crawlHealth()));
    await save();
  }
  out.final = health;
  out.minutes = await page.evaluate(() => Math.round((Date.now() - CR.started) / 60000));
  out.skippedNews = await page.evaluate(() => CR.skippedNews);
  out.excluded = await page.evaluate(() => ({ n: CR.excluded || 0, re: CR.excludeRe || '' }));
  L.writeJSON(path.join(dir, 'health.json'), out);
  await L.dumpTo(page, path.join(dir, 'dump_failed.txt'), 'dumpFailed()');
  L.log('crawl done', JSON.stringify(out));
  await browser.close();
})().catch(e => { console.error('CRAWL ERROR', e); process.exit(1); });
