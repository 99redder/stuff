import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../mom-budget-phone.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function phone() {
  const elements = new Map(), intervals = new Map(), timeouts = new Map(), events = new Map();
  let id = 0, now = 100000, calls = 0, amount = 500, stall = false;
  const element = key => {
    if (!elements.has(key)) elements.set(key, {
      textContent: '', innerHTML: '', style: {}, disabled: false, children: [],
      classList: { toggle() {}, contains() { return false; } },
      addEventListener() {}, setAttribute() {}, querySelector() { return null; },
      appendChild(child) { elements.set(child.id, child); }, remove() { elements.delete(this.id); },
    });
    return elements.get(key);
  };
  const document = {
    visibilityState: 'visible', getElementById: key => key === 'error-card' ? elements.get(key) : element(key),
    createElement: () => ({ remove() { elements.delete(this.id); } }), querySelector: element,
    addEventListener: (event, fn) => events.set(event, fn),
  };
  const context = vm.createContext({
    document, navigator: {}, window: { addEventListener: (event, fn) => events.set(event, fn) },
    Date: class extends Date { static now() { return now; } }, AbortController,
    setInterval: (fn, ms) => { intervals.set(++id, { fn, ms }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { timeouts.set(++id, { fn, ms }); return id; },
    clearTimeout: id => timeouts.delete(id),
    fetch: async (_url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).action, 'get_mom_budget_public_summary');
      assert.equal(options.cache, 'no-store');
      if (stall) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout'))));
      return { ok: true, json: async () => ({ monthKey: '2026-09', month: { overallSpendingRemaining: amount } }) };
    },
  });
  vm.runInContext(script, context);
  return {
    document, elements, intervals, timeouts, context,
    calls: () => calls, spend: () => { amount -= 37.84; }, stall: value => { stall = value; },
    wake: async visibility => { now += 5000; document.visibilityState = visibility; events.get('visibilitychange')(); await settle(); },
    tick: async () => { now += 5000; for (const { fn } of intervals.values()) fn(); await settle(); },
  };
}

test('phone shows new spending on its next five-second poll and pauses while hidden', async () => {
  const p = phone(); await settle();
  assert.equal(p.elements.get('overall').textContent, '$500.00');
  assert.equal([...p.intervals.values()][0].ms, 5000);
  p.spend(); await p.tick();
  assert.equal(p.elements.get('overall').textContent, '$462.16');
  await p.wake('hidden'); const calls = p.calls(); await p.tick();
  assert.equal(p.intervals.size, 0);
  assert.equal(p.calls(), calls);
  await p.wake('visible');
  assert.equal(p.calls(), calls + 1);
  assert.equal(p.intervals.size, 1);
});

test('stalled refresh times out, preserves marked-stale balances, and allows the next poll', async () => {
  const p = phone(); await settle(); p.stall(true); await p.tick();
  const calls = p.calls(); await p.tick();
  assert.equal(p.calls(), calls, 'no overlapping requests');
  const timeout = [...p.timeouts.values()][0]; assert.equal(timeout.ms, 10000);
  timeout.fn(); await settle();
  assert.equal(p.elements.get('overall').textContent, '$500.00');
  assert.match(p.elements.get('status').textContent, /out of date/);
  assert.equal(p.elements.get('refresh-button').disabled, false);
  p.stall(false); p.spend(); await p.tick();
  assert.equal(p.elements.get('overall').textContent, '$462.16');
  assert.equal(p.elements.has('error-card'), false);
});
