import importlib.util
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('nikki_watch',Path(__file__).parents[1]/'scripts/nikki-watch.py')
watch=importlib.util.module_from_spec(spec);spec.loader.exec_module(watch)

class NikkiWatchTest(unittest.TestCase):
    def setUp(self):
        self.proxies={'direct':{'server':'hks.example','ip-version':'ipv6'},'HK-to-HKS':{'server':'hk.example','ip-version':'ipv6'},'oci':{'server':'1.1.1.1'}}
        self.groups={'Proxy':{'type':'Selector','now':'HKS'},'HKS':{'type':'Selector','now':'direct'},'Emby':{'type':'Selector','now':'oci'},'Unused':{'type':'Selector','now':'HK-to-HKS'}}
        self.config={'endpoints':{'hks.example':'hks','hk.example':'hk','1.1.1.1':'oci'}}
    def snapshot(self,connections=(),activity=None,now=1000,roots=('Proxy','Emby'),mode='rule'):
        return watch.map_routes(connections,self.proxies,self.groups,roots,mode,self.config,activity if activity is not None else {},now)
    def test_rule_referenced_nested_selections_only_not_unused_groups(self):
        routes,unknown=self.snapshot()
        self.assertEqual(routes,[{'server_id':'hks','family':'ipv6','connections':0,'selected':True},{'server_id':'oci','family':'ipv4','connections':0,'selected':True}]);self.assertEqual(unknown,0)
    def test_actual_old_connection_and_selected_new_route_are_separate_first_hop_only(self):
        self.groups['HKS']['now']='HK-to-HKS'
        cs=[{'id':'1','chains':['direct','HKS','Proxy'],'download':10}];activity={}
        routes,_=self.snapshot(cs,activity)
        self.assertEqual(routes,[{'server_id':'hk','family':'ipv6','connections':0,'selected':True},{'server_id':'oci','family':'ipv4','connections':0,'selected':True}])
        cs[0]['download']=20
        routes,unknown=self.snapshot(cs,activity,1060)
        self.assertEqual(routes,[{'server_id':'hk','family':'ipv6','connections':0,'selected':True},{'server_id':'hks','family':'ipv6','connections':1,'selected':False},{'server_id':'oci','family':'ipv4','connections':0,'selected':True}])
        self.assertEqual(unknown,0)
    def test_relay_active_marks_hk_entry_not_hks_exit(self):
        self.groups['HKS']['now']='HK-to-HKS';cs=[{'id':'1','chains':['HK-to-HKS','HKS'],'upload':1}];activity={}
        self.snapshot(cs,activity);cs[0]['upload']=2
        routes,_=self.snapshot(cs,activity,1060,roots=('Proxy',))
        self.assertEqual(routes,[{'server_id':'hk','family':'ipv6','connections':1,'selected':True}])
    def test_no_guessing_preferred_family_and_dialer_uses_physical_first_entry(self):
        self.assertEqual(watch.endpoint_family({'server':'161.33.195.120','ip-version':'ipv6-prefer'}),'ipv4')
        self.assertIsNone(watch.endpoint_family({'server':'example.com','ip-version':'ipv6-prefer'}))
        self.proxies['direct']['dialer-proxy']='HK-to-HKS'
        routes,n=self.snapshot(roots=('Proxy',))
        self.assertEqual(routes,[{'server_id':'hk','family':'ipv6','connections':0,'selected':True}]);self.assertEqual(n,0)
        self.proxies['HK-to-HKS']['dialer-proxy']='direct'
        self.assertEqual(self.snapshot(roots=('Proxy',)),([],1))
    def test_idle_connections_expire_and_missing_connections_are_removed(self):
        activity={};cs=[{'id':'1','chains':['direct'],'download':1}]
        self.snapshot(cs,activity,1000);cs[0]['download']=2
        self.assertEqual(self.snapshot(cs,activity,1060,roots=('Proxy',))[0][0]['connections'],1)
        self.assertEqual(self.snapshot(cs,activity,1181,roots=('Proxy',))[0][0]['connections'],0)
        self.snapshot([],activity,1182);self.assertEqual(activity,{})
    def test_global_direct_fallback_and_cycles(self):
        self.groups['GLOBAL']={'type':'Selector','now':'oci'}
        self.assertEqual(self.snapshot(mode='global')[0],[{'server_id':'oci','family':'ipv4','connections':0,'selected':True}])
        self.assertEqual(self.snapshot(mode='direct'),([],0))
        self.groups['TAILNET']={'type':'Tailscale'}
        self.assertEqual(self.snapshot(roots=('TAILNET',)),([],0))
        self.groups['Failover']={'type':'Fallback','now':'direct','all':['direct','HK-to-HKS']}
        self.assertEqual(self.snapshot(roots=('Failover',))[0],[{'server_id':'hks','family':'ipv6','connections':0,'selected':True}])
        self.groups['Proxy']['now']='Proxy';self.assertEqual(self.snapshot(roots=('Proxy',)),([],1))

if __name__=='__main__':unittest.main()
