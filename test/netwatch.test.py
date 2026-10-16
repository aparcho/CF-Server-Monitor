"""验证预算、限量探测、公网路径和异常后的行为。"""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('netwatch',Path(__file__).parents[1]/'scripts/netwatch/netwatch.py')
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)

class Tests(unittest.TestCase):
    def config(self,temp):
        return n.validate({'data_dir':temp,'gateway_ipv4':'192.168.50.1','gateway_ipv6':'fe80::1',
            'nodes':[{'name':'AWS.HKG','id':'one','ipv4':'8.8.8.8','management_host':'root@host',
                      'iperf_enabled':True,'daily_budget_mib':64}], 'shared_lock':temp+'/shared.lock'})
    def test_private_addresses_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            c=self.config(temp);c['nodes'][0]['ipv4']='100.79.59.26'
            with self.assertRaises(ValueError):n.validate(c)
    def test_budget_is_durable_and_enforces_global_and_node_limits(self):
        with tempfile.TemporaryDirectory() as temp:
            c=self.config(temp);db=n.connect(c);self.addCleanup(db.close);node=c['nodes'][0];node['daily_budget_mib']=1
            self.assertIsNotNone(n.reserve(db,c,node,600000))
            db.close();db=n.connect(c);self.addCleanup(db.close)
            self.assertIsNone(n.reserve(db,c,node,600000))
            c['global_budget_mib']=1;node['daily_budget_mib']=10
            self.assertIsNone(n.reserve(db,c,node,600000))
    def test_reverse_uses_receiver_speed_and_server_retransmits(self):
        data={'end':{'sum_received':{'bits_per_second':500000,'bytes':100},'sum_sent':{'bytes':110,'retransmits':0}},
              'server_output_json':{'end':{'sum_sent':{'retransmits':13}}}}
        self.assertEqual(n.parse_iperf(data,'download')['retransmits'],13)
        self.assertEqual(n.parse_iperf(data,'download')['mbps'],.5)
        self.assertEqual(n.parse_iperf(data,'download')['payload_bytes'],110)
        data.pop('server_output_json')
        self.assertIsNone(n.parse_iperf(data,'download')['retransmits'])
    def test_route_drift_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            c=self.config(temp)
            with patch.object(n,'run',return_value=types.SimpleNamespace(returncode=0,stdout='8.8.8.8 via 192.168.50.2 dev eth0')):
                self.assertFalse(n.route_ok(c,'8.8.8.8'))
    def test_probe_is_byte_limited_and_cleanup_runs_on_timeout(self):
        with tempfile.TemporaryDirectory() as temp:
            c=self.config(temp);db=n.connect(c);self.addCleanup(db.close);calls=[];commands=[]
            def remote(node,action,token):
                calls.append(action);return {'cleaned':True}
            def run(command,**kw):
                commands.append(command)
                raise n.subprocess.TimeoutExpired(command,15,output=b'partial')
            with patch.object(n,'route_ok',return_value=True),patch.object(n,'runner_active',return_value=False),patch.object(n,'remote',side_effect=remote),patch.object(n,'run',side_effect=run):
                self.assertTrue(n.speed(db,c,c['nodes'][0],4,'download'))
            self.assertEqual(calls,['start','stop'])
            cmd=commands[0]
            self.assertIn('-n',cmd);self.assertIn('-b',cmd);self.assertIn('-R',cmd);self.assertIn('--rcv-timeout',cmd);self.assertNotIn('-t',cmd)
            self.assertEqual(cmd[cmd.index('-c')+1],'8.8.8.8')
            self.assertEqual(db.execute('SELECT status FROM samples').fetchone()[0],'timeout')
            self.assertGreater(db.execute('SELECT reserved FROM reservations').fetchone()[0],0)
            self.assertEqual(len(list((Path(temp)/'raw').glob('*/*.json'))),1)
    def test_success_settles_real_bytes_and_upload_has_no_receive_timeout(self):
        with tempfile.TemporaryDirectory() as temp:
            c=self.config(temp);db=n.connect(c);self.addCleanup(db.close)
            sample={'end':{'sum_received':{'bits_per_second':2000000,'bytes':250000},'sum_sent':{'bytes':262144,'retransmits':0}}}
            p=types.SimpleNamespace(returncode=0,stdout=json.dumps(sample),stderr='')
            with patch.object(n,'route_ok',return_value=True),patch.object(n,'runner_active',return_value=False),patch.object(n,'remote',return_value={'cleaned':True}),patch.object(n,'run',return_value=p) as command:
                n.speed(db,c,c['nodes'][0],4,'upload')
            cmd=command.call_args.args[0]
            self.assertNotIn('--rcv-timeout',cmd)
            self.assertIn('--snd-timeout',cmd)
            reserved,payload=db.execute('SELECT reserved,payload FROM reservations').fetchone()
            self.assertEqual(payload,262144)
            self.assertEqual(reserved,payload+65536)
            self.assertGreater(payload,c['sentinel_bytes'])

    def test_existing_runner_takes_priority_without_reserving_budget(self):
        with tempfile.TemporaryDirectory() as temp:
            c=self.config(temp);db=n.connect(c);self.addCleanup(db.close)
            with patch.object(n,'route_ok',return_value=True),patch.object(n,'runner_active',return_value=True):
                self.assertFalse(n.speed(db,c,c['nodes'][0],4,'download'))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM reservations').fetchone()[0],0)
    def test_two_slow_samples_schedule_budgeted_confirmation(self):
        with tempfile.TemporaryDirectory() as temp:
            c=self.config(temp);db=n.connect(c);self.addCleanup(db.close)
            sample={'end':{'sum_received':{'bits_per_second':500000,'bytes':262144},'sum_sent':{'bytes':262144,'retransmits':2}},
                    'server_output_json':{'end':{'sum_sent':{'retransmits':2}}}}
            p=types.SimpleNamespace(returncode=0,stdout=json.dumps(sample),stderr='')
            with patch.object(n,'route_ok',return_value=True),patch.object(n,'runner_active',return_value=False),patch.object(n,'remote',return_value={'cleaned':True}),patch.object(n,'run',return_value=p):
                n.speed(db,c,c['nodes'][0],4,'download');n.speed(db,c,c['nodes'][0],4,'download')
            state=n.state(db,'speed:AWS.HKG:4:download')
            self.assertEqual(state['weak_streak'],2);self.assertTrue(state['confirm_pending'])
    def test_absent_temporary_listener_is_idempotent_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            code=n.REMOTE.replace("pathlib.Path('/tmp')",f"pathlib.Path({temp!r})")
            output=io.StringIO()
            payload=json.dumps({'token':'a'*32,'port':5202,'action':'stop'})
            with patch.object(sys,'argv',['helper',payload]),patch.object(n.subprocess,'check_output',return_value='State Recv-Q Send-Q Local Address:Port\n'),patch.object(n.subprocess,'Popen') as spawn,patch.object(sys,'stdout',output):
                with self.assertRaises(SystemExit) as stop:exec(code,{})
            self.assertEqual(stop.exception.code,0)
            self.assertTrue(json.loads(output.getvalue())['cleaned'])
            spawn.assert_not_called()

    def test_shared_lock_prevents_overlap_and_releases_for_next_probe(self):
        with tempfile.TemporaryDirectory() as temp:
            c=self.config(temp)
            with open(c['shared_lock'],'a') as existing:
                n.fcntl.flock(existing,n.fcntl.LOCK_EX)
                with patch.object(n,'runner_active') as active:
                    with n.measurement_lock(c) as acquired:self.assertFalse(acquired)
                    active.assert_not_called()
            with patch.object(n,'runner_active',return_value=False):
                with n.measurement_lock(c) as acquired:self.assertTrue(acquired)

if __name__=='__main__':unittest.main()
