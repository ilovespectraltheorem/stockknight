//! Network inputs, per perspective (the side whose view they take):
//!
//! - **Board, 14,256** = 36 king squares × 11 piece kinds × 36 squares:
//!   `king_sq × 396 + kind × 36 + sq`, squares seen from that side (Black's rotated: `35 − sq`).
//!   Kinds 0–4 are the perspective's own pawn, knight, bishop, rook, queen; 5–10 the opponent's
//!   pawn, knight, bishop, rook, queen, king. The perspective's own king is the king square.
//! - **Reserves, 10**: own (14,256–14,260) then opponent (14,261–14,265): at least one pawn in
//!   hand, two pawns, a rook, a bishop, and "a rook or bishop drop is allowed" (fewer than 2 on
//!   the board).
//!
//! A position and its 180°-rotated, colour-swapped mirror have identical inputs.

use sk_core::*;

pub const BOARD_FEATURES: usize = 36 * 11 * 36;
pub const NUM_FEATURES: usize = BOARD_FEATURES + 10;
/// At most 35 pieces besides the own king, plus 10 reserve inputs.
pub const MAX_ACTIVE: usize = 45;

const fn orient(perspective: u8, sq: u8) -> usize {
    if perspective == WHITE {
        sq as usize
    } else {
        35 - sq as usize
    }
}

/// Active inputs for `perspective`: board inputs in ascending order, then reserve inputs.
pub fn active_features(pos: &Position, perspective: u8) -> Vec<u32> {
    let mut out = Vec::with_capacity(MAX_ACTIVE);
    let ksq = orient(perspective, pos.king_sq[perspective as usize]);
    for sq in 0..36u8 {
        let code = pos.board[sq as usize];
        if code == 0 {
            continue;
        }
        let (color, kind) = (color_of(code), type_of(code));
        if color == perspective && kind == KING {
            continue;
        }
        let k = if color == perspective {
            kind - 1
        } else {
            5 + kind - 1
        } as usize;
        out.push((ksq * 396 + k * 36 + orient(perspective, sq)) as u32);
    }
    out.sort_unstable();
    for (i, color) in [perspective, perspective ^ 1].into_iter().enumerate() {
        let base = (BOARD_FEATURES + 5 * i) as u32;
        let hand = &pos.hand[color as usize];
        if hand[PAWN as usize] >= 1 {
            out.push(base);
        }
        if hand[PAWN as usize] >= 2 {
            out.push(base + 1);
        }
        if hand[ROOK as usize] >= 1 {
            out.push(base + 2);
        }
        if hand[BISHOP as usize] >= 1 {
            out.push(base + 3);
        }
        if pos.rb_count[color as usize] < 2 {
            out.push(base + 4);
        }
    }
    out
}

/// The 180°-rotated, colour-swapped position (side to move swapped too).
pub fn mirror(pos: &Position) -> Position {
    let mut rows = Vec::new();
    for rank in (0..6).rev() {
        let mut row = String::new();
        let mut empty = 0;
        for file in 0..6 {
            let sq = 35 - (rank * 6 + file);
            let code = pos.board[sq];
            if code == 0 {
                empty += 1;
                continue;
            }
            if empty > 0 {
                row.push_str(&empty.to_string());
                empty = 0;
            }
            row.push(PIECE_CHARS[(code ^ 8) as usize] as char);
        }
        if empty > 0 {
            row.push_str(&empty.to_string());
        }
        rows.push(row);
    }
    let mut reserves = String::new();
    for c in 0..2u8 {
        for kind in [PAWN, ROOK, BISHOP] {
            for _ in 0..pos.hand[(c ^ 1) as usize][kind as usize] {
                reserves.push(PIECE_CHARS[make_code(kind, c) as usize] as char);
            }
        }
    }
    if reserves.is_empty() {
        reserves.push('-');
    }
    let side = if pos.side == WHITE { 'b' } else { 'w' };
    Position::from_fen(&format!(
        "{}[{}] {side} {} 1",
        rows.join("/"),
        reserves,
        pos.clock
    ))
    .expect("mirror is legal")
}
