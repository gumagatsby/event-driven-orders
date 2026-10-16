import { mergeLines, PlaceOrder, requestHash } from './orders.service.js';

describe('order helpers', () => {
  it('merges repeated SKUs and sorts lines', () => {
    expect(mergeLines([{ sku: 'B', quantity: 1 }, { sku: 'A', quantity: 2 }, { sku: 'B', quantity: 3 }])).toEqual([
      { sku: 'A', quantity: 2 },
      { sku: 'B', quantity: 4 },
    ]);
  });

  it('hashes equivalent orders identically', () => {
    const a = { customerId: 'c1', lines: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 1 }] };
    const b = { customerId: 'c1', lines: [{ sku: 'B', quantity: 1 }, { sku: 'A', quantity: 1 }] };
    expect(requestHash(a)).toBe(requestHash(b));
    expect(requestHash(a)).not.toBe(requestHash({ ...a, customerId: 'c2' }));
  });

  it.each([
    [{}, 'missing fields'],
    [{ customerId: 'c', lines: [] }, 'no lines'],
    [{ customerId: 'c', lines: [{ sku: 'A', quantity: 0 }] }, 'zero quantity'],
    [{ customerId: 'c', lines: [{ sku: 'A', quantity: 1.5 }] }, 'fractional quantity'],
    [{ customerId: 'c', lines: [{ sku: '', quantity: 1 }] }, 'empty SKU'],
  ])('rejects %j (%s)', (body: object, _why: string) => {
    expect(PlaceOrder.safeParse(body).success).toBe(false);
  });
});
