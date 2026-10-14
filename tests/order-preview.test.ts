import test from "node:test";
import assert from "node:assert/strict";
import { orderPreview } from "../lib/order-preview.ts";

test("invalid quantities never produce a cost or payout preview", () => {
  for (const value of ["", " ", "-1", "0", "1.5", "100001", "Infinity", "NaN", "9007199254740993"]) {
    const preview = orderPreview(value, .4);
    assert.equal(preview.quantity, null, value);
    assert.equal(preview.total, null, value);
    assert.ok(preview.quantityError, value);
  }
});

test("only whole-cent prices between 1 and 99 cents produce a total", () => {
  for (const value of [undefined, null, 0, -1, 1, .001, .015, .00999999999, .99000000001, NaN, Infinity]) {
    const preview = orderPreview("25", value);
    assert.equal(preview.price, null, String(value));
    assert.equal(preview.total, null, String(value));
    assert.ok(preview.priceError, String(value));
  }
});

test("valid boundary drafts and normal cents retain the correct financial preview", () => {
  assert.equal(orderPreview("1", .01).total, .01);
  assert.equal(orderPreview("100000", .99).total, 99000);
  const preview = orderPreview("25", .29);
  assert.equal(preview.quantity, 25);
  assert.equal(preview.price, .29);
  assert.ok(Math.abs(preview.total! - 7.25) < 1e-10);
  assert.equal(preview.quantityError, null);
  assert.equal(preview.priceError, null);
});

test("correcting a draft clears its validation without a submit", () => {
  assert.ok(orderPreview("-1", 0).quantityError);
  assert.ok(orderPreview("25", 0).priceError);
  assert.equal(orderPreview("25", .4).quantityError, null);
  assert.equal(orderPreview("25", .4).priceError, null);
  assert.equal(orderPreview("25", .4).total, 10);
});
