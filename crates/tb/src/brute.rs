//! An independent solver for checking tables: no index, no symmetry, no un-moves.
//!
//! It lists every position of a set of signatures by placing pieces square by square, reads
//! each one through the FEN parser, links positions by their FEN keys using full legal move
//! generation, and assigns values by plain sweeps (a position is decided in sweep d exactly
//! when its distance is d). It is slow and memory hungry, so it is meant for small tables.

use std::collections::HashMap;

use sk_core::{Position, PIECE_CHARS};

use crate::sig::{Sig, TYPES};
use crate::table::{decode_value, Tables, Wdl};

fn key(pos: &Position) -> String {
    let fen = pos.to_fen();
    let mut f = fen.split_whitespace();
    format!("{} {}", f.next().unwrap(), f.next().unwrap())
}

fn fen_of(board: &[u8; 36], sig: &Sig, side: u8) -> String {
    let mut s = String::new();
    for r in (0..6).rev() {
        let mut empty = 0;
        for f in 0..6 {
            let c = board[r * 6 + f];
            if c == 0 {
                empty += 1;
                continue;
            }
            if empty > 0 {
                s.push((b'0' + empty) as char);
                empty = 0;
            }
            s.push(PIECE_CHARS[c as usize] as char);
        }
        if empty > 0 {
            s.push((b'0' + empty) as char);
        }
        if r > 0 {
            s.push('/');
        }
    }
    let mut hand = String::new();
    for c in 0..2 {
        for t in TYPES {
            for _ in 0..sig.hand[c][t as usize] {
                hand.push(PIECE_CHARS[(t | (c as u8) << 3) as usize] as char);
            }
        }
    }
    if hand.is_empty() {
        hand.push('-');
    }
    format!("{s}[{hand}] {} 0 1", if side == 0 { 'w' } else { 'b' })
}

/// Every legal position of `sig`, as parsed positions.
fn enumerate(sig: &Sig, out: &mut Vec<Position>) {
    let mut codes = vec![6u8, 14u8];
    for c in 0..2u8 {
        for t in TYPES {
            for _ in 0..sig.board[c as usize][t as usize] {
                codes.push(t | c << 3);
            }
        }
    }
    fn rec(
        codes: &[u8],
        i: usize,
        min_sq: u8,
        board: &mut [u8; 36],
        sig: &Sig,
        out: &mut Vec<Position>,
    ) {
        if i == codes.len() {
            for side in 0..2 {
                if let Ok(p) = Position::from_fen(&fen_of(board, sig, side)) {
                    out.push(p);
                }
            }
            return;
        }
        let same = i > 0 && codes[i] == codes[i - 1];
        for sq in if same { min_sq } else { 0 }..36 {
            if board[sq as usize] != 0 {
                continue;
            }
            board[sq as usize] = codes[i];
            rec(codes, i + 1, sq + 1, board, sig, out);
            board[sq as usize] = 0;
        }
    }
    rec(&codes, 0, 0, &mut [0; 36], sig, out);
}

/// Solve `sigs` and everything they lead to, then compare every position with `tables`.
/// Returns (positions compared, mismatches as text, at most 20).
pub fn compare(sigs: &[Sig], tables: &Tables, log: &dyn Fn(&str)) -> (u64, Vec<String>) {
    let mut closure: Vec<Sig> = Vec::new();
    let mut todo: Vec<Sig> = sigs.to_vec();
    while let Some(s) = todo.pop() {
        if !closure.contains(&s) {
            closure.push(s);
            todo.extend(s.successors());
        }
    }
    let mut positions = Vec::new();
    for s in &closure {
        enumerate(s, &mut positions);
    }
    log(&format!(
        "brute force: {} signatures, {} positions",
        closure.len(),
        positions.len()
    ));
    let index: HashMap<String, u32> = positions
        .iter()
        .enumerate()
        .map(|(i, p)| (key(p), i as u32))
        .collect();
    let mut children: Vec<Vec<u32>> = Vec::with_capacity(positions.len());
    let mut bare = Vec::with_capacity(positions.len());
    for p in positions.iter_mut() {
        bare.push(p.bare_kings());
        let mut kids = Vec::new();
        for m in p.legal_moves() {
            p.make_move(m);
            kids.push(
                *index
                    .get(&key(p))
                    .unwrap_or_else(|| panic!("successor {} not listed", p.to_fen())),
            );
            p.unmake_move();
        }
        children.push(kids);
    }
    drop(index);
    let mut val = vec![-1i64; positions.len()];
    for (i, kids) in children.iter().enumerate() {
        if kids.is_empty() && !bare[i] {
            val[i] = 0;
        }
    }
    let mut d = 1;
    loop {
        let mut new = Vec::new();
        for (i, kids) in children.iter().enumerate() {
            if val[i] >= 0 || bare[i] || kids.is_empty() {
                continue;
            }
            let mut min_loss = None;
            let mut all_win = true;
            let mut max_win = 0;
            for &k in kids {
                let v = val[k as usize];
                if v < 0 {
                    all_win = false;
                } else if v % 2 == 0 {
                    min_loss = Some(min_loss.map_or(v, |m: i64| m.min(v)));
                } else {
                    max_win = max_win.max(v);
                }
            }
            let got = match min_loss {
                Some(m) => Some(m + 1),
                None if all_win => Some(max_win + 1),
                None => None,
            };
            if let Some(g) = got {
                assert_eq!(g, d, "brute force sweep order");
                new.push(i);
            }
        }
        if new.is_empty() {
            break;
        }
        for i in new {
            val[i] = d;
        }
        d += 1;
    }
    let mut bad = Vec::new();
    let wanted: Vec<Sig> = sigs.to_vec();
    let mut n = 0;
    for (i, p) in positions.iter().enumerate() {
        if !wanted.contains(&Sig::of(p)) {
            continue;
        }
        n += 1;
        let expect = match val[i] {
            -1 => (Wdl::Draw, None),
            v if v % 2 == 1 => (Wdl::Win, Some(v as u32)),
            v => (Wdl::Loss, Some(v as u32)),
        };
        let got = tables.probe(p).and_then(decode_value);
        if got != Some(expect) && bad.len() < 20 {
            bad.push(format!(
                "{}: brute force {expect:?}, table {got:?}",
                p.to_fen()
            ));
        }
    }
    (n, bad)
}
