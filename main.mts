import { promises as fs } from 'fs';
import * as proc from './proc.js';
import { consume, produce } from '@ndn/endpoint';
import { Config } from './typings.js';

export default async function main() {
    // Read config file
    const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as Config;

    // Multicast sync
    await proc.setStrategy(config.sync, '/localhost/nfd/strategy/multicast');

    // Create all neighbor faces
    for (const link of config.links) {
        try {
            link.faceid = await proc.createFace(link.to);
            console.log(`Created face to ${link.to} with faceid ${link.faceid}`);
        } catch (e) {
            console.error(`Failed to create face to ${link.to}: ${e}`);
        }
    }

    produce(config.sync, async (interest) => {
        console.log(`Received interest ${interest.name}`);
        return undefined;
    });

    // sleep 2s
    await new Promise((r) => setTimeout(r, 2000));

    await consume(config.sync + '/test/' + config.name);
}