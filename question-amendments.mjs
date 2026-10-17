import { readFileSync } from 'node:fs';

export const faqAmendments = JSON.parse(readFileSync(new URL('./data/question/inofficial-faq-amendments.json', import.meta.url), 'utf8'));
// Stable short thread URL keeps combined citations within Discord's message limit.
export const faqAmendmentsUrl = 'https://boardgamegeek.com/thread/3605801';
const ids = new Set();
for (const entry of faqAmendments.entries) {
  if (!/^[a-z0-9-]+$/.test(entry.id) || ids.has(entry.id) || !entry.heading || !entry.text ||
      !Array.isArray(entry.names) || entry.names.some(name => typeof name !== 'string')) throw new Error('Invalid FAQ amendment.');
  ids.add(entry.id);
}
