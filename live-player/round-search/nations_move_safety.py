"""Adapt engine options for policy observations that restrict available moves."""


def with_move_options(state, options):
    names = tuple(map(str, options))
    return state if tuple(state['next_move_options']) == names else {**state, 'next_move_options': names}
