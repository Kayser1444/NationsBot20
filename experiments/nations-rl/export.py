"""Export compatible CPU inference weights for the Nations player service."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
from struct import pack

from model import load_model

LAYERS = ('state_embedding', 'action_embedding', 'context.0', 'action.0',
          'policy.0', 'policy.2', 'value.0', 'value.2')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('--card-index', type=Path, required=True,
                        help='Frozen card-index.json from the training run.')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    model, metadata = load_model(args.checkpoint)
    if model.config != {'state_size': 60, 'action_size': 67} or metadata.get('games', 0) < 1:
        parser.error('Expected a compatible v1 policy/value checkpoint with a game count.')
    info = {'format': 'nations-policy-v1', 'games': metadata['games'],
            'checkpoint_sha256': sha256(args.checkpoint.read_bytes()).hexdigest(),
            'card_index_sha256': sha256(args.card_index.read_bytes()).hexdigest()}
    header = json.dumps(info, separators=(',', ':')).encode('utf-8')
    weights = model.state_dict()
    tensors = (weights[key].detach().numpy().astype('<f4').tobytes()
               for name in LAYERS for key in (name + '.weight', name + '.bias') if key in weights)
    artifact = pack('<I', len(header)) + header + b''.join(tensors)
    digest = sha256(artifact).hexdigest()
    args.output.mkdir(parents=True, exist_ok=True)
    path = args.output / f'rl-{digest[:24]}.nrl'
    if path.exists():
        if path.read_bytes() != artifact:
            raise ValueError('The export filename already exists with different content.')
    else:
        with path.open('xb') as stream:
            stream.write(artifact)
    print(json.dumps({'path': str(path.resolve()), 'sha256': digest, **info}))


if __name__ == '__main__':
    main()
