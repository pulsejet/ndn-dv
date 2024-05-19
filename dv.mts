import { Data, Interest, Name } from "@ndn/packet";
import { Config, IAdvertisement, ILink, IRibEntry } from "./typings.mjs";

import * as proc from './proc.js';
import { consume, produce } from "@ndn/endpoint";

export class DV {
    private advertisements: {
        name: Name;
    }[] = [];

    private rib: IRibEntry<Name>[] = [];

    constructor(private config: Config) {
        this.setup();
    }

    async setup() {
        // Register own prefixes
        this.advertisements.push({
            name: new Name(`/${this.config.name}`),
        }, {
            name: new Name(`/${this.config.name}-1`),
        });

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

        // Compute RIB
        await this.computeRib();

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

    getMyAdvertisement() {
        const adv: IAdvertisement = {
            nexthops: {},
            rib: [],
        };

        for (const link of this.config.links) {
            adv.nexthops[link.faceid!] = link.other_name;
        }

        for (const entry of this.rib) {
            adv.rib.push({
                name: entry.name.toString(),
                cost: entry.cost,
                nexthop: entry.nexthop,
            });
        }

        return adv;
    }

    async onAdvertisementInterest(interest: Interest) {
        const adv = this.getMyAdvertisement();
        const content = new TextEncoder().encode(JSON.stringify(adv));
        return new Data(interest.name, content, Data.FreshnessPeriod(1000));
    }

    async fetchAllAdvertisements() {
        for (const link of this.config.links) {
            await this.fetchAdvertisement(link);
        }

        await this.computeRib();
    }

    async fetchAdvertisement(link: ILink) {
        try {
            const interest = new Interest(`${this.config.sync}/${link.other_name}`, Interest.MustBeFresh);
            const data = await consume(interest);

            const json = new TextDecoder().decode(data.content);
            link.advert = JSON.parse(json);
        } catch (e) {
            console.error(`Failed to fetch advertisement from ${link.other_name}: ${e}`);
        }
    }

    async computeRib() {
        this.rib = [];

        // Add own prefixes
        for (const adv of this.advertisements) {
            this.rib.push({
                name: adv.name,
                cost: 0,
                nexthop: 0,
            });
        }

        // Add neighbor prefixes
        for (const link of this.config.links) {
            if (!link.advert) continue;

            for (const entry of link.advert.rib) {
                // poison reverse
                if (link.advert.nexthops[entry.nexthop] === this.config.name) {
                    console.log(`Poison reverse for ${entry.name}`);
                    continue;
                }

                this.rib.push({
                    name: new Name(entry.name),
                    cost: entry.cost + 1,
                    nexthop: link.faceid!,
                });
            }
        }

        console.log('Computed RIB:', this.getMyAdvertisement().rib);
    }
}