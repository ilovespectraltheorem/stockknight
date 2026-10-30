'use strict';
// The reference engine behind the engine protocol, so `sk-match` can play it:
//   sk-match --e1 target/release/stockknight --e2 "node reference/js-engine.js" ...
// Supports uci, isready, ucinewgame, position, go (depth, nodes, movetime, level) and quit.

const readline = require('node:readline');
const E = require('./engine.js');

let pos = new E.Position();
let searcher = new E.Searcher();
let randomMargin = 0;
const say = line => process.stdout.write(`${line}\n`);

function position(words) {
  const at = words.indexOf('moves');
  const end = at < 0 ? words.length : at;
  const p = words[1] === 'startpos' ? new E.Position() : new E.Position(words.slice(2, end).join(' '));
  if (at >= 0) {
    for (const text of words.slice(at + 1)) {
      const m = p.moveFromUci(text);
      if (!m) throw new Error(`illegal move ${text}`);
      p.makeMove(m);
    }
  }
  pos = p;
}

function go(words) {
  const num = key => {
    const i = words.indexOf(key);
    return i >= 0 ? parseInt(words[i + 1], 10) : undefined;
  };
  const level = words.indexOf('level') >= 0 ? E.LEVELS[words[words.indexOf('level') + 1]] : null;
  const limits = { ...(level || {}), randomMargin: level ? level.randomMargin : randomMargin };
  if (num('depth')) limits.depth = num('depth');
  if (num('nodes')) limits.nodes = num('nodes');
  if (num('movetime')) limits.movetime = num('movetime');
  const r = searcher.think(pos, limits, info => {
    const score = Math.abs(info.score) >= E.MATE - 1000 ? `mate ${E.mateIn(info.score)}` : `cp ${info.score}`;
    const pv = info.pv.map(m => pos.moveToUci(m)).join(' ');
    say(`info depth ${info.depth} score ${score} nodes ${info.nodes} time ${info.elapsed} pv ${pv}`);
  });
  say(`bestmove ${r.best ? pos.moveToUci(r.best) : '0000'}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const words = line.trim().split(/\s+/);
  try {
    switch (words[0]) {
      case 'uci':
        say('id name StockKnight reference (JS)');
        say('uciok');
        break;
      case 'isready':
        say('readyok');
        break;
      case 'ucinewgame':
        searcher = new E.Searcher();
        break;
      case 'setoption':
        if (words[2] === 'RandomMargin') randomMargin = parseInt(words[4], 10) || 0;
        break;
      case 'position':
        position(words);
        break;
      case 'go':
        go(words);
        break;
      case 'quit':
        process.exit(0);
        break;
      default:
        if (words[0]) say(`info string unknown command: ${line}`);
    }
  } catch (e) {
    say(`info string error ${e.message}`);
  }
});
