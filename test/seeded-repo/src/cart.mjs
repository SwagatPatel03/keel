// A tiny shopping cart. Keel's replay tests copy this project into a temporary
// folder and seed failures into it (wrong totals, deleted or skipped tests).

export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function applyDiscount(amount, percent) {
  return Math.round(amount * (100 - percent)) / 100;
}
