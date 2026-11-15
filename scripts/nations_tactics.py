"""Check architect supply, Stability costs and planned worker transfers."""

from nations_placement import military_after_deploy
from nations_advisors import advisor_adjustments


def private_architects(player):
    return sum(card.private_architects_available for card in player.completed_cards())


def wonder_adjustments(match, player):
    available = match.architects + private_architects(player)
    adjustments = {}
    for action in player.buy_actions():
        if action.row < 0 or not action.card.is_wonder():
            continue
        needed = len(action.card.stage_costs)
        shortfall = needed - available
        if shortfall <= 0:
            continue
        price = action.row + 1
        # A project can still be worth staging for next round. A higher price
        # and more missing hires make this a larger opportunity cost now.
        penalty = min(1.25, .38 * shortfall + .11 * price)
        if match.round_number == 8:
            penalty += 1
        reasons = [f'{action.card.name} needs {needed} architects. Only {available} available to {player.name} this round.']
        for rival in match.players:
            project = rival.wonders_under_construction[0]
            if rival is player or rival.passed or project is None or not project.is_wonder():
                continue
            remaining = len(project.stage_costs) - project.completed_stages
            private = private_architects(rival)
            if 0 < remaining <= private:
                reasons.append(f'{project.name} needs {remaining} more architects and has {private} private architects available.')
        adjustments[str(action)] = (penalty, reasons)
    return adjustments


def can_recover_stability(player, required, stability):
    """Ordinary recovery using stock on hand and keeping deployed military."""
    for buy in player.buy_actions():
        if buy.card.production_value[stability] >= required:
            return True
    lost_stability = []
    if player.workers > 0:
        lost_stability.append(0)
    # A non-military worker can be moved without surrendering war strength.
    lost_stability.extend(action.card.production_per_worker[stability]
                          for action in player.undeploy_actions() if not action.card.is_military())
    for _, card in player.filled_slot_names_cards():
        if (card.is_building_military() and player.can_deploy_to_card(card)
                and any(card.production_per_worker[stability] - lost >= required for lost in lost_stability)):
            return True
    for hire in player.hire_actions():
        wonder = hire.card
        if wonder.completed_stages + 1 == len(wonder.stage_costs) and wonder.production_value[stability] >= required:
            return True
    return False


def turmoil_adjustment(match, player, replay_position, choose_benefit):
    from nations.resources import Resource

    before = player.resources[Resource.STABILITY]
    if before >= 2:
        return None
    try:
        branch = match.get_replay() + 'Turmoil\n'
        after = replay_position(branch)
        if after.next_move_choice == 'Which benefit?' and after.next_move_player == player.name:
            benefit = choose_benefit(after.get_state())
            if benefit not in after.next_move_options:
                return None
            after = replay_position(branch + benefit + '\n')
    except ValueError:
        return None
    if after.phase != match.phase or after.round_number != match.round_number:
        return None
    acting = next(p for p in after.players if p.name == player.name)
    stability = acting.resources[Resource.STABILITY]
    if stability >= 0 or stability >= before or can_recover_stability(acting, -stability, Resource.STABILITY):
        return None

    reasons = [f'Turmoil takes Stability from {before} to {stability}. No ordinary one-action recovery keeps the current Military.']
    original_wars = {str(action) for action in player.buy_actions() if action.card.is_war()}
    newly_funded = [action for action in acting.buy_actions() if action.card.is_war() and str(action) not in original_wars]
    rivals = [p for p in after.players if p is not acting]
    strength = acting.resources[Resource.MILITARY]
    military_lead = any(strength > military_after_deploy(rival, Resource.MILITARY)[0] for rival in rivals)
    if newly_funded and military_lead:
        wars = ' or '.join(action.card.name for action in newly_funded)
        can_block = any(not rival.passed and any(action.card.is_war() for action in rival.buy_actions()) for rival in rivals)
        if can_block:
            reasons.append(f'The Gold funds {wars}, but a rival can declare war first.')
        else:
            reasons.append(f'The Gold funds {wars} at {strength} Military with no ordinary rival war purchase available.')
            return .25, reasons
    return .80, reasons


def gold_transfer_plans(match, player, replay_position, pass_score):
    """Value a legal same-turn worker transfer when Gold is below its reserve target."""
    from nations.resources import Resource

    if player.workers or match.round_number >= 8:
        return {}
    age = (match.round_number + 1) // 2
    gold_target, stone_target = 4 + age, 2 + 3 * age

    def reserves(nation):
        production = nation.production(projected=True)
        return {resource: nation.resources[resource] + production[resource]
                for resource in (Resource.GOLD, Resource.STONE, Resource.FOOD, Resource.BOOKS)}

    def reserve_value(amount, target, beyond):
        return min(amount, target) + max(0, amount - target) * beyond

    before = reserves(player)
    if before[Resource.GOLD] >= gold_target:
        return {}
    stability = player.resources[Resource.STABILITY]
    military = player.resources[Resource.MILITARY]
    prefix = match.get_replay()
    plans = {}
    for source in player.undeploy_actions():
        if source.card.is_military():
            continue
        undeploy = str(source)
        try:
            released = replay_position(prefix + undeploy + '\n')
        except ValueError:
            continue
        if released.next_move_player != player.name or released.next_move_choice != 'Which action?':
            continue
        mover = next(p for p in released.players if p.name == player.name)
        for target in mover.deploy_actions():
            if target.slot == source.slot or target.card.production_per_worker[Resource.GOLD] <= source.card.production_per_worker[Resource.GOLD]:
                continue
            deploy = str(target)
            try:
                completed = replay_position(prefix + undeploy + '\n' + deploy + '\n')
            except ValueError:
                continue
            if completed.round_number != match.round_number or completed.phase != match.phase:
                continue
            moved = next(p for p in completed.players if p.name == player.name)
            after_stability = moved.resources[Resource.STABILITY]
            if after_stability < min(0, stability) or moved.resources[Resource.MILITARY] < military:
                continue
            after = reserves(moved)
            if after[Resource.GOLD] <= before[Resource.GOLD]:
                continue
            gold_gain = reserve_value(after[Resource.GOLD], gold_target, .35) - reserve_value(before[Resource.GOLD], gold_target, .35)
            stone_gain = reserve_value(after[Resource.STONE], stone_target, .15) - reserve_value(before[Resource.STONE], stone_target, .15)
            food_shortfall = min(0, after[Resource.FOOD]) - min(0, before[Resource.FOOD])
            books_delta = after[Resource.BOOKS] - before[Resource.BOOKS]
            value = gold_gain + .75 * stone_gain + food_shortfall + .4 * books_delta
            if value < .85 or value <= plans.get(undeploy, {}).get('value', 0):
                continue
            reason = (f'Move a worker from {source.card.name} to {target.card.name}. Stock plus production changes '
                      f'from {before[Resource.GOLD]} to {after[Resource.GOLD]} Gold and {before[Resource.STONE]} to '
                      f'{after[Resource.STONE]} Stone. Stability {stability} → {after_stability}, Military {military}.')
            # Compare against passing. A private transfer can usually wait
            # behind a stronger market action, so cap its priority bonus.
            plans[undeploy] = {'value': value, 'score': pass_score + min(.65, .28 * value),
                               'next_deploy': deploy, 'reasons': [reason]}
    return plans


def rank_actions(match, rows, replay_position, choose_benefit):
    """Keep learned preferences and adjust them for visible tactical constraints."""
    if match.next_move_choice != 'Which action?' or not rows:
        return rows
    player = next(p for p in match.players if p.name == match.next_move_player)
    adjustments = wonder_adjustments(match, player)
    pass_score = next((row['score'] for row in rows if row['move'] == 'Pass'), None)
    advisors = advisor_adjustments(match, player, replay_position, {row['move']: row['score'] for row in rows}, pass_score)
    transfers = gold_transfer_plans(match, player, replay_position, pass_score) if pass_score is not None else {}
    if any(row['move'] == 'Turmoil' for row in rows):
        penalty = turmoil_adjustment(match, player, replay_position, choose_benefit)
        if penalty:
            adjustments['Turmoil'] = penalty
    if not adjustments and not transfers and not advisors:
        return rows
    result = []
    for row in rows:
        transfer = transfers.get(row['move'])
        if transfer and transfer['score'] > row['score']:
            result.append({**row, 'learned_score': row['score'], 'score': transfer['score'], 'reasons': transfer['reasons'],
                           'next_deploy': transfer['next_deploy']})
        elif row['move'] in advisors:
            score, reasons = advisors[row['move']]
            result.append({**row, 'learned_score': row['score'], 'score': score, 'reasons': reasons})
        elif row['move'] not in adjustments:
            result.append(row)
        else:
            penalty, reasons = adjustments[row['move']]
            result.append({**row, 'learned_score': row['score'], 'score': row['score'] - penalty, 'reasons': reasons})
    return sorted(result, key=lambda row: -row['score'])
