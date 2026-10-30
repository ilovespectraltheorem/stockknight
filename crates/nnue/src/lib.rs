//! The network evaluation (NNUE): inputs, the `.nnue` file format and the forward pass.
//!
//! ```text
//! 14,266 sparse inputs per side ─► FT accumulator (same weights for both sides)
//! [side to move, other side] ─► clipped ReLU ─► L1 ─► clipped ReLU ─► L2 ─► clipped ReLU ─► 1
//! centipawns = output × output_scale
//! ```
//!
//! In search the network runs quantized and incrementally (`QuantEval`); `Network` is the float
//! reference.

pub mod features;
pub mod incremental;
pub mod network;
pub mod quant;

use sk_core::{Move, Position};
use sk_eval::{hand_eval, Evaluator};

pub use features::{active_features, NUM_FEATURES};
pub use incremental::QuantEval;
pub use network::Network;
pub use quant::{simd_available, vnni_available, QuantNet};

/// How a network is evaluated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NnueMode {
    /// Integers, incremental, AVX2 (and VNNI) when the CPU has it. The default.
    Quantized,
    /// The same without VNNI (gives identical results).
    Avx2,
    /// The same integers without AVX2 (gives identical results).
    Portable,
    /// Float, recomputed at every evaluation: the reference, and slow.
    Float,
}

impl NnueMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "quantized" | "quant" => Some(NnueMode::Quantized),
            "avx2" => Some(NnueMode::Avx2),
            "portable" => Some(NnueMode::Portable),
            "float" => Some(NnueMode::Float),
            _ => None,
        }
    }
}

/// A network as an evaluator.
pub struct NnueEval {
    pub net: Network,
    pub quant: QuantEval,
    mode: NnueMode,
}

impl NnueEval {
    pub fn new(net: Network) -> Result<Self, String> {
        let quant = QuantEval::new(QuantNet::from_network(&net)?);
        Ok(NnueEval {
            net,
            quant,
            mode: NnueMode::Quantized,
        })
    }

    pub fn mode(&self) -> NnueMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: NnueMode) {
        self.mode = mode;
        let net = &mut self.quant.net;
        net.simd = matches!(mode, NnueMode::Quantized | NnueMode::Avx2)
            && simd_available()
            && QuantNet::simd_shape(net.ft, net.l1);
        net.vnni = mode == NnueMode::Quantized && vnni_available();
    }
}

impl Evaluator for NnueEval {
    fn reset(&mut self, pos: &Position) {
        if self.mode != NnueMode::Float {
            self.quant.set_root(pos);
        }
    }
    fn make(&mut self, pos: &Position, m: Move) {
        if self.mode != NnueMode::Float {
            self.quant.push(pos, m);
        }
    }
    fn unmake(&mut self) {
        if self.mode != NnueMode::Float {
            self.quant.pop();
        }
    }
    fn evaluate(&mut self, pos: &Position) -> i32 {
        match self.mode {
            NnueMode::Float => self.net.evaluate_cp(pos),
            _ => self.quant.evaluate_pos(pos),
        }
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
        Ok(AnyEval::Nnue(Box::new(NnueEval::new(Network::load(
            path,
        )?)?)))
    }

    /// Sets how a network is evaluated; no effect on G0.
    pub fn set_mode(&mut self, mode: NnueMode) {
        if let AnyEval::Nnue(n) = self {
            n.set_mode(mode);
        }
    }
}

impl Evaluator for AnyEval {
    fn reset(&mut self, pos: &Position) {
        if let AnyEval::Nnue(n) = self {
            n.reset(pos);
        }
    }
    fn make(&mut self, pos: &Position, m: Move) {
        if let AnyEval::Nnue(n) = self {
            n.make(pos, m);
        }
    }
    fn unmake(&mut self) {
        if let AnyEval::Nnue(n) = self {
            n.unmake();
        }
    }
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
