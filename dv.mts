import { Data, Interest } from "@ndn/packet";
import { Config, ILink } from "./typings.js";

import * as proc from './proc.js';
import { consume, produce } from "@ndn/endpoint";

export class DV {
    constructor(private config: Config) {
        this.setup();
    }

    async setup() {
        // Process all neighbor links
        for (const link of this.config.links) {
            // Create face to neighbor
            try {
                link.faceid = await proc.createFace(link.other_ip);
                console.log(`Created face to ${link.other_ip} with faceid ${link.faceid}`);
            } catch (e) {
                console.error(`Failed to create face to ${link.other_ip}: ${e}`);
                continue;
            }

            // Create static routes for neighbor advertisement prefixes
            const other_route = `${this.config.sync}/${link.other_name}`;
            try {
                await proc.addRoute(other_route, link.faceid);
                console.log(`Added route to ${other_route} via faceid ${link.faceid}`);
            } catch (e) {
                console.error(`Failed to add route to ${other_route}: ${e}`);
            }
        }

        // Register own advertisement prefix
        produce(`${this.config.sync}/${this.config.name}`, this.onAdvertisementInterest.bind(this));

        // Set up periodic fetch
        let fetchLock = false;
        setInterval(async () => {
            if (fetchLock) {
                console.warn('Fetch routine is still running, skipping this interval');
                return;
            }

            try {
                fetchLock = true;
                await this.fetchAllAdvertisements();
            } catch (err) {
                console.error(`Error during fetch routine: ${err}`);
            } finally {
                fetchLock = false;
            }
        }, 5000);
    }

    async onAdvertisementInterest(interest: Interest) {
        console.log(`Received interest ${interest.name}`);

        return new Data(interest.name, new Uint8Array([0x230]), Data.FreshnessPeriod(1000));
    }

    async fetchAllAdvertisements() {
        for (const link of this.config.links) {
            await this.fetchAdvertisement(link);
        }
    }

    async fetchAdvertisement(link: ILink) {
        console.log(`Fetching advertisement from ${link.other_name}`);

        const interest = new Interest(`${this.config.sync}/${link.other_name}`, Interest.MustBeFresh);
        const data = await consume(interest);

        console.log(`Received advertisement from ${link.other_name}: ${data.content}`);
    }
}