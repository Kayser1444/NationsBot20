"""Public policy features for the mixed-settings continuation."""
import numpy as np

from position_encoding import MARKET_SLOTS
from wonder_encoding import WonderSlotEncoder


SCHEMA = 'current-position-mixed-settings-v1'
KOREA = ('K_S', 'K_S_Nerf')
LINCOLN = ('AhLc', 'AhLc_Nerf')


class MixedSettingsEncoder(WonderSlotEncoder):
    extra_mixed_state_size = 3 + 2 * (len(KOREA) + len(LINCOLN)) + len(MARKET_SLOTS) * len(LINCOLN)
    extra_mixed_action_size = len(KOREA) + len(LINCOLN)

    def __init__(self, cards):
        super().__init__(cards)
        # Printed stats are shared. Keep the original feature columns in place
        # for warm starts, then add the rule-changing variant columns.
        if 'AhLc' in cards:
            self.cards = {**cards, 'AhLc_Nerf': dict(cards['AhLc'])}

    def state(self, state):
        numbers, tokens = super().state(state)
        actor = state['next_move_player']
        rival = next(name for name in state['players'] if name != actor)
        growth = state.get('growth_allowances', {})
        features = [growth.get(actor, 0) / 4, growth.get(rival, 0) / 4,
                    float(state.get('weighted_card_draw', False))]
        for name in (actor, rival):
            player = state['players'][name]
            active = player.get('slots', {}).values()
            held = player.get('cards', {})
            features.extend(float(cid in active) for cid in KOREA)
            features.extend(float(cid in held or cid in active) for cid in LINCOLN)
        market = state.get('progress_board', {})
        features.extend(float(market.get(slot) == cid) for slot in MARKET_SLOTS for cid in LINCOLN)
        return np.concatenate((numbers, np.asarray(features, dtype=np.float32))), tokens

    def move_profile(self, state, player, move):
        nation_slots = state.get('nations', {}).get(move, {}).get('slots', {}).values()
        return super().move_profile(state, player, move) + [float(cid in nation_slots) for cid in KOREA]

    def move_card_features(self, cid, move):
        return [*super().move_card_features(cid, move), *[float(cid == variant) for variant in LINCOLN]]
