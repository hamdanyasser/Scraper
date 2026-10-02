// extract_snippets.js <runbook.md> — copy snippets S2–S9 verbatim from the Runbook 2 markdown into ./snippets/S<n>.js.
// The snippets are not committed: re-extract from the runbook version you run, so the scripts always use its exact code.
const fs = require('fs');
const path = require('path');
const md = fs.readFileSync(process.argv[2], 'utf8');
const out = path.join(__dirname, 'snippets');
fs.mkdirSync(out, { recursive: true });
let n = 0;
for (const m of md.matchAll(/```js\n([\s\S]*?)```/g)) {
  const id = (m[1].match(/^\/\/ (S\d)\b/) || [])[1];
  if (!id || id === 'S1') continue; // S1 needs a logged-in Jira tab; Jira goes through the Atlassian connector instead
  fs.writeFileSync(path.join(out, id + '.js'), m[1]);
  console.log(id, m[1].length, 'chars');
  n++;
}
if (n !== 8) { console.error('expected S2–S9 (8 snippets), got ' + n); process.exit(1); }
