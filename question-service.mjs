import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceStore, createQuestionCorpus, saveQuestionJson, loadQuestionRulebooks } from './question-sources.mjs';
import { investigateQuestion, maxQuestionRequests } from './question-agent.mjs';
import { loadQuestionCards } from './card-library.mjs';
import { questionReplyParts } from './question-answer.mjs';

export function createQuestionService(options = {}) {
  try { return buildQuestionService(options); }
  catch {
    options.report?.('Frågefunktionen är avstängd: lokala källor eller inställningar kunde inte läsas.', 'error');
    return { ask: async ({ language }) => language === 'sv-SE' ? 'Frågefunktionen är inte tillgänglig just nu.' : 'Questions are currently unavailable.', close() {} };
  }
}

function buildQuestionService({ env = process.env, directory, fetcher = fetch, now = Date.now, report = () => {} } = {}) {
  const allowed = new Set((env.NATIONS_QUESTION_USER_IDS || env.NATIONS_ADMIN_OWNER_ID || '').split(',').map(id => id.trim()).filter(id => /^\d{17,20}$/.test(id)));
  const enabled = env.NATIONS_QUESTION_ENABLED === '1' && !!env.OPENAI_API_KEY && allowed.size && directory;
  const message = (language, sv, en) => language === 'sv-SE' ? sv : en;
  const disabled = language => message(language, 'Frågefunktionen är inte aktiverad för ditt konto.', 'Questions are not enabled for your account.');
  if (!enabled) return { ask: async ({ language }) => disabled(language), close() {} };
  const root = join(directory, 'questions');
  mkdirSync(root, { recursive: true });
  const path = join(root, 'usage.json');
  // Corrupt accounting must disable questions rather than reset the limits.
  let ledger;
  try {
    ledger = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { day: '', total: 0, requests: 0, users: {} };
    if (typeof ledger.day !== 'string' || !Number.isInteger(ledger.total) || ledger.total < 0 ||
        !Number.isInteger(ledger.requests) || ledger.requests < 0 || !ledger.users || Array.isArray(ledger.users) || typeof ledger.users !== 'object' ||
        Object.values(ledger.users).some(user => !Number.isInteger(user.count) || user.count < 0 || !Number.isFinite(user.last))) throw new Error();
  } catch { report('Frågefunktionen är avstängd: sparad förbrukning kunde inte läsas.', 'error'); return { ask: async ({ language }) => disabled(language), close() {} }; }
  const sourceStore = createSourceStore({ directory: root,
    seed: fileURLToPath(new URL('./data/question/tabony-snapshot.json', import.meta.url)), fetcher, now, report });
  const faq = JSON.parse(readFileSync(new URL('./data/faq/entries.json', import.meta.url), 'utf8'));
  const rulebooks = loadQuestionRulebooks();
  const cards = loadQuestionCards();
  const controller = new AbortController();
  let busy = false, closed = false;
  sourceStore.start();
  return {
    async ask({ userId, question, language = 'en-US', onAnswer = () => {}, onTelemetry = () => {}, onAccepted = async () => {} }) {
      if (closed || !allowed.has(userId)) return disabled(language);
      if (typeof question !== 'string' || question.trim().length < 5 || question.length > 1200) return message(language,
        'Skriv en fråga på 5–1200 tecken om Nations regler eller Tabony-implementationen.', 'Enter a 5–1200 character question about Nations rules or the Tabony implementation.');
      if (busy) return message(language, 'En fråga undersöks redan. Försök igen strax.', 'Another question is being investigated. Please try again shortly.');
      const day = new Date(now()).toISOString().slice(0, 10);
      if (ledger.day !== day) ledger = { day, total: 0, requests: 0, users: {} };
      const user = ledger.users[userId] ?? { count: 0, last: 0 };
      if (user.count >= 5 || (user.count && now() - user.last < 60000) || ledger.total >= 20 || ledger.requests + maxQuestionRequests > 120) return message(language,
        'Frågegränsen är nådd: en per minut, fem per dygn och högst 20 totalt per dygn (UTC).', 'Question limit reached: one per minute, five per day and at most 20 overall per day (UTC).');
      busy = true;
      try {
        await onAccepted(); // Acknowledge after access/quota checks and before any paid request.
        ledger.total++; ledger.users[userId] = { count: user.count + 1, last: now() };
        saveQuestionJson(path, ledger);
        const corpus = createQuestionCorpus(sourceStore.snapshot(), faq, rulebooks, cards);
        let details;
        await investigateQuestion({ question: question.trim(), language, corpus, apiKey: env.OPENAI_API_KEY, fetcher, now, onTelemetry, onAnswer: value => { details = value; },
          signal: controller.signal, reserveRequest() {
            if (ledger.requests >= 120) throw new Error('Daily request limit.');
            ledger.requests++; saveQuestionJson(path, ledger);
          } });
        const footer = message(language, 'AI-tolkning · lokal Tabony-kod', 'AI interpretation · local Tabony code');
        const parts = questionReplyParts(details.parts, `${footer}: ${corpus.commit.slice(0, 12)} · ${corpus.fetchedAt.slice(0, 10)}`);
        onAnswer({ ...details, parts, status: 'answered' });
        return parts.join('\n\n');
      } catch (error) {
        onAnswer({ status: 'failed', failure: ['invalid_answer', 'answer_too_long'].includes(error.code) ? error.code : 'investigation_failed' });
        report('En regelfråga kunde inte slutföras. Ingen alternativ modell används.', 'error');
        return message(language, 'Undersökningen kunde inte slutföras inom gränserna, eller GPT-6 Luna är inte tillgänglig. Försöket räknas i kvoten. Försök med en mer avgränsad fråga.',
          'The investigation could not finish within its limits, or GPT-6 Luna is unavailable. This attempt counts toward your quota. Try a narrower question.');
      } finally { busy = false; }
    },
    close() { closed = true; controller.abort(); sourceStore.close(); },
  };
}
