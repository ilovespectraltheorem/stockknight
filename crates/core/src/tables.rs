//! Move tables and Zobrist keys, built once. Every list is in the same order as in
//! `reference/engine.js`, since that order fixes the move generation order.

use std::sync::OnceLock;

use crate::{far_rank, file_of, in_enemy_half, rank_of, BISHOP, BLACK, PAWN, ROOK, WHITE};

pub struct Tables {
    pub knight: Vec<Vec<u8>>,
    pub king: Vec<Vec<u8>>,
    pub diag: Vec<Vec<Vec<u8>>>,
    pub ortho: Vec<Vec<Vec<u8>>>,
    /// `pawn_steps[color][sq]`: forward, then left, then right (sideways only in the enemy half).
    pub pawn_steps: [Vec<Vec<u8>>; 2],
    /// `pawn_attackers[color][sq]`: squares from which a pawn of `color` attacks `sq`.
    pub pawn_attackers: [Vec<Vec<u8>>; 2],
    pub piece_lo: [u32; 16 * 36],
    pub piece_hi: [u32; 16 * 36],
    pub hand_lo: [u32; 2 * 7 * 3],
    pub hand_hi: [u32; 2 * 7 * 3],
    pub side_lo: u32,
    pub side_hi: u32,
}

pub fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(build)
}

fn on_board(f: i32, r: i32) -> bool {
    (0..6).contains(&f) && (0..6).contains(&r)
}

fn jumps(deltas: &[(i32, i32)]) -> Vec<Vec<u8>> {
    (0..36u8)
        .map(|sq| {
            let (f0, r0) = (file_of(sq) as i32, rank_of(sq) as i32);
            deltas
                .iter()
                .map(|&(df, dr)| (f0 + df, r0 + dr))
                .filter(|&(f, r)| on_board(f, r))
                .map(|(f, r)| (r * 6 + f) as u8)
                .collect()
        })
        .collect()
}

fn rays(dirs: &[(i32, i32)]) -> Vec<Vec<Vec<u8>>> {
    (0..36u8)
        .map(|sq| {
            let mut out = Vec::new();
            for &(df, dr) in dirs {
                let mut ray = Vec::new();
                let (mut f, mut r) = (file_of(sq) as i32 + df, rank_of(sq) as i32 + dr);
                while on_board(f, r) {
                    ray.push((r * 6 + f) as u8);
                    f += df;
                    r += dr;
                }
                if !ray.is_empty() {
                    out.push(ray);
                }
            }
            out
        })
        .collect()
}

fn pawn_steps(color: u8) -> Vec<Vec<u8>> {
    (0..36u8)
        .map(|sq| {
            let mut list = Vec::new();
            let (f, r) = (file_of(sq) as i32, rank_of(sq) as i32);
            let fr = r + if color == WHITE { 1 } else { -1 };
            if (0..6).contains(&fr) && fr != far_rank(color) as i32 {
                list.push((fr * 6 + f) as u8);
            }
            if in_enemy_half(color, r as u8) && r != far_rank(color) as i32 {
                if f > 0 {
                    list.push((r * 6 + f - 1) as u8);
                }
                if f < 5 {
                    list.push((r * 6 + f + 1) as u8);
                }
            }
            list
        })
        .collect()
}

/// mulberry32, as in the reference engine.
struct Mulberry32(u32);

impl Mulberry32 {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        t ^ (t >> 14)
    }
}

fn build() -> Tables {
    let knight = jumps(&[
        (1, 2),
        (2, 1),
        (2, -1),
        (1, -2),
        (-1, -2),
        (-2, -1),
        (-2, 1),
        (-1, 2),
    ]);
    let king = jumps(&[
        (0, 1),
        (1, 1),
        (1, 0),
        (1, -1),
        (0, -1),
        (-1, -1),
        (-1, 0),
        (-1, 1),
    ]);
    let diag = rays(&[(1, 1), (1, -1), (-1, -1), (-1, 1)]);
    let ortho = rays(&[(0, 1), (1, 0), (0, -1), (-1, 0)]);
    let pawn_steps = [pawn_steps(WHITE), pawn_steps(BLACK)];
    let pawn_attackers = [WHITE, BLACK].map(|c| {
        let mut table = vec![Vec::new(); 36];
        for sq in 0..36u8 {
            for &to in &pawn_steps[c as usize][sq as usize] {
                table[to as usize].push(sq);
            }
        }
        table
    });

    // Order: piece code 0..15 × square; color × drop type (P, B, R) × count 0..2; side.
    let mut rng = Mulberry32(0x6c_6573);
    let mut piece_lo = [0; 16 * 36];
    let mut piece_hi = [0; 16 * 36];
    for i in 0..16 * 36 {
        piece_lo[i] = rng.next();
        piece_hi[i] = rng.next();
    }
    let mut hand_lo = [0; 2 * 7 * 3];
    let mut hand_hi = [0; 2 * 7 * 3];
    for c in 0..2 {
        for t in [PAWN, BISHOP, ROOK] {
            for n in 0..3 {
                let i = (c * 7 + t as usize) * 3 + n;
                hand_lo[i] = rng.next();
                hand_hi[i] = rng.next();
            }
        }
    }
    let side_lo = rng.next();
    let side_hi = rng.next();

    Tables {
        knight,
        king,
        diag,
        ortho,
        pawn_steps,
        pawn_attackers,
        piece_lo,
        piece_hi,
        hand_lo,
        hand_hi,
        side_lo,
        side_hi,
    }
}
