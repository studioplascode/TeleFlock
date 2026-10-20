//! AES-256-GCM envelopes (`omp-collab.md` §3).
//!
//! ```text
//! envelope = peerId:u32 BE ‖ iv(12, random) ‖ AES-256-GCM(key, iv, json, aad = none)  (ct ‖ tag16)
//! ```

use std::fmt;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};

pub const ENVELOPE_HEADER_LENGTH: usize = 4;
pub const IV_LENGTH: usize = 12;
pub const TAG_LENGTH: usize = 16;
/// Per-frame overhead: header + iv + tag.
pub const ENVELOPE_OVERHEAD: usize = ENVELOPE_HEADER_LENGTH + IV_LENGTH + TAG_LENGTH;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    /// Shorter than header + iv + tag.
    Truncated,
    /// Authentication failed: wrong key or corrupted frame.
    Decrypt,
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => f.write_str("truncated collab envelope"),
            Self::Decrypt => f.write_str("bad key or corrupted frame"),
        }
    }
}
impl std::error::Error for CryptoError {}

/// A room key ready to seal/open envelopes.
#[derive(Clone)]
pub struct RoomKey {
    cipher: Aes256Gcm,
}

impl fmt::Debug for RoomKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RoomKey(..)")
    }
}

/// Read the routing prefix without decrypting.
pub fn envelope_peer(envelope: &[u8]) -> Option<u32> {
    envelope.get(..ENVELOPE_HEADER_LENGTH).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

/// Rewrite the routing prefix in place (what the relay does for guest frames).
pub fn set_envelope_peer(envelope: &mut [u8], peer_id: u32) -> bool {
    match envelope.get_mut(..ENVELOPE_HEADER_LENGTH) {
        Some(h) => {
            h.copy_from_slice(&peer_id.to_be_bytes());
            true
        }
        None => false,
    }
}

impl RoomKey {
    pub fn new(key: &[u8; 32]) -> RoomKey {
        RoomKey { cipher: Aes256Gcm::new(key.into()) }
    }

    /// Seal `plaintext` with a fresh random IV and prefix the routing header.
    pub fn seal(&self, peer_id: u32, plaintext: &[u8]) -> Vec<u8> {
        let mut iv = [0u8; IV_LENGTH];
        getrandom::fill(&mut iv).expect("OS random source unavailable");
        self.seal_with_iv(peer_id, &iv, plaintext)
    }

    pub(crate) fn seal_with_iv(&self, peer_id: u32, iv: &[u8; IV_LENGTH], plaintext: &[u8]) -> Vec<u8> {
        let ct = self
            .cipher
            .encrypt(Nonce::from_slice(iv), plaintext)
            .expect("AES-GCM encryption cannot fail for in-memory buffers");
        let mut out = Vec::with_capacity(ENVELOPE_HEADER_LENGTH + IV_LENGTH + ct.len());
        out.extend_from_slice(&peer_id.to_be_bytes());
        out.extend_from_slice(iv);
        out.extend_from_slice(&ct);
        out
    }

    /// Open an envelope; returns the routing peer id and the plaintext.
    pub fn open(&self, envelope: &[u8]) -> Result<(u32, Vec<u8>), CryptoError> {
        if envelope.len() < ENVELOPE_OVERHEAD {
            return Err(CryptoError::Truncated);
        }
        let peer = envelope_peer(envelope).ok_or(CryptoError::Truncated)?;
        let iv = &envelope[ENVELOPE_HEADER_LENGTH..ENVELOPE_HEADER_LENGTH + IV_LENGTH];
        let pt = self
            .cipher
            .decrypt(Nonce::from_slice(iv), &envelope[ENVELOPE_HEADER_LENGTH + IV_LENGTH..])
            .map_err(|_| CryptoError::Decrypt)?;
        Ok((peer, pt))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_layout() {
        let key = RoomKey::new(&[7u8; 32]);
        let env = key.seal(5, br#"{"t":"abort"}"#);
        assert_eq!(env.len(), 13 + ENVELOPE_OVERHEAD);
        assert_eq!(envelope_peer(&env), Some(5));
        let (peer, pt) = key.open(&env).unwrap();
        assert_eq!(peer, 5);
        assert_eq!(pt, br#"{"t":"abort"}"#);
        // fresh IV per frame
        assert_ne!(key.seal(0, b"x")[4..16], key.seal(0, b"x")[4..16]);
    }

    #[test]
    fn peer_prefix_is_unauthenticated() {
        let key = RoomKey::new(&[1u8; 32]);
        let mut env = key.seal(0, b"hello");
        assert!(set_envelope_peer(&mut env, 42));
        assert_eq!(key.open(&env).unwrap(), (42, b"hello".to_vec()));
    }

    #[test]
    fn wrong_key_and_truncation() {
        let env = RoomKey::new(&[1u8; 32]).seal(0, b"hello");
        assert_eq!(RoomKey::new(&[2u8; 32]).open(&env), Err(CryptoError::Decrypt));
        assert_eq!(RoomKey::new(&[1u8; 32]).open(&env[..20]), Err(CryptoError::Truncated));
        let mut tampered = env.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(RoomKey::new(&[1u8; 32]).open(&tampered), Err(CryptoError::Decrypt));
    }

    /// Known-answer test: NIST SP 800-38D / McGrew-Viega test case 13 (AES-256, zero key,
    /// zero IV, empty plaintext) — tag only. Confirms the `ct ‖ tag` layout WebCrypto uses.
    #[test]
    fn known_answer_empty() {
        let key = RoomKey::new(&[0u8; 32]);
        let env = key.seal_with_iv(0, &[0u8; 12], b"");
        assert_eq!(hex(&env[16..]), "530f8afbc74536b9a963b4f1c4cb738b");
    }

    /// Test case 14: AES-256, zero key, zero IV, one zero block.
    #[test]
    fn known_answer_block() {
        let key = RoomKey::new(&[0u8; 32]);
        let env = key.seal_with_iv(0, &[0u8; 12], &[0u8; 16]);
        assert_eq!(hex(&env[16..32]), "cea7403d4d606b6e074ec5d3baf39d18");
        assert_eq!(hex(&env[32..]), "d0d1c8a799996bf0265b98b5d48ab919");
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
