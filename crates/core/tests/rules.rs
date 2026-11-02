//! The rule tests of `reference/test.js`, ported.

use sk_core::*;

fn pos(fen: &str) -> Position {
    Position::from_fen(fen).unwrap()
}

fn uci(p: &mut Position) -> Vec<String> {
    let mut v: Vec<String> = p
        .legal_moves()
        .into_iter()
        .map(Position::move_to_uci)
        .collect();
    v.sort();
    v
}

fn piece_moves(p: &mut Position, from: &str) -> Vec<String> {
    uci(p).into_iter().filter(|u| u.starts_with(from)).collect()
}

fn drops(p: &mut Position, kind: char) -> Vec<String> {
    uci(p)
        .into_iter()
        .filter(|u| u.starts_with(&format!("{kind}@")))
        .collect()
}

fn play(p: &mut Position, moves: &[&str]) {
    for &u in moves {
        let m = p
            .move_from_uci(u)
            .unwrap_or_else(|| panic!("illegal {u} in {}", p.to_fen()));
        p.make_move(m);
    }
}

const PERFT: [u64; 5] = [10, 100, 1185, 13788, 181968];

#[test]
fn start_position() {
    let mut p = Position::startpos();
    assert_eq!(p.to_fen(), START_FEN);
    assert_eq!(p.legal_moves().len(), 10);
    assert_eq!(RULESET, "knightchess-2");
}

#[test]
fn perft_counts_match_js() {
    let mut p = Position::startpos();
    for (i, &n) in PERFT.iter().enumerate() {
        assert_eq!(p.perft(i as u32 + 1), n, "perft({})", i + 1);
    }
    assert_eq!(p.to_fen(), START_FEN);
}

#[test]
fn pawn_in_own_half_moves_only_forward() {
    assert_eq!(
        piece_moves(&mut pos("2k3/6/6/2P3/6/3K2[-] w 0 1"), "c3"),
        ["c3c4"]
    );
}

#[test]
fn pawn_in_enemy_half_moves_forward_left_right() {
    assert_eq!(
        piece_moves(&mut pos("2k3/6/2P3/6/6/3K2[-] w 0 1"), "c4"),
        ["c4b4", "c4c5", "c4d4"]
    );
}

#[test]
fn pawn_captures_straight_and_sideways_never_diagonally() {
    assert_eq!(
        piece_moves(&mut pos("2k3/6/1nb3/2P3/6/3K2[-] w 0 1"), "c3"),
        ["c3c4"]
    );
    assert_eq!(
        piece_moves(&mut pos("2k3/1nbn2/1pPp2/6/6/3K2[-] w 0 1"), "c4"),
        ["c4b4", "c4c5", "c4d4"]
    );
}

#[test]
fn pawn_enters_far_rank_and_checks_there() {
    let mut p = pos("1k4/2P3/6/6/6/3K2[-] w 0 1");
    assert_eq!(piece_moves(&mut p, "c5"), ["c5b5", "c5c6", "c5d5"]);
    assert!(pos("2k3/2P3/6/6/6/3K2[-] b 0 1").in_check(BLACK));
    assert_eq!(
        piece_moves(&mut pos("3k2/6/6/6/3p2/2K3[-] b 0 1"), "d2"),
        ["d2c2", "d2d1", "d2e2"]
    );
    // On the far rank only sideways steps remain.
    assert_eq!(
        piece_moves(&mut pos("2P3/6/6/k5/6/3K2[-] w 0 1"), "c6"),
        ["c6b6", "c6d6"]
    );
}

#[test]
fn black_pawns_mirror_white() {
    assert_eq!(
        piece_moves(&mut pos("3k2/6/3p2/6/6/2K3[-] b 0 1"), "d4"),
        ["d4d3"]
    );
    assert_eq!(
        piece_moves(&mut pos("3k2/6/6/3p2/6/2K3[-] b 0 1"), "d3"),
        ["d3c3", "d3d2", "d3e3"]
    );
}

#[test]
fn pawn_attacks_follow_the_half() {
    assert!(pos("6/6/3Pk1/6/6/K5[-] b 0 1").checked());
    assert!(!pos("6/6/6/3Pk1/6/K5[-] b 0 1").checked());
    assert!(pos("6/6/3k2/3P2/6/K5[-] b 0 1").checked());
    assert!(!pos("6/6/6/2k3/3P2/K5[-] b 0 1").checked());
}

#[test]
fn pawns_may_be_dropped_on_far_rank() {
    let d = drops(&mut pos("2k3/6/6/6/6/3K2[P] w 0 1"), 'P');
    assert_eq!(d.len(), 34);
    assert!(d.iter().any(|u| u == "P@a6"));
    assert!(drops(&mut pos("2k3/6/6/6/6/3K2[p] b 0 1"), 'P')
        .iter()
        .any(|u| u == "P@a1"));
}

#[test]
fn pawn_drop_file_rule_follows_sideways_moves() {
    let mut p = pos("2k3/6/2P3/6/6/3K2[P] w 0 1");
    assert!(!drops(&mut p, 'P').iter().any(|u| u.as_bytes()[2] == b'c'));
    play(&mut p, &["c4d4", "c6b6"]);
    let d = drops(&mut p, 'P');
    assert!(d.iter().any(|u| u.as_bytes()[2] == b'c'));
    assert!(!d.iter().any(|u| u.as_bytes()[2] == b'd'));
}

#[test]
fn sideways_steps_keep_the_clock() {
    let mut p = pos("2k3/6/2P3/6/6/3K2[-] w 5 1");
    play(&mut p, &["c4b4"]);
    assert_eq!(p.clock, 6);
    p.unmake_move();
    play(&mut p, &["c4c5"]);
    assert_eq!(p.clock, 0);
}

#[test]
fn kings_side_by_side() {
    let mut p = pos("6/6/2kK2/6/6/6[-] w 0 1");
    assert!(!p.in_check(WHITE) && !p.in_check(BLACK));
    let moves = uci(&mut p);
    assert!(!moves.contains(&"d4c4".to_string()));
    assert!(moves.contains(&"d4c5".to_string()));
}

#[test]
fn rook_bishop_cap() {
    assert!(drops(&mut pos("2k3/6/6/6/6/B2K1R[R] w 0 1"), 'R').is_empty());
    let mut open = pos("2k3/6/6/6/6/3K1R[RB] w 0 1");
    assert!(!drops(&mut open, 'R').is_empty());
    assert!(!drops(&mut open, 'B').is_empty());
}

#[test]
fn no_legal_move_loses() {
    let mut s = pos("k5/2Q3/6/1N4/6/5K[-] b 0 1");
    assert_eq!(
        s.outcome(),
        Outcome::Win {
            winner: WHITE,
            reason: WinReason::Stalemate
        }
    );
    let mut m = pos("k5/2Q3/6/1N4/6/R4K[-] b 0 1");
    assert_eq!(
        m.outcome(),
        Outcome::Win {
            winner: WHITE,
            reason: WinReason::Checkmate
        }
    );
}

#[test]
fn draws_and_no_fifty_move_rule() {
    let mut p = Position::startpos();
    for _ in 0..2 {
        play(&mut p, &["b1a3", "b6a4", "a3b1", "a4b6"]);
    }
    assert_eq!(p.outcome(), Outcome::Draw(DrawReason::Threefold));
    assert_eq!(
        pos("2k3/6/6/6/6/3K2[-] w 0 1").outcome(),
        Outcome::Draw(DrawReason::BareKings)
    );
    assert_eq!(
        pos("2k3/6/6/6/6/3K1R[-] w 400 300").outcome(),
        Outcome::Ongoing
    );
}

#[test]
fn bad_fens_are_rejected() {
    for fen in [
        "2P3/6/6/6/6/3K2[-] w 0 1",
        "2k3/6/6/6/6/3K2[PPP] w 0 1",
        "2k3/6/6/6/6/3K2[-] x 0 1",
        "2k3/6/6/6/3K2[-] w 0 1",
        "2k3/6/6/6/6/3K2 w 0 1",
        "2k3/2R3/6/6/6/3K2[-] w 0 1",
    ] {
        assert!(Position::from_fen(fen).is_err(), "{fen}");
    }
}

#[test]
fn make_unmake_keeps_invariants_in_random_games() {
    let mut seed: u32 = 12345;
    let mut rnd = move || {
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        seed as f64 / 4294967296.0
    };
    for _ in 0..200 {
        let mut p = Position::startpos();
        let mut fens = vec![p.to_fen()];
        for _ in 0..150 {
            let moves = p.legal_moves();
            if moves.is_empty() || p.outcome() != Outcome::Ongoing {
                break;
            }
            p.make_move(moves[(rnd() * moves.len() as f64) as usize]);
            fens.push(p.to_fen());
            let key = p.key();
            p.compute_hash();
            assert_eq!(p.key(), key);
            let copy = pos(&p.to_fen());
            assert_eq!(copy.key(), key);
            assert_eq!(copy.pawn_file, p.pawn_file);
            assert_eq!(copy.rb_count, p.rb_count);
        }
        while p.game_ply() > 0 {
            assert_eq!(p.to_fen(), fens.pop().unwrap());
            p.unmake_move();
        }
        assert_eq!(p.to_fen(), START_FEN);
    }
}

#[test]
fn move_text_matches_js_style() {
    let mut p = Position::startpos();
    let m = p.move_from_uci("b1c3").unwrap();
    assert_eq!(p.move_to_text(m), "Nb1-c3");
    let mut e = pos("2k3/6/1pP3/6/6/3K2[R] w 0 1");
    let m = e.move_from_uci("c4b4").unwrap();
    assert_eq!(e.move_to_text(m), "c4xb4");
    let m = e.move_from_uci("R@c5").unwrap();
    assert_eq!(e.move_to_text(m), "R@c5+");
    let mut mate = pos("k5/2Q3/6/1N4/6/5K[R] w 0 1");
    let m = mate.move_from_uci("R@a1").unwrap();
    assert_eq!(mate.move_to_text(m), "R@a1#");
}
