"""Play the learned replay policy with the same checks in the browser and benchmarks."""

from nations_move_safety import safe_architect_options, with_move_options

def human_prediction(scorer, state, replay_position, match=None):
    return scorer.request({'state': state, 'humanPolicy': True, 'explain': True})


def choose_human_move(scorer, match, replay_position, planned_deployments):
    who = match.next_move_player
    options = safe_architect_options(match, match.next_move_choice, match.next_move_options)
    transfer = planned_deployments.pop(who, None)
    if len(options) == 1:
        return options[0], None
    if match.next_move_choice == 'Which action?' and transfer in options:
        return transfer, None

    prediction = human_prediction(scorer, with_move_options(match.get_state(), options), replay_position, match)
    top = prediction['moves'][0]
    if top.get('nextDeploy'):
        planned_deployments[who] = top['nextDeploy']
    return top['move'], None
