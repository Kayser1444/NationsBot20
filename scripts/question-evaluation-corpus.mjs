import { readFileSync } from 'node:fs';
import { createQuestionCorpus, loadQuestionRulebooks } from '../question-sources.mjs';
import { loadQuestionCards } from '../card-library.mjs';

export function loadEvaluationCorpus() {
  const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  return createQuestionCorpus(json('../data/question/tabony-snapshot.json'), json('../data/faq/entries.json'),
    loadQuestionRulebooks(), loadQuestionCards(), json('../data/question/tabony-rules-differences.json'));
}
