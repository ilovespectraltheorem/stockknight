//! Alpha-beta search, an exact port of `Searcher` in `reference/engine.js`: iterative
//! deepening, principal variation search, late-move reductions, check extensions,
//! mate-distance pruning, a transposition table, killers, a history table and quiescence.
//! At equal limits it searches the same tree as the reference and reports the same nodes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sk_core::*;
use sk_eval::{Evaluator, VALUE};

pub const MATE: i32 = 30000;
pub const MATE_BOUND: i32 = MATE - 1000;
const TT_BITS: u32 = 18;
const TT_SIZE: usize = 1 << TT_BITS;
const TT_EXACT: i8 = 1;
const TT_LOWER: i8 = 2;
const TT_UPPER: i8 = 3;
pub const MAX_PLY: i32 = 96;

/// Moves until the game ends for a mate score (positive: the side to move wins), else 0.
pub fn mate_in(score: i32) -> i32 {
    if score.abs() < MATE_BOUND {
        return 0;
    }
    let moves = (MATE - score.abs() + 1) / 2;
    if score > 0 {
        moves
    } else {
        -moves
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Limits {
    pub depth: Option<i32>,
    pub nodes: Option<u64>,
    pub movetime: Option<Duration>,
    /// Above 0: score every root move exactly and pick at random among those within the margin.
    pub random_margin: i32,
    pub seed: u64,
}

/// The platform's strength levels, identical to `LEVELS` in the reference engine.
pub fn level_limits(level: &str) -> Option<Limits> {
    let ms = |n| Some(Duration::from_millis(n));
    match level {
        "casual" => Some(Limits {
            depth: Some(2),
            movetime: ms(600),
            random_margin: 90,
            ..Default::default()
        }),
        "club" => Some(Limits {
            depth: Some(7),
            movetime: ms(1000),
            ..Default::default()
        }),
        "strong" => Some(Limits {
            movetime: ms(3000),
            ..Default::default()
        }),
        _ => None,
    }
}

#[derive(Clone, Debug, Default)]
pub struct SearchResult {
    pub best: Move,
    pub score: i32,
    pub depth: i32,
    pub nodes: u64,
    pub elapsed: Duration,
    pub pv: Vec<Move>,
}

pub type Info = SearchResult;

fn history_index(side: u8, m: Move) -> usize {
    let drop = move_drop(m) as usize;
    let from = if drop != 0 {
        36 + drop
    } else {
        move_from(m) as usize
    };
    (side as usize * 41 + from) * 36 + move_to(m) as usize
}

pub struct Searcher<E: Evaluator> {
    pub eval: E,
    tt_key: Vec<u32>,
    tt_move: Vec<u32>,
    tt_score: Vec<i32>,
    tt_depth: Vec<i8>,
    tt_flag: Vec<i8>,
    history: Vec<i32>,
    killers: Vec<Move>,
    nodes: u64,
    max_nodes: u64,
    deadline: Option<Instant>,
    start: Instant,
    stopped: bool,
    stop_flag: Arc<AtomicBool>,
}

impl<E: Evaluator> Searcher<E> {
    pub fn new(eval: E) -> Self {
        Searcher {
            eval,
            tt_key: vec![0; TT_SIZE],
            tt_move: vec![0; TT_SIZE],
            tt_score: vec![0; TT_SIZE],
            tt_depth: vec![0; TT_SIZE],
            tt_flag: vec![0; TT_SIZE],
            history: vec![0; 2 * 41 * 36],
            killers: vec![0; MAX_PLY as usize * 2],
            nodes: 0,
            max_nodes: u64::MAX,
            deadline: None,
            start: Instant::now(),
            stopped: false,
            stop_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// A flag another thread can set to stop the search.
    pub fn stop_handle(&self) -> Arc<AtomicBool> {
        self.stop_flag.clone()
    }

    pub fn clear(&mut self) {
        self.tt_key.fill(0);
        self.tt_move.fill(0);
        self.tt_score.fill(0);
        self.tt_depth.fill(0);
        self.tt_flag.fill(0);
        self.history.fill(0);
        self.killers.fill(0);
    }

    pub fn think(
        &mut self,
        pos: &mut Position,
        limits: Limits,
        mut on_info: impl FnMut(&Info),
    ) -> SearchResult {
        self.nodes = 0;
        self.stopped = false;
        self.start = Instant::now();
        self.max_nodes = limits.nodes.unwrap_or(u64::MAX);
        self.deadline = limits.movetime.map(|t| self.start + t);
        let max_depth = limits.depth.unwrap_or(64).min(MAX_PLY - 8);
        let margin = limits.random_margin;
        self.killers.fill(0);
        for h in self.history.iter_mut() {
            *h >>= 2;
        }
        self.eval.reset(pos);

        let root_moves = pos.legal_moves();
        let mut result = SearchResult::default();
        if root_moves.is_empty() {
            result.score = -MATE;
            return result;
        }
        let mut order = root_moves;
        let mut scores: Vec<(Move, i32)> = Vec::new();

        for depth in 1..=max_depth {
            let (best, score, move_scores, complete) =
                self.search_root(pos, &order, depth, margin > 0);
            if !complete && depth > 1 {
                break;
            }
            result.best = best;
            result.score = score;
            result.depth = depth;
            scores = move_scores;
            order.retain(|&m| m != best);
            order.insert(0, best);
            result.pv = self.principal_variation(pos, best, depth);
            result.nodes = self.nodes;
            result.elapsed = self.start.elapsed();
            on_info(&result);
            if !complete || self.stopped {
                break;
            }
            if score.abs() >= MATE_BOUND && depth >= MATE - score.abs() {
                break;
            }
        }

        if margin > 0 && !scores.is_empty() {
            let score_of = |m: Move| scores.iter().find(|s| s.0 == m).map(|s| s.1);
            let near: Vec<Move> = order
                .iter()
                .copied()
                .filter(|&m| score_of(m).is_some_and(|s| s >= result.score - margin))
                .collect();
            let mut x =
                limits.seed ^ 0x9e37_79b9_7f4a_7c15 ^ self.start.elapsed().as_nanos() as u64;
            x ^= x >> 33;
            x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
            x ^= x >> 33;
            let pick = near[(x % near.len() as u64) as usize];
            if pick != result.best {
                result.best = pick;
                result.score = score_of(pick).unwrap();
                result.pv = vec![pick];
            }
        }
        result.nodes = self.nodes;
        result.elapsed = self.start.elapsed();
        result
    }

    fn make(&mut self, pos: &mut Position, m: Move) {
        self.eval.make(pos, m);
        pos.make_move(m);
    }

    fn unmake(&mut self, pos: &mut Position) {
        pos.unmake_move();
        self.eval.unmake();
    }

    fn search_root(
        &mut self,
        pos: &mut Position,
        order: &[Move],
        depth: i32,
        exact_all: bool,
    ) -> (Move, i32, Vec<(Move, i32)>, bool) {
        let mut alpha = -MATE - 1;
        let beta = MATE + 1;
        let mut best = order[0];
        let mut best_score = -MATE - 1;
        let mut move_scores = Vec::with_capacity(order.len());
        for (i, &m) in order.iter().enumerate() {
            self.make(pos, m);
            let mut score;
            if i == 0 || exact_all {
                score = -self.negamax(pos, depth - 1, -beta, -alpha, 1);
            } else {
                score = -self.negamax(pos, depth - 1, -alpha - 1, -alpha, 1);
                if score > alpha && !self.stopped {
                    score = -self.negamax(pos, depth - 1, -beta, -alpha, 1);
                }
            }
            self.unmake(pos);
            if self.stopped {
                return (best, best_score, move_scores, false);
            }
            move_scores.push((m, score));
            if score > best_score {
                best_score = score;
                best = m;
                if !exact_all && score > alpha {
                    alpha = score;
                }
            }
        }
        self.store_tt(pos, depth, best_score, TT_EXACT, best, 0);
        (best, best_score, move_scores, true)
    }

    fn check_limits(&mut self) {
        if self.nodes >= self.max_nodes {
            self.stopped = true;
        } else if self.nodes & 1023 == 0
            && (self.deadline.is_some_and(|d| Instant::now() >= d)
                || self.stop_flag.load(Ordering::Relaxed))
        {
            self.stopped = true;
        }
    }

    fn tt_index(pos: &Position) -> usize {
        pos.hash_lo as usize & (TT_SIZE - 1)
    }

    fn store_tt(
        &mut self,
        pos: &Position,
        depth: i32,
        mut score: i32,
        flag: i8,
        m: Move,
        ply: i32,
    ) {
        let i = Self::tt_index(pos);
        if score >= MATE_BOUND {
            score += ply;
        } else if score <= -MATE_BOUND {
            score -= ply;
        }
        self.tt_key[i] = pos.hash_hi;
        self.tt_move[i] = m;
        self.tt_score[i] = score;
        self.tt_depth[i] = depth as i8;
        self.tt_flag[i] = flag;
    }

    fn killer(&self, i: usize) -> Move {
        self.killers.get(i).copied().unwrap_or(0)
    }

    fn negamax(
        &mut self,
        pos: &mut Position,
        mut depth: i32,
        mut alpha: i32,
        mut beta: i32,
        ply: i32,
    ) -> i32 {
        if self.stopped {
            return 0;
        }
        self.nodes += 1;
        self.check_limits();
        if self.stopped {
            return 0;
        }

        if pos.repeats_within(u32::MAX) || pos.bare_kings() {
            return 0;
        }
        alpha = alpha.max(-MATE + ply);
        beta = beta.min(MATE - ply - 1);
        if alpha >= beta {
            return alpha;
        }

        let in_check = pos.checked();
        if in_check && ply < MAX_PLY - 8 {
            depth += 1;
        }
        if depth <= 0 || ply >= MAX_PLY - 2 {
            return self.quiesce(pos, alpha, beta, ply);
        }

        let pv_node = beta - alpha > 1;
        let i = Self::tt_index(pos);
        let mut tt_move = 0;
        if self.tt_key[i] == pos.hash_hi && self.tt_flag[i] != 0 {
            tt_move = self.tt_move[i];
            if !pv_node && self.tt_depth[i] as i32 >= depth {
                let mut s = self.tt_score[i];
                if s >= MATE_BOUND {
                    s -= ply;
                } else if s <= -MATE_BOUND {
                    s += ply;
                }
                let flag = self.tt_flag[i];
                if flag == TT_EXACT
                    || (flag == TT_LOWER && s >= beta)
                    || (flag == TT_UPPER && s <= alpha)
                {
                    return s;
                }
            }
        }

        let mut moves = Vec::with_capacity(64);
        pos.gen_moves(&mut moves, false);
        self.order_moves(pos, &mut moves, tt_move, ply);
        let alpha_start = alpha;
        let mut best = 0;
        let mut best_score = -MATE - 1;
        let mut legal = 0;
        for m in moves {
            let capture = pos.captured_by(m) != 0;
            self.make(pos, m);
            if pos.in_check(pos.side ^ 1) {
                self.unmake(pos);
                continue;
            }
            legal += 1;
            let mut score;
            if legal == 1 {
                score = -self.negamax(pos, depth - 1, -beta, -alpha, ply + 1);
            } else {
                let mut reduction = 0;
                if depth >= 3 && legal > 3 && !capture && !in_check && !pos.checked() {
                    reduction = if legal > 8 { 2 } else { 1 };
                }
                score = -self.negamax(pos, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1);
                if score > alpha && reduction != 0 {
                    score = -self.negamax(pos, depth - 1, -alpha - 1, -alpha, ply + 1);
                }
                if score > alpha && score < beta {
                    score = -self.negamax(pos, depth - 1, -beta, -alpha, ply + 1);
                }
            }
            self.unmake(pos);
            if self.stopped {
                return 0;
            }
            if score > best_score {
                best_score = score;
                best = m;
            }
            if score > alpha {
                alpha = score;
            }
            if alpha >= beta {
                if !capture {
                    let k = ply as usize * 2;
                    if self.killer(k) != m && k + 1 < self.killers.len() {
                        self.killers[k + 1] = self.killers[k];
                        self.killers[k] = m;
                    }
                    let h = history_index(pos.side, m);
                    self.history[h] = self.history[h].wrapping_add(depth * depth);
                }
                break;
            }
        }

        if legal == 0 {
            return -MATE + ply; // checkmate and stalemate both lose
        }
        let flag = if best_score >= beta {
            TT_LOWER
        } else if best_score > alpha_start {
            TT_EXACT
        } else {
            TT_UPPER
        };
        self.store_tt(pos, depth, best_score, flag, best, ply);
        best_score
    }

    fn quiesce(&mut self, pos: &mut Position, mut alpha: i32, beta: i32, ply: i32) -> i32 {
        if self.stopped {
            return 0;
        }
        self.nodes += 1;
        self.check_limits();
        if self.stopped {
            return 0;
        }

        let in_check = pos.checked();
        let mut best_score = -MATE + ply;
        if !in_check {
            let stand = self.eval.evaluate(pos);
            if stand >= beta || ply >= MAX_PLY - 1 {
                return stand;
            }
            if stand > alpha {
                alpha = stand;
            }
            best_score = stand;
        }

        let mut moves = Vec::with_capacity(32);
        pos.gen_moves(&mut moves, !in_check);
        self.order_moves(pos, &mut moves, 0, ply);
        for m in moves {
            self.make(pos, m);
            if pos.in_check(pos.side ^ 1) {
                self.unmake(pos);
                continue;
            }
            let score = -self.quiesce(pos, -beta, -alpha, ply + 1);
            self.unmake(pos);
            if self.stopped {
                return 0;
            }
            if score > best_score {
                best_score = score;
            }
            if score > alpha {
                alpha = score;
            }
            if alpha >= beta {
                break;
            }
        }
        best_score
    }

    /// TT move, captures (most valuable victim, then least valuable attacker), killers, then
    /// quiet moves and drops by history; a stable sort, as in the reference. Keys are the
    /// reference's keys × 10, so they stay integers.
    fn order_moves(&self, pos: &Position, moves: &mut [Move], tt_move: Move, ply: i32) {
        let (k1, k2) = (
            self.killer(ply as usize * 2),
            self.killer(ply as usize * 2 + 1),
        );
        let b = &pos.board;
        let mut keyed: Vec<(i64, Move)> = moves
            .iter()
            .map(|&m| {
                let key = if m == tt_move {
                    10_000_000_000
                } else if move_drop(m) == 0 && b[move_to(m) as usize] != 0 {
                    1_000_000_000 + VALUE[type_of(b[move_to(m) as usize]) as usize] as i64 * 100
                        - VALUE[type_of(b[move_from(m) as usize]) as usize] as i64
                } else if m == k1 {
                    900_000_000
                } else if m == k2 {
                    800_000_000
                } else {
                    self.history[history_index(pos.side, m)] as i64 * 10
                };
                (key, m)
            })
            .collect();
        keyed.sort_by(|x, y| y.0.cmp(&x.0));
        for (slot, (_, m)) in moves.iter_mut().zip(keyed) {
            *slot = m;
        }
    }

    fn principal_variation(&mut self, pos: &mut Position, first: Move, depth: i32) -> Vec<Move> {
        let mut pv = vec![first];
        pos.make_move(first);
        let mut made = 1;
        while (pv.len() as i32) < depth {
            let i = Self::tt_index(pos);
            if self.tt_key[i] != pos.hash_hi || self.tt_move[i] == 0 {
                break;
            }
            let m = self.tt_move[i];
            if !pos.legal_moves().contains(&m) {
                break;
            }
            pv.push(m);
            pos.make_move(m);
            made += 1;
            if pos.repetition_count() >= 2 {
                break;
            }
        }
        for _ in 0..made {
            pos.unmake_move();
        }
        pv
    }
}
