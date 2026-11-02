//! KnightChess rules (docs/RULES.md), an exact port of `reference/engine.js`.

mod position;
pub mod tables;

pub use position::{DrawReason, Outcome, Position, WinReason};

pub const RULESET: &str = "knightchess-2";
pub const START_FEN: &str = "rnkqnb/pppppp/6/6/PPPPPP/BNQKNR[PPRBpprb] w 0 1";

pub const WHITE: u8 = 0;
pub const BLACK: u8 = 1;

pub const PAWN: u8 = 1;
pub const KNIGHT: u8 = 2;
pub const BISHOP: u8 = 3;
pub const ROOK: u8 = 4;
pub const QUEEN: u8 = 5;
pub const KING: u8 = 6;

pub const DROP_TYPES: [u8; 3] = [PAWN, BISHOP, ROOK];
pub const PIECE_CHARS: &[u8; 16] = b".PNBRQK..pnbrqk.";
/// Reserve limits per type: 2 pawns, 1 bishop, 1 rook.
pub const RESERVE_MAX: [u8; 7] = [0, 2, 0, 1, 1, 0, 0];

/// `to | from << 6 | drop_type << 12`; 0 is never a legal move.
pub type Move = u32;

pub const fn encode_move(from: u8, to: u8, drop: u8) -> Move {
    to as u32 | (from as u32) << 6 | (drop as u32) << 12
}
pub const fn move_to(m: Move) -> u8 {
    (m & 63) as u8
}
pub const fn move_from(m: Move) -> u8 {
    ((m >> 6) & 63) as u8
}
pub const fn move_drop(m: Move) -> u8 {
    (m >> 12) as u8
}

pub const fn file_of(sq: u8) -> u8 {
    sq % 6
}
pub const fn rank_of(sq: u8) -> u8 {
    sq / 6
}
pub const fn color_of(code: u8) -> u8 {
    code >> 3
}
pub const fn type_of(code: u8) -> u8 {
    code & 7
}
pub const fn make_code(piece_type: u8, color: u8) -> u8 {
    piece_type | color << 3
}

/// The opponent's back rank for `color`: pawns may not be dropped there.
pub const fn far_rank(color: u8) -> u8 {
    if color == WHITE {
        5
    } else {
        0
    }
}

/// Whether `rank` lies in the half of the board where pawns of `color` may step sideways.
pub const fn in_enemy_half(color: u8, rank: u8) -> bool {
    if color == WHITE {
        rank >= 3
    } else {
        rank <= 2
    }
}

pub fn sq_name(sq: u8) -> String {
    format!("{}{}", (b'a' + file_of(sq)) as char, rank_of(sq) + 1)
}

pub fn parse_sq(s: &str) -> Option<u8> {
    let b = s.as_bytes();
    if b.len() != 2 || !(b'a'..=b'f').contains(&b[0]) || !(b'1'..=b'6').contains(&b[1]) {
        return None;
    }
    Some((b[1] - b'1') * 6 + (b[0] - b'a'))
}
