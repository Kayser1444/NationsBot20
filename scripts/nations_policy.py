"""Call the shared JavaScript scorer for local games and training."""

import atexit
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


class SharedScorer:
    def __init__(self, bridge=None):
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js 24 is required for the shared Nations scorer.")
        self.process = subprocess.Popen(
            [node, str(bridge or ROOT / "live-player/local-bridge.mjs")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            encoding="utf-8", bufsize=1,
        )
        atexit.register(self.close)

    def request(self, payload):
        if self.process.poll() is not None:
            raise RuntimeError("The shared scorer has stopped.")
        self.process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("The shared scorer did not answer.")
        result = json.loads(line)
        if isinstance(result, dict) and result.get("error"):
            raise RuntimeError(result["error"])
        return result

    def configure(self, models):
        self.request({"configure": models})

    def choose(self, state):
        return self.request(state)

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=3)


_shared = None


def bot_move(match, choice, options, rng, baseline):
    global _shared
    if not options:
        raise RuntimeError(f"The engine offered no legal moves for {choice}.")
    if len(options) == 1:
        return options[0]
    if not baseline:
        candidates = [option for option in options if str(option) not in ("UNDO", "Resign")]
        return rng.choice(candidates or options)
    if _shared is None:
        _shared = SharedScorer()
    selected = _shared.choose(match.get_state())
    return next(option for option in options if str(option) == selected)
