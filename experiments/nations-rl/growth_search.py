"""Offline comparison of growth choices with a neutral, still-hidden event."""
from collections import Counter
from math import floor
from statistics import mean, median
from time import perf_counter

from nations.event_cards import all_event_cards
from nations_lookahead import SearchBoundary, SearchBudget
from nations_microsearch import ADMIN, ranked_choices
from nations_round_search import rollout_round


GROWTH = 'Take what for growth?'


def forecasts_by_age():
    forecasts = []
    for age in range(1, 5):
        events = [card for card in all_event_cards if card.age == age]
        average_famine = mean(-card.famine for card in events)
        median_architects = median(1 + card.architects for card in events)
        forecasts.append({'average_famine': average_famine, 'famine': floor(average_famine + .5),
                          'median_architects': median_architects, 'architects': floor(median_architects + .5)})
    return forecasts


def search_growth(match, state, options, predict, *, forecast, value_score, observe, seconds):
    """Give each legal choice one greedy path to settlement. Favor policy ties."""
    started = perf_counter()
    deadline = started + seconds
    legal = tuple(dict.fromkeys(str(option) for option in options if str(option) not in ADMIN))
    choices = ranked_choices(GROWTH, legal, predict(state), all_moves=True)
    counts = Counter({'growth searched': 1})
    replay = match.get_replay()
    scorer_owner = state['next_move_player']
    values = []
    try:
        for move in choices:
            settled = rollout_round(replay, state, (move,), predict, lambda *_: None, deadline,
                                    observe=observe, growth_forecast=forecast)
            counts['growth settled lines'] += 1
            if settled['sampled_draw']:
                raise SearchBoundary('Victoria Falls')
            values.append(value_score(settled, scorer_owner))
    except SearchBoundary as error:
        counts[f'growth fallback: {error}'] += 1
        return None, counts, perf_counter() - started
    except SearchBudget:
        counts['growth fallback: budget'] += 1
        return None, counts, perf_counter() - started

    best = max(range(len(choices)), key=values.__getitem__)
    counts['growth compared'] += 1
    if best:
        counts['growth changed'] += 1
        before = 'worker' if '[Worker]' in choices[0] else 'resources'
        after = 'worker' if '[Worker]' in choices[best] else 'resources'
        counts[f'growth changed: {before} to {after}'] += 1
    # Returning None lets the normal policy handle unchanged decisions.
    return choices[best] if best else None, counts, perf_counter() - started
