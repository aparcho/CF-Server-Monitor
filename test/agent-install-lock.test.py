"""验证 apt 锁等待、超时与真实安装错误的区别，不调用系统包管理器。"""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

SCRIPT=Path(__file__).parents[1]/'public/agent-install-iperf.sh'
FUNCTION=SCRIPT.read_text().split('apt_with_lock_wait() {',1)[1].split("\nbase=''",1)[0]
class AptLockTests(unittest.TestCase):
 def run_case(self,mode):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory)
   helpers={
    'apt-get':'''#!/bin/sh
n=$(cat "$CASE_DIR/count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$CASE_DIR/count"
case "$CASE_MODE" in
 transient) [ "$n" -gt 1 ] && exit 0; echo 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 2334 (unattended-upgr)' >&2;;
 permanent) echo 'E: Unable to acquire the dpkg frontend lock' >&2;;
 real_error) echo 'E: Unable to locate package iperf3' >&2;;
esac
exit 100
''',
    'date':'''#!/bin/sh
n=$(cat "$CASE_DIR/clock" 2>/dev/null || echo 0); step=1; [ "$CASE_MODE" = permanent ] && step=300; echo $((n+step)) > "$CASE_DIR/clock"; echo "$n"
''',
    'sleep':'#!/bin/sh\nexit 0\n'}
   for name,source in helpers.items():
    path=root/name;path.write_text(source);path.chmod(0o700)
   result=subprocess.run(['sh','-c','set -eu\ntask_dir="$CASE_DIR"\napt_with_lock_wait() {'+FUNCTION+'\napt_with_lock_wait install -y python3 iperf3 iptables'],env={**os.environ,'CASE_DIR':directory,'CASE_MODE':mode,'PATH':directory+':'+os.environ['PATH']},text=True,capture_output=True,timeout=5)
   return result,int((root/'count').read_text())
 def test_lock_is_retried_until_released(self):
  result,count=self.run_case('transient');self.assertEqual(result.returncode,0);self.assertEqual(count,2);self.assertIn('10 秒后重试',result.stdout)
 def test_lock_timeout_is_bounded(self):
  result,count=self.run_case('permanent');self.assertNotEqual(result.returncode,0);self.assertEqual(count,1);self.assertIn('5 分钟',result.stderr)
 def test_other_errors_are_not_misclassified_as_lock(self):
  result,count=self.run_case('real_error');self.assertNotEqual(result.returncode,0);self.assertEqual(count,1);self.assertIn('Unable to locate package',result.stderr);self.assertNotIn('10 秒后重试',result.stdout)
if __name__=='__main__':unittest.main()
