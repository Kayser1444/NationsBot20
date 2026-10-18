# Official FAQ audit: general rules, nations and advisors (indices 0–64)

Source: Nations FAQ++ v1.11 (2017-12-05), supplied PDF `Reference/faq++1.11.pdf`; English `sourceText` in `data/faq/entries.json`. FAQ page numbers below refer to the PDF. Immutable implementation commit: `9c344205b1802c9583d20c749b89a4cfa52516f7`. This is source/component auditing, not verification of the deployed website.

Counts: not-applicable: 7, supported: 56, partial: 1, conflict: 1.

Confirmed conflict: Galileo free purchase skips Axumite’s separate surcharge. Source gap: discard-pile reshuffle fallback is absent, without a demonstrated legal exhaustion replay. Unsupported scope: Nikola Tesla promo and solo-only Venice clarification; solo clauses in otherwise multiplayer entries are excluded. Ordinary card replacement intermediate most/least checks comply with the FAQ and are not defects.

Focused verification: `probe_official_faq_01.py` passed five most/least tie cases, the complete resource-loss example, Sun Tzu retaining its second action after removal, and Florence keeping substitution costs. Two observational probes verify no exhausted-deck refill and no Tesla registry entry.

## 0. Nations FAQ++ — not-applicable

FAQ p. 1; `nations-faq-nations-faq`.

Document introduction, symbols/version conventions and reading guidance impose no executable gameplay rule.

## 1. Campaign rules — not-applicable

FAQ p. 1; `general-campaign-rules`.

Multi-game campaign progression is an optional outside-match variant. No campaign orchestration claimed by this engine; not a gameplay defect.

## 2. First game — not-applicable

FAQ p. 1; `general-first-game`.

Beginner strategy recommendations, including suggested first-round production, are advice rather than constraints to enforce.

## 3. Components — not-applicable

FAQ p. 1; `general-components`.

Physical board flattening advice does not apply to a digital engine.

## 4. Production — supported

FAQ p. 1; `general-production`.

Production applies positive resources before forced negative loss; military/building deploy and undeploy immediately adjust square effects while produce filters to round resources. Purchases/deployment require available payment rather than voluntarily invoking deficit VP rules. Jaguar stability is a deploy effect, not production change.

Evidence: [player.py:1039-1059](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1039-L1059); [progress_cards.py:11-71](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L11-L71); [player.py:260-307](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L260-L307).

## 5. Architects — supported

FAQ p. 1; `general-architects`.

Public architects are overwritten each round and cleared at maintenance; private availability resets to the printed amount, never accumulates. Architects left on a partially built wonder are completed construction stages, not unused round supply.

Evidence: [match.py:516-524](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L516-L524); [cards.py:120-136](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/cards.py#L120-L136); [player.py:205-215](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L205-L215).

## 6. Cards — partial

FAQ p. 1; `general-cards`.

Ownership conditions scope normal effects; explicitly global event conditions include the owner where required. Replacing a normal card removes it permanently; removing its successor leaves an empty slot, not the original printed card. Special actions consume an action and become available after purchase, including that round. Physical card symbols/face-down markers are representation details. HOWEVER draw_cards slices the remaining deck and never replenishes from discarded cards; empty-pile component probe returns no cards. This is a source-level gap for the explicit reshuffle fallback, not a demonstrated legal exhaustion replay. Every individual card interaction still requires its own review.

Evidence: [cards.py:45-62](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/cards.py#L45-L62); [player.py:360-415](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L360-L415); [player.py:868-899](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L868-L899); [player.py:743-787](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L743-L787); [match.py:398-413](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L398-L413).

## 7. Most and least — supported

FAQ p. 1; `general-most-and-least`.

Most production bonuses use current most flags and tied strongest are excluded below five players. Deploy/undeploy/removal update most/least immediately, including an ordinary intermediate undeployment. Replacing cards removes/checks before adding the replacement, consistent with the FAQ; do not label that a defect. Explicit worker-return exception is separately atomic.

Evidence: [match.py:314-360](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314-L360); [player.py:585-609](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L585-L609); [player.py:868-899](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L868-L899); [progress_cards.py:2089-2101](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2089-L2101).

## 8. Resource loss — supported

FAQ p. 1, 2; `general-resource-loss`.

Deficit flags limit actual point losses to once per resource per round, then reset. Food shortfall substitutes books, book shortfall substitutes remaining resources with a split choice; spending everything causes no additional unpayable penalty and points floor at zero. Component reproduction of all steps in the FAQ worked example: three VP lost total, zero food/books and three stone remain.

Evidence: [player.py:205-206](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L205-L206); [player.py:930-1023](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L930-L1023).

## 9. Workers — supported

FAQ p. 2; `general-workers`.

Growth takes an undeployed worker; deployment is in action phase. Special effects explicitly call take_worker/return_worker. Return offers eligible population pools rather than a fixed order. If no undeployed worker is available it undeploys with the comparison suppressed until the worker is back on its chosen track. Extra workers are a separate expansion pool. No voluntary general return action is exposed.

Evidence: [player.py:217-257](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L217-L257); [player.py:797-864](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L797-L864); [match.py:539-568](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L539-L568).

## 10. 5 players — supported

FAQ p. 2; `general-5-players`.

Five-player threshold selects at most two most and at least two least. Exact-two top ties count; top singleton with tied second excludes the tied-second players; three-way top tie gives no most; tied-second least expands least. Component probes cover all these cases including everyone tied.

Evidence: [match.py:314-331](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314-L331).

## 11. Nations — not-applicable

FAQ p. 2; `nations-nations`.

Section introduction merely points out repetition of Dynasties rules.

## 12. China B-side — supported

FAQ p. 2; `nations-china-b-side`.

Bonus is one food in production when passed_first is true. That flag includes the first two passers at five players. No duplicate immediate food payout.

Evidence: [nations.py:244-255](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L244-L255); [player.py:724-733](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L724-L733).

## 13. Ethiopia — supported

FAQ p. 2; `nations-ethiopia`.

Ethiopia adds stability through the player-order-only hook, preserving underlying military. Sorting still breaks military-total ties by stability and original order.

Evidence: [nations.py:340-351](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L340-L351); [match.py:576-589](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L576-L589).

## 14. Greece B-side — supported

FAQ p. 2; `nations-greece-b-side`.

Greece supplies one additive golden-age bonus; that increases books/stone alternatives and reduces the separate VP resource cost. Cross-reference entry contains no additional independent condition.

Evidence: [nations.py:391-395](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L391-L395); [player.py:202-203](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L202-L203); [player.py:443-510](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L443-L510).

## 15. Japan — supported

FAQ p. 2; `nations-japan`.

Japan buys/discards advisor before placement, so cannot install it on Porcelain Tower. Emperor markers persist because new_round is overridden and effect-removal selections exclude age-zero advisors. First dynasty occupies one building/military slot; subsequent dynasty finds/reuses that dynasty slot. Hokkaido has zero worker positions and max_workers set, making it unavailable until replaced.

Evidence: [nations.py:469-555](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L469-L555); [player.py:126-130](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L126-L130); [player.py:555-560](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L555-L560); [player.py:300-302](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L300-L302).

## 16. Korea — supported

FAQ p. 2; `nations-korea`.

Korea invokes hire_free_architect without decrementing public/private architects or charging stone. Optional korea_nerf changes number hired, not this entry’s supply/payment clarification.

Evidence: [nations.py:580-604](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L580-L604); [player.py:629-640](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L629-L640).

## 17. Mongolia — supported

FAQ p. 2; `nations-mongolia`.

Global Mongolia hook increases the war-card resource penalty by two for every defeated nation, including itself; stability mitigates combined loss. Four starting workers and eight population workers give twelve maximum. Negative military adds book loss and an independent VP revolt penalty. Buying war clamps negative military to zero. Steppe has no legal worker slots until replaced.

Evidence: [nations.py:696-731](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L696-L731); [match.py:593-603](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L593-L603); [player.py:1025-1059](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1025-L1059); [player.py:423-429](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L423-L429); [player.py:1061-1118](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1061-L1118).

## 18. Persia B-side — supported

FAQ p. 2; `nations-persia-b-side`.

First dynasty uses a colony slot; next dynasty locates and replaces the previous dynasty in that same slot.

Evidence: [nations.py:769-789](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L769-L789).

## 19. Poland — supported

FAQ p. 2; `nations-poland`.

Poland listens for not defeated. This event fires only while an actual war is resolved and the player meets its military threshold, so a no-war round grants no books.

Evidence: [nations.py:812-823](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L812-L823); [match.py:593-609](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L593-L609); [player.py:1061-1117](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1061-L1117).

## 20. Rome B-side — supported

FAQ p. 2; `nations-rome-b-side`.

Rome special contributes its permanent two military at setup, independently of workers. Special slot is not deployable.

Evidence: [nations.py:916-919](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L916-L919); [player.py:174-189](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L174-L189).

## 21. Venice — not-applicable

FAQ p. 2; `nations-venice`.

This entry only clarifies solo play. Solo shadow mode is outside the audited multiplayer implementation; do not count it as a multiplayer conflict.

## 22. Vikings — supported

FAQ p. 2; `nations-vikings`.

Vikings reduction runs after all players produce; it only calls resource loss on others, never adds resources to Vikings. Solo clause outside scope. Old Uppsala is an ordinary replaceable starting wonder with negative final points, so replacement removes that penalty.

Evidence: [nations.py:1025-1072](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L1025-L1072); [match.py:568-574](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L568-L574); [player.py:611-628](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L611-L628).

## 23. Advisor — supported

FAQ p. 2; `advisor-advisor`.

Advisor immediate square resources are added on placement and removed on removal. Production loops over completed owned cards regardless of whether a conditional secondary effect succeeds.

Evidence: [player.py:412-415](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L412-L415); [player.py:1025-1037](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1025-L1037); [cards.py:138-142](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/cards.py#L138-L142).

## 24. Augustus — supported

FAQ p. 2; `advisor-augustus`.

Augustus checks most_military during production, not acquisition; no shared-most bonus in ordinary player counts. Permanent military remains separate from its conditional stone bonus.

Evidence: [progress_cards.py:2089-2101](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2089-L2101); [match.py:314-355](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314-L355).

## 25. Hatshepsut — supported

FAQ p. 2; `advisor-hatshepsut`.

Hatshepsut registers only while owned and rewards wonder-ready events, so no retroactive completed-wonder bonus. hire_free_architect emits wonder ready BEFORE card.ready (Titanic removal), preserving the three-book bonus even when Titanic removes her.

Evidence: [progress_cards.py:2168-2179](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2168-L2179); [player.py:629-640](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L629-L640).

## 26. Qin Shi Huang — supported

FAQ p. 2; `advisor-qin-shi-huang`.

Qin registers its least-stability removal when placed. Most/least updates immediately invoke the removal hook. Incoming Qin is not exposed until placed; an existing Qin can be lost during a normal intermediate stability dip, as the FAQ requires.

Evidence: [progress_cards.py:2211-2222](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2211-L2222); [match.py:346-360](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L346-L360).

## 27. Saint Augustine — supported

FAQ p. 2; `advisor-saint-augustine`.

Saint Augustine uses current most-stability at production; square stability is a separate permanent contribution. Ties follow player-count rules.

Evidence: [progress_cards.py:2224-2236](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2224-L2236); [match.py:314-355](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314-L355).

## 28. Archimedes — supported

FAQ p. 2; `advisor-archimedes`.

Archimedes supplies one private architect; assign_owner initializes availability immediately and new_round replenishes it. Normal architect action/stone payment uses private supply, not public supply.

Evidence: [progress_cards.py:2082-2087](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2082-L2087); [cards.py:128-135](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/cards.py#L128-L135); [player.py:642-660](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L642-L660).

## 29. Boudica — supported

FAQ p. 2; `advisor-boudica`.

Boudica checks deployed workers on military cards, not military total. Her own military and other non-worker strength are allowed; deployment invokes the immediate removal test.

Evidence: [progress_cards.py:2103-2117](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2103-L2117); [match.py:346-348](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L346-L348).

## 30. Cyrus the Great — supported

FAQ p. 2, 3; `advisor-cyrus-the-great`.

Cyrus reads a boolean colony-purchased-this-round at production, granting three gold once regardless of number; buying the colony before Cyrus works. Removal before production excludes him from completed cards.

Evidence: [progress_cards.py:2134-2145](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2134-L2145); [player.py:205-215](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L205-L215); [player.py:366-367](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L366-L367); [player.py:1025-1028](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1025-L1028).

## 31. Buddha — supported

FAQ p. 3; `advisor-buddha`.

Buddha skip is checked at start of the first turn, before any purchase. Buying him as first action cannot retrospectively skip it. Solo die-roll clause outside scope.

Evidence: [progress_cards.py:2119-2132](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2119-L2132); [player.py:778-787](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L778-L787).

## 32. Hannibal — supported

FAQ p. 3; `advisor-hannibal`.

Hannibal adds one raid value to the buyer’s battle reward and one gold cost to other nations’ battles. Own battles are excluded from the surcharge condition.

Evidence: [progress_cards.py:2147-2166](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2147-L2166); [player.py:191-200](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L191-L200); [player.py:431-440](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L431-L440); [player.py:530-542](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L530-L542).

## 33. Sun Tzu — supported

FAQ p. 3; `advisor-sun-tzu`.

Sun Tzu bonus is determined once at first-turn start before executing either action. Buying him during that first action gives no extra action. Removing/replacing him with first action does not retract the already granted second action; component probe passed. Solo shadow roll outside scope.

Evidence: [progress_cards.py:2238-2250](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2238-L2250); [player.py:778-787](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L778-L787).

## 34. Anna Komnene — supported

FAQ p. 3; `advisor-anna-komnene`.

Anna disables negative military per-worker production and immediate upkeep; acquisition restores already-lost stability and removal reinstates upkeep. Positive per-worker values are retained.

Evidence: [progress_cards.py:2302-2319](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2302-L2319); [progress_cards.py:46-71](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L46-L71).

## 35. Harald Hardrada — supported

FAQ p. 3; `advisor-harald-hardrada`.

Harald registers/removes immediately on least military; production value is independent until removal.

Evidence: [progress_cards.py:2355-2366](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2355-L2366); [match.py:346-360](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L346-L360).

## 36. Sejong the Great — supported

FAQ p. 3; `advisor-sejong-the-great`.

Sejong grants two stone from buying-card golden-age hook, independent of which golden-age benefit is selected. It does not alter the golden-age bonus calculation.

Evidence: [progress_cards.py:2404-2418](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2404-L2418); [player.py:553-581](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L553-L581).

## 37. Thomas Aquino — supported

FAQ p. 3; `advisor-thomas-aquino`.

Thomas Aquino checks current most stability during production, giving four extra books only when qualifying; permanent stability is separate.

Evidence: [progress_cards.py:2420-2432](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2420-L2432); [match.py:314-355](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314-L355).

## 38. Abu Bakr — supported

FAQ p. 3; `advisor-abu-bakr`.

Abu Bakr grants two books on buying a battle before battle reward choice, so all selected resource types receive the extra books.

Evidence: [progress_cards.py:2255-2269](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2255-L2269); [player.py:553-579](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L553-L579).

## 39. Eleanor of Aquitaine — supported

FAQ p. 3; `advisor-eleanor-of-aquitaine`.

Eleanor uses the same round-wide boolean as Cyrus: one bonus if any colony bought, not multiplied by colony purchases.

Evidence: [progress_cards.py:2321-2332](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2321-L2332); [player.py:205-215](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L205-L215); [player.py:366-367](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L366-L367).

## 40. Mansa Musa — supported

FAQ p. 3; `advisor-mansa-musa`.

Mansa Musa listens from placement. Purchase pays and emits spent-last-gold BEFORE new advisor buy/placement/removal, so buying Mansa gives no bonus and buying his replacement does. Each qualifying spend is a fresh event without per-round marker cap; forced losses do not emit it. Golden-age VP gold payments also explicitly emit it. Buying from Poland/Chopin follows the same pre-placement trigger. Known Galileo tax omission can suppress an otherwise required gold spend, but Mansa hook itself is correct.

Evidence: [progress_cards.py:2368-2380](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2368-L2380); [player.py:513-569](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L513-L569); [player.py:443-477](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L443-L477).

## 41. Alhazen — supported

FAQ p. 3; `advisor-alhazen`.

Alhazen requires at least two live board cards and an unused marker, selects two distinct occupied positions, swaps them and consumes the special action. No purchase is bundled; later ordinary turns buy normally.

Evidence: [progress_cards.py:2271-2300](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2271-L2300); [player.py:743-787](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L743-L787).

## 42. Genghis Khan — supported

FAQ p. 3; `advisor-genghis-khan`.

Genghis subtracts three stability from all players including owner and restores it when removed. Scope is not limited to opponents or production.

Evidence: [progress_cards.py:2334-2353](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2334-L2353).

## 43. Marco Polo — supported

FAQ p. 3; `advisor-marco-polo`.

Marco payment checks/takes exactly two food OR two stone, then adds four gold. No payment to another nation, no mixed one-food/one-stone option.

Evidence: [progress_cards.py:2382-2402](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2382-L2402).

## 44. Zhu Xi — supported

FAQ p. 3; `advisor-zhu-xi`.

Zhu Xi cover condition requires replacement of Zhu Xi itself by an advisor and no existing cover. First replacement stacks; second removes both. remove-with hook removes Zhu when covering advisor is removed. Other slots do not meet old_card-is-self. Direct event removal of Zhu goes through ordinary removal, clearing any attached stack.

Evidence: [progress_cards.py:2434-2456](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2434-L2456); [player.py:398-421](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L398-L421); [player.py:868-899](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L868-L899).

## 45. Elizabeth — supported

FAQ p. 3; `advisor-elizabeth`.

Elizabeth adds eight only in the war-defeat threshold; no change to underlying military, most/military or player order.

Evidence: [progress_cards.py:2474-2485](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2474-L2485); [player.py:1061-1062](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1061-L1062); [match.py:576-589](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L576-L589).

## 46. Galileo Galilei — conflict

FAQ p. 3; `advisor-galileo-galilei`.

Golden-age VP payment remains normal and the purchase filter includes golden ages, ordinary wonders and natural wonders. BUT free=True bypasses extra-payment affordability/payment, including Axumite Kingdom’s separate three-gold surcharge. The official wording limits the waiver to normal purchase gold, so this supports the previously reproduced Galileo/Axumite conflict; tax owner receives nothing and a consequent Mansa last-gold trigger is skipped.

Evidence: [progress_cards.py:2487-2504](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2487-L2504); [player.py:260-267](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L260-L267); [player.py:530-542](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L530-L542); [player.py:443-510](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L443-L510); [dynasty_cards.py:200-241](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L200-L241).

## 47. Isabella — supported

FAQ p. 3; `advisor-isabella`.

Isabella counts every owned colony whose age equals three and adds three gold per colony; ages one/two/four excluded.

Evidence: [progress_cards.py:2506-2519](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2506-L2519).

## 48. Montezuma — supported

FAQ p. 3; `advisor-montezuma`.

Montezuma rewards immediate buying-card war/battle event. prev_card identity guards against the same hybrid Kingdom of Leon purchase firing twice, so one three-book reward.

Evidence: [progress_cards.py:2535-2553](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2535-L2553); [player.py:553-579](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L553-L579).

## 49. Martin Luther — supported

FAQ p. 3; `advisor-martin-luther`.

Martin adds four food to shared war resource-loss vector for all nations including owner. War resolution iterates reverse player order, allowing each defeated player to distribute stability mitigation over food and normal penalty types.

Evidence: [progress_cards.py:2521-2533](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2521-L2533); [match.py:593-603](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L593-L603); [player.py:1072-1109](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1072-L1109).

## 50. Pocahontas — supported

FAQ p. 3; `advisor-pocahontas`.

Pocahontas uses unconditional global true condition for extra-colony-military requirement, so affects owner as well.

Evidence: [progress_cards.py:2589-2602](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2589-L2602); [player.py:270-274](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L270-L274).

## 51. Tokugawa — supported

FAQ p. 3; `advisor-tokugawa`.

Tokugawa calculates current age as (round+1)//2, counting building/military cards, not workers; rounds five/six use age three, seven/eight age four.

Evidence: [progress_cards.py:2617-2631](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2617-L2631).

## 52. Niccolo Machiavelli — supported

FAQ p. 3; `advisor-niccolo-machiavelli`.

Machiavelli chooses between the two top events. Both names are placed in shared next-move options during choice; log names the selected AND discarded event afterwards. Both cards removed from event deck. Solo event-tile clause outside scope; website observer rendering is outside this source snapshot.

Evidence: [progress_cards.py:2555-2570](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2555-L2570); [match.py:505-514](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L505-L514); [match.py:736-742](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L736-L742); [match.py:782-811](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L782-L811).

## 53. Peter the Great — supported

FAQ p. 3; `advisor-peter-the-great`.

Peter requires an existing war and strictly greater military, then offers exactly one of five stone/gold/books. Equal military gives no reward.

Evidence: [progress_cards.py:2572-2587](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2572-L2587).

## 54. Suleiman I — supported

FAQ p. 3; `advisor-suleiman-i`.

Suleiman action requires most_military and an available worker; no once-per-round marker. It takes one worker each legal activation.

Evidence: [progress_cards.py:2604-2615](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2604-L2615); [player.py:797-830](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L797-L830).

## 55. Florence Nightingale — supported

FAQ p. 3; `advisor-florence-nightingale`.

Florence suppresses resource-deficit VP penalties only; book and other-resource substitution remains (component probe passed). War defeat VP and negative stability/military revolt use independent direct point-loss paths, so unaffected.

Evidence: [progress_cards.py:2699-2710](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2699-L2710); [player.py:937-1023](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L937-L1023); [player.py:1039-1069](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1039-L1069).

## 56. Frederick the Great — supported

FAQ p. 3; `advisor-frederick-the-great`.

Frederick discount computes cost-max(1,cost-2), enforcing minimum one stone for military deployment.

Evidence: [progress_cards.py:2743-2760](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2743-L2760); [player.py:300-307](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L300-L307).

## 57. Abraham Lincoln — supported

FAQ p. 3; `advisor-abraham-lincoln`.

Normal rules: Lincoln may take one worker per action repeatedly while workers remain. OPTIONAL lincoln_nerf rule replaces this with a two-worker self-removing activation, a configured balance variant rather than undisclosed ordinary-rules discrepancy. Default flag is false unless rules/replay explicitly selects it.

Evidence: [progress_cards.py:2636-2658](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2636-L2658); [match.py:147-170](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L147-L170).

## 58. Benjamin Disraeli — supported

FAQ p. 3; `advisor-benjamin-disraeli`.

Disraeli produces one eight-food bonus when the round-wide colony purchase boolean is true; no multiplicity bonus.

Evidence: [progress_cards.py:2685-2697](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2685-L2697); [player.py:205-215](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L205-L215); [player.py:366-367](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L366-L367).

## 59. Marie Curie — supported

FAQ p. 3; `advisor-marie-curie`.

Marie Curie grants two private architects. Availability initialized at acquisition, reset each round, used through ordinary architect hire action and normal stone cost.

Evidence: [progress_cards.py:2781-2786](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2781-L2786); [cards.py:128-135](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/cards.py#L128-L135); [player.py:642-660](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L642-L660).

## 60. Alfred Nobel — supported

FAQ p. 3; `advisor-alfred-nobel`.

Nobel’s war-buy prohibition is separately registered with no worker precondition; production stone sums only workers on age-four buildings. Bonus is not paid immediately on acquisition/deployment.

Evidence: [progress_cards.py:2660-2683](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2660-L2683); [player.py:268-270](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L268-L270).

## 61. Shaka Zulu — supported

FAQ p. 3; `advisor-shaka-zulu`.

Shaka qualifies player-is-not-owner colony purchases and adds five stone to the purchasing other nation, never the owner.

Evidence: [progress_cards.py:2788-2803](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2788-L2803).

## 62. Simon Bolivar — supported

FAQ p. 3; `advisor-simon-bolivar`.

Bolivar bonus occurs only in its dedicated activation, not on generic colony replacement/removal. Selection includes owned preprinted colonies because colony_cards has no age restriction; special non-colony dynasty slots are excluded by type. Removed slot is empty and can accept later colonies normally.

Evidence: [progress_cards.py:2805-2822](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2805-L2822); [player.py:112-117](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L112-L117); [player.py:360-415](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L360-L415); [player.py:868-899](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L868-L899).

## 63. Nikola Tesla — not-applicable

FAQ p. 4; `advisor-nikola-tesla`.

UNSUPPORTED CARD coverage gap: no Nikola Tesla class/name exists in snapshot and registry has no Tesla. Hence neither unlimited activations nor solo die are exercised. Do not count an absent promo as a confirmed implementation bug in a supported card. Component registry probe confirms absence.

Evidence: [progress_cards.py:3387-3403](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3387-L3403).

## 64. Frédéric Chopin — supported

FAQ p. 4; `advisor-frederic-chopin`.

Chopin doubles computed book production via additional-production hook, not stored books. Other nation can use ordinary buy action for five gold when owner has not passed; payment is subtracted without credit to former owner (supply). Hook excludes already-passed owner and insufficient gold.

Evidence: [progress_cards.py:2712-2741](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2712-L2741); [player.py:543-569](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L543-L569).
