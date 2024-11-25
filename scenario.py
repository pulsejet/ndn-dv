import random
import time
import json
import os

from mininet.log import setLogLevel, info

from minindn.minindn import Minindn
from minindn.util import MiniNDNCLI
from minindn.apps.app_manager import AppManager
from minindn.apps.nfd import Nfd
from minindn.apps.nlsr import Nlsr

from mininet.link import Link
from mininet.node import Node

#from minindn_play.server import PlayServer

from dv import DV
from ping import PingServer, Ping

TMP_DIR = '/ndn-dv/tmp'
SEED = 0

NUM_PINGSS = 12

SCEN_MAX_SEC = 300
SCEN_INTERVAL = 1

NAME_PFX = 'what'
MTTF = 0
MTTR = 0
PROTO = 'dv'

DEBUG = False

DRY = False

def chooseRandN(n, lst, seed):
    random.seed(seed)
    lst = list(lst)
    random.shuffle(lst)
    return lst[:n]

def setLinkParams(link: Link, **params):
    link.intf1.config(**params)
    link.intf2.config(**params)
    for p in params:
        link.intf1.params[p] = params[p]
        link.intf2.params[p] = params[p]

def getStats(nodes: list[Node]):
    fail, success = 0, 0
    for source in nodes:
        # list files starting with ping-
        folder = f'/tmp/minindn/{source.name}/log'
        if not os.path.exists(folder):
            continue
        basenames = os.listdir(folder)
        basenames = [f for f in basenames if f.startswith('ping-')]

        for basename in basenames:
            filename = f'{folder}/{basename}'
            with open(filename, 'r') as f:
                for line in f:
                    for char in line:
                        if char == 'x':
                            fail += 1
                        elif char == '.':
                            success += 1
    total = fail + success
    fail_pc = round((fail * 100) / ((fail + success) or 1), 2)
    return fail, success, total, fail_pc

def printStats(nodes: list[Node]):
    fail, success, total, fail_pc = getStats(nodes)
    print(f'TOTAL: {total}\t'
          f'LOSS: {fail_pc}%')

def flow_works(source: Node, target: Node, visited: set[str]) -> bool:
    if source == target:
        return True
    visited.add(source.name)
    for intf in source.intfList():
        if intf.params.get('loss', 0.0) > 99.0:
            continue
        link = intf.link
        if link.intf1.node.name not in visited:
            if flow_works(link.intf1.node, target, visited):
                return True
        if link.intf2.node.name not in visited:
            if flow_works(link.intf2.node, target, visited):
                return True
    return False

def start():
    setLogLevel('info')

    if os.path.exists('/tmp/minindn'):
        os.system('rm -rf /tmp/minindn')

    Minindn.cleanUp()
    Minindn.verifyDependencies()

    ndn = Minindn()

    ndn.start()

    if not DRY:
        info('Starting NFD on nodes\n')
        nfds = AppManager(ndn, ndn.net.hosts, Nfd)
        time.sleep(10)

        info('Starting PingServer on nodes\n')
        ping_servers = AppManager(ndn, ndn.net.hosts, PingServer)

        if PROTO == 'dv':
            info('Starting DV on nodes\n')
            dvs = AppManager(ndn, ndn.net.hosts, DV)
        elif PROTO == 'ls':
            info('Starting NLSR on nodes\n')
            nlsrs = AppManager(ndn, ndn.net.hosts, Nlsr)
        else:
            raise ValueError('Invalid PROTO')

        if DEBUG:
            #PlayServer(ndn.net).start()
            ndn.stop()
            exit(0)

        # more time for router to converge
        info('Waiting for router to converge\n')
        time.sleep(60)

    # calculate scenario variables
    info('Starting Ping on nodes\n')
    all_hosts = list(ndn.net.hosts)
    # targets = chooseRandN(NUM_TGT, ndn.net.hosts, SEED)
    # sources = chooseRandN(NUM_SRC, ndn.net.hosts, SEED+1)
    # print('Targets:', [target.name for target in targets])
    # print('Sources:', [source.name for source in sources])

    random.seed(SEED+2)
    flows = set()
    pingss = []
    while len(flows) < NUM_PINGSS:
        source = random.choice(all_hosts)
        target = random.choice(all_hosts)

        if source == target:
            continue

        flow = f'{source.name}->{target.name}'
        if flow in flows:
            continue
        flows.add(flow)

        print('Setting up flow:', flow)

        if not DRY:
            pingss.append(AppManager(ndn, [source], Ping, pfx=f'/{target.name}/ping', logname=target.name))

    # scenario start
    if not DRY:
        time.sleep(5)

    random.seed(SEED+3)

    for i in range(SCEN_MAX_SEC // SCEN_INTERVAL):
        links: list[Link] = ndn.net.links
        for link in links:
            if link.intf1.params.get('loss', 0.0) > 99.0:
                if random.random() < 1 / MTTR:
                    setLinkParams(link, loss=0.0001)
                    print('Link', link, 'repaired')
            else:
                if random.random() < 1 / MTTF:
                    setLinkParams(link, loss=100.0)
                    print('Link', link, 'broken')

        if not DRY:
            time.sleep(SCEN_INTERVAL)
        else:
            for flow in flows:
                source_name, target_name = flow.split('->')
                source = ndn.net.getNodeByName(source_name)
                target = ndn.net.getNodeByName(target_name)

                # make dummy log dir and file
                os.makedirs(f'/tmp/minindn/{source_name}/log', exist_ok=True)
                with open(f'/tmp/minindn/{source_name}/log/ping-{target_name}.log', 'a') as f:
                    f.write('.' if flow_works(source, target, set()) else 'x')

        if (i % 10) == 0:
            print('TIME:', i * SCEN_INTERVAL, end='\t')
            printStats(all_hosts)

    # scenario end
    ndn.stop()

    printStats(all_hosts)

    # save stats to results json file
    fail, success, total, fail_pc = getStats(all_hosts)
    with open(f'/ndn-dv/results/{PROTO}_{NAME_PFX}_{MTTF}_{MTTR}.json', 'w') as f:
        json.dump({'fail': fail, 'success': success, 'total': total, 'fail_pc': fail_pc}, f)

if __name__ == '__main__':
    MTTR = 120

    for run in range(1, 4):
        NAME_PFX = f'base_{run}'
        SEED = run - 1

        for mttf in [4000, 3000, 2000, 1500, 1000, 500, 300]:
            MTTF = mttf
            start()
