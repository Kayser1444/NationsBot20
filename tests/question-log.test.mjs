import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuestionLog } from '../question-log.mjs';
import { parseQuestionAnswer, questionReplyParts } from '../question-answer.mjs';
import { deliverQuestion } from '../question-delivery.mjs';
import { startDashboard } from '../dashboard.mjs';
import { questionSearchHint, questionReceipt } from '../question-acknowledgement.mjs';

const answer = overrides => JSON.stringify({ question_language: 'fr', answer_language: 'fr', english_question: 'Which card?',
  parts: [{ text: 'La carte.', english_text: 'The card.' }], ...overrides });
const input = { userId: '229311536827465728', userName: 'Example', question: 'Quelle carte ?', channelId: '123', language: 'fr' };
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'nations-conversations-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('local acknowledgement hints identify likely sources without claiming a ruling', () => {
  for (const [question, route] of [['Vad säger regelboken?', 'rules'], ['Is there FAQ errata?', 'faq'], ['Vilket händelsekort?', 'cards'], ['How does Tabony implement this?', 'code']]) {
    assert.ok(questionSearchHint(question, 'sv-SE').routes.includes(route));
  }
  for (const language of ['sv-SE', 'en-US', 'fr', 'de', 'es', 'zh-CN']) {
    const hint = questionSearchHint('Tabony rules FAQ card', language);
    assert.ok(hint.text.length <= 2000); assert.ok(hint.englishText.includes('probably'));
  }
  assert.deepEqual(questionSearchHint('Can I do this?').routes, ['rules', 'faq']);
});

test('accepted question immediately acknowledges then sends two private answer followups, logging all three messages', async () => {
  let clock = Date.now(), sends = []; const log = createQuestionLog({ now: () => clock });
  const interaction = { user: { id: input.userId }, guildId: 'guild', createdTimestamp: clock, options: { getString: () => 'Rules and Tabony card?' },
    async editReply(payload) { sends.push({ ...payload, method: 'edit' }); clock += 10; },
    async followUp(payload) { sends.push({ ...payload, method: 'followup' }); clock += 20; } };
  const questions = { async ask({ onAccepted, onAnswer }) {
    await onAccepted(); assert.equal(sends.length, 1); clock += 1000;
    onAnswer({ status: 'answered', parts: ['Official rules: evidence.', 'Tabony: implementation evidence.'] }); return 'unused';
  } };
  await deliverQuestion({ interaction, questions, log, language: 'sv-SE', flags: { SuppressEmbeds: 4, Ephemeral: 64 }, now: () => clock });
  assert.deepEqual(sends.map(p => p.method), ['edit', 'followup', 'followup']);
  assert.equal(sends[1].flags, 68); assert.equal(sends[2].flags, 68); assert.ok(sends.every(p => p.content.length <= 2000));
  const record = log.read(log.list().records[0].id);
  assert.equal(record.acknowledgement.delivery, 'sent'); assert.equal(record.acknowledgement.text, sends[0].content);
  assert.equal(record.acknowledgementMs, 10); assert.equal(record.firstResponseMs, 1030); assert.equal(record.modelDurationMs, 1000);
  assert.equal(record.parts.length, 2); assert.equal(record.deliveryStatus, 'sent');
  assert.equal(sends[0].embeds[0].title, 'Din fråga');
  assert.equal(sends[0].embeds[0].description, 'Rules and Tabony card?');
  assert.equal(sends[0].flags, undefined, 'Do not suppress the explicit question embed');
  assert.deepEqual(record.acknowledgement.embeds, sends[0].embeds);
});

test('question receipt keeps long Markdown questions visible and fits Discord without embed permission', () => {
  const question = '*'.repeat(1200), ack = questionSearchHint('card rules FAQ Tabony', 'sv-SE').text;
  const embedded = questionReceipt(question, 'sv-SE', ack);
  assert.equal(embedded.embeds[0].description, '\\*'.repeat(1200)); assert.ok(embedded.embeds[0].description.length <= 4096);
  const plain = questionReceipt(question, 'sv-SE', ack, false);
  assert.ok(plain.content.includes(question)); assert.ok(plain.content.length <= 2000); assert.equal(plain.embeds, undefined);
});

test('uncertain acknowledgement delivery stops investigation and is not overwritten or retried', async () => {
  let sends = 0, investigations = 0; const log = createQuestionLog();
  const interaction = { user: { id: input.userId }, options: { getString: () => input.question }, async editReply() { sends++; throw new Error('uncertain'); } };
  await deliverQuestion({ interaction, log, language: 'en-US', flags: {}, questions: { async ask({ onAccepted }) { await onAccepted(); investigations++; } } });
  assert.equal(investigations, 0); assert.equal(sends, 1);
  const record = log.read(log.list().records[0].id); assert.equal(record.acknowledgement.delivery, 'unconfirmed'); assert.equal(record.status, 'failed'); assert.equal(record.deliveryStatus, 'unconfirmed');
});

test('translations preserve originals, distinguish mixed languages and reject overlong replies without truncation', () => {
  const parsed = parseQuestionAnswer(answer());
  assert.deepEqual(parsed.parts, ['La carte.']); assert.equal(parsed.translation.parts[0], 'The card.'); assert.equal(parsed.translation.status, 'complete');
  assert.equal(parseQuestionAnswer(answer({ answer_language: 'en', parts: [{ text: 'The card.', english_text: null }] })).translation.status, 'complete');
  assert.equal(parseQuestionAnswer(answer({ english_question: null })).translation.status, 'incomplete');
  assert.equal(parseQuestionAnswer(answer({ question_language: 'sv', answer_language: 'en' })).translation.status, 'not-needed');
  assert.throws(() => parseQuestionAnswer(answer({ parts: [{ text: 'x'.repeat(1801), english_text: null }] })));
  assert.throws(() => questionReplyParts(['x'.repeat(1801)]));
  const parts = questionReplyParts(['x'.repeat(1800), 'y'.repeat(1800)], 'AI interpretation');
  assert.equal(parts.length, 2); assert.ok(parts.every(text => text.length <= 2000)); assert.match(parts[1], /^\(2\/2\)/);
});

test('persistent log handles restarts, retention, pagination, DM, metrics and safe telemetry', t => {
  const directory = temp(t); let clock = Date.now(); const options = { directory, now: () => clock, maxRecords: 2 };
  let log = createQuestionLog(options); const id = log.start(input);
  log.telemetry(id, { type: 'api', inputTokens: 25, outputTokens: 12, authorization: 'secret', error: 'secret', model: 'gpt-6-luna' });
  log.telemetry(id, { type: 'api', status: 403, errorCode: 'permission_denied', errorType: 'permission_error', errorParam: 'service_tier', requestId: 'req_example', errorMessage: 'Denied Bearer privatevalue sk-proj-privatevalue' });
  clock += 1500; log = createQuestionLog(options);
  assert.equal(log.read(id).status, 'interrupted'); assert.equal(log.read(id).deliveryStatus, 'unknown');
  assert.deepEqual(log.read(id).usage, { inputTokens: 25, outputTokens: 12, reportedRequests: 1 });
  const diagnostic = log.read(id).telemetry.at(-1);
  assert.equal(diagnostic.errorCode, 'permission_denied'); assert.equal(diagnostic.requestId, 'req_example');
  assert.equal(diagnostic.errorParam, 'service_tier'); assert.equal(diagnostic.errorType, 'permission_error');
  assert.equal(diagnostic.errorMessage.includes('privatevalue'), false);
  assert.equal(readFileSync(join(directory, 'questions/conversations.json'), 'utf8').includes('secret'), false);
  const second = log.start({ ...input, guildId: 'server', guildName: 'Guild', channelName: 'rules' }); log.finish(second, { status: 'answered' });
  assert.equal(log.list({ search: 'Guild' }).total, 1); assert.equal(log.list({ limit: 1, offset: 1 }).records[0].id, id);
  assert.equal(log.read(id).location, 'dm');
  log.start(input); assert.equal(log.read(id), null); clock += 31 * 86400000; assert.equal(log.list().total, 0);
});

test('corrupt conversation log fails closed without replacing the evidence', t => {
  const directory = temp(t); createQuestionLog({ directory }); const path = join(directory, 'questions/conversations.json');
  writeFileSync(path, '{broken'); const log = createQuestionLog({ directory });
  assert.equal(log.available, false); assert.throws(() => log.start(input)); assert.equal(readFileSync(path, 'utf8'), '{broken');
});

test('delivery records exact parts and partial failures without overwriting the first answer or leaking a guild followup', async () => {
  let clock = Date.now(), sends = []; const log = createQuestionLog({ now: () => clock });
  const interaction = { user: { id: input.userId, username: 'Example' }, guildId: 'guild', channelId: 'channel', createdTimestamp: clock,
    options: { getString: () => input.question }, async editReply(payload) { sends.push(payload); clock += 50; },
    async followUp(payload) { sends.push(payload); throw new Error('uncertain delivery'); } };
  const questions = { async ask({ onAnswer, onTelemetry }) { clock += 1000; onTelemetry({ type: 'request', model: 'gpt-6-luna' });
    onAnswer({ ...parseQuestionAnswer(answer()), parts: ['(1/2)\nLa carte.', '(2/2)\nDétails.'], status: 'answered' }); return 'unused'; } };
  await deliverQuestion({ interaction, questions, log, language: 'fr', now: () => clock, flags: { SuppressEmbeds: 4, Ephemeral: 64 } });
  const record = log.read(log.list().records[0].id);
  assert.equal(sends.length, 2); assert.equal(sends[1].flags, 68); assert.deepEqual(sends[0].allowedMentions, { parse: [] });
  assert.equal(record.deliveryStatus, 'partial'); assert.equal(record.parts[0].delivery, 'sent'); assert.equal(record.parts[1].delivery, 'unconfirmed');
  assert.equal(record.firstResponseMs, 1050); assert.equal(record.durationMs, 1050); assert.equal(record.modelDurationMs, 1000);
  assert.equal(record.translation.question, 'Which card?'); assert.equal(record.parts[0].text, sends[0].content);
});

test('unavailable logging prevents model spending; successful deliveries and rejected questions are logged', async () => {
  let calls = 0, replies = []; const interaction = { user: { id: input.userId }, options: { getString: () => input.question }, editReply: async p => { replies.push(p); } };
  await deliverQuestion({ interaction, log: { start() { throw new Error(); } }, questions: { ask() { calls++; } }, flags: {} });
  assert.equal(calls, 0); assert.equal(replies.length, 1);
  const log = createQuestionLog(); await deliverQuestion({ interaction, log, questions: { async ask() { return 'Quota reached.'; } }, flags: {} });
  const record = log.read(log.list().records[0].id); assert.equal(record.status, 'denied'); assert.equal(record.deliveryStatus, 'sent');
  assert.equal(record.parts[0].text, 'Quota reached.');
});

test('question log endpoints follow dashboard authentication and keep details out of status and summary', async t => {
  const log = createQuestionLog(); const id = log.start(input); log.update(id, { parts: [{ text: 'private answer', delivery: 'sent' }] });
  let authorized = false;
  const auth = { origin: null, handle: async () => false, session: () => authorized ? { csrf: 'test' } : null, close() {} };
  // Local binding with synthetic session gate; imitate Railway HTTPS forwarding.
  const dashboard = await startDashboard({ port: 0, snapshot: () => ({ ok: true }), questionLog: log, auth });
  t.after(() => dashboard.close());
  const headers = { 'x-forwarded-proto': 'https' };
  assert.equal((await fetch(dashboard.url + '/api/questions', { headers })).status, 401);
  assert.equal((await fetch(dashboard.url + '/api/questions/' + id, { headers })).status, 401);
  authorized = true;
  const list = await (await fetch(dashboard.url + '/api/questions', { headers })).json(); assert.equal(list.total, 1); assert.equal(JSON.stringify(list).includes('private answer'), false);
  assert.equal((await (await fetch(dashboard.url + '/api/questions/' + id, { headers })).json()).parts[0].text, 'private answer');
  assert.equal(JSON.stringify(await (await fetch(dashboard.url + '/api/status', { headers })).json()).includes('Quelle'), false);
});
