import importlib.util,pathlib,subprocess,unittest,json
s=importlib.util.spec_from_file_location('c',pathlib.Path(__file__).parents[1]/'scripts/iperf-control.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Control(unittest.TestCase):
 def test_lost_start_reply_reconciles_without_second_start(self):
  calls=[];logs=[]
  def remote(host,script,**kw):
   calls.append(script)
   if 'systemd-run' in script:raise subprocess.TimeoutExpired('ssh',45)
   return json.dumps({'state':'ready' if len(calls)>2 else 'absent','unit_active':len(calls)>2})
  c=m.Listener(remote,lambda phase,**d:logs.append(phase),'root@node',None,'11111111-1111-4111-8111-111111111111',['1.1.1.1']);c.start()
  self.assertEqual(sum('systemd-run' in x for x in calls),1);self.assertIn('listener_start_reply_lost',logs)
 def test_failed_start_is_not_reported_as_ready(self):
  c=m.Listener(lambda *a,**k:json.dumps({'state':'failed','error':'port 5202 busy'}),lambda *a,**k:None,'root@node',None,'11111111-1111-4111-8111-111111111111',['1.1.1.1'])
  with self.assertRaisesRegex(RuntimeError,'port 5202 busy'):c.start()
 def test_cleanup_timeout_reconciles_same_unit(self):
  calls=[]
  def remote(host,script,**kw):
   calls.append(script)
   if len(calls)==1:raise subprocess.TimeoutExpired('ssh',45)
   return 'cleanup_confirmed'
  c=m.Listener(remote,lambda *a,**k:None,'root@node',None,'11111111-1111-4111-8111-111111111111',['1.1.1.1']);c.stop();self.assertEqual(calls[0],calls[1])
if __name__=='__main__':unittest.main()
