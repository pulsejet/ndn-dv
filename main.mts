import { promises as fs } from 'fs';
import * as proc from './proc.js';
import { produce } from '@ndn/endpoint';
import { Config } from './typings.js';
import { enableNfdPrefixReg } from '@ndn/nfdmgmt';
import { UnixTransport } from '@ndn/node-transport';
import { onAdvertisementInterest } from './dv.mjs';

export default async function main() {
    // Read config file
    const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as Config;

    // Connect to local NFD
    console.log(`Connecting to NFD via ${config.unix}`);
    const face = await UnixTransport.createFace({}, config.unix);
    enableNfdPrefixReg(face);

    // Process all neighbor links
    for (const link of config.links) {
        // Create face to neighbor
        try {
            link.faceid = await proc.createFace(link.other_ip);
            console.log(`Created face to ${link.other_ip} with faceid ${link.faceid}`);
        } catch (e) {
            console.error(`Failed to create face to ${link.other_ip}: ${e}`);
            continue;
        }

        // Create static routes for neighbor advertisement prefixes
        const other_route = `${config.sync}/${link.other_name}`;
        try {
            await proc.addRoute(other_route, link.faceid);
            console.log(`Added route to ${other_route} via faceid ${link.faceid}`);
        } catch (e) {
            console.error(`Failed to add route to ${other_route}: ${e}`);
        }
    }

    // Register own advertisement prefix
    produce(`${config.sync}/${config.name}`, onAdvertisementInterest);
}