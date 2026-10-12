// Public listing discovery; no account cookies or game mutations.
const routes = ['/nations/matches/', '/nations/archive/ongoing/'];
const headings = ['Ongoing Nations Matches', 'Archived Ongoing Nations Matches'];
const decode = value => value.replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
  const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
  return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
}).replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function parseMatchListing(html, heading) {
  if (!html.includes(`<h1>${heading}</h1>`)) {
    throw new Error('Public listing format changed or returned an unexpected page.');
  }
  const cards = html.split('<div class="card my-2"').slice(1);
  if (!cards.length && !/<li>\s*None\.\s*<\/li>/.test(html)) {
    throw new Error('Public listing contained neither match cards nor an empty-list marker.');
  }
  return cards.map(card => {
    const id = card.match(/href="\/nations\/(\d+)\/"/)?.[1];
    const players = card.match(/Players:([\s\S]*?)<\/div>/)?.[1];
    const title = card.match(/Title:\s*<span[^>]*>([^<]*)<\/span>/)?.[1];
    const names = [...(players ?? '').matchAll(/<span[^>]*>([^<]*)<\/span>/g)]
      .map(m => decode(m[1]).trim());
    if (!id || title === undefined || !names.length || names.some(name => !name)) {
      throw new Error('Public match card format changed.');
    }
    return { id, title: decode(title), players: names };
  });
}

export async function discoverPublicMatches({ fetcher = fetch, signal } = {}) {
  const pages = await Promise.allSettled(routes.map(async (route, index) => {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    const response = await fetcher(`https://games.tabony.net${route}`, { signal: requestSignal, redirect: 'error' });
    if (!response.ok) throw new Error(`Public listing failed: HTTP ${response.status}`);
    return parseMatchListing(await response.text(), headings[index]);
  }));
  // Never apply partial results if either listing fails.
  for (const page of pages) if (page.status === 'rejected') throw page.reason;
  const matches = new Map();
  for (const page of pages) for (const match of page.value) {
    matches.set(match.id, match);
  }
  return [...matches.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

export async function discoverMatches(usernames, options = {}) {
  const selected = new Set(usernames);
  if (!selected.size) return [];
  return (await discoverPublicMatches(options)).filter(match => match.players.some(name => selected.has(name)));
}

export function addDiscoveredMatches(existing, discovered) {
  const byId = new Map(existing.map(match => [match.id, match]));
  const added = [];
  for (const info of discovered) {
    const known = byId.get(info.id);
    if (known) {
      // Preserve observed turn state and socket across listing refreshes.
      known.title = info.title;
      known.players = info.players;
    } else {
      const match = { ...info, state: null, status: 'connecting', backoff: 1000 };
      existing.push(match);
      byId.set(match.id, match);
      added.push(match);
    }
  }
  return added;
}
