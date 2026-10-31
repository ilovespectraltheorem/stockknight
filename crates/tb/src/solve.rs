//! Retrograde solving of one table, given every table its captures and drops lead into.
//!
//! Positions are resolved in order of distance: level n holds exactly the positions decided in
//! n plies. A position is re-examined at level n only when something could have decided it:
//! one of its in-table successors was decided at level n − 1 (found by un-moving), or an
//! out-of-table successor (a capture or a drop) has distance n − 1. Re-examining runs every
//! legal move forward, so the result never depends on counting moves. Whatever is never
//! decided is a draw: neither side can force the game to end, so it ends by repetition.

use std::collections::BTreeMap;

use sk_core::{
    color_of, move_drop, move_to, type_of, Move, Position, BISHOP, KING, KNIGHT, PAWN, QUEEN, ROOK,
};

use crate::index::{load, scratch, Layout};
use crate::sig::Sig;
use crate::table::{Table, Tables, DRAW, INVALID};

/// Distance of a value, if it is decided.
fn dist(v: u16) -> Option<u32> {
    (v != DRAW && v != INVALID).then(|| v as u32 - 1)
}

/// What a set of child values says about the parent.
#[derive(Default)]
struct Summary {
    moves: usize,
    /// Shortest distance of a child that is lost for the opponent.
    min_loss: Option<u32>,
    /// Every child counted is a win for the opponent; longest such distance.
    all_win: bool,
    max_win: u32,
}

impl Summary {
    fn new() -> Self {
        Summary {
            all_win: true,
            ..Default::default()
        }
    }
    fn add(&mut self, v: u16) {
        self.moves += 1;
        match dist(v) {
            Some(d) if d % 2 == 0 => self.min_loss = Some(self.min_loss.map_or(d, |m| m.min(d))),
            Some(d) => self.max_win = self.max_win.max(d),
            None => self.all_win = false,
        }
    }
    /// The parent's distance if the children decide it.
    fn decided(&self) -> Option<u32> {
        match self.min_loss {
            Some(d) => Some(d + 1),
            None if self.moves > 0 && self.all_win => Some(self.max_win + 1),
            None => None,
        }
    }
}

pub struct Ctx {
    pub pos: Position,
    moves: Vec<Move>,
}

impl Ctx {
    pub fn new() -> Ctx {
        Ctx {
            pos: scratch(),
            moves: Vec::with_capacity(128),
        }
    }
}

impl Default for Ctx {
    fn default() -> Self {
        Self::new()
    }
}

/// Calls `f(value, in_table)` for every legal move of the loaded position. In-table values come
/// from `cur`, the rest from `tables`. Returns the number of legal moves.
fn for_children(
    ctx: &mut Ctx,
    sig: &Sig,
    layout: &Layout,
    cur: &[u16],
    tables: &Tables,
    want_in_table: bool,
    mut f: impl FnMut(u16, bool),
) -> usize {
    ctx.moves.clear();
    ctx.pos.gen_moves(&mut ctx.moves, false);
    let us = ctx.pos.side;
    let mut legal = 0;
    for i in 0..ctx.moves.len() {
        let m = ctx.moves[i];
        let drop = move_drop(m);
        let captured = if drop != 0 {
            0
        } else {
            ctx.pos.board[move_to(m) as usize]
        };
        let child = if drop != 0 {
            Some(sig.after_drop(us, drop))
        } else if captured != 0 {
            Some(sig.after_capture(us, type_of(captured)))
        } else {
            None
        };
        if child.is_none() && !want_in_table {
            // Only legality matters for an in-table move here.
            ctx.pos.make_move(m);
            let ok = !ctx.pos.in_check(us);
            ctx.pos.unmake_move();
            if ok {
                legal += 1;
                f(DRAW, true);
            }
            continue;
        }
        ctx.pos.make_move(m);
        if !ctx.pos.in_check(us) {
            legal += 1;
            let v = match child {
                None => cur[layout.index(&ctx.pos.board, ctx.pos.side) as usize],
                Some(s) => tables
                    .value(&s, &ctx.pos.board, ctx.pos.side)
                    .unwrap_or_else(|| panic!("{} needs {}", sig.name(), s.name())),
            };
            f(v, child.is_none());
        }
        ctx.pos.unmake_move();
    }
    legal
}

/// Run `f` over `items` on `threads` threads, each with its own context, collecting outputs.
fn par<T: Send, I: Sync>(
    items: &[I],
    threads: usize,
    f: impl Fn(&mut Ctx, &I, &mut Vec<T>) + Sync,
) -> Vec<T> {
    if items.is_empty() {
        return Vec::new();
    }
    let chunk = items.len().div_ceil(threads.max(1));
    std::thread::scope(|s| {
        let handles: Vec<_> = items
            .chunks(chunk)
            .map(|part| {
                let f = &f;
                s.spawn(move || {
                    let mut ctx = Ctx::new();
                    let mut out = Vec::new();
                    for it in part {
                        f(&mut ctx, it, &mut out);
                    }
                    out
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().expect("worker panicked"))
            .collect()
    })
}

/// In-table positions with the other side to move from which one quiet move reaches the loaded
/// position. Restores the position before returning.
fn predecessors(pos: &mut Position, layout: &Layout, out: &mut Vec<u64>) {
    let t = sk_core::tables::tables();
    let c = pos.side;
    let m = c ^ 1;
    for sq in 0..36u8 {
        let code = pos.board[sq as usize];
        if code == 0 || color_of(code) != m {
            continue;
        }
        let kind = type_of(code);
        let mut origins: [u8; 36] = [0; 36];
        let mut n = 0;
        let mut add = |f: u8, n: &mut usize| {
            origins[*n] = f;
            *n += 1;
        };
        let b = &pos.board;
        match kind {
            PAWN => t.pawn_attackers[m as usize][sq as usize]
                .iter()
                .for_each(|&f| {
                    if b[f as usize] == 0 {
                        add(f, &mut n)
                    }
                }),
            KNIGHT => t.knight[sq as usize].iter().for_each(|&f| {
                if b[f as usize] == 0 {
                    add(f, &mut n)
                }
            }),
            QUEEN | KING => t.king[sq as usize].iter().for_each(|&f| {
                if b[f as usize] == 0 {
                    add(f, &mut n)
                }
            }),
            BISHOP | ROOK => {
                let rays = if kind == BISHOP {
                    &t.diag[sq as usize]
                } else {
                    &t.ortho[sq as usize]
                };
                for ray in rays {
                    for &f in ray {
                        if b[f as usize] != 0 {
                            break;
                        }
                        add(f, &mut n);
                    }
                }
            }
            _ => unreachable!(),
        }
        for &f in &origins[..n] {
            pos.board[sq as usize] = 0;
            pos.board[f as usize] = code;
            if kind == KING {
                pos.king_sq[m as usize] = f;
            }
            if !pos.in_check(c) {
                out.push(layout.index(&pos.board, m));
            }
            pos.board[f as usize] = 0;
            pos.board[sq as usize] = code;
            if kind == KING {
                pos.king_sq[m as usize] = sq;
            }
        }
    }
}

pub struct Stats {
    pub valid: u64,
    pub wins: u64,
    pub losses: u64,
    pub draws: u64,
    pub longest: u32,
}

pub fn stats(t: &Table) -> Stats {
    let mut s = Stats {
        valid: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        longest: 0,
    };
    for &v in &t.data {
        match v {
            INVALID => continue,
            DRAW => s.draws += 1,
            _ if (v - 1) % 2 == 1 => s.wins += 1,
            _ => s.losses += 1,
        }
        s.valid += 1;
        if v != DRAW {
            s.longest = s.longest.max(v as u32 - 1);
        }
    }
    s
}

/// Solve the table for `sig`. Every table a capture or drop leads to must be in `tables`.
pub fn solve(sig: Sig, tables: &Tables, threads: usize) -> Table {
    let layout = Layout::new(sig);
    let size = layout.size as usize;
    let mut data = vec![DRAW; size];
    let threads = threads.max(1);

    // Pass 1: mark invalid indices, decide positions with no legal move, and register each
    // position at the levels its out-of-table moves could decide it.
    let chunk = size.div_ceil(threads);
    let (level0, regs): (Vec<u64>, Vec<(u32, u64)>) = std::thread::scope(|s| {
        let handles: Vec<_> = data
            .chunks_mut(chunk)
            .enumerate()
            .map(|(ci, part)| {
                let layout = &layout;
                s.spawn(move || {
                    let mut ctx = Ctx::new();
                    let (mut zero, mut regs) = (Vec::new(), Vec::new());
                    let empty: [u16; 0] = [];
                    for (j, slot) in part.iter_mut().enumerate() {
                        let idx = (ci * chunk + j) as u64;
                        let Some((board, side)) = layout.decode(idx) else {
                            *slot = INVALID;
                            continue;
                        };
                        load(&mut ctx.pos, &sig, &board, side);
                        if ctx.pos.in_check(side ^ 1) {
                            *slot = INVALID;
                            continue;
                        }
                        if sig.bare() {
                            continue;
                        }
                        let mut ext = Summary::new();
                        let legal = for_children(
                            &mut ctx,
                            &sig,
                            layout,
                            &empty,
                            tables,
                            false,
                            |v, inside| {
                                if !inside {
                                    ext.add(v)
                                }
                            },
                        );
                        if legal == 0 {
                            *slot = 1;
                            zero.push(idx);
                            continue;
                        }
                        if let Some(d) = ext.min_loss {
                            regs.push((d + 1, idx));
                        }
                        if ext.moves > 0 && ext.all_win {
                            regs.push((ext.max_win + 1, idx));
                        }
                    }
                    (zero, regs)
                })
            })
            .collect();
        let mut zero = Vec::new();
        let mut regs = Vec::new();
        for h in handles {
            let (z, r) = h.join().expect("worker panicked");
            zero.extend(z);
            regs.extend(r);
        }
        (zero, regs)
    });
    let mut buckets: BTreeMap<u32, Vec<u64>> = BTreeMap::new();
    for (lvl, idx) in regs {
        buckets.entry(lvl).or_default().push(idx);
    }

    // Levels 1, 2, ...
    let mut last = level0;
    let mut n = 1u32;
    loop {
        let mut cands: Vec<u64> = par(&last, threads, |ctx, &idx, out| {
            let (board, side) = layout.decode(idx).expect("decided position is valid");
            load(&mut ctx.pos, &sig, &board, side);
            predecessors(&mut ctx.pos, &layout, out);
        });
        if let Some(b) = buckets.remove(&n) {
            cands.extend(b);
        }
        if cands.is_empty() && buckets.is_empty() {
            break;
        }
        cands.sort_unstable();
        cands.dedup();
        cands.retain(|&i| data[i as usize] == DRAW);
        let cur = &data;
        let decided: Vec<u64> = par(&cands, threads, |ctx, &idx, out| {
            let (board, side) = layout.decode(idx).expect("candidate is valid");
            load(&mut ctx.pos, &sig, &board, side);
            let mut all = Summary::new();
            for_children(ctx, &sig, &layout, cur, tables, true, |v, _| all.add(v));
            // An out-of-table successor can decide a position later than this level; it is
            // registered for that level and comes back then.
            if let Some(d) = all.decided() {
                assert!(
                    d >= n,
                    "{} index {idx}: distance {d} found only on level {n}",
                    sig.name()
                );
                if d == n {
                    out.push(idx);
                }
            }
        });
        assert!(n < INVALID as u32 - 1, "distance overflow");
        for &i in &decided {
            data[i as usize] = (n + 1) as u16;
        }
        last = decided;
        n += 1;
    }
    Table { layout, data }
}

/// Check every position of a solved table against its successors: a win at distance d has a
/// move to a loss at d − 1 and none to a shorter loss; a loss at d has only moves to wins, the
/// longest at d − 1 (d = 0: no legal move); a draw has no move to a loss and some move to a
/// draw. Returns the first failure.
pub fn check(table: &Table, tables: &Tables, threads: usize) -> Result<u64, String> {
    let sig = table.sig();
    let layout = &table.layout;
    let ids: Vec<u64> = (0..layout.size)
        .filter(|&i| table.data[i as usize] != INVALID)
        .collect();
    let errors: Vec<String> = par(&ids, threads, |ctx, &idx, out| {
        if !out.is_empty() {
            return;
        }
        let (board, side) = layout.decode(idx).expect("valid");
        load(&mut ctx.pos, &sig, &board, side);
        if ctx.pos.in_check(side ^ 1) {
            out.push(format!(
                "{} {idx}: stored as valid but the side not to move is in check",
                sig.name()
            ));
            return;
        }
        let v = table.data[idx as usize];
        if sig.bare() {
            if v != DRAW {
                out.push(format!("{} {idx}: bare kings not a draw", sig.name()));
            }
            return;
        }
        let mut all = Summary::new();
        let legal = for_children(ctx, &sig, layout, &table.data, tables, true, |cv, _| {
            all.add(cv)
        });
        let expect = if legal == 0 { Some(0) } else { all.decided() };
        let got = dist(v);
        if expect != got {
            out.push(format!(
                "{} {idx} ({}): stored {got:?}, successors give {expect:?}",
                sig.name(),
                ctx.pos.to_fen()
            ));
        }
    });
    match errors.into_iter().next() {
        Some(e) => Err(e),
        None => Ok(ids.len() as u64),
    }
}
