'use strict';
// Bundles the site into one self-contained HTML file, for publishing as a claude.ai Artifact
// (online games then use the artifact's shared database instead of web/server.js).
//   node web/build-artifact.js [out.html]
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const read = rel => fs.readFileSync(path.join(here, rel), 'utf8');
const safe = js => js.replace(/<\/script/gi, '<\\/script');

const engine = read('../reference/engine.js');
const endgame = read('endgame.js');
const tasks = read('engine-tasks.js');
const worker = read('engine-worker.js').replace(/^importScripts\(.*\);$/m, '');
const workerSrc = `${engine}\n${endgame}\n${tasks}\n${worker}`;

let html = read('index.html');
html = html.replace(/\s*<link rel="icon"[^>]*>/, '');
html = html.replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${read('style.css')}</style>`);
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  let js = read(src);
  if (src === 'app.js') js = `window.SK_WORKER_SRC = ${JSON.stringify(workerSrc)};\n${js}`;
  return `<script>\n${safe(js)}</script>`;
});

// The Artifact host supplies the document skeleton, so publish the head's title and style
// followed by the body's content.
const head = /<head>([\s\S]*)<\/head>/.exec(html)[1]
  .replace(/<meta charset[^>]*>|<meta name="viewport"[^>]*>|<meta name="description"[^>]*>/g, '')
  .replace('<title>Maki</title>', '<title>Maki Arena</title>');
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1];
html = `${head.trim()}\n${body.trim()}\n`;

const out = process.argv[2] || path.join(here, 'dist', 'stockknight.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${out} (${(html.length / 1024).toFixed(0)} KB)`);
