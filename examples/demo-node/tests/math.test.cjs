"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { add, clamp } = require("../src/math.cjs");
test("add handles positive, negative and zero values", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-2, -3), -5);
  assert.equal(add(0, 7), 7);
});
test("clamp preserves an in-range value", () =>
  assert.equal(clamp(5, 0, 10), 5));
test("clamp handles both boundaries and negative values", () => {
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(20, 0, 10), 10);
  assert.equal(clamp(-3, -5, -1), -3);
  assert.equal(clamp(4, 4, 4), 4);
});
test("clamp rejects a reversed range", () =>
  assert.throws(() => clamp(1, 10, 0), RangeError));
