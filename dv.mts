import { Data, Interest, Name } from "@ndn/packet";
import { Config, IAdvertisement, ILink, IRibEntry } from "./typings.mjs";

import * as proc from './proc.js';
import { consume, produce } from "@ndn/endpoint";
import deepEqual from "deep-equal";

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

        // Register own advertisement prefix
        produce(`${this.config.sync}/${this.config.name}`, this.onAdvertisementInterest.bind(this));

        // Set up periodic fetch
        let fetchLock = false;

        // Periodic fetch routine
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

        // Initial RIB computation
        this.computeRib();
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

    async advertise(interest: Interest) {
        const advertisement = this.getMyAdvertisement();
        const content = new TextEncoder().encode(JSON.stringify(advertisement));
        return new Data(interest.name, content, Data.FreshnessPeriod(1));
    }

    async ackUpdate(interest: Interest) {
        const sender = interest.name.at(-2).value;
        const senderName = new TextDecoder().decode(sender);
        console.log('Received update notification from neighbor: ', senderName);

        const link = this.config.links.find(link => link.other_name === senderName);
        if (link) {
            this.fetchAdvertisement(link);
        } else {
            console.warn(`Received update notification from unknown neighbor ${senderName}`);
        }

        return new Data(interest.name, Data.FreshnessPeriod(1));
    }

    async onAdvertisementInterest(interest: Interest) {
        const msgType = interest.name.at(-1).value;
        const msgTypeStr = new TextDecoder().decode(msgType);

        switch (msgTypeStr) {
            case 'ADV':
                return this.advertise(interest);
            case 'UPD':
                return this.ackUpdate(interest);
            default:
                console.warn(`Received unknown message type: ${msgTypeStr}`);
        }
    }

    async fetchAllAdvertisements() {
        await Promise.allSettled(this.config.links.map(link => this.fetchAdvertisement(link)));
    }

    async fetchAdvertisement(link: ILink) {
        try {
            const interest = new Interest(`${this.config.sync}/${link.other_name}/ADV`, Interest.MustBeFresh);
            const data = await consume(interest);
            const json = new TextDecoder().decode(data.content);

            const old = link.advert;
            link.advert = JSON.parse(json);

            if (!deepEqual(old, link.advert)) {
                this.computeRib();
            }
        } catch (e) {
            console.error(`Failed to fetch advertisement from ${link.other_name}: ${e}`);
        }
    }

    async notifyChange() {
        await Promise.allSettled(this.config.links.map(link => (async () => {
            const interest = new Interest(`${this.config.sync}/${link.other_name}/${this.config.name}/UPD`, Interest.MustBeFresh);
            await consume(interest);
        })()));
    }

    computeRib() {
        const ribMap = new Map<string, IRibEntry<string>>();

        // Add own prefixes
        for (const adv of this.advertisements) {
            const pfx = adv.name.toString();
            ribMap.set(pfx, {
                name: pfx,
                cost: 0,
                nexthop: 0,
            });
        }

        // Add neighbor prefixes
        for (const link of this.config.links) {
            if (!link.advert) continue;

            for (const entry of link.advert.rib) {
                // poison reverse
                if (link.advert.nexthops[entry.nexthop] === this.config.name) continue;

                // our cost to destination through this neighbor
                const cost = entry.cost + 1;

                // check if we have a better route
                if ((ribMap.get(entry.name)?.cost ?? Number.MAX_SAFE_INTEGER) <= cost) {
                    continue;
                }

                ribMap.set(entry.name, {
                    name: entry.name,
                    cost: cost,
                    nexthop: link.faceid!,
                });
            }
        }

        const newRib: IRibEntry<Name>[] = [];
        for (const [name, entry] of ribMap) {
            newRib.push({
                name: new Name(name),
                cost: entry.cost,
                nexthop: entry.nexthop,
            });
        }

        // sort by name
        newRib.sort((a, b) => a.name.compare(b.name));

        if (!deepEqual(this.rib, newRib)) {
            this.rib = newRib;
            console.log('New computed RIB:', this.getMyAdvertisement());
            this.notifyChange(); // no await
        }
    }
}