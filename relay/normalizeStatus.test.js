// Run with: node --test relay/normalizeStatus.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStatus } from "./normalizeStatus.js";

test("live play -- minute-formatted, matching Code.gs", () => {
  assert.equal(normalizeStatus("1H", 23), "23'");
  assert.equal(normalizeStatus("2H", 58), "58'");
  assert.equal(normalizeStatus("ET", 105), "105'");
  assert.equal(normalizeStatus("LIVE", 12), "12'");
});

test("finished -- plain FT, including extra time and penalties", () => {
  assert.equal(normalizeStatus("FT", 90), "FT");
  assert.equal(normalizeStatus("AET", 120), "FT", "extra time must still register as finished for scoring");
  assert.equal(normalizeStatus("PEN", 120), "FT", "penalties must still register as finished for scoring");
});

test("not started yet", () => {
  assert.equal(normalizeStatus("NS", null), "NS");
  assert.equal(normalizeStatus("TBD", null), "NS");
});

test("half time and anything else passes through unchanged", () => {
  assert.equal(normalizeStatus("HT", 45), "HT");
  assert.equal(normalizeStatus("SUSP", 30), "SUSP");
});
