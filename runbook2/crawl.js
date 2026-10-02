// crawl.js <KEY> [--resume] — Runbook 2 Stage 3 steps 1–3: S2 crawl in "Tab B", crawlHealth, one slow retryFailed pass.
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
  await L.inject(page, 'S2');
  if (resume && fs.existsSync(path.join(dir, 'cr.json'))) {
    // S2 has just created a fresh CR and is still reading sitemaps; swap the checkpoint in before its workers start.
    const prev = L.readJSON(path.join(dir, 'cr.json'));
    const elapsed = (prev.lastSave || Date.now()) - prev.started;
    await L.loadCR(page, dir);
    await page.evaluate(el => { CR.running = true; CR.finished = false; CR.active = 0; CR.started = Date.now() - el; }, elapsed);
    L.log('resumed from checkpoint', await page.evaluate(() => crawlStatus()));
  }
  let lastSave = 0;
  const save = async () => { await page.evaluate(() => { CR.lastSave = Date.now(); }); await L.saveCR(page, dir); lastSave = Date.now(); };
  for (;;) {
    await page.waitForTimeout(30000);
    const s = JSON.parse(await page.evaluate(() => crawlStatus()));
    L.log('crawlStatus', JSON.stringify(s));
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(s));
    if (s.finished) break;
    if (Date.now() - lastSave > 120000) await save();
  }
  await save();
  let health = JSON.parse(await page.evaluate(() => crawlHealth()));
  L.log('crawlHealth', JSON.stringify(health));
  const out = { first: health, retry: null };
  if (health.verdict !== 'ok' && health.verdict !== 'blocked') {
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
  L.writeJSON(path.join(dir, 'health.json'), out);
  await L.dumpTo(page, path.join(dir, 'dump_failed.txt'), 'dumpFailed()');
  L.log('crawl done', JSON.stringify(out));
  await browser.close();
})().catch(e => { console.error('CRAWL ERROR', e); process.exit(1); });
