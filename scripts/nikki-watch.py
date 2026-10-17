#!/usr/bin/env python3
"""只读 Nikki 活动连接，向 Monitor 上报 VPS 地址族；不改变配置或选线。"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import time
import urllib.request


def endpoint_family(proxy):
    try:
        return 'ipv'+str(ipaddress.ip_address(proxy.get('server','')).version)
    except ValueError:
        # prefer 允许回退，不能据此认定实际地址族；只接受强制地址族。
        return {'ipv4':'ipv4','ipv6':'ipv6'}.get(proxy.get('ip-version'))


def proxy_definitions(runtime):
    import yaml
    proxies={p['name']:p for p in runtime.get('proxies',[]) if p.get('server')}
    for provider in runtime.get('proxy-providers',{}).values():
        path=Path(provider.get('path',''))
        if not path.is_absolute():path=Path('/etc/nikki/run')/path
        if not path.is_file():continue
        try:
            for proxy in (yaml.safe_load(path.read_text()) or {}).get('proxies',[]):
                if proxy.get('server'):proxies[proxy['name']]=proxy
        except (OSError,ValueError,yaml.YAMLError):continue
    return proxies


DIRECT={'DIRECT','REJECT','REJECT-DROP','PASS','COMPATIBLE'}


def selected_leaves(name,groups,path=()):
    if name in DIRECT:return set()
    if name in path or len(path)>=24:raise ValueError('selector cycle')
    group=groups.get(name,{})
    if str(group.get('type','')).lower() in ('direct','reject','rejectdrop','pass','tailscale'):return set()
    if group.get('now'):
        return selected_leaves(group['now'],groups,(*path,name))
    if str(group.get('type','')).lower()=='loadbalance':
        return set().union(*(selected_leaves(child,groups,(*path,name)) for child in group.get('all',[])))
    if group.get('all'):raise ValueError('group selection missing')
    return {name}


def entry_route(name,proxies,groups,config,path=()):
    if name in path or len(path)>=24:raise ValueError('dialer cycle')
    proxy=proxies.get(name)
    if not proxy:raise ValueError('proxy definition missing')
    dialer=proxy.get('dialer-proxy')
    if dialer:
        leaves=selected_leaves(dialer,groups)
        if len(leaves)!=1:raise ValueError('ambiguous dialer')
        return entry_route(next(iter(leaves)),proxies,groups,config,(*path,name))
    family=endpoint_family(proxy)
    server_id=config['endpoints'].get(str(proxy.get('server','')).lower())
    if not family or not server_id:raise ValueError('unmapped route')
    # 入口只取第一个公网节点，出口角色由 exit_route 独立识别。
    return {'server_id':server_id,'family':family}


def exit_route(name,proxies,groups,config):
    proxy=proxies.get(name,{})
    family=endpoint_family(proxy)
    for relay in config.get('relay_exits',[]):
        if (str(proxy.get('server','')).lower(),proxy.get('port'),family)==(relay['server'].lower(),relay['port'],relay['family']):
            return {'server_id':relay['exit_server_id'],'family':relay['exit_family']}
    # dialer-proxy 明确暴露客户端中转关系，最终代理的服务端是出口。
    if proxy.get('dialer-proxy'):
        sid=config['endpoints'].get(str(proxy.get('server','')).lower())
        if sid and family:return {'server_id':sid,'family':family}
    return None


def map_routes(connections,proxies,groups,rule_targets,mode,config,activity,now):
    routes={};unknown=set();live=set()
    def add(name,selected=False,connected=False):
        try:entry=entry_route(name,proxies,groups,config)
        except ValueError:
            unknown.add(name);return
        key=(entry['server_id'],entry['family'])
        route=routes.setdefault(key,{**entry,'connections':0,'selected':False,'exit_connections':0})
        route['selected']|=selected
        if connected:
            route['connections']+=1
            destination=exit_route(name,proxies,groups,config)
            if destination and destination!=entry:
                key=(destination['server_id'],destination['family'])
                exits=routes.setdefault(key,{**destination,'connections':0,'selected':False,'exit_connections':0})
                exits['exit_connections']+=1
    mode=str(mode).lower()
    roots=['GLOBAL'] if mode=='global' else rule_targets if mode=='rule' else []
    for root in set(roots):
        try:leaves=selected_leaves(root,groups)
        except ValueError:
            unknown.add(root);continue
        for name in leaves:add(name,selected=True)
    for connection in connections:
        cid=connection.get('id');chain=connection.get('chains',[])
        if not cid or not chain:continue
        live.add(cid)
        total=int(connection.get('upload',0))+int(connection.get('download',0))
        old=activity.get(cid)
        # 首次见到的累计字节不能证明近期活跃；下一次实际增长后再标绿。
        touched=now if old is not None and total>old[0] else old[1] if old else None
        activity[cid]=(total,touched)
        if touched is None or now-touched>300:continue
        leaf=chain[0]
        if leaf not in DIRECT:add(leaf,connected=True)
    for cid in list(activity):
        if cid not in live:del activity[cid]
    return [row for _,row in sorted(routes.items())],len(unknown)


def collect(config,activity):
    import yaml
    runtime=yaml.safe_load(Path('/etc/nikki/run/config.yaml').read_text())
    controller=str(runtime['external-controller'])
    # 管理 API 只连本机，不把现有 controller 暴露出去。
    port=int(controller.rsplit(':',1)[1])
    # 不继承 HTTP_PROXY，避免管理请求经代理发出。
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def get(path):
        req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,headers={'Authorization':'Bearer '+str(runtime.get('secret',''))})
        with opener.open(req,timeout=5) as response:return json.load(response)
    groups=get('/proxies')['proxies'];mode=get('/configs')['mode']
    rule_targets=[r['proxy'] for r in get('/rules').get('rules',[])] if str(mode).lower()=='rule' else []
    connections=get('/connections')['connections']
    now=time.time()
    routes,unknown=map_routes(connections,proxy_definitions(runtime),groups,rule_targets,mode,config,activity,now)
    return {'version':3,'observed_at':int(now*1000),'routes':routes,'unknown_count':unknown}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',default='/etc/cfsm-nikki-watch/config.json');parser.add_argument('--once',action='store_true');parser.add_argument('--dry-run',action='store_true');args=parser.parse_args()
    os.umask(0o077);activity={}
    while True:
        began=time.monotonic()
        try:
            config=json.loads(Path(args.config).read_text());payload=collect(config,activity)
            if args.dry_run:print(json.dumps(payload),flush=True)
            else:
                req=urllib.request.Request(config['url'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-Nikki-Token':config['token'],'User-Agent':'CFSM-Iperf/1.0'},method='POST')
                opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(req,timeout=25) as response:ack=json.load(response)
                if ack.get('success') is not True:raise RuntimeError('report acknowledgement missing')
                print(json.dumps({'phase':'reported','routes':len(payload['routes']),'active':sum(r['connections']>0 for r in payload['routes']),
                    'selected':sum(r['selected'] for r in payload['routes']),'exits':sum(r['exit_connections']>0 for r in payload['routes']),'unknown':payload['unknown_count'],'observed_at':payload['observed_at']}),flush=True)
        except Exception as error:
            # 不输出请求头、运行配置或访问域名。
            print(json.dumps({'phase':'error','type':type(error).__name__}),flush=True)
            if args.once:raise SystemExit(1)
        if args.once:return
        time.sleep(max(1,60-(time.monotonic()-began)))


if __name__=='__main__':main()
