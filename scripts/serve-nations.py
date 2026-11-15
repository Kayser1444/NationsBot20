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
from urllib.parse import quote, urlsplit

from nations_policy import bot_move

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "scripts" / "nations-browser"
ENGINE = ROOT.parent / "nations-server" / "Nations"
SAVE = ROOT / ".data" / "nations-play" / "browser.replay"
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
    def __init__(self, save, seed):
        self.save = save
        self.lock = Lock()
        self.revision = secrets.token_hex(12)
        self.by_id, self.by_name = image_library()
        self.images = {}
        replay = save.read_text(encoding="utf-8") if save.is_file() else None
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

        def choose(choice, options, _undo):
            nonlocal pending, options_for_human
            if match.invalid_move:
                raise RuntimeError("The engine rejected the last move.")
            if match.current_player.name == BOT:
                rng = random.Random(f"{match.seed.hex()}:{match.move_number}")
                return bot_move(match, choice, options, rng, baseline=True)
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
        if {player.name for player in match.players} != {HUMAN, BOT} or len(match.players) != 2:
            raise ValueError("The saved replay is not from the local browser game.")
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
        self.revision = secrets.token_hex(12)

    def card_data(self, card):
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
        if card is self.match.event:
            detail = f"{card.name_a}: {card.effect_a}\n{card.name_b}: {card.effect_b}"
            data["famine"] = -card.famine
        data["detail"] = detail or ""
        path = self.by_id.get(card.abbr)
        if path is None:
            path = self.by_name.get(art_key(card.name.split(";")[0]))
        data["image"] = self.image(card.abbr, path)
        return data

    def state(self):
        match = self.match
        state = match.get_state()
        visible = [card for row in match.progress_board for card in row]
        visible.extend(card for player in match.players if player.nation for card in player.all_cards())
        visible.extend(card for nation in match.available_nations for card in nation.all_slots())
        visible.extend((match.war, match.event))
        state["card_details"] = {card.abbr: self.card_data(card) for card in visible if card is not None}
        for name, nation in state["nations"].items():
            path = ROOT / "Reference" / "tabony-boards" / (name + ".jpg")
            nation["image"] = self.image("nation-" + name, path)
        state["revision"] = self.revision
        state["human"] = HUMAN
        state["log"] = match.get_log().strip().splitlines()[-80:]
        state["options"] = []
        for option in self.options:
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
                placed = state["players"][HUMAN].get("slots", {}).get(value)
                label = f"Replace {state['card_details'][placed]['name']} ({value})" if placed else f"Use empty slot {value}"
            state["options"].append({"value": value, "label": label})
        if match.game_over:
            if match.phase.name == "SCORING":
                ordered = sorted(match.players, key=lambda player: -player.score())
                state["result"] = [{"name": player.name, "score": player.score()} for player in ordered]
            else:
                state["result"] = []
        return state


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
            with game.lock:
                if path == "/api/game":
                    self.json_reply(game.state())
                    return
                if path == "/api/replay":
                    self.reply(200, game.match.get_replay().encode("utf-8"), "text/plain",
                               **{"Content-Disposition": 'attachment; filename="local-nations.replay"'})
                    return
                filename = {"/": WEB / "index.html", "/board.js": WEB / "board.js", "/board.css": WEB / "board.css"}.get(path)
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
            if self.path not in ("/api/move", "/api/new"):
                self.send_error(404)
                return
            if self.headers.get_content_type() != "application/json":
                self.send_error(415)
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 4096:
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
                        game.advance()
                    else:
                        move = payload.get("move")
                        if move not in [str(option) for option in game.options]:
                            self.json_reply({"error": "Choose a legal move on the current board."}, 400)
                            return
                        game.advance(replay=game.match.get_replay(), move=move)
                    self.json_reply(game.state())
                except (ValueError, RuntimeError, OSError) as error:
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
    parser.add_argument("--weights", type=Path, help="editable model JSON to use locally")
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
    game = LocalGame(args.save, args.seed)
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(game)) as server:
        print(f"Nations offline is ready at http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
