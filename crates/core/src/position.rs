use crate::tables::tables;
use crate::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WinReason {
    Checkmate,
    Stalemate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawReason {
    Threefold,
    BareKings,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Ongoing,
    Win { winner: u8, reason: WinReason },
    Draw(DrawReason),
}

impl Outcome {
    /// The reference engine's status text: `ongoing`, `draw:threefold`, `win:w:checkmate`, …
    pub fn code(&self) -> String {
        match self {
            Outcome::Ongoing => "ongoing".into(),
            Outcome::Draw(DrawReason::Threefold) => "draw:threefold".into(),
            Outcome::Draw(DrawReason::BareKings) => "draw:bare kings".into(),
            Outcome::Win { winner, reason } => format!(
                "win:{}:{}",
                if *winner == WHITE { 'w' } else { 'b' },
                if *reason == WinReason::Checkmate {
                    "checkmate"
                } else {
                    "stalemate"
                }
            ),
        }
    }
}

#[derive(Clone, Debug)]
struct Undo {
    m: Move,
    captured: u8,
    clock: u32,
    lo: u32,
    hi: u32,
}

#[derive(Clone, Debug)]
pub struct Position {
    pub board: [u8; 36],
    pub hand: [[u8; 7]; 2],
    pub pawn_file: [[u8; 6]; 2],
    pub rb_count: [u8; 2],
    pub king_sq: [u8; 2],
    pub side: u8,
    /// Plies since the last capture, drop or forward pawn step.
    pub clock: u32,
    pub move_no: u32,
    pub hash_lo: u32,
    pub hash_hi: u32,
    undo: Vec<Undo>,
    keys_lo: Vec<u32>,
    keys_hi: Vec<u32>,
}

impl Default for Position {
    fn default() -> Self {
        Self::startpos()
    }
}

impl Position {
    pub fn startpos() -> Self {
        Self::from_fen(START_FEN).expect("start FEN is valid")
    }

    pub fn from_fen(fen: &str) -> Result<Self, String> {
        let bad = |what: &str| Err(format!("bad FEN: {what}: {fen}"));
        let parts: Vec<&str> = fen.split_whitespace().collect();
        if parts.len() != 4 {
            return bad("expected 4 fields");
        }
        let Some(open) = parts[0].find('[') else {
            return bad("board or reserves");
        };
        if open == 0 || !parts[0].ends_with(']') {
            return bad("board or reserves");
        }
        let rows_text = &parts[0][..open];
        let reserves = &parts[0][open + 1..parts[0].len() - 1];
        if reserves != "-" && !reserves.bytes().all(|c| b"PBRpbr".contains(&c)) {
            return bad("board or reserves");
        }
        let rows: Vec<&str> = rows_text.split('/').collect();
        if rows.len() != 6 {
            return bad("expected 6 ranks");
        }

        let mut pos = Position {
            board: [0; 36],
            hand: [[0; 7]; 2],
            pawn_file: [[0; 6]; 2],
            rb_count: [0; 2],
            king_sq: [u8::MAX; 2],
            side: WHITE,
            clock: 0,
            move_no: 1,
            hash_lo: 0,
            hash_hi: 0,
            undo: Vec::new(),
            keys_lo: Vec::new(),
            keys_hi: Vec::new(),
        };

        for (i, row) in rows.iter().enumerate() {
            let rank = 5 - i as u8;
            let mut file = 0u32;
            for ch in row.bytes() {
                if (b'1'..=b'6').contains(&ch) {
                    file += (ch - b'0') as u32;
                    continue;
                }
                let Some(code) = PIECE_CHARS.iter().position(|&c| c == ch) else {
                    return bad("unknown piece");
                };
                let code = code as u8;
                if code == 0 || ch == b'.' {
                    return bad("unknown piece");
                }
                if file > 5 {
                    return bad("rank too long");
                }
                let sq = rank * 6 + file as u8;
                let (color, kind) = (color_of(code), type_of(code));
                if kind == KING {
                    if pos.king_sq[color as usize] != u8::MAX {
                        return bad("two kings");
                    }
                    pos.king_sq[color as usize] = sq;
                }
                pos.board[sq as usize] = code;
                file += 1;
            }
            if file != 6 {
                return bad("wrong rank length");
            }
        }
        if pos.king_sq.contains(&u8::MAX) {
            return bad("missing king");
        }

        if reserves != "-" {
            for ch in reserves.bytes() {
                let code = PIECE_CHARS.iter().position(|&c| c == ch).unwrap() as u8;
                let (color, kind) = (color_of(code) as usize, type_of(code) as usize);
                pos.hand[color][kind] += 1;
                if pos.hand[color][kind] > RESERVE_MAX[kind] {
                    return bad("too many pieces in reserve");
                }
            }
        }

        pos.side = match parts[1] {
            "w" => WHITE,
            "b" => BLACK,
            _ => return bad("side"),
        };
        let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
        if !digits(parts[2]) || !digits(parts[3]) {
            return bad("counters");
        }
        pos.clock = parts[2]
            .parse()
            .map_err(|_| format!("bad FEN: counters: {fen}"))?;
        pos.move_no = parts[3]
            .parse::<u32>()
            .map_err(|_| format!("bad FEN: counters: {fen}"))?
            .max(1);

        for sq in 0..36u8 {
            let code = pos.board[sq as usize];
            if code == 0 {
                continue;
            }
            let (color, kind) = (color_of(code) as usize, type_of(code));
            if kind == PAWN {
                pos.pawn_file[color][file_of(sq) as usize] += 1;
            }
            if kind == BISHOP || kind == ROOK {
                pos.rb_count[color] += 1;
            }
        }

        pos.compute_hash();
        pos.keys_lo.push(pos.hash_lo);
        pos.keys_hi.push(pos.hash_hi);
        if pos.in_check(pos.side ^ 1) {
            return bad("the side not to move is in check");
        }
        Ok(pos)
    }

    pub fn compute_hash(&mut self) {
        let t = tables();
        let (mut lo, mut hi) = (0u32, 0u32);
        for sq in 0..36 {
            let code = self.board[sq] as usize;
            if code != 0 {
                lo ^= t.piece_lo[code * 36 + sq];
                hi ^= t.piece_hi[code * 36 + sq];
            }
        }
        for c in 0..2 {
            for kind in DROP_TYPES {
                let i = (c * 7 + kind as usize) * 3 + self.hand[c][kind as usize] as usize;
                lo ^= t.hand_lo[i];
                hi ^= t.hand_hi[i];
            }
        }
        if self.side == BLACK {
            lo ^= t.side_lo;
            hi ^= t.side_hi;
        }
        self.hash_lo = lo;
        self.hash_hi = hi;
    }

    /// The 64-bit position key (hi << 32 | lo).
    pub fn key(&self) -> u64 {
        (self.hash_hi as u64) << 32 | self.hash_lo as u64
    }

    pub fn to_fen(&self) -> String {
        let mut rows = Vec::new();
        for rank in (0..6).rev() {
            let mut row = String::new();
            let mut empty = 0;
            for file in 0..6 {
                let code = self.board[rank * 6 + file];
                if code == 0 {
                    empty += 1;
                    continue;
                }
                if empty > 0 {
                    row.push_str(&empty.to_string());
                }
                empty = 0;
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
                for _ in 0..self.hand[c as usize][kind as usize] {
                    reserves.push(PIECE_CHARS[make_code(kind, c) as usize] as char);
                }
            }
        }
        if reserves.is_empty() {
            reserves.push('-');
        }
        format!(
            "{}[{}] {} {} {}",
            rows.join("/"),
            reserves,
            if self.side == WHITE { 'w' } else { 'b' },
            self.clock,
            self.move_no
        )
    }

    // --- attacks ------------------------------------------------------------------------------

    /// Whether `sq` is attacked by a piece of color `by`. Kings attack their neighbours, so two
    /// kings can never stand next to each other.
    pub fn is_attacked(&self, sq: u8, by: u8) -> bool {
        let t = tables();
        let b = &self.board;
        let sq = sq as usize;
        let pawn = make_code(PAWN, by);
        if t.pawn_attackers[by as usize][sq]
            .iter()
            .any(|&s| b[s as usize] == pawn)
        {
            return true;
        }
        let knight = make_code(KNIGHT, by);
        if t.knight[sq].iter().any(|&s| b[s as usize] == knight) {
            return true;
        }
        let queen = make_code(QUEEN, by);
        let king = make_code(KING, by);
        if t.king[sq]
            .iter()
            .any(|&s| b[s as usize] == queen || b[s as usize] == king)
        {
            return true;
        }
        let bishop = make_code(BISHOP, by);
        for ray in &t.diag[sq] {
            if let Some(&s) = ray.iter().find(|&&s| b[s as usize] != 0) {
                if b[s as usize] == bishop {
                    return true;
                }
            }
        }
        let rook = make_code(ROOK, by);
        for ray in &t.ortho[sq] {
            if let Some(&s) = ray.iter().find(|&&s| b[s as usize] != 0) {
                if b[s as usize] == rook {
                    return true;
                }
            }
        }
        false
    }

    pub fn in_check(&self, color: u8) -> bool {
        self.is_attacked(self.king_sq[color as usize], color ^ 1)
    }

    /// Whether the side to move is in check.
    pub fn checked(&self) -> bool {
        self.in_check(self.side)
    }

    // --- move generation ----------------------------------------------------------------------

    /// Pseudo-legal moves in the reference order: board moves by square a1..f6, then drops by
    /// type (P, B, R) and square. `captures_only` skips quiet moves and drops.
    pub fn gen_moves(&self, list: &mut Vec<Move>, captures_only: bool) {
        let t = tables();
        let b = &self.board;
        let us = self.side;
        let them = us ^ 1;
        let target = |to: u8| -> bool {
            let code = b[to as usize];
            if code == 0 {
                return !captures_only;
            }
            color_of(code) == them && type_of(code) != KING
        };
        for from in 0..36u8 {
            let code = b[from as usize];
            if code == 0 || color_of(code) != us {
                continue;
            }
            let kind = type_of(code);
            let f = from as usize;
            match kind {
                PAWN => {
                    for &to in &t.pawn_steps[us as usize][f] {
                        if target(to) {
                            list.push(encode_move(from, to, 0));
                        }
                    }
                }
                KNIGHT => {
                    for &to in &t.knight[f] {
                        if target(to) {
                            list.push(encode_move(from, to, 0));
                        }
                    }
                }
                QUEEN | KING => {
                    for &to in &t.king[f] {
                        if target(to) {
                            list.push(encode_move(from, to, 0));
                        }
                    }
                }
                _ => {
                    let rays = if kind == BISHOP {
                        &t.diag[f]
                    } else {
                        &t.ortho[f]
                    };
                    for ray in rays {
                        for &to in ray {
                            if target(to) {
                                list.push(encode_move(from, to, 0));
                            }
                            if b[to as usize] != 0 {
                                break;
                            }
                        }
                    }
                }
            }
        }
        if captures_only {
            return;
        }

        let hand = &self.hand[us as usize];
        if hand[PAWN as usize] > 0 {
            for to in 0..36u8 {
                if b[to as usize] != 0 || self.pawn_file[us as usize][file_of(to) as usize] != 0 {
                    continue;
                }
                list.push(encode_move(0, to, PAWN));
            }
        }
        if self.rb_count[us as usize] < 2 {
            for kind in [BISHOP, ROOK] {
                if hand[kind as usize] == 0 {
                    continue;
                }
                for to in 0..36u8 {
                    if b[to as usize] == 0 {
                        list.push(encode_move(0, to, kind));
                    }
                }
            }
        }
    }

    pub fn legal_moves(&mut self) -> Vec<Move> {
        let mut list = Vec::with_capacity(64);
        self.gen_moves(&mut list, false);
        list.retain(|&m| {
            self.make_move(m);
            let ok = !self.in_check(self.side ^ 1);
            self.unmake_move();
            ok
        });
        list
    }

    pub fn has_legal_move(&mut self) -> bool {
        let mut list = Vec::with_capacity(64);
        self.gen_moves(&mut list, false);
        list.into_iter().any(|m| {
            self.make_move(m);
            let ok = !self.in_check(self.side ^ 1);
            self.unmake_move();
            ok
        })
    }

    // --- make / unmake ------------------------------------------------------------------------

    fn toggle_piece(&mut self, code: u8, sq: u8) {
        let t = tables();
        let i = code as usize * 36 + sq as usize;
        self.hash_lo ^= t.piece_lo[i];
        self.hash_hi ^= t.piece_hi[i];
    }

    fn toggle_hand(&mut self, color: u8, kind: u8) {
        let t = tables();
        let i = (color as usize * 7 + kind as usize) * 3
            + self.hand[color as usize][kind as usize] as usize;
        self.hash_lo ^= t.hand_lo[i];
        self.hash_hi ^= t.hand_hi[i];
    }

    fn remove_piece(&mut self, sq: u8) {
        let code = self.board[sq as usize];
        let (color, kind) = (color_of(code) as usize, type_of(code));
        self.toggle_piece(code, sq);
        self.board[sq as usize] = 0;
        if kind == PAWN {
            self.pawn_file[color][file_of(sq) as usize] -= 1;
        } else if kind == BISHOP || kind == ROOK {
            self.rb_count[color] -= 1;
        }
    }

    fn put_piece(&mut self, code: u8, sq: u8) {
        let (color, kind) = (color_of(code) as usize, type_of(code));
        self.toggle_piece(code, sq);
        self.board[sq as usize] = code;
        if kind == PAWN {
            self.pawn_file[color][file_of(sq) as usize] += 1;
        } else if kind == BISHOP || kind == ROOK {
            self.rb_count[color] += 1;
        } else if kind == KING {
            self.king_sq[color] = sq;
        }
    }

    /// The piece a board move captures (0 for none or a drop), read before the move is made.
    pub fn captured_by(&self, m: Move) -> u8 {
        if move_drop(m) != 0 {
            0
        } else {
            self.board[move_to(m) as usize]
        }
    }

    pub fn make_move(&mut self, m: Move) {
        let us = self.side;
        let (from, to, drop) = (move_from(m), move_to(m), move_drop(m));
        let mut entry = Undo {
            m,
            captured: 0,
            clock: self.clock,
            lo: self.hash_lo,
            hi: self.hash_hi,
        };
        if drop != 0 {
            self.toggle_hand(us, drop);
            self.hand[us as usize][drop as usize] -= 1;
            self.toggle_hand(us, drop);
            self.put_piece(make_code(drop, us), to);
            self.clock = 0;
        } else {
            let code = self.board[from as usize];
            let captured = self.board[to as usize];
            entry.captured = captured;
            if captured != 0 {
                self.remove_piece(to);
            }
            self.remove_piece(from);
            self.put_piece(code, to);
            let forward_pawn = type_of(code) == PAWN && file_of(from) == file_of(to);
            self.clock = if captured != 0 || forward_pawn {
                0
            } else {
                self.clock + 1
            };
        }
        let t = tables();
        self.side ^= 1;
        self.hash_lo ^= t.side_lo;
        self.hash_hi ^= t.side_hi;
        if us == BLACK {
            self.move_no += 1;
        }
        self.undo.push(entry);
        self.keys_lo.push(self.hash_lo);
        self.keys_hi.push(self.hash_hi);
    }

    pub fn unmake_move(&mut self) {
        let entry = self.undo.pop().expect("unmake without a move");
        self.keys_lo.pop();
        self.keys_hi.pop();
        self.side ^= 1;
        let us = self.side;
        if us == BLACK {
            self.move_no -= 1;
        }
        let (from, to, drop) = (move_from(entry.m), move_to(entry.m), move_drop(entry.m));
        if drop != 0 {
            self.remove_piece(to);
            self.hand[us as usize][drop as usize] += 1;
        } else {
            let code = self.board[to as usize];
            self.remove_piece(to);
            self.put_piece(code, from);
            if entry.captured != 0 {
                self.put_piece(entry.captured, to);
            }
        }
        self.clock = entry.clock;
        self.hash_lo = entry.lo;
        self.hash_hi = entry.hi;
    }

    /// Number of moves made since this position was set up.
    pub fn game_ply(&self) -> usize {
        self.undo.len()
    }

    /// The moves made since this position was set up, oldest first.
    pub fn moves_played(&self) -> Vec<Move> {
        self.undo.iter().map(|u| u.m).collect()
    }

    // --- game status --------------------------------------------------------------------------

    /// How often the current position has occurred, bounded by the quiet-ply counter.
    pub fn repetition_count(&self) -> u32 {
        let n = self.keys_lo.len() - 1;
        let (lo, hi) = (self.keys_lo[n], self.keys_hi[n]);
        let mut count = 1;
        let mut i = n as i64 - 2;
        while i >= 0 && (n as i64 - i) <= self.clock as i64 {
            if self.keys_lo[i as usize] == lo && self.keys_hi[i as usize] == hi {
                count += 1;
            }
            i -= 2;
        }
        count
    }

    /// Whether the current position occurred earlier within the last `plies` plies.
    pub fn repeats_within(&self, plies: u32) -> bool {
        let n = self.keys_lo.len() - 1;
        let (lo, hi) = (self.keys_lo[n], self.keys_hi[n]);
        let limit = plies.min(self.clock) as i64;
        let mut i = n as i64 - 2;
        while i >= 0 && (n as i64 - i) <= limit {
            if self.keys_lo[i as usize] == lo && self.keys_hi[i as usize] == hi {
                return true;
            }
            i -= 2;
        }
        false
    }

    pub fn bare_kings(&self) -> bool {
        self.board.iter().all(|&c| c == 0 || type_of(c) == KING)
            && self
                .hand
                .iter()
                .all(|h| DROP_TYPES.iter().all(|&k| h[k as usize] == 0))
    }

    pub fn outcome(&mut self) -> Outcome {
        if self.repetition_count() >= 3 {
            return Outcome::Draw(DrawReason::Threefold);
        }
        if self.bare_kings() {
            return Outcome::Draw(DrawReason::BareKings);
        }
        if !self.has_legal_move() {
            let reason = if self.checked() {
                WinReason::Checkmate
            } else {
                WinReason::Stalemate
            };
            return Outcome::Win {
                winner: self.side ^ 1,
                reason,
            };
        }
        Outcome::Ongoing
    }

    // --- notation -----------------------------------------------------------------------------

    pub fn move_to_uci(m: Move) -> String {
        let drop = move_drop(m);
        if drop != 0 {
            format!(
                "{}@{}",
                PIECE_CHARS[drop as usize] as char,
                sq_name(move_to(m))
            )
        } else {
            format!("{}{}", sq_name(move_from(m)), sq_name(move_to(m)))
        }
    }

    /// A legal move from its UCI text.
    pub fn move_from_uci(&mut self, text: &str) -> Option<Move> {
        self.legal_moves()
            .into_iter()
            .find(|&m| Self::move_to_uci(m) == text)
    }

    /// Scoresheet text for a legal move: `Nb1-c3`, `c4xc5`, `R@c4`, plus `+` or `#`.
    pub fn move_to_text(&mut self, m: Move) -> String {
        let (from, to, drop) = (move_from(m), move_to(m), move_drop(m));
        let mut text = if drop != 0 {
            format!("{}@{}", PIECE_CHARS[drop as usize] as char, sq_name(to))
        } else {
            let kind = type_of(self.board[from as usize]);
            let letter = if kind == PAWN {
                String::new()
            } else {
                (PIECE_CHARS[kind as usize] as char).to_string()
            };
            let sep = if self.board[to as usize] != 0 {
                'x'
            } else {
                '-'
            };
            format!("{letter}{}{sep}{}", sq_name(from), sq_name(to))
        };
        self.make_move(m);
        if !self.has_legal_move() {
            text.push('#');
        } else if self.checked() {
            text.push('+');
        }
        self.unmake_move();
        text
    }

    pub fn perft(&mut self, depth: u32) -> u64 {
        if depth == 0 {
            return 1;
        }
        let mut list = Vec::with_capacity(64);
        self.gen_moves(&mut list, false);
        let mut total = 0;
        for m in list {
            self.make_move(m);
            if !self.in_check(self.side ^ 1) {
                total += if depth == 1 { 1 } else { self.perft(depth - 1) };
            }
            self.unmake_move();
        }
        total
    }

    pub fn board_text(&self) -> String {
        let mut s = String::new();
        for rank in (0..6).rev() {
            s.push_str(&format!("{} ", rank + 1));
            for file in 0..6 {
                s.push(PIECE_CHARS[self.board[rank * 6 + file] as usize] as char);
                s.push(' ');
            }
            s.push('\n');
        }
        s.push_str("  a b c d e f\n");
        s.push_str(&self.to_fen());
        s
    }
}
