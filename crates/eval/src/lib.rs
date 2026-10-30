//! The evaluator interface and G0, the hand-written evaluation (an exact port of
//! `evaluate` in `reference/engine.js`).

use sk_core::tables::tables;
use sk_core::*;

pub trait Evaluator: Send {
    /// A search starts from `pos`.
    fn reset(&mut self, _pos: &Position) {}
    /// Called before every `make_move`.
    fn make(&mut self, _pos: &Position, _m: Move) {}
    /// Called after every `unmake_move`.
    fn unmake(&mut self) {}
    /// Centipawns from the side to move's view.
    fn evaluate(&mut self, pos: &Position) -> i32;
    fn name(&self) -> &'static str;
}

#[derive(Clone, Copy, Default)]
pub struct HandEval;

impl Evaluator for HandEval {
    fn evaluate(&mut self, pos: &Position) -> i32 {
        hand_eval(pos)
    }
    fn name(&self) -> &'static str {
        "G0"
    }
}

pub const VALUE: [i32; 7] = [0, 100, 290, 300, 450, 320, 0];

#[rustfmt::skip]
const PST: [[i32; 36]; 6] = [
    [0; 36],
    // pawn: worth more once across the middle line; rank 6 is never reached
    [
        0, 0, 0, 0, 0, 0,
        0, 2, 4, 4, 2, 0,
        4, 8, 12, 12, 8, 4,
        18, 24, 28, 28, 24, 18,
        26, 32, 36, 36, 32, 26,
        0, 0, 0, 0, 0, 0,
    ],
    // knight
    [
        -30, -16, -10, -10, -16, -30,
        -16, 0, 8, 8, 0, -16,
        -10, 8, 18, 18, 8, -10,
        -10, 8, 18, 18, 8, -10,
        -16, 0, 8, 8, 0, -16,
        -30, -16, -10, -10, -16, -30,
    ],
    // bishop
    [
        -8, -4, -4, -4, -4, -8,
        -4, 4, 2, 2, 4, -4,
        -4, 2, 6, 6, 2, -4,
        -4, 2, 6, 6, 2, -4,
        -4, 4, 2, 2, 4, -4,
        -8, -4, -4, -4, -4, -8,
    ],
    // rook
    [
        0, 0, 2, 2, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        8, 10, 10, 10, 10, 8,
        4, 4, 4, 4, 4, 4,
    ],
    // queen
    [
        -12, -6, -4, -4, -6, -12,
        -6, 0, 4, 4, 0, -6,
        -4, 4, 10, 10, 4, -4,
        -4, 4, 10, 10, 4, -4,
        -6, 0, 4, 4, 0, -6,
        -12, -6, -4, -4, -6, -12,
    ],
];

#[rustfmt::skip]
const KING_MIDDLE: [i32; 36] = [
    8, 12, 4, 4, 12, 8,
    0, 0, -8, -8, 0, 0,
    -16, -20, -24, -24, -20, -16,
    -28, -32, -36, -36, -32, -28,
    -36, -40, -44, -44, -40, -36,
    -40, -44, -48, -48, -44, -40,
];

#[rustfmt::skip]
const KING_END: [i32; 36] = [
    -20, -10, -6, -6, -10, -20,
    -10, 0, 6, 6, 0, -10,
    -6, 6, 14, 14, 6, -6,
    -6, 6, 14, 14, 6, -6,
    -10, 0, 6, 6, 0, -10,
    -20, -10, -6, -6, -10, -20,
];

const PHASE_WEIGHT: [i32; 7] = [0, 0, 1, 1, 2, 1, 0];
const PHASE_MAX: i32 = 2 * (2 + 1 + 2 + 1) + 2 * (1 + 2);

/// JavaScript's `Math.round(num / den)` for `den > 0`: rounds halves up.
fn js_round(num: i32, den: i32) -> i32 {
    (2 * num + den).div_euclid(2 * den)
}

pub fn hand_eval(pos: &Position) -> i32 {
    let t = tables();
    let b = &pos.board;
    let mut score = [0i32; 2];
    let mut phase = 0;

    for sq in 0..36u8 {
        let code = b[sq as usize];
        if code == 0 {
            continue;
        }
        let (color, kind) = (color_of(code), type_of(code));
        let rel = if color == WHITE { sq } else { 35 - sq } as usize;
        phase += PHASE_WEIGHT[kind as usize];
        if kind == KING {
            continue;
        }
        score[color as usize] += VALUE[kind as usize] + PST[kind as usize][rel];
        if kind == BISHOP || kind == ROOK {
            let rays = if kind == BISHOP {
                &t.diag[sq as usize]
            } else {
                &t.ortho[sq as usize]
            };
            let mut mobility = 0;
            for ray in rays {
                for &s in ray {
                    let c = b[s as usize];
                    if c != 0 && color_of(c) == color {
                        break;
                    }
                    mobility += 1;
                    if c != 0 {
                        break;
                    }
                }
            }
            score[color as usize] += 4 * mobility;
        }
    }

    for c in 0..2 {
        let hand = &pos.hand[c];
        let (p, bi, r) = (
            hand[PAWN as usize] as i32,
            hand[BISHOP as usize] as i32,
            hand[ROOK as usize] as i32,
        );
        phase += PHASE_WEIGHT[BISHOP as usize] * bi + PHASE_WEIGHT[ROOK as usize] * r;
        if p > 0 {
            let free_files = pos.pawn_file[c].iter().filter(|&&n| n == 0).count() as i32;
            score[c] += p * if free_files >= p { 90 } else { 50 };
        }
        let open = pos.rb_count[c] < 2;
        score[c] += bi * if open { 270 } else { 210 } + r * if open { 410 } else { 320 };
    }

    let phase = phase.min(PHASE_MAX);
    for c in 0..2u8 {
        let ksq = pos.king_sq[c as usize];
        let rel = if c == WHITE { ksq } else { 35 - ksq } as usize;
        score[c as usize] += js_round(
            KING_MIDDLE[rel] * phase + KING_END[rel] * (PHASE_MAX - phase),
            PHASE_MAX,
        );
        let shelter = t.king[ksq as usize]
            .iter()
            .filter(|&&s| b[s as usize] != 0 && color_of(b[s as usize]) == c)
            .count() as i32;
        score[c as usize] += js_round(6 * shelter * phase, PHASE_MAX);
    }

    let us = pos.side as usize;
    score[us] - score[us ^ 1] + 8
}
