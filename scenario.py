import time

from mininet.log import setLogLevel, info

from minindn.minindn import Minindn
from minindn.util import MiniNDNCLI
from minindn.apps.app_manager import AppManager
from minindn.apps.nfd import Nfd

from dv import DV

TMP_DIR = '/work/tmp'

if __name__ == '__main__':
    setLogLevel('info')

    Minindn.cleanUp()
    Minindn.verifyDependencies()

    ndn = Minindn()

    ndn.start()

    # info('Starting NFD on nodes\n')
    # nfds = AppManager(ndn, ndn.net.hosts, Nfd)

    info('Starting DV on nodes\n')
    dvs = AppManager(ndn, ndn.net.hosts, DV)

    time.sleep(4)

    # MiniNDNCLI(ndn.net)

    ndn.stop()
