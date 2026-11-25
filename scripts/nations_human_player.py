"""Play the learned replay policy with the same checks in the browser and benchmarks."""

from nations_action_prompt import is_main_action
def human_prediction(scorer, state, replay_position, match=None):
    return scorer.request({'state': state, 'humanPolicy': True, 'explain': True})


def choose_human_move(scorer, match, replay_position, planned_deployments):
    who = match.next_move_player
    options = match.next_move_options
    transfer = planned_deployments.pop(who, None)
    if len(options) == 1:
        return options[0], None
    if is_main_action(match.next_move_choice) and transfer in options:
        return transfer, None

    prediction = human_prediction(scorer, match.get_state(), replay_position, match)
    top = prediction['moves'][0]
    if top.get('nextDeploy'):
        planned_deployments[who] = top['nextDeploy']
    return top['move'], None
