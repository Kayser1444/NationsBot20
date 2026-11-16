"""Export public slot counts and worker scoring rules from the local engine."""
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT.parent/'nations-server/Nations'))
from nations import Match

match=Match(player_names=['A','B'],seed='01')
all_cards=[card for deck in match.initial_progress_card_order.values() for card in deck]
nations={}
for nation in match.initial_nation_order:
    all_cards.extend(card for card in nation.all_slots() if card is not None)
    nations[nation.name]={name:len(getattr(nation,name)) for name in ['buildings_military','advisors','colonies','wonders']}
worker_rules={card.abbr:{'workerPoints':list(card.worker_points),'maxWorkers':bool(card.max_workers)}
              for card in all_cards if card.is_building_military()}
result={'source':'Tabony public engine rules: building/military worker_points, max_workers, nation slot counts',
        'cards':dict(sorted(worker_rules.items())),'nations':dict(sorted(nations.items()))}
(ROOT/'live-player/predictor-rules.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(f'Exported {len(worker_rules)} worker cards and {len(nations)} nation boards.')
specials={nation.name:[{'id':card.abbr,'name':card.name,'resources':card.production_value.state(),
    'description':card.__doc__ or '', 'privateArchitects':card.private_architects}
    for card in nation.specials if card is not None] for nation in match.initial_nation_order}
(ROOT/'live-player/default-specials.json').write_text(json.dumps(specials,indent=2)+'\n',encoding='utf-8',newline='\n')
