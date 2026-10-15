import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const sourceFiles = ['__init__.py', '__main__.py', 'abbr.py', 'actions.py', 'cards.py', 'cli.py',
  'dynasty_cards.py', 'event_cards.py', 'events.py', 'exceptions.py', 'match.py', 'nations.py',
  'phases.py', 'player.py', 'progress_cards.py', 'resources.py', 'stats.py', 'utils.py', 'LICENSE', 'README.md'];
export const dayMs = 86400000;
const hash = text => createHash('sha256').update(text).digest('hex');
export function saveQuestionJson(path, value) {
  writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
export function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(snapshot.commit) ||
      snapshot.repository !== 'Logitude/nations' || typeof snapshot.fetchedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.fetchedAt)) || !snapshot.files ||
      Object.keys(snapshot.files).length !== sourceFiles.length) throw new Error('Invalid question sources.');
  for (const name of sourceFiles) {
    const file = snapshot.files[name];
    if (!file || typeof file.text !== 'string' || Buffer.byteLength(file.text) > 500000 ||
        file.sha256 !== hash(file.text)) throw new Error('Invalid question source file.');
  }
  return snapshot;
}

// Only this updater has GitHub access. Its targets cannot be chosen by a question or the model.
export function createSourceStore({ directory, seed, fetcher = fetch, now = Date.now, report = () => {} }) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'tabony-snapshot.json'), syncPath = join(directory, 'source-sync.json');
  let snapshot = validateSnapshot(JSON.parse(readFileSync(existsSync(path) ? path : seed, 'utf8')));
  let lastAttempt = 0, timer, active, stopped = false;
  if (existsSync(syncPath)) {
    try { lastAttempt = JSON.parse(readFileSync(syncPath, 'utf8')).lastAttempt || 0; } catch { /* Retry a damaged sync marker. */ }
  }
  async function download(url, limit) {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'NationsBot-question-sources' } });
    if (!response.ok) throw new Error('Source download failed.');
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error('Source download too large.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  async function update() {
    if (stopped || active || (lastAttempt && now() - lastAttempt < dayMs)) return active;
    lastAttempt = now();
    saveQuestionJson(syncPath, { lastAttempt });
    active = (async () => {
      try {
        const info = JSON.parse(await download('https://api.github.com/repos/Logitude/nations/commits/main', 1000000));
        if (!/^[a-f0-9]{40}$/.test(info.sha)) throw new Error('Invalid commit.');
        const next = { schemaVersion: 1, repository: 'Logitude/nations', commit: info.sha,
          fetchedAt: new Date(now()).toISOString(), files: {} };
        if (info.sha === snapshot.commit) next.files = snapshot.files;
        else for (const name of sourceFiles) {
          if (stopped) return;
          const text = await download(`https://raw.githubusercontent.com/Logitude/nations/${info.sha}/${name}`, 500000);
          next.files[name] = { text, sha256: hash(text) };
        }
        validateSnapshot(next);
        if (stopped) return;
        saveQuestionJson(path, next); // Publish only a complete, validated version.
        snapshot = next;
        report('Frågekällan från GitHub är uppdaterad.');
      } catch {
        report('Frågekällan kunde inte uppdateras; senaste kompletta lokala versionen behålls.', 'error');
      } finally { active = null; }
    })();
    return active;
  }
  return { snapshot: () => snapshot, update,
    start() {
      void update().catch(() => report('Frågekällans uppdateringsstatus kunde inte sparas.', 'error'));
      timer = setInterval(() => void update().catch(() => report('Frågekällans uppdateringsstatus kunde inte sparas.', 'error')), 3600000);
      timer.unref?.();
    },
    close() { stopped = true; clearInterval(timer); },
  };
}

// A per-question immutable corpus: no file paths, URLs, shell, match state or credentials are exposed.
export function loadQuestionRulebooks() {
  const root = new URL('./data/rules/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.books?.length !== 2) throw new Error('Invalid rulebook manifest.');
  return manifest.books.map(book => {
    if (!['base', 'dynasties'].includes(book.id) || book.markdown !== `${book.id}.md` || book.pages.length !== book.pageCount) throw new Error('Invalid rulebook.');
    const markdown = readFileSync(new URL(book.markdown, root), 'utf8').replace(/\r\n/g, '\n');
    if (hash(markdown) !== book.markdownSha256) throw new Error('Rulebook content changed without reimport.');
    const lines = markdown.split('\n');
    return book.pages.map((page, index) => {
      if (page.page !== index + 1 || !Number.isInteger(page.startLine) || !Number.isInteger(page.endLine) ||
          page.startLine < 1 || page.endLine > lines.length || page.endLine < page.startLine ||
          lines[page.startLine - 1] !== `## PDF page ${page.page}`) throw new Error('Invalid rulebook page range.');
      return { id: `rules/${book.id}/page-${page.page}`, kind: 'rulebook', title: book.title,
        page: page.page, edition: book.edition, review: book.review, headings: page.headings,
        sourceSha256: book.sourceSha256, text: lines.slice(page.startLine - 1, page.endLine).join('\n') };
    });
  }).flat();
}

export function createQuestionCorpus(snapshot, faq, rulebooks = [], cards = null) {
  const sources = new Map();
  if (cards) {
    sources.set('cards/index', { kind: 'card-index', title: 'English card names and effects',
      text: '# English card library\n' + JSON.stringify(cards.summary) + '\nUse search_cards for name/effect lookup, then read_source on the returned IDs. Score is relevance, not confidence. Image-reviewed text and implementation descriptions are separate evidence.' });
    for (const { searchText, searchNames, ...document } of cards.documents) {
      const { id, ...source } = document;
      sources.set(id, source);
    }
  }
  for (const { id, ...source } of rulebooks) sources.set(id, source);
  for (const [name, file] of Object.entries(snapshot.files)) sources.set(`code/${name}`, {
    kind: 'implementation', title: name, commit: snapshot.commit, text: file.text,
  });
  for (const entry of faq.entries) sources.set(`faq/${entry.id}`, {
    kind: 'faq', title: entry.heading, pages: entry.sourcePages, version: '1.11',
    review: entry.review?.status ?? 'pending', text: entry.sourceText,
  });
  // Card names/effects are retrieved on demand; listing every card in every API call wastes context.
  const catalogue = () => [...sources].filter(([, source]) => source.kind !== 'card').map(([id, source]) => ({ id, title: source.title, kind: source.kind,
    ...(source.kind === 'rulebook' ? { page: source.page, headings: source.headings } : {}) }));
  const read = ({ id, start = 1, count = 60 }) => {
    const source = sources.get(id);
    if (!source || !Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 100) return { error: 'Unknown source or invalid line range.' };
    const { text, ...metadata } = source;
    const lines = text.split('\n');
    return { id, ...metadata, totalLines: lines.length,
      excerpt: lines.slice(start - 1, start - 1 + count).map((line, i) => `${start + i}: ${line}`).join('\n').slice(0, 10000) };
  };
  const search = ({ query }) => {
    if (typeof query !== 'string' || query.length > 200 || !query.trim()) return { error: 'Use a short literal search.' };
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];
    for (const [id, source] of sources) {
      if (source.kind === 'card') continue; // Card candidates have their own ranked search; do not crowd out rules/code.
      const lines = source.text.split('\n');
      let sourceHits = 0;
      for (let i = 0; i < lines.length; i++) {
        const value = lines[i].toLowerCase();
        if (terms.every(term => value.includes(term))) {
          const first = Math.min(...terms.map(term => value.indexOf(term)));
          const offset = Math.max(0, first - 180);
          hits.push({ id, line: i + 1, ...(source.kind === 'rulebook' ? { page: source.page } : {}),
            excerpt: lines[i].slice(offset, offset + 700) });
          if (++sourceHits >= 2) break;
        }
      }
    }
    return hits.slice(0, 14);
  };
  return { catalogue, read, search, searchCards: args => cards?.search(args) ?? [], commit: snapshot.commit, fetchedAt: snapshot.fetchedAt };
}
