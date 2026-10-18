# Official FAQ implementation audit: cards and events (indices 65–143)

Audit date: 2026-10-17. Source: pinned Logitude/nations commit 9c344205b1802c9583d20c749b89a4cfa52516f7. This is source behavior, not a claim about the website deployed revision.

Rules source: [official FAQ++ v1.11](https://boardgamegeek.com/filepage/96855/faq-official), 2017-12-05; local Reference/faq++1.11.pdf and protected English sourceText in data/faq/entries.json. Page references below are printed PDF pages. Physical tracking instructions are assessed by their game-state equivalents. Multiplayer code has no implemented solo shadow-opponent flow. Unsupported promos are scope gaps, not runtime conflicts.

Status cautions: supported is a static trace, not exhaustive state-space proof. partial identifies an unimplemented clause or literal timing qualification, uncertain identifies a rules-priority question. Existing author replacement exceptions are separate.

Most significant observations: Statue of Liberty uses the generic five-player top-two routine despite individual more-workers-than-all wording; general five-player FAQ makes rule priority ambiguous. Black Death full-track return is represented equivalently by a free extra worker consumed first on growth. Porcelain Tower self-removal versus generic advisor loss needs clarification. Solomons Temple and Victoria Falls have literal timing differences without demonstrated changed outcomes.

## 65. Battle — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 4. Entry: `battle-battle`.

Only deployed military enter maximum raid calculation; worker count is not multiplied. Battle grants one chosen resource benefit.

Code: [player.py:raid_value](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L192), [player.py:do_battle](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L431).

## 66. Coffffee House — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 4. Entry: `building-coffffee-house`.

Multiplayer passed-last production is implemented. The solo clause is outside the implemented multiplayer model; no shadow opponent machinery was found.

Code: [progress_cards.py:CoffeeHouse](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L321).

## 67. Grand Duchy of Finland — not-applicable

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 4. Entry: `colony-grand-duchy-of-finland`.

Grand Duchy of Finland is absent from the available card class roster; this promo cannot be played in this snapshot.

Code: [progress_cards.py:all_progress_cards](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3387).

## 68. Bonus — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 4, 5. Entry: `golden-age-bonus`.

Bonus sums all completed-card bonuses, increases the chosen standard resource, and reduces VP resource payment with a zero floor; cannot gain resources from over-discounting.

Code: [player.py:golden_age_bonus](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L202), [player.py:have_golden_age](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L479), [player.py:pay_for_golden_age_point](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L443).

## 69. Antikythera Mechanism — not-applicable

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 5. Entry: `golden-age-antikythera-mechanism`.

Antikythera Mechanism is absent; draw-until-building/wonder, mandatory placement and natural-wonder stopping clauses cannot arise.

Code: [progress_cards.py:all_progress_cards](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3387).

## 70. Arabian Nights — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 5. Entry: `golden-age-arabian-nights`.

Passed-over hook grants exactly two books, special branch ignores Golden Age bonus and end-round removes its extra card and hooks. Solo clause outside supported mode.

Code: [progress_cards.py:ArabianNights](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2870), [player.py:have_golden_age](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L479).

## 71. Le Vite — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 5. Entry: `golden-age-le-vite`.

Special option directly adds three public architects and its discount hook; Golden Age bonus never enters this branch.

Code: [progress_cards.py:LeVite](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2950), [player.py:have_golden_age](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L479).

## 72. Uncle Tom's Cabin — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 5. Entry: `golden-age-uncle-tom-s-cabin`.

All players including purchaser lose building cards with printed deployment_cost -1. Removal undeploys workers and leaves a vacant replaceable slot, the digital equivalent of a flipped card. Special option ignores Golden Age bonus.

Code: [progress_cards.py:UncleTomsCabin](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3034), [player.py:remove_cards](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L868), [player.py:have_golden_age](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L479).

## 73. Assassin — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 5. Entry: `military-assassin`.

Requires a deployed Assassin worker; after-bought-card effect follows ordinary battle gain; each other player chooses legal food payment or advisor removal. Zhu Xi special remove-with behavior discards him whether or not he carries a replacement.

Code: [progress_cards.py:Assassin](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L562), [progress_cards.py:ZhuXi](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2434), [player.py:buy_action](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L508), [player.py:remove_all_advisors](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L904).

## 74. Wonder — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 5. Entry: `wonder-wonder`.

Placement permits any replaceable completed wonder slot even when a slot is empty. wonder-ready hooks execute before old wonder removal, so its ready-trigger reward still occurs on replacing it. Mechanical Turk exception outside scope: card absent.

Code: [player.py:place_wonder_or_natural_wonder](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L611), [player.py:hire_free_architect](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L629).

## 75. Colosseum — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 5. Entry: `wonder-colosseum`.

Ready effect invokes mandatory resource loss, not affordability gating; missing food incurs books and resource-deficit VP through ordinary lose_resources.

Code: [progress_cards.py:Colosseum](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1342), [player.py:lose_resources](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L937).

## 76. Great Lighthouse — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-great-lighthouse`.

Actual card-price event tests gold==3, independent of printed row; Hannibal surcharge contributes to card price so row-two battles qualify. Separate Axumite transfer is not part of card price.

Code: [progress_cards.py:GreatLighthouse](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1370), [progress_cards.py:Hannibal](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2147), [player.py:buy_action](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L508).

## 77. Sphinx — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-sphinx`.

Sphinx registers only on ready, so does not award itself five stone; later wonder-ready hooks fire before replacement removes it.

Code: [progress_cards.py:Sphinx](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1439), [player.py:hire_free_architect](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L629).

## 78. Solomon's Temple — partial

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-solomon-s-temple`.

Awards once at each end-of-age and removes on defeat, yielding at most four VP. Strict timing wording says same time as Books, but hook actually executes after end-of-round hooks following Books. No demonstrated outcome difference for this entry; record timing qualification.

Code: [progress_cards.py:SolomonsTemple](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1420), [match.py:resolution_phase](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640).

## 79. Terracotta Army — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-terracotta-army`.

Placed effect snapshots least stability and applies mandatory four-gold loss to every qualifying player including owner.

Code: [progress_cards.py:TerracottaArmy](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1466).

## 80. Petra — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-petra`.

Once-per-round affordable special action pays one food and directly grants chosen three books/gold/stone from supply; no other player involved.

Code: [progress_cards.py:Petra](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1395).

## 81. Great Library — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-great-library`.

Golden Age bonus uses common summed mechanism. Least-stability hook registered on placement removes card on ordinary least checks, including ties.

Code: [progress_cards.py:GreatLibrary](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1354), [player.py:golden_age_bonus](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L202), [match.py:most_least_of_resource](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L333).

## 82. Alhambra — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-alhambra`.

One private architect is replenished per round and available through ordinary hire actions and costs, rather than a repeatable special action.

Code: [progress_cards.py:Alhambra](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1508), [cards.py:new_round](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/cards.py#L134), [player.py:hire_actions](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L326).

## 83. Notre Dame — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-notre-dame`.

Cross-reference Most and least: produce checks owner.most_stability and grants extra books only for qualifying most set; ties follow shared common most/least algorithm.

Code: [progress_cards.py:NotreDame](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1592), [match.py:most_least](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314).

## 84. Porcelain Tower — uncertain

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-porcelain-tower`.

Tower cover hooks allow advisor on Tower and replacement of that covering advisor. Global advisor loss collects both completed advisors. Removing just covering advisor reveals Tower; placing ready wonder removes Tower and its covered advisor stack. Self-removing Qin or Hypatia calls remove(self), retaining the other advisor: no Tower remove-with hook propagates this. Whether official any-effect wording includes self-removal needs clarification; ordinary lose-advisor effects remove both as required.

Code: [progress_cards.py:PorcelainTower](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1628), [player.py:place_card](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L360), [player.py:remove_cards](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L868), [player.py:remove_all_advisors](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L904).

## 85. Angkor Wat — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-angkor-wat`.

Cross-reference Most and least: production tests owner.least_military; tied least share penalty under common algorithm.

Code: [progress_cards.py:AngkorWat](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1522), [match.py:most_least](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314).

## 86. Chichen Itza — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-chichen-itza`.

Buying-war hook immediately adds one VP with no military, war outcome or defeated-player requirement.

Code: [progress_cards.py:ChichenItza](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1538), [player.py:buy_action](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L508).

## 87. Great Wall — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-great-wall`.

Spared-war-point hook protects only direct defeat VP. War resources and their separate deficit VP remain ordinary losses.

Code: [progress_cards.py:GreatWall](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1555), [player.py:war](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1061), [player.py:lose_resources](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L937).

## 88. Piazza San Marco — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-piazza-san-marco`.

Pays two gold to supply and grants chosen five books/food/stone; requires affordability and one action per round.

Code: [progress_cards.py:PiazzaSanMarco](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1608).

## 89. Hagia Sophia — not-applicable

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-hagia-sophia`.

Hagia Sophia absent from playable card roster; cross-referenced most/least behavior cannot be evaluated for this promo.

Code: [progress_cards.py:all_progress_cards](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3387).

## 90. Shwedagon Pagoda — documented-exception

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-shwedagon-pagoda`.

Markers and added stability clear at end of round before final scoring. Additionally clears immediately when removed, ending round-long benefit early; previously documented author replacement exception.

Code: [progress_cards.py:ShwedagonPagoda](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1659), [match.py:resolution_phase](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640).

## 91. Sistine Chapel — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-sistine-chapel`.

Books are attached to hire-architect event. Normal hire actions require an incomplete wonder, so player cannot hire solely to generate books. Free architect completion path also emits the hook; FAQ entry does not explicitly settle free-hire distinction.

Code: [progress_cards.py:SistineChapel](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1800), [player.py:hire_actions](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L326), [player.py:hire_free_architect](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L629).

## 92. Versailles — documented-exception

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-versailles`.

Force-least effect alters comparison rather than resource marker, preserving actual stability for war mitigation. Effect clears at round end, but removal unregisters it early: previously documented replacement exception.

Code: [progress_cards.py:Versailles](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1834), [match.py:most_least_of_resource](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L333), [player.py:war](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1061).

## 93. Potala Palace — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-potala-palace`.

bonus_points called by final score and counts owned completed advisors including advisor covering Porcelain Tower; two advisors yield two bonus VP.

Code: [progress_cards.py:PotalaPalace](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1750), [player.py:score](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1123), [player.py:advisor_cards](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L119).

## 94. Royal Society — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-royal-society`.

Free deployment bypasses only stone payment, calls normal military.deploy and production, retaining immediate and production upkeep.

Code: [progress_cards.py:RoyalSociety](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1780), [player.py:deploy_for_free](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L585), [progress_cards.py:Military](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L46).

## 95. Uraniborg — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-uraniborg`.

Golden Age/Bonus cross-reference: printed bonus2 is summed through common routine, applying only ordinary resource benefit or zero-floored VP price.

Code: [progress_cards.py:Uraniborg](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1826), [player.py:golden_age_bonus](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L202), [player.py:have_golden_age](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L479).

## 96. Himeji Castle — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-himeji-castle`.

Replaced-card hook requires both old and new building types and strictly newer new_card.age, then grants four stone at placement. Does not reward same age, military, or empty slot.

Code: [progress_cards.py:HimejiCastle](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1709), [player.py:place_card](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L360).

## 97. Red Fort — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-red-fort`.

buy-card-for-gold event compares actual price==1, not row; grants two food immediately.

Code: [progress_cards.py:RedFort](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1763), [player.py:buy_action](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L508).

## 98. Kremlin — not-applicable

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-kremlin`.

Kremlin absent from implemented card roster; ongoing strongest bonus clause cannot arise.

Code: [progress_cards.py:all_progress_cards](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3387).

## 99. Mechanical Turk — not-applicable

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-mechanical-turk`.

Mechanical Turk absent. VP ownership, transfer placement choice, nonreplacement and reserved natural-wonder-space restrictions cannot arise in this source.

Code: [progress_cards.py:all_progress_cards](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3387).

## 100. Öresund Dues — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-oresund-dues`.

Passed-over hook grants two stone per skipped turn. Solo zero-gain clause outside supported multiplayer model.

Code: [progress_cards.py:OresundDues](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1735), [match.py:action_phase](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L546).

## 101. South Pole Expedition — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-south-pole-expedition`.

Mandatory five-food loss on ready uses ordinary deficit payment, allowing completion without five food and charging books/VP as appropriate.

Code: [progress_cards.py:SouthPoleExpedition](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1965), [player.py:lose_resources](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L937).

## 102. Big Ben — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-big-ben`.

Final bonus counts only self.owner.colony_cards filtered age4; does not count other nations colonies.

Code: [progress_cards.py:BigBen](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1854), [player.py:score](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1123).

## 103. Brandenburg Gate — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-brandenburg-gate`.

Ready effect grants both six gold and six stone to entire eligible most-military set, including builder.

Code: [progress_cards.py:BrandenburgGate](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1868), [match.py:most_military](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L376).

## 104. British Museum — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-british-museum`.

Placed effect imposes ten-book loss on all qualifying least military including owner.

Code: [progress_cards.py:BritishMuseum](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1889), [match.py:least_military](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L383).

## 105. MIT — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-mit`.

Bought-building hook follows placement and optionally deploys one worker on that exact card for no stone. If none undeployed it first asks for undeployment; normal deployment effects then apply.

Code: [progress_cards.py:MIT](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1938), [player.py:buy_action](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L508), [player.py:deploy_for_free](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L585).

## 106. Statue of Liberty — uncertain

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-statue-of-liberty`.

Final scoring correctly delays bonus. Five-player generic most_least can award two players, or tied first when exactly two, rather than strict singleton most workers. Individual wording says more than all others, but general official five-player rule says two most of anything, so priority needs rules clarification; observed code behavior is certain, discrepancy interpretation uncertain.

Code: [progress_cards.py:StatueOfLiberty](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1976), [match.py:most_least](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314), [player.py:score](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1123).

## 107. Titanic — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `wonder-titanic`.

Iterates reverse player order. Removes both advisors on removal option; no advisors forces mandatory four-gold loss with ordinary deficit books/VP. An unaffordable gold option is not offered when advisors provide a payable alternative.

Code: [progress_cards.py:Titanic](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1999), [player.py:remove_all_advisors](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L904), [player.py:lose_resources](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L937).

## 108. Natural Wonders — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `natural-wonders-natural-wonders`.

Natural-wonder and extension spaces are excluded from replacement; purchase gates sufficient replaceable space, completion actions require replaceable space, and ordinary wonders remain replaceable by natural wonders.

Code: [player.py:replaceable_wonder_spaces](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L160), [player.py:can_buy_card](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L260), [player.py:place_wonder_or_natural_wonder](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L611), [player.py:hire_actions](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L326).

## 109. Vesuvius — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 6. Entry: `natural-wonders-vesuvius`.

End-of-age hook returns one worker; existing undeployed worker used if available, otherwise asks to undeploy. Undeploy check suppressed until restored population-track stability. Extra check within end-age hook is not a conflict with this specific mandatory-return entry.

Code: [progress_cards.py:Vesuvius](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3124), [player.py:return_worker](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L832).

## 110. Siberia — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `natural-wonders-siberia`.

Extra-space hook reserves two replaceable spaces at purchase. Discovery places ordinary Siberia then creates and places its extension in another replaceable slot; both are nonreplaceable natural-wonder types.

Code: [progress_cards.py:Siberia](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3198), [progress_cards.py:Siberia2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3222), [player.py:can_buy_card](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L260), [player.py:place_wonder_or_natural_wonder](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L611).

## 111. Sahara — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `natural-wonders-sahara`.

Four extra military emitted exclusively to war-defeat calculation; resources military and ordinary most/least/order/colony checks unchanged.

Code: [progress_cards.py:Sahara](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3184), [player.py:war](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1061).

## 112. Hawaii — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `natural-wonders-hawaii`.

On placed Hawaii records selected population pool, takes worker without immediate upkeep then marks pool; permanent marker subtracts resource cost and prevents returning that waived slot. Worker identity abstracted by pool bookkeeping.

Code: [progress_cards.py:Hawaii](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3160), [nations.py:WorkerPool](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L11).

## 113. Spice Islands — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `natural-wonders-spice-islands`.

Extra-growth-resource hook returns four only in resource-choice branch, applied to selected same resource. Worker-growth branch does not use it.

Code: [progress_cards.py:SpiceIslands](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3295), [player.py:growth](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L217).

## 114. Titusville — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `natural-wonders-titusville`.

Extra scoring stone inserted only immediately around resource-total division, after card bonus VP; no doubling of ordinary production, military or stability.

Code: [progress_cards.py:Titusville](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3337), [player.py:score](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1123).

## 115. Victoria Falls — partial

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `natural-wonders-victoria-falls`.

Row-four colonies created on discovery and never carried into next progress board; progress phase reconstructs three rows. FAQ says discard at end of round whereas source retains board until next progress phase. No established intervening gameplay effect, but literal timing differs.

Code: [progress_cards.py:VictoriaFalls](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3365), [match.py:progress_phase](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L441).

## 116. Uluru — not-applicable

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `natural-wonders-uluru`.

Entry solely specifies solo zero reward. Uluru counts passed players normally, but shadow solo game is not implemented; solo-specific clause cannot arise in supported mode.

Code: [progress_cards.py:Uluru](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L3353).

## 117. Event — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-event`.

Common most/least supports positive exclusion on ties and all negative least; five-player maximum two positive vs all negative cutoff ties. Mandatory choices generally reverse order. Event loss uses raw lose_resources without war stability mitigation. Per-effect single execution and explicit multi-worker loops. Return-worker effects distinct from undeploy effects.

Code: [event_cards.py:EventCard](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L8), [match.py:resolution_phase](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640), [player.py:lose_resources](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L937).

## 118. Ashokas conversion — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-ashokas-conversion`.

Reverse-order loop permits repeated military undeployment until Done; workers move to undeployed supply rather than population, and are available next round.

Code: [event_cards.py:HellenismAshokasConversion](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L223), [player.py:undeploy_action](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L603).

## 119. Bronze Age Collapse — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-bronze-age-collapse`.

Safe set is union of most military and most stability, so strongest, most stable and player who is both avoid VP loss.

Code: [event_cards.py:SeaPeoplesBronzeAgeCollapse](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L363).

## 120. Christianity — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-christianity`.

Shared may_pay_to_gain asks Yes/No once per affordable player in reverse order; no mandatory conversion.

Code: [event_cards.py:BreadAndGamesChristianity](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L208), [event_cards.py:EventCard](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L8).

## 121. Han dynasty — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-han-dynasty`.

Yes/No wraps both worker and three food; requires worker availability, grants both or neither.

Code: [event_cards.py:PaxRomanaHandynasty](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L263).

## 122. Hellenism — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-hellenism`.

If strongest shared in 2-4, most set empty and others loop makes everyone lose two food; ordinary five-player cutoff rule inherited.

Code: [event_cards.py:HellenismAshokasConversion](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L223), [match.py:most_least](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314).

## 123. Jain Ascetism — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-jain-ascetism`.

Lost-to-war event accumulates direct and deficit VP per player. Most stable regains only own accumulated lost VP, never others. Resource-loss routine pays available resources before deficits.

Code: [event_cards.py:AssyrianDeportationsJainAscetism](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L135), [player.py:lose_resources](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L937), [player.py:war](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1061).

## 124. Olympic games — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-olympic-games`.

Events occur after normal player-order phase. In five-player two most stable are sorted by stability then existing player order and prepended strongest first.

Code: [event_cards.py:QinUnificationOlympicGames](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L289), [match.py:resolution_phase](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640), [event_cards.py:EventCard](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L8).

## 125. Qin Unifcation — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-qin-unifcation`.

No war means no effect. Otherwise every player with raw military strictly greater than war_value gains one VP.

Code: [event_cards.py:QinUnificationOlympicGames](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L289).

## 126. Spartacus revolt — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-spartacus-revolt`.

Event reordering resolves after normal military/stability player-order phase.

Code: [event_cards.py:YellowTurbanRebellionSpartacusRevolt](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L436), [match.py:resolution_phase](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640).

## 127. Rigveda — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-rigveda`.

Counters record purchases of wars/battles and award one book each at event resolution. FAQ immediate-book suggestion is optional physical tracking convenience, not a required immediate payout.

Code: [event_cards.py:RigvedaExodus](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L324).

## 128. Sea Peoples — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-sea-peoples`.

Removal offered only when first wonder under construction has positive completed_stages, then decrements that. Private available architect count is never touched.

Code: [event_cards.py:SeaPeoplesBronzeAgeCollapse](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L363).

## 129. Zoroastrian revival — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-zoroastrian-revival`.

Choice offered to unique most stable (none on shared-most in 2-4). Five-player most stable set sorted by value/current order, top makes shared reward-versus-others-loss choice.

Code: [event_cards.py:AttilaZoroastrianRevival](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L172), [event_cards.py:EventCard](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L8).

## 130. Black Death — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-black-death`.

Normal case returns worker to chosen population pool and restores upkeep. When no population worker has been taken, source uses extra_worker_pool for the worker placed atop a full track; take_worker consumes that free extra worker first, preserving game-state effect. Track-choice identity is unnecessary digital bookkeeping.

Code: [event_cards.py:BlackDeathHuntForPresterJohn](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L469), [player.py:return_worker](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L832), [nations.py:WorkerPool](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L11).

## 131. Ecological Collapse — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-ecological-collapse`.

All decisions gathered in reverse order before order mutation; food<2 forces nonpayment. Result keeps paying subgroup in order followed by nonpaying subgroup in order. Event resolves after normal order.

Code: [event_cards.py:EcologicalCollapseCasteSystem](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L504), [match.py:resolution_phase](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640).

## 132. Feudal dues — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-feudal-dues`.

On reveal skip-player-order hook causes normal order phase to return unchanged; event A intentionally no-op.

Code: [event_cards.py:FeudalDuesHajjFromMali](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L539), [match.py:player_order_phase](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L576).

## 133. Fourth Crusade — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-fourth-crusade`.

Top most-military chooser sorted by value and current order gates all least-military losses. Only when top pays can second most optionally pay for own VP. Generic least set supplies both weakest in five-player and cutoff ties. Affordability and declining properly suppress losses.

Code: [event_cards.py:FourthCrusadeSongResistance](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L562), [event_cards.py:EventCard](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L8).

## 134. Hajj from Mali — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-hajj-from-mali`.

At two or fewer gold does nothing; only gold>2 is reduced to exactly two.

Code: [event_cards.py:FeudalDuesHajjFromMali](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L539).

## 135. Iconoclasm — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-iconoclasm`.

Single Resources loss includes food -2 and gold -2 simultaneously; both components paid, with normal deficit handling.

Code: [event_cards.py:RaidOnLindisfarneIconoclasm](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L748), [player.py:lose_resources](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L937).

## 136. Peace of God — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-peace-of-god`.

Explicit no-war guard exits without granting books.

Code: [event_cards.py:PeaceOfGodCouncilOfClermont](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L698).

## 137. Song Resistance — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7. Entry: `event-song-resistance`.

Lost-to-war counters record own actual resource and point changes including shortfall penalties, then restore both to most-stable eligible owner.

Code: [event_cards.py:FourthCrusadeSongResistance](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L562), [player.py:lose_resources](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L937), [player.py:war](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1061).

## 138. Stupor Mundi — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 7, 8. Entry: `event-stupor-mundi`.

Counts all bought Golden Ages this round and chooses most at resolution. Keeping physical cards beside board is represented by counter; no physical retention necessary.

Code: [event_cards.py:StuporMundiGreatSchism](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L778).

## 139. Zanj Revolt — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 8. Entry: `event-zanj-revolt`.

Reorders during event after normal player-order phase.

Code: [event_cards.py:ChansonDeRolandZanjRevolt](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L488), [match.py:resolution_phase](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640).

## 140. Absolute Monarchy — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 8. Entry: `event-absolute-monarchy`.

No standalone discard-advisor main action exists; replacing advisor is via buying and placing new advisor. Event itself penalizes antiquity/medieval advisor without offering discard escape.

Code: [event_cards.py:AbsoluteMonarchySalemWitchTrials](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L818), [player.py:take_one_action](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L756), [player.py:place_card](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L360).

## 141. Dutch Revolt — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 8. Entry: `event-dutch-revolt`.

Event moves least stable to back after normal player-order phase.

Code: [event_cards.py:PilgrimsDutchRevolt](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1081), [match.py:resolution_phase](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640).

## 142. Glorious revolution — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 8. Entry: `event-glorious-revolution`.

Optional Yes/No wraps six gold plus going last. Five-player sorted top-two queried in reverse (secondmost first); accepted players inserted in most/secondmost order at tail, leaving secondmost last when both accept.

Code: [event_cards.py:AfricanSlaveTradeGloriousRevolution](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L863), [event_cards.py:EventCard](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L8).

## 143. Janissaries — supported

[Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), p. 8. Entry: `event-janissaries`.

Affordability requires two available workers; one Yes/No wraps two take-worker calls plus four stone, so cannot take partial bundle.

Code: [event_cards.py:JanissariesCouncilOfTrent](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L969).
