import test from 'node:test';
import assert from 'node:assert/strict';
import { stockStickiesRecentSales } from './stock-stickies-sales.js';

const sell = (overrides) => ({
  id: Math.random().toString(36).slice(2),
  stockStickiesAccount: 'individual',
  date: '2026-10-01',
  type: 'sell',
  subtype: 'sell',
  ticker: 'NVDA',
  securityType: 'equity',
  quantity: -10,
  price: 190,
  amount: -1900,
  optionContract: null,
  cancelTransactionId: null,
  ...overrides,
});

test('fills of one sale combine into one row with a weighted price', () => {
  const sales = stockStickiesRecentSales([
    sell({ quantity: -10, price: 190, amount: -1900 }),
    sell({ quantity: -30, price: 194, amount: -5820 }),
  ]);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].quantity, 40);
  assert.equal(sales[0].price, 193);
  assert.equal(sales[0].proceeds, 7720);
  assert.equal(sales[0].fills, 2);
});

test('buys, options, SGOV and cancelled sales are left out', () => {
  const cancelled = sell({ ticker: 'AMD' });
  const sales = stockStickiesRecentSales([
    sell({ type: 'buy', subtype: 'buy', quantity: 5 }),
    sell({ ticker: 'NVDA', optionContract: { contractType: 'put' }, securityType: 'derivative' }),
    sell({ ticker: 'SGOV', price: 100.5 }),
    cancelled,
    sell({ type: 'cancel', subtype: 'cancel', cancelTransactionId: cancelled.id }),
    sell({ ticker: 'MU', account: 'roth', stockStickiesAccount: 'roth', date: '2026-10-10' }),
  ]);
  assert.deepEqual(sales.map((sale) => sale.ticker), ['MU']);
  assert.equal(sales[0].id, 'roth|MU|2026-10-10');
});

test('only the newest sales up to the limit are returned', () => {
  const sales = stockStickiesRecentSales(
    Array.from({ length: 60 }, (_, index) => sell({ ticker: `T${index}`, date: `2026-0${1 + Math.floor(index / 28)}-${String(1 + (index % 28)).padStart(2, '0')}` })),
    { limit: 50 },
  );
  assert.equal(sales.length, 50);
  assert.equal(sales[0].ticker, 'T59');
});

test('the same ticker sold in two accounts or on two days stays separate, newest first', () => {
  const sales = stockStickiesRecentSales([
    sell({ date: '2026-09-02' }),
    sell({ date: '2026-10-02' }),
    sell({ date: '2026-10-02', stockStickiesAccount: 'roth' }),
  ]);
  assert.deepEqual(sales.map((sale) => `${sale.date}:${sale.account}`), ['2026-10-02:individual', '2026-10-02:roth', '2026-09-02:individual']);
});
