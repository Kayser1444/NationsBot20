# Kortinventering

Status 2026-10-14: 503 poster, inklusive 74 varianter på startbrädena. Alla 479 kortnamnsrubriker i den importerade FAQ++ 1.11 är kopplade till inventeringen. Händelsekort har två namn på samma bild och kan sökas på båda. `Tom's Cabin` är ett alias till `Uncle Tom's Cabin` (`UTC`).

422 separata JPEG-bilder har verifierats med HTTP HEAD (200 och `image/jpeg`) på Tabonys publika assetserver. Detta verifierar tillgänglighet och filtyp, inte en visuell granskning av varje kort. De 74 startvarianterna saknar separata bilder på dessa adresser. Sju ytterligare FAQ-kort saknar ännu verifierad Tabony-bild: Nikola Tesla, Hagia Sophia, Kremlin, Mechanical Turk, Antikythera Mechanism, Grand Duchy of Finland och Hussar. Dessa poster kan väljas med `/card`, men svaret anger att separat bild saknas. Inga kända 404-adresser skickas som bilder till Discord.

| Typ | Poster |
| --- | ---: |
| Underverk | 50 |
| Rådgivare/ledare | 46 |
| Byggnader | 119 |
| Militär | 51 |
| Guldåldrar | 36 |
| Kolonier | 34 |
| Krig | 32 |
| Slag | 32 |
| Naturliga underverk | 19 |
| Dynastier | 34 |
| Händelsekort (två händelser per kort) | 48 |
| Tilläggskort (Siberia 2) | 1 |
| Turmoil | 1 |

`catalog.json` innehåller sökbara namn, alias, typ, era, eventuell startnation och bildkontroll. Namn som Three Kingdoms kan avse olika kort; använd namnförslagens typ/era för att välja. Startvarianter visar nationen. Ett entydigt progresskort prioriteras när det har samma namn som en startvariant.

`supplemental.json` dokumenterar extra kort och stavningsvarianter från FAQ:n. `faq-coverage.json` kopplar varje kortnamnsrubrik till en eller flera poster. `data/faq/index.json` bevarar originalrubriker, inklusive PDF-textlagrets stavfel. Det är metadata, inte ett godkännande av FAQ-innehåll. Nya egna poster och omnämnanden registreras med `pending`; godkända beslut bevaras.

## Uppdatera

```text
python scripts/import-card-catalog.py --game-source <sökväg-till-nations-pythonkällan>
node scripts/update-card-faq-coverage.mjs
node scripts/verify-card-images.mjs
node scripts/review-faq-pilot.mjs
```

Importen läser Python med AST utan att köra spelkod och bevarar befintliga granskningsbeslut. Bildkontrollen gör högst fyra samtidiga HEAD-anrop, kontrollerar bara nya/ändrade adresser och avbryter vid nätverksfel eller andra oväntade svar. Använd `--all` för en ny kontroll av alla adresser. Bildkontroller körs manuellt, aldrig vid Discord-kommandon. FAQ-PDF:en behöver inte importeras om för att uppdatera kortkatalogen.

Tillgängliga kortbilder är oberoende av FAQ-granskningen. FAQ-vyn visar både godkända och `pending` källposter, punkter och kortkopplingar med den korta disclaimern **”FAQ-text och kortkopplingar är inte fullständigt granskade.”** Avvisat innehåll visas inte. Granskningsstatus ändras inte av visningen. Porcelain Tower har fortfarande 13 källkontrollerade punkter. Övriga kort visar importerade punkter, relevanta korttypsregler och uttryckliga regelhänvisningar, utan dubbletter. Engelskt original används där svensk sammanfattning saknas; detta anges i FAQ-vyn. Tomma kortrubriker skapar inga regelpunkter.
