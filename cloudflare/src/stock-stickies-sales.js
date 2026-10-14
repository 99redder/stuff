// Recent stock sales for the Stock Stickies iPad "Lookback" page: one row per
// account, ticker and day, so several fills of one sale read as one sale.
// Input is the normalized investment-transaction list the performance code
// already caches (normalizeStockStickiesInvestmentTransactions).

// SGOV is the IRAs' cash; selling it is moving cash, not a sale worth reviewing.
const EXCLUDED_TICKERS = new Set(['SGOV']);

const isOption = (transaction) => Boolean(transaction?.optionContract)
  || ['derivative', 'option'].includes(String(transaction?.securityType || '').toLowerCase());

const isSale = (transaction) => String(transaction?.type || '').toLowerCase() === 'sell'
  && String(transaction?.subtype || '').toLowerCase() === 'sell'
  && !isOption(transaction)
  && /^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(String(transaction?.ticker || ''))
  && !EXCLUDED_TICKERS.has(String(transaction.ticker))
  && Number.isFinite(Number(transaction?.quantity))
  && Math.abs(Number(transaction.quantity)) > 0
  && Number.isFinite(Number(transaction?.price))
  && Number(transaction.price) > 0;

export function stockStickiesRecentSales(transactions, { limit = 50 } = {}) {
  const list = Array.isArray(transactions) ? transactions : [];
  // A transaction that cancels another removes both from the record.
  const cancelled = new Set(list.map((transaction) => transaction?.cancelTransactionId).filter(Boolean));
  const groups = new Map();
  for (const transaction of list) {
    if (!isSale(transaction) || transaction.cancelTransactionId || cancelled.has(transaction.id)) continue;
    const date = String(transaction.date || '').slice(0, 10);
    if (!date) continue;
    const key = `${transaction.stockStickiesAccount}|${transaction.ticker}|${date}`;
    const quantity = Math.abs(Number(transaction.quantity));
    const group = groups.get(key) || {
      date,
      time: null,
      account: transaction.stockStickiesAccount,
      ticker: transaction.ticker,
      assetClass: String(transaction.securityType || '').toLowerCase() === 'cryptocurrency' ? 'crypto' : 'stock',
      quantity: 0,
      value: 0,
      proceeds: 0,
      fills: 0,
    };
    group.quantity += quantity;
    group.value += quantity * Number(transaction.price);
    group.proceeds += Math.abs(Number(transaction.amount) || 0);
    group.fills += 1;
    const time = transaction.transactionDatetime || null;
    if (time && (!group.time || time > group.time)) group.time = time;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ value, ...group }) => ({
      ...group,
      quantity: Math.round(group.quantity * 1e6) / 1e6,
      price: Math.round((value / group.quantity) * 1e4) / 1e4,
      proceeds: Math.round(group.proceeds * 100) / 100,
    }))
    .sort((a, b) => (b.date.localeCompare(a.date)) || String(b.time || '').localeCompare(String(a.time || '')) || a.ticker.localeCompare(b.ticker))
    .slice(0, limit)
    .map((sale) => ({ ...sale, id: `${sale.account}|${sale.ticker}|${sale.date}` }));
}
