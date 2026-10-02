// classify.js <KEY> [--ops ops.json] [--nonaec] [--no-maps]
// Runbook 2 Stage 3 steps 5–7, Stage 4 dumps and Stage 5 maps, in "Tab B" (the city homepage, so checkLinks stays same-origin).
// First run: restore CR → S3, S4, S5, S6 → buildCandidates → checkLinks(aec || Review) → buildCandidates → (--nonaec: first 400 non-AEC)
//            → S7, S8 → AG.fromCrawl → save LINKS, CAND, AG → write the review dumps.
// With --ops: restore CR, LINKS, DEC, MDEC, AG → buildCandidates → apply the operations in ops.json → save → rewrite the dumps.
// ops.json is a list of [op, ...args]; only these ops exist (no arbitrary code):
//   ["setDec", [[id, up, reason, cat, scope, hint], ...]]   ["setMap", [[mid, type, up, reason], ...]]
//   ["checkLinks", [url, ...]]  ["setOrg", host]  ["orgSearch", orgId]  ["resolveItem", id]  ["addService", url]  ["server", url]
const path = require('path');
const fs = require('fs');
const L = require('./lib');

(async () => {
  const key = process.argv[2];
  const opsIdx = process.argv.indexOf('--ops');
  const opsFile = opsIdx > 0 ? process.argv[opsIdx + 1] : null;
  const dir = L.stateDir(key);
  const RUN = L.readJSON(path.join(dir, 'run.json'));
  const { browser, ctx } = await L.launch();
  const page = await L.openSite(ctx, RUN);
  L.log('restored pages', await L.loadCR(page, dir));
  await L.loadVar(page, dir, 'LINKS', {});
  await L.loadVar(page, dir, 'DEC', {});
  await L.loadVar(page, dir, 'MDEC', {});
  await L.inject(page, 'S3', 'S4', 'S5', 'S6', 'S7', 'S8');
  const counts = {};
  counts.cand1 = await page.evaluate(() => buildCandidates());
  L.log('buildCandidates', counts.cand1);

  if (!opsFile) {
    // Stage 3 step 6: verify the candidate links, then rebuild so content-disposition filenames replace "click here" titles.
    counts.links1 = await page.evaluate(() => checkLinks(CAND.docs.filter(d => d.aec || d.up === 'Review').map(d => d.url)));
    L.log('checkLinks aec/review', counts.links1);
    const h = JSON.parse(counts.links1);
    const n = Object.values(h).reduce((a, b) => a + b, 0);
    if ((h['403'] || 0) > Math.max(5, n * 0.2)) {
      // A run of 403s = the checker is being rate-limited: wait 2 minutes, run the same call again (it only retries what has no status).
      L.log('many 403s; waiting 2 min and re-checking');
      await page.evaluate(() => { for (const [u, v] of Object.entries(LINKS)) if (v.status === 403) delete LINKS[u]; });
      await page.waitForTimeout(120000);
      counts.links1b = await page.evaluate(() => checkLinks(CAND.docs.filter(d => d.aec || d.up === 'Review').map(d => d.url)));
      L.log('checkLinks again', counts.links1b);
    }
    await L.saveVar(page, dir, 'LINKS');
    counts.cand2 = await page.evaluate(() => buildCandidates());
    L.log('buildCandidates 2', counts.cand2);
    if (process.argv.includes('--nonaec')) {
      // Stage 3 step 7, only when the crawl was fast.
      counts.links2 = await page.evaluate(() => checkLinks(CAND.docs.filter(d => !d.aec).map(d => d.url).slice(0, 400)));
      L.log('checkLinks non-AEC 400', counts.links2);
      await L.saveVar(page, dir, 'LINKS');
      counts.cand3 = await page.evaluate(() => buildCandidates());
    }
    if (!process.argv.includes('--no-maps')) {
      // Stage 5 step 1.
      counts.maps = await page.evaluate(() => AG.fromCrawl());
      L.log('AG.fromCrawl', counts.maps);
      await L.saveAG(page, dir);
      fs.writeFileSync(path.join(dir, 'ag_log.txt'), (await page.evaluate(() => AG.log.join('\n') + '\n\norgCandidates: ' + JSON.stringify(AG.orgCandidates) + '\norgVotes: ' + JSON.stringify(AG.orgVotes || {}))));
    }
  } else {
    if (fs.existsSync(path.join(dir, 'ag.json'))) L.log('restored layers', await L.loadAG(page, dir));
    const ops = L.readJSON(opsFile);
    for (const [op, arg] of ops) {
      let r;
      if (op === 'setDec') r = await page.evaluate(a => setDec(a), arg);
      else if (op === 'setMap') r = await page.evaluate(a => setMap(a), arg);
      else if (op === 'checkLinks') { r = await page.evaluate(a => checkLinks(a), arg); await L.saveVar(page, dir, 'LINKS'); }
      else if (op === 'setOrg') r = await page.evaluate(a => AG.setOrg(a), arg);
      else if (op === 'orgSearch') r = await page.evaluate(a => AG.orgSearch(a), arg);
      else if (op === 'resolveItem') r = await page.evaluate(a => AG.resolveItem(a, 'manual'), arg);
      else if (op === 'addService') r = await page.evaluate(a => AG.addService(a, 'manual'), arg);
      else if (op === 'server') r = await page.evaluate(a => AG.server(a), arg);
      else throw new Error('unknown op ' + op);
      L.log(op, typeof arg === 'string' ? arg : (Array.isArray(arg) ? arg.length + ' items' : ''), '->', r === undefined ? 'ok' : String(r).slice(0, 300));
    }
    await L.saveAG(page, dir);
    counts.cand2 = await page.evaluate(() => buildCandidates());
  }
  await L.saveVar(page, dir, 'DEC');
  await L.saveVar(page, dir, 'MDEC');
  await L.saveVar(page, dir, 'CAND');
  counts.layers = await page.evaluate(() => Object.keys(AG.layers).length);
  L.writeJSON(path.join(dir, 'classify_counts.json'), counts);

  // Stage 4 / 5 dumps, written to files and read in full (no slicing needed here).
  const BIG = 1e6;
  await L.dumpTo(page, path.join(dir, 'dump_review.txt'), `dumpDocs('review',0,${BIG})`);
  await L.dumpTo(page, path.join(dir, 'dump_yes.txt'), `dumpDocs('yes',0,${BIG})`);
  await L.dumpTo(page, path.join(dir, 'dump_noaec.txt'), `dumpDocs('no-aec',0,${BIG})`);
  await L.dumpTo(page, path.join(dir, 'dump_excl.txt'), `dumpDocs('excl',0,${BIG})`);
  await L.dumpTo(page, path.join(dir, 'dump_aec.txt'), `dumpDocs('aec',0,${BIG})`);
  await L.dumpTo(page, path.join(dir, 'dump_pages_aec.txt'), `dumpPages('aec',0,${BIG})`);
  await L.dumpTo(page, path.join(dir, 'dump_pages_no.txt'), `dumpPages('no',0,${BIG})`);
  await L.dumpTo(page, path.join(dir, 'dump_ext.txt'), `dumpExt(0,${BIG})`);
  await L.dumpTo(page, path.join(dir, 'dump_maps.txt'), 'dumpMaps()');
  // Same rows with URLs, for the reviewer (ids match the dumps).
  fs.writeFileSync(path.join(dir, 'doc_urls.tsv'), await page.evaluate(() => CAND.docs.map(effective).map(d => [d.id, d.up, d.url, d.page, (LINKS[d.url] || {}).status || '', (LINKS[d.url] || {}).ct || ''].join('\t')).join('\n')));
  fs.writeFileSync(path.join(dir, 'ext_urls.tsv'), await page.evaluate(() => CAND.ext.map(e => [e.id, e.kind, e.url, e.page].join('\t')).join('\n')));
  fs.writeFileSync(path.join(dir, 'page_urls.tsv'), await page.evaluate(() => CAND.pages.map(p => [p.id, p.aec ? 'AEC' : '-', p.url].join('\t')).join('\n')));
  L.log('classify done', JSON.stringify(counts));
  await browser.close();
})().catch(e => { console.error('CLASSIFY ERROR', e); process.exit(1); });
