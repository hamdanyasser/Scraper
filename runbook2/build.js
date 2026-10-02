// build.js <KEY> <outDir> — Runbook 2 Stage 7: apply the saved decisions, S9 buildWorkbook, save the .xlsx.
// Restores CR, LINKS, DEC, MDEC, AG, ORD (ord.json) and CODES (codes.json); runs S3–S9 in a blank page (no requests to the city site),
// captures downloadWorkbook()'s browser download into <outDir>, and writes build.json with the counts for the scrape comment.
const path = require('path');
const fs = require('fs');
const L = require('./lib');

(async () => {
  const key = process.argv[2];
  const outDir = process.argv[3] || L.stateDir(key);
  const dir = L.stateDir(key);
  const RUN = L.readJSON(path.join(dir, 'run.json'));
  const { browser, ctx } = await L.launch();
  const page = await ctx.newPage();
  page.setDefaultTimeout(0);
  await page.goto('about:blank');
  await page.evaluate(run => { window.RUN = run; }, RUN);
  await L.loadCR(page, dir);
  await L.loadVar(page, dir, 'LINKS', {});
  await L.loadVar(page, dir, 'DEC', {});
  await L.loadVar(page, dir, 'MDEC', {});
  await L.loadVar(page, dir, 'ORD', { source: '', note: 'out of source' });
  await L.loadVar(page, dir, 'CODES', []);
  await L.inject(page, 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9');
  if (fs.existsSync(path.join(dir, 'ag.json'))) await L.loadAG(page, dir);
  L.log('buildCandidates', await page.evaluate(() => buildCandidates()));
  L.log('loadXLSX', await page.evaluate(() => loadXLSX().catch(e => 'failed ' + e)));
  const wb = JSON.parse(await page.evaluate(() => buildWorkbook()));
  L.log('buildWorkbook', JSON.stringify(wb));
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.evaluate(() => downloadWorkbook())]);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, wb.file);
  await dl.saveAs(file);
  // Extra counts for comment 2 (read from the built sheets, not recomputed).
  const extra = await page.evaluate(() => {
    const aec = SHEETS.find(s => s.name === 'AEC Documents').rows;
    const maps = SHEETS.find(s => s.name === 'Maps & GIS').rows;
    const c = (rows, f) => rows.filter(f).length;
    const reasons = {};
    for (const r of aec) if (r['Upload to ETL'] !== 'Yes') { const k = String(r.Reason || '').replace(/\(.*$|\d{4}.*$/, '').trim(); reasons[k] = (reasons[k] || 0) + 1; }
    return {
      superseded: c(aec, r => r['Version Status'] === 'Superseded'), draft: c(aec, r => r['Version Status'] === 'Draft'),
      dead: c(aec, r => /^dead link/.test(r.Reason || '')), later: c(aec, r => r['Upload to ETL'] === 'Later'),
      yesCompliance: c(aec, r => r['Upload to ETL'] === 'Yes' && r['ETL Destination'] === 'Compliance'),
      yesPAD: c(aec, r => r['Upload to ETL'] === 'Yes' && r['ETL Destination'] === 'PAD Documents'),
      yesOrdinance: c(aec, r => r['Upload to ETL'] === 'Yes' && r['ETL Destination'] === 'Ordinance'),
      layers: Object.keys(AG.layers).length,
      mapsYes: c(maps, r => r['Upload to ETL'] === 'Yes' && r['Query Link']),
      newType: maps.filter(r => /^NEW TYPE/.test(r['Map Category (ETL Type)'] || '') && r['Query Link']).map(r => r['Map Category (ETL Type)'].replace('NEW TYPE NEEDED: ', '') + ': ' + r['Layer Name']),
      sheets: Object.fromEntries(SHEETS.map(s => [s.name, s.rows.length === 1 && s.rows[0].note ? 0 : s.rows.length])),
      nonYesReasons: reasons,
    };
  });
  const out = Object.assign({ path: file, bytes: fs.statSync(file).size }, wb, extra);
  L.writeJSON(path.join(dir, 'build.json'), out);
  L.log('saved', file, out.bytes, 'bytes');
  await browser.close();
})().catch(e => { console.error('BUILD ERROR', e); process.exit(1); });
