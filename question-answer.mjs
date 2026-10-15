export const questionAnswerFormat = { type: 'json_schema', name: 'nations_question_answer', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['question_language', 'answer_language', 'english_question', 'parts'],
  properties: {
    question_language: { type: 'string' }, answer_language: { type: 'string' },
    english_question: { type: ['string', 'null'] },
    parts: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', additionalProperties: false,
      required: ['text', 'english_text'], properties: { text: { type: 'string' }, english_text: { type: ['string', 'null'] } } },
    },
  },
} };
const clean = value => value.replace(/https?:\/\/[^\s)>]+/gi, '[external link omitted]').trim();
const base = language => language.toLowerCase().split('-')[0];
const translate = language => !['sv', 'en'].includes(base(language));
export function parseQuestionAnswer(text) {
  let answer;
  try { answer = JSON.parse(text); } catch { throw Object.assign(new Error('Invalid structured answer.'), { code: 'invalid_answer' }); }
  if (!answer || ![answer.question_language, answer.answer_language].every(value => typeof value === 'string' && /^[a-z]{2,3}(?:-[a-zA-Z0-9]+)*$/.test(value)) ||
      !Array.isArray(answer.parts) || answer.parts.length < 1 || answer.parts.length > 2 ||
      ![null, 'string'].includes(answer.english_question === null ? null : typeof answer.english_question) ||
      answer.parts.some(part => !part || typeof part.text !== 'string' || !part.text.trim() || part.text.length > 1800 ||
        (part.english_text !== null && typeof part.english_text !== 'string'))) {
    throw Object.assign(new Error('Invalid or overlong structured answer.'), { code: 'invalid_answer' });
  }
  const parts = answer.parts.map(part => clean(part.text));
  if (parts.some(part => part.length > 1800 || !part)) throw Object.assign(new Error('Answer too long after formatting.'), { code: 'answer_too_long' });
  const englishQuestion = translate(answer.question_language) && answer.english_question ? clean(answer.english_question).slice(0, 6000) : null;
  const englishParts = answer.parts.map(part => translate(answer.answer_language) && part.english_text ? clean(part.english_text).slice(0, 8000) : null);
  const needed = translate(answer.question_language) || translate(answer.answer_language);
  const complete = (!translate(answer.question_language) || englishQuestion) && (!translate(answer.answer_language) || englishParts.every(Boolean));
  return { parts, questionLanguage: answer.question_language, answerLanguage: answer.answer_language,
    translation: { status: !needed ? 'not-needed' : complete ? 'complete' : 'incomplete', targetLanguage: 'en',
      label: 'Machine translation of the original conversation; not the text sent to Discord.', question: englishQuestion, parts: englishParts } };
}

export function questionReplyParts(parts, footer = '') {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 2 || parts.some(part => typeof part !== 'string' || !part || part.length > 1800)) throw new Error('Invalid question reply parts.');
  const replies = parts.map((part, index) => (parts.length > 1 ? `(${index + 1}/${parts.length})\n` : '') + part +
    (footer && index === parts.length - 1 ? '\n\n' + footer : ''));
  if (replies.some(part => part.length > 2000)) throw new Error('Question reply exceeds Discord limit.');
  return replies;
}

export function questionSourceFooter({ commit, fetchedAt }, language) {
  const timestamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(fetchedAt));
  const label = language === 'sv-SE' ? 'AI-tolkning · Tabony-kod uppdaterad' : 'AI interpretation · Tabony code updated';
  return `${label}: ${timestamp} (${commit.slice(0, 12)})`;
}
