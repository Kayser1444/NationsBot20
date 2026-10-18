"""Offline focused probes of the pinned Tabony source; no runtime data changes.

Run with Python 3 from any directory. Extracts hash-verified snapshot source to a
temporary directory and exercises real methods on deliberately small fixtures.
These are component probes, not full-game replay tests.
"""
import hashlib
import importlib
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
snapshot = json.loads((ROOT / 'data/question/tabony-snapshot.json').read_text(encoding='utf-8'))
(ROOT / '.tmp').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='tabony-faq-', dir=ROOT / '.tmp') as tmp:
    package = Path(tmp) / 'nations'
    package.mkdir()
    for name, entry in snapshot['files'].items():
        raw = entry['text'].encode('utf-8')
        assert hashlib.sha256(raw).hexdigest() == entry['sha256'], name
        (package / name).write_bytes(raw)
    sys.path.insert(0, tmp)
    Match = importlib.import_module('nations.match').Match
    Player = importlib.import_module('nations.player').Player
    Events = importlib.import_module('nations.events').Events
    pc = importlib.import_module('nations.progress_cards')
    dc = importlib.import_module('nations.dynasty_cards')
    nc = importlib.import_module('nations.nations')
    Resource = importlib.import_module('nations.resources').Resource
    BuyAction = importlib.import_module('nations.actions').BuyAction
    NoStats = importlib.import_module('nations.stats').NoStats

    def fixture():
        m = Match.__new__(Match)
        m.events = Events(m)
        m.log = lambda *args: None
        m.stats = NoStats()
        m.cards_bought = 0
        m.get_move = lambda player, prompt, options: options[0]
        m.players = [Player(m, 'A'), Player(m, 'B')]
        for p in m.players:
            for slot in ('dynasties', 'advisors', 'buildings_military', 'specials', 'colonies', 'wonders_under_construction', 'wonders', 'extra_cards', 'worker_pools'):
                setattr(p, slot, [])
            p.workers = p.grown_workers = p.extra_worker_pool = p.points = 0
        return m, *m.players

    m, a, b = fixture()
    tax = dc.AxumiteKingdom(m)
    tax.assign_owner(b)
    tax.play()
    card = pc.HimejiCastle(m)
    tax.marked_cards.append(card)
    m.progress_board = [[card]]
    a.wonders_under_construction = [None]
    a.resources[Resource.GOLD] = 3
    galileo = pc.GalileoGalilei(m)
    galileo.assign_owner(a)
    a.advisors = [galileo]
    assert galileo.action_available(a)
    galileo.activate(a)
    assert (a.resources[Resource.GOLD], b.resources[Resource.GOLD]) == (3, 0)
    print('FAIL Axumite/free purchase: buyer retains 3 gold; Axumite owner receives 0 (FAQ expects 0/3).')

    m, a, b = fixture()
    qin, old, new = pc.QinShiHuang(m), pc.SaintAugustine(m), pc.ThomasAquino(m)
    for card in (qin, old, new):
        card.assign_owner(a)
    a.advisors = [old, qin]
    a.resources[Resource.STABILITY] = 1
    qin.placed()
    m.update_most_least_stability_military()
    assert qin in a.advisors
    a.place_card(new)
    assert qin not in a.advisors and a.resources[Resource.STABILITY] == 1
    print('FAIL replacement atomicity: existing Qin removed during 1 -> 0 -> 1 stability replacement.')

    m, a, b = fixture()
    genghis, qin = pc.GenghisKhan(m), pc.QinShiHuang(m)
    genghis.assign_owner(a)
    qin.assign_owner(a)
    a.advisors = [genghis]
    a.resources[Resource.STABILITY] = 2
    a.resources[Resource.MILITARY] = 3
    genghis.buy()
    a.place_card(qin)
    assert a.advisors == [qin]
    assert (a.resources[Resource.STABILITY], b.resources[Resource.STABILITY]) == (2, 0)
    print('PASS incoming Qin: replacing Genghis restores stability before Qin registers its condition.')

    m, a, b = fixture()
    card = pc.Versailles(m)
    card.assign_owner(a)
    a.wonders = [card]
    card.ready()
    assert any(m.events.happen('force least stability', a))
    a.remove(card)
    assert not any(m.events.happen('force least stability', a))
    print('QUALIFICATION Versailles: forced least stability ends immediately when card is removed.')

    m, a, b = fixture()
    card = dc.Sheba(m)
    card.assign_owner(a)
    a.specials = [card]
    card.play()
    card.remove_upkeep(a)
    assert any(m.events.happen('no military upkeep', a))
    a.remove(card)
    assert not any(m.events.happen('no military upkeep', a))
    print('QUALIFICATION Sheba: no-upkeep effect ends immediately when dynasty is removed.')

    m, a, b = fixture()
    card = pc.CoffeeHouse(m)
    card.assign_owner(a)
    card.deployed_workers = 2
    a.passed_last = True
    a.buildings_military = [card]
    chopin = pc.FredericChopin(m)
    chopin.assign_owner(a)
    a.advisors = [chopin]
    chopin.buy()
    card.gain_books(a)
    assert a.resources[Resource.BOOKS] == 0
    assert a.production()[Resource.BOOKS] == 8
    print('PASS Coffee House: no immediate books; two workers produce 8 books with Chopin.')

    m, a, b = fixture()
    old = pc.Archimedes(m)
    old.assign_owner(a)
    a.advisors = [old]
    m.progress_board = [[pc.Hypatia(m)]]
    a.resources[Resource.STABILITY] = 3
    a.resources[Resource.GOLD] = 1
    a.buy_action(BuyAction(0, 0, m.progress_board[0][0]))
    assert a.advisors == [None]
    print('PASS immediate self-removal: bought Hypatia leaves advisor slot empty.')

    print('Snapshot:', snapshot['commit'])
