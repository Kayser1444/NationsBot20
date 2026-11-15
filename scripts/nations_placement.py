"""Compare legal placements after applying them with the local game engine."""

import re


SLOT = re.compile(r'(?:BM|A|C|W|S)\d+')
# This printed starting space has no workers, output or ongoing effect.
INERT_CARDS = {'Mg_Stp'}


def is_placement(choice, options):
    return (choice.startswith('Place ') and choice.endswith(' where?')
            and len(options) > 1 and all(SLOT.fullmatch(option) for option in options))


def military_after_deploy(player, military):
    """Return the strongest ordinary military deployment funded now."""
    current = player.resources[military]
    best, slot = current, None
    if player.workers <= 0 or player.passed:
        return best, slot
    for location, card in player.filled_slot_names_cards():
        if not card.is_military() or not player.can_deploy_to_card(card):
            continue
        potential = current + card.production_per_worker[military]
        if potential > best:
            best, slot = potential, location
    return best, slot


def placement_value(match, name):
    from nations.resources import Resource

    player = next(player for player in match.players if player.name == name)
    production = player.production(projected=True)
    score = player.score(projected=True)
    for resource, weight in ((Resource.GOLD, .55), (Resource.STONE, .45), (Resource.FOOD, .35), (Resource.BOOKS, .25)):
        score += weight * (production[resource] + .35 * player.resources[resource])
    score += .35 * player.resources[Resource.STABILITY] + .20 * player.resources[Resource.MILITARY]

    # An idle card is an option for future turns. Count existing productive
    # cards as well as current output, with a separate value for military/raid.
    for _, card in player.filled_slot_names_cards():
        if card.abbr in INERT_CARDS:
            continue
        score += .25
        if card.is_building_military():
            output = card.production_per_worker
            score += .18 * sum(max(0, output[r]) for r in (Resource.GOLD, Resource.STONE, Resource.FOOD, Resource.BOOKS, Resource.STABILITY))
            if card.is_military():
                score += .18 * output[Resource.MILITARY] + .12 * card.raid_value

    strength, slot = military_after_deploy(player, Resource.MILITARY)
    wars = [card.name for row, cards in enumerate(match.progress_board, 1) for card in cards
            if card is not None and card.is_war() and player.can_buy_card(card, row)]
    rivals = [rival for rival in match.players if rival is not player]
    threatened = [rival.name for rival in rivals if strength > military_after_deploy(rival, Resource.MILITARY)[0]] if wars else []
    if threatened:
        score += min(1.5, strength * .30) * len(threatened) / len(rivals)
    return score, {'military_after_deploy': strength, 'military_slot': slot, 'affordable_wars': wars,
                   'rivals_below_strength_after_one_deploy': threatened}


def rank_placements(match, replay_position):
    if not is_placement(match.next_move_choice, match.next_move_options):
        return []
    name = match.next_move_player
    player = next(player for player in match.players if player.name == name)
    original = dict(player.filled_slot_names_cards())
    replay = match.get_replay()
    rows = []
    for slot in match.next_move_options:
        try:
            after = replay_position(replay + slot + '\n')
        except ValueError:
            return []
        # A prompt can be part of event resolution. Compare placements only
        # when the replay fork stays in the same phase and round.
        if after.round_number != match.round_number or after.phase != match.phase or after.game_over:
            return []
        after_player = next(player for player in after.players if player.name == name)
        after_slots = dict(after_player.filled_slot_names_cards())
        old_card = original.get(slot)
        new_card = after_slots.get(slot)
        score, options = placement_value(after, name)
        # Returning idle workers is useful only after paying to deploy them
        # again. This penalty applies even when the projected VP is unchanged.
        displaced = max(0, after_player.workers - player.workers)
        rows.append({'move': slot, 'score': score - .45 * displaced, 'old_card': old_card.name if old_card else None,
                     'new_card': new_card.name if new_card else None, 'displaced_workers': displaced,
                     'inert_or_empty': old_card is None or old_card.abbr in INERT_CARDS, **options})
    return sorted(rows, key=lambda row: (-row['score'], not row['inert_or_empty']))
