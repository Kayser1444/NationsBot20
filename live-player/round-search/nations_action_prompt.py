"""Classify the engine's main-action prompt and read its optional action count."""
import re

MAIN = 'Which action?'
_MAIN_PROMPT = re.compile(r'Which action\?(?: \(([2-9]|[1-9]\d+) remaining\))?')


def main_actions_remaining(prompt):
    match = _MAIN_PROMPT.fullmatch(prompt) if isinstance(prompt, str) else None
    return int(match[1] or 1) if match else None


def is_main_action(prompt):
    return main_actions_remaining(prompt) is not None


def policy_prompt(prompt):
    return MAIN if is_main_action(prompt) else prompt
