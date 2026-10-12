import { validateSubscriptions } from './subscriptions.mjs';

export const commands = [
  { name: 'notifications', description: 'Turn Nations reminders on or off', type: 1, options: [
    { name: 'on', description: 'Enable turn reminders', type: 1, options: [
      { name: 'nationsname', description: 'Exact Nations name; omit to match your Discord display name', type: 3, required: false, autocomplete: true, max_length: 100 },
    ] },
    { name: 'off', description: 'Disable your turn reminders', type: 1 },
  ] },
  { name: 'status', description: 'Show your Nations subscription and monitored games', type: 1 },
  { name: 'dm', description: 'Choose private or channel reminders', type: 1, options: [
    { name: 'on', description: 'Send your reminders only by DM', type: 1 },
    { name: 'off', description: 'Send your reminders in the reminders channel (default)', type: 1 },
  ] },
  { name: 'help', description: 'Show commands and what NationsBot can do', type: 1 },
];
export const helpMessage = [
  '**Nations Bot 2.0 — hjälp**',
  'Jag bevakar publika Nations-partier och påminner dig när det är din tur, med en länk till partiet.',
  '',
  '**Kommandon**',
  '`/notifications on` — starta påminnelser med ditt senast använda Nations-namn. Första gången matchas ditt Discord-visningsnamn utan hänsyn till stora och små bokstäver. Ett tillägg inom parentes, som i Kayser (Jonas Adolphson), ignoreras.',
  '`/notifications on nationsname:Kayser` — välj ett Nations-namn själv. Ange exakt skiftläge; namnförslag finns medan du skriver.',
  '`/notifications off` — avsluta dina egna påminnelser.',
  '`/dm on` — få turpåminnelser enbart som DM och ett kontroll-DM direkt. `/dm off` — få dem i kanalen (standard). Valet sparas även när du slår av påminnelser.',
  '`/status` — visa din prenumeration och hur många pågående partier som bevakas.',
  '`/help` — visa den här hjälpen.',
  '',
  '**Bra att veta**',
  'Ett Discord-konto kan ha en prenumeration. Ett upptaget Nations-namn kan inte tas över. Avprenumerera först om du vill byta namn; kontakta Kayser om en koppling är fel.',
  'Nya partier upptäcks automatiskt, normalt inom fem minuter. En redan väntande tur kan ge en påminnelse direkt vid prenumeration.',
  'Det här är en prototyp. Kommandon och påminnelser fungerar medan tjänsten kör. Start och stopp annonseras i kanalen utan omnämningar.',
  'Kommandosvaren är privata. Tillåt Discord-aviseringar och DM från boten om du valt DM. Nekade DM visas i /status och skickas aldrig i kanalen.',
].join('\n');
const quote = name => '`' + name.replace(/[`\r\n]/g, '') + '`';
const folded = name => name.toLocaleLowerCase('sv-SE');
// A server nickname may append a real name: "Kayser (Jonas Adolphson)".
// Only automatic Discord-name matching removes that trailing annotation.
const playerAlias = name => name.trim().replace(/\s+\([^()]*\)\s*$/u, '').trim();

export function autocompleteNames(names, query) {
  const selected = folded(query.trim());
  return [...new Set(names)].filter(name => name.length <= 100 && folded(name).includes(selected))
    .sort((a, b) => Number(!folded(a).startsWith(selected)) - Number(!folded(b).startsWith(selected)) || a.localeCompare(b, 'sv'))
    .slice(0, 25).map(name => ({ name, value: name }));
}

// Called synchronously after Discord acknowledges the interaction. Check and save
// have no await between them, so simultaneous claims cannot replace each other.
export function handleSubscriptionCommand({ command, action, userId, displayName, nationsName }, { getSubscriptions, getNames, commit, getStatus, getPreviousName = () => null, getDm = () => false, setDm }) {
  if (command === 'help') return helpMessage;
  if (command === 'dm') {
    if (!['on', 'off'].includes(action)) return 'Använd /dm on eller /dm off.';
    setDm(userId, action === 'on');
    return action === 'on' ? 'DM är på. Dina turpåminnelser skickas bara privat, aldrig i kanalen. Tillåt DM från boten. Inställningen sparas; /notifications on aktiverar själva prenumerationen.' : 'DM är av. Dina turpåminnelser skickas i påminnelsekanalen. Inställningen sparas.';
  }
  const current = getSubscriptions();
  const own = Object.entries(current).find(([, id]) => id === userId)?.[0];
  if (command === 'status') {
    const state = getStatus(own, userId);
    const mode = getDm(userId) ? 'Leverans: endast DM.' : 'Leverans: påminnelsekanalen (DM av).';
    const blocked = state.blocked ? ' Ett utskick är blockerat. Kontrollera DM-inställningarna eller kontakta Kayser; /dm on eller /dm off gör ett nytt försök.' : '';
    const summary = (own ? `Du prenumererar på påminnelser för ${quote(own)}. ${state.matches} pågående partier bevakas. ${state.discordEnabled ? 'Discord-utskick är aktiverade.' : 'Discord-utskick är inte aktiverade.'}` : 'Du har ingen prenumeration. Använd /notifications on för att börja.') + ' ' + mode + blocked;
    if (!own || !state.matchList?.length) return summary;
    const rows = state.matchList.map(match => {
      const title = (match.title || `Parti ${match.id}`).replace(/[\r\n\t]+/g, ' ').replace(/[\\`*_[\]<>@]/g, '').slice(0, 100);
      return `• [${title}](<https://games.tabony.net/nations/${encodeURIComponent(match.id)}/>) · ID ${match.id} · ${match.connected ? 'ansluten' : 'ej ansluten'}`;
    });
    return summary + '\n\n**Dina bevakade partier**\n' + rows.join('\n');
  }
  if (command === 'notifications' && action === 'off') {
    if (!own) return 'Du har ingen prenumeration att avsluta.';
    const next = { ...current }; delete next[own]; commit(next);
    return `Prenumerationen för ${quote(own)} är avslutad.`;
  }
  if (command !== 'notifications' || action !== 'on') return 'Okänt kommando. Använd /help för hjälp.';
  const names = [...new Set([...getNames(), ...Object.keys(current)])];
  const previousName = nationsName == null ? own || getPreviousName(userId) : null;
  let name;
  if (nationsName !== null && nationsName !== undefined) {
    name = nationsName.trim();
    const similar = names.filter(item => folded(item) === folded(name));
    if (!names.includes(name) && similar.length) return `Nations-namn skiljer på stora och små bokstäver. Ange det exakta namnet: ${similar.map(quote).join(', ')}.`;
  } else if (previousName) {
    // Reuse the exact historical spelling even if no current game lists it.
    name = previousName;
  } else {
    const matches = names.filter(item => folded(item) === folded(playerAlias(displayName)));
    if (!matches.length) return 'Ditt Discord-namn matchar inget känt Nations-namn. Ange nationsname i /notifications on eller välj ett namnförslag.';
    if (matches.length > 1) return `Flera Nations-namn matchar ditt Discord-namn: ${matches.map(quote).join(', ')}. Ange nationsname med exakt skiftläge.`;
    name = matches[0];
  }
  if (Object.hasOwn(current, name) && current[name] !== userId) return `${quote(name)} har redan en prenumerant och kan inte tas över. Kontakta Kayser om kopplingen är fel.`;
  if (own === name) return `Du prenumererar redan på ${quote(name)}.`;
  if (own) return `Du prenumererar redan på ${quote(own)}. Avsluta först med /notifications off innan du väljer ett annat namn.`;
  commit(validateSubscriptions({ ...current, [name]: userId }));
  return `Du prenumererar nu på påminnelser för ${quote(name)}. Påminnelserna skickas ${getDm(userId) ? 'endast som DM' : 'i påminnelsekanalen'}. En väntande tur kan ge en påminnelse direkt.`;
}
