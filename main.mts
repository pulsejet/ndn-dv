import { promises as fs } from 'fs';
import { Config } from './typings.js';
import { enableNfdPrefixReg } from '@ndn/nfdmgmt';
import { UnixTransport } from '@ndn/node-transport';
import { DV } from './dv.mjs';

export default async function main() {
    // Read config file
    const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as Config;

    // Connect to local NFD
    console.log(`Connecting to NFD via ${config.unix}`);
    const face = await UnixTransport.createFace({}, config.unix);
    enableNfdPrefixReg(face);

    // Start DV router
    new DV(config);
}