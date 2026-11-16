import assert from "node:assert/strict";
import { test } from "node:test";
import { registrationFile, toFeedbackValue } from "./erc8004.ts";

test("edge score → signed 6-decimal feedback value", () => {
  assert.equal(toFeedbackValue(0.103322), 103322n);
  assert.equal(toFeedbackValue(-0.0525), -52500n);
  assert.equal(toFeedbackValue(0), 0n);
  assert.equal(toFeedbackValue(1), 1_000_000n);
  assert.equal(toFeedbackValue(-1), -1_000_000n);
});

test("registration file names the x402 endpoint and wallet", () => {
  const reg = registrationFile("vol");
  assert.ok(reg);
  assert.equal(reg.x402Support, true);
  assert.ok(reg.services.some((s) => s.name === "x402" && s.endpoint.includes("/forecast/vol/")));
  assert.equal(registrationFile("nobody"), null);
});
