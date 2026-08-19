import { describe, expect, it } from 'vitest';

type Product = { availableQuantity: number };

function canReserve(
  products: Map<string, Product>,
  items: Array<{ productId: string; quantity: number }>,
) {
  const requested = new Map<string, number>();
  for (const item of items)
    requested.set(item.productId, (requested.get(item.productId) ?? 0) + item.quantity);
  return [...requested].every(
    ([productId, quantity]) => (products.get(productId)?.availableQuantity ?? 0) >= quantity,
  );
}

describe('reservation quantity validation', () => {
  it('rejects a multi-item reservation when any requested product is unavailable', () => {
    const products = new Map<string, Product>([
      ['keyboard', { availableQuantity: 2 }],
      ['dock', { availableQuantity: 0 }],
    ]);
    expect(
      canReserve(products, [
        { productId: 'keyboard', quantity: 1 },
        { productId: 'dock', quantity: 1 },
      ]),
    ).toBe(false);
    expect(products.get('keyboard')?.availableQuantity).toBe(2);
  });

  it('combines duplicate product lines before validating stock', () => {
    const products = new Map<string, Product>([['keyboard', { availableQuantity: 1 }]]);
    expect(
      canReserve(products, [
        { productId: 'keyboard', quantity: 1 },
        { productId: 'keyboard', quantity: 1 },
      ]),
    ).toBe(false);
  });
});
