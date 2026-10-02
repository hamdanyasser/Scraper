// lib.js — shared plumbing for the Runbook 2 stage scripts (headless Chromium in a Claude Code cloud session).
// The page opened on the city's homepage plays the role of the runbook's "Tab B". Snippets S2–S9 are injected
// verbatim from ./snippets (extracted from the runbook); nothing here changes their logic.
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');

const SNIP = path.join(__dirname, 'snippets');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// State lives in <STATE_ROOT>/<KEY>/ (default: ./runs). run.json holds window.RUN.
function stateDir(key) {
  const d = path.join(process.env.STATE_ROOT || path.join(__dirname, 'runs'), key);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const readJSON = (f, dflt) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : dflt);
function writeJSON(f, v) { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, f); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function launch() {
  // The proxy CA must be trusted in ~/.pki/nssdb (certutil -A -t "C,," -n ccr-agent-proxy -i /root/.ccr/agent-proxy-ca.crt);
  // TLS verification stays on.
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
  });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 }, locale: 'en-US', acceptDownloads: true, bypassCSP: true });
  return { browser, ctx };
}

// Open the city homepage ("Tab B") and set window.RUN.
async function openSite(ctx, RUN) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(0);
  const r = await page.goto(RUN.site + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2000);
  log('opened', page.url(), 'status', r && r.status(), 'title', await page.title());
  await page.evaluate(run => { window.RUN = run; }, RUN);
  return page;
}

async function inject(page, ...names) {
  for (const n of names) await page.addScriptTag({ content: fs.readFileSync(path.join(SNIP, n + '.js'), 'utf8') });
}

// --- state save / restore (Sets converted to arrays) ---
const SAVE_CR = () => JSON.stringify(Object.assign({}, window.CR, { seen: [...(window.CR.seen || [])] }));
const LOAD_CR = s => { const o = JSON.parse(s); o.seen = new Set(o.seen || []); window.CR = o; return Object.keys(o.pages).length; };
const SAVE_AG = () => JSON.stringify({ items: window.AG.items, log: window.AG.log, done: [...window.AG.done], orgCandidates: window.AG.orgCandidates, orgVotes: window.AG.orgVotes || {}, orgId: window.AG.orgId || '', orgName: window.AG.orgName || '', orgKey: window.AG.orgKey || '',
  layers: Object.fromEntries(Object.entries(window.AG.layers).map(([u, l]) => [u, Object.assign({}, l, { via: [...(l.via || [])] })])) });
const LOAD_AG = s => { const o = JSON.parse(s); for (const k of ['items', 'log', 'orgCandidates', 'orgVotes', 'orgId', 'orgName', 'orgKey']) window.AG[k] = o[k]; window.AG.done = new Set(o.done || []);
  window.AG.layers = Object.fromEntries(Object.entries(o.layers || {}).map(([u, l]) => [u, Object.assign(l, { via: new Set(l.via || []) })])); return Object.keys(window.AG.layers).length; };

async function saveCR(page, dir) { fs.writeFileSync(path.join(dir, 'cr.json.tmp'), await page.evaluate(SAVE_CR)); fs.renameSync(path.join(dir, 'cr.json.tmp'), path.join(dir, 'cr.json')); }
async function loadCR(page, dir) { return page.evaluate(LOAD_CR, fs.readFileSync(path.join(dir, 'cr.json'), 'utf8')); }
async function saveAG(page, dir) { fs.writeFileSync(path.join(dir, 'ag.json'), await page.evaluate(SAVE_AG)); }
async function loadAG(page, dir) { return page.evaluate(LOAD_AG, fs.readFileSync(path.join(dir, 'ag.json'), 'utf8')); }
async function saveVar(page, dir, name) { writeJSON(path.join(dir, name.toLowerCase() + '.json'), await page.evaluate(n => window[n] || null, name)); }
async function loadVar(page, dir, name, dflt) { const v = readJSON(path.join(dir, name.toLowerCase() + '.json'), dflt); await page.evaluate(([n, x]) => { window[n] = x; }, [name, v]); return v; }

// Run a dump helper (dumpDocs, dumpPages, dumpExt, dumpMaps, dumpFailed) and write the text to a file instead of reading it in slices.
async function dumpTo(page, file, expr) {
  await page.evaluate(expr);
  const t = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync(file, t);
  return t.length;
}

module.exports = { launch, openSite, inject, stateDir, readJSON, writeJSON, log, saveCR, loadCR, saveAG, loadAG, saveVar, loadVar, dumpTo };
