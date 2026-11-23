"""Remove optional hires that would finish a wonder with nowhere to place it."""

FREE_ARCHITECT = ('Hire [Architect] for free?', 'Hire 1 [Architect] for free?')
QIN_DYNASTY = 'Special of "Qin Dynasty"'


def safe_architect_options(match, prompt, options):
    if prompt not in (*FREE_ARCHITECT, 'Which action?'):
        return options
    player = match.current_player
    project = player.wonders_under_construction[0]
    stages = getattr(project, 'stage_costs', ())
    if (not stages or project.completed_stages + 1 != len(stages)
            or player.replaceable_wonder_spaces()):
        return options
    if prompt in FREE_ARCHITECT:
        return tuple(option for option in options if str(option) != 'Yes')
    return tuple(option for option in options
                 if str(option) not in (QIN_DYNASTY, 'Hire') and not str(option).startswith('Hire from '))


def with_move_options(state, options):
    names = tuple(map(str, options))
    return state if tuple(state['next_move_options']) == names else {**state, 'next_move_options': names}
