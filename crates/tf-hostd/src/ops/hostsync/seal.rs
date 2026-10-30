//! End-to-end sealing of secrets from one host to another (`hostSync.keyBegin`, `hostSync.seal`,
//! `hostSync.apply`). The app only relays the ciphertext.
//!
//! Suite [`SYNC_SUITE`] (`x25519-hkdf-sha256-aes256gcm/1`, the ECIES / HPKE base-mode shape):
//! * The target makes a one-time X25519 key pair ([`Keys::begin`]). Its private half stays in this
//!   daemon's memory, is taken out for one `hostSync.apply` ([`Keys::take`]) and is gone after
//!   [`KEY_TTL`] anyway.
//! * The source makes an ephemeral X25519 pair of its own, agrees on a shared secret with the
//!   target's public key and derives a 256-bit key with HKDF-SHA256 (salt: the suite; info: the
//!   transfer id and both public keys). AES-256-GCM with a random 96-bit nonce encrypts the
//!   secrets; the suite, the transfer id, both public keys and the item ids are its associated
//!   data, so none of them can be swapped on the way.
//! * An all-zero shared secret (a low-order public key) is refused on both sides.
//!
//! The primitives come from crates TeleFlock already builds: `curve25519-dalek` (X25519 is
//! `MontgomeryPoint::mul_clamped`, the function `x25519-dalek` wraps; russh's curve25519-sha256
//! key exchange uses the same crate), `hkdf` + `sha2` (RustCrypto) and `aes-gcm` (RustCrypto; omp
//! collab's room cipher in tf-collab). Secret buffers are zeroized when dropped.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use curve25519_dalek::montgomery::MontgomeryPoint;
use hkdf::Hkdf;
use sha2::Sha256;
use tf_proto::{ApiError, Millis, SyncKey, SyncSealed, SYNC_SUITE};
use zeroize::Zeroizing;

/// How long a one-time key waits for its `hostSync.apply`.
pub const KEY_TTL: Duration = Duration::from_secs(10 * 60);
/// Keys waiting at once; a new one replaces the one that expires first.
const MAX_KEYS: usize = 8;
/// Largest sealed payload (an `omp auth export` of many accounts is a few KiB).
pub const MAX_PLAINTEXT: usize = 1 << 20;
const NONCE_LEN: usize = 12;
/// AES-GCM tag.
const TAG_LEN: usize = 16;

/// An X25519 key pair; the private half is wiped when dropped.
pub struct KeyPair {
    secret: Zeroizing<[u8; 32]>,
    public: [u8; 32],
}

impl KeyPair {
    pub fn generate() -> Result<KeyPair, ApiError> {
        let mut secret = Zeroizing::new([0u8; 32]);
        getrandom::fill(secret.as_mut()).map_err(|e| ApiError::new("internal", format!("OS random source: {e}")))?;
        let public = MontgomeryPoint::mul_base_clamped(*secret).to_bytes();
        Ok(KeyPair { secret, public })
    }

    #[cfg(test)]
    pub fn from_secret(secret: [u8; 32]) -> KeyPair {
        KeyPair { public: MontgomeryPoint::mul_base_clamped(secret).to_bytes(), secret: Zeroizing::new(secret) }
    }
}

/// X25519 (RFC 7748): `secret` × `public`. `None` for the all-zero output of a low-order point.
fn agree(secret: &[u8; 32], public: &[u8; 32]) -> Option<Zeroizing<[u8; 32]>> {
    let shared = Zeroizing::new(MontgomeryPoint(*public).mul_clamped(*secret).to_bytes());
    (!shared.iter().all(|b| *b == 0)).then_some(shared)
}

fn derive(shared: &[u8; 32], transfer_id: &str, sender: &[u8; 32], recipient: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(Some(SYNC_SUITE.as_bytes()), shared);
    let mut info = Vec::with_capacity(transfer_id.len() + 65);
    info.extend_from_slice(transfer_id.as_bytes());
    info.push(0);
    info.extend_from_slice(sender);
    info.extend_from_slice(recipient);
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(&info, key.as_mut()).expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

/// Associated data: everything the ciphertext must stay bound to.
fn associated(transfer_id: &str, sender: &[u8; 32], recipient: &[u8; 32], items: &[String]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(SYNC_SUITE.len() + transfer_id.len() + 67 + items.iter().map(|i| i.len() + 1).sum::<usize>());
    aad.extend_from_slice(SYNC_SUITE.as_bytes());
    aad.push(0);
    aad.extend_from_slice(transfer_id.as_bytes());
    aad.push(0);
    aad.extend_from_slice(sender);
    aad.extend_from_slice(recipient);
    for item in items {
        aad.push(0);
        aad.extend_from_slice(item.as_bytes());
    }
    aad
}

fn decode_key(b64: &str, what: &str) -> Result<[u8; 32], ApiError> {
    let raw = B64.decode(b64.trim()).map_err(|_| ApiError::new("invalid_params", format!("{what}: not base64")))?;
    <[u8; 32]>::try_from(raw.as_slice()).map_err(|_| ApiError::new("invalid_params", format!("{what}: an X25519 public key has 32 bytes")))
}

/// Encrypts `plaintext` for the holder of `recipient` (base64), bound to `transfer_id` and `items`.
pub fn seal(recipient: &str, transfer_id: &str, items: Vec<String>, plaintext: &[u8]) -> Result<SyncSealed, ApiError> {
    let recipient = decode_key(recipient, "publicKey")?;
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(ApiError::new("invalid_params", format!("the secrets come to {} bytes; at most {MAX_PLAINTEXT} can be sealed", plaintext.len())));
    }
    let ephemeral = KeyPair::generate()?;
    let shared = agree(&ephemeral.secret, &recipient).ok_or_else(|| ApiError::new("invalid_params", "publicKey: not a usable X25519 public key"))?;
    let key = derive(&shared, transfer_id, &ephemeral.public, &recipient);
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|e| ApiError::new("internal", format!("OS random source: {e}")))?;
    let aad = associated(transfer_id, &ephemeral.public, &recipient, &items);
    let ciphertext = Aes256Gcm::new((&*key).into())
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: &aad })
        .map_err(|_| ApiError::new("internal", "sealing failed"))?;
    Ok(SyncSealed {
        suite: SYNC_SUITE.into(),
        transfer_id: transfer_id.into(),
        sender_key: B64.encode(ephemeral.public),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
        items,
    })
}

fn tampered() -> ApiError {
    ApiError::new(
        "sealed_invalid",
        "The sealed secrets don't open with this host's one-time key: they were changed on the way or sealed for another transfer. Nothing was applied.",
    )
    .with_hint("Start the copy again.")
}

/// Decrypts `sealed` with `pair` (consumed: a one-time key opens one box).
pub fn open(pair: KeyPair, sealed: &SyncSealed) -> Result<Zeroizing<Vec<u8>>, ApiError> {
    if sealed.suite != SYNC_SUITE {
        return Err(ApiError::new("unsupported", format!("sealed with `{}`; this host opens `{SYNC_SUITE}`", sealed.suite)).with_hint("Update TeleFlock on both hosts."));
    }
    let sender = decode_key(&sealed.sender_key, "senderKey")?;
    let nonce = B64.decode(sealed.nonce.trim()).ok().filter(|n| n.len() == NONCE_LEN).ok_or_else(tampered)?;
    let ciphertext = B64.decode(sealed.ciphertext.trim()).ok().filter(|c| c.len() >= TAG_LEN && c.len() <= MAX_PLAINTEXT + TAG_LEN).ok_or_else(tampered)?;
    let shared = agree(&pair.secret, &sender).ok_or_else(tampered)?;
    let key = derive(&shared, &sealed.transfer_id, &sender, &pair.public);
    let aad = associated(&sealed.transfer_id, &sender, &pair.public, &sealed.items);
    Aes256Gcm::new((&*key).into())
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ciphertext, aad: &aad })
        .map(Zeroizing::new)
        .map_err(|_| tampered())
}

struct Waiting {
    pair: KeyPair,
    expires: Instant,
}

/// One-time keys waiting for their `hostSync.apply`, by transfer id.
pub struct Keys {
    map: Mutex<HashMap<String, Waiting>>,
}

/// The daemon's keys.
pub static KEYS: LazyLock<Keys> = LazyLock::new(Keys::new);

impl Keys {
    pub fn new() -> Keys {
        Keys { map: Mutex::new(HashMap::new()) }
    }

    /// A fresh key pair for one transfer; answers its public half.
    pub fn begin(&self, now: Instant, now_ms: Millis) -> Result<SyncKey, ApiError> {
        let pair = KeyPair::generate()?;
        let mut id = [0u8; 16];
        getrandom::fill(&mut id).map_err(|e| ApiError::new("internal", format!("OS random source: {e}")))?;
        let transfer_id: String = id.iter().map(|b| format!("{b:02x}")).collect();
        let key = SyncKey {
            transfer_id: transfer_id.clone(),
            public_key: B64.encode(pair.public),
            suite: SYNC_SUITE.into(),
            expires_at: now_ms + KEY_TTL.as_millis() as Millis,
        };
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        map.retain(|_, w| w.expires > now);
        while map.len() >= MAX_KEYS {
            let Some(first) = map.iter().min_by_key(|(_, w)| w.expires).map(|(k, _)| k.clone()) else { break };
            map.remove(&first);
        }
        map.insert(transfer_id, Waiting { pair, expires: now + KEY_TTL });
        Ok(key)
    }

    /// Takes the key pair of `transfer_id` out (one use), unless it expired.
    pub fn take(&self, transfer_id: &str, now: Instant) -> Result<KeyPair, ApiError> {
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        map.remove(transfer_id).filter(|w| w.expires > now).map(|w| w.pair).ok_or_else(|| {
            ApiError::new("expired", "This transfer's one-time key is gone: it was used already, or 10 minutes passed. Nothing was applied.")
                .with_hint("Start the copy again.")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex32(s: &str) -> [u8; 32] {
        let v: Vec<u8> = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect();
        v.try_into().unwrap()
    }

    #[test]
    fn x25519_matches_rfc_7748() {
        // RFC 7748 §6.1.
        let alice = KeyPair::from_secret(hex32("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"));
        let bob = KeyPair::from_secret(hex32("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb"));
        assert_eq!(alice.public, hex32("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"));
        assert_eq!(bob.public, hex32("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"));
        let shared = hex32("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
        assert_eq!(*agree(&alice.secret, &bob.public).unwrap(), shared);
        assert_eq!(*agree(&bob.secret, &alice.public).unwrap(), shared);
        // A low-order point gives the all-zero secret: refused.
        assert!(agree(&alice.secret, &[0u8; 32]).is_none());
    }

    fn items() -> Vec<String> {
        vec!["signIn:anthropic|0123456789ab".into(), "mcpSecrets:github".into()]
    }

    #[test]
    fn round_trip() {
        let keys = Keys::new();
        let now = Instant::now();
        let key = keys.begin(now, 1_000).unwrap();
        assert_eq!(key.suite, SYNC_SUITE);
        assert_eq!(key.expires_at, 1_000 + 600_000);
        let secret = br#"{"auth":{"version":1,"credentials":[{"provider":"openai","credential":{"type":"api_key","key":"sk-live-TOPSECRET"}}]}}"#;
        let sealed = seal(&key.public_key, &key.transfer_id, items(), secret).unwrap();
        let wire = serde_json::to_string(&sealed).unwrap();
        assert!(!wire.contains("TOPSECRET") && !wire.contains("sk-live"), "no plaintext on the wire: {wire}");
        assert_eq!(sealed.items, items());
        let opened = open(keys.take(&key.transfer_id, now).unwrap(), &sealed).unwrap();
        assert_eq!(opened.as_slice(), secret);
        // One use: the key is gone.
        assert_eq!(keys.take(&key.transfer_id, now).err().unwrap().code, "expired");
    }

    #[test]
    fn tampering_is_rejected() {
        let pair = KeyPair::generate().unwrap();
        let public = B64.encode(pair.public);
        let secret = b"api key: sk-live-TOPSECRET";
        let sealed = seal(&public, "t1", items(), secret).unwrap();
        let reopen = |s: &SyncSealed, p: &KeyPair| open(KeyPair { secret: Zeroizing::new(*p.secret), public: p.public }, s);
        assert_eq!(reopen(&sealed, &pair).unwrap().as_slice(), secret);

        let mut ct = B64.decode(&sealed.ciphertext).unwrap();
        ct[3] ^= 1;
        let flipped = SyncSealed { ciphertext: B64.encode(&ct), ..sealed.clone() };
        assert_eq!(reopen(&flipped, &pair).unwrap_err().code, "sealed_invalid");

        let mut tag = B64.decode(&sealed.ciphertext).unwrap();
        let last = tag.len() - 1;
        tag[last] ^= 0x80;
        assert_eq!(reopen(&SyncSealed { ciphertext: B64.encode(&tag), ..sealed.clone() }, &pair).unwrap_err().code, "sealed_invalid");

        // The item list, the transfer id, the nonce and the sender key are bound to it.
        let more = SyncSealed { items: vec!["signIn:anthropic|0123456789ab".into()], ..sealed.clone() };
        assert_eq!(reopen(&more, &pair).unwrap_err().code, "sealed_invalid");
        assert_eq!(reopen(&SyncSealed { transfer_id: "t2".into(), ..sealed.clone() }, &pair).unwrap_err().code, "sealed_invalid");
        assert_eq!(reopen(&SyncSealed { nonce: B64.encode([7u8; 12]), ..sealed.clone() }, &pair).unwrap_err().code, "sealed_invalid");
        let other = KeyPair::generate().unwrap();
        assert_eq!(reopen(&SyncSealed { sender_key: B64.encode(other.public), ..sealed.clone() }, &pair).unwrap_err().code, "sealed_invalid");
        assert_eq!(reopen(&SyncSealed { sender_key: B64.encode([0u8; 32]), ..sealed.clone() }, &pair).unwrap_err().code, "sealed_invalid");
        // Truncated or garbled fields.
        assert_eq!(reopen(&SyncSealed { ciphertext: B64.encode([1u8; 8]), ..sealed.clone() }, &pair).unwrap_err().code, "sealed_invalid");
        assert_eq!(reopen(&SyncSealed { nonce: "!!".into(), ..sealed.clone() }, &pair).unwrap_err().code, "sealed_invalid");
        assert_eq!(reopen(&SyncSealed { suite: "rot13/1".into(), ..sealed.clone() }, &pair).unwrap_err().code, "unsupported");

        // Another host's key can't open it.
        assert_eq!(reopen(&sealed, &other).unwrap_err().code, "sealed_invalid");
        // A low-order or malformed recipient key is refused before anything is sealed.
        assert_eq!(seal(&B64.encode([0u8; 32]), "t1", items(), secret).unwrap_err().code, "invalid_params");
        assert_eq!(seal("AAAA", "t1", items(), secret).unwrap_err().code, "invalid_params");
        assert_eq!(seal(&public, "t1", items(), &vec![0u8; MAX_PLAINTEXT + 1]).unwrap_err().code, "invalid_params");
    }

    #[test]
    fn keys_expire_and_are_capped() {
        let keys = Keys::new();
        let t0 = Instant::now();
        let k = keys.begin(t0, 0).unwrap();
        assert_eq!(keys.take(&k.transfer_id, t0 + KEY_TTL + Duration::from_secs(1)).err().unwrap().code, "expired");
        assert_eq!(keys.take("nope", t0).err().unwrap().code, "expired");
        let ids: Vec<String> = (0..MAX_KEYS + 2).map(|i| keys.begin(t0 + Duration::from_secs(i as u64), 0).unwrap().transfer_id).collect();
        assert!(keys.take(&ids[0], t0).is_err(), "the oldest gave way");
        assert!(keys.take(&ids[1], t0).is_err());
        assert!(keys.take(&ids[MAX_KEYS + 1], t0).is_ok());
        // Every key is new.
        let a = keys.begin(t0, 0).unwrap();
        let b = keys.begin(t0, 0).unwrap();
        assert_ne!(a.public_key, b.public_key);
        assert_ne!(a.transfer_id, b.transfer_id);
    }
}
