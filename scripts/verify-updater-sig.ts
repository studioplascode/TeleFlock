// Verifies updater signatures the way tauri-plugin-updater does before it installs anything:
// `<file>.sig` must be a valid minisign signature of <file> by the key in
// src-tauri/tauri.conf.json (`plugins.updater.pubkey`), its trusted comment must be authentic, and
// (requireSignedVersion) the comment's `version:` must equal the release version.
//
// Usage: bun scripts/verify-updater-sig.ts <version> <file>...   (reads <file>.sig next to each)
// Exit 1 with a reason on the first failure. Used by scripts/release.sh.
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [version, ...files] = process.argv.slice(2);
if (!version || files.length === 0) {
  console.error("usage: bun scripts/verify-updater-sig.ts <version> <file>...");
  process.exit(2);
}

const fail = (msg: string): never => {
  console.error(`verify-updater-sig: ${msg}`);
  process.exit(1);
};

/** The tauri key / signature files are base64 of a minisign text file. */
const minisignLines = (b64: string): string[] => Buffer.from(b64.trim(), "base64").toString("utf8").split("\n");

const conf = JSON.parse(readFileSync(join(import.meta.dir, "../src-tauri/tauri.conf.json"), "utf8"));
// Public key line: "Ed" | key id (8) | Ed25519 key (32).
const pub = Buffer.from(minisignLines(conf.plugins.updater.pubkey)[1].trim(), "base64");
if (pub.length !== 42 || pub.subarray(0, 2).toString() !== "Ed") fail("plugins.updater.pubkey is not a minisign Ed25519 key");
const pubKeyId = pub.subarray(2, 10);
const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub.subarray(10).toString("base64url") }, format: "jwk" });

for (const file of files) {
  const lines = minisignLines(readFileSync(`${file}.sig`, "utf8"));
  // Signature line: "ED" (BLAKE2b-512 prehashed) or "Ed" (legacy, raw) | key id (8) | signature (64).
  const sig = Buffer.from(lines[1]?.trim() ?? "", "base64");
  const trusted = lines[2]?.startsWith("trusted comment: ") ? lines[2].slice("trusted comment: ".length) : fail(`${file}.sig has no trusted comment`);
  const globalSig = Buffer.from(lines[3]?.trim() ?? "", "base64");
  if (sig.length !== 74 || globalSig.length !== 64) fail(`${file}.sig is malformed`);
  if (!sig.subarray(2, 10).equals(pubKeyId)) {
    fail(`${file}.sig is signed by key ${sig.subarray(2, 10).toString("hex")}, tauri.conf.json trusts ${pubKeyId.toString("hex")}`);
  }
  const alg = sig.subarray(0, 2).toString();
  const data = readFileSync(file);
  const message = alg === "ED" ? new Bun.CryptoHasher("blake2b512").update(data).digest() : alg === "Ed" ? data : fail(`${file}.sig: unknown algorithm ${alg}`);
  if (!verify(null, message, key, sig.subarray(10))) fail(`${file}.sig does not match ${file}`);
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), key, globalSig)) fail(`${file}.sig: trusted comment is not authentic`);
  const signed = /(?:^|\t)version:([^\t]+)/.exec(trusted)?.[1];
  if (signed !== version) fail(`${file}.sig is bound to version ${signed ?? "(none)"}, the release is ${version}`);
  console.log(`ok  ${file.split("/").pop()}  (key ${pubKeyId.toString("hex")}, version ${signed})`);
}
