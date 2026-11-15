"""Prefetch native Nations artwork for offline local evaluation."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import re
import sys

from native_nations import cached_asset, CACHE, TEMPLATE

ROOT=Path(__file__).resolve().parents[1]


def asset_paths(engine):
    sys.path.insert(0,str(engine.resolve()))
    from nations.abbr import abbrs
    from nations.nations import all_nations
    paths={ '/static/'+name for name in re.findall(r"\{% static '([^']+)' %\}",TEMPLATE.read_text(encoding='utf-8')) if name.endswith(('.png','.jpg')) }
    prefixes=tuple(nation.abbr+'_' for nation in all_nations)
    dynasties={dynasty.abbr for nation in all_nations for dynasty in nation.dynasties}
    paths.update('/static/public/Nations/cards/'+abbr+'.jpg' for abbr in abbrs if not abbr.startswith(prefixes) or abbr in dynasties)
    paths.update('/static/public/Nations/nations/'+nation.name+'.jpg' for nation in all_nations)
    for filename in ('progress_cards.py','nations.py'):
        source=(engine/'nations'/filename).read_text(encoding='utf-8')
        module=__import__('nations.'+filename[:-3],fromlist=['_'])
        for block in re.split(r'(?=^class )',source,flags=re.M):
            if 'self.global_effect = True' not in block: continue
            match=re.match(r'class (\w+)',block)
            card=getattr(module,match[1],None) if match else None
            abbr=getattr(card,'abbr',None)
            if abbr: paths.add('/static/public/Nations/global/'+abbr+'_GE.jpg')
    paths.add('/native-assets/bootstrap.min.css')
    return sorted(paths)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine',type=Path,default=ROOT.parent/'nations-server/Nations')
    parser.add_argument('--workers',type=int,default=6)
    args=parser.parse_args()
    if not 1<=args.workers<=8: parser.error('Choose between one and eight download workers.')
    paths=asset_paths(args.engine)
    completed=[];failed=[]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs={pool.submit(cached_asset,path):path for path in paths}
        for index,job in enumerate(as_completed(jobs),1):
            path=jobs[job]
            try:
                content,_=job.result()
                completed.append({'path':path,'bytes':len(content)})
            except Exception as error:
                failed.append({'path':path,'error':str(error)})
            if index%50==0 or index==len(paths): print(f'{index}/{len(paths)} assets checked; {len(failed)} unavailable.',flush=True)
    CACHE.mkdir(parents=True,exist_ok=True)
    (CACHE/'manifest.json').write_text(json.dumps({'assets':completed,'unavailable':failed},indent=2)+'\n',encoding='utf-8')
    print(f'Cached {len(completed)} native assets ({sum(row["bytes"] for row in completed)/1024/1024:.1f} MB).',flush=True)
    if failed:
        print('Unavailable optional images are listed in .data/nations-native-assets/manifest.json.',flush=True)


if __name__=='__main__': main()
