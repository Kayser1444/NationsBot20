import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnJournal } from '../turn-journal.mjs';
import { recoverTurnJournal } from '../turn-recovery.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nations-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new TurnJournal(join(dir, 'journal.json'), () => 20_000_000);
  journal.data = { version: 1, turns: {}, tracking: { '1': true }, receipts: { keep: 'receipt' }, records: [
    { matchId: '1', player: 'A', startedAt: 100123, endedAt: 100123, durationMs: 0, partial: true, reason: 'disconnected' },
  ] }; journal.save();
  const sourcePath = journal.path + '.recovery.json';
  const checkpoint = observations => writeFileSync(sourcePath, JSON.stringify({ version: 1, observations }));
  return { dir, journal, sourcePath, checkpoint };
}
const observation = { matchId: '1', player: 'A', startedAt: 100000, durationMs: 4 * 60 * 60 * 1000 };

test('an observed pre-deploy interval repairs truncation once, backs up the original and preserves tracking and receipts', t => {
  const f = fixture(t), before = readFileSync(f.journal.path, 'utf8');
  f.checkpoint([observation]);
  assert.equal(recoverTurnJournal(f.journal), 1);
  assert.equal(f.journal.data.records[0].durationMs, observation.durationMs);
  assert.equal(f.journal.data.records[0].endedAt, 100123 + observation.durationMs);
  assert.equal(f.journal.data.records[0].recovered, true);
  assert.equal(f.journal.data.records[0].partial, true);
  assert.deepEqual(f.journal.data.tracking, { '1': true }); assert.deepEqual(f.journal.data.receipts, { keep: 'receipt' });
  assert.equal(existsSync(f.sourcePath), false);
  const backup = readdirSync(f.dir).find(name => name.includes('before-recovery'));
  assert.equal(readFileSync(join(f.dir, backup), 'utf8'), before);
  assert.equal(recoverTurnJournal(f.journal), 0);
  f.checkpoint([observation]); assert.equal(recoverTurnJournal(f.journal), 0);
  assert.equal(f.journal.data.records.length, 1);
});

test('recovery never shortens a saved interval or overlaps a later move', t => {
  const f = fixture(t);
  f.journal.data.records[0].endedAt = 120123; f.journal.data.records[0].durationMs = 20000;
  f.journal.data.records.push({ matchId: '1', player: 'B', startedAt: 150123, endedAt: 180123, durationMs: 30000 });
  f.journal.save(); f.checkpoint([{ ...observation, durationMs: 10000 }]);
  assert.equal(recoverTurnJournal(f.journal), 0);
  f.checkpoint([observation]); assert.equal(recoverTurnJournal(f.journal), 1);
  assert.equal(f.journal.data.records[0].endedAt, 150123);
  assert.equal(f.journal.data.records[1].durationMs, 30000);
});

test('missing, ambiguous or invalid checkpoints cannot partially change the journal', t => {
  const f = fixture(t);
  for (const entry of [{ ...observation, matchId: '2' }, { ...observation, durationMs: -1 }, { ...observation, durationMs: 30_000_000 }]) {
    const before = readFileSync(f.journal.path, 'utf8'), data = structuredClone(f.journal.data);
    f.checkpoint([observation, entry]); assert.throws(() => recoverTurnJournal(f.journal));
    assert.equal(readFileSync(f.journal.path, 'utf8'), before); assert.deepEqual(f.journal.data, data);
    assert.equal(existsSync(f.sourcePath), true);
  }
  f.journal.data.records.push({ ...f.journal.data.records[0] }); f.journal.save();
  f.checkpoint([observation]); assert.throws(() => recoverTurnJournal(f.journal), /unique/);
});
