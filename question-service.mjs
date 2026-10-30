import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceStore, createQuestionCorpus, saveQuestionJson, loadQuestionRulebooks } from './question-sources.mjs';
import { investigateQuestion, maxQuestionRequests } from './question-agent.mjs';
import { loadQuestionCards } from './card-library.mjs';
import { questionReplyParts, questionSourceFooter } from './question-answer.mjs';
import { createRulesDifferencesStore } from './question-errata.mjs';
import { createLocalRetrieval } from './question-retrieval.mjs';
import { createQuestionModels } from './question-models.mjs';

export function createQuestionService(options = {}) {
  try { return buildQuestionService(options); }
  catch {
    options.report?.('Frågefunktionen är avstängd: lokala källor eller inställningar kunde inte läsas.', 'error');
    return { ask: async ({ language }) => language === 'sv-SE' ? 'Frågefunktionen är inte tillgänglig just nu.' : 'Questions are currently unavailable.', close() {} };
  }
}

function buildQuestionService({ env = process.env, directory, fetcher = fetch, now = Date.now, report = () => {}, rulesDifferencesStore,
  retrievalFactory = createLocalRetrieval } = {}) {
  const enabled = env.NATIONS_QUESTION_ENABLED === '1' && !!env.OPENAI_API_KEY && directory;
  const message = (language, sv, en) => language === 'sv-SE' ? sv : en;
  const disabled = language => message(language, 'Frågefunktionen är inte aktiverad för ditt konto.', 'Questions are not enabled for your account.');
  if (!enabled) return { ask: async ({ language }) => disabled(language), close() {} };
  const root = join(directory, 'questions');
  mkdirSync(root, { recursive: true });
  const path = join(root, 'usage.json');
  const models = createQuestionModels({ directory: root, env, fetcher, now, report });
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
  const differencesStore = rulesDifferencesStore ?? createRulesDifferencesStore({ directory: root, fetcher, now, report });
  const retrieval = env.NATIONS_QUESTION_RETRIEVAL === 'hybrid' ? retrievalFactory({ directory: join(root, 'vector-index'),
    modelDirectory: env.NATIONS_QUESTION_MODEL_DIR, report }) : null;
  const createCorpus = () => createQuestionCorpus(sourceStore.snapshot(), faq, rulebooks, cards, differencesStore.snapshot());
  const controller = new AbortController();
  let busy = false, closed = false;
  const globalQuota = () => {
    const day = new Date(now()).toISOString().slice(0, 10);
    return { day, total: ledger.day === day ? ledger.total : 0, totalLimit: 20,
      requests: ledger.day === day ? ledger.requests : 0, requestLimit: 120 };
  };
  sourceStore.start();
  if (!rulesDifferencesStore) differencesStore.start();
  if (retrieval) void retrieval.prepare(createCorpus());
  return {
    modelSettings: () => models.catalogue(),
    currentModel: () => models.current(),
    selectModel(model, actorId) { if (closed) throw new Error('Frågefunktionen är stoppad.'); return models.select(model, actorId); },
    retrievalStatus: () => retrieval?.status() ?? { mode: 'literal' },
    globalQuota,
    quota(userId) {
      if (!/^\d{17,20}$/.test(userId)) throw new Error('Ogiltigt Discord-ID.');
      const global = globalQuota();
      const user = ledger.day === global.day ? ledger.users[userId] : null;
      return { userId, used: user?.count ?? 0, limit: 5, remaining: Math.max(0, 5 - (user?.count ?? 0)),
        cooldownRemainingMs: user?.count ? Math.max(0, 60000 - (now() - user.last)) : 0,
        ...global };
    },
    resetGlobalQuota(actorId) {
      if (closed) throw new Error('Frågefunktionen är stoppad.');
      if (busy) throw new Error('En fråga undersöks. Vänta tills den är klar innan kvoten nollställs.');
      const day = new Date(now()).toISOString().slice(0, 10);
      const next = ledger.day === day ? structuredClone(ledger) : { day, total: 0, requests: 0, users: {} };
      const previous = next.total;
      const previousRequests = next.requests;
      next.total = 0;
      next.requests = 0;
      saveQuestionJson(path, next);
      ledger = next;
      report(`Gemensam frågekvot nollställd från ${previous} frågor och ${previousRequests} API-anrop av ${/^\d{17,20}$/.test(actorId) ? actorId : 'lokal administratör'}. Personliga kvoter behålls.`);
      return globalQuota();
    },
    resetQuota(userId, actorId) {
      if (!/^\d{17,20}$/.test(userId)) throw new Error('Ogiltigt Discord-ID.');
      if (closed) throw new Error('Frågefunktionen är stoppad.');
      if (busy) throw new Error('En fråga undersöks. Vänta tills den är klar innan kvoten nollställs.');
      const day = new Date(now()).toISOString().slice(0, 10);
      const next = ledger.day === day ? structuredClone(ledger) : { day, total: 0, requests: 0, users: {} };
      delete next.users[userId];
      saveQuestionJson(path, next); // Publish in memory only after the persistent reset succeeds.
      ledger = next;
      report(`Frågekvot nollställd för Discord-ID ${userId} av ${/^\d{17,20}$/.test(actorId) ? actorId : 'lokal administratör'}. Gemensamma fråge- och API-kvoter behålls.`);
      return this.quota(userId);
    },
    async ask({ userId, question, language = 'en-US', onAnswer = () => {}, onTelemetry = () => {}, onAccepted = async () => {} }) {
      if (closed || !/^\d{17,20}$/.test(userId)) return disabled(language);
      if (typeof question !== 'string' || question.trim().length < 5 || question.length > 1200) return message(language,
        'Skriv en fråga på 5–1200 tecken om Nations regler eller Tabony-implementationen.', 'Enter a 5–1200 character question about Nations rules or the Tabony implementation.');
      if (busy) return message(language, 'En fråga undersöks redan. Försök igen strax.', 'Another question is being investigated. Please try again shortly.');
      const checkedAt = now();
      const day = new Date(checkedAt).toISOString().slice(0, 10);
      if (ledger.day !== day) ledger = { day, total: 0, requests: 0, users: {} };
      const user = ledger.users[userId] ?? { count: 0, last: 0 };
      const cooldownSeconds = user.count ? Math.max(0, Math.ceil((60000 - (checkedAt - user.last)) / 1000)) : 0;
      const limits = [];
      if (cooldownSeconds > 0) limits.push(message(language,
        `Minutgränsen: vänta ${cooldownSeconds} s innan du ställer nästa fråga.`, `Minute limit: wait ${cooldownSeconds} s before asking another question.`));
      if (user.count >= 5) limits.push(message(language, `Din dygnskvot: ${user.count}/5 frågor använda.`, `Your daily quota: ${user.count}/5 questions used.`));
      if (ledger.total >= 20) limits.push(message(language, `Gemensam dygnskvot: ${ledger.total}/20 frågor använda.`, `Shared daily question quota: ${ledger.total}/20 questions used.`));
      const apiBlocked = ledger.requests + maxQuestionRequests > 120;
      if (apiBlocked) {
        const remaining = Math.max(0, 120 - ledger.requests);
        limits.push(message(language, `Gemensam API-kvot: ${ledger.requests}/120 anrop använda.`, `Shared daily API quota: ${ledger.requests}/120 requests used.`) +
          (remaining ? message(language, ` ${remaining} anrop återstår, men det behövs plats för upp till ${maxQuestionRequests} anrop för att starta en fråga.`,
            ` ${remaining} requests remain, but starting a question requires room for up to ${maxQuestionRequests} requests.`) : ''));
      }
      if (limits.length) return message(language, 'Frågegränsen är nådd:', 'Question limit reached:') + '\n' + limits.map(limit => '- ' + limit).join('\n') +
        (user.count >= 5 || ledger.total >= 20 || apiBlocked ? message(language, '\nDygnskvoterna återställs kl. 00:00 UTC.', '\nDaily quotas reset at 00:00 UTC.') : '');
      let model;
      try { model = models.current(); }
      catch { return message(language, 'Frågefunktionen är inte tillgänglig: administratören behöver välja en giltig modell.', 'Questions are unavailable: the administrator needs to select a valid model.'); }
      busy = true;
      try {
        await onAccepted(); // Acknowledge after access/quota checks and before any paid request.
        ledger.total++; ledger.users[userId] = { count: user.count + 1, last: now() };
        saveQuestionJson(path, ledger);
        const originalCorpus = createCorpus();
        const corpus = retrieval ? retrieval.forCorpus(originalCorpus, onTelemetry) : originalCorpus;
        onTelemetry({ type: 'retrieval', phase: 'selected', name: corpus.retrieval ?? 'literal', corpusHash: originalCorpus.fingerprint });
        let details;
        await investigateQuestion({ question: question.trim(), language, corpus, model, apiKey: env.OPENAI_API_KEY, fetcher, now, onTelemetry, onAnswer: value => { details = value; },
          signal: controller.signal, reserveRequest() {
            if (ledger.requests >= 120) throw new Error('Daily request limit.');
            ledger.requests++; saveQuestionJson(path, ledger);
          } });
        const footer = [...(details.sourceUrls ?? []), questionSourceFooter(corpus, language)].join('\n');
        const parts = questionReplyParts(details.parts, footer);
        onAnswer({ ...details, parts, status: 'answered' });
        return parts.join('\n\n');
      } catch (error) {
        onAnswer({ status: 'failed', failure: ['invalid_answer', 'answer_too_long', 'context_limit'].includes(error.code) ? error.code : 'investigation_failed' });
        report(`En regelfråga kunde inte slutföras med ${model}. Ingen alternativ modell används.`, 'error');
        if (error.code === 'context_limit') return message(language,
          'Undersökningen behövde mer källtext än vad som ryms i en fråga. Försöket räknas i kvoten. Försök med en mer avgränsad fråga.',
          'The investigation needed more source text than fits in one question. This attempt counts toward your quota. Try a narrower question.');
        return message(language, 'Undersökningen kunde inte slutföras inom gränserna, eller den valda OpenAI-modellen är inte tillgänglig. Försöket räknas i kvoten. Försök med en mer avgränsad fråga.',
          'The investigation could not finish within its limits, or the selected OpenAI model is unavailable. This attempt counts toward your quota. Try a narrower question.');
      } finally { busy = false; }
    },
    close() { closed = true; controller.abort(); retrieval?.close(); sourceStore.close(); if (!rulesDifferencesStore) differencesStore.close(); },
  };
}
