//! Endgame tablebases for KnightChess (ruleset `knightchess-2`).
//!
//! A table holds every position of one material signature (pieces on the board and in reserve
//! for both sides) with its exact result and distance to the end of the game. Captures remove
//! pieces for good and drops move a piece from reserve to the board, so every move either stays
//! in its table or leads to one with fewer pieces, or as many but fewer in reserve. Tables are
//! solved in that order, each by retrograde analysis (`solve`).

pub mod brute;
pub mod index;
pub mod sig;
pub mod solve;
pub mod table;

pub use sig::{all_sigs, canonical_sigs, Sig};
pub use table::{decode_value, Table, Tables, Wdl};
