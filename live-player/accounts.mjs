import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export const accountNamePattern = /^[a-zA-Z0-9_]{1,20}$/;
export const matchIdPattern = /^\d{1,10}$/;
export const accountDatabase = 'player-accounts.sqlite';

export function accountStore(directory, secret) {
  if (!/^[a-f0-9]{64}$/i.test(secret ?? '')) throw new Error('Set NATIONS_PLAYER_CREDENTIAL_ENCRYPTION_KEY to a sealed 32-byte hex key.');
  const derive = purpose => Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'hex'), '', `nations-player/${purpose}/v1`, 32));
  const key = derive('credentials');
  const lookup = derive('account-id');
  const idFor = username => createHmac('sha256', lookup).update(username).digest('hex');
  const db = new DatabaseSync(join(directory, accountDatabase));
  function seal(id, value) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }
  function open(id, blob) {
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(blob.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8'));
  }
  try {
    db.exec(`PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS vault (slot INTEGER PRIMARY KEY CHECK (slot = 1), verifier BLOB NOT NULL, legacy_id TEXT) STRICT;`);
    db.prepare('INSERT OR IGNORE INTO vault (slot, verifier) VALUES (1, ?)').run(seal('vault', true));
    open('vault', db.prepare('SELECT verifier FROM vault WHERE slot = 1').get().verifier);
  } catch {
    db.close();
    throw new Error('Could not open the account vault. Check the player volume and its encryption key.');
  }
  const insert = db.prepare('INSERT INTO accounts VALUES (?, ?)');
  const withIdentity = ({ id, data }) => ({ ...open(id, data), id });
  return {
    idFor,
    list: () => db.prepare('SELECT * FROM accounts ORDER BY rowid').all().map(withIdentity),
    add(input) {
      const id = idFor(input.username);
      insert.run(id, seal(id, input));
      return { ...input, id };
    },
    save({ id, ...input }) { db.prepare('UPDATE accounts SET data = ? WHERE id = ?').run(seal(id, input), id); },
    delete(id) { db.prepare('DELETE FROM accounts WHERE id = ?').run(id); },
    legacyId: () => db.prepare('SELECT legacy_id FROM vault WHERE slot = 1').get().legacy_id,
    importLegacy({ username, password, play }) {
      if (!username || !password || this.legacyId()) return;
      if (!accountNamePattern.test(username)) throw new Error('Set the exact legacy TABONY_USERNAME before importing it.');
      const id = idFor(username);
      db.exec('BEGIN');
      try {
        const account = { username, password, enabled: play, defaultModel: null, matchIds: null };
        db.prepare('INSERT OR IGNORE INTO accounts VALUES (?, ?)').run(id, seal(id, account));
        db.prepare('UPDATE vault SET legacy_id = ? WHERE slot = 1').run(id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close: () => db.close(),
  };
}
