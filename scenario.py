import random
import time

from mininet.log import setLogLevel, info

from minindn.minindn import Minindn
from minindn.util import MiniNDNCLI
from minindn.apps.app_manager import AppManager
from minindn.apps.nfd import Nfd

from mininet.link import Link
from mininet.node import Node

from minindn_play.server import PlayServer

from dv import DV
from ping import PingServer, Ping

TMP_DIR = '/work/tmp'
SEED = 0

NUM_SRC = 10
NUM_TGT = 6

SCEN_MAX_SEC = 600
SCEN_INTERVAL = 1

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
        with open(f'/tmp/minindn/{source.name}/log/ping.log', 'r') as f:
            for line in f:
                for char in line:
                    if char == 'x':
                        fail += 1
                    elif char == '.':
                        success += 1
    return fail, success

def printStats(nodes: list[Node]):
    fail, success = getStats(nodes)
    print('TOTAL:', fail + success)
    print('RATE:', success / (fail + success))

if __name__ == '__main__':
    setLogLevel('info')

    Minindn.cleanUp()
    Minindn.verifyDependencies()

    ndn = Minindn()

    ndn.start()

    info('Starting NFD on nodes\n')
    nfds = AppManager(ndn, ndn.net.hosts, Nfd)
    time.sleep(10)

    info('Starting PingServer on nodes\n')
    ping_servers = AppManager(ndn, ndn.net.hosts, PingServer)

    info('Starting DV on nodes\n')
    dvs = AppManager(ndn, ndn.net.hosts, DV)

    # MiniNDNCLI(ndn.net)
    # PlayServer(ndn.net).start()

    time.sleep(10)

    info('Starting Ping on nodes\n')
    targets = chooseRandN(NUM_TGT, ndn.net.hosts, SEED)
    sources = chooseRandN(NUM_SRC, ndn.net.hosts, SEED+1)
    print('Targets:', [target.name for target in targets])
    print('Sources:', [source.name for source in sources])
    pingss = []
    for target in targets:
        pingss.append(AppManager(ndn, sources, Ping, prefix=f'/{target.name}/ping'))

    # scenario start
    time.sleep(2)
    random.seed(SEED+3)

    for i in range(SCEN_MAX_SEC // SCEN_INTERVAL):
        links: list[Link] = ndn.net.links
        for link in links:
            if link.intf1.params.get('loss', 0.0) > 99.0:
                if random.random() < 0.01:
                    setLinkParams(link, loss=0.0001)
                    print('Link', link, 'repaired')
            else:
                if random.random() < 0.001:
                    setLinkParams(link, loss=100.0)
                    print('Link', link, 'broken')
        time.sleep(SCEN_INTERVAL)

        if (i % 10) == 0:
            print('TIME:', i * SCEN_INTERVAL)
            printStats(sources)

    # scenario end
    ndn.stop()

    printStats(sources)
