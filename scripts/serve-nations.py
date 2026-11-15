"""Run the offline Nations board on http://127.0.0.1:8765."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import random
import re
import secrets
import sys
from threading import Lock
from time import perf_counter
from urllib.parse import quote, urlsplit

from nations_policy import SharedScorer
from nations_placement import rank_placements
from nations_human_player import choose_human_move, human_prediction
from native_nations import native_page, cached_asset, CACHE

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "scripts" / "nations-browser"
ENGINE = ROOT.parent / "nations-server" / "Nations"
SAVE = ROOT / ".data" / "nations-play" / "browser.replay"
HUMAN_POLICY = ROOT / '.data' / 'human-policy' / 'v1' / 'policy.json'
HUMAN = "You"
BOT = "NationsBot"


class HumanTurn(Exception):
    pass


def art_key(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def image_library():
    scanned = ROOT / "Reference" / "Nations_assets"
    by_name = {
        art_key(path.stem): path
        for folder in ("Progress_Cards", "Dynasties_Cards", "Event_Cards")
        for path in (scanned / folder).glob("*.jpg")
    }
    cropped = ROOT / "public" / "card-assets"
    manifest = json.loads((ROOT / "data/cards/asset-manifest.json").read_text(encoding="utf-8"))
    by_id = {
        entry["cardId"]: cropped / entry["filename"]
        for entry in manifest["files"]
        if (cropped / entry["filename"]).is_file()
    }
    return by_id, by_name


class LocalGame:
    def __init__(self, save, seed, difficulty='easy', human_policy=None):
        self.save = save
        self.lock = Lock()
        self.revision = secrets.token_hex(12)
        self.by_id, self.by_name = image_library()
        self.images = {}
        self.scorer = SharedScorer()
        self.difficulties = ['easy', 'medium']
        if human_policy is not None:
            self.scorer.request({'loadHumanPolicy': json.loads(human_policy.read_text(encoding='utf-8'))})
            self.difficulties.append('human')
        self.validate_difficulty(difficulty)
        self.difficulty = difficulty
        self.human_name = HUMAN
        self.review = None
        self.view_number = None
        self.bot_decisions = []
        manifest = CACHE/'manifest.json'
        self.native_assets = len(json.loads(manifest.read_text(encoding='utf-8'))['assets']) if manifest.is_file() else 0
        replay = save.read_text(encoding="utf-8") if save.is_file() else None
        if replay:
            from nations import Match
            names = [p.name for p in Match(replay=replay).players]
            meta = save.with_suffix('.meta.json')
            metadata = json.loads(meta.read_text(encoding='utf-8')) if meta.is_file() else {}
            selected = metadata.get('human')
            self.difficulty = metadata.get('difficulty',difficulty)
            if self.difficulty not in self.difficulties:
                self.validate_difficulty(self.difficulty)
            self.human_name = selected if selected in names else HUMAN if HUMAN in names else names[0]
        self.advance(replay=replay, seed=seed)

    def image(self, key, path):
        if path is not None and path.is_file():
            self.images[key] = path
            return "/art/" + quote(key)
        return None

    def advance(self, *, replay=None, seed=None, move=None):
        from nations import Match

        pending = move
        options_for_human = ()
        planned = {}
        planned_deployments = {}

        def choose(choice, options, _undo):
            nonlocal pending, options_for_human
            if match.invalid_move:
                raise RuntimeError("The engine rejected the last move.")
            if match.current_player.name != self.human_name:
                started = perf_counter()
                search = None
                label_card = None
                legal = [str(option) for option in options]
                who = match.current_player.name
                if choice == 'Which action?':
                    planned.pop(who,None)
                steps = planned.get(who,[])
                if self.difficulty == 'human':
                    selected, label_card = choose_human_move(self.scorer, match, self.replay_position, planned_deployments)
                elif len(options) == 1:
                    selected = legal[0]
                elif steps and steps[0] in legal:
                    selected = steps.pop(0)
                elif self.difficulty == 'medium':
                    search = self.scorer.request({'state':match.get_state(),'medium':True})
                    top = search['moves'][0]
                    selected = top['move']
                    if top.get('nextSteps'):
                        planned[who] = top['nextSteps'][:]
                else:
                    selected = self.scorer.choose(match.get_state())
                option = next((option for option in options if str(option) == selected), None)
                if option is None:
                    raise RuntimeError('The scorer did not select a legal option.')
                if not selected.startswith('Confirm'):
                    label = selected
                    card = getattr(option, 'card', None)
                    if card is not None:
                        label += f' ({card.name})'
                    elif label_card:
                        label += f' (replaces {label_card})'
                    self.bot_decisions.append(dict(move=selected, label=label, player=match.current_player.name,
                                                   decision=match.move_number, choice=choice, difficulty=self.difficulty,
                                                   search=search, duration_ms=(perf_counter()-started)*1000))
                    del self.bot_decisions[:-30]
                return option
            if pending is not None:
                label = pending
                pending = None
                for option in options:
                    if str(option) == label:
                        return option
                raise ValueError("That move is no longer legal.")
            options_for_human = options
            raise HumanTurn()

        match = Match(
            player_names=[HUMAN, BOT], replay=replay,
            seed=f"{seed:x}" if seed is not None else None, move_getter=choose,
        )
        if self.human_name not in {player.name for player in match.players} or not 2 <= len(match.players) <= 5:
            raise ValueError("Choose a player in a two- through five-player replay.")
        try:
            match.play()
        except HumanTurn:
            pass
        if pending is not None or match.move_list or match.invalid_move:
            raise ValueError("The match did not accept the complete move sequence.")
        if replay != match.get_replay():
            self.save.parent.mkdir(parents=True, exist_ok=True)
            temp = self.save.with_suffix(".tmp")
            temp.write_text(match.get_replay(), encoding="utf-8")
            temp.replace(self.save)
        self.match = match
        self.options = options_for_human
        self.save_metadata()
        self.revision = secrets.token_hex(12)

    def save_metadata(self):
        meta = self.save.with_suffix('.meta.json')
        temporary = meta.with_suffix('.meta.tmp')
        temporary.write_text(json.dumps({'human':self.human_name,'difficulty':self.difficulty})+'\n',encoding='utf-8')
        temporary.replace(meta)

    def validate_difficulty(self, difficulty):
        if difficulty not in self.difficulties:
            if difficulty == 'human':
                raise ValueError('The human replay model is missing. Start with --human-policy PATH.')
            raise ValueError('Choose a bot listed in the Bot menu.')

    def set_difficulty(self, difficulty):
        self.validate_difficulty(difficulty)
        self.difficulty = difficulty
        self.save_metadata()
        self.revision = secrets.token_hex(12)

    def card_data(self, card, match=None):
        match = match or self.match
        data = {"name": card.name, "type": str(card.progress_card_type) if card.is_progress() else card.card_type.name.lower()}
        production = getattr(card, "production_per_worker", card.production_value)
        data["production"] = production.state()
        if card.is_building_military():
            data["cost"] = -card.deployment_cost
            data["per_worker"] = True
        for attr in ("military_requirement", "raid_value", "stage_costs", "completed_stages", "exploration_turns", "points"):
            if hasattr(card, attr):
                data[attr] = getattr(card, attr)
        if card.is_war():
            data["penalty"] = f"{-card.penalty_amount} {card.penalty_resource}"
        detail = type(card).__doc__
        if card is match.event:
            detail = f"{card.name_a}: {card.effect_a}\n{card.name_b}: {card.effect_b}"
            data["famine"] = -card.famine
        data["detail"] = detail or ""
        path = self.by_id.get(card.abbr)
        if path is None:
            path = self.by_name.get(art_key(card.name.split(";")[0]))
        data["image"] = self.image(card.abbr, path)
        return data

    def state(self):
        if self.review and self.review['kind'] == 'fixture':
            positions = self.review['positions']
            number = self.view_number if self.view_number is not None else max(positions)
            state = json.loads(json.dumps(positions[number]))
            state.update(revision=self.revision, human=self.human_name, log=[], full_log='Public opening snapshot; full replay not available.',
                         bot_decisions=[], native_assets=self.native_assets, difficulty=self.difficulty, difficulties=self.difficulties,
                         view={'mode':'review','label':'Match 3272 opening','min_position':min(positions),'max_position':max(positions), 'can_branch':False, 'replay_available':False})
            return state
        match = self.view_match()
        state = match.get_state()
        visible = [card for row in match.progress_board for card in row]
        visible.extend(card for player in match.players if player.nation for card in player.all_cards())
        visible.extend(card for nation in match.available_nations for card in nation.all_slots())
        visible.extend((match.war, match.event))
        state["card_details"] = {card.abbr: self.card_data(card, match) for card in visible if card is not None}
        for name, nation in state["nations"].items():
            path = ROOT / "Reference" / "tabony-boards" / (name + ".jpg")
            nation["image"] = self.image("nation-" + name, path)
        state["revision"] = self.revision
        state["human"] = self.human_name
        state["log"] = match.get_log().strip().splitlines()[-80:]
        state['full_log'] = match.get_log()
        state['bot_decisions'] = self.bot_decisions
        state['native_assets'] = self.native_assets
        state['difficulty'] = self.difficulty
        state['difficulties'] = self.difficulties
        state['view'] = {'mode':'review' if self.review else 'history' if self.view_number is not None else 'play',
                         'label':'Imported replay' if self.review else 'Local game replay',
                         'min_position':0,
                         'max_position':self.review['maximum'] if self.review else self.match.move_number,
                         'can_branch': self.review is not None or self.view_number is not None, 'replay_available':True}
        state["options"] = []
        for option in self.options if state['view']['mode'] == 'play' else []:
            value = str(option)
            card = getattr(option, "card", None)
            label = value
            if card is not None:
                if value.startswith("Buy P"):
                    label = f"Buy {card.name} ({option.row + 1} Gold row)"
                elif hasattr(option, "slot"):
                    label = f"{value.split(' from ')[0].split(' to ')[0]} {card.name} ({option.slot})"
                elif value == "Hire":
                    label = f"Hire for {card.name}"
            elif re.fullmatch(r"P[1-3][1-4]", value) and value in state["progress_board"]:
                label = f"Select {state['card_details'][state['progress_board'][value]]['name']} ({value})"
            elif re.fullmatch(r"(?:BM|A|C|W|S)\d+", value):
                placed = state["players"][self.human_name].get("slots", {}).get(value)
                label = f"Replace {state['card_details'][placed]['name']} ({value})" if placed else f"Use empty slot {value}"
            state["options"].append({"value": value, "label": label})
        if match.game_over:
            if match.phase.name == "SCORING":
                ordered = sorted(match.players, key=lambda player: -player.score())
                state["result"] = [{"name": player.name, "score": player.score()} for player in ordered]
            else:
                state["result"] = []
        return state

    def view_match(self):
        if self.review or self.view_number is not None:
            source = self.review['replay'] if self.review else self.match.get_replay()
            return self.replay_position(source, self.view_number)
        return self.match

    @staticmethod
    def replay_position(replay, number=None):
        from nations import Match
        header, separator, moves = replay.partition('\n\n')
        if not separator:
            raise ValueError('Replay header is missing.')
        seeds = re.findall(r'^seed ([0-9a-fA-F]{1,128})$',header,re.M)
        names = re.findall(r'^player (.+)$',header,re.M)
        if len(seeds) != 1 or not 2 <= len(names) <= 5 or len(set(names)) != len(names) or any(not re.fullmatch(r'[\w.@+-]{1,150}',name) for name in names):
            raise ValueError('Replay must contain a seed and two through five distinct player names.')
        for line in header.splitlines():
            if line.startswith('growth_resources ') and not re.fullmatch(r'growth_resources [1-4]',line):
                raise ValueError('Replay growth resources must be between one and four.')
            if line.startswith('extra_draft_nations ') and not -1 <= int(line.split()[1]) <= 17:
                raise ValueError('Invalid number of extra draft nations.')
        lines = moves.splitlines()
        if len(lines) > 10000:
            raise ValueError('Replay has too many decisions.')
        if number is not None:
            prefix = lines[:number]
            replay = header + '\n\n' + ('\n'.join(prefix) + '\n' if prefix else '')
        def stop(*args):
            raise HumanTurn()
        try:
            match = Match(replay=replay, move_getter=stop)
        except Exception as error:
            raise ValueError('Replay header could not be reconstructed.') from error
        if not 2 <= len(match.players) <= 5:
            raise ValueError('Replay must have two through five players.')
        try:
            match.play()
        except HumanTurn:
            pass
        except Exception as error:
            raise ValueError('Replay could not be reconstructed.') from error
        if match.invalid_move or match.move_list:
            raise ValueError('Replay contains an invalid or incomplete move sequence.')
        return match

    def open_review(self, payload):
        if payload.get('fixture') == '3272':
            positions = json.loads((ROOT/'live-player/fixtures/match-3272-opening.json').read_text(encoding='utf-8'))
            self.review = {'kind':'fixture', 'positions':{int(n):state for n,state in positions.items()}}
            self.view_number = min(self.review['positions'])
        else:
            replay = payload.get('replay')
            if not isinstance(replay, str) or len(replay.encode('utf-8')) > 2*1024*1024:
                raise ValueError('Choose a replay file up to 2 MB.')
            replay = replay.replace('\r\n','\n')
            match = self.replay_position(replay)
            self.review = {'kind':'replay', 'replay':replay, 'maximum':match.move_number}
            self.view_number = 0
        self.revision = secrets.token_hex(12)

    def seek(self, command):
        if not isinstance(command, dict) or len(command) != 1:
            raise ValueError('Choose one replay navigation command.')
        state = self.state()
        current, maximum = state['move_number'], state['view']['max_position']
        key, value = next(iter(command.items()))
        if key == 'end':
            self.view_number = maximum if self.review else None
        elif key in ('to','back','forward','round'):
            if not isinstance(value,int) or isinstance(value,bool) or value < 0:
                raise ValueError('Invalid replay position.')
            target = value if key == 'to' else current-value if key == 'back' else current+value if key == 'forward' else state['round_starts'].get(str(value),state['round_starts'].get(value,0))
            self.view_number = max(0,min(maximum,target))
            if self.review and self.review['kind'] == 'fixture':
                available = sorted(self.review['positions'])
                if key == 'forward':
                    self.view_number = next((n for n in available if n > current), available[-1])
                elif key == 'back':
                    self.view_number = next((n for n in reversed(available) if n < current), available[0])
                else:
                    self.view_number = min(available,key=lambda n:abs(n-self.view_number))
        else:
            raise ValueError('Unknown replay navigation command.')

    def archive(self):
        directory = self.save.parent/'archives'
        directory.mkdir(parents=True,exist_ok=True)
        (directory/(self.revision+'.replay')).write_text(self.match.get_replay(),encoding='utf-8')

    def branch(self, human):
        if self.review and self.review['kind'] == 'fixture':
            raise ValueError('This snapshot has no replay seed. Open a full replay to branch it.')
        source = self.review['replay'] if self.review else self.match.get_replay()
        match = self.replay_position(source, self.view_number)
        if human not in [p.name for p in match.players] or match.game_over:
            raise ValueError('Choose a player at an unfinished replay position.')
        self.archive()
        previous = self.human_name
        self.human_name = human
        try:
            self.advance(replay=match.get_replay())
        except Exception:
            self.human_name = previous
            raise
        self.review = None
        self.view_number = None


def handler_for(game):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, content, media_type, **headers):
            self.send_response(status)
            self.send_header("Content-Type", media_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(content)

        def json_reply(self, data, status=200):
            self.reply(status, json.dumps(data).encode("utf-8"), "application/json")

        def allowed_host(self):
            port = self.server.server_port
            return self.headers.get("Host") in {f"127.0.0.1:{port}", f"localhost:{port}"}

        def do_GET(self):
            from urllib.parse import unquote

            if not self.allowed_host():
                self.send_error(403)
                return
            path = urlsplit(self.path).path
            if path.startswith('/static/public/Nations/') or path == '/native-assets/bootstrap.min.css':
                try:
                    content, media = cached_asset(unquote(path))
                    self.reply(200,content,media)
                except (ValueError,OSError) as error:
                    self.json_reply({'error':f'Native asset could not be loaded: {error}'},502)
                return
            with game.lock:
                if path == '/':
                    self.reply(200,native_page(game.human_name,len(game.match.players)),'text/html; charset=utf-8')
                    return
                if path == "/api/game":
                    self.json_reply(game.state())
                    return
                if path == "/api/replay":
                    if game.review and game.review['kind'] == 'fixture':
                        self.json_reply({'error':'This is a public snapshot, not a complete replay.'},400)
                        return
                    replay = game.review['replay'] if game.review else game.match.get_replay()
                    self.reply(200, replay.encode("utf-8"), "text/plain",
                               **{"Content-Disposition": 'attachment; filename="local-nations.replay"'})
                    return
                if path == '/api/snapshot':
                    self.reply(200,json.dumps(game.state()).encode('utf-8'),'application/json',**{'Content-Disposition':'attachment; filename="nations-position.json"'})
                    return
                if path == '/api/analyze':
                    try:
                        position = game.state()
                        analysis = game.scorer.request({'state':position,'analyze':True})
                        analysis['medium'] = game.scorer.request({'state':position,'medium':True})
                        if 'human' in game.difficulties:
                            match = game.view_match() if position['view']['replay_available'] else None
                            analysis['human'] = human_prediction(game.scorer, position, game.replay_position, match)
                            if match is not None:
                                placement = rank_placements(match, game.replay_position)
                                if placement:
                                    analysis['placement'] = placement
                        self.json_reply(analysis)
                    except RuntimeError as error:
                        self.json_reply({'error':str(error)},400)
                    return
                filename = {"/legacy": WEB / "index.html", "/board.js": WEB / "board.js", "/board.css": WEB / "board.css",
                            '/native-transport.js':WEB/'native-transport.js','/native-license':WEB/'native/LICENSE.txt'}.get(path)
                if path.startswith("/art/"):
                    filename = game.images.get(unquote(path.removeprefix("/art/")))
            if filename is None or not filename.is_file():
                self.send_error(404)
                return
            self.reply(200, filename.read_bytes(), mimetypes.guess_type(filename)[0] or "application/octet-stream")

        def do_POST(self):
            origin = "http://" + self.headers.get("Host", "")
            if not self.allowed_host() or self.headers.get("Origin") != origin:
                self.send_error(403)
                return
            if self.path not in ("/api/move", "/api/new", '/api/review','/api/resume','/api/position','/api/branch','/api/settings'):
                self.send_error(404)
                return
            if self.headers.get_content_type() != "application/json":
                self.send_error(415)
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= (2*1024*1024+4096 if self.path == '/api/review' else 4096):
                    raise ValueError()
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError()
            except (ValueError, UnicodeError):
                self.json_reply({"error": "Invalid request."}, 400)
                return
            with game.lock:
                if payload.get("revision") != game.revision:
                    self.json_reply({"error": "The board changed. Review the current position."}, 409)
                    return
                try:
                    if self.path == "/api/new":
                        difficulty = payload.get('difficulty',game.difficulty)
                        game.validate_difficulty(difficulty)
                        game.archive()
                        game.difficulty = difficulty
                        game.human_name = HUMAN
                        game.review = None
                        game.view_number = None
                        game.bot_decisions.clear()
                        game.advance()
                    elif self.path == '/api/settings':
                        game.set_difficulty(payload.get('difficulty'))
                    elif self.path == '/api/review':
                        game.open_review(payload)
                    elif self.path == '/api/resume':
                        game.review = None
                        game.view_number = None
                    elif self.path == '/api/position':
                        game.seek(payload.get('command'))
                    elif self.path == '/api/branch':
                        game.branch(payload.get('human',game.human_name))
                    else:
                        if game.review is not None or game.view_number is not None:
                            raise ValueError('Replay is read-only. Choose Play from here to create a local branch.')
                        move = payload.get("move")
                        if move not in [str(option) for option in game.options]:
                            self.json_reply({"error": "Choose a legal move on the current board."}, 400)
                            return
                        game.advance(replay=game.match.get_replay(), move=move)
                    self.json_reply(game.state())
                except (ValueError, RuntimeError, OSError, KeyError) as error:
                    self.json_reply({"error": str(error)}, 400)

        def log_request(self, code="-", size="-"):
            if not self.path.startswith("/art/"):
                super().log_request(code, size)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--engine", type=Path, default=ENGINE)
    parser.add_argument("--save", type=Path, default=SAVE)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--weights", type=Path, default=ROOT/'live-player/trained-weights.json', help="editable Easy model JSON to use locally")
    parser.add_argument('--difficulty',choices=['easy','medium','human'],default='easy',help='Policy for a new local save; an existing save retains its selected policy.')
    parser.add_argument('--human-policy',type=Path,help='Learned model JSON. Uses the local v1 model if present.')
    args = parser.parse_args()
    if args.weights:
        if not args.weights.is_file():
            parser.error("--weights must name an existing JSON model")
        os.environ["NATIONS_PLAYER_WEIGHTS"] = str(args.weights.resolve())
    if args.seed is not None and args.seed < 0:
        parser.error("--seed must be nonnegative")
    if not (args.engine / "nations" / "match.py").is_file():
        parser.error("pass --engine with the directory containing Tabony's nations package")
    sys.path.insert(0, str(args.engine.resolve()))
    human_policy = args.human_policy or (HUMAN_POLICY if HUMAN_POLICY.is_file() else None)
    if human_policy is not None and not human_policy.is_file():
        parser.error('--human-policy must name an existing JSON model')
    game = LocalGame(args.save, args.seed, args.difficulty, human_policy=human_policy)
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(game)) as server:
        print(f"Nations offline is ready at http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
