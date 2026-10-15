"""Extract the supplied English rulebooks into page-addressable Markdown.

Requires pdfplumber. Never executes game code. PDF pages are reference inputs;
no PDF is authored. The Markdown retains original English rules, not summaries.
"""
import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parents[1]
BOOKS = [
    ('base', 'Nations - base game rulebook', 'Nations_rulebook_ENG_2014-03-17_small.pdf', '2014-03-17', 24),
    ('dynasties', 'Nations: Dynasties - expansion rulebook', 'Nations_Dynasties_Manual_ENG_2015-08-24_web.pdf', '2015-08-24', 4),
]
FIX_WORDS = ['difficulty', 'difficulties', 'difficult', 'refill', 'affect', 'affected', 'affects', 'benefit', 'buffer',
             'defined', 'difference', 'differences', 'different', 'effect', 'effectively', 'effects', 'fiercer',
             'fifth', 'fight', 'fighting', 'figure', 'fill', 'filled', 'final', 'find', 'finished', 'first', 'fit',
             'flipped', 'flips', 'fulfill', 'fulfilled', 'fulfillment', 'influence', 'significant', 'significantly',
             'specific', 'specifically', 'suffer', 'unaffected', 'unfinished']
NOTES = {
    'base': {
        1: 'Cover artwork and Nations logo are not rule text.',
        3: 'Component illustrations and tiny card/board text are not transcribed. Quantities are shown beside the component names; token denominations are not rules for starting resources.',
        4: 'Setup illustration spans PDF pages 4-5. Board pictures show an example arrangement, not additional actions or extra starting resources.',
        5: 'Continuation of the setup illustration on PDF page 4. Rotated board lettering and tiny card text are excluded.',
        6: 'Board diagram labels (Architect, War, Revolt, Player order, round/age track and difficulty levels) are graphical context. Follow the numbered setup instructions below.',
        7: 'Board diagram: the Advisor space holds one Advisor; two Colony spaces hold Colonies; five spaces hold Buildings or Military; one space holds a Wonder under construction; five spaces hold ready Wonders. The printed Player Board and card effects can change these capacities. Follow the surrounding text for setup and replacement rules.',
        8: 'Resource symbols are Gold, Food, Stone and Books. Red resource circles mean gain; black circles mean consumption/upkeep. Stability and Military Strength use squares; a Worker uses a person silhouette. The adjacent prose explains the rules.',
        9: 'Card diagrams label title, set icon, age, effect/special abilities, Worker deployment cost and effect per Worker, raid value (Military), minimum Military Strength (Colony), Architect slots and construction cost (Wonder), and VP. The Event card diagram labels Architects, Famine, Event 1 and Event 2. Miniature card values are examples, not general rules.',
        10: 'Illustrated Worker example: placing a Worker on a Building/Military is deploying; taking one off is undeploying; moving a Worker from the Population Track into the population is taking; putting one back on the Population Track is returning. Do not treat those pairs of terms as interchangeable.',
        11: 'Set symbols: base has no symbol, advanced uses a plus (+), expert uses an x. The pictured card values are illustrations.',
        12: 'The summary uses symbols for Worker, Gold, Food, Stone and Books. Bracketed labels below transcribe these symbols; the following pages explain each phase in detail.',
        13: 'The population-track example uses the current Difficulty Level to set Food/Stone gain. On the Scoring Board, the Architect icons specify the round supply according to player count; the prose explains that Event-card Architects are added to that supply.',
        14: 'The board illustration shows placing/replacing purchased cards. Miniature labels and statistics are omitted; the prose contains the placement and replacement rules.',
        15: 'The food/stone/military icons in example cards stand for the resources and attributes named in the example prose. VP symbols under Buildings/Military are counted once per deployed Worker, subject to the number of printed VP symbols.',
        16: 'Golden Age symbols represent the displayed resource amount, or the displayed VP purchase and Food/Stone cost. Golden Age bonuses are added to both alternatives as described in the prose. Printed miniature card statistics are not a separate rule.',
        17: 'A Wonder construction section has an Architect slot and its own Stone cost. Use the displayed section costs; there is no single universal cost per Architect.',
        18: 'Example production equation shown in the figure: 6 - 3 + 3 + 3 + 3 = 12. The explanation and card effects determine which resource is being produced; use actual owned cards rather than this pictured example as a rule.',
        19: 'End-of-age Books example: Blue has 13, Yellow 11, Green 11, Red 4. Blue gains 3 VP, Yellow and Green gain 1 VP each, Red gains 0 VP. The prose explains War, Events and Famine separately.',
        20: 'Final scoring resource category includes remaining Gold, Food, Stone, Books, Military Strength and Stability; sum them, divide by 10 and round down for VP. Example: 3 Stone + 7 Gold + 5 Food + 6 Books + 10 Strength + 6 Stability = 37, giving 3 VP. The score-pad picture is an example tally.',
        22: 'Solo Event-tile diagram labels Military Strength, Stability, Architects and Famine. The die has six outcomes listed in the prose; the tiny/hidden tile artwork is not transcribed as extra rules.',
        24: 'The summary repeats the detailed rules. The final Resources category includes Military Strength and Stability as well as Gold, Food, Stone and Books. See page 20 for the full scoring rule.',
    },
    'dynasties': {
        1: 'Cover logo and miniature example card/board text are omitted. Component list: 6 two-sided Player Boards, 34 Dynasty cards, 6 Turmoil cards, 43 Progress cards, 1 Rulebook. The two new Progress-card effects are: some Buildings include the text Max [Worker], meaning the maximum number of Workers deployable on that card; some tokens are used, or any other tokens if these run out.',
        2: 'Natural Wonder exploration uses one Architect from the supply per exploration action, not an Architect available this round. The brown Architect icons missing from the text layer are written as [Architect] below. Great Barrier Reef is an example card, not an exception to the permanence rule.',
        4: 'Summary resource icons denote Gold, Food, Stone and Books. The book icon means end-of-age scoring of Books, which awards VP as described in the base rules. The final box credits the artwork/background textures; it does not list additional abilities.',
    },
}


def normalize(text):
    text = text.replace('\ufb01', 'fi').replace('\ufb02', 'fl').replace('\u00ad', '')
    text = text.replace('–', '-').replace('—', '-').replace('‑', '-').replace('−', '-')
    for word in sorted(FIX_WORDS, key=len, reverse=True):
        for ligature in ['ffi', 'ffl', 'fi', 'fl', 'ff']:
            index = word.find(ligature)
            if index >= 0:
                broken = word[:index + len(ligature)] + ' ' + word[index + len(ligature):]
                if broken != word and not broken.endswith(' '):
                    text = re.sub(r'\b' + re.escape(broken) + r'\b', lambda m: word.capitalize() if m[0][0].isupper() else word, text, flags=re.I)
    return text.strip()


def regions(book, page, width, height):
    """Explicit reading order from rendered page layouts; no automatic column guesses."""
    bottom = 808 if book == 'base' else height
    split = 298 if book == 'base' else 254
    def columns(top, end, cut=split):
        return [(0, top, cut, end), (cut, top, width, end)]
    if book == 'dynasties':
        if page == 1:
            return [(0, 0, width, 352), (0, 352, 200, 600)] + columns(600, bottom)
        if page == 2:
            return columns(0, 280) + columns(280, 530) + columns(530, bottom)
        if page == 3:
            return columns(0, 415) + columns(415, bottom)
        return columns(0, 340) + columns(340, 600, 200) + columns(600, bottom)
    if page in [1, 3, 5]:
        return [(0, 0, width, bottom)]
    if page == 4:
        return [(0, 0, width, 100)] + columns(100, 300, 240) + columns(300, 500, 450) + [(0, 500, width, bottom)]
    if page == 6:
        return [(0, 0, width, 100), (0, 100, 200, 590), (200, 100, 420, 590),
                (420, 100, width, 615), (0, 590, 280, bottom), (280, 590, 420, bottom), (420, 615, width, bottom)]
    if page == 7:
        return [(0, 0, width, 105), (0, 105, 210, 220), (210, 105, 390, 220), (390, 105, width, 220),
                (0, 220, 220, 620), (220, 220, 365, 620), (365, 220, width, 620),
                (0, 620, width, 650)] + columns(650, bottom, 240)
    if page == 8:
        return columns(0, bottom)
    if page == 11:
        return columns(0, 395) + [(0, 395, width, bottom)]
    if page == 12:
        return [(0, 0, width, 145)] + columns(145, 405, 290) + columns(405, bottom)
    if page in [21, 22, 23]:
        return [(0, 0, width, 95)] + columns(95, 700 if page == 23 else bottom) + ([(0, 700, width, bottom)] if page == 23 else [])
    return columns(0, bottom)


def prose(lines):
    """Keep paragraph breaks/heading structure, rejoin typeset line wrapping."""
    result, paragraph = [], []
    last_bottom = None
    def flush():
        if paragraph:
            text = ' '.join(paragraph)
            # Rejoin words broken across typeset lines, preserving common compound prefixes.
            text = re.sub(r'\b([A-Za-z]+)- ([a-z]+)', lambda m: m[1] + ('-' if m[1].lower() in {'pre', 'long', 'single', 'two', 'three', 'four', 'five', '1', '2', '3', '4', '5'} else '') + m[2], text)
            result.append(normalize(text)); paragraph.clear()
    for line in lines:
        text = normalize(line['text'])
        if not text:
            continue
        chars = line['chars']
        size = max(c['size'] for c in chars)
        heading = len(text) > 1 and (size >= 20 or (size >= 10.5 and all('Bold' in c['fontname'] or c['text'].isspace() for c in chars)))
        bullet = text.startswith(('»', '•'))
        gap = last_bottom is not None and line['top'] - last_bottom > 5
        if heading:
            flush(); result.append('### ' + text)
        else:
            if gap or bullet: flush()
            if bullet: text = '- ' + text.lstrip('»• ')
            if paragraph and len(paragraph) == 1 and paragraph[0] in ['F', 'N']:
                paragraph[0] += text
            else: paragraph.append(text)
        last_bottom = line['bottom']
    flush()
    return '\n\n'.join(result)


def extract(book, filename, out):
    pages, audit = [], []
    with pdfplumber.open(ROOT / 'Reference' / filename) as pdf:
        for number, original in enumerate(pdf.pages, 1):
            page = original.dedupe_chars(tolerance=1, extra_attrs=())
            selected, excluded = [], Counter()
            for char in page.chars:
                reason = None
                if not (0 <= char['x0'] < page.width and 0 <= char['top'] < page.height): reason = 'outside-page'
                elif book == 'base' and char['top'] >= 808: reason = 'page-footer'
                elif not any(abs(char['size'] - size) < 0.06 for size in [8, 8.5, 9, 10, 11, 12, 13, 24, 28, 30.2, 35]): reason = 'scaled-illustration-text'
                elif not any(font in char['fontname'] for font in ['Georgia', 'RomanceFatal', 'MyriadPro']): reason = 'illustration-or-numeric-symbol-font'
                elif 'RomanceFatal' in char['fontname'] and char['size'] < 20: reason = 'board-illustration-label'
                if reason: excluded[reason] += 1
                else: selected.append(char)
            blocks, raw, used = [], [], set()
            for region in regions(book, number, page.width, page.height):
                left, top, right, bottom = region
                chars = [c for c in selected if left <= c['x0'] < right and top <= c['top'] < bottom]
                for c in chars:
                    if id(c) in used: raise ValueError('Overlapping reading regions')
                    used.add(id(c))
                char_ids = {id(c) for c in chars}
                part = page.filter(lambda obj: obj['object_type'] == 'char' and id(obj) in char_ids)
                lines = part.extract_text_lines(x_tolerance=2, y_tolerance=3)
                raw.extend(line['text'] for line in lines)
                blocks.append(prose(lines))
            omitted = [c for c in selected if id(c) not in used]
            # Dynasties page 1 deliberately omits the example art to the right of the component list.
            if omitted and not (book == 'dynasties' and number == 1): raise ValueError(f'Unassigned source glyphs: {book} page {number}')
            excluded['example-art-region'] += len(omitted)
            text = '\n\n'.join(block for block in blocks if block)
            if book == 'base' and number == 3:
                # The inventory is an illustrated table; transcribe the visible cells rather than interleave them.
                text = '''### Game Components

### Component inventory (visual transcription)

| Component | Quantity |
| --- | --- |
| Score Board | 1 |
| Two-sided Player Boards | 5 |
| Rulebook | 1 |
| Progress Board | 1 |
| Workers | 13 in each of five player colors |
| Player discs | 5 in each of five player colors |
| Scoring pad | 1 |
| Progress Cards | 296 |
| Event Cards | 48 |
| 50-Book tokens | 4 |
| Player aid tiles | 4 |
| Player order cards | 5 |
| War marker | 1 |
| Round marker | 1 |
| Architects | 15 |
| Used markers | 12 |
| Solo Event tiles | 24 |
| 6-sided die | 1 |

| Token type | Value 1 | Value 3 | Value 10 |
| --- | --- | --- | --- |
| Food | 36 | 16 | 8 |
| Stone | 36 | 16 | 8 |
| Gold | 36 | 16 | 8 |
| VP | 36 | 16 | 4 |'''
            if book == 'base' and number == 6:
                prefix, _, tail = text.partition('This slot is for placing')
                pieces = re.split(r'(?=Step [1-7]:)', prefix)
                text = pieces[0] + '\n\n'.join(sorted(pieces[1:], key=lambda part: int(part[5])))
                if tail: text += '\n\nThis slot is for placing' + tail
            if book == 'base' and number in [12, 24]:
                text = text.replace('3. Growth: Take or / /', '3. Growth: Take [Worker] or [Gold]/[Food]/[Stone]')
                text = text.replace('B. Deploy\n', 'B. Deploy [Worker]\n')
                text = text.replace('(6.) : Score if end of age', '(6.) [Books]: Score if end of age')
            # These are resource icons, not missing prose; visually identified on Dynasties p.2.
            if book == 'dynasties' and number == 2:
                text = text.replace('you take an from the supply', 'you take an [Architect] from the supply')
                text = text.replace('from the available this round', 'from the [Architects] available this round')
                text = text.replace('placed as many as there', 'placed as many [Architects] as there')
            if book == 'dynasties' and number == 1:
                text = text.replace('the ” ” tokens', 'the ”[Used marker]” tokens')
                text = text.replace('” Max ” or “ Max , where number of equals', '”Max [Worker]” or ”Max [Worker][Worker]”, where number of [Worker symbols] equals')
            if book == 'dynasties' and number == 4:
                text = text.replace('3. Growth: Take or / /', '3. Growth: Take [Worker] or [Gold]/[Food]/[Stone]')
                text = text.replace('B. Deploy\n', 'B. Deploy [Worker]\n')
                text = text.replace('(7.) : Score if end of age', '(7.) [Books]: Score if end of age')
            pages.append(dict(number=number, text=text, notes=NOTES.get(book, {}).get(number)))
            audit.append(dict(page=number, originalGlyphs=len(original.chars), deduplicatedGlyphs=len(page.chars),
                              extractedGlyphs=len(used), excludedGlyphs=dict(excluded), textLines=len(raw)))
            (out / f'{book}-page-{number:02}.txt').write_text('\n'.join(raw) + '\n', encoding='utf8')
            page.close()
    return pages, audit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--diagnostics', type=Path, default=ROOT / 'work' / 'rulebooks')
    args = parser.parse_args()
    out = ROOT / 'data' / 'rules'; out.mkdir(parents=True, exist_ok=True)
    args.diagnostics.mkdir(parents=True, exist_ok=True)
    manifest = dict(schemaVersion=1, books=[])
    for key, title, filename, date, expected in BOOKS:
        pages, audit = extract(key, filename, args.diagnostics)
        if len(pages) != expected: raise ValueError('Unexpected source edition/page count')
        source_hash = hashlib.sha256((ROOT / 'Reference' / filename).read_bytes()).hexdigest()
        lines = [f'# {title}', '', f'Source PDF: `{filename}`. Edition identifier from filename: {date}.',
                 f'Source SHA-256: `{source_hash}`.', '',
                 '> English source transcription. PDF page numbers are preserved. Overlapping text is deduplicated; ligature spacing and line wrapping are normalized.',
                 '> Editor notes are explicitly marked. Miniature card/board lettering and graphics are not a complete card catalogue. Symbols not explained in prose require the source PDF.',
                 '> Layout checked against rendered pages; the transcription has not received a complete independent word-for-word review. This is not an updated rules edition.', '',
                 '## Contents', '']
        for page in pages: lines.append(f'- [PDF page {page["number"]}](#pdf-page-{page["number"]})')
        page_index = []
        for page in pages:
            lines.extend(['', f'## PDF page {page["number"]}', ''])
            start = len(lines) - 2
            if page['notes']: lines.extend(['> Editor note (visual transcription/context): ' + page['notes'], ''])
            lines.extend(page['text'].splitlines())
            page_index.append(dict(page=page['number'], startLine=start + 1, endLine=len(lines),
                                   headings=re.findall(r'^### (.+)$', page['text'], flags=re.M)))
        markdown = '\n'.join(lines) + '\n'
        (out / f'{key}.md').write_text(markdown, encoding='utf8', newline='\n')
        manifest['books'].append(dict(id=key, title=title, markdown=f'{key}.md', sourceFile='Reference/' + filename,
                                     edition=date, sourceSha256=source_hash, markdownSha256=hashlib.sha256(markdown.encode()).hexdigest(),
                                     pageCount=expected, review='layout-reviewed; full independent proofreading pending', pages=page_index))
        (args.diagnostics / f'{key}-extraction-audit.json').write_text(json.dumps(audit, indent=2) + '\n', encoding='utf8')
        print(f'{key}: {len(pages)} pages, {len(markdown)} Markdown characters', flush=True)
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


if __name__ == '__main__':
    main()
