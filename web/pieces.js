'use strict';
// StockKnight's own piece set, drawn for this site. Each piece is a 100×100 SVG; colours come
// from CSS (--pc-body, --pc-line, --pc-detail) so one drawing serves both sides.

(function (root) {
  const base = 'M27 82c0-4 3-7 7-7h32c4 0 7 3 7 7v4H27z';
  const shapes = {
    // Pawn: a round head on a collar and a flared foot.
    P: `<path class="b" d="M50 22a11 11 0 0 0-7.4 19.2C37 43 35 46 35 48h30c0-2-2-5-7.6-6.8A11 11 0 0 0 50 22z"/>
        <path class="b" d="M42 50c0 9-3 17-9 25h34c-6-8-9-16-9-25z"/>
        <path class="b" d="${base}"/>`,
    // Knight: the house piece, a horse's head with a braided mane.
    N: `<path class="b" d="M68 75H33c-1-10 3-17 11-24 4-3.5 6-7 6.5-10.5-2.5 2.5-6 4-10 4.5-3 3-7 5-11 4.5-3.5-.5-5.5-3.5-4.5-7 1.5-5 5-8.5 9.5-12.5 3-2.5 5-6 6.5-9.5l-1.5-7c3.5.5 6 2.5 7.5 5 1.5-2.5 4-4 7-4.5l-.5 6.5C68 22 78 34 76 52c-1 9-4 16-8 23z"/>
        <path class="d" d="M60 26c5 4 9 11 9 20 0 9-3 17-6 25" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="3 4"/>
        <circle class="d" cx="45" cy="31" r="2.6"/>
        <path class="d" d="M28.5 41.5c1.5.3 3 .2 4-.6" fill="none" stroke-width="2" stroke-linecap="round"/>
        <path class="b" d="${base}"/>`,
    // Bishop: a mitre with its cut, on a collar.
    B: `<circle class="b" cx="50" cy="16" r="5"/>
        <path class="b" d="M50 22c-10 8-16 18-16 27 0 7 4 12 10 13h12c6-1 10-6 10-13 0-9-6-19-16-27z"/>
        <path class="d" d="M45 42l11-11" fill="none" stroke-width="3" stroke-linecap="round"/>
        <path class="b" d="M37 63h26v6H37z"/>
        <path class="b" d="M40 69c0 2-2 4-4 6h28c-2-2-4-4-4-6z"/>
        <path class="b" d="${base}"/>`,
    // Rook: a battlemented tower.
    R: `<path class="b" d="M29 20h9v7h7.5v-7h9v7H62v-7h9v17l-7 5v24l6 6v3H30v-3l6-6V42l-7-5z"/>
        <path class="d" d="M36 42h28M36 66h28" fill="none" stroke-width="2.5"/>
        <path class="b" d="${base}"/>`,
    // Queen: a five-pointed coronet.
    Q: `<path class="b" d="M22 30l11 34h34l11-34-14 17-7-25-7 23-7-23-7 25z"/>
        <circle class="b" cx="22" cy="27" r="4.5"/><circle class="b" cx="36" cy="20" r="4.5"/>
        <circle class="b" cx="50" cy="17" r="4.5"/><circle class="b" cx="64" cy="20" r="4.5"/>
        <circle class="b" cx="78" cy="27" r="4.5"/>
        <path class="b" d="M32 64h36l-2 11H34z"/>
        <path class="b" d="${base}"/>`,
    // King: a crowned dome topped with a cross.
    K: `<path class="b" d="M46.5 9h7v7h7v7h-7v6h-7v-6h-7v-7h7z"/>
        <path class="b" d="M50 31c-14 0-26 6-26 17 0 8 6 13 10 17h32c4-4 10-9 10-17 0-11-12-17-26-17z"/>
        <path class="d" d="M50 33v31M34 52c10-4 22-4 32 0" fill="none" stroke-width="2.5"/>
        <path class="b" d="M33 65h34l-2 10H35z"/>
        <path class="b" d="${base}"/>`,
  };

  const NAMES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };

  // letter: one of PNBRQK; color: 'w' | 'b'
  function pieceSvg(letter, color) {
    return `<svg class="piece ${color === 'w' ? 'pw' : 'pb'}" viewBox="0 0 100 100" aria-hidden="true">${shapes[letter]}</svg>`;
  }

  root.Pieces = { pieceSvg, NAMES, shapes };
})(globalThis);
