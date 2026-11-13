// Debug helper: prints every data: URI and href in public/index.html, so we can tell what Chrome is loading as favicon.
import fs from 'node:fs';
const s = fs.readFileSync('public/index.html', 'utf8');
console.log('has base64 logo string:', s.includes('PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUi'));
for (const m of s.matchAll(/data:[^'"\s]+/g)) console.log(m[0].slice(0, 80), '…', m[0].length);
