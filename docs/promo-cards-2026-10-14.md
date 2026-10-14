# Promo-kort från bildbilagorna

Tolv kortframsidor är separerade och normaliserade till 164 × 254 pixlar: elva från användarens tre bildbilagor och Antikythera Mechanism från en komplett lokal kortbild. Två kortbaksidor i den tredje bilagan används inte som kortposter. Sex nya poster utökar inventeringen till 526. Befintliga FAQ-ID:n, texter, källhänvisningar och granskningsbeslut bevaras. Hussar saknar fortfarande en komplett framsida; den befintliga lokala illustrationen räcker inte som regelkort.

| Kort | Typ | Era |
| --- | --- | --- |
| Imperium Rex | Händelse | III |
| Potemkin Village | Byggnad | III |
| Power Grid | Guldålder | IIII |
| Julius Agricola | Rådgivare | I |
| Engineering Genius | Guldålder | II |
| Solar Eclipse / Spring and Autumn Period | Ett händelsekort, två sökbara namn | I |
| Nikola Tesla | Rådgivare | IIII |
| Hagia Sophia | Underverk | II |
| Grand Duchy of Finland | Koloni | IIII |
| Kremlin | Underverk | III |
| Mechanical Turk | Underverk | III |
| Antikythera Mechanism | Guldålder | I |

Alla 13 promo-poster, inklusive Hussar, har `promo: true` och `tabonyImplemented: false`. Botens metadata visar på svenska eller engelska att kortet är ett promo-kort och inte ingår i Tabonys spelimplementation. Typ följer ramfärgen och era följer kortets nedre markeringar. Inga nya FAQ-regler har skrivits utifrån bilderna.

## Bildbehandling och verifiering

Vattenstämpelrensning gjordes med det inbyggda `imagegen`-verktyget. Den genererade helbilden ändrade vissa tryckta datum och användes därför inte som färdig kortbild. Endast avgränsade rensningsområden i `data/cards/promos.json` kopierades tillbaka till originalskanningarna. Övriga originalpixlar bevaras före storleksanpassningen, vilket `prepare-promo-scans.mjs` verifierar pixel för pixel. Regelrutor, erastreck, färgramar och tryckta uppgifter utanför dessa områden kommer från originalet. Original och slutresultat granskades visuellt tillsammans. Små källbilder ger begränsad detaljrikedom även efter storleksanpassning.

Slutbilderna ligger i `public/card-assets/` med versionsunika filnamn. `data/cards/asset-manifest.json` anger varje källfil, dess SHA-256, beskärning, rensningsområden och slutbildens checksumma. De tre originalbilagorna och rensningsunderlaget sparas lokalt i det ignorerade `Reference/promo-scans/`.

Återskapa från de lokala underlagen:

```text
node scripts/prepare-promo-scans.mjs --cleaned-sheet=Reference/promo-scans/cleaned-sheet-draft.png --sharp=<sharp-modulens sökväg>
node scripts/import-promo-cards.mjs --sharp=<sharp-modulens sökväg>
node scripts/update-card-faq-coverage.mjs
node scripts/apply-faq-translations.mjs
```

## Prompt till det inbyggda imagegen-verktyget

```text
Precise conservation edit of the attached Nations promo-card contact sheet. This is an EDIT TARGET, not a style reference. Remove only the semi-transparent white overprinted watermark text crossing the cards. Keep the exact original composition: 3 cards across in the upper row (Imperium Rex, Potemkin Village, Power Grid), 3 across in the middle row (Julius Agricola, Engineering Genius, Solar Eclipse / Spring and Autumn Period as ONE event card), and 2 cards centered in the bottom row (Nikola Tesla, Hagia Sophia). Preserve the original sheet aspect ratio 450:682 and the relative card bounding rectangles. No new margins or layout changes. Preserve all original printed game text, numbers, pictograms, card borders, colors, era stripe counts and illustration geometry EXACTLY. Do not rewrite, translate, redesign, correct, simplify or invent any printed rules. Reconstruct only the tiny parts obscured by the watermark; keep everything else faithful to the input, including the low-resolution scan appearance. White background remains white. No extra cards, titles, labels or watermark. The result is a faithful cleaned scan of the SAME complete sheet; it must not look like a new illustration.
```
