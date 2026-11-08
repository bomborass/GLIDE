// Turns dist/index.html into a body-only page for publishing as a claude.ai artifact.
import fs from 'fs';
const html = fs.readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const styles = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(m => m[0]).join('\n');
const scripts = [...html.matchAll(/<script[^>]*>[\s\S]*?<\/script>/g)].map(m => m[0].replace(/ crossorigin/g, '')).join('\n');
const out = `<title>SLIDE</title>\n${styles}\n<div id="root"></div>\n${scripts}\n`;
fs.writeFileSync(process.argv[2], out);
console.log('wrote', process.argv[2], out.length);
