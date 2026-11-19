# Publishing Maki

The website is static, so GitHub Pages serves it: the page, the reference engine (rules, G0),
and Stockhorse compiled to WebAssembly with the strongest accepted network. Online games need
`web/server.js`, which Pages cannot run, so it lives on a separate free host.

**Play:** https://ilovespectraltheorem.github.io/stockknight/

## The site (GitHub Pages)

`.github/workflows/pages.yml` runs on every push to `main`: it builds `crates/wasm` for
`wasm32-wasip1` with WebAssembly SIMD (`web/build-wasm.sh`), checks it (`web/test-wasm.js`),
assembles `_site/` (`web/build-pages.sh`) and deploys it.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Locally:

```sh
rustup target add wasm32-wasip1
web/build-wasm.sh                 # web/engine/stockhorse.wasm
node web/test-wasm.js             # G0 in WebAssembly equals the reference; the network plays
web/build-pages.sh _site && (cd _site && python3 -m http.server 8000)
node web/server.js                # or this: everything, including online games, on :8080
```

### The engine in the browser

The engine worker (`web/engine-worker.js`) loads `web/wasm-engine.js`, which runs the Rust
search (`sk-search`) with the quantized, incremental network (`sk-nnue`) inside WebAssembly. The
tasks (`crates/wasm`) are ports of `play`, `analyse` and `lines` in `web/engine-tasks.js`, so
the play screen, the analysis board and game review work as before; with G0 the WebAssembly
engine plays exactly the reference engine's moves at equal node budgets (tested).

| | Nodes/s (Chromium, laptop) |
|---|---|
| Reference engine, G0 (JavaScript) | ≈ 450k |
| Stockhorse, G25 (WebAssembly SIMD) | ≈ 450k |

The network loads on a worker's first search (about 0.6 s, after a 29 MB download the browser
then caches). If WebAssembly or the network is unavailable, the worker falls back to G0.

**Changing the network:** put the file in `web/nets/` and point `net` in `web/config.js` at
it. `*.nnue` files are ignored by git except in `web/nets/`. The Elo slider's ladder
(`docs/STRENGTH.md`) was calibrated with G0, so with a network every setting plays stronger
than its label until `web/calibrate.js` is re-run against the WebAssembly engine.

## Online games (Render, free)

`render.yaml` describes the server as a Render Blueprint on the free plan:

1. Sign in at https://render.com with GitHub, choose **New → Blueprint**, and pick this
   repository. Render starts `node web/server.js` and gives it a URL such as
   `https://maki-server.onrender.com`.
2. In this repository, **Settings → Secrets and variables → Actions → Variables**, add
   `MAKI_SERVER_URL` with that URL, then re-run the Pages workflow (Actions → Pages → Run
   workflow).

The server allows cross-origin requests to `/api`, so the Pages site talks to it directly.
Free-plan limits: the service sleeps after 15 minutes without requests and takes up to a minute
to wake (the Online card says so meanwhile), and games in progress are lost when it sleeps or
redeploys, since the free plan has no disk for `--data`. Any host that runs Node works the same
way (Fly.io, Railway, a small VM): run `node web/server.js` with `PORT` set and put its URL in
`MAKI_SERVER_URL`.
