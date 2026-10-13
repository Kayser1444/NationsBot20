import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const awards = [5, 3, 2, 1];
const sameNames = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every(name => b.includes(name));

export function validateSeason(config) {
  if (!Number.isInteger(config.season) || config.season < 1 || !config.divisions) throw new Error('Invalid SM season.');
  const ids = new Set(), players = new Set();
  for (const [div, group] of Object.entries(config.divisions)) {
    if (!/^\d+[A-Z]$/.test(div) || !Array.isArray(group.players) || !Array.isArray(group.matches) || !group.matches.length) throw new Error('Invalid SM division.');
    for (const name of group.players) {
      if (typeof name !== 'string' || !name || /[`\n\r]/.test(name) || players.has(name)) throw new Error('Invalid or duplicate SM player.');
      players.add(name);
    }
    const titles = new Set();
    for (const match of group.matches) {
      if (!/^\d+$/.test(match.id) || ids.has(match.id) || !new RegExp(`^S${config.season}-${div}-P[1-8]$`).test(match.title) || titles.has(match.title) || !Array.isArray(match.players) || match.players.length !== 4 || new Set(match.players).size !== 4 || !match.players.every(name => group.players.includes(name))) throw new Error('Invalid locked SM match.');
      ids.add(match.id); titles.add(match.title);
    }
    if (!group.players.every(name => group.matches.some(m => m.players.includes(name)))) throw new Error('SM player has no matches.');
  }
  return config;
}

function extract(match, message, now) {
  const state = message?.state;
  if (message?.replaying !== false || !state || ![0, 1, false, true].includes(state.game_over)) return null;
  if (!state.players || !Array.isArray(state.player_order) || !sameNames(Object.keys(state.players), match.players) || !sameNames(state.player_order, match.players)) throw new Error(`SM participant/order mismatch: ${match.id}`);
  const drafting = state.round === 0 && state.phase === 'Drafting Phase' && !state.game_over;
  const players = match.players.map(name => {
    const p = state.players[name];
    if (drafting) return { name, score: null, remainder: null };
    if (!Number.isInteger(p.score) || !Number.isInteger(p.resource_remainder) || p.resource_remainder < 0 || p.resource_remainder > 9) throw new Error(`Invalid SM score: ${match.id}`);
    return { name, score: p.score, remainder: p.resource_remainder };
  });
  return { state: { players: Object.fromEntries(players.map(p => [p.name, { score: p.score, resource_remainder: p.remainder }])), player_order: [...state.player_order], game_over: Boolean(state.game_over), round: state.round, phase: state.phase }, updatedAt: now };
}

export function rankTable(group, snapshots) {
  const rows = group.players.map(name => ({ name, points: 0, wins: 0, seconds: 0, games: [], tiebreak: '–' }));
  for (const match of group.matches) {
    const state = snapshots.get(match.id).state;
    if (state.round === 0 && state.phase === 'Drafting Phase') continue;
    const ranked = [...match.players].sort((a, b) => state.players[b].score - state.players[a].score || state.players[b].resource_remainder - state.players[a].resource_remainder || state.player_order.indexOf(a) - state.player_order.indexOf(b));
    ranked.forEach((name, i) => {
      const row = rows.find(r => r.name === name);
      row.points += awards[i]; row.wins += Number(i === 0); row.seconds += Number(i === 1);
      row.games.push({ id: match.id, points: awards[i], wins: Number(i === 0), seconds: Number(i === 1), vp: state.players[name].score });
    });
  }
  // Resolve each tied cohort together, rather than a pairwise comparator that
  // can produce circular ordering when three or more players are tied.
  const labels = ['Poäng', 'Vinster', 'Andraplatser', 'Inbördes p', 'Inbördes vinster', 'Inbördes tvåor', 'Inbördes VP'];
  function resolve(cohort, stage = 0, headIds = null) {
    if (cohort.length < 2) return cohort;
    if (stage === 7) { const tie = Symbol(); cohort.forEach(r => { r.tie = tie; r.tiebreak = 'Lika'; }); return cohort; }
    if (stage === 3) {
      const names = new Set(cohort.map(r => r.name));
      headIds = new Set(group.matches.filter(m => m.players.filter(n => names.has(n)).length >= 2).map(m => m.id));
    }
    const value = row => stage < 3 ? row[['points', 'wins', 'seconds'][stage]] : row.games.filter(g => headIds.has(g.id)).reduce((n, g) => n + g[['points', 'wins', 'seconds', 'vp'][stage - 3]], 0);
    const buckets = new Map();
    for (const row of cohort) { const n = value(row); if (!buckets.has(n)) buckets.set(n, []); buckets.get(n).push(row); }
    if (buckets.size > 1 && stage > 0) cohort.forEach(row => { row.tiebreak = `${labels[stage]}: ${value(row)}`; });
    return [...buckets.entries()].sort((a, b) => b[0] - a[0]).flatMap(([, bucket]) => resolve(bucket, stage + 1, headIds));
  }
  const sorted = resolve(rows);
  sorted.forEach((row, i) => { row.place = row.tie && i && sorted[i - 1].tie === row.tie ? sorted[i - 1].place : i + 1; });
  return sorted;
}

export class SmTableCache {
  constructor(config, { path, now = () => Date.now(), report = () => {} } = {}) {
    this.config = validateSeason(config); this.path = path; this.now = now; this.report = report;
    this.snapshots = new Map(); this.connected = new Set(); this.tables = new Map(); this.lastContact = new Map();
    this.matches = Object.values(config.divisions).flatMap(group => group.matches);
    if (path && existsSync(path)) {
      try {
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        if (saved.lock !== JSON.stringify(config)) throw new Error('Season lock changed');
        for (const match of this.matches) {
          const cached = saved.snapshots[match.id];
          if (cached && Number.isFinite(cached.updatedAt)) this.snapshots.set(match.id, extract(match, { replaying: false, state: cached.state }, cached.updatedAt));
        }
      } catch { this.snapshots.clear(); report('SM-cachen kunde inte läsas. Väntar på färska snapshots.', 'error'); }
    }
    for (const div of Object.keys(config.divisions)) this.rebuild(div);
  }
  has(id) { return this.matches.some(m => m.id === id); }
  divisionFor(name) { return Object.entries(this.config.divisions).find(([, g]) => g.players.includes(name))?.[0]; }
  connection(id, connected) {
    if (connected) this.connected.add(id);
    else { this.connected.delete(id); this.lastContact.delete(id); }
  }
  update(id, message) {
    const match = this.matches.find(m => m.id === id);
    if (!match) return false;
    // Anonymous info requests return only {turns: 0} after the initial snapshot.
    // This confirms socket liveness; full state arrives on each game change.
    if (message && Object.keys(message).length === 1 && Number.isInteger(message.turns) && message.turns >= 0) {
      if (this.connected.has(id) && this.snapshots.has(id)) this.lastContact.set(id, this.now());
      return false;
    }
    let snapshot;
    try { snapshot = extract(match, message, this.now()); }
    catch (error) { this.connected.delete(id); this.report(error.message, 'error'); return false; }
    if (!snapshot) return false;
    this.snapshots.set(id, snapshot); this.connected.add(id); this.lastContact.set(id, this.now());
    this.rebuild(this.divisionFor(match.players[0]));
    if (this.path) {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path + '.tmp', JSON.stringify({ lock: JSON.stringify(this.config), snapshots: Object.fromEntries(this.snapshots) }) + '\n');
        renameSync(this.path + '.tmp', this.path);
      } catch { this.report('SM-cachen kunde inte sparas till disk. Minnescachen används.', 'error'); }
    }
    return true;
  }
  rebuild(div) {
    const group = this.config.divisions[div];
    if (group.matches.every(m => this.snapshots.has(m.id))) this.tables.set(div, rankTable(group, this.snapshots));
  }
  reply(div, userId, subscriptions) {
    if (!div) {
      const name = Object.entries(subscriptions).find(([, id]) => Array.isArray(id) ? id.includes(userId) : id === userId)?.[0];
      if (!name) return 'Ange div:1A, div:2A eller div:2B. Automatisk grupp kräver en aktiv prenumeration.';
      div = this.divisionFor(name);
      if (!div) return 'Ditt Nations-namn finns inte i SM denna säsong. Ange div:1A, div:2A eller div:2B.';
    }
    const group = this.config.divisions[div];
    if (!group) return 'Okänd SM-grupp. Välj div:1A, div:2A eller div:2B.';
    const missing = group.matches.filter(m => !this.snapshots.has(m.id));
    if (missing.length) return `SM S${this.config.season} · ${div}: väntar på ${missing.length} av ${group.matches.length} partier. Försök igen strax.`;
    const stale = group.matches.filter(m => !this.snapshots.get(m.id).state.game_over && (!this.connected.has(m.id) || this.now() - (this.lastContact.get(m.id) ?? this.snapshots.get(m.id).updatedAt) > 60000));
    const oldest = Math.min(...group.matches.filter(m => !this.snapshots.get(m.id).state.game_over).map(m => this.lastContact.get(m.id) ?? this.snapshots.get(m.id).updatedAt));
    const stamp = Number.isFinite(oldest) ? oldest : Math.max(...group.matches.map(m => this.snapshots.get(m.id).updatedAt));
    const time = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'medium' }).format(stamp);
    const rows = this.tables.get(div);
    const width = Math.max(7, ...rows.map(r => r.name.length));
    const lines = rows.map(r => `${String(r.place).padStart(5)}  ${r.name.padEnd(width)}  ${String(r.points).padStart(5)}  ${r.tiebreak}`);
    const header = `Plats  ${"Spelare".padEnd(width)}  Poäng  Skiljekriterium`;
    const boundary = div === "1A" ? rows.length - 2 : /^2[A-Z]$/.test(div) ? 1 : -1;
    if (boundary > 0 && boundary < lines.length) {
      const separator = "─".repeat(Math.max(header.length, ...lines.map(line => line.length)));
      lines.splice(boundary, 0, separator);
    }
    const ongoing = group.matches.filter(m => !this.snapshots.get(m.id).state.game_over).length;
    const drafting = group.matches.filter(m => this.snapshots.get(m.id).state.phase === 'Drafting Phase' && this.snapshots.get(m.id).state.round === 0);
    return [`**Svenska mästerskapet · S${this.config.season} · Division ${div}**`, `Bevakning kontrollerad: ${time}`, stale.length ? `⚠️ ${stale.length} parti(er) saknar aktuell anslutning eller färsk avläsning. Senast kända ställning visas.` : '', '```text', header, ...lines, '```', `${ongoing}/${group.matches.length} partier ej avslutade. Grupppoäng: 5/3/2/1. Rangordning enligt §7.`, drafting.length ? `Väntar på spelstart: ${drafting.map(m => m.title).join(', ')}. Dessa partier ger ännu inga grupppoäng.` : '', 'Inbördes = gemensamma partier. Vinster/tvåor = aktuella placeringar.'].filter(Boolean).join('\n');
  }
}
