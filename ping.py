from minindn.apps.application import Application

class PingServer(Application):
    prefix: str

    def __init__(self, node):
        Application.__init__(self, node)
        self.logFile = 'pingserver.log'
        self.prefix = f'/{node.name}'

    def start(self):
        Application.start(self, ['ndnpingserver', self.prefix], logfile=self.logFile)

class Ping(Application):
    prefix: str

    def __init__(self, node, prefix):
        Application.__init__(self, node)
        self.logFile = 'ping.log'
        self.prefix = prefix

    def start(self):
        Application.start(self, ['node', '/work/dist/ping.js', self.prefix], logfile=self.logFile)
