// Offline inspection: no Discord connection, API key or network request.
import { loadQuestionCards } from '../card-library.mjs';

const library = loadQuestionCards();
const selected = process.argv.find(value => value.startsWith('--read='))?.slice(7);
if (selected) {
  const document = library.documents.find(item => item.id === selected);
  if (!document) { console.error('Unknown local card source ID.'); process.exitCode = 1; }
  else console.log(document.text);
} else {
  const query = process.argv.slice(2).join(' ');
  if (!query) { console.error('Usage: node scripts/search-card-library.mjs "English card description"\nOr: --read=cards/FD_HM/b'); process.exitCode = 1; }
  else console.log(JSON.stringify(library.search({ query }), null, 2));
}
