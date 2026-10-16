"""模拟响应丢失、进程重启和补报，不发起网络或吞吐测试。"""
import importlib.util,json,tempfile,unittest,sys
sys.dont_write_bytecode=True
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('runner',Path(__file__).parents[1]/'scripts/iperf-runner.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
class ReceiptTests(unittest.TestCase):
 def setUp(self):self.enterContext(patch.object(runner,'audit'))
 def test_claim_request_survives_network_failure(self):
  with tempfile.TemporaryDirectory() as temp:
   state=Path(temp);seen=[]
   def fail(*args):seen.append(args[-1].copy());raise runner.ApiFailure('503')
   with patch.object(runner,'api',side_effect=fail):
    with self.assertRaises(runner.ApiFailure):runner.claim_job('url','test',state)
   self.assertTrue((state/'claim-request.json').exists())
   def success(*args):seen.append(args[-1].copy());return {'id':'job','status':'running'}
   with patch.object(runner,'api',side_effect=success):self.assertEqual(runner.claim_job('url','test',state)['id'],'job')
   self.assertEqual(seen[0],seen[1]);self.assertFalse((state/'claim-request.json').exists())
 def test_completion_survives_failure_and_is_not_remeasured(self):
  with tempfile.TemporaryDirectory() as temp:
   state=Path(temp);payload={'id':'job','status':'completed','result_count':4,'cleanup_confirmed':True};path=state/'pending-finish/job.json';runner.write_receipt(path,payload)
   with patch.object(runner,'api',side_effect=runner.ApiFailure('timeout')):
    with self.assertRaises(runner.ApiFailure):runner.flush_completions('url','test',state)
   self.assertEqual(json.loads(path.read_text()),payload)
   with patch.object(runner,'api',return_value={'success':True}) as api:runner.flush_completions('url','test',state)
   self.assertFalse(path.exists());self.assertEqual(api.call_args.args[-1],payload)
 def test_retry_uses_same_payload_and_falls_back_to_ipv4(self):
  payload={'request_id':'same'}
  with patch.object(runner,'api_once',side_effect=[runner.ApiFailure('503'),{'id':'one'}]) as once,patch.object(runner.time,'sleep'):
   self.assertEqual(runner.api('url','test','/claim',payload),{'id':'one'})
  self.assertEqual(once.call_args_list[0].args[3],once.call_args_list[1].args[3]);self.assertEqual(once.call_args_list[1].args[4],'--ipv4')
if __name__=='__main__':unittest.main()
