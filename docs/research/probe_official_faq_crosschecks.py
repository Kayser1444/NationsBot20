"""Offline component cross-checks using the hash-verified audited source.

Success means the stated observations reproduced, including the known conflict.
These fixtures exercise real methods, not complete legal match replays.
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
with tempfile.TemporaryDirectory(prefix='official-crosschecks-', dir=ROOT / '.tmp') as tmp:
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
    R = importlib.import_module('nations.resources').Resource
    Resources = importlib.import_module('nations.resources').Resources
    BuyAction = importlib.import_module('nations.actions').BuyAction
    NoStats = importlib.import_module('nations.stats').NoStats

    def fixture():
        m = Match.__new__(Match)
        m.events, m.stats, m.cards_bought = Events(m), NoStats(), 0
        m.log = lambda *args: None
        m.get_move = lambda player, prompt, options: options[0]
        m.players = [Player(m, 'A'), Player(m, 'B')]
        for p in m.players:
            for slot in ('dynasties', 'advisors', 'buildings_military', 'specials', 'colonies', 'wonders_under_construction', 'wonders', 'extra_cards', 'worker_pools'):
                setattr(p, slot, [])
            p.workers = p.grown_workers = p.extra_worker_pool = p.points = 0
        return m, *m.players

    for free, starting_gold, expected in ((True, 3, (3, 0, 0, 0)), (False, 4, (0, 3, 2, 1))):
        m, a, b = fixture()
        tax, wonder = dc.AxumiteKingdom(m), pc.HimejiCastle(m)
        tax.assign_owner(b)
        tax.play()
        tax.marked_cards.append(wonder)
        m.progress_board = [[wonder]]
        a.wonders_under_construction = [None]
        a.resources[R.GOLD] = starting_gold
        mansa, galileo = pc.MansaMusa(m), pc.GalileoGalilei(m)
        for card in (mansa, galileo):
            card.assign_owner(a)
        a.advisors = [mansa, galileo]
        mansa.placed()
        if free:
            galileo.activate(a)
        else:
            a.buy_action(BuyAction(0, 0, wonder))
        observed = (a.resources[R.GOLD], b.resources[R.GOLD], a.resources[R.BOOKS], a.resources[R.FOOD])
        assert observed == expected, observed
        assert wonder not in tax.marked_cards
        print(('CONFLICT Galileo' if free else 'SUPPORTED ordinary purchase') + ': buyer gold, Axumite gold, Mansa books/food = ' + str(observed))

    m, a, b = fixture()
    qin, library, temple = pc.QinShiHuang(m), pc.GreatLibrary(m), pc.Ziggurat(m)
    for card in (qin, library, temple):
        card.assign_owner(a)
    a.advisors, a.wonders, a.buildings_military = [qin], [library], [temple]
    qin.placed()
    library.placed()
    temple.deployed_workers = 1
    pool = nc.WorkerPool(4, Resources({R.STABILITY: -3}))
    pool.grow_worker()
    a.worker_pools = [pool]
    a.grown_workers = 6
    a.resources[R.STABILITY], b.resources[R.STABILITY] = 5, 4
    checks = []
    update = m.update_most_least_stability_military
    def observed_update():
        checks.append(a.resources[R.STABILITY])
        update()
    m.update_most_least_stability_military = observed_update
    a.return_worker()
    assert checks == [6], checks
    assert qin in a.advisors and library in a.wonders
    print('SUPPORTED worker return: only final stability 6 checked; Qin and Great Library retained.')

    print('Snapshot:', snapshot['commit'])
