# Nations FAQ: lokalt granskningsunderlag

Status 2026-10-14: **FAQ++ 1.11 importerad** från användarens `Reference/faq++1.11.pdf`. Dokumentet är daterat 5 december 2017 och omfattar tio sidor. Vi har 216 textposter och 547 indexrubriker. Tio poster med 13 svarspunkter per språk är källkontrollerade av Codex för Porcelain Tower; resterande 206 poster och deras automatiska kopplingar är `pending`. Det innebär ingen användargranskning eller kontroll av vilken version som nu kan laddas ner från BGG.

`/card` använder registret via `card-bank.mjs` i den separata Railway-stagingmiljön. Kortinventeringen omfattar 503 poster, 422 verifierade bildlänkar och samtliga 479 kortnamnsrubriker i FAQ:n. Alla 216 textposter har nu svenska svarspunkter; de 206 som saknade svenska har översatts och de 10 pilotposternas svenska sammanfattningar behålls. Alla kopplade punkter, även `pending`, visas utan granskningsdisclaimer enligt användarens önskemål. Relevanta korttypsregler och uttryckliga regelhänvisningar ingår också. Varje punkt behåller källsidan och FAQ-vyn länkar till den engelska källan. Visningen ändrar inga granskningsbeslut. Se [kortinventering och bildstatus](../cards/README.md).

## Filer och ansvar

- `sources.json`: dokumentets identitet, version, datum, ursprung och SHA-256 från den faktiska PDF:en.
- `entries.json`: maskinläsbara FAQ-poster och deras separata granskningsstatus. Detta är den primära datakällan för den kommande funktionen.
- `review.md`: läsvänlig genomgång som genereras från registret när originalet har importerats. Användaren granskar innehållet och kortkopplingarna här; överenskomna ändringar förs tillbaka till registret innan boten använder dem.
- `entry.schema.json`: den föreslagna strukturen för en enskild post.
- `index.json`: alla 547 rubriker, även sådana utan egen regeltext. Tomma kortposter blir inte påhittade regler.
- `document.json`: bevarade textblock, dokumentkontext, spalter och positioner. Alla 1804 extraherade rader redovisas.
- `pilot-review.json`: separat källkontrollerat urval, svenska/engelska sammanfattningar, kortkopplingar och källtextens checksummor. Importören godkänner inga poster automatiskt.
- `translations-sv.json`: 206 svenska översättningar och 77 svenska rubriker, med SHA-256 för dokumentet och motsvarande engelska text. Ändrad källtext stoppar återapplicering tills översättningen uppdaterats. Originaltext, engelska punkter och granskningsbeslut bevaras.

Ändra svenska översättningar i `translations-sv.json` och kör `scripts/apply-faq-translations.mjs`; skriptet uppdaterar både registret och granskningsunderlaget. Det avbryter om engelska källtexter har ändrats eller en tidigare godkänd/avvisad översättning skulle skrivas över med annan text.
- `../cards/catalog.json`: 520 sökbara metadataobjekt, inklusive 17 nationsposter och 74 startkort med extraherade bilder. Pythonkällan läses med AST utan att köra spelkod. Bildstatus och FAQ-granskning hanteras separat.
- `../cards/faq-coverage.json`: inventeringskopplingar för samtliga kortnamnsrubriker, inklusive specialkort och startvarianter. Nya FAQ-kopplingar är `pending`.

Original-PDF:en ligger i `Reference`; renderade sidor och extraherad text finns under `work/faq-source/`. PDF-textlagret tappar bokstäver i ligaturer (t.ex. `efect`, `frst`). Originaltexten bevaras, medan kontrollerade sammanfattningar använder vanlig stavning. Dokumentets SHA-256 identifierar exakt vilket original genomgången avser.

## Återskapa och förhandsvisa

Kör med Python som har `pdfplumber` och ange sökvägen till den lokala Nations-spelimplementationen:

```text
python scripts/import-faq.py --game-source <sökväg-till-nations-pythonkällan>
python scripts/import-card-catalog.py --game-source <sökväg-till-nations-pythonkällan>
node scripts/update-card-faq-coverage.mjs
node scripts/verify-card-images.mjs
node scripts/review-faq-pilot.mjs
node scripts/apply-faq-translations.mjs
node work/render-card-preview.mjs PcTw sv-SE
node work/build-card-preview.mjs work/card-preview-faq.json
```

Importören läser vänster, mitten och höger spalt i ordning, med kompletta tecken och fortsättningar över spalt- och sidgränser. Rubriker styr postgränserna. Det separata pilotsteget avbryter om PDF-checksumman eller någon kontrollerad källtext har ändrats. Hela originalet har inspekterats visuellt; det automatiskt avgränsade materialet utanför piloten behöver fortfarande innehållsgranskning.

DM-kommandot förbereds i `work/card-preview-command.txt`. Samma renderer används av slash-kommandot och förhandsvisningen. FAQ:n börjar nu hopfälld i ett enda kortmeddelande; långa svar får sidknappar utan att punkter försvinner. En statisk engångssändning får fungerande knappar först när avsändarboten kör den nya knapphanteringen. Ingen FAQ-PDF hämtas eller tolkas vid ett Discord-kommando.

## Så ska hela FAQ:n tas in

1. Identifiera den tillhandahållna PDF:ens titel, version, datum och omfattning; spara checksumma och källhänvisning.
2. Extrahera hela dokumentet i rätt kolumnordning. Kontrollera samtliga sidor visuellt: rubriker, spaltövergångar, fotnoter, ändringsmarkeringar och korshänvisningar får inte tappas.
3. Registrera alla regelposter, inklusive allmänna regler, korttyper, kortspecifika poster och eventuella nations-, dynasti- eller promoregler. Rubriker utan egen regeltext blir indexuppgifter, inte påhittade FAQ-svar. Inledning, innehållsförteckning och versionshistorik bevaras som dokumentkontext.
4. Bevara den engelska källtexten. Gör en eller flera korta svarspunkter per post med alla villkor kvar. Håll sammanfattning/översättning åtskild från originalet. Ge varje punkt en egen granskningsstatus.
5. Koppla både den egna kortposten och relevanta hänvisningar under andra poster till kortets stabila ID. Automatiskt föreslagna kopplingar ska granskas separat från regeltexten. Allmänna regler kopplas endast där de faktiskt är relevanta.
6. Generera `review.md` med post-ID, sidor, originaltext, föreslagna svarspunkter, kortkopplingar och plats för granskningsanteckningar.
7. Användaren granskar innehåll, formulering och kopplingar. `pending` blir aldrig automatiskt `approved` vid import.

Alla poster tas med i granskningsunderlaget. `/card` visar både `approved` och `pending` poster, punkter och kopplingar. `rejected` och okända granskningsstatusar visas inte. Svenska svar visar enbart svenska regeltexter och engelska svar enbart engelska, utan granskningsdisclaimer eller språknotis. Kortnamn behålls på engelska, medan allmänna rubriker och frågor översätts. Granskning sker fortsatt separat i `review.md`; inget blir automatiskt godkänt. Källsidor och länk till den engelska FAQ:n finns kvar för kontroll av översättningen. Ett kort utan kopplade punkter beskrivs som att koppling saknas i den importerade versionen. Fullständighetsstatus gäller en viss dokumentversion och ett visst kort.

## Föreslagen Discord-layout

Kortbilden visas öppet. Era och typ får högst en kompakt rad, exempelvis **Underverk · Era II**, i stället för separata metadatafält.

FAQ:n börjar hopfälld. En knapp under kortbilden växlar mellan **Visa FAQ (antal)** och **Dölj FAQ**. Boten uppdaterar samma meddelande: vid öppning lägger den till FAQ-punkterna, vid stängning tar den bort dem. Kortbild och den kompakta metadata-raden ligger kvar. Ingen spoiler-markering används.

```text
Hopfällt: kortbild + kompakt metadata + [Visa FAQ (antal)]

Utfällt: kortbild + kompakt metadata
FAQ · [verifierad version] · [antal] punkter
- [Första granskade regeln med sina villkor.]
- [Nästa granskade regel eller relevant korshänvisning.]

Källa: [officiell FAQ, sida/sidor]
[Dölj FAQ]
```

Hakparenteserna ovan är formatplatshållare, inte FAQ-innehåll. En post från ett annat kort anger sin ursprungliga rubrik så att sambandet blir begripligt. Om allt inte ryms får FAQ-ytan sidnumrering och knappar för föregående/nästa sida, medan Dölj FAQ finns kvar. Alla granskade punkter ska vara åtkomliga utan att en hopfällning lämnar kvar följdmeddelanden i kanalen.

Discord har ingen inbyggd accordion-komponent i det dokumenterade komponentutbudet. Lösningen bygger på en botknapp och en uppdatering av meddelandet. I en publik kanal ser alla samma öppna/stängda läge. Ett alternativ för individuell läsning är en Visa FAQ-knapp som ger klickaren ett privat, tillfälligt svar; det fäller inte ut FAQ:n i det publika kortmeddelandet. I DM berörs bara mottagaren.

Knapparna är implementerade lokalt i `card-bank.mjs` och `discord-bot.mjs`. Kör `npm run dev` och välj `/card name:Porcelain Tower` från NationsBot Dev. Knapparna uppdaterar samma meddelande, behåller dess språk och kontrollerar spärrar och DM-medlemskap vid varje klick. Knapp-ID:n innehåller kort, språk och önskad sida; de kräver ingen tillfällig minnessession och fungerar efter omstart om kortet fortfarande finns i katalogen. Produktionsboten är inte uppdaterad. [Discords knappkomponent](https://docs.discord.com/developers/components/reference#button), [uppdatera meddelandet vid knapptryck](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type).

## Granskningsbeslut

Varje post har tre separata frågor:

1. Är originaltexten korrekt extraherad och rätt avgränsad?
2. Återger svarspunkterna regeln korrekt, med undantag och villkor?
3. Är posten kopplad till rätt kort, även när kortet omnämns under en annan rubrik?

Förkortningarna i kortkopplingarna ska komma från den verifierade kortkatalogen. Exempelvis är Porcelain Towers bild-ID `PcTw`; visningsnamnet är inte filnamnet.


## Tyska, franska, spanska och förenklad kinesiska

Alla 216 textposter har även 219 svarspunkter per språk för `de`, `fr`, `es-ES` och `zh-CN`. Översättningarna ligger i `translations-de.json`, `translations-fr.json`, `translations-es.json` och `translations-zh.json`. Varje svarspunkt anger källpost, engelsk punkt och SHA-256 för båda texter, samt dokumentets checksumma. De engelska och svenska texterna är oförändrade. Allmänna rubriker och frågor översätts separat i `headingTranslations`; tryckta kort- och nationsnamn behålls.

Texterna är maskinöversatta med Google Translate med skyddade namn, versionstaggar och en gemensam spelordlista för bland annat runda, spelares tur, resurser och poäng. Stickprov och särskilda rättningar av komplexa regler dokumenteras i översättningsfilerna; detta är inte ett fullständigt innehållsgodkännande. De nya punkterna har granskningsstatus `pending`. Befintliga granskningsbeslut på original och kortkopplingar ändras inte.

Kör `node scripts/apply-faq-translations.mjs` för alla språk, eller ange `sv`, `de`, `fr`, `es` och/eller `zh` för en delmängd. Skriptet kontrollerar samtliga valda filer innan det sparar registret, vägrar att skriva över ändrade godkända/avvisade översättningar, och uppdaterar `review.md`. En ny import eller ändring av engelska källpunkter kräver att översättningarnas källkontroller uppdateras. Runtime använder enbart det lokala registret och har inget beroende av Google Translate.
