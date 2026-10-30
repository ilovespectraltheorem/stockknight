//! The 24-byte training record.
//!
//! | Bytes | Field |
//! |---|---|
//! | 0–17 | Board: 36 squares × 4 bits (piece codes), square `2i` in the low nibble of byte `i` |
//! | 18 | Reserves: White pawns (2 bits), White rook (1), White bishop (1), then Black's the same |
//! | 19 | Bit 0: side to move. Bits 1–2: game result from White's view (0 Black won, 1 draw, 2 White won) |
//! | 20–21 | Search score, int16 little-endian, centipawns, side to move's view |
//! | 22–23 | Best move, engine encoding, little-endian |
//!
//! Files are plain concatenations of records.

use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::Path;

use sk_core::*;

pub const RECORD_SIZE: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GameResult {
    BlackWon = 0,
    Draw = 1,
    WhiteWon = 2,
}

impl GameResult {
    pub fn from_bits(b: u8) -> Self {
        match b {
            0 => GameResult::BlackWon,
            2 => GameResult::WhiteWon,
            _ => GameResult::Draw,
        }
    }

    /// 1, ½ or 0 for `color`.
    pub fn score_for(self, color: u8) -> f32 {
        let white = self as u8 as f32 / 2.0;
        if color == WHITE {
            white
        } else {
            1.0 - white
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Record(pub [u8; RECORD_SIZE]);

impl Record {
    pub fn encode(pos: &Position, score: i32, result: GameResult, best: Move) -> Self {
        let mut r = [0u8; RECORD_SIZE];
        for sq in 0..36 {
            r[sq / 2] |= pos.board[sq] << (4 * (sq % 2));
        }
        let mut hand = 0u8;
        for c in 0..2 {
            let h = &pos.hand[c];
            let bits = h[PAWN as usize] | h[ROOK as usize] << 2 | h[BISHOP as usize] << 3;
            hand |= bits << (4 * c);
        }
        r[18] = hand;
        r[19] = pos.side | (result as u8) << 1;
        r[20..22]
            .copy_from_slice(&(score.clamp(i16::MIN as i32, i16::MAX as i32) as i16).to_le_bytes());
        r[22..24].copy_from_slice(&(best as u16).to_le_bytes());
        Record(r)
    }

    pub fn set_result(&mut self, result: GameResult) {
        self.0[19] = (self.0[19] & 1) | (result as u8) << 1;
    }

    pub fn piece_at(&self, sq: usize) -> u8 {
        (self.0[sq / 2] >> (4 * (sq % 2))) & 15
    }

    /// Reserve count of `kind` (pawn, rook or bishop) for `color`.
    pub fn hand(&self, color: u8, kind: u8) -> u8 {
        let bits = self.0[18] >> (4 * color);
        match kind {
            PAWN => bits & 3,
            ROOK => (bits >> 2) & 1,
            BISHOP => (bits >> 3) & 1,
            _ => 0,
        }
    }

    pub fn side(&self) -> u8 {
        self.0[19] & 1
    }

    pub fn result(&self) -> GameResult {
        GameResult::from_bits((self.0[19] >> 1) & 3)
    }

    /// The game result for the side to move: 1, ½ or 0.
    pub fn stm_result(&self) -> f32 {
        self.result().score_for(self.side())
    }

    pub fn score(&self) -> i16 {
        i16::from_le_bytes([self.0[20], self.0[21]])
    }

    pub fn best_move(&self) -> Move {
        u16::from_le_bytes([self.0[22], self.0[23]]) as Move
    }

    /// The position as FEN (quiet-ply counter 0, move number 1).
    pub fn fen(&self) -> String {
        let mut rows = Vec::new();
        for rank in (0..6).rev() {
            let mut row = String::new();
            let mut empty = 0;
            for file in 0..6 {
                let code = self.piece_at(rank * 6 + file);
                if code == 0 {
                    empty += 1;
                    continue;
                }
                if empty > 0 {
                    row.push_str(&empty.to_string());
                    empty = 0;
                }
                row.push(PIECE_CHARS[code as usize] as char);
            }
            if empty > 0 {
                row.push_str(&empty.to_string());
            }
            rows.push(row);
        }
        let mut reserves = String::new();
        for c in 0..2u8 {
            for kind in [PAWN, ROOK, BISHOP] {
                for _ in 0..self.hand(c, kind) {
                    reserves.push(PIECE_CHARS[make_code(kind, c) as usize] as char);
                }
            }
        }
        if reserves.is_empty() {
            reserves.push('-');
        }
        format!(
            "{}[{}] {} 0 1",
            rows.join("/"),
            reserves,
            if self.side() == WHITE { 'w' } else { 'b' }
        )
    }

    pub fn position(&self) -> Result<Position, String> {
        Position::from_fen(&self.fen())
    }

    /// A 64-bit hash of the position only (board, reserves, side); labels are ignored.
    pub fn key(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for &b in &self.0[..19] {
            h = (h ^ b as u64).wrapping_mul(0x0100_0000_01b3);
        }
        h = (h ^ (self.0[19] & 1) as u64).wrapping_mul(0x0100_0000_01b3);
        h ^= h >> 33;
        h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
        h ^ (h >> 33)
    }
}

/// Streams records from a file.
pub struct RecordReader<R: Read> {
    inner: R,
}

impl RecordReader<BufReader<File>> {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        Ok(RecordReader {
            inner: BufReader::with_capacity(1 << 20, File::open(path)?),
        })
    }
}

impl<R: Read> Iterator for RecordReader<R> {
    type Item = io::Result<Record>;

    fn next(&mut self) -> Option<Self::Item> {
        let mut buf = [0u8; RECORD_SIZE];
        let mut filled = 0;
        while filled < RECORD_SIZE {
            match self.inner.read(&mut buf[filled..]) {
                Ok(0) if filled == 0 => return None,
                Ok(0) => {
                    return Some(Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "truncated record",
                    )))
                }
                Ok(n) => filled += n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Some(Err(e)),
            }
        }
        Some(Ok(Record(buf)))
    }
}

pub fn read_records(path: impl AsRef<Path>) -> io::Result<Vec<Record>> {
    RecordReader::open(path)?.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_position_layout() {
        let pos = Position::startpos();
        let r = Record::encode(&pos, 12, GameResult::WhiteWon, encode_move(1, 14, 0));
        assert_eq!(r.fen(), START_FEN);
        assert_eq!(r.piece_at(0), make_code(BISHOP, WHITE));
        assert_eq!(r.hand(WHITE, PAWN), 2);
        assert_eq!(r.hand(BLACK, ROOK), 1);
        assert_eq!(r.score(), 12);
        assert_eq!(r.best_move(), encode_move(1, 14, 0));
        assert_eq!(r.result(), GameResult::WhiteWon);
    }

    #[test]
    fn round_trip_random_games() {
        let mut seed = 99u32;
        for _ in 0..50 {
            let mut pos = Position::startpos();
            for ply in 0..120 {
                let moves = pos.legal_moves();
                if moves.is_empty() {
                    break;
                }
                seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
                let m = moves[(seed >> 8) as usize % moves.len()];
                let score = (seed as i32 % 3000) - 1500;
                let r = Record::encode(&pos, score, GameResult::from_bits((ply % 3) as u8), m);
                let back = r.position().unwrap();
                assert_eq!(back.board, pos.board);
                assert_eq!(back.hand, pos.hand);
                assert_eq!(back.side, pos.side);
                assert_eq!(r.score() as i32, score);
                assert_eq!(r.best_move(), m);
                pos.make_move(m);
            }
        }
    }

    #[test]
    fn key_ignores_labels_but_not_position() {
        let pos = Position::startpos();
        let a = Record::encode(&pos, 10, GameResult::Draw, 5);
        let b = Record::encode(&pos, -40, GameResult::BlackWon, 9);
        assert_eq!(a.key(), b.key());
        let other = Position::from_fen("rnkqnb/pppppp/6/6/PPPPPP/BNQKNR[PPRBpprb] b 0 1").unwrap();
        assert_ne!(
            a.key(),
            Record::encode(&other, 10, GameResult::Draw, 5).key()
        );
    }

    #[test]
    fn stm_result() {
        let black = Position::from_fen("rnkqnb/pppppp/6/6/PPPPPP/BNQKNR[PPRBpprb] b 0 1").unwrap();
        assert_eq!(
            Record::encode(&black, 0, GameResult::WhiteWon, 1).stm_result(),
            0.0
        );
        assert_eq!(
            Record::encode(&black, 0, GameResult::BlackWon, 1).stm_result(),
            1.0
        );
        assert_eq!(
            Record::encode(&black, 0, GameResult::Draw, 1).stm_result(),
            0.5
        );
    }
}
