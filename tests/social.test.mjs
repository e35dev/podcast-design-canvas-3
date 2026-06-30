// tests/social.test.mjs — derived speaker names from social URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const S = PDC.social;

test("handleFromSocialUrl derives names from common platforms", () => {
  assert.equal(S.handleFromSocialUrl("https://x.com/alice_host"), "Alice Host");
  assert.equal(S.handleFromSocialUrl("https://twitter.com/bob-guest"), "Bob Guest");
  assert.equal(S.handleFromSocialUrl("https://linkedin.com/in/carol-speaker"), "Carol Speaker");
  assert.equal(S.handleFromSocialUrl("https://instagram.com/dana.creator"), "Dana Creator");
  assert.equal(S.handleFromSocialUrl(""), "");
  assert.equal(S.handleFromSocialUrl("https://example.com"), "");
});

test("displayNameForSocial falls back to bucket label when URL has no handle", () => {
  assert.equal(S.displayNameForSocial("https://x.com/alicehost", "Host"), "Alicehost");
  assert.equal(S.displayNameForSocial("", "Guest 1"), "Guest 1");
});
