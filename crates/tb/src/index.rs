//! Indexing: positions of one signature to numbers 0..size and back.
//!
//! The rules are symmetric under a left-right mirror, so the white king always stands on files
//! a–c (18 squares). Index = side to move, white king, black king, then for each group of
//! identical pieces the rank of its set of squares (combinatorial number system). Index values
//! that do not decode to a legal position (two pieces on a square, a pawn on its far rank, the
//! side not to move in check) are marked invalid in the table.

use sk_core::{
    color_of, far_rank, file_of, make_code, rank_of, type_of, Position, BISHOP, KING, PAWN, ROOK,
};

use crate::sig::{Sig, TYPES};

pub const MAX_GROUP: usize = 8;

/// `binom[n][k]` for n ≤ 36, k ≤ 8.
fn binom(n: usize, k: usize) -> u64 {
    static TABLE: std::sync::OnceLock<[[u64; 9]; 37]> = std::sync::OnceLock::new();
    let t = TABLE.get_or_init(|| {
        let mut t = [[0u64; 9]; 37];
        for n in 0..37 {
            t[n][0] = 1;
            for k in 1..9 {
                t[n][k] = if n == 0 {
                    0
                } else {
                    t[n - 1][k - 1] + t[n - 1][k]
                };
            }
        }
        t
    });
    t[n][k]
}

pub const fn mirror(sq: u8) -> u8 {
    rank_of(sq) * 6 + 5 - file_of(sq)
}

/// Rank of a sorted set of squares.
fn rank_set(sqs: &[u8]) -> u64 {
    sqs.iter()
        .enumerate()
        .map(|(i, &s)| binom(s as usize, i + 1))
        .sum()
}

/// The sorted set of `k` squares with rank `r`.
fn unrank_set(mut r: u64, k: usize, out: &mut [u8]) {
    for i in (1..=k).rev() {
        let mut s = i - 1;
        while binom(s + 1, i) <= r {
            s += 1;
        }
        r -= binom(s, i);
        out[i - 1] = s as u8;
    }
}

#[derive(Clone, Debug)]
pub struct Layout {
    pub sig: Sig,
    /// Board groups: (piece code, count), in a fixed order.
    pub groups: Vec<(u8, usize)>,
    /// Group number of each piece code, or u8::MAX.
    group_of: [u8; 16],
    radix: Vec<u64>,
    pub size: u64,
}

impl Layout {
    pub fn new(sig: Sig) -> Layout {
        let mut groups = Vec::new();
        let mut group_of = [u8::MAX; 16];
        for c in 0..2u8 {
            for t in TYPES {
                let k = sig.board[c as usize][t as usize] as usize;
                if k > 0 {
                    group_of[make_code(t, c) as usize] = groups.len() as u8;
                    groups.push((make_code(t, c), k));
                }
            }
        }
        let radix: Vec<u64> = groups.iter().map(|&(_, k)| binom(36, k)).collect();
        let size = 2 * 18 * 36 * radix.iter().product::<u64>();
        Layout {
            sig,
            groups,
            group_of,
            radix,
            size,
        }
    }

    /// The index of a board (any orientation) with `side` to move. The board must hold
    /// exactly this layout's material.
    pub fn index(&self, board: &[u8; 36], side: u8) -> u64 {
        let mut wk = 0;
        for (sq, &c) in board.iter().enumerate() {
            if c == make_code(KING, 0) {
                wk = sq as u8;
            }
        }
        let flip = file_of(wk) >= 3;
        let fix = |sq: u8| if flip { mirror(sq) } else { sq };
        let mut sqs = [[0u8; MAX_GROUP]; 10];
        let mut fill = [0usize; 10];
        let mut bk = 0;
        for (sq, &c) in board.iter().enumerate() {
            if c == 0 {
                continue;
            }
            if c == make_code(KING, 1) {
                bk = fix(sq as u8);
            } else if type_of(c) != KING {
                let g = self.group_of[c as usize] as usize;
                sqs[g][fill[g]] = fix(sq as u8);
                fill[g] += 1;
            }
        }
        let wk = fix(wk);
        let mut idx = (side as u64 * 18 + (rank_of(wk) * 3 + file_of(wk)) as u64) * 36 + bk as u64;
        for (g, &(_, k)) in self.groups.iter().enumerate() {
            let set = &mut sqs[g][..k];
            set.sort_unstable();
            idx = idx * self.radix[g] + rank_set(set);
        }
        idx
    }

    /// The board and side to move for `idx`, or None when two pieces share a square or a pawn
    /// stands on its far rank. Legality of check is not tested here.
    pub fn decode(&self, mut idx: u64) -> Option<([u8; 36], u8)> {
        let mut board = [0u8; 36];
        let mut sets = [[0u8; MAX_GROUP]; 10];
        for g in (0..self.groups.len()).rev() {
            let r = idx % self.radix[g];
            idx /= self.radix[g];
            unrank_set(r, self.groups[g].1, &mut sets[g]);
        }
        let bk = (idx % 36) as u8;
        idx /= 36;
        let wk18 = (idx % 18) as u8;
        let side = (idx / 18) as u8;
        let wk = (wk18 / 3) * 6 + wk18 % 3;
        if wk == bk {
            return None;
        }
        board[wk as usize] = make_code(KING, 0);
        board[bk as usize] = make_code(KING, 1);
        for (g, &(code, k)) in self.groups.iter().enumerate() {
            for &sq in &sets[g][..k] {
                if board[sq as usize] != 0 {
                    return None;
                }
                if type_of(code) == PAWN && rank_of(sq) == far_rank(color_of(code)) {
                    return None;
                }
                board[sq as usize] = code;
            }
        }
        Some((board, side))
    }
}

/// Put a board, this signature's reserves and the side to move into a scratch position.
pub fn load(pos: &mut Position, sig: &Sig, board: &[u8; 36], side: u8) {
    pos.board = *board;
    pos.hand = sig.hand;
    pos.side = side;
    pos.pawn_file = [[0; 6]; 2];
    pos.rb_count = [0; 2];
    for (sq, &c) in board.iter().enumerate() {
        if c == 0 {
            continue;
        }
        let (col, t) = (color_of(c) as usize, type_of(c));
        match t {
            PAWN => pos.pawn_file[col][file_of(sq as u8) as usize] += 1,
            BISHOP | ROOK => pos.rb_count[col] += 1,
            KING => pos.king_sq[col] = sq as u8,
            _ => {}
        }
    }
}

/// A scratch position to load boards into.
pub fn scratch() -> Position {
    Position::from_fen("k5/6/6/6/6/5K[-] w 0 1").expect("valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sig::all_sigs;

    #[test]
    fn sets_round_trip() {
        for k in 1..=4 {
            let mut out = [0u8; MAX_GROUP];
            for r in (0..binom(36, k)).step_by(7) {
                unrank_set(r, k, &mut out);
                assert!(out[..k].windows(2).all(|w| w[0] < w[1]));
                assert_eq!(rank_set(&out[..k]), r);
            }
        }
    }

    /// Every index of every signature up to 4 pieces decodes and encodes back to itself.
    #[test]
    fn index_round_trip() {
        let mut checked = 0u64;
        for sig in all_sigs(4) {
            let l = Layout::new(sig);
            for idx in 0..l.size {
                if let Some((board, side)) = l.decode(idx) {
                    assert_eq!(l.index(&board, side), idx, "{}", sig.name());
                    let mut m = [0u8; 36];
                    for sq in 0..36u8 {
                        m[mirror(sq) as usize] = board[sq as usize];
                    }
                    assert_eq!(l.index(&m, side), idx, "{} mirrored", sig.name());
                    checked += 1;
                }
            }
        }
        assert!(checked > 1_000_000);
    }
}
