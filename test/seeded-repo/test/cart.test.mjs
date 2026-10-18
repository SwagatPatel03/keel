import test from 'node:test';
import assert from 'node:assert/strict';
import { total, applyDiscount } from '../src/cart.mjs';

test('total adds price times quantity', () => {
  assert.equal(total([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]), 11);
});

test('total of an empty cart is zero', () => {
  assert.equal(total([]), 0);
});

test('applyDiscount takes a percentage off', () => {
  assert.equal(applyDiscount(200, 10), 180);
});
