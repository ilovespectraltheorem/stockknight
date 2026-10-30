'use strict';
// Runs the reference engine off the page's main thread so the board stays responsive.
importScripts('../reference/engine.js', 'engine-tasks.js');

self.onmessage = e => {
  const { id, cmd, args } = e.data;
  try {
    const task = self.EngineTasks[cmd];
    if (typeof task !== 'function' || cmd === 'build') throw new Error(`unknown command ${cmd}`);
    self.postMessage({ id, result: task(args) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
