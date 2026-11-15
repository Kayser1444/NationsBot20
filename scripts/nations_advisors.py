"""Compare an advisor's immediate and recurring effects in the local engine."""

from nations_placement import rank_placements


def advisor_purchase(match, action, replay_position):
    prefix = match.get_replay() + str(action) + '\n'
    try:
        after = replay_position(prefix)
        if after.next_move_choice == 'Place card where?':
            placements = rank_placements(after, replay_position)
            if not placements:
                return None
            after = replay_position(prefix + placements[0]['move'] + '\n')
    except ValueError:
        return None
    if after.phase != match.phase or after.round_number != match.round_number or after.game_over:
        return None
    acting = next(player for player in after.players if player.name == match.next_move_player)
    advisor = next((card for card in acting.completed_cards() if card.abbr == action.card.abbr), None)
    return (after, acting, advisor) if advisor is not None else None


def newly_available_colony(before, after, acting, original_buys, horizon):
    from nations.resources import Resource

    military = acting.resources[Resource.MILITARY]
    if military <= before.resources[Resource.MILITARY]:
        return None
    plans = []
    for action in acting.buy_actions():
        colony = action.card
        if action.row < 0 or not colony.is_colony() or str(action) in original_buys:
            continue
        price = action.row + 1
        if any(not rival.passed and rival.can_buy_card(colony, price) for rival in after.players if rival is not acting):
            continue
        production = colony.production_value
        recurring = (.55 * production[Resource.GOLD] + .35 * production[Resource.STONE]
                     + .24 * production[Resource.FOOD] + .36 * production[Resource.BOOKS])
        value = colony.points + horizon * recurring - .18 * price
        if value > 0:
            plans.append((value, f'{military} Military opens {colony.name} in the {price}-Gold row for the next action.'))
    return max(plans, default=None)


def advisor_adjustments(match, player, replay_position, scores, pass_score):
    from nations.resources import Resource

    buys = player.buy_actions()
    advisors = [action for action in buys if action.row >= 0 and action.card.is_advisor()]
    if not advisors:
        return {}
    before_production = player.production(projected=True)
    originals = {str(action) for action in buys}
    old_advisors = {card.abbr for card in player.completed_cards() if card.is_advisor()}
    horizon = 1 + .35 * (8 - match.round_number)
    gold_target = 4 + (match.round_number + 1) // 2
    adjustments = {}
    for action in advisors:
        move = str(action)
        if move not in scores:
            continue
        future = advisor_purchase(match, action, replay_position)
        if future is None:
            continue
        after, acting, advisor = future
        production = acting.production(projected=True)
        delta = {resource: production[resource] - before_production[resource]
                 for resource in (Resource.GOLD, Resource.STONE, Resource.FOOD, Resource.BOOKS)}
        price = max(0, player.resources[Resource.GOLD] - acting.resources[Resource.GOLD])
        reserve = acting.resources[Resource.GOLD] + production[Resource.GOLD]
        food_reserve = player.resources[Resource.FOOD] + before_production[Resource.FOOD]
        food_weight = .38 if food_reserve < 2 else .14
        value = horizon * (.55 * delta[Resource.GOLD] + .35 * delta[Resource.STONE]
                           + food_weight * delta[Resource.FOOD] + .34 * delta[Resource.BOOKS])
        value -= price * (.42 if reserve < gold_target else .18)
        retained = {card.abbr for card in acting.completed_cards() if card.is_advisor()}
        replaces_advisor = bool(old_advisors - retained)
        if replaces_advisor:
            value -= .30

        reasons = []
        if delta[Resource.BOOKS] > 0:
            books = delta[Resource.BOOKS]
            reasons.append(f'{advisor.name} adds {books} {"Book" if books == 1 else "Books"} per production after placement.')
        if advisor.abbr == 'Ahz' and advisor.action_available(acting):
            value += .45
            reasons.append('Can swap two progress cards, including between different price rows.')
        for rival in match.players:
            if rival is player or rival.passed or not rival.can_buy_card(action.card, action.row + 1):
                continue
            if any(card.abbr == 'Eg_OK' for card in rival.completed_cards()):
                value += .30
                reasons.append('Takes an advisor Egypt could buy and turn into an Old Kingdom marker worth 2 Books per production.')
                break

        score = scores[move] + min(.85, max(0, .25 * value))
        if not replaces_advisor and pass_score is not None and value > .65 and reserve >= gold_target:
            score = max(score, pass_score + min(.55, .25 * value))
        colony = newly_available_colony(player, after, acting, originals, horizon)
        if colony is not None:
            payoff, reason = colony
            score += min(2.4, .30 + .52 * payoff)
            reasons.append(reason)
        if score > scores[move]:
            if not reasons:
                reasons.append(f'{advisor.name} improves projected production at the current price.')
            adjustments[move] = (score, reasons)
    return adjustments
