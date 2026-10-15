"""Build an English effect library from pinned AST metadata and separate image reviews.

Never executes game code. Image reviews are explicit editorial input: this script
checks their image hashes but never grants or upgrades review status.
"""
import ast
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'data' / 'cards' / 'library'
FIELDS = {
    'production_per_worker': 'Production/attributes per Worker (timing follows the rules)',
    'production_value': 'Resource/attribute values (timing follows the card rules)',
    'deployment_cost': 'Worker deployment debit in Stone',
    'worker_points': 'VP slots for deployed Workers, left to right',
    'points': 'Card VP', 'stage_costs': 'Wonder construction debits in Stone, in order',
    'military_requirement': 'Minimum Military Strength required', 'raid_value': 'Raid value',
    'golden_age_bonus': 'Golden Age bonus', 'max_workers': 'Worker limit enabled',
    'exploration_turns': 'Natural Wonder exploration actions required',
    'private_architects': 'Private Architects', 'penalty_amount': 'War penalty amount',
    'penalty_resource': 'War penalty resource', 'offers_books': 'Golden Age Books offer',
    'offers_stone': 'Golden Age Stone offer', 'offers_special_action': 'Special action offered',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8', newline='\n')


def main():
    snapshot = json.loads((ROOT / 'data/question/tabony-snapshot.json').read_text(encoding='utf8'))
    catalog = json.loads((ROOT / 'data/cards/catalog.json').read_text(encoding='utf8'))
    review_file = OUTPUT / 'image-reviews.json'
    reviews = json.loads(review_file.read_text(encoding='utf8'))
    if reviews['schemaVersion'] != 1 or reviews['language'] != 'en':
        raise ValueError('Unsupported card review format')
    reviewed = {}
    for card in reviews['cards']:
        if card['cardId'] in reviewed: raise ValueError('Duplicate card review')
        image = ROOT / card['sourceImage']['file']
        if sha(image.read_bytes()) != card['sourceImage']['sha256']:
            raise ValueError(f'Image changed; re-review required: {image}')
        if card['review']['status'] != 'image-verified': raise ValueError('Unsupported image review state')
        if not card['effects'] or any(not effect['name'] or not effect['text'] for effect in card['effects']):
            raise ValueError('Empty reviewed card effect')
        reviewed[card['cardId']] = card

    classes, by_id = {}, {}
    for filename in ['cards.py', 'progress_cards.py', 'dynasty_cards.py', 'nations.py', 'event_cards.py']:
        source = snapshot['files'][filename]['text']
        if sha(source.encode()) != snapshot['files'][filename]['sha256']: raise ValueError('Invalid pinned source')
        for node in ast.parse(source).body:
            if not isinstance(node, ast.ClassDef): continue
            attrs = {s.targets[0].id: s.value for s in node.body
                     if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name)}
            info = dict(node=node, attrs=attrs, filename=filename,
                        bases=[base.id for base in node.bases if isinstance(base, ast.Name)])
            classes[node.name] = info
            try: ident = ast.literal_eval(attrs.get('abbr'))
            except (ValueError, TypeError): ident = None
            if isinstance(ident, str): by_id[ident.strip()] = info

    def inherited(info, field, visited=None):
        visited = set() if visited is None else visited
        if id(info) in visited: return None
        visited.add(id(info))
        if field in info['attrs']: return info['attrs'][field], info['filename']
        for name in info['bases']:
            if name in classes:
                result = inherited(classes[name], field, visited)
                if result: return result
        return None

    def human_value(node):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'Resources' and node.args and isinstance(node.args[0], ast.Dict):
            values = []
            for key, value in zip(node.args[0].keys, node.args[0].values):
                if not isinstance(key, ast.Attribute) or not isinstance(key.value, ast.Name) or key.value.id != 'Resource': break
                try: amount = ast.literal_eval(value)
                except (ValueError, TypeError): break
                values.append(f'{amount:+} [{key.attr.title()}]')
            else: return ', '.join(values)
        try: return str(ast.literal_eval(node))
        except (ValueError, TypeError): return ast.unparse(node)

    cards = []
    for card in catalog['cards']:
        record = {key: card.get(key) for key in ['id', 'name', 'aliases', 'type', 'age']}
        record['imageReviewStatus'] = 'pending'
        info = by_id.get(card['id'])
        if card['type'] == 'nation': info = next((entry for ident, entry in by_id.items()
            if card['id'] == 'nation-' + ident), None)
        implementation = None
        if info:
            refs = []
            def reference(filename, line):
                ref = dict(file=filename, line=line, fileSha256=snapshot['files'][filename]['sha256'])
                if ref not in refs: refs.append(ref)
            reference(info['filename'], info['node'].lineno)
            description = ast.get_docstring(info['node'])
            facts = []
            for field, label in FIELDS.items():
                result = inherited(info, field)
                if result:
                    node, filename = result
                    reference(filename, node.lineno)
                    facts.append(dict(field=field, label=label, value=human_value(node)))
            effects = []
            if card['type'] == 'event':
                for slot in ['a', 'b']:
                    name_node = info['attrs'].get('name_' + slot)
                    effect_node = info['attrs'].get('effect_' + slot)
                    if name_node is not None and effect_node is not None:
                        effects.append(dict(slot=slot, name=ast.literal_eval(name_node), text=ast.literal_eval(effect_node)))
                        reference(info['filename'], effect_node.lineno)
            implementation = dict(provenance='Tabony implementation description; not image-transcribed card text.',
                                  commit=snapshot['commit'], description=description, facts=facts, effects=effects, sources=refs)
        record['implementation'] = implementation
        record['printed'] = reviewed.get(card['id'])
        if record['printed']: record['imageReviewStatus'] = 'image-verified'
        cards.append(record)
    unknown = set(reviewed) - {card['id'] for card in cards}
    if unknown: raise ValueError(f'Review refers to unknown cards: {unknown}')
    library = dict(schemaVersion=1, language='en', implementationCommit=snapshot['commit'],
                   sourceCatalogSha256=sha((ROOT / 'data/cards/catalog.json').read_bytes()),
                   imageReviewsSha256=sha(review_file.read_bytes()), cards=cards)
    write(OUTPUT / 'entries.json', library)
    lines = ['# English Nations card effect library', '',
             'Printed-card transcriptions and Tabony implementation descriptions are separate evidence.',
             'Symbol labels in square brackets replace printed icons. Image review is not user editorial sign-off.', '',
             f'Cards: {len(cards)}. Image-verified: {len(reviewed)}. Other image transcriptions remain pending.', '']
    for card in cards:
        lines += [f'## {card["name"]} ({card["id"]})', '', f'Type: {card["type"]}. Age: {card["age"]}. Image review: {card["imageReviewStatus"]}.', '']
        printed = card['printed']
        if printed:
            lines += [f'### Printed gameplay text - image-verified', '',
                      f'Architects: {printed["architects"]}. Famine: {printed["famine"]}.', '']
            for effect in printed['effects']:
                lines += [f'#### {effect["name"]}', '', effect['text'], '']
            lines += [f'Source image: `{printed["sourceImage"]["file"]}`; SHA-256 `{printed["sourceImage"]["sha256"]}`.', '']
        impl = card['implementation']
        if impl:
            lines += ['### Tabony implementation description - not verified printed text', '',
                      f'Implementation commit: `{impl["commit"]}`.', '']
            if impl['description']: lines += [impl['description'], '']
            for fact in impl['facts']: lines += [f'- {fact["label"]}: {fact["value"]}']
            for effect in impl['effects']: lines += [f'- {effect["name"]}: {effect["text"]}']
            lines += ['', 'Source: ' + ', '.join(f'`{ref["file"]}:{ref["line"]}`' for ref in impl['sources']), '']
        elif not printed: lines += ['Metadata only. No card effect has been transcribed yet.', '']
    (OUTPUT / 'cards.md').write_text('\n'.join(lines) + '\n', encoding='utf8', newline='\n')
    write(OUTPUT / 'manifest.json', dict(schemaVersion=1, entriesSha256=sha((OUTPUT / 'entries.json').read_bytes()),
          cards=len(cards), imageVerifiedCards=len(reviewed), imageVerifiedEffects=sum(len(c['effects']) for c in reviewed.values()),
          implementationCards=sum(c['implementation'] is not None for c in cards)))
    print(f'{len(cards)} cards; {len(reviewed)} image-verified; English library built without executing game code.')


if __name__ == '__main__': main()
