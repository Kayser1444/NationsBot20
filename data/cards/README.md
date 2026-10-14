# Kortinventering

Status 2026-10-14: 520 poster, inklusive 74 varianter på startbrädena och 17 nationer. Alla 479 kortnamnsrubriker i den importerade FAQ++ 1.11 är kopplade till inventeringen. Händelsekort har två namn på samma bild och kan sökas på båda. `Tom's Cabin` är ett alias till `Uncle Tom's Cabin` (`UTC`). Nationerna kan sökas på svenska eller engelska, exempelvis `Kina` eller `China`.

422 separata JPEG-kortbilder har verifierats på Tabonys publika assetserver. Nationsposterna länkar till ytterligare 17 verifierade spelarbräden, B-sidorna för Dynasties. De 74 startkortsbilderna är extraherade från dessa bräden med spelets egna positionskoordinater, utan omritning, och har granskats i bildöversikter. De lagras i `public/card-assets` och levereras från Railway. Manifestet bevarar källadress, källbildens checksumma, beskärningsrektangel och resultatets checksumma. Totalt har 513 poster en bild. Sju FAQ-kort saknar fortfarande verifierad bild: Nikola Tesla, Hagia Sophia, Kremlin, Mechanical Turk, Antikythera Mechanism, Grand Duchy of Finland och Hussar. Dessa poster kan väljas med `/card`, men svaret anger att bilden saknas.

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
| Nationer med spelarbräde | 17 |

`catalog.json` innehåller sökbara namn, alias, typ, era, eventuell startnation och bildkontroll. Namn som Three Kingdoms kan avse olika kort; använd namnförslagens typ/era för att välja. Startvarianter visar nationen. Ett entydigt progresskort prioriteras när det har samma namn som en startvariant.

`supplemental.json` dokumenterar extra kort och stavningsvarianter från FAQ:n. `faq-coverage.json` kopplar varje kortnamnsrubrik till en eller flera poster. `data/faq/index.json` bevarar originalrubriker, inklusive PDF-textlagrets stavfel. Det är metadata, inte ett godkännande av FAQ-innehåll. Nya egna poster och omnämnanden registreras med `pending`; godkända beslut bevaras.

Nationsposterna visar spelarbrädet från Tabony, nationens egna FAQ-poster, dynastiposter och namngivna korshänvisningar. Startkortens filnamn skiljer nationsvarianterna åt. Spelimplementationens klasslista anger vilket startkort som ligger på vilken plats; ingen kortbild återanvänds enbart för att kortnamnet är detsamma.

## Uppdatera

```text
python scripts/import-card-catalog.py --game-source <sökväg-till-nations-pythonkällan>
node scripts/extract-starting-cards.mjs --game-source=<sökväg-till-TabonyGames> --sharp=<sökväg-till-sharp>
node scripts/update-card-faq-coverage.mjs
node scripts/verify-card-images.mjs
node scripts/review-faq-pilot.mjs
node scripts/apply-faq-translations.mjs
```

Importen läser Python med AST utan att köra spelkod och bevarar befintliga granskningsbeslut. Bildkontrollen gör högst fyra samtidiga HEAD-anrop, kontrollerar bara nya/ändrade adresser och avbryter vid nätverksfel eller andra oväntade svar. Använd `--all` för en ny kontroll av alla adresser. Bildkontroller körs manuellt, aldrig vid Discord-kommandon. FAQ-PDF:en behöver inte importeras om för att uppdatera kortkatalogen.

## Bildtjänst på Railway

Sätt `NATIONS_CARD_ASSETS_ENABLED=1` och `NATIONS_CARD_ASSET_ORIGIN=https://<publik-staging-domän>`. Rikta den publika domänen till port **8081**, eller en uttryckligen vald `NATIONS_CARD_ASSET_PORT`. Denna port har en separat HTTP-server som endast levererar manifestets PNG-filer under `/card-assets/`. Adminpanelen, API:er, prenumerationer och andra filer finns inte på denna server. Adminpanelens befintliga inställningar och port är separata.

Bildfiler och manifest byggs in i Dockerbilden och använder ingen plats på prenumerationsvolymen. Filnamnets checksumma gör URL:en versionsunik; bilderna kan därför cachas permanent. `GET`, `HEAD` och ETag stöds. `sharp` behövs bara vid extrahering, inte i driften. De fullständiga källbrädena sparas i det ignorerade `Reference/tabony-boards`.

Tillgängliga kortbilder är oberoende av FAQ-granskningen. FAQ-vyn visar både godkända och `pending` källposter, punkter och kortkopplingar utan granskningsdisclaimer, enligt användarens önskemål. Avvisat innehåll visas inte och visningen ändrar inga granskningsbeslut. Alla 216 FAQ-poster har svenska svarspunkter; engelska originaltexter bevaras. Svaret följer användarens språk utan att blanda svenska och engelska regeltexter. Kortnamn behålls på engelska. Varje punkt anger källsida och varje FAQ-sida länkar till den engelska FAQ++-källan. Relevanta korttypsregler och uttryckliga regelhänvisningar tas med utan dubbletter. Tomma kortrubriker skapar inga regelpunkter.
