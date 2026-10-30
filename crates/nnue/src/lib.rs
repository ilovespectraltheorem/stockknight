//! The network evaluation (NNUE): inputs, the `.nnue` file format and the forward pass.
//!
//! ```text
//! 14,266 sparse inputs per side ─► FT accumulator (same weights for both sides)
//! [side to move, other side] ─► clipped ReLU ─► L1 ─► clipped ReLU ─► L2 ─► clipped ReLU ─► 1
//! centipawns = output × output_scale
//! ```

pub mod features;
pub mod network;

use sk_core::Position;
use sk_eval::{hand_eval, Evaluator};

pub use features::{active_features, NUM_FEATURES};
pub use network::Network;

/// A network as an evaluator. Phase 3 recomputes every evaluation from scratch (float);
/// incremental, quantized inference comes in Phase 4.
pub struct NnueEval {
    pub net: Network,
}

impl Evaluator for NnueEval {
    fn evaluate(&mut self, pos: &Position) -> i32 {
        self.net.evaluate_cp(pos)
    }
    fn name(&self) -> &'static str {
        "NNUE"
    }
}

/// What the binaries use: G0 or a network.
pub enum AnyEval {
    Hand,
    Nnue(Box<NnueEval>),
}

impl AnyEval {
    /// `none` (or empty) for G0, else a `.nnue` file.
    pub fn from_file(path: &str) -> Result<Self, String> {
        if path.is_empty() || path == "none" {
            return Ok(AnyEval::Hand);
        }
        Ok(AnyEval::Nnue(Box::new(NnueEval {
            net: Network::load(path)?,
        })))
    }
}

impl Evaluator for AnyEval {
    fn evaluate(&mut self, pos: &Position) -> i32 {
        match self {
            AnyEval::Hand => hand_eval(pos),
            AnyEval::Nnue(n) => n.evaluate(pos),
        }
    }
    fn name(&self) -> &'static str {
        match self {
            AnyEval::Hand => "G0",
            AnyEval::Nnue(_) => "NNUE",
        }
    }
}
