import json

from minindn.apps.application import Application

class DV(Application):
    config: str

    def __init__(self, node):
        Application.__init__(self, node)

        self.logFile = 'dv.log'

        # Make DV configuration
        config = {
            'sync': '/dv/sync',
            'name': node.name,
            'links': [],
        }

        # Getting all link pairs
        for intf in node.intfList():
            ip1 = intf.IP()
            ip2 = intf.link.intf2.IP() if intf.link.intf1 == intf else intf.link.intf1.IP()
            config['links'].append({ 'from': ip1, 'to': ip2 })

        self.config = f'{self.homeDir}/cfg-{node.name}.json'
        with open(self.config, 'w') as f:
            json.dump(config, f)

    def start(self):
        Application.start(self, ['node', '/work/dist/index.js', self.config], logfile=self.logFile)
