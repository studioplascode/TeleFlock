//! omp collab for `tf-hostd` (see `README.md` and `docs/research/omp-collab.md`).
//!
//! * [`link`]: collab link grammar.
//! * [`crypto`]: AES-256-GCM envelopes.
//! * [`frame`]: typed host/guest frames (`COLLAB_PROTO = 3`).
//! * [`relay`]: the loopback WebSocket relay embedded in `tf-hostd`.
//! * [`registry`]: discovery of hosted omp sessions (`~/.omp/run/collab-hosts` IPC, CLI fallback).
//! * [`guest`]: a reconnecting full-control guest.
//! * [`replica`]: omp frames → tf-proto session model, with delta compaction.

pub mod crypto;
pub mod frame;
pub mod guest;
pub mod link;
pub mod registry;
pub mod relay;
pub mod replica;

pub use crypto::{CryptoError, RoomKey};
pub use frame::{AgentCmdKind, COLLAB_PROTO, GuestFrame, HostFrame, ImageContent};
pub use guest::{EndReason, Guest, GuestError, GuestEvent, Snapshot, TranscriptChunk};
pub use link::{CollabLink, LinkError};
pub use registry::{Access, HostEntry, LinkInfo, Registry, RegistryError};
pub use relay::{IdentityError, Relay, RelayConfig, RelayIdentity, RelayStats};
pub use replica::{ArtifactCall, ArtifactKind, ArtifactLedger, Replica, Signal, Spend, UiReply, Update, transcript_page};
