"""Small shared observation encoder, candidate policy head and win-value head."""
import numpy as np
import torch
from torch import nn

from encoding import BUCKETS, VERSION


class PolicyValue(nn.Module):
    def __init__(self, state_size, action_size):
        super().__init__()
        self.config = {'state_size': state_size, 'action_size': action_size}
        self.state_embedding = nn.Embedding(BUCKETS, 24, padding_idx=0)
        self.action_embedding = nn.Embedding(BUCKETS, 24, padding_idx=0)
        self.context = nn.Sequential(nn.Linear(state_size + 24, 64), nn.Tanh())
        self.action = nn.Sequential(nn.Linear(action_size + 24, 48), nn.Tanh())
        self.policy = nn.Sequential(nn.Linear(112, 64), nn.Tanh(), nn.Linear(64, 1))
        self.value = nn.Sequential(nn.Linear(64, 32), nn.Tanh(), nn.Linear(32, 1))

    @staticmethod
    def pool(table, tokens):
        return table(tokens).sum(-2) / tokens.ne(0).sum(-1, keepdim=True).clamp_min(1).sqrt()

    def forward(self, batch):
        context = self.context(torch.cat((batch['sn'], self.pool(self.state_embedding, batch['st'])), -1))
        action = self.action(torch.cat((batch['an'], self.pool(self.action_embedding, batch['at'])), -1))
        repeated = context[:, None, :].expand(-1, action.shape[1], -1)
        logits = self.policy(torch.cat((repeated, action), -1)).squeeze(-1)
        logits = logits.masked_fill(~batch['mask'], -1e9)
        return logits, self.value(context).squeeze(-1)


def collate(rows):
    count = max(len(row['an']) for row in rows)
    batch = {key: torch.from_numpy(np.stack([r[key] for r in rows])) for key in ('sn', 'st')}
    for key in ('an', 'at'):
        values = np.zeros((len(rows), count, rows[0][key].shape[-1]), dtype=rows[0][key].dtype)
        for i, row in enumerate(rows):
            values[i, :len(row[key])] = row[key]
        batch[key] = torch.from_numpy(values)
    batch['st'] = batch['st'].long()
    batch['at'] = batch['at'].long()
    batch['mask'] = torch.arange(count)[None, :] < torch.tensor([len(r['an']) for r in rows])[:, None]
    return batch


def save_model(path, model, metadata):
    torch.save({'encoding_version': VERSION, 'config': model.config,
                'parameters': model.state_dict(), 'metadata': metadata}, path)


def load_model(path):
    checkpoint = torch.load(path, map_location='cpu', weights_only=True)
    if checkpoint['encoding_version'] != VERSION:
        raise ValueError('Unsupported feature encoding version')
    model = PolicyValue(**checkpoint['config'])
    model.load_state_dict(checkpoint['parameters'])
    return model, checkpoint['metadata']
