//! `sk-pv`: measure what each piece is worth to a network.
//!
//! `sk-pv <net.nnue> <out.tsv> <records.bin>... [--search-every N --nodes M]`
//!
//! For every recorded position and every non-king piece on the board, the piece is removed
//! and the evaluation change is written from the owner's view. For every reserve slot
//! (pawn 1, pawn 2, rook, bishop) a piece is added or taken away the same way. Positions where
//! the edit leaves either king in check are skipped. Lines:
//!
//! `B <idx> <owner_is_stm> <type> <rel_rank 1-6> <rel_file> <static_delta> <search_delta|NA>`
//! `H <idx> <owner_is_stm> <type> <slot 1|2> <drop_ok 0|1> <static_delta> <search_delta|NA>`
//! `P <idx> <side> <result_white> <score_stm> <static_stm> <material...>`

use std::io::{BufWriter, Write};

use sk_core::*;
use sk_data::read_records;
use sk_nnue::network::Network;
use sk_nnue::AnyEval;
use sk_search::{Limits, Searcher};

fn rebuild(p: &Position) -> Option<Position> {
    let q = Position::from_fen(&p.to_fen()).ok()?;
    if q.in_check(WHITE) || q.in_check(BLACK) {
        return None;
    }
    Some(q)
}

fn owner_cp(net: &Network, p: &Position, owner: u8) -> i32 {
    let cp = net.evaluate_cp(p);
    if p.side == owner { cp } else { -cp }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let net = Network::load(&args[1]).expect("net");
    let mut out = BufWriter::new(std::fs::File::create(&args[2]).unwrap());
    let mut files = Vec::new();
    let mut search_every = 0usize;
    let mut nodes = 3000u64;
    let mut i = 3;
    while i < args.len() {
        match args[i].as_str() {
            "--search-every" => { search_every = args[i + 1].parse().unwrap(); i += 2; }
            "--nodes" => { nodes = args[i + 1].parse().unwrap(); i += 2; }
            f => { files.push(f.to_string()); i += 1; }
        }
    }
    let mut searcher = Searcher::new(AnyEval::from_file(&args[1]).unwrap());
    let search_owner = |s: &mut Searcher<AnyEval>, p: &Position, owner: u8| -> i32 {
        let mut q = p.clone();
        s.clear();
        let r = s.think(&mut q, Limits { nodes: Some(nodes), ..Default::default() }, |_| {});
        let sc = r.score.clamp(-3000, 3000);
        if p.side == owner { sc } else { -sc }
    };

    let mut idx = 0usize;
    for f in &files {
        for rec in read_records(f).unwrap() {
            idx += 1;
            let Ok(pos) = rec.position() else { continue };
            if pos.in_check(WHITE) || pos.in_check(BLACK) { continue; }
            let do_search = search_every > 0 && idx % search_every == 0;
            let base_stm = net.evaluate_cp(&pos);
            let base_search = if do_search { Some(search_owner(&mut searcher, &pos, pos.side)) } else { None };

            // Position line: material by colour.
            // per colour: N B R Q, pawns rel rank 1..6, hand P R B
            let mut mat = [[0i32; 13]; 2];
            for sq in 0..36u8 {
                let code = pos.board[sq as usize];
                if code == 0 { continue; }
                let (t, c) = (type_of(code), color_of(code));
                let rr = if c == WHITE { rank_of(sq) } else { 5 - rank_of(sq) } as usize;
                match t {
                    KNIGHT => mat[c as usize][0] += 1,
                    BISHOP => mat[c as usize][1] += 1,
                    ROOK => mat[c as usize][2] += 1,
                    QUEEN => mat[c as usize][3] += 1,
                    PAWN => mat[c as usize][4 + rr] += 1,
                    _ => {}
                }
            }
            for c in 0..2 {
                mat[c][10] = pos.hand[c][PAWN as usize] as i32;
                mat[c][11] = pos.hand[c][ROOK as usize] as i32;
                mat[c][12] = pos.hand[c][BISHOP as usize] as i32;
            }
            let res = rec.result() as u8;
            write!(out, "P\t{idx}\t{}\t{res}\t{}\t{base_stm}", pos.side, rec.score()).unwrap();
            for c in 0..2 { for v in mat[c] { write!(out, "\t{v}").unwrap(); } }
            writeln!(out).unwrap();

            // Board pieces.
            for sq in 0..36u8 {
                let code = pos.board[sq as usize];
                if code == 0 || type_of(code) == KING { continue; }
                let (t, c) = (type_of(code), color_of(code));
                let mut q = pos.clone();
                q.board[sq as usize] = 0;
                let Some(q) = rebuild(&q) else { continue };
                let before = if pos.side == c { base_stm } else { -base_stm };
                let d = before - owner_cp(&net, &q, c);
                let sd = match base_search {
                    Some(b) => {
                        let b = if pos.side == c { b } else { -b };
                        format!("{}", b - search_owner(&mut searcher, &q, c))
                    }
                    None => "NA".into(),
                };
                let (rr, rf) = if c == WHITE { (rank_of(sq), file_of(sq)) } else { (5 - rank_of(sq), 5 - file_of(sq)) };
                writeln!(out, "B\t{idx}\t{}\t{t}\t{}\t{rf}\t{d}\t{sd}", (pos.side == c) as u8, rr + 1).unwrap();
            }

            // Reserve slots: the value of the k-th piece of a kind in hand.
            for c in 0..2u8 {
                for t in DROP_TYPES {
                    let have = pos.hand[c as usize][t as usize];
                    let max = RESERVE_MAX[t as usize];
                    // remove one (slot = have) or add one (slot = have + 1)
                    let mut edits = Vec::new();
                    if have > 0 { edits.push((have, true)); }
                    if have < max { edits.push((have + 1, false)); }
                    for (slot, remove) in edits {
                        let mut q = pos.clone();
                        if remove { q.hand[c as usize][t as usize] -= 1 } else { q.hand[c as usize][t as usize] += 1 }
                        let Some(q) = rebuild(&q) else { continue };
                        let before = if pos.side == c { base_stm } else { -base_stm };
                        let after = owner_cp(&net, &q, c);
                        // value of having the slot-th piece: with - without
                        let d = if remove { before - after } else { after - before };
                        let sd = match base_search {
                            Some(b) => {
                                let b = if pos.side == c { b } else { -b };
                                let a = search_owner(&mut searcher, &q, c);
                                format!("{}", if remove { b - a } else { a - b })
                            }
                            None => "NA".into(),
                        };
                        let drop_ok = (t == PAWN || pos.rb_count[c as usize] < 2) as u8;
                        writeln!(out, "H\t{idx}\t{}\t{t}\t{slot}\t{drop_ok}\t{d}\t{sd}", (pos.side == c) as u8).unwrap();
                    }
                }
            }
        }
    }
}
