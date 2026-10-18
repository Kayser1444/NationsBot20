# Tabony implementation audit against the official FAQ

Audited 17 October 2026. All **216 English text entries** in Nations FAQ++ version **1.11**, dated **5 December 2017**, have an individual verdict and source trace. The remaining confirmed discrepancy is **Galileo bypassing Axumite's surcharge**. The Sinking of the Vasa issue was closed after the user reported a designer clarification accepting the implementation on 17 October 2026. Several additional entries require clarification or describe documented implementation differences.

## Source and scope

The [official FAQ file page](https://boardgamegeek.com/filepage/96855/faq-plus-plus-official), posted by RustanR, was checked in the browser on the audit date and lists version 1.11 as its latest file. The original supplied PDF, `Reference/faq++1.11.pdf`, has SHA-256 `d9639ea5b25291309210907e7fc5a358156777e45b8f842f661a6b0ab56c97f6`. Original page images were checked for the principal candidate findings; preserved English `sourceText` supplies the audit baseline. Translations and editorial card-search text were not used as rules evidence. Existing FAQ translation/review approvals were not changed.

The implementation is [Logitude/nations at commit 9c344205b1802c9583d20c749b89a4cfa52516f7](https://github.com/Logitude/nations/commit/9c344205b1802c9583d20c749b89a4cfa52516f7). A fresh browser read of the GitHub HEAD API confirmed this remains current upstream on the audit date. All 20 local snapshot files passed their SHA-256 checks. The preceding investigation also matched those files against GitHub's Git blob hashes. **The revision deployed on games.tabony.net was not verified.** Findings describe this source revision.

This covers the complete imported set of substantive FAQ text entries. The larger FAQ index also lists card names without accompanying explanations; such headings do not add behavioral rulings. Solo-game rules, campaign/physical-component advice and promos absent from the playable source roster are explicitly recorded as outside scope rather than counted as runtime failures. Mixed multiplayer/solo entries are judged on their applicable multiplayer clauses, with the solo exclusion noted. Optional configured house rules, such as the Lincoln nerf, are distinguished from ordinary behavior.

## Coverage

| Verdict | Entries | Meaning |
|---|---:|---|
| Supported in applicable scope | 177 | Relevant code implements the applicable ruling; this is not exhaustive state-space testing. |
| Confirmed conflict | 1 | Galileo bypasses the Axumite surcharge. |
| Documented exception | 3 | Shwedagon Pagoda, Versailles and Roman Republic end round-long benefits on replacement. |
| Partial / qualified | 4 | Cards/deck reshuffle; Solomon's Temple timing; Victoria Falls discard timing; Axumite affected by the same Galileo defect. |
| Uncertain | 6 | Rules interpretation, ordering or source mismatch requiring clarification. |
| Not applicable / unsupported content | 25 | Advice, document notes, solo-only rulings and absent promos. |
| **Total** | **216** | Every imported entry appears exactly once. |

The Galileo defect is also recorded under the partially supported Axumite entry; these represent the same underlying issue. Counts are entry classifications, not a percentage of game correctness.

Detailed records:

- [Entries 0–64: general rules, nations and advisors](official-faq-audit-01-general-advisors.md).
- [Entries 65–143: other cards and early events](official-faq-audit-02-cards-events.md).
- [Entries 144–215: later events, dynasties and general questions](official-faq-audit-03-events-dynasties.md).
- [Unified machine-readable ledger](official-faq-audit.json), containing all 216 original IDs, PDF pages, source-text hashes, verdicts, notes and immutable code citations.

## Confirmed discrepancies

### 1. Galileo skips Axumite's separate 3-gold payment

**FAQ:** Galileo, page 3, waives only the normal purchase cost. Axumite, pages 8–9, separately requires other players to pay its owner 3 gold when buying the marked card.

**Code:** [`GalileoGalilei.activate`](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2487-L2504) calls `buy_action(..., free=True)`. [`Player.buy_action`](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L508-L556) skips both extra-payment hooks in its free branch; [`can_buy_card`](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L260-L267) also skips surcharge affordability.

**Reproduction:** with Mansa Musa and Galileo, buy a marked Himeji Castle while holding exactly 3 gold. Actual: buyer retains 3 gold, Axumite receives 0, Mansa grants nothing. Expected: buyer pays the 3 gold to Axumite, then Mansa grants 2 books and 1 food. A normal marked purchase with 4 gold pays the row-one price plus surcharge and correctly triggers Mansa. The normal-purchase control rules out a general failure of Mansa's payment trigger.

## Closed: Sinking of the Vasa

Accepted designer clarification, reported by the user on 2026-10-17: Logitude discussed this with Rustan Håkansson, whose interpretation agrees with the current implementation. The gold<3 branch may use the temporary military reduction even below zero. Closed as an issue; no gameplay change requested. This is a user-reported clarification, not an independently inspected quotation from Rustan.

The component observations remain valid: a player with 0 gold and 5 military is compared at -5 military during Peace of Westphalia, then restored to 5. The withdrawn claim was that this behavior is erroneous. It is no longer counted as a confirmed discrepancy.

## Qualifications and clarification requests

These are excluded from the confirmed-bug count:

- **Round-long benefits on replacement:** Shwedagon Pagoda, Versailles and Roman Republic explicitly lose their benefits early in the code. Logitude already acknowledges this family of differences in the [implementation differences post](https://games.tabony.net/forum/viewtopic.php?p=4#p4). The same post lists Old Uppsala and Sheba, whose official FAQ entries do not independently spell out the affected lifetime rule. This is a documented policy difference, not a newly discovered defect.
- **Exhausted decks:** the general Cards entry requires reshuffling discarded cards if an age's deck runs out. [`draw_cards`](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L398-L413) has no discard-pile refill. An empty-pile component check returns no cards. No complete legal match replay exhausting a deck was established, so this is an unimplemented fallback rather than a demonstrated ordinary-game failure.
- **Solomon's Temple and Victoria Falls:** the code uses a later resolution boundary for the Temple's age-end point and removes Victoria Falls' extra row at the next progress-board reconstruction. These differ from literal FAQ timing; no changed game outcome was demonstrated.
- **Statue of Liberty and Industrial Revolution at five players:** their individual FAQ text asks for strictly more workers than everyone else, whereas the general five-player rule allows two players to have most of anything. The code applies that general rule. Clarify which wording governs before reporting either as a defect.
- **Porcelain Tower and Polish-Lithuanian Commonwealth:** generic advisor-loss effects remove all advisors, while Qin's conditional self-removal removes only Qin. It is unclear whether the FAQ's broad lose-all wording is intended to cover conditional self-removal as well. Ordinary replacement and the express Old Kingdom/Mali remove-one exceptions must not be mistaken for compulsory lose-all effects.
- **Kingdom of Leon:** the named battle bonuses and Montezuma deduplication are implemented, but some battle hooks run before completion of the war purchase rather than afterward. No resulting outcome difference was demonstrated; the ordering clause remains qualified.
- **Peace of Westphalia:** its FAQ text refers to reordering, while the implemented card effect is least military loses food. This apparent source/card mismatch needs resolution before the entry can be certified or reported as a missing reorder.

The absent promos covered by substantive FAQ entries are Nikola Tesla, Grand Duchy of Finland, Antikythera Mechanism, Hagia Sophia, Kremlin and Mechanical Turk. Their absence is explicitly recorded as a content-coverage limitation.

## Corrected interpretation from the preceding audit

Ordinary card replacement subtracts the old card's stability/military, checks conditions, and then adds the new card's values. That is consistent with the FAQ and the subsequent replacing-cards clarification. An existing Qin or Great Library can therefore be removed during a colony/wonder upgrade's temporary stability dip; this observation is **not** included as a defect.

Returning a deployed worker is different: `return_worker` explicitly suppresses the undeployment check, restores the population-track effect, and checks only the completed return. A focused probe with both Qin and the Great Library verifies this. The previously discussed Vesuvius outer end-of-age check has no demonstrated gameplay consequence and is not counted as a confirmed discrepancy here.

## Verification and limits

The following scripts import unmodified, hash-verified source into temporary local packages and exercise real methods using component fixtures. They are not complete match replays and make no live game moves:

```powershell
python docs/research/probe_official_faq_01.py
python docs/research/probe_official_faq_03.py
python docs/research/probe_official_faq_crosschecks.py
node docs/research/build_official_faq_audit.mjs
```

All three probe scripts completed successfully. They verify five five-player tie configurations, the official resource-loss worked example, Sun Tzu retaining a second action after removal, Florence Nightingale's resource substitution, the accepted Vasa behavior and a threshold control, Emigration's free returned worker, advisor self-removal behavior, Galileo/Axumite with Mansa, a normal-purchase control, and atomic worker return. Registry and empty-deck observations are also recorded.

The assembly script verifies exact 216-entry coverage without duplicates, original PDF and all snapshot hashes, FAQ page mappings, pinned citation revisions and citation line bounds. Passing a diagnostic script means the stated observations reproduced, including known conflicts; it does not mean every FAQ rule passed.

No gameplay code, runtime FAQ data, translations or approval statuses were changed. No deployment or external issue report was made.
