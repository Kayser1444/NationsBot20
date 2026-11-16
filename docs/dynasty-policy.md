# Dynasty policy v2

The 1,902 eligible completed two- and four-player replays contain 343 Persian games: Sassanid was played in 324 (94.5%), Achaemenid in 24 (7.0%). Sassanid was the first dynasty played in 313. Rome kept its starting ability throughout 317/408 games (77.7%). These are choices made by humans, not causal estimates of dynasty strength. Games can play both dynasties.

| Nation | Games | Kept starting ability throughout | First dynasty played |
|---|---:|---:|---|
| America | 214 | 20 | Federalist Party: 146, Democratic Republicans: 48 |
| Arabs | 227 | 144 | Umayyad Caliphate: 52, Abbasid Caliphate: 31 |
| China | 262 | 20 | Ming Dynasty: 219, Qin Dynasty: 23 |
| Egypt | 205 | 117 | Old Kingdom: 44, New Kingdom: 44 |
| Ethiopia | 296 | 101 | Axumite Kingdom: 179, Sheba: 16 |
| Greece | 344 | 100 | Sparta: 126, Athens: 118 |
| India | 359 | 79 | Mauryan Empire: 255, Mughal Empire: 25 |
| Japan | 373 | 289 | Heian Period: 62, Edo Period: 22 |
| Korea | 361 | 170 | Joseon Kingdom: 174, Koryo Kingdom: 17 |
| Mali | 167 | 72 | Songhai Empire: 49, Mali Empire: 46 |
| Mongolia | 331 | 42 | Yuan Dynasty: 267, Golden Horde: 22 |
| Persia | 343 | 17 | Sassanid Empire: 313, Achaemenid Empire: 13 |
| Poland | 198 | 42 | Jagellonian Dynasty: 118, Polish-Lithuanian Commonwealth: 38 |
| Portugal | 226 | 73 | Portugese Empire: 106, Kingdom of Leon: 47 |
| Rome | 408 | 317 | Roman Empire: 68, Roman Republic: 23 |
| Venice | 223 | 85 | Pactum Warmundi: 117, Domains of the Sea: 21 |
| Vikings | 239 | 48 | Normans: 170, Varangians: 21 |

## Training and effects

The extractor now records both **Which benefit?** and forced **Play which dynasty?** prompts, including Gold choices. Training uses 21,042 additional decisions from 1,499 games; validation uses 213 games and the held-out split 190. Splits remain grouped by starting seed. All 2,267 existing draft, growth and action coefficients are frozen. Only the new benefit head is trained.

A separate head distinguishes each dynasty, the current dynasty or starting ability, round, resources and remaining turmoil cards. It includes printed ability categories for all 34 dynasties and conditional public-position features such as free Gold turmoils, colony access, workers, architect demand, military and book leads. Replacing Rome's starting ability includes losing 2 Military. Five-player lead features use the same most/least thresholds as the shared scorer.

The ordinary activation cost is retained when Persia first plays Sassanid. Subsequent Gold turmoils with Sassanid consume one card from the round supply, give 2 Gold and do not reduce Stability or add held turmoil. Changing away from Sassanid through a turmoil benefit incurs the deferred Stability cost. Playing it after the last turmoil in the last round is dominated by taking Gold. The action scorer consults the learned benefit choice when considering Turmoil.

Special effects are inputs and bounded forecasts, not a complete reimplementation of every triggered ability. Sassanid cost transitions are implemented explicitly and checked against the real local engine. Automatic special actions and other subchoices still use the existing policy or fallback.

Gold labels outnumber voluntary dynasty plays by roughly seven to one in the held-out set. The release weights dynasty-play training examples three times as heavily and selects an epoch using the corresponding validation loss. This intentionally trades some Gold-choice agreement for activation recall: on the held-out data it matches 176/354 voluntary dynasty plays (49.7%) and 2,219/2,440 Gold choices (90.9%). It matches all 35 Sassanid plays and 225/229 Roman benefit choices. Rare forced dynasty choices remain weak (0/7 held-out matches); 42 training examples are too few for a reliable estimate. Overall held-out benefit/forced agreement is 85.5%.

## Game evaluation

The final checkpoint was evaluated on the same seed 61371000 and seat rotations as the previous release. An archived copy of commit `29fe9dd4c50574dc099fe1f1c8bf49b73c19fbdd` supplied the previous baseline opponent, including its original scorer code. All 384 games completed.

| Opponents | Previous release | Dynasty release |
|---|---:|---:|
| One Easy | 60/64 | 60/64 |
| One v0.2 heuristic | 60/64 | 58/64 |
| Three Easy bots | 82/96 | 84/96 |
| One previous-baseline bot | — | 30/64 |
| Three previous-baseline bots | — | 20/96 |

The candidate played Sassanid in round one in all 46 Persian appearances and retained the starting ability in all 25 Roman appearances. These include repeated boards against different opponents, not 46 independent Persian openings. Its four-player mean league points against Easy were 4.677 on the 5/3/2/1 scale. Direct play against the previous baseline does not establish an overall strength improvement; this release corrects dynasty behavior while retaining roughly the previous performance against simple bots.

The first unweighted candidate scored 62/64, 59/64 and 86/96 against the simple opponents, but matched only 85/354 held-out voluntary dynasty plays. It was replaced by the balanced head to address the broader reluctance to activate dynasties. Those exploratory reports remain under `.data/human-policy/dynasty-benchmark/`.

Aggregate training evidence is in `live-player/dynasty-training-info.json`; final benchmark summaries and code/model hashes are in `live-player/baseline-info.json`. Full final reports and replays remain in `.data/human-policy/dynasty-final-benchmark/`. Three- and five-player strength has not been benchmarked.

```powershell
& '../nations-server/.venv/Scripts/python.exe' -B scripts/extract-human-nations.py "$env:USERPROFILE/Downloads/completed_matches_2730.tar.gz" .data/human-policy/NEW_DIRECTORY
node scripts/train-human-nations.mjs .data/human-policy/NEW_DIRECTORY 5 BASE_POLICY.json 3
node scripts/evaluate-dynasty-nations.mjs .data/human-policy/NEW_DIRECTORY MODEL.json
& '../nations-server/.venv/Scripts/python.exe' -B scripts/evaluate-local-nations.py MODEL.json --output .data/human-policy/NEW_REPORT --boards 32 --four-player-boards 24 --seed 61371000 --previous-directory ARCHIVED_LIVE_PLAYER_DIRECTORY
```
