"""Local integration checks using the real engine; no live Tabony requests."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT.parent/'nations-server/Nations')]
os.environ['NATIONS_PLAYER_WEIGHTS']=str(ROOT/'live-player/trained-weights.json')
spec=importlib.util.spec_from_file_location('native_local_server',ROOT/'scripts/serve-nations.py')
server_module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)
import native_nations


class NativeLocalTests(unittest.TestCase):
    def setUp(self):
        directory=ROOT/'.data/nations-native-tests'
        directory.mkdir(parents=True,exist_ok=True)
        self.temporary=tempfile.TemporaryDirectory(prefix='case-',dir=directory)
        self.assertTrue(Path(self.temporary.name).resolve().is_relative_to(directory.resolve()))
        policy=Path(self.temporary.name)/'policy.json'
        policy.write_text(json.dumps({'schemaVersion':1,'type':'human-move-softmax',
                                      'weights':{'growth/Gold':8,'draft/Vikings':8}}),encoding='utf-8')
        self.game=server_module.LocalGame(Path(self.temporary.name)/'game.replay',400,human_policy=policy)
        self.server=server_module.ThreadingHTTPServer(('127.0.0.1',0),server_module.handler_for(self.game))
        self.thread=Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.origin=f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()
        self.game.scorer.close();self.temporary.cleanup()

    def request(self,path,body=None,origin=None):
        headers={}
        if body is not None:
            headers={'Origin':origin or self.origin,'Content-Type':'application/json'}
            body=json.dumps({'revision':self.game.revision,**body}).encode()
        try:
            with urlopen(Request(self.origin+path,data=body,headers=headers),timeout=10) as response:
                return response.status,response.read()
        except HTTPError as error:
            return error.code,error.read()

    def test_native_shell_and_game_actions(self):
        code,body=self.request('/')
        self.assertEqual(code,200)
        self.assertIn(b'id="content"',body)
        self.assertIn(b'id="game"',body)
        self.assertNotIn(b'{%',body)
        self.assertIn(b'/native-transport.js',body)
        before=self.game.match.move_number
        choice=str(self.game.options[0])
        self.assertEqual(self.request('/api/move',{'move':choice})[0],200)
        self.assertGreater(self.game.match.move_number,before)
        self.assertEqual(self.request('/api/move',{'move':'Confirm'},origin='https://evil.test')[0],403)
        self.assertEqual(self.request('/api/move',{'move':'Confirm','revision':'stale'})[0],409)
        self.assertEqual(self.request('/api/new',{'difficulty':'hard'})[0],400)

    def test_medium_can_take_over_an_existing_game_and_make_legal_moves(self):
        saved=self.game.save.read_bytes()
        code,body=self.request('/api/settings',{'difficulty':'medium'})
        self.assertEqual(code,200,body.decode())
        self.assertEqual(json.loads(body)['difficulty'],'medium')
        self.assertEqual(self.game.save.read_bytes(),saved)
        self.assertEqual(json.loads(self.game.save.with_suffix('.meta.json').read_text())['difficulty'],'medium')
        # Complete human decisions until the actual engine calls Medium on a
        # branching decision. Use the fixture seed with Japan and Greece.
        for _ in range(12):
            options=list(map(str,self.game.options))
            move=next((value for value in ('Confirm','2 [Gold]','Pass') if value in options),options[0])
            code,body=self.request('/api/move',{'move':move})
            self.assertEqual(code,200,body.decode())
            if any(row['search'] and row['search']['completedDepth'] for row in json.loads(body)['bot_decisions']):
                break
        else:
            self.fail('No Medium search was used for an accepted engine move.')

    def test_installed_human_policy_chooses_the_next_bot_growth(self):
        code,body=self.request('/api/settings',{'difficulty':'human'})
        self.assertEqual(code,200,body.decode())
        self.assertIn('human',json.loads(body)['difficulties'])
        for _ in range(8):
            code,body=self.request('/api/move',{'move':str(self.game.options[0])})
            self.assertEqual(code,200,body.decode())
            growth=next((row for row in json.loads(body)['bot_decisions'] if row['choice']=='Take what for growth?'),None)
            if growth:
                self.assertEqual(growth['difficulty'],'human')
                self.assertEqual(growth['move'],'2 [Gold]')
                return
        self.fail('No bot growth move was recorded.')

    def test_human_policy_keeps_horse_archer_when_placing_city_wall(self):
        replay = ('seed 0194\nplayer You\ngrowth_resources 2\nplayer NationsBot\ngrowth_resources 2\n\n'
                  'Mongolia\nConfirm\n2 [Gold]\nConfirm\n2 [Gold]\nConfirm\n'
                  'Buy P13\nBM4\nConfirm\nBuy P23\n')
        self.game.set_difficulty('human')
        self.game.advance(replay=replay)
        slots = self.game.match.get_state()['players']['NationsBot']['slots']
        self.assertEqual(slots['BM3'], 'Mg_HsAr')
        self.assertEqual(slots['BM4'], 'CtWl')
        self.assertEqual(self.request('/api/position',{'command':{'to':10}})[0],200)
        code,body=self.request('/api/analyze')
        self.assertEqual(code,200,body.decode())
        placements=json.loads(body)['placement']
        self.assertEqual([(p['move'],p['military_after_deploy']) for p in (placements[0],placements[-1])],
                         [('BM4',5),('BM3',0)])

    def test_persia_sassanid_first_round_activation_and_followup_gold_in_real_engine(self):
        replay=(ROOT/'live-player/fixtures/persia-sassanid-opening.replay').read_text(encoding='utf-8')
        moves=replay.partition('\n\n')[2].splitlines()
        activation=moves.index('Play "Sassanid Empire"')
        first=moves.index('Turmoil')
        second=moves.index('Turmoil',activation)
        def player_at(number):
            return self.game.replay_position(replay,number).get_state()['players']['Player0']
        before=player_at(first)
        played=player_at(activation+1)
        self.assertEqual(played['resources'].get('[Stability]',0),before['resources'].get('[Stability]',0)-2)
        self.assertIn('Ps_SE',played['slots'].values())
        before=player_at(second)
        after=player_at(second+2)
        self.assertEqual(after['resources']['[Gold]'],before['resources']['[Gold]']+2)
        self.assertEqual(after['resources'].get('[Stability]',0),before['resources'].get('[Stability]',0))
        self.assertEqual(after['turmoil'],before['turmoil'])

    def test_human_actions_prefer_funded_war_and_avoid_unprotected_revolt(self):
        replay=(ROOT/'live-player/fixtures/mongolia-oracle-opening.replay').read_text(encoding='utf-8')
        # Reproduce the two learned preferences without requiring a trained file
        # on every machine that runs these tests.
        self.game.scorer.request({'loadHumanPolicy':{'schemaVersion':1,'type':'human-move-softmax',
            'weights':{'buy/card/Orc':1.2,'buy/card/PlpW':1,'turmoil':.45,'pass':.1,
                       'undeploy/military':-1,'undeploy/building':-1}}})
        self.game.set_difficulty('human')
        for decision,expected in [(70,'Buy P12'),(74,'Undeploy from BM4')]:
            with self.subTest(decision=decision):
                prefix=self.game.replay_position(replay,decision).get_replay()
                self.game.advance(replay=prefix)
                actual=self.game.match.get_replay().removeprefix(prefix).splitlines()[0]
                self.assertEqual(actual,expected)
        # On the stronger line, the war is already settled at strength 5.
        # The planned second step must run before control returns to Egypt.
        prefix=self.game.replay_position(replay,70).get_replay()+'Buy P12\nConfirm\nHire\nConfirm\n'
        self.game.advance(replay=prefix)
        actions=self.game.match.get_replay().removeprefix(prefix).splitlines()
        self.assertEqual(actions,['Undeploy from BM4','Deploy to BM1','Confirm'])
        mongolia=self.game.match.get_state()['players']['NationsBot']
        self.assertEqual(mongolia['production']['[Gold]'],5)
        self.assertEqual(mongolia['resources'].get('[Stability]',0),0)
        self.assertEqual(mongolia['resources']['[Military]'],5)

    def test_human_policy_values_advisor_production_and_unlocked_colony(self):
        replay=(ROOT/'live-player/fixtures/mongolia-advisors.replay').read_text(encoding='utf-8')
        self.game.scorer.request({'loadHumanPolicy':{'schemaVersion':1,'type':'human-move-softmax',
            'weights':{'buy/card/Orc':.8,'buy/card/AbBk':.2,'buy/card/Ahz':-.26,'buy/card/AnKn':.06,
                       'buy/colony':1.3,'pass':.2}}})
        self.game.set_difficulty('human')
        for decision,expected in [(104,'Buy P24'),(132,'Buy P22')]:
            with self.subTest(decision=decision):
                prefix=self.game.replay_position(replay,decision).get_replay()
                self.game.advance(replay=prefix)
                move=self.game.match.get_replay().removeprefix(prefix).splitlines()[0]
                self.assertEqual(move,expected)
        state=self.game.match.get_state()
        self.assertEqual(state['players']['NationsBot']['production']['[Books]'],2)
        self.assertNotIn('Buy P22',state['next_move_options'])
        prefix=self.game.replay_position(replay,104).get_replay()+'Buy P24\nConfirm\nBuy P21\nConfirm\n'
        self.game.advance(replay=prefix)
        self.assertEqual(self.game.match.get_replay().removeprefix(prefix).splitlines()[0],'Buy P14')
        self.assertEqual(self.game.match.get_state()['players']['NationsBot']['slots']['C2'],'Prs')

    def test_public_opening_is_read_only_and_explainable(self):
        saved=self.game.save.read_bytes()
        self.assertEqual(self.request('/api/review',{'fixture':'3272'})[0],200)
        self.assertEqual(self.request('/api/position',{'command':{'to':13}})[0],200)
        code,body=self.request('/api/analyze')
        self.assertEqual(code,200)
        data=json.loads(body)
        self.assertEqual(data['moves'][0]['move'],'Deploy to BM2')
        self.assertEqual(data['reading']['colonies'][0]['rivalDeadline'],3)
        self.assertGreaterEqual(data['medium']['completedDepth'],1)
        predicted={row['move']:row['score'] for row in data['medium']['moves']}
        self.assertGreater(predicted['Deploy to BM3'],predicted['Deploy to BM2'])
        self.assertEqual(self.request('/api/move',{'move':'Deploy to BM3'})[0],400)
        self.assertEqual(self.request('/api/branch',{'human':'Kayser'})[0],400)
        self.assertEqual(self.game.save.read_bytes(),saved)

    def test_replay_import_navigation_and_local_branch_preserve_archive(self):
        for _ in range(4):
            choice=next(str(option) for option in self.game.options if str(option) not in ['UNDO','Resign'])
            self.game.advance(replay=self.game.match.get_replay(),move=choice)
        replay=self.game.match.get_replay()
        code,body=self.request('/api/review',{'replay':replay})
        self.assertEqual(code,200,body.decode())
        self.assertEqual(self.request('/api/position',{'command':{'to':0}})[0],200)
        self.assertEqual(self.game.state()['move_number'],0)
        self.assertEqual(self.request('/api/branch',{'human':'You'})[0],200)
        self.assertEqual(self.game.state()['view']['mode'],'play')
        archives=list((self.game.save.parent/'archives').glob('*.replay'))
        self.assertEqual(len(archives),1)
        self.assertEqual(archives[0].read_text(encoding='utf-8'),replay)

    def test_bad_replays_and_asset_paths_do_not_escape_local_storage(self):
        self.assertEqual(self.request('/api/review',{'replay':'not a replay\n\n'})[0],400)
        bad='seed 0190\nplayer <script>\nplayer Other\n\n'
        self.assertEqual(self.request('/api/review',{'replay':bad})[0],400)
        with patch.object(native_nations,'urlopen',side_effect=AssertionError('No network expected')):
            for path in ['/static/public/Nations/../secret.jpg','/static/public/Nations/cards\\secret.jpg','/static/public/Nations/cards/file.html']:
                with self.assertRaises(ValueError): native_nations.cached_asset(path)


if __name__=='__main__': unittest.main()
