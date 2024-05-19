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
            'unix': f'/run/nfd/{node.name}.sock',
            'name': node.name,
            'links': [],
        }

        # Getting all link pairs
        for intf in node.intfList():
            other_intf = intf.link.intf2 if intf.link.intf1 == intf else intf.link.intf1
            config['links'].append({ 'other_ip': other_intf.IP(), 'other_name': other_intf.node.name })

        self.config = f'{self.homeDir}/cfg-{node.name}.json'
        with open(self.config, 'w') as f:
            json.dump(config, f)

    def start(self):
        Application.start(self, ['node', '/work/dist/index.js', self.config], logfile=self.logFile)
