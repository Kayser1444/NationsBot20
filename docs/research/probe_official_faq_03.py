"""Narrow component probes using unmodified, hash-verified pinned Tabony source."""
import hashlib,importlib,json,pathlib,sys,tempfile
R=pathlib.Path(__file__).resolve().parents[2]
s=json.loads((R/'data/question/tabony-snapshot.json').read_text(encoding='utf-8'))
(R/'.tmp').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir=R/'.tmp',prefix='official-faq03-') as t:
 p=pathlib.Path(t)/'nations';p.mkdir()
 for n,e in s['files'].items():
  raw=e['text'].encode();assert hashlib.sha256(raw).hexdigest()==e['sha256'];(p/n).write_bytes(raw)
 sys.path.insert(0,t)
 M=importlib.import_module('nations.match').Match; P=importlib.import_module('nations.player').Player;Ev=importlib.import_module('nations.events').Events
 pc=importlib.import_module('nations.progress_cards');dc=importlib.import_module('nations.dynasty_cards');ec=importlib.import_module('nations.event_cards');nc=importlib.import_module('nations.nations');rs=importlib.import_module('nations.resources');Res=rs.Resource
 def fix():
  m=M.__new__(M);m.events=Ev(m);m.log=lambda *a:None;m.get_move=lambda p,q,o:o[0];m.players=[P(m,'A'),P(m,'B')]
  for a in m.players:
   for slot in ('dynasties','advisors','buildings_military','specials','colonies','wonders_under_construction','wonders','extra_cards','worker_pools'):setattr(a,slot,[])
   a.workers=a.grown_workers=5;a.extra_worker_pool=0;a.points=0
  return m,*m.players
 m,a,b=fix();a.resources[Res.MILITARY]=0;a.resources[Res.STABILITY]=0;b.resources[Res.STABILITY]=1
 m.update_most_least_stability_military();event=ec.SinkingOfTheVasaPeaceOfWestphalia(m);event.happen_a();assert a in event.strength_reduced_players
 print('ACCEPTED Vasa: 0gold/0military player assigned temporary reduction, consistent with user-reported designer clarification.')
 # Capture military value at the actual Peace comparison; resource losses use tiny recording fixtures.
 for initial,expected in ((5,-5),(10,0)):
  m,a,b=fix();a.resources[Res.MILITARY]=initial;b.resources[Res.MILITARY]=1;a.resources[Res.STABILITY]=0;b.resources[Res.STABILITY]=1
  m.update_most_least_stability_military();losses=[]
  for player in (a,b):player.lose_resources=lambda r,player=player:losses.append((player.name,str(r)))
  event=ec.SinkingOfTheVasaPeaceOfWestphalia(m);event.happen_a();original=m.most_least_of_resource;captured=[]
  def record(resource):
   if resource is Res.MILITARY:captured.append(a.resources[Res.MILITARY])
   return original(resource)
  m.most_least_of_resource=record;event.happen_b()
  assert captured==[expected] and a.resources[Res.MILITARY]==initial and not any('Gold' in text for _,text in losses)
  print(f'VASA comparison military={captured[0]}, restored={initial}, gold loss skipped; {"accepted below-zero case" if initial<10 else "threshold control"}.')
 m,a,b=fix();a.worker_pools=[nc.WorkerPool(4,rs.Resources({Res.FOOD:-3})),nc.WorkerPool(4,rs.Resources({Res.STABILITY:-3}))];a.least_stability=True;b.least_stability=False
 ec.WeltpolitikEmigration(m).happen_b();assert a.extra_worker_pool==1 and a.grown_workers==4
 a.take_worker();assert a.extra_worker_pool==0 and a.grown_workers==5 and a.resources[Res.STABILITY]==0
 print('SUPPORTED Emigration no population worker taken: creates free extra worker, then takes it before regular tracks, no stability cost.')
 m,a,b=fix();pol=dc.PolishLithuanianCommonwealth(m);pol.assign_owner(a);a.specials=[pol];pol.play();qin=pc.QinShiHuang(m);aug=pc.SaintAugustine(m)
 for c in (qin,aug):c.assign_owner(a)
 a.advisors=[qin];a.wonders=[aug];qin.placed();a.resources[Res.STABILITY]=0;b.resources[Res.STABILITY]=1
 m.update_most_least_stability_military();assert qin not in a.advisor_cards() and aug in a.advisor_cards()
 print('INTERPRETATION Poland: Qin self-removal leaves another advisor. FAQ lose-all might cover this, but conditional-self-removal scope needs clarification.')
