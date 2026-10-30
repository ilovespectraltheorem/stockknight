//! `QuantEval`: the quantized network as a search evaluator, with accumulators kept up to date
//! move by move.
//!
//! - `make` records what the move changes (at most two pieces off, one on, and the reserve
//!   inputs of both sides) on a stack. Nothing is computed yet.
//! - `evaluate` brings the top accumulator up to date for each perspective: from the nearest
//!   computed ancestor, applying the recorded changes, unless that perspective's king moved on
//!   the way. Then the accumulator is rebuilt from the refresh cache.
//! - The refresh cache keeps, for each perspective and king square, the last accumulator built
//!   there and the board it was built for. A rebuild only applies the squares that differ.

use sk_core::*;

use crate::features::BOARD_FEATURES;
use crate::quant::QuantNet;

/// Reserve inputs of one side as 5 bits: a pawn in hand, two pawns, a rook, a bishop, and
/// "a rook or bishop drop is allowed".
fn reserve_bits(hand: &[u8], rb_count: u8) -> u8 {
    (hand[PAWN as usize] >= 1) as u8
        | ((hand[PAWN as usize] >= 2) as u8) << 1
        | ((hand[ROOK as usize] >= 1) as u8) << 2
        | ((hand[BISHOP as usize] >= 1) as u8) << 3
        | ((rb_count < 2) as u8) << 4
}

fn reserves(pos: &Position) -> [u8; 2] {
    [0, 1].map(|c| reserve_bits(&pos.hand[c], pos.rb_count[c]))
}

#[inline]
fn orient(p: usize, sq: usize) -> usize {
    if p == WHITE as usize {
        sq
    } else {
        35 - sq
    }
}

/// The board input for `code` on `sq` from `p`'s view with its king on `ksq`, if any.
#[inline]
fn board_feature(p: usize, ksq: usize, code: u8, sq: usize) -> Option<usize> {
    let (color, kind) = (color_of(code) as usize, type_of(code) as usize);
    if color == p && kind == KING as usize {
        return None;
    }
    let k = if color == p { kind - 1 } else { 4 + kind };
    Some(orient(p, ksq) * 396 + k * 36 + orient(p, sq))
}

/// The reserve inputs that change for `p` between reserve bits `before` and `after` (indexed by
/// colour): into `add` if they come on, `sub` if they go off.
fn reserve_changes(
    p: usize,
    before: [u8; 2],
    after: [u8; 2],
    add: &mut Vec<usize>,
    sub: &mut Vec<usize>,
) {
    for (i, c) in [p, p ^ 1].into_iter().enumerate() {
        let changed = before[c] ^ after[c];
        for bit in 0..5 {
            if changed >> bit & 1 != 0 {
                let f = BOARD_FEATURES + 5 * i + bit;
                if after[c] >> bit & 1 != 0 {
                    add.push(f);
                } else {
                    sub.push(f);
                }
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Delta {
    /// (code, square) pairs; `n_off` used.
    off: [(u8, u8); 2],
    n_off: usize,
    on: (u8, u8),
    king_moved: [bool; 2],
    res_before: [u8; 2],
    res_after: [u8; 2],
}

struct Entry {
    /// Both perspectives, `[colour][ft]`.
    acc: Vec<i16>,
    computed: [bool; 2],
    ksq: [u8; 2],
    delta: Delta,
}

struct CacheEntry {
    acc: Vec<i16>,
    board: [u8; 36],
    res: [u8; 2],
}

pub struct QuantEval {
    pub net: QuantNet,
    stack: Vec<Entry>,
    top: usize,
    root_ply: usize,
    root_key: (u32, u32),
    /// `[colour * 36 + king square]`.
    cache: Vec<CacheEntry>,
    add: Vec<usize>,
    sub: Vec<usize>,
}

impl QuantEval {
    pub fn new(net: QuantNet) -> Self {
        let cache = (0..72)
            .map(|_| CacheEntry {
                acc: net.ft_b.clone(),
                board: [0; 36],
                res: [0; 2],
            })
            .collect();
        let mut e = QuantEval {
            stack: Vec::new(),
            top: 0,
            root_ply: usize::MAX,
            root_key: (0, 0),
            cache,
            add: Vec::with_capacity(64),
            sub: Vec::with_capacity(64),
            net,
        };
        e.entry(0);
        e
    }

    /// Make sure stack entry `i` exists.
    fn entry(&mut self, i: usize) {
        while self.stack.len() <= i {
            self.stack.push(Entry {
                acc: vec![0; 2 * self.net.ft],
                computed: [false; 2],
                ksq: [0; 2],
                delta: Delta::default(),
            });
        }
    }

    /// Start from `pos` with an empty stack.
    pub fn set_root(&mut self, pos: &Position) {
        self.top = 0;
        self.root_ply = pos.game_ply();
        self.root_key = (pos.hash_lo, pos.hash_hi);
        let e = &mut self.stack[0];
        e.computed = [false; 2];
        e.ksq = pos.king_sq;
        for p in 0..2 {
            self.refresh(pos, p);
        }
    }

    /// Rebuild `p`'s accumulator at the top of the stack from the refresh cache.
    fn refresh(&mut self, pos: &Position, p: usize) {
        let ksq = pos.king_sq[p] as usize;
        let c = &mut self.cache[p * 36 + ksq];
        self.add.clear();
        self.sub.clear();
        for sq in 0..36 {
            let (old, new) = (c.board[sq], pos.board[sq]);
            if old == new {
                continue;
            }
            if old != 0 {
                self.sub.extend(board_feature(p, ksq, old, sq));
            }
            if new != 0 {
                self.add.extend(board_feature(p, ksq, new, sq));
            }
        }
        let res = reserves(pos);
        reserve_changes(p, c.res, res, &mut self.add, &mut self.sub);
        self.net.update_in_place(&mut c.acc, &self.add, &self.sub);
        c.board = pos.board;
        c.res = res;
        let ft = self.net.ft;
        let e = &mut self.stack[self.top];
        e.acc[p * ft..(p + 1) * ft].copy_from_slice(&c.acc);
        e.computed[p] = true;
    }

    /// Apply entry `i`'s changes to `p`'s accumulator of entry `i − 1`.
    fn apply(&mut self, i: usize, p: usize) {
        let ft = self.net.ft;
        let (head, tail) = self.stack.split_at_mut(i);
        let (prev, cur) = (&head[i - 1], &mut tail[0]);
        let d = cur.delta;
        let ksq = cur.ksq[p] as usize;
        self.add.clear();
        self.sub.clear();
        for &(code, sq) in &d.off[..d.n_off] {
            self.sub.extend(board_feature(p, ksq, code, sq as usize));
        }
        if d.on.0 != 0 {
            self.add
                .extend(board_feature(p, ksq, d.on.0, d.on.1 as usize));
        }
        reserve_changes(p, d.res_before, d.res_after, &mut self.add, &mut self.sub);
        self.net.update(
            &mut cur.acc[p * ft..(p + 1) * ft],
            &prev.acc[p * ft..(p + 1) * ft],
            &self.add,
            &self.sub,
        );
        cur.computed[p] = true;
    }

    /// Bring `p`'s accumulator at the top of the stack up to date.
    fn ensure(&mut self, pos: &Position, p: usize) {
        if self.stack[self.top].computed[p] {
            return;
        }
        let mut i = self.top;
        loop {
            if self.stack[i].delta.king_moved[p] {
                return self.refresh(pos, p);
            }
            i -= 1;
            if self.stack[i].computed[p] {
                break;
            }
        }
        for j in i + 1..=self.top {
            self.apply(j, p);
        }
    }

    /// Bring both accumulators for `pos` up to date. `pos` must be the top of the stack; if it
    /// is not (the evaluator was used without `set_root`), the stack restarts from `pos`.
    fn sync(&mut self, pos: &Position) {
        let in_sync = pos.game_ply() == self.root_ply.wrapping_add(self.top)
            && (self.top > 0 || (pos.hash_lo, pos.hash_hi) == self.root_key);
        if !in_sync {
            self.set_root(pos);
        }
        self.ensure(pos, 0);
        self.ensure(pos, 1);
    }

    /// Both accumulators for `pos`, `[colour][ft]`.
    pub fn accumulators(&mut self, pos: &Position) -> &[i16] {
        self.sync(pos);
        &self.stack[self.top].acc
    }

    /// Centipawns from the side to move's view.
    pub fn evaluate_pos(&mut self, pos: &Position) -> i32 {
        self.sync(pos);
        let ft = self.net.ft;
        let (w, b) = self.stack[self.top].acc.split_at(ft);
        if pos.side == WHITE {
            self.net.evaluate_cp(w, b)
        } else {
            self.net.evaluate_cp(b, w)
        }
    }

    pub fn push(&mut self, pos: &Position, m: Move) {
        let us = pos.side as usize;
        let (from, to, drop) = (move_from(m), move_to(m), move_drop(m));
        let mut d = Delta {
            res_before: reserves(pos),
            ..Delta::default()
        };
        d.res_after = d.res_before;
        let mut ksq = self.stack[self.top].ksq;
        if drop != 0 {
            d.on = (make_code(drop, us as u8), to);
            let mut hand = pos.hand[us];
            hand[drop as usize] -= 1;
            let rb = pos.rb_count[us] + (drop == ROOK || drop == BISHOP) as u8;
            d.res_after[us] = reserve_bits(&hand, rb);
        } else {
            let code = pos.board[from as usize];
            let captured = pos.board[to as usize];
            d.off[0] = (code, from);
            d.n_off = 1;
            if captured != 0 {
                d.off[1] = (captured, to);
                d.n_off = 2;
                let kind = type_of(captured);
                if kind == ROOK || kind == BISHOP {
                    let them = us ^ 1;
                    d.res_after[them] = reserve_bits(&pos.hand[them], pos.rb_count[them] - 1);
                }
            }
            d.on = (code, to);
            if type_of(code) == KING {
                d.king_moved[us] = true;
                ksq[us] = to;
            }
        }
        self.top += 1;
        self.entry(self.top);
        let e = &mut self.stack[self.top];
        e.delta = d;
        e.ksq = ksq;
        e.computed = [false; 2];
    }

    pub fn pop(&mut self) {
        self.top = self.top.saturating_sub(1);
    }
}
