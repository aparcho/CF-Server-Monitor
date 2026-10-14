import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('iperf_node', Path(__file__).parents[1] / 'public/iperf-node.py')
node = importlib.util.module_from_spec(spec)
spec.loader.exec_module(node)

class ListenerTests(unittest.TestCase):
    def test_sources_are_public_and_restricted(self):
        with patch.object(node.shutil, 'which', return_value='/sbin/iptables'):
            rules = node.source_rules(['8.8.8.8', '2001:4860:4860::8888'], 'job')
            self.assertEqual([rule[-1] for _, rule in rules], ['DROP', 'DROP', 'ACCEPT', 'ACCEPT'])
            self.assertTrue(all('5202' in rule and '5201' not in rule for _, rule in rules))
            for invalid in (['127.0.0.1'], ['100.64.0.1'], ['8.8.8.8', '1.1.1.1'], ['8.8.8.8; rm']):
                with self.assertRaises(ValueError): node.source_rules(invalid, 'job')

    def test_listener_cleanup_removes_only_owned_rules_and_stops_child(self):
        calls = []
        class Child:
            stopped = False
            def poll(self): return 0 if self.stopped else None
            def terminate(self): self.stopped = True
            def wait(self, timeout):
                if not self.stopped: raise subprocess.TimeoutExpired('iperf3', timeout)
                return 0
        child = Child()
        def run(command):
            calls.append(command)
            return types.SimpleNamespace(stdout='State\n' if command[0] == 'ss' else '')
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'session.json'
            path.write_text(json.dumps({'job_id': 'test', 'sources': ['8.8.8.8']}))
            with patch.object(node, 'run', side_effect=run), patch.object(node.shutil, 'which', return_value='iptables'), \
                patch.object(node.subprocess, 'Popen', return_value=child) as popen, patch.object(node.time, 'sleep'), patch.object(node.signal, 'signal'):
                node.listen(path)
            self.assertEqual(json.loads(path.read_text())['state'], 'stopped')
            self.assertTrue(child.stopped)
            self.assertIn('-4', popen.call_args.args[0])
            insertions = [c for c in calls if '-I' in c]
            deletions = [c for c in calls if '-D' in c]
            self.assertEqual(len(insertions), 2)
            self.assertEqual(len(deletions), 2)
            self.assertTrue(all('CFSM-auto-test' in c for c in deletions))

if __name__ == '__main__': unittest.main()
