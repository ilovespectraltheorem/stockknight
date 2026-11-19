'use strict';
// Site settings. The GitHub Pages build (.github/workflows/pages.yml) rewrites this file.
//   server: base URL of web/server.js for online games ('' = the server that serves this page)
//   wasm, net: Stockhorse in WebAssembly and its network, relative to this page ('' = use G0)
(typeof self !== 'undefined' ? self : globalThis).MAKI_CONFIG = {
  server: '',
  wasm: 'engine/stockhorse.wasm',
  net: 'nets/g25.nnue',
};
