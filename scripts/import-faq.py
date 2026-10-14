"""Import the supplied FAQ by column; do not execute the game's Python code.

Run with the bundled Python and --game-source pointing at the local nations repo.
Unreviewed rules and automatically found card links remain pending.
"""
import argparse
import ast
import hashlib
import json
import re
import unicodedata
import sys
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ID = 'nations-faq-official'
PENDING = dict(status='pending', reviewer=None, reviewedAt=None, notes='Automatically imported; review required.')
AGES = {'Start': 0, 'Antiquity': 1, 'Medieval': 2, 'Renaissance': 3, 'Industrial': 4}
MARKERS = '+⨯●ⅅ'


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def fold(text):
    return re.sub(r'[^a-z0-9]+', '', unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode().lower())


def slug(text):
    return re.sub(r'[^a-z0-9]+', '-', unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode().lower()).strip('-')


def catalog(game):
    classes = {}
    for filename in ['progress_cards.py', 'dynasty_cards.py']:
        path = game / filename
        for node in ast.parse(path.read_text(encoding='utf-8')).body:
            if not isinstance(node, ast.ClassDef):
                continue
            attrs = {}
            for statement in node.body:
                if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
                    try:
                        attrs[statement.targets[0].id] = ast.literal_eval(statement.value)
                    except (ValueError, TypeError):
                        pass
            classes[node.name] = dict(attrs=attrs, bases=[base.id for base in node.bases if isinstance(base, ast.Name)], filename=filename)

    def get(name, key, seen=None):
        seen = (seen or set()) | {name}
        record = classes.get(name, {})
        if key in record.get('attrs', {}):
            return record['attrs'][key]
        return next((value for base in record.get('bases', []) if base not in seen
                     for value in [get(base, key, seen)] if value is not None), None)

    def ancestors(name):
        return {name} | set().union(*(ancestors(base) for base in classes.get(name, {}).get('bases', []) if base != name))

    types = {'Building': 'building', 'Military': 'military', 'Colony': 'colony', 'War': 'war', 'Battle': 'battle',
             'Wonder': 'wonder', 'Advisor': 'advisor', 'GoldenAge': 'golden_age', 'NaturalWonder': 'natural_wonder', 'DynastyCard': 'dynasty'}
    cards = []
    for cls, record in classes.items():
        name, abbr = record['attrs'].get('name'), record['attrs'].get('abbr')
        if not isinstance(name, str) or not isinstance(abbr, str):
            continue
        kind = next((value for base, value in types.items() if base in ancestors(cls)), None)
        if kind is None:
            continue
        cards.append(dict(id=abbr, name=name, aliases=[], type=kind, age=get(cls, 'age'),
                          imageUrl=f'https://games.tabony.net/static/public/Nations/cards/{abbr}.jpg',
                          faqReviewStatus='pending', metadataSource=record['filename']))
    aliases = {'Qin Shi Huang': ['Qin Shi Huangdi'], 'Saint Augustine': ['St Augustine'], 'Hindu Kush': ['Hindukush'],
               'Thomas Aquino': ['Thomas Aquinas'], 'Nikola Tesla': ['Tesla'], 'Cho-Ko-Nu': ['Cho Ko Nu'],
               'Jagellonian Dynasty': ['Jagiellonian Dynasty'], 'Portugese Empire': ['Portuguese Empire']}
    for card in cards:
        card['aliases'] = aliases.get(card['name'], [])
    return sorted(cards, key=lambda card: card['name'])


def extract(pdf_path):
    blocks, context = [], []
    active = None
    section, age, group = 'Introduction', None, None
    lines_total = 0
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) != 10 or 'version 1.11, 5 dec 2017' not in pdf.pages[0].extract_text():
            raise ValueError('This importer is calibrated to the supplied FAQ++ 1.11 (10 pages).')
        for page_number, page in enumerate(pdf.pages, 1):
            page = page.dedupe_chars()
            for column, (left, right) in enumerate([(35, 210), (210, 382), (382, 570)], 1):
                # Assign complete glyphs by their origin. Cropping clips final letters.
                col = page.filter(lambda obj: obj['object_type'] == 'char' and left <= obj['x0'] < right and 40 < obj['top'] < 782)
                for line in col.extract_text_lines(x_tolerance=2, y_tolerance=3):
                    text, chars = line['text'], line['chars']
                    lines_total += 1
                    size = max(char['size'] for char in chars)
                    leading = []
                    for char in chars:
                        if 'Bold' in char['fontname'] or char['text'].isspace() or char['text'] in MARKERS:
                            leading.append(char)
                        else:
                            break
                    prefix = pdfplumber.utils.extract_text(leading).strip(' ' + MARKERS + ':–-') if leading else ''
                    heading = None
                    if text in AGES and section not in ['General', 'FAQ']:
                        age = AGES[text]
                        active = None
                        context.append(dict(page=page_number, column=column, text=text, kind='age'))
                        continue
                    if size >= 17:
                        section, age, group = text, None, None
                        heading = text
                    elif size >= 12:
                        group = text
                        heading = text if section != 'FAQ' else None
                        if section == 'FAQ':
                            active = None
                            context.append(dict(page=page_number, column=column, text=text, kind='faq_group'))
                            continue
                    elif section == 'FAQ' and text.startswith('Q:'):
                        heading = text
                    elif section not in ['Introduction', 'Nations FAQ++', 'General', 'FAQ'] and prefix:
                        # Indented nation labels and wrapped dynasty names are continuations.
                        if chars[0]['x0'] < left + 9 and not prefix.startswith('A:'):
                            heading = prefix
                    if heading and section == 'Dynasties' and ':' not in heading and active and ':' in active['heading'] and not active['body']:
                        active['heading'] += ' ' + heading
                        active['lines'].append(text)
                        body = re.split(r'\s+[–-]\s*', text, maxsplit=1)
                        if len(body) > 1:
                            active['body'].append(body[1])
                        continue
                    if heading:
                        active = dict(heading=heading, section=section, age=age, group=group,
                                      pages=[page_number], lines=[text], body=[], position=[page_number, column, round(chars[0]['top'], 2)])
                        blocks.append(active)
                        # Card heading and body can share the same line.
                        if size < 12 and section != 'FAQ':
                            # Prefix is a formatted name, not necessarily the whole physical line.
                            body = re.split(r'\s+[–-]\s*|\s*:\s*(?=[A-Z])', text, maxsplit=1)
                            if section == 'Dynasties':
                                body = re.split(r'\s+[–-]\s*', text, maxsplit=1)
                            if len(body) > 1:
                                active['body'].append(body[1])
                    elif active:
                        active['lines'].append(text)
                        active['body'].append(text)
                        if page_number not in active['pages']:
                            active['pages'].append(page_number)
                    else:
                        context.append(dict(page=page_number, column=column, text=text, kind='context'))
        return blocks, context, lines_total, len(pdf.pages)


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('--game-source', type=Path, required=True)
    args = parser.parse_args()
    pdf_path = ROOT / 'Reference/faq++1.11.pdf'
    cards = catalog(args.game_source)
    blocks, context, total_lines, page_count = extract(pdf_path)
    # Merge wrapped bold names that did not introduce a new entry.
    entries, index, used = [], [], set()
    for block in blocks:
        heading = block['heading']
        if block['section'] == 'FAQ' and heading.startswith('Q:'):
            heading = ' '.join(' '.join(block['lines']).split('A:', 1)[0].split())
        raw = ' '.join(block['lines'])
        body = ' '.join(block['body']).strip()
        ident = slug(block['section'] + '-' + heading)
        if ident in used:
            ident += '-' + str(block['pages'][0])
        used.add(ident)
        kind = 'other' if block['section'] == 'Nations FAQ++' else 'general' if block['section'] in ['General', 'FAQ'] else 'nation' if block['section'] == 'Nations' else 'dynasty' if block['section'] == 'Dynasties' else 'card_type' if heading == block['section'] or block['section'] == 'Golden Age' and heading == 'Bonus' else 'card'
        row = dict(id=ident, heading=heading, section=block['section'], age=block['age'], sourcePages=block['pages'], position=block['position'], hasRule=bool(body), cardId=None)
        lookup = heading.split(':', 1)[-1].strip() if kind == 'dynasty' else heading
        matches = [card for card in cards if fold(lookup) in [fold(card['name']), *map(fold, card['aliases'])]]
        if len(matches) == 1:
            row['cardId'] = matches[0]['id']
        index.append(row)
        if not body:
            continue
        links = []
        for card in cards:
            own = row['cardId'] == card['id']
            names = [card['name'], *card['aliases']]
            cross = any(re.search(r'(?<![a-z0-9])' + re.escape(name.lower()) + r'(?![a-z0-9])', body.lower()) for name in names)
            if own or cross:
                links.append(dict(cardId=card['id'], relation='own_entry' if own else 'cross_reference', review=dict(PENDING)))
        entries.append(dict(id=ident, sourceId=SOURCE_ID, sourcePages=block['pages'], heading=heading,
                            category=kind, sourceText=raw, review=dict(PENDING),
                            bullets=[dict(id=ident + '-en', language='en-US', kind='quotation', text=body, review=dict(PENDING))],
                            cardLinks=links, relatedEntryIds=[]))
    # Preserve named rule references rather than duplicating their text into cards.
    for entry in entries:
        for key, ident in [('Most and least', 'general-most-and-least'), ('Golden Age/Bonus', 'golden-age-bonus')]:
            if key in entry['sourceText'] and entry['id'] != ident:
                entry['relatedEntryIds'].append(ident)
    metadata_sources = [dict(file=name, sha256=hashlib.sha256((args.game_source / name).read_bytes()).hexdigest()) for name in ['progress_cards.py', 'dynasty_cards.py']]
    write(ROOT / 'data/cards/catalog.json', dict(schemaVersion=1, metadataProvenance='Local Tabony game implementation, read with AST; not publisher rule text.', metadataSources=metadata_sources, cards=cards))
    write(ROOT / 'data/faq/entries.json', dict(schemaVersion=1, entries=entries))
    write(ROOT / 'data/faq/index.json', dict(schemaVersion=1, items=index))
    write(ROOT / 'data/faq/document.json', dict(schemaVersion=1, context=context, blocks=blocks, extractedLines=total_lines))
    write(ROOT / 'data/faq/sources.json', dict(schemaVersion=1, sources=[dict(id=SOURCE_ID, title='Nations FAQ++', officialUrl='https://boardgamegeek.com/filepage/96855/faq-official',
        version='1.11', documentDate='2017-12-05', sha256=hashlib.sha256(pdf_path.read_bytes()).hexdigest(), pageCount=page_count,
        localFile='Reference/faq++1.11.pdf', provenance='User-supplied PDF; identity checked against all page footers.', status='imported',
        extractionComplete=True, reviewComplete=False, extractionMethod='pdfplumber: complete glyphs assigned by x origin to three columns, deduplicated, headers preserved; ligature defects remain in raw text.')]))
    print(f'Imported {len(entries)} rule entries, {len(index)} index headings, {len(cards)} card records, {total_lines} text lines.')
    for entry in entries:
        if 'Porcelain' in entry['sourceText']:
            print(entry['id'], entry['sourcePages'], entry['heading'], '\n', entry['sourceText'])


if __name__ == '__main__':
    main()
