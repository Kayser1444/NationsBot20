"""Focused component checks for official FAQ indices 0-64; pinned snapshot only."""
import importlib,json,tempfile,sys,hashlib
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2]
s=json.loads((ROOT/'data/question/tabony-snapshot.json').read_text(encoding='utf-8'))
(ROOT/'.tmp').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='official-faq-',dir=ROOT/'.tmp') as tmp:
 p=Path(tmp)/'nations';p.mkdir()
 for n,e in s['files'].items():
  assert hashlib.sha256(e['text'].encode()).hexdigest()==e['sha256']
  (p/n).write_text(e['text'],encoding='utf-8')
 sys.path.insert(0,tmp)
 Match=importlib.import_module('nations.match').Match
 Player=importlib.import_module('nations.player').Player
 Events=importlib.import_module('nations.events').Events
 pc=importlib.import_module('nations.progress_cards')
 R=importlib.import_module('nations.resources').Resource
 Resources=importlib.import_module('nations.resources').Resources
 def fixture(n=2):
  m=Match.__new__(Match);m.events=Events(m);m.log=lambda *a:None;m.get_move=lambda p,q,o:o[0]
  m.players=[Player(m,chr(65+i)) for i in range(n)]
  for a in m.players:
   for slot in ('dynasties','advisors','buildings_military','specials','colonies','wonders_under_construction','wonders','extra_cards','worker_pools'):setattr(a,slot,[])
   a.workers=a.grown_workers=a.extra_worker_pool=0;a.points=10
  return m,m.players[0]
 m,a=fixture(5)
 for amounts,most,least in [([9,8,8,3,2],[0],[3,4]),([9,9,8,2,2],[0,1],[3,4]),([9,9,9,3,2],[],[3,4]),([9,8,3,3,2],[0,1],[2,3,4]),([2,2,2,2,2],[],[0,1,2,3,4])]:
  got=m.most_least({p.name:v for p,v in zip(m.players,amounts)})
  assert set(got[0])=={m.players[i] for i in most} and set(got[1])=={m.players[i] for i in least}
 print('PASS official 5-player most/least: five tie configurations')
 m,a=fixture();a.resources[R.FOOD]=2;a.resources[R.BOOKS]=3;a.resource_deficit_points=Resources()
 a.lose_resources(Resources({R.FOOD:-3}));a.resources[R.STONE]=6
 a.lose_point();a.lose_resources(Resources({R.FOOD:-3}));a.lose_resources(Resources({R.FOOD:-2}))
 assert (a.points,a.resources[R.FOOD],a.resources[R.BOOKS],a.resources[R.STONE])==(7,0,0,3)
 print('PASS official resource-loss worked example: 3 VP lost, 3 stone remain')
 m,a=fixture();sun=pc.SunTzu(m);sun.assign_owner(a);a.advisors=[sun];sun.buy();a.turn_number=0;a.need_confirmation=False
 calls=[]
 def action():
  calls.append(1)
  if len(calls)==1:a.remove(sun)
  a.remaining_main_actions-=1
 a.take_one_action=action;a.take_turn();assert len(calls)==2
 print('PASS Sun Tzu: replacing/removing on first action preserves second action')
 m,a=fixture();fl=pc.FlorenceNightingale(m);fl.assign_owner(a);a.advisors=[fl];fl.buy();a.resource_deficit_points=Resources();a.resources[R.BOOKS]=1;a.resources[R.STONE]=3
 a.lose_resources(Resources({R.FOOD:-3}));assert (a.points,a.resources[R.BOOKS],a.resources[R.STONE])==(10,0,1)
 print('PASS Florence Nightingale: books/other resource substitution retained without deficit VP loss')
 m,a=fixture();m.round_number=7;m.weighted_card_draw=False;m.progress_cards={4:[]}
 assert m.draw_cards(20)==[]
 print('OBSERVATION empty draw pile returns no cards; draw_cards has no discard reshuffle')
 assert not any(c.name=='Nikola Tesla' for c in pc.all_progress_cards)
 print('OBSERVATION Nikola Tesla absent from implemented card registry')
