# Official FAQ implementation audit: events, dynasties and general questions

Scope: English sourceText entries144–215 (zero-based) of official Nations FAQ++1.11, pages8–10. Pinned source revision9c344205b1802c9583d20c749b89a4cfa52516f7; deployed website revision unverified. Every English clause traced; solo clauses are outside multiplayer support, not defects. Supported is source evidence, not exhaustive replay coverage.

Status counts: {'supported': 54, 'conflict': 0, 'uncertain': 4, 'not-applicable': 12, 'partial': 1, 'documented-exception': 1}.

Vasa issue closed following the designer clarification reported by the user on 2026-10-17; current behavior is accepted. Known Axumite/Galileo conflict also affects official entry173. Roman Republic bonus lifetime is documented exception. Uncertainties: Industrial Revolution5player interpretation; Poland lose-all scope for conditional self-removal; Leon strict war/battle ordering.

[Component probes](probe_official_faq_03.py) ran successfully: Vasa0gold/0military assigned reduction; Emigration no population worker taken correctly creates prioritized free extra worker; Qin self-removal with Poland leaves second advisor. Hash-verified source only, no runtime edits.

## 144: Kangxi Era

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Player-order phase precedes events; Kangxi then moves eligible players first and retains ordering rules for multiple eligible players.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640-L645), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1158-L1186).

## 145: Little Ice Age

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Choices resolve over players[::-1], with food/books alternatives and ordinary resource loss resolution.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L996-L1028).

## 146: Magellan's expedition

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Per-round Counter increments on each bought colony; five gold times count is credited only in happen_a, not at purchase.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1038-L1059).

## 147: Mercantilism

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Reverse order; optional loop permits multiple building undeployments; each undeploy increases available workers, not population.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L934-L967), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L603-L609).

## 148: Muntzer Revolt

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Reordering helper executes within event after player-order phase.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640-L645), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1143-L1156), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L90-L108).

## 149: Papal Indulgence

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Free architect immediately advances construction without decrementing shared architect supply or charging stone. In ordinary player counts a tied highest value leaves no most, so everyone pays2. General five-player top-two rule applies.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1061-L1079), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L629-L642), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314-L331).

## 150: Peace of Westphalia

**uncertain** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Source-text ambiguity: the FAQ calls this reordering, while the implemented Peace of Westphalia effect is least military loses food. The effect runs after normal player order, but this does not establish a reordering rule to audit. Resolve the apparent FAQ/card mismatch before claiming either compliance or an implementation defect.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640-L645), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1102-L1141).

## 151: Pilgrims

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

take_worker is compulsory if available; no yes/no. Most-food tie excludes recipients at ordinary counts; general five-player exception applies.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1081-L1100), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314-L331).

## 152: Salem Witch Trials

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Remove-advisors branch calls remove_all_advisors over all removable advisors, including Porcelain Tower occupant.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L837-L861), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L126-L131), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L868-L905).

## 153: Sinking of the Vasa

**supported following reported designer clarification** — FAQ p.8.

Accepted designer clarification, reported by the user on 2026-10-17: Logitude discussed this with Rustan Håkansson, whose interpretation agrees with the current implementation. The gold<3 branch may use the temporary military reduction even below zero. Closed as an issue; no gameplay change requested. This is a user-reported clarification, not an independently inspected quotation from Rustan.

## 154: American Revolution

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

If colony exists selects one and removes it without decline option; otherwise loses point.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1200-L1218).

## 155: Anarchism

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Anarchism invokes remove_all_advisors, including second advisor on Porcelain Tower.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1241-L1246), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L904-L905).

## 156: Emigration

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Emigration uses return_worker. When normal pool has grown workers, chooses eligible food/stability pool. If neither pool has been grown, worker goes to extra_worker_pool; future growth takes that worker first with no cost, mechanically representing placement above either track. Track-side visual choice is abstracted. Initial board workers count in grown_workers, so no-population-growth is not zero-grown-workers.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1499-L1503), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L832-L865), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L219-L250).

## 157: Entente Cordiale

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Separate loop for each of two military deployments permits different cards. If no free workers, any undeploy action is offered, including from military, then chosen deployment. Capacity respects max_workers.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1281-L1332).

## 158: French Revolution

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Any removable advisor forces remove_all_advisors; Porcelain Tower advisors included; no decline.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1220-L1230), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L904-L905).

## 159: Great Exhibition

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Two immediate free architects consume no shared supply/stone; Wardenclyffe placed during events immediately executes three actions. can_buy_card rejects further war when war exists; war resets next maintenance. Completing tower after war resolution cannot change the already-resolved war of current round.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1248-L1264), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L629-L642), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2056-L2079), [source4](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L279-L281), [source5](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L528-L529).

## 160: Industrial Revolution

**uncertain** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Counts deployed workers only on age4 building cards. Ordinary-count ties award none. Generic most calculation implements general top-two rule at five players; interpret this FAQ shorthand with that rule. Unresolved five-player interpretation: this entry explicitly says more than all others, shared none, whereas general most rule allows two. Ordinary2–4 player behavior matches; author clarification needed before claiming conflict at5.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1389-L1399), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314-L331).

## 161: March to Moscow

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Existing colony must be selected and removed, no decline; absence causes point loss.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1359-L1376).

## 162: Scramble for Africa

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Loops colonies, adds one point for first age4 colony then breaks; older colonies ignored.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1411-L1424).

## 163: Sepoy Mutiny

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Sepoy helper reorders after regular player order.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640-L645), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1456-L1472), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L90-L108).

## 164: Sokoto Caliphate

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Optional payment/gain helper iterates reverse player order and permits declining.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1441-L1454), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L77-L88).

## 165: Taiping Rebellion

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Taiping reorder helper executes during events after player-order phase.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640-L645), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1350-L1376).

## 166: Tonghak movement

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Books loss and stone gain execute consecutively; stone gain is unconditional even if books loss exhausts holdings.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1464-L1469).

## 167: Weltpolitik

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Each age4 colony contributes5gold+5stone to reward; older colonies contribute neither.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/event_cards.py#L1483-L1497).

## 168: Dynasties

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Section introduction only; no independent executable rule.

Evidence: Editorial/non-executable entry.

## 169: America: Democratic Republicans

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Action unavailable if owner among least military; filters least players with unplayed dynasties, requires enough turmoil for all, forces each to choose available dynasty and awards3books each. Uses global least logic including five-player rule. Solo clause outside supported multiplayer mode.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L12-L58).

## 170: Arabs: Abbasid Caliphate

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Other player buying any golden age activates optional VP regardless of their selection; own golden_age_bonus reduces affordability and payment. Solo shadow clause outside supported mode.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L75-L100), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L444-L475).

## 171: China: Qin Dynasty

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Returns available worker directly if one exists, otherwise undeploys; immediately hires free architect without supply decrement or stone.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L127-L140), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L629-L642), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L832-L865).

## 172: Egypt: Old Kingdom

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8.

Correct Remove Advisor action; selects one removable non-covered advisor and calls remove(card) once, not remove_all_advisors.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L142-L182).

## 173: Ethiopia: Axumite Kingdom

**partial** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.8, 9.

Marks persist across rounds in marked_cards; owner exempt and normal purchase pays bank price plus owner3gold. Galileo free=True skips extra-payment hooks: known confirmed surcharge conflict. Discarded cards leave harmless stale entries (not on board/no later purchase). Solo clause outside supported mode.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L200-L249), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L258-L267), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L530-L555).

## 174: India: Mauryan Empire

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Only growth-triggered taking worker offers extras: two if two available, otherwise one; no option for one when two remain.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L329-L349).

## 175: India: Mughal Empire

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

VP subscribes wonder ready, called only completed construction; natural discovery uses discover event instead.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L351-L361), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L629-L642), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L661-L674).

## 176: Japan: Heian Period

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Only ordinary book resource benefit fires golden age choose books; special actions activate directly and do not fire it.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L393-L403), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L477-L497).

## 177: Japan: Edo Period

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

no defeated effect hook wraps defeated event and losses, so removal conditions subscribed defeated (including Solomon Temple) never run.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L363-L391), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1061-L1067).

## 178: Korea: Joseon Kingdom

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Placement options are one resource type1..3 and stored balance blocks reuse. End-of-round returns twice stored quantity before final scoring. Removal unregisters return event, losing resources permanently; stored3gold returns6gold.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L405-L449), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640-L659), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L868-L898).

## 179: Mali: Mali Empire

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Correct remove-advisor action chooses exactly one uncovered advisor; costs2gold, gives3books+1VP, and removes chosen card only.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L464-L486).

## 180: Mongolia: Golden Horde

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

This specific FAQ ruling is solo only, outside supported modes; multiplayer Golden Horde receives actual paid war price through buy card for gold.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L504-L518).

## 181: Mongolia: Yuan Dynasty

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Up to three ordinary take_worker calls draw regular population workers, with common extra pool handling same as growth.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L520-L531), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L803-L830).

## 182: Persia: Achaemenid Empire

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Growth worker flags discount available only action_number1; deploy is a main action and increments action counter, consuming first action. Undeployment remains permitted free preparation; no repeated free deployment.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L533-L563), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L591-L601), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L751-L777).

## 183: Persia: Sassanid Empire

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Defers taking turmoil. Gold benefit discards via hook without personal turmoil/-2stability. Choosing a new dynasty passes deferred flag, adds turmoil and subtracts2stability before replacement.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L565-L576), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L680-L722).

## 184: Poland: Jagellonian Dynasty

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Paid extra turn runs before normal action loop, which then starts at first player; first-position Poland therefore takes consecutive turns.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L578-L624), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L548-L554).

## 185: Poland: Polish-Lithuanian Commonwealth

**uncertain** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Dynasty removal discards advisors only in wonder slots, leaving Porcelain Tower occupant outside wonder slots intact. Effects asking lose advisors call remove_all_advisors across every removable advisor. Does not treat voluntary dynasty remove-one-advisor actions as lose-all; FAQ expressly permits single removal there. Unresolved scope: conditional self-removal (e.g. existing Qin reaches least stability) calls remove(self), leaving other advisors. A component probe confirms this. If FAQ any effect includes self-removal, it conflicts; if only opponent/event remove-advisor instruction, generic all-advisor calls comply. No implicit remove-with rule registered by Poland.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L626-L642), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L904-L905), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L126-L131), [source4](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2211-L2225).

## 186: Portugal: Portugese Empire

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Removal discards colonies on wonder slots. Placement supports colonies there and replacement by colony/wonder/natural wonder, while all replacement slots exclude natural wonders/extensions.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L701-L717), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L160-L161), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L367-L415), [source4](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L611-L626).

## 187: Portugal: Kingdom of Leon

**uncertain** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Battle effects and buying/bought/after-bought hooks replay by temporarily treating war as battle; Montezuma prev_card avoids duplicate3books. Abu Bakr and other battle hooks participate. Ordering caveat: do_battle plus buying-battle triggers occur in buying card before actual war card buy/set-war; FAQ explicitly places battle after resolving purchase. No resulting gameplay difference demonstrated; timing discrepancy only, not confirmed gameplay bug. Overall verdict uncertain only for strict ordering clause; named reward/dedup behavior is supported.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L668-L699), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2535-L2554), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L2255-L2270), [source4](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L554-L583).

## 188: Rome: Roman Republic

**documented-exception** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Uses shared architects and decrements1, gains1stability, removes round bonus at end. Known documented exception: removing dynasty also clears the bonus before round ends.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L736-L763).

## 189: Venice: Domains of the Sea

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

discard immediately targets bought colony and returns true; dynasty stays installed.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L765-L781).

## 190: Venice: Pactum Warmundi

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Other player buying battle/colony directly adds1gold from bank, no deduction from buyer. Solo shadow clause outside supported mode.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L783-L797).

## 191: Vikings: Normans

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Extra raid-value hook adds3 to normal maximum deployed military raid value.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L799-L808), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L192-L199).

## 192: Q: Can you build the same building/military card several times?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Placement has no same-name uniqueness restriction; nation starting cards instantiate separately from progress cards. Thus same building/military may coexist including B-side starting copies.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L367-L415), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L42-L55), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L248-L280).

## 193: Q: Can you place many workers on a building/military?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Normal deployment adds one worker per main action; non-max-workers buildings/militaries permit further workers. Specific card capacity restrictions retained.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L299-L316), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L585-L601), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L751-L777).

## 194: Q: Do you get VP for placing a worker on a building/military?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Deployment updates production/most-least without VP. score sums deployed workers worker_points only at scoring; projected score display is not awarded VP.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L585-L601), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1123-L1138).

## 195: Q: In a 5-player game with 2 Nations having the most Strength, who gets the bonus from a strongest Nation event?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Five-player most selects up to top2 unless threshold tied with third; exactly two tied highest are both above third and both qualify.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314-L331).

## 196: Q: In a 5-player game with 3 Nations having the most Strength, who gets the bonus from a strongest Nation event?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Three tied highest makes threshold increase above their value, leaving no most recipients.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L314-L331).

## 197: Q: What does the Books on the solo tiles mean?

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Solo shadow/tile/die rule. No shadow opponent, solo tile or die-roll engine is present in this multiplayer implementation; card-draw tables cover2+ players. Not a multiplayer gameplay defect.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L16-L74).

## 198: Q: Is the shadow opponent afected by war?

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Solo shadow/tile/die rule. No shadow opponent, solo tile or die-roll engine is present in this multiplayer implementation; card-draw tables cover2+ players. Not a multiplayer gameplay defect.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L16-L74).

## 199: Q: Can the shadow take Turmoil cards?

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Solo shadow/tile/die rule. No shadow opponent, solo tile or die-roll engine is present in this multiplayer implementation; card-draw tables cover2+ players. Not a multiplayer gameplay defect.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L16-L74).

## 200: Q: Should I roll the die after every action?

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Solo shadow/tile/die rule. No shadow opponent, solo tile or die-roll engine is present in this multiplayer implementation; card-draw tables cover2+ players. Not a multiplayer gameplay defect.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L16-L74).

## 201: Q: If I am second in player order and pass as my frst action, will the shadow player roll at all?

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Solo shadow/tile/die rule. No shadow opponent, solo tile or die-roll engine is present in this multiplayer implementation; card-draw tables cover2+ players. Not a multiplayer gameplay defect.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L16-L74).

## 202: Q: Are the strength and stability values for the shadow accumulated?

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9.

Solo shadow/tile/die rule. No shadow opponent, solo tile or die-roll engine is present in this multiplayer implementation; card-draw tables cover2+ players. Not a multiplayer gameplay defect.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L16-L74).

## 203: Q: If a war has been bought or rolled, what happens if I roll a column with a war again?

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.9, 10.

Solo shadow/tile/die rule. No shadow opponent, solo tile or die-roll engine is present in this multiplayer implementation; card-draw tables cover2+ players. Not a multiplayer gameplay defect.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L16-L74).

## 204: Q: Is the efect applied each time you roll a 5 or 6, or only the frst?

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

Solo shadow/tile/die rule. No shadow opponent, solo tile or die-roll engine is present in this multiplayer implementation; card-draw tables cover2+ players. Not a multiplayer gameplay defect.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L16-L74).

## 205: Q: When an architect is removed by a die roll in the solo game, is a Turmoil card removed as well?

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

Solo shadow/tile/die rule. No shadow opponent, solo tile or die-roll engine is present in this multiplayer implementation; card-draw tables cover2+ players. Not a multiplayer gameplay defect.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L16-L74).

## 206: Q: What happens when I take a worker?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

Growth normal worker uses3food upkeep or immediate-3stability worker pool; worker taking has no separate resource payment. Growth resource bonus is foregone by selecting worker. Special extra pool/other nation exceptions are separate explicit effects.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/nations.py#L11-L31), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L219-L250), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L803-L830), [source4](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1022-L1036).

## 207: Q: When does "Scoring" happen, like on Statue of Liberty? (Scoring: +2 VP if most workers)

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

bonus_points evaluated during final score (also non-mutating projected score); end-age hooks execute separately every even round.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1123-L1138), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640-L669).

## 208: Q: How are "Used" markers placed?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

Limited actions check markers/resources against limit and reset each round; unlimited action availability lacks per-round count. Digital marker state substitutes physical used markers; Old Kingdom persistent markers track its separate production effect.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/cards.py#L125-L139), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L127-L134), [source3](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/dynasty_cards.py#L142-L163), [source4](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L353-L359).

## 209: Q: How many rounds is the game?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

Rounds increment1 at a time; game finishes at8. Even rounds score books, giving four two-round ages. Physical reminder marker is presentation only.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L640-L659), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L700-L706).

## 210: Q: If I move a worker from a Temple (Stability 1) to a Ziggurat (Stability 2), is my Stability reduced by 1 before being increased by 2?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

Undeployment immediately updates most/least; subsequent deployment independently updates. Thus temple-to-ziggurat temporary dip can remove conditional advisor, as FAQ requires.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L603-L609), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L591-L601).

## 211: Q: How is player order determined for Nations in revolt?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

Player-order sort clamps all negative stability to-1, preserving old order when military and clamped stability tie; force least stability hook similarly sets Versailles to-1. Distinct military still orders normally.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L576-L590), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/progress_cards.py#L1834-L1852).

## 212: Q: How is negative Stability counted at the end of the game?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

total includes signed stability with upper cap15 but no lower floor, reducing resources used for final scoring.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/resources.py#L93-L94), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1135-L1138).

## 213: Q: Is row 1 on the progress board diferent from row 2 and 3?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

Progress board initialized as3equal rows of playercount+2 columns; no shorter first row.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L279-L280), [source2](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/match.py#L446-L448).

## 214: Q: Page 15, what is the o in "It is impossible for any nation to sufer any losses due to strength o war."?

**supported** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

War value0 defeats only military below0; no positive/zero strength player loses due to zero-strength war, consistent with corrected typographic zero. Negative-strength special cases remain per rules.

Evidence: [source1](https://github.com/Logitude/nations/blob/9c344205b1802c9583d20c749b89a4cfa52516f7/player.py#L1061-L1098).

## 215: Q: Why is the 4:th age indicated by "II II" instead of "IV" at the bottom?

**not-applicable** — [Official FAQ](https://boardgamegeek.com/filepage/96855/faq-official), pp.10.

Physical card printing explanation (IIII vs IV), no gameplay logic to implement.

Evidence: Editorial/non-executable entry.
