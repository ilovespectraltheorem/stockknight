'use strict';
// The analysis board's move tree: a start position and every line tried from it. Each node is
// one move; a node's first child is its main continuation and the others are variations.
// Moves are UCI text and are checked against the rules as they are added.

(function (root) {
  const SK = root.StockKnight || (typeof require === 'function' ? require('../reference/engine.js') : null);

  class MoveTree {
    constructor(fen = SK.START_FEN) {
      new SK.Position(fen); // throws on a bad position
      this.fen = fen;
      this.nextId = 1;
      this.root = { id: 0, uci: null, text: '', ply: 0, parent: null, children: [] };
      this.nodes = new Map([[0, this.root]]);
    }

    get(id) {
      return this.nodes.get(id) || null;
    }

    // The UCI moves from the start position to a node.
    path(id) {
      const out = [];
      for (let n = this.get(id); n && n.parent; n = n.parent) out.push(n.uci);
      return out.reverse();
    }

    position(id) {
      const pos = new SK.Position(this.fen);
      for (const u of this.path(id)) pos.makeMove(pos.moveFromUci(u));
      return pos;
    }

    // Play `uci` after node `id`: the existing child with that move, or a new last child.
    // Returns the node, or null when the move is illegal there.
    add(id, uci, pos = null) {
      const parent = this.get(id);
      if (!parent) return null;
      const known = parent.children.find(c => c.uci === uci);
      if (known) return known;
      pos = pos || this.position(id);
      if (pos.status().state !== 'ongoing') return null;
      const m = pos.moveFromUci(uci);
      if (!m) return null;
      const node = { id: this.nextId++, uci, text: pos.moveToText(m), ply: parent.ply + 1, parent, children: [] };
      parent.children.push(node);
      this.nodes.set(node.id, node);
      return node;
    }

    // Play a list of moves after node `id`; returns the last node reached (stops at an illegal move).
    addLine(id, ucis) {
      let node = this.get(id);
      const pos = this.position(id);
      for (const u of ucis) {
        const next = this.add(node.id, u, pos);
        if (!next) break;
        pos.makeMove(pos.moveFromUci(u));
        node = next;
      }
      return node;
    }

    // The main continuation from a node to the end of its line.
    mainline(id = 0) {
      const out = [];
      for (let n = this.get(id); n && n.children.length; ) {
        n = n.children[0];
        out.push(n);
      }
      return out;
    }

    // Whether a node lies on the tree's main line.
    isMainline(id) {
      for (let n = this.get(id); n && n.parent; n = n.parent) if (n.parent.children[0] !== n) return false;
      return true;
    }

    // Make the line through a node the main line, all the way up to the start.
    promote(id) {
      for (let n = this.get(id); n && n.parent; n = n.parent) {
        const sib = n.parent.children;
        sib.splice(sib.indexOf(n), 1);
        sib.unshift(n);
      }
    }

    // Delete a node and everything after it. Returns its parent's id.
    remove(id) {
      const n = this.get(id);
      if (!n || !n.parent) return 0;
      const sib = n.parent.children;
      sib.splice(sib.indexOf(n), 1);
      const drop = x => {
        this.nodes.delete(x.id);
        x.children.forEach(drop);
      };
      drop(n);
      return n.parent.id;
    }

    // Compact storage: { fen, lines } where lines is the nested [uci, [children]] form.
    toJSON() {
      const enc = n => n.children.map(c => [c.uci, enc(c)]);
      return { fen: this.fen, lines: enc(this.root) };
    }

    static fromJSON(data) {
      const t = new MoveTree(data.fen);
      const dec = (node, kids, pos) => {
        for (const [uci, sub] of kids || []) {
          const c = t.add(node.id, uci, pos);
          if (!c) continue;
          pos.makeMove(pos.moveFromUci(uci));
          dec(c, sub, pos);
          pos.unmakeMove();
        }
      };
      dec(t.root, data.lines, new SK.Position(data.fen));
      return t;
    }

    // Find the node reached by a list of moves, or null.
    find(ucis) {
      let n = this.root;
      for (const u of ucis) {
        n = n.children.find(c => c.uci === u);
        if (!n) return null;
      }
      return n;
    }
  }

  const api = { MoveTree };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MoveTree = MoveTree;
})(typeof self !== 'undefined' ? self : globalThis);
