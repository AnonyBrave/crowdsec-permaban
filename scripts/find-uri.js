// Debug helper: searches the repo's text files for the base64 logo string Chrome reports as its favicon.
import fs from 'node:fs';

const needle = 'PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9y';
const files = fs.readdirSync('.', { recursive: true }).filter((p) => /\.(js|css|html|json|md|txt)$/.test(String(p)));

for (const f of files.map(String)) {
  const raw = fs.readFileSync(f, 'utf8');
  if (raw.includes(needle)) console.log('found in', f);
}
console.log('decoded head icon href content:', decodeURIComponent((fs.readFileSync('public/index.html', 'utf8').match(/href='([^']+)'/) ?? [])[1] ?? ''));
