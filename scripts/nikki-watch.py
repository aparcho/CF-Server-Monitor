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


def map_connections(connections,proxies,endpoints,activity,now):
    routes={};unknown=set();live=set()
    for connection in connections:
        cid=connection.get('id');chain=connection.get('chains',[])
        if not cid or not chain:continue
        live.add(cid)
        total=int(connection.get('upload',0))+int(connection.get('download',0))
        old=activity.get(cid)
        touched=now if old is None or total>old[0] else old[1]
        activity[cid]=(total,touched)
        if now-touched>120:continue
        leaf=chain[0]
        if leaf in ('DIRECT','REJECT','REJECT-DROP','PASS'):continue
        proxy=proxies.get(leaf)
        family=endpoint_family(proxy) if proxy else None
        server_id=endpoints.get(str(proxy.get('server','')).lower()) if proxy else None
        # 中转只标记首跳入口，不把最终出口的分数冒充完整中转链路。
        if not family or not server_id or proxy.get('dialer-proxy'):
            unknown.add(leaf);continue
        key=(server_id,family)
        routes[key]=routes.get(key,0)+1
    for cid in list(activity):
        if cid not in live:del activity[cid]
    return [{'server_id':sid,'family':family,'connections':n} for (sid,family),n in sorted(routes.items())],len(unknown)


def collect(config,activity):
    import yaml
    runtime=yaml.safe_load(Path('/etc/nikki/run/config.yaml').read_text())
    controller=str(runtime['external-controller'])
    # 管理 API 只连本机，不把现有 controller 暴露出去。
    port=int(controller.rsplit(':',1)[1])
    req=urllib.request.Request(f'http://127.0.0.1:{port}/connections',headers={'Authorization':'Bearer '+str(runtime.get('secret',''))})
    # 不继承 HTTP_PROXY，避免管理请求经代理发出。
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req,timeout=5) as response:connections=json.load(response)['connections']
    now=time.time()
    routes,unknown=map_connections(connections,proxy_definitions(runtime),config['endpoints'],activity,now)
    return {'observed_at':int(now*1000),'routes':routes,'unknown_count':unknown}


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
                print(json.dumps({'phase':'reported','routes':len(payload['routes']),'unknown':payload['unknown_count'],'observed_at':payload['observed_at']}),flush=True)
        except Exception as error:
            # 不输出请求头、运行配置或访问域名。
            print(json.dumps({'phase':'error','type':type(error).__name__}),flush=True)
            if args.once:raise SystemExit(1)
        if args.once:return
        time.sleep(max(1,60-(time.monotonic()-began)))


if __name__=='__main__':main()
