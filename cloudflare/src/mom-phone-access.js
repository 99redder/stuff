import { DurableObject } from 'cloudflare:workers';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

export const MOM_PHONE_API_ORIGIN = 'https://rentals-api.99redder.workers.dev';
export const MOM_PHONE_WEB_ORIGIN = 'https://99redder.github.io';
export const MOM_PHONE_SESSION_SECONDS = 30 * 24 * 60 * 60;
// Enrollment is deliberately closed after the approved devices are set up.
// Re-opening it requires an explicit code change and deployment; an old invite
// or stale admin page cannot add another device.
const MOM_PHONE_ENROLLMENT_LOCKED = true;
const FLOW_MS = 5 * 60 * 1000;
const INVITE_MS = 30 * 60 * 1000;
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const randomToken = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const hash = async text => encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
const tokenValid = value => typeof value === 'string' && /^[\w-]{43}$/.test(value);
function reject(message, status = 400) { throw Object.assign(new Error(message), { status }); }

// One coordination atom: this household's phone access. Synchronous SQL and
// transactionSync make invite consumption, revocation and challenge use atomic.
// Only hashes of bearer credentials are stored; passkeys store public keys only.
export class MomPhoneAccess extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires REAL, PRIMARY KEY (kind, key))');
  }

  get(kind, key) {
    const row = this.sql.exec('SELECT value, expires FROM records WHERE kind = ? AND key = ?', kind, key).toArray()[0];
    if (!row || (row.expires !== null && row.expires <= Date.now())) return null;
    return JSON.parse(row.value);
  }
  put(kind, key, value, expires = null) {
    this.sql.exec('INSERT OR REPLACE INTO records (kind, key, value, expires) VALUES (?, ?, ?, ?)', kind, key, JSON.stringify(value), expires);
  }
  remove(kind, key) { this.sql.exec('DELETE FROM records WHERE kind = ? AND key = ?', kind, key); }
  rows(kind) {
    return this.sql.exec('SELECT key, value FROM records WHERE kind = ? AND (expires IS NULL OR expires > ?)', kind, Date.now()).toArray()
      .map(row => ({ key: row.key, ...JSON.parse(row.value) }));
  }
  cleanup() { this.sql.exec('DELETE FROM records WHERE expires IS NOT NULL AND expires <= ?', Date.now()); }
  closeEnrollmentData() {
    if (MOM_PHONE_ENROLLMENT_LOCKED) this.sql.exec("DELETE FROM records WHERE kind IN ('invite', 'flow')");
  }
  origin() { return this.env.MOM_PHONE_WEB_ORIGIN || MOM_PHONE_WEB_ORIGIN; }

  // Error details from cryptographic verification never leave the object.
  async call(action, input = {}) {
    try {
      switch (action) {
        case 'list': return this.listAccess();
        case 'invite': return await this.createInvite(input);
        case 'revoke': return this.revoke(input.id);
        case 'cancel-invite': return this.cancelInvite(input.id);
        case 'enroll-options': return await this.enrollOptions(input.token, input.oldFlow);
        case 'enroll-verify': return await this.enrollVerify(input.flow, input.response);
        case 'login-options': return await this.loginOptions(input.oldFlow);
        case 'login-verify': return await this.loginVerify(input.flow, input.response);
        case 'session': return await this.session(input.token);
        case 'logout': return await this.logout(input.token);
        case 'private-info': return { data: await this.privateInfo() };
        case 'save-private-info': return this.savePrivateInfo(input.data);
        default: reject('Not found.', 404);
      }
    } catch (error) {
      if (error.status) return { error: error.message, status: error.status };
      throw error;
    }
  }

  listAccess() {
    this.cleanup();
    return {
      access: this.rows('grant').map(({ key, ...grant }) => ({ id: key, ...grant })),
      invites: this.rows('invite').map(({ id, name, mode, expiresAt }) => ({ id, name, mode, expiresAt })),
    };
  }

  async createInvite({ name, mode = 'passkey' }) {
    if (MOM_PHONE_ENROLLMENT_LOCKED) { this.closeEnrollmentData(); reject('New device setup is closed.', 403); }
    name = typeof name === 'string' ? name.trim() : '';
    if (!name || name.length > 80 || !['passkey', 'device'].includes(mode)) reject('Enter a name and a valid sign-in method.');
    this.cleanup();
    if (this.rows('grant').length >= 20 || this.rows('invite').length >= 10) reject('Remove unused access or setup links first.');
    const token = randomToken();
    const key = await hash(token);
    const invite = { id: crypto.randomUUID(), name, mode, expiresAt: Date.now() + INVITE_MS };
    this.put('invite', key, invite, invite.expiresAt);
    const webOrigin = this.env.MOM_PHONE_WEB_ORIGIN || MOM_PHONE_WEB_ORIGIN;
    return { ...invite, url: `${webOrigin}/stuff/mom-budget-phone.html#setup=${token}` };
  }

  revoke(id) {
    if (typeof id !== 'string' || !this.get('grant', id)) reject('Access no longer exists.', 404);
    this.ctx.storage.transactionSync(() => {
      this.remove('grant', id);
      for (const kind of ['credential', 'session']) {
        for (const row of this.rows(kind)) if (row.grantId === id) this.remove(kind, row.key);
      }
    });
    return { success: true };
  }
  cancelInvite(id) {
    const invite = this.rows('invite').find(row => row.id === id);
    if (invite) this.remove('invite', invite.key);
    return { success: true };
  }

  async makeFlow(value, oldFlow) {
    const token = randomToken();
    const key = await hash(token);
    const oldKey = tokenValid(oldFlow) ? await hash(oldFlow) : null;
    this.cleanup();
    // Bound anonymous storage even if requests come from many IP addresses.
    if (this.rows('flow').length >= 200) reject('Please wait a few minutes and try again.', 429);
    if (oldKey) this.remove('flow', oldKey);
    this.put('flow', key, value, Date.now() + FLOW_MS);
    return token;
  }

  async consumeFlow(token, purpose) {
    if (!tokenValid(token)) reject('Please tap the button again to start.', 401);
    const key = await hash(token);
    const flow = this.get('flow', key);
    this.remove('flow', key); // A challenge can be tried only once, including failed verification.
    if (!flow || flow.purpose !== purpose) reject('This sign-in expired. Please try again.', 401);
    return flow;
  }

  async enrollOptions(token, oldFlow) {
    if (MOM_PHONE_ENROLLMENT_LOCKED) { this.closeEnrollmentData(); reject('New device setup is closed.', 403); }
    if (!tokenValid(token)) reject('This setup link is invalid or expired. Ask for a new link.', 401);
    const inviteKey = await hash(token);
    const invite = this.get('invite', inviteKey);
    if (!invite) reject('This setup link was used or expired. Ask for a new link.', 401);
    let options = null;
    if (invite.mode === 'passkey') {
      options = await generateRegistrationOptions({
        rpName: 'Money Left', rpID: new URL(this.origin()).hostname,
        userID: new TextEncoder().encode(invite.id), userName: invite.name, userDisplayName: invite.name,
        attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform' },
        timeout: 120000,
      });
    }
    const flowToken = await this.makeFlow({ purpose: 'enroll', inviteKey, options }, oldFlow);
    return { options, mode: invite.mode, flowToken };
  }

  async newSession(grantId) {
    const token = randomToken();
    const key = await hash(token);
    return { token, key, grantId, expiresAt: Date.now() + MOM_PHONE_SESSION_SECONDS * 1000 };
  }
  commitSession(session) {
    // Call only in the transaction that checks the grant still exists.
    const sessions = this.rows('session').filter(row => row.grantId === session.grantId);
    sessions.sort((a, b) => a.expiresAt - b.expiresAt);
    while (sessions.length >= 30) this.remove('session', sessions.shift().key);
    this.put('session', session.key, { grantId: session.grantId, expiresAt: session.expiresAt }, session.expiresAt);
  }

  async enrollVerify(flowToken, response) {
    const flow = await this.consumeFlow(flowToken, 'enroll');
    const invite = this.get('invite', flow.inviteKey);
    if (!invite) reject('This setup link was used or expired. Ask for a new link.', 401);
    let credential = null;
    if (invite.mode === 'passkey') {
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response, expectedChallenge: flow.options.challenge,
          expectedOrigin: this.origin(), expectedRPID: new URL(this.origin()).hostname,
          requireUserVerification: true, supportedAlgorithmIDs: [-7, -257],
        });
      } catch { reject('The phone could not verify this passkey. Please try setup again.', 401); }
      if (!verification.verified || !verification.registrationInfo) reject('Passkey verification failed.', 401);
      const info = verification.registrationInfo;
      credential = {
        ...info.credential, publicKey: encode(info.credential.publicKey),
        userId: flow.options.user.id, grantId: invite.id,
      };
    }
    const session = await this.newSession(invite.id);
    this.ctx.storage.transactionSync(() => {
      // Crypto awaits allow other requests to run. Recheck inside the commit.
      if (!this.get('invite', flow.inviteKey)) reject('This setup link was used or expired.', 401);
      if (credential && this.get('credential', credential.id)) reject('This passkey is already registered.');
      if (this.rows('grant').length >= 20) reject('Remove unused access first.');
      this.remove('invite', flow.inviteKey);
      this.put('grant', invite.id, { name: invite.name, mode: invite.mode, createdAt: Date.now(), lastUsedAt: Date.now() });
      if (credential) this.put('credential', credential.id, credential);
      this.commitSession(session);
    });
    return { success: true, sessionToken: session.token, expiresAt: session.expiresAt };
  }

  async loginOptions(oldFlow) {
    // Discoverable passkeys: no public list of names or credential IDs.
    const options = await generateAuthenticationOptions({
      rpID: new URL(this.origin()).hostname, userVerification: 'required', timeout: 120000,
    });
    const flowToken = await this.makeFlow({ purpose: 'login', options }, oldFlow);
    return { options, flowToken };
  }

  async loginVerify(flowToken, response) {
    const flow = await this.consumeFlow(flowToken, 'login');
    const credential = typeof response?.id === 'string' ? this.get('credential', response.id) : null;
    if (!credential || !this.get('grant', credential.grantId)) reject('This passkey is not approved. Ask for a new setup link.', 401);
    if (response.response?.userHandle !== credential.userId) reject('Passkey verification failed.', 401);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response, expectedChallenge: flow.options.challenge,
        expectedOrigin: this.origin(), expectedRPID: new URL(this.origin()).hostname,
        credential: { ...credential, publicKey: decode(credential.publicKey) },
        requireUserVerification: true,
      });
    } catch { reject('The phone could not verify this passkey. Please try again.', 401); }
    if (!verification.verified) reject('Passkey verification failed.', 401);
    const session = await this.newSession(credential.grantId);
    this.ctx.storage.transactionSync(() => {
      const current = this.get('credential', credential.id);
      const grant = this.get('grant', credential.grantId);
      if (!current || !grant) reject('This access has been removed.', 401);
      const counter = verification.authenticationInfo.newCounter;
      if ((counter > 0 || current.counter > 0) && counter <= current.counter) reject('Please try signing in again.', 401);
      this.put('credential', credential.id, { ...current, counter });
      this.put('grant', credential.grantId, { ...grant, lastUsedAt: Date.now() });
      this.commitSession(session);
    });
    return { success: true, sessionToken: session.token, expiresAt: session.expiresAt };
  }

  async session(token) {
    if (!tokenValid(token)) return { authenticated: false };
    const session = this.get('session', await hash(token));
    const grant = session && this.get('grant', session.grantId);
    if (!grant) return { authenticated: false };
    if (Date.now() - grant.lastUsedAt > 60 * 60 * 1000) this.put('grant', session.grantId, { ...grant, lastUsedAt: Date.now() });
    return { authenticated: true, expiresAt: session.expiresAt };
  }

  async logout(token) {
    if (tokenValid(token)) this.remove('session', await hash(token));
    return { success: true };
  }

  async privateInfo() {
    const current = this.get('private', 'info');
    if (current) return current;
    // One-time import from the private KV migration record. Recheck after I/O.
    const legacy = await this.env.RENTALS.get('mom_phone_private_info', 'json');
    return this.ctx.storage.transactionSync(() => {
      const latest = this.get('private', 'info');
      if (latest) return latest;
      if (!legacy) return { birthdays: [], importantInfo: [] };
      const normalized = normalizePrivateInfo(legacy);
      this.put('private', 'info', normalized);
      return normalized;
    });
  }
  savePrivateInfo(data) {
    const normalized = normalizePrivateInfo(data);
    this.put('private', 'info', normalized);
    return { success: true };
  }
}

function normalizePrivateInfo(data) {
  if (!data || !Array.isArray(data.birthdays) || !Array.isArray(data.importantInfo) || data.birthdays.length > 100 || data.importantInfo.length > 30) reject('Invalid private information.');
  const text = (value, max) => {
    if (typeof value !== 'string' || value.length > max) reject('A private information field is too long or invalid.');
    return value.trim();
  };
  return {
    birthdays: data.birthdays.map(row => ({ month: text(row.month, 20), name: text(row.name, 100), date: text(row.date, 100), note: text(row.note || '', 300) })),
    importantInfo: data.importantInfo.map(row => ({ label: text(row.label, 100), value: text(row.value, 500) })),
  };
}
