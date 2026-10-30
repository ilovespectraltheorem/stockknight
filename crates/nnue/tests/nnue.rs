use sk_core::*;
use sk_nnue::features::{active_features, mirror, MAX_ACTIVE, NUM_FEATURES};
use sk_nnue::Network;

fn random_positions(n: usize) -> Vec<Position> {
    let mut seed = 7u32;
    let mut out = Vec::new();
    let mut pos = Position::startpos();
    while out.len() < n {
        let moves = pos.legal_moves();
        if moves.is_empty() || pos.outcome() != Outcome::Ongoing || pos.game_ply() > 150 {
            pos = Position::startpos();
            continue;
        }
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        pos.make_move(moves[(seed >> 8) as usize % moves.len()]);
        out.push(Position::from_fen(&pos.to_fen()).unwrap());
    }
    out
}

#[test]
fn input_count() {
    assert_eq!(NUM_FEATURES, 14_266);
}

#[test]
fn start_position_inputs() {
    let pos = Position::startpos();
    let white = active_features(&pos, WHITE);
    // 23 pieces besides the own king, 2 pawns + rook + bishop in hand, no drop allowed: 4 + 4 reserve.
    assert_eq!(white.len(), 23 + 4 + 4);
    let black = active_features(&pos, BLACK);
    assert_eq!(white, black, "the start position is its own mirror");
}

#[test]
fn drop_allowed_input() {
    let open = Position::from_fen("2k3/6/6/6/6/3K1R[RB] w 0 1").unwrap();
    assert!(active_features(&open, WHITE).contains(&(14_256 + 4)));
    let capped = Position::from_fen("2k3/6/6/6/6/B2K1R[R] w 0 1").unwrap();
    assert!(!active_features(&capped, WHITE).contains(&(14_256 + 4)));
}

#[test]
fn mirror_symmetry_and_bounds() {
    let net = Network::random(32, 8, 8, 3);
    for pos in random_positions(300) {
        let m = mirror(&pos);
        assert_eq!(active_features(&pos, pos.side), active_features(&m, m.side));
        assert_eq!(net.forward(&pos), net.forward(&m));
        for p in [WHITE, BLACK] {
            let f = active_features(&pos, p);
            assert!(f.len() <= MAX_ACTIVE);
            assert!(f.iter().all(|&i| (i as usize) < NUM_FEATURES));
        }
    }
}

#[test]
fn file_round_trip() {
    let net = Network::random(16, 8, 4, 5);
    let back = Network::from_bytes(&net.to_bytes()).unwrap();
    let pos = Position::startpos();
    assert_eq!(net.forward(&pos), back.forward(&pos));
    assert_eq!(back.description, net.description);
    let mut wrong = net.to_bytes();
    wrong[0] = b'X';
    assert!(Network::from_bytes(&wrong).is_err());
}
