import test from "node:test";
import assert from "node:assert/strict";
import * as api from "../dist/index.js";
import {
  DpapiError,
  DpapiUnsupportedPlatformError,
  decryptSecret,
  decryptSecretFromFile,
  encryptSecret,
  encryptSecretToFile,
  isDpapiSupported,
} from "../dist/index.js";

const PUBLIC_FUNCTIONS = [
  "isDpapiSupported",
  "encryptSecret",
  "decryptSecret",
  "encryptSecretToFile",
  "decryptSecretFromFile",
];

test("public API exposes the documented functions", () => {
  for (const name of PUBLIC_FUNCTIONS) {
    assert.equal(typeof api[name], "function", `${name} should be exported as a function`);
  }
});

test("public API exposes the documented error classes", () => {
  assert.equal(typeof api.DpapiError, "function");
  assert.equal(typeof api.DpapiUnsupportedPlatformError, "function");
  assert.equal(typeof api.DpapiError.prototype, "object");
});

test("isDpapiSupported() matches process.platform", () => {
  assert.equal(isDpapiSupported(), process.platform === "win32");
  assert.equal(typeof isDpapiSupported(), "boolean");
});

test("DpapiUnsupportedPlatformError names the platform and points at isDpapiSupported()", () => {
  const error = new DpapiUnsupportedPlatformError("linux");
  assert.ok(error instanceof DpapiUnsupportedPlatformError);
  assert.ok(error instanceof DpapiError);
  assert.ok(error instanceof Error);
  assert.equal(error.code, "UNSUPPORTED_PLATFORM");
  assert.match(error.message, /linux/);
  assert.match(error.message, /isDpapiSupported/);
  assert.equal(error.name, "DpapiUnsupportedPlatformError");
});

test("DpapiError keeps the typed code and optional cause", () => {
  const cause = new Error("inner cause");
  const error = new DpapiError("DPAPI_FAILURE", "outer message", cause);
  assert.equal(error.code, "DPAPI_FAILURE");
  assert.equal(error.message, "outer message");
  assert.equal(error.cause, cause);
  assert.equal(error.name, "DpapiError");
});

// Keep the imported bindings referenced so the static import list above matches
// the real public surface, even on platforms where the DPAPI tests are skipped.
void decryptSecret;
void decryptSecretFromFile;
void encryptSecret;
void encryptSecretToFile;
