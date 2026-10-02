# Runbook 2 stage scripts (Claude Code cloud session)

Plumbing for AIAEC Runbook 2 (Jira ticket → crawl → classify → workbook) when the run happens in a Claude Code cloud
container instead of Claude in Chrome. The stages, rules, Reference A–E and snippets S2–S9 are the runbook's own; these
scripts only run them in headless Chromium and keep the state on disk. Jira (start comment, Progress comment, scrape
comment, attachment, transition) goes through the Atlassian connector, not S1.

## One-time setup per container

```sh
# Chromium must trust the egress proxy CA (TLS verification stays on)
apt-get install -y libnss3-tools
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n ccr-agent-proxy -i /root/.ccr/agent-proxy-ca.crt
# copy S2–S9 verbatim from the runbook you are running
node extract_snippets.js /path/to/Runbook_2_v2_unattended.md
```

## Per ticket

State lives in `$STATE_ROOT/<KEY>/` (default `./runs/<KEY>/`, git-ignored). Write `run.json` first (= `window.RUN`):

```json
{"key":"DATA-…","city":"…","state":"ST","county":"…","site":"https://…","date":"YYYY-MM-DD","maxPages":20000,"maxMinutes":120,"crawlNews":false,"etlHtml":false}
```

| Step | Command | Runbook |
| --- | --- | --- |
| Verify a page | `node readpage.js <url> <out.txt>` | Stage 2, Stage 4 review, Stage 6 |
| Crawl | `node crawl.js <KEY>` (`--resume` continues from `cr.json`) | Stage 3 steps 1–3: S2, crawlHealth, one `retryFailed(2,1500)` |
| Classify + maps | `node classify.js <KEY> [--nonaec]` | Stage 3 steps 5–7 (S3–S6, checkLinks), Stage 5 (S7, S8, `AG.fromCrawl`); writes the `dump_*.txt` review files |
| Review decisions | `node classify.js <KEY> --ops ops.json` | Stage 4 `setDec`, Stage 5 `setMap` / `AG.setOrg` / `AG.resolveItem` / `AG.addService` / `AG.server` |
| Ordinance + codes | write `ord.json` (`window.ORD`) and `codes.json` (`window.CODES`) | Stage 6 |
| Workbook | `node build.js <KEY> <outDir>` | Stage 7: S9 `buildWorkbook` + `downloadWorkbook`, saved to `<outDir>`; counts in `build.json` |

Options learned on real sites (2 Oct 2026 runs):

- `./crawlloop.sh <KEY> [crawl.js options]` — use instead of `node crawl.js`: S2's fetches have no timeout, so crawl.js exits 3
  after 5 minutes without progress and the loop resumes it from `cr.json`.
- `crawl.js --fetch-timeout` / `classify.js --fetch-timeout` — abort any in-page fetch after 60 s (S2's crawl and `retryFailed`, S5 and
  S7 have no timeout; one dead server otherwise hangs the run). Use it on every city.
- `crawl.js --exclude '<regex>'` — drop a CMS crawl trap from the queue. Granicus sites:
  `'/i-want-to/advanced-components/|/Sys/Sso/|/Home/Components/(StaffDirectory|BusinessDirectory)/'`.
- `classify.js --get404` — CivicPlus DocumentCenter answers HEAD with 404 and GET with 200; re-checks the 404s with S5's
  GET + Range fallback. Use it on every city (harmless elsewhere).
- `classify.js --splash` — Granicus wraps external links as `/?splash=<url>`; adds the decoded targets to `CR.ext`.
- op `["recheckGet", [urls]]` — re-check specific links (transient 502s) with GET; `http://` links are checked on their `https://`
  address, since an https page blocks them as mixed content (they would otherwise show Link Status ERR).
- op `["recheckNode", [urls] | "*status0"]` — check links from Playwright's request context instead of the page (no CORS):
  for documents that redirect to another host (Revize `cms7files.revize.com`, CivicPlus `content.civicplus.com`), which the
  in-page check reports as status 0.
- `node renderlinks.js <KEY> [--lanes 4] [--wait 2500]` — run after crawl.js on JavaScript-rendered sites (CivicPlus HCMS titles
  "… Official Website | Official Website"), where S2 sees only the menus and records 0 documents: renders every crawled page and adds
  its document links to `CR.files` in S2's row shape; then classify with `["recheckNode","*status0"]`.
- Review traps seen: S4's latest-only rule groups look-alike titles ("Ordinance No. 26-24" vs "25-60") as one family and marks
  distinct ordinances superseded; "Historical" in a district name trips the archive rule; S9 makes PARCELS TAB rows Upload = Yes
  unless a `setMap` sets No; titles containing "Plat" or "Map" become Later.

`ops.json` is a list of `[op, arg]` pairs; only `setDec`, `setMap`, `checkLinks`, `setOrg`, `orgSearch`, `resolveItem`,
`addService` and `server` exist. There is no eval of arbitrary code and no long-running server.

Saved state: `cr.json` (CR with `seen` as an array; checkpointed every 2 minutes during the crawl), `links.json`,
`cand.json`, `dec.json`, `mdec.json`, `ag.json` (layers with `via` as arrays), `ord.json`, `codes.json`, `health.json`,
`build.json`.
