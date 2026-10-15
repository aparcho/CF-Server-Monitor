"""验证测速过程中的逐项持久化、上报与补传。"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock
import urllib.error

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('report', Path(__file__).parents[1] / 'scripts/iperf-report.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ProgressTests(unittest.TestCase):
    def run_case(self, failures=(), no_upload=False):
        events = []
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / 'config.json'
            config.write_text(json.dumps({'worker_url': 'https://example.invalid', 'targets': [
                {'id': 'node', 'ipv4': '192.0.2.1', 'ipv6': '2001:db8::1'}]}))
            def probe(server, family, address, direction, duration, port, run_id, output):
                events.append(('probe', family, direction))
                return dict(run_id=run_id, family=family, direction=direction, status='ok', mbps=123)
            calls = 0
            def urlopen(req, timeout):
                nonlocal calls
                calls += 1
                rows = json.loads(req.data)['results']
                events.append(('upload', [(r['family'], r['direction']) for r in rows]))
                summary = list((root / 'results').glob('*/summary.json'))[0]
                self.assertEqual(len(json.loads(summary.read_text())), sum(e[0]=='probe' for e in events))
                if calls in failures:
                    raise urllib.error.URLError('temporary')
                response = MagicMock()
                response.__enter__.return_value.read.return_value = json.dumps({'success': True, 'count': len(rows)}).encode()
                return response
            argv = ['iperf-report', str(config), '--output', str(root / 'results'), '--duration', '5']
            if no_upload:
                argv.append('--no-upload')
            with patch.object(sys, 'argv', argv), patch.dict(report.os.environ, {'IPERF_REPORT_TOKEN': 'test-only'}), patch.object(report, 'probe', side_effect=probe), patch.object(report.time, 'sleep'), patch.object(report.urllib.request, 'urlopen', side_effect=urlopen):
                report.main()
            return events

    def test_each_result_is_persisted_and_uploaded_before_next_probe(self):
        events = self.run_case()
        self.assertEqual([e[0] for e in events], ['probe', 'upload'] * 4)

    def test_failed_upload_does_not_stop_probes_and_is_retried_without_other_rows(self):
        events = self.run_case(failures=(1,))
        self.assertEqual(sum(e[0]=='probe' for e in events), 4)
        self.assertEqual(events[-1], ('upload', [('ipv4', 'download')]))
        self.assertEqual(len([e for e in events if e[0]=='upload']), 5)

    def test_no_upload_mode_keeps_all_local_results(self):
        self.assertEqual([e[0] for e in self.run_case(no_upload=True)], ['probe'] * 4)

    def test_permanent_upload_failure_is_reported_after_all_probes(self):
        with self.assertRaisesRegex(RuntimeError, 'local results'):
            self.run_case(failures=range(1, 9))


if __name__ == '__main__':
    unittest.main()
