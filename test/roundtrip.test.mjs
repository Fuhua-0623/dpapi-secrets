import test from "node:test";
import assert from "node:assert/strict";
import {
  DpapiError,
  decryptSecret,
  encryptSecret,
  isDpapiSupported,
} from "../dist/index.js";

const skip = isDpapiSupported() ? false : "Windows DPAPI is only available on Windows";
const winTest = (name, fn) => test(name, { skip }, fn);

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function assertDpapiError(expectedCode) {
  return (error) => {
    assert.ok(error instanceof DpapiError, `expected a DpapiError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

const ROUND_TRIP_CASES = [
  ["ASCII text", "correct horse battery staple"],
  ["non-ASCII text and emoji", "pä55wörd 🔐✓"],
  ["empty string", ""],
  ["10,000 character value", "aB3-".repeat(2500)],
  ["text with newlines and tabs", "line one\nline two\tend\r\n"],
];

for (const [label, value] of ROUND_TRIP_CASES) {
  winTest(`encryptSecret/decryptSecret round-trip: ${label}`, async () => {
    assert.equal(value.length, label.startsWith("10,000") ? 10000 : value.length);
    const encrypted = await encryptSecret(value);
    assert.equal(typeof encrypted, "string");
    assert.match(encrypted, BASE64_PATTERN, "ciphertext should be base64 text");
    const blob = Buffer.from(encrypted, "base64");
    assert.ok(blob.length > 0, "ciphertext should decode to a non-empty blob");
    assert.notEqual(encrypted, value);
    if (value.length > 0) {
      assert.ok(!encrypted.includes(value), "ciphertext must not contain the plaintext");
    }
    assert.equal(await decryptSecret(encrypted), value);
    // Decrypting the same blob twice must produce the same plaintext.
    assert.equal(await decryptSecret(encrypted), value);
  });
}

winTest("two encryptions of the same secret produce different blobs that decrypt identically", async () => {
  const first = await encryptSecret("deterministic-check");
  const second = await encryptSecret("deterministic-check");
  assert.notEqual(first, second, "DPAPI should use fresh randomness for each protect call");
  assert.equal(await decryptSecret(first), "deterministic-check");
  assert.equal(await decryptSecret(second), "deterministic-check");
});

winTest("a tampered blob (flipped byte) is rejected with DPAPI_FAILURE", async () => {
  const encrypted = await encryptSecret("tamper target");
  const blob = Buffer.from(encrypted, "base64");
  const tampered = Buffer.from(blob);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  await assert.rejects(() => decryptSecret(tampered.toString("base64")), assertDpapiError("DPAPI_FAILURE"));
});

winTest("a truncated blob is rejected with DPAPI_FAILURE", async () => {
  const encrypted = await encryptSecret("truncate target");
  const blob = Buffer.from(encrypted, "base64");
  const truncated = blob.subarray(0, Math.max(1, blob.length - 8));
  await assert.rejects(() => decryptSecret(truncated.toString("base64")), assertDpapiError("DPAPI_FAILURE"));
});

winTest("base64 that is not a DPAPI blob is rejected with DPAPI_FAILURE", async () => {
  const notABlob = Buffer.from("this is definitely not a DPAPI blob", "utf8").toString("base64");
  await assert.rejects(() => decryptSecret(notABlob), assertDpapiError("DPAPI_FAILURE"));
});

winTest("the CurrentUser scope round-trips", async () => {
  const encrypted = await encryptSecret("scoped secret", { scope: "CurrentUser" });
  assert.equal(await decryptSecret(encrypted, { scope: "CurrentUser" }), "scoped secret");
});

winTest("an explicit timeoutMs and powershellPath are accepted", async () => {
  const encrypted = await encryptSecret("configured secret", {
    timeoutMs: 60_000,
    powershellPath: "powershell.exe",
  });
  assert.equal(await decryptSecret(encrypted, { timeoutMs: 60_000, powershellPath: "powershell.exe" }), "configured secret");
});
