"""Engine state fingerprints and worker rules shared by local search probes."""
from enum import Enum

from nations.cards import Card
from nations.nations import Nation, WorkerPool
from nations.player import Player
from nations.resources import Resource, Resources


def freeze(value):
    """Fingerprint known engine values without reading the hidden deck."""
    if value is None or isinstance(value, (str, int, Enum)):
        return value
    if isinstance(value, (Card, Nation)):
        return type(value), value.abbr
    if isinstance(value, Player):
        return value.name
    if isinstance(value, Resources):
        return tuple(value[resource] for resource in Resource)
    if isinstance(value, WorkerPool):
        return tuple((key, freeze(item)) for key, item in vars(value).items())
    if isinstance(value, dict):
        return tuple((freeze(key), freeze(item)) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return tuple(map(freeze, value))
    raise TypeError(f'Unhandled benchmark state field: {type(value).__name__}')


def decision_key(match, actor, prompt, undeploy_cursor, *, exact=False):
    players = []
    cards = [match.event, match.war]
    cards.extend(card for row in match.progress_board for card in row)
    for player in match.players:
        fields = []
        for name, value in vars(player).items():
            if name in ('match', 'take_turn') or (player.name == actor and name == 'resources'):
                continue
            if not exact and name in ('turn_number', 'action_number'):
                # Current rules distinguish the first turn/action from later ones.
                value = min(value, 2)
            fields.append((name, freeze(value)))
        players.append(tuple(fields))
        cards.extend(player.all_cards())

    hooks = []
    for name, event in match.events.events.items():
        if event.registered_events:
            hooks.append((name, tuple((freeze(card), condition.__name__, handler.__name__)
                                      for card, condition, handler in event.registered_events)))
            cards.extend(card for card, _, _ in event.registered_events)
    card_fields = tuple((freeze(card), tuple((key, freeze(value)) for key, value in vars(card).items()
                                             if key != 'match'))
                        for card in dict.fromkeys(cards) if card is not None)
    key = (match.round_number, match.phase, prompt, actor, undeploy_cursor, match.architects,
            match.turmoil, match.war_value, freeze(match.event), freeze(match.war),
            freeze(match.progress_board), tuple(players), tuple(hooks), card_fields)
    return (*key, match.cards_bought, freeze(match.available_nations)) if exact else key


def standalone_undeploy_allowed(card, varanasi_active, military_upkeep_waived):
    if varanasi_active:
        return True
    if card.is_military() and military_upkeep_waived:
        return False
    return bool(card.production_per_worker.negative())
