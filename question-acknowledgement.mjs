// A tentative local routing hint, never a ruling or an extra model request.
export function questionSearchHint(question, language = 'en-US') {
  const text = String(question).toLowerCase();
  const routes = [];
  if (/regel|rule|règle|regla|regelbuch|规则|rulebook/.test(text)) routes.push('rules');
  if (/faq|errata|clarification|förtydlig/.test(text)) routes.push('faq');
  if (/kort|card|carte|carta|karte|卡|advisor|adviser|wonder|underverk|leader|ledare|händelse|event|dynast|gold|guld|stability|stabilitet/.test(text)) routes.push('cards');
  if (/tabon[yi]|implement|kod|code|bug|python|源码/.test(text)) routes.push('code');
  if (!routes.length) routes.push('rules', 'faq');
  const translations = {
    sv: ['Frågan är mottagen. Jag börjar troligen i ', '. Jag kontrollerar andra lokala källor vid behov.', ['regelboken', 'FAQ:n', 'kortbiblioteket', 'Tabony-koden']],
    en: ['Question received. I will probably start with ', '. I will check other local sources as needed.', ['the rulebook', 'the FAQ', 'the card library', 'the Tabony code']],
    fr: ['Question reçue. Je commencerai probablement par ', '. Je consulterai les autres sources locales si nécessaire.', ['les règles', 'la FAQ', 'la bibliothèque de cartes', 'le code Tabony']],
    de: ['Frage erhalten. Ich beginne voraussichtlich mit ', '. Bei Bedarf prüfe ich weitere lokale Quellen.', ['dem Regelbuch', 'der FAQ', 'der Kartenbibliothek', 'dem Tabony-Code']],
    es: ['Pregunta recibida. Probablemente empezaré por ', '. Consultaré otras fuentes locales si es necesario.', ['el reglamento', 'las FAQ', 'la biblioteca de cartas', 'el código de Tabony']],
    zh: ['已收到问题。我可能先查阅：', '。如有需要，我会检查其他本地资料。', ['规则书', '常见问题', '卡牌资料库', 'Tabony 源代码']],
  };
  const [prefix, suffix, names] = translations[language.split('-')[0]] ?? translations.en;
  const keys = ['rules', 'faq', 'cards', 'code'];
  return { text: prefix + routes.map(route => names[keys.indexOf(route)]).join(' / ') + suffix,
    englishText: translations.en[0] + routes.map(route => translations.en[2][keys.indexOf(route)]).join(' / ') + translations.en[1], routes };
}
