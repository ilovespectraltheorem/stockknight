//! Material signatures: which pieces each side has on the board and in reserve.

use sk_core::{color_of, type_of, Position, BISHOP, KING, KNIGHT, PAWN, QUEEN, RESERVE_MAX, ROOK};

/// Non-king piece types, in naming order (strongest first).
pub const TYPES: [u8; 5] = [QUEEN, ROOK, BISHOP, KNIGHT, PAWN];
/// Most pieces of a type one side can own at once (board and reserve together).
pub const TOTAL_MAX: [u8; 7] = [0, 8, 2, 2, 2, 1, 0];
const LETTERS: &[u8; 7] = b".PNBRQK";

/// Material by color and piece type, kings not counted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Sig {
    pub board: [[u8; 7]; 2],
    pub hand: [[u8; 7]; 2],
}

impl Sig {
    pub fn of(pos: &Position) -> Sig {
        let mut s = Sig {
            board: [[0; 7]; 2],
            hand: pos.hand,
        };
        for &code in &pos.board {
            if code != 0 && type_of(code) != KING {
                s.board[color_of(code) as usize][type_of(code) as usize] += 1;
            }
        }
        for h in &mut s.hand {
            h[KING as usize] = 0;
        }
        s
    }

    /// All pieces in the game, both kings included.
    pub fn pieces(&self) -> u32 {
        2 + self
            .board
            .iter()
            .chain(&self.hand)
            .flatten()
            .map(|&n| n as u32)
            .sum::<u32>()
    }

    pub fn hand_pieces(&self) -> u32 {
        self.hand.iter().flatten().map(|&n| n as u32).sum()
    }

    /// Only the two kings and nothing in reserve: a draw by bare kings.
    pub fn bare(&self) -> bool {
        self.pieces() == 2
    }

    /// The order tables are solved in: every move leads to an earlier signature or stays put.
    pub fn solve_key(&self) -> (u32, u32, String) {
        (self.pieces(), self.hand_pieces(), self.name())
    }

    /// The same material with colors swapped.
    pub fn flipped(&self) -> Sig {
        Sig {
            board: [self.board[1], self.board[0]],
            hand: [self.hand[1], self.hand[0]],
        }
    }

    /// The one of this signature and its colour swap that has a stored table, and whether it
    /// is the swapped one. A position of the other is looked up with colours swapped and the
    /// board turned upside down (`index::flip`), which the rules treat identically.
    pub fn canonical(&self) -> (Sig, bool) {
        let f = self.flipped();
        if f < *self {
            (f, true)
        } else {
            (*self, false)
        }
    }

    /// `KRvKP`, with reserves in brackets: `KQ[P]vK[RB]`.
    pub fn name(&self) -> String {
        let mut out = String::new();
        for c in 0..2 {
            if c == 1 {
                out.push('v');
            }
            out.push('K');
            for t in TYPES {
                for _ in 0..self.board[c][t as usize] {
                    out.push(LETTERS[t as usize] as char);
                }
            }
            if self.hand[c].iter().any(|&n| n > 0) {
                out.push('[');
                for t in TYPES {
                    for _ in 0..self.hand[c][t as usize] {
                        out.push(LETTERS[t as usize] as char);
                    }
                }
                out.push(']');
            }
        }
        out
    }

    pub fn parse(text: &str) -> Result<Sig, String> {
        let bad = || format!("bad signature {text:?}");
        let sides: Vec<&str> = text.split('v').collect();
        if sides.len() != 2 {
            return Err(bad());
        }
        let mut s = Sig {
            board: [[0; 7]; 2],
            hand: [[0; 7]; 2],
        };
        for (c, side) in sides.iter().enumerate() {
            let rest = side.strip_prefix('K').ok_or_else(bad)?;
            let (on, inhand) = match rest.find('[') {
                Some(i) => (&rest[..i], rest[i + 1..].strip_suffix(']').ok_or_else(bad)?),
                None => (rest, ""),
            };
            for (part, dst) in [(on, &mut s.board[c]), (inhand, &mut s.hand[c])] {
                for ch in part.bytes() {
                    let t = LETTERS
                        .iter()
                        .position(|&l| l == ch)
                        .filter(|&t| t != 0 && t != 6)
                        .ok_or_else(bad)?;
                    dst[t] += 1;
                }
            }
        }
        if !s.feasible() {
            return Err(format!("{text}: more material than the game allows"));
        }
        Ok(s)
    }

    /// Within the game's material limits: reserves only hold pawns, bishops and rooks, at most
    /// as many as the start reserve, and no side owns more of a type than it started with.
    pub fn feasible(&self) -> bool {
        (0..2).all(|c| {
            (1..6).all(|t| {
                self.hand[c][t] <= RESERVE_MAX[t]
                    && self.board[c][t] + self.hand[c][t] <= TOTAL_MAX[t]
            })
        })
    }

    /// The signature after the side `us` captures a piece of type `t`.
    pub fn after_capture(&self, us: u8, t: u8) -> Sig {
        let mut s = *self;
        s.board[(us ^ 1) as usize][t as usize] -= 1;
        s
    }

    /// The signature after `us` drops a piece of type `t`.
    pub fn after_drop(&self, us: u8, t: u8) -> Sig {
        let mut s = *self;
        s.hand[us as usize][t as usize] -= 1;
        s.board[us as usize][t as usize] += 1;
        s
    }

    /// Every signature a move from this one can lead to, other than itself.
    pub fn successors(&self) -> Vec<Sig> {
        let mut out = Vec::new();
        for us in 0..2u8 {
            for t in TYPES {
                if self.board[(us ^ 1) as usize][t as usize] > 0 {
                    out.push(self.after_capture(us, t));
                }
                if self.hand[us as usize][t as usize] > 0 {
                    out.push(self.after_drop(us, t));
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }
}

/// The signatures with stored tables (one of each colour-swapped pair), in solving order.
pub fn canonical_sigs(max: u32) -> Vec<Sig> {
    all_sigs(max)
        .into_iter()
        .filter(|s| !s.canonical().1)
        .collect()
}

/// Every feasible signature with at most `max` pieces, in solving order.
pub fn all_sigs(max: u32) -> Vec<Sig> {
    // Slots: (color, type, in reserve).
    let mut slots = Vec::new();
    for c in 0..2 {
        for t in TYPES {
            slots.push((c, t as usize, false));
            if RESERVE_MAX[t as usize] > 0 {
                slots.push((c, t as usize, true));
            }
        }
    }
    let mut out = Vec::new();
    fn rec(slots: &[(usize, usize, bool)], i: usize, left: u32, s: &mut Sig, out: &mut Vec<Sig>) {
        if i == slots.len() {
            out.push(*s);
            return;
        }
        let (c, t, h) = slots[i];
        for n in 0..=left.min(8) as u8 {
            if h {
                s.hand[c][t] = n
            } else {
                s.board[c][t] = n
            }
            if s.feasible() {
                rec(slots, i + 1, left - n as u32, s, out);
            }
        }
        if h {
            s.hand[c][t] = 0
        } else {
            s.board[c][t] = 0
        }
    }
    let mut s = Sig {
        board: [[0; 7]; 2],
        hand: [[0; 7]; 2],
    };
    rec(&slots, 0, max.saturating_sub(2), &mut s, &mut out);
    out.sort_by_key(|s| s.solve_key());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip() {
        for s in all_sigs(5) {
            assert_eq!(Sig::parse(&s.name()).unwrap(), s);
        }
        assert_eq!(Sig::parse("KQ[P]vK[RB]").unwrap().name(), "KQ[P]vK[RB]");
        assert!(Sig::parse("KQQvK").is_err());
        assert!(Sig::parse("K[N]vK").is_err());
    }

    #[test]
    fn counts_match_the_census() {
        let n: Vec<usize> = (2..=6).map(|k| all_sigs(k).len()).collect();
        assert_eq!(n, vec![1, 17, 147, 855, 3746]);
    }

    #[test]
    fn successors_come_first() {
        let order = all_sigs(5);
        for (i, s) in order.iter().enumerate() {
            for t in s.successors() {
                assert!(order[..i].contains(&t), "{} before {}", t.name(), s.name());
            }
        }
    }

    #[test]
    fn piece_codes() {
        assert_eq!(LETTERS[ROOK as usize], b'R');
        assert_eq!(LETTERS[PAWN as usize], b'P');
        assert_eq!(LETTERS[QUEEN as usize], b'Q');
        assert_eq!(LETTERS[KNIGHT as usize], b'N');
        assert_eq!(LETTERS[BISHOP as usize], b'B');
    }
}
