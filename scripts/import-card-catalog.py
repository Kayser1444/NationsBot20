"""Refresh card metadata from Tabony's Python sources without executing game code.

Preserves FAQ review decisions and image checks. Run verify-card-images.mjs afterwards.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-source', type=Path, required=True)
    args = parser.parse_args()
    path = ROOT / 'data/cards/catalog.json'
    catalog = json.loads(path.read_text(encoding='utf-8'))
    existing = {card['id'].strip(): dict(card, id=card['id'].strip()) for card in catalog['cards']}
    classes = {}
    files = ['progress_cards.py', 'dynasty_cards.py', 'nations.py', 'event_cards.py']
    for filename in files:
        for node in ast.parse((args.game_source / filename).read_text(encoding='utf-8')).body:
            if not isinstance(node, ast.ClassDef):
                continue
            attrs = {}
            for statement in node.body:
                if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
                    try:
                        attrs[statement.targets[0].id] = ast.literal_eval(statement.value)
                    except (ValueError, TypeError):
                        pass
                    if isinstance(statement.value, ast.List) and all(isinstance(value, (ast.Name, ast.Constant)) for value in statement.value.elts):
                        attrs[statement.targets[0].id] = [value.id if isinstance(value, ast.Name) else value.value for value in statement.value.elts]
            classes[node.name] = (attrs, [base.id for base in node.bases if isinstance(base, ast.Name)], filename)

    def ancestors(name):
        return {name} | set().union(*(ancestors(base) for base in classes.get(name, ({}, [], ''))[1]))

    def inherited(name, key):
        attrs, bases, _ = classes.get(name, ({}, [], ''))
        if key in attrs:
            return attrs[key]
        return next((value for base in bases for value in [inherited(base, key)] if value is not None), None)

    types = {'Building': 'building', 'Military': 'military', 'Colony': 'colony', 'War': 'war',
             'Battle': 'battle', 'Wonder': 'wonder', 'Advisor': 'advisor', 'GoldenAge': 'golden_age',
             'NaturalWonder': 'natural_wonder', 'DynastyCard': 'dynasty', 'EventCard': 'event', 'ExtensionCard': 'extension'}
    nations = {attrs['abbr']: attrs['name'] for name, (attrs, _, _) in classes.items()
               if 'Nation' in ancestors(name) and isinstance(attrs.get('abbr'), str) and isinstance(attrs.get('name'), str)}
    for name, (attrs, _, filename) in classes.items():
        if 'Nation' not in ancestors(name) or not isinstance(attrs.get('abbr'), str) or not isinstance(attrs.get('name'), str):
            continue
        ident = 'nation-' + attrs['name']
        nation = existing.setdefault(ident, dict(id=ident, aliases=[], faqReviewStatus='pending'))
        nation.update(name=attrs['name'], type='nation', age=None, boardSide='B',
                      imageUrl=f"https://games.tabony.net/static/public/Nations/nations/{attrs['name']}.jpg", metadataSource=filename)
        for key, prefix in [('advisors', 'A'), ('buildings_military', 'BM'), ('colonies', 'C'), ('wonders', 'W')]:
            for index, cls in enumerate(attrs.get(key, []), 1):
                if cls in classes and 'StartingCard' in ancestors(cls):
                    abbr = classes[cls][0].get('abbr', '').strip()
                    card = existing.setdefault(abbr, dict(id=abbr, aliases=[], faqReviewStatus='pending'))
                    card['boardSource'] = dict(nation=attrs['name'], slot=f'{prefix}{index}', url=nation['imageUrl'])
    for name, (attrs, _, filename) in classes.items():
        bases = ancestors(name)
        kind = next((value for base, value in types.items() if base in bases), None)
        ident = attrs.get('abbr')
        title = attrs.get('name')
        aliases = []
        if kind == 'event' and attrs.get('name_a') and attrs.get('name_b'):
            aliases = [attrs['name_a'], attrs['name_b']]
            title = '; '.join(aliases)
        if not kind or not isinstance(ident, str) or not isinstance(title, str):
            continue
        ident = ident.strip()
        card = existing.setdefault(ident, dict(id=ident, aliases=[], faqReviewStatus='pending'))
        card.update(name=title, type=kind, age=inherited(name, 'age'), metadataSource=filename)
        if not card.get('imageAsset'):
            card['imageUrl'] = f'https://games.tabony.net/static/public/Nations/cards/{ident}.jpg'
        if 'StartingCard' in bases:
            card['variant'] = nations.get(ident.split('_')[0], ident.split('_')[0])
            aliases.append(f"{card['variant']} {title}")
        card['aliases'] = list(dict.fromkeys(card['aliases'] + aliases))
    catalog['metadataSources'] = [dict(file=filename, sha256=hashlib.sha256((args.game_source / filename).read_bytes()).hexdigest()) for filename in files]
    catalog['cards'] = sorted(existing.values(), key=lambda card: (card['name'], card['id']))
    path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"Imported {len(catalog['cards'])} cards; FAQ reviews preserved.")


if __name__ == '__main__':
    main()
