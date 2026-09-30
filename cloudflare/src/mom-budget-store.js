import { DurableObject } from 'cloudflare:workers';

// One object for this household's Mom Budget. Both the editor and phone read
// the same durable record, without Workers KV's cross-location cache delay.
export class MomBudgetStore extends DurableObject {
  async getBudget() {
    const saved = await this.ctx.storage.get('budget');
    if (saved !== undefined) return saved;

    // Import the existing record once. A save can arrive during this KV read;
    // recheck inside a transaction so an older import never replaces it.
    const legacy = await this.env.RENTALS.get('mom_budget', 'json') || {};
    return this.ctx.storage.transaction(async txn => {
      const current = await txn.get('budget');
      if (current !== undefined) return current;
      await txn.put('budget', legacy);
      return legacy;
    });
  }

  async saveBudget(data) {
    // Commit the budget and a backup job together before acknowledging a save.
    // The phone can read immediately; KV backup latency is off the save path.
    await this.ctx.storage.transaction(async txn => {
      await txn.put('budget', data);
      await txn.setAlarm(Date.now() + 1000);
    });
  }

  // Append one ledger entry atomically, so an add from the phone snapshot app
  // can never be lost to (or clobber) a concurrent full save from the editor.
  async addLedgerEntry(monthKey, section, entry) {
    const current = await this.getBudget();
    return this.ctx.storage.transaction(async txn => {
      const data = (await txn.get('budget')) ?? current ?? {};
      if (!data.months || typeof data.months !== 'object') data.months = {};
      const month = data.months[monthKey] || (data.months[monthKey] = {});
      if (!Array.isArray(month[section])) month[section] = [];
      month[section].push(entry);
      await txn.put('budget', data);
      await txn.setAlarm(Date.now() + 1000);
      return data;
    });
  }

  // Remove one ledger entry by id, atomically (see addLedgerEntry).
  async removeLedgerEntry(monthKey, section, id) {
    const current = await this.getBudget();
    return this.ctx.storage.transaction(async txn => {
      const data = (await txn.get('budget')) ?? current ?? {};
      const list = data.months?.[monthKey]?.[section];
      const removed = Array.isArray(list) && list.some(e => e?.id === id);
      if (removed) {
        data.months[monthKey][section] = list.filter(e => e?.id !== id);
        await txn.put('budget', data);
        await txn.setAlarm(Date.now() + 1000);
      }
      return { data, removed };
    });
  }

  // Update one ledger entry's fields, atomically. A new date in another month
  // moves the entry into that month's ledger (ledgers are keyed by month).
  async updateLedgerEntry(monthKey, section, id, fields) {
    const current = await this.getBudget();
    return this.ctx.storage.transaction(async txn => {
      const data = (await txn.get('budget')) ?? current ?? {};
      const list = data.months?.[monthKey]?.[section];
      const index = Array.isArray(list) ? list.findIndex(e => e?.id === id) : -1;
      if (index < 0) return { data, updated: false };
      const entry = { ...list[index], ...fields, id };
      const targetKey = String(entry.date || '').slice(0, 7) || monthKey;
      if (targetKey === monthKey) {
        list[index] = entry;
      } else {
        list.splice(index, 1);
        const target = data.months[targetKey] || (data.months[targetKey] = {});
        if (!Array.isArray(target[section])) target[section] = [];
        target[section].push(entry);
      }
      await txn.put('budget', data);
      await txn.setAlarm(Date.now() + 1000);
      return { data, updated: true, entry };
    });
  }

  async alarm() {
    const data = await this.ctx.storage.get('budget');
    if (data !== undefined) {
      // Alarms retry failed writes. A concurrent save schedules another alarm,
      // so the backup eventually catches up without ever serving stale reads.
      await this.env.RENTALS.put('mom_budget', JSON.stringify(data));
    }
  }
}
