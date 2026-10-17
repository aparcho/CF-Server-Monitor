import importlib.util
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('nikki_watch',Path(__file__).parents[1]/'scripts/nikki-watch.py')
watch=importlib.util.module_from_spec(spec);spec.loader.exec_module(watch)

class NikkiWatchTest(unittest.TestCase):
    def test_actual_chain_not_current_selector_and_relay_first_hop(self):
        proxies={'direct':{'server':'hks.example','ip-version':'ipv6'},'relay':{'server':'hk.example','ip-version':'ipv6'}}
        connections=[{'id':'1','chains':['direct','HKS','Proxy'],'download':10},{'id':'2','chains':['relay','HKS','Proxy'],'upload':20}]
        routes,unknown=watch.map_connections(connections,proxies,{'hks.example':'hks','hk.example':'hk'},{},1000)
        self.assertEqual(routes,[{'server_id':'hk','family':'ipv6','connections':1},{'server_id':'hks','family':'ipv6','connections':1}]);self.assertEqual(unknown,0)
    def test_no_guessing_preferred_family_or_chained_proxy(self):
        self.assertEqual(watch.endpoint_family({'server':'161.33.195.120','ip-version':'ipv6-prefer'}),'ipv4')
        self.assertIsNone(watch.endpoint_family({'server':'example.com','ip-version':'ipv6-prefer'}))
        routes,n=watch.map_connections([{'id':'1','chains':['x'],'download':1}],{'x':{'server':'1.1.1.1','dialer-proxy':'relay'}},{'1.1.1.1':'x'},{},0)
        self.assertEqual(routes,[]);self.assertEqual(n,1)
    def test_idle_connections_expire_and_missing_connections_are_removed(self):
        activity={};cs=[{'id':'1','chains':['x'],'download':1}];proxies={'x':{'server':'1.1.1.1'}};endpoints={'1.1.1.1':'x'}
        self.assertEqual(len(watch.map_connections(cs,proxies,endpoints,activity,0)[0]),1)
        self.assertEqual(watch.map_connections(cs,proxies,endpoints,activity,121)[0],[])
        watch.map_connections([],proxies,endpoints,activity,122);self.assertEqual(activity,{})

if __name__=='__main__':unittest.main()
