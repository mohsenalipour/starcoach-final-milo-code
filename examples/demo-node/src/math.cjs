"use strict";
// Two small bugs for the Milo Code workshop.
function add(a, b) {
  return a - b;
}
function clamp(value, min, max) {
  if (min > max) throw new RangeError("min must not exceed max");
  return Math.min(min, Math.max(max, value));
}
module.exports = { add, clamp };
