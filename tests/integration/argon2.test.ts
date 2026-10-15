/**
 * Integration test: Argon2id password hashing.
 *
 * Verifies that @node-rs/argon2 works in this runtime, produces Argon2id
 * hashes, and verifies passwords correctly (both success and failure).
 * This test is NOT skipped — it must pass before any auth code is built.
 */

import { test, expect } from "bun:test";
import { hash, verify } from "@node-rs/argon2";

const params = {
  algorithm: 2, // Argon2id (Algorithm enum is a const enum, not accessible with isolatedModules)
  memoryCost: 19456, // 19 MiB — sane minimum
  timeCost: 2,
  parallelism: 1,
} as Parameters<typeof hash>[1];

test("argon2id hashes start with the standard prefix", async () => {
  const h = await hash("hunter2", params);
  expect(h.startsWith("$argon2id$")).toBe(true);
});

test("argon2id verifies the correct password as true", async () => {
  const h = await hash("correct-horse-battery-staple", params);
  const ok = await verify(h, "correct-horse-battery-staple");
  expect(ok).toBe(true);
});

test("argon2id verifies a wrong password as false", async () => {
  const h = await hash("right-password", params);
  const ok = await verify(h, "wrong-password");
  expect(ok).toBe(false);
});

test("argon2id uses a random salt — two hashes of the same password differ", async () => {
  const a = await hash("same-password", params);
  const b = await hash("same-password", params);
  expect(a).not.toBe(b);
  // Both must still verify the same password.
  expect(await verify(a, "same-password")).toBe(true);
  expect(await verify(b, "same-password")).toBe(true);
});
