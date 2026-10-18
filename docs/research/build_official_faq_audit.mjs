// Validate coverage/provenance and assemble the official FAQ audit ledger.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const source = read('data/faq/sources.json').sources[0];
const faq = read('data/faq/entries.json').entries;
const snapshot = read('data/question/tabony-snapshot.json');
if (hash(fs.readFileSync(path.join(root, source.localFile))) !== source.sha256) throw Error('FAQ PDF hash mismatch');
for (const [name, file] of Object.entries(snapshot.files)) {
  if (hash(file.text) !== file.sha256) throw Error(`Snapshot hash mismatch: ${name}`);
}
const statuses = new Set(['supported', 'conflict', 'documented-exception', 'partial', 'uncertain', 'not-applicable']);
const parts = ['01', '02', '03'].flatMap(part => read(`docs/research/official-faq-audit-${part}.json`));
parts.sort((a, b) => a.index - b.index);
if (parts.length !== faq.length || parts.length !== 216) throw Error('Audit entry count mismatch');
const ids = new Set();
let citations = 0;
const entries = parts.map((entry, index) => {
  const original = faq[index];
  if (entry.index !== index || entry.id !== original.id || ids.has(entry.id)) throw Error(`Missing/duplicate/mismatched entry ${index}`);
  ids.add(entry.id);
  if (!statuses.has(entry.status) || !entry.notes) throw Error(`Incomplete verdict ${index}`);
  const pages = entry.sourcePages ?? entry.faqPages;
  if (JSON.stringify(pages) !== JSON.stringify(original.sourcePages)) throw Error(`FAQ page mismatch ${index}`);
  const evidence = entry.evidence.map(item => typeof item === 'string' ? item : item.url);
  if (entry.status !== 'not-applicable' && !evidence.length) throw Error(`Missing code evidence ${index}`);
  for (const url of evidence) {
    const match = url.match(/^https:\/\/github\.com\/Logitude\/nations\/blob\/([^/]+)\/([^#]+)(?:#L(\d+)(?:-L(\d+))?)?$/);
    if (!match || match[1] !== snapshot.commit || !snapshot.files[match[2]]) throw Error(`Invalid source citation ${url}`);
    if (match[3]) {
      const start = Number(match[3]), end = Number(match[4] ?? match[3]);
      if (start < 1 || end < start || end > snapshot.files[match[2]].text.split('\n').length) throw Error(`Invalid line range ${url}`);
    }
    citations++;
  }
  return { index, id: entry.id, heading: original.heading, sourcePages: pages, sourceTextSha256: hash(original.sourceText), status: entry.status, evidence, notes: entry.notes };
});
const counts = Object.fromEntries([...statuses].map(status => [status, entries.filter(e => e.status === status).length]));
const ledger = {
  schemaVersion: 1,
  auditedAt: '2026-10-17',
  scope: 'All 216 imported English text entries in Nations FAQ++ 1.11; headings without rule text are not separate behavioral tests.',
  faq: { title: source.title, version: source.version, documentDate: source.documentDate, sha256: source.sha256, localFile: source.localFile, url: 'https://boardgamegeek.com/filepage/96855/faq-plus-plus-official' },
  implementation: { repository: snapshot.repository, commit: snapshot.commit, snapshotFetchedAt: snapshot.fetchedAt, currentUpstreamConfirmedAt: '2026-10-17', deployedRevisionVerified: false },
  verification: { allEntriesPresentExactlyOnce: true, snapshotFilesHashVerified: Object.keys(snapshot.files).length, codeCitationCount: citations, originalSourceDataModified: false },
  counts,
  entries,
};
fs.writeFileSync(path.join(dir, 'official-faq-audit.json'), JSON.stringify(ledger, null, 2) + '\n');
console.log(JSON.stringify({ entries: entries.length, counts, validatedCodeCitations: citations, snapshotFiles: Object.keys(snapshot.files).length }, null, 2));
