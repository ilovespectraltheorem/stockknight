'use strict';
// The benchmark: a fixed-depth search of every position in testdata/bench-positions.txt.
// The Rust engine's `bench` must report the same node counts, scores and moves.
// Usage: node reference/bench.js [depth]

const fs = require('node:fs');
const path = require('node:path');
const E = require('./engine.js');

const depth = parseInt(process.argv[2] || '7', 10);
const fens = fs.readFileSync(path.join(__dirname, '..', 'testdata', 'bench-positions.txt'), 'utf8')
  .split('\n').map(s => s.trim()).filter(Boolean);

let nodes = 0;
const start = Date.now();
for (const fen of fens) {
  const pos = new E.Position(fen);
  const r = new E.Searcher().think(pos, { depth });
  nodes += r.nodes;
  console.log(`${pos.moveToUci(r.best).padEnd(6)} ${String(r.score).padStart(6)} ${String(r.nodes).padStart(9)}  ${fen}`);
}
const ms = Date.now() - start;
console.log(`depth ${depth}: ${nodes} nodes, ${ms} ms, ${Math.round(nodes / (ms / 1000))} nodes/s`);
