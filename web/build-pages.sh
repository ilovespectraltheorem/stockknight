#!/bin/sh
# Assembles the static site for GitHub Pages in OUT (default _site): the web/ page at the root,
# the reference engine, Stockhorse in WebAssembly and the network. Run web/build-wasm.sh first.
#   MAKI_SERVER_URL=https://maki.example.com web/build-pages.sh _site
# MAKI_SERVER_URL is where web/server.js runs for online games; empty leaves online play off.
set -e
cd "$(dirname "$0")/.."
OUT=${1:-_site}
rm -rf "$OUT"
mkdir -p "$OUT/reference" "$OUT/engine" "$OUT/nets" "$OUT/train"
for f in index.html style.css favicon.svg app.js config.js endgame.js engine-tasks.js \
         engine-worker.js online.js pieces.js review.js tree.js share.js manifest.webmanifest wasm-engine.js lessons.js tutorial.js coach.js \
         train.js train.css train/openings.js train/tactics.js train/endgames.js; do
  cp "web/$f" "$OUT/$f"
done
cp reference/engine.js "$OUT/reference/engine.js"
cp web/engine/stockhorse.wasm "$OUT/engine/stockhorse.wasm"
NET=$(sed -n "s/^ *net: '\(.*\)',$/\1/p" web/config.js)
cp "web/$NET" "$OUT/$NET"
# The page sits at the site root, so the reference engine is beside it, not one level up.
sed -i 's#\.\./reference/engine\.js#reference/engine.js#' "$OUT/index.html" "$OUT/engine-worker.js"
# Bust caches when the files change: version the scripts the page and worker load.
V=$(cat "$OUT"/*.js "$OUT"/train/*.js "$OUT"/engine/* "$OUT/$NET" | sha1sum | cut -c1-10)
sed -i "s#\(src=\"[^\"]*\.js\)\"#\1?v=$V\"#; s#href=\"\([a-z]*\.css\)\"#href=\"\1?v=$V\"#" "$OUT/index.html"
sed -i "s#new Worker('engine-worker.js')#new Worker('engine-worker.js?v=$V')#" "$OUT/app.js"
sed -i "s#'\([a-z./-]*\.js\)'#'\1?v=$V'#g" "$OUT/engine-worker.js"
sed -i "s#server: ''#server: '${MAKI_SERVER_URL:-}'#; s#\(wasm: '[^']*\)'#\1?v=$V'#; s#\(net: '[^']*\)'#\1?v=$V'#" "$OUT/config.js"
touch "$OUT/.nojekyll"
du -sh "$OUT"
