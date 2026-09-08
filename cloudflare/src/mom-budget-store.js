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

  async alarm() {
    const data = await this.ctx.storage.get('budget');
    if (data !== undefined) {
      // Alarms retry failed writes. A concurrent save schedules another alarm,
      // so the backup eventually catches up without ever serving stale reads.
      await this.env.RENTALS.put('mom_budget', JSON.stringify(data));
    }
  }
}
