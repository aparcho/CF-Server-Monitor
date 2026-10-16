"""monitor 上报游标、断线补传和配置应用验证。"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch,MagicMock
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('watch',Path(__file__).parents[1]/'scripts/netwatch/netwatch.py')
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)
class SyncTests(unittest.TestCase):
 def test_only_ack_advances_cursor_and_no_private_or_excluded_node_data_is_sent(self):
  with tempfile.TemporaryDirectory() as temp:
   p=Path(temp);(p/'token').write_text('test-only')
   config=n.validate({'data_dir':temp,'worker_url':'https://monitor.test','token_file':str(p/'token'),'gateway_ipv4':'192.168.50.1','gateway_ipv6':'fe80::1','config_path':str(p/'config.json'),'nodes':[{'name':'AWS.HKG','id':'hkg','ipv4':'8.8.8.8','management_host':'root@control','iperf_enabled':True}]})
   db=n.connect(config);self.addCleanup(db.close)
   n.save(db,'AWS.HKG',4,'download','sentinel','ok',{'mbps':2,'target_bps':2000000,'payload_bytes':262144,'raw':'/root/private','management_host':'secret'})
   n.save(db,'WAWO.HK',6,'download','sentinel','ok',{'mbps':2,'target_bps':2000000})
   opener=MagicMock();captured=[]
   def fail(req,timeout):captured.append(json.loads(req.data));raise TimeoutError()
   opener.open.side_effect=fail
   with patch.object(n.urllib.request,'build_opener',return_value=opener):
    with self.assertRaises(TimeoutError):n.sync_monitor(db,config)
    self.assertIsNone(n.state(db,'upload_cursor'))
    response=MagicMock();response.__enter__.return_value.read.return_value=json.dumps({'success':True,'accepted':1,'settings':[{'server_id':'hkg','enabled':0,'interval_seconds':600,'daily_budget_mib':256}]}).encode()
    def good(req,timeout):captured.append(json.loads(req.data));return response
    opener.open.side_effect=good
    n.sync_monitor(db,config)
   self.assertEqual(n.state(db,'upload_cursor'),2)
   self.assertEqual(captured[0]['samples'][0]['id'],captured[1]['samples'][0]['id'])
   self.assertEqual(len(captured[1]['samples']),1)
   self.assertNotIn('raw',captured[1]['samples'][0]['data'])
   self.assertNotIn('management_host',captured[1]['samples'][0]['data'])
   self.assertFalse(config['nodes'][0]['watch_enabled'])
   self.assertEqual(json.loads((p/'config.json').read_text())['nodes'][0]['daily_budget_mib'],256)
 def test_explicit_deletion_removes_only_deleted_node_and_empty_config_can_restart(self):
  with tempfile.TemporaryDirectory() as temp:
   p=Path(temp);(p/'token').write_text('test-only')
   config=n.validate({'data_dir':temp,'worker_url':'https://monitor.test','token_file':str(p/'token'),'gateway_ipv4':'192.168.50.1','gateway_ipv6':'fe80::1','config_path':str(p/'config.json'),'nodes':[{'name':'AWS.TYO','id':'tyo','ipv4':'8.8.8.8'}]})
   db=n.connect(config);self.addCleanup(db.close)
   n.save(db,'AWS.TYO',4,'both','quality','ok',{'ping_sent':3,'ping_received':3,'ping_ms':[1,2,3]})
   n.save(db,'AWS.HKG',4,'both','quality','ok',{'ping_sent':3,'ping_received':3,'ping_ms':[1,2,3]})
   response=MagicMock();response.__enter__.return_value.read.return_value=json.dumps({'success':True,'accepted':1,'settings':[],'deleted_ids':['tyo']}).encode()
   opener=MagicMock();opener.open.return_value=response
   with patch.object(n.urllib.request,'build_opener',return_value=opener): n.sync_monitor(db,config)
   self.assertEqual(config['nodes'],[])
   self.assertEqual(db.execute("SELECT COUNT(*) FROM samples WHERE node='AWS.TYO'").fetchone()[0],0)
   self.assertEqual(db.execute("SELECT COUNT(*) FROM samples WHERE node='AWS.HKG'").fetchone()[0],1)
   self.assertEqual(n.validate(json.loads((p/'config.json').read_text()))['nodes'],[])
if __name__=='__main__':unittest.main()
