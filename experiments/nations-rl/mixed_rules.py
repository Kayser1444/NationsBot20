"""Reproducible public match settings for mixed training and paired evaluation."""
from functools import lru_cache
from random import Random


RULE_MIX = 'growth-30-30-30-10-draft-012-wcd70-v1'
POOL = {
    'growth_resources': (1, 1, 1, 2, 2, 2, 3, 3, 3, 4),
    'extra_draft_nations': (0, 1, 2),
    'korea_nerf': (False, True),
    'lincoln_nerf': (False, True),
    'weighted_card_draw': (True,) * 7 + (False,) * 3,
}
DIFFICULTIES = ('Emperor', 'King', 'Prince', 'Chieftain')


@lru_cache(maxsize=256)
def shuffled_block(seed, field, block):
    values = list(POOL[field])
    Random(f'{RULE_MIX}/{seed}/{field}/{block}').shuffle(values)
    return tuple(values)


def rules_for_board(seed, index):
    settings = {'resource_remainder_tiebreaker': True}
    for field, pool in POOL.items():
        block, offset = divmod(index, len(pool))
        value = shuffled_block(seed, field, block)[offset]
        # The frozen engine enables these options by key presence.
        if value is not False:
            settings[field] = value
    return settings
