import { Data, Interest, Name } from "@ndn/packet";
import { Config, IAdvertisement, ILink, IRibEntry } from "./typings.mjs";

import * as proc from "./proc.js";
import { consume, produce } from "@ndn/endpoint";
import deepEqual from "deep-equal";
import { encodeAdv, decodeAdv } from "./tlv-adv.mjs";

const NUM_FAILS = 5;

export class DV {
  private advertisements: {
    name: Name;
  }[] = [];

  private rib: Record<string, IRibEntry> = {};
  private ribUpdateTimer: NodeJS.Timeout | null = null;

  private fib: Record<string, IRibEntry> = {};
  private fibUpdateQueue = new Map<string, IRibEntry>();
  private fibUpdateTimer: NodeJS.Timeout | null = null;

  constructor(private config: Config) {
    this.setup();
  }

  async setup() {
    // Register own prefixes
    this.advertisements.push({
      name: new Name(`/${this.config.name}`),
    });

    // Process all neighbor links
    for (const link of this.config.links) {
      // Create face to neighbor
      try {
        link.faceid = await proc.createFace(link.other_ip);
        console.log(
          `Created face to ${link.other_ip} with faceid ${link.faceid}`
        );
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

      // Other initializations
      link.advErrors ??= 0;
    }

    // Register own advertisement prefix
    produce(
      `${this.config.sync}/${this.config.name}`,
      this.onAdvertisementInterest.bind(this)
    );

    // Set up periodic fetch
    let fetchLock = false;

    // Periodic fetch routine
    setInterval(async () => {
      if (fetchLock) {
        console.warn("Fetch routine is still running, skipping this interval");
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
    }, 2000);

    // Initial RIB computation
    this.scheduleRibUpdate();

    // Initial FIB scheduler
    this.processFibUpdate();
  }

  getMyAdvertisement() {
    const adv: IAdvertisement = {
      nexthops: {},
      rib: {},
    };

    for (const link of this.config.links) {
      adv.nexthops[link.faceid!] = link.other_name;
    }

    for (const [prefix, entry] of Object.entries(this.rib)) {
      const entries = Object.entries(entry);
      if (entries.length === 0) continue;
      entries.sort((a, b) => a[1].cost - b[1].cost);

      adv.rib[prefix] = {
        nexthop: Number(entries[0][0]),
        cost: entries[0][1].cost,
        other: entries[1]?.[1].cost ?? null,
      };
    }

    return adv;
  }

  async advertise(interest: Interest) {
    const advertisement = this.getMyAdvertisement();
    const content = encodeAdv(advertisement);
    return new Data(interest.name, content, Data.FreshnessPeriod(1));
  }

  async ackUpdate(interest: Interest) {
    const sender = interest.name.at(-2).value;
    const senderName = new TextDecoder().decode(sender);

    const link = this.config.links.find(
      (link) => link.other_name === senderName
    );
    if (link) {
      this.fetchAdvertisement(link);
    } else {
      console.warn(
        `Received update notification from unknown neighbor ${senderName}`
      );
    }

    return new Data(interest.name, Data.FreshnessPeriod(1));
  }

  async onAdvertisementInterest(interest: Interest) {
    const msgType = interest.name.at(-1).value;
    const msgTypeStr = new TextDecoder().decode(msgType);

    switch (msgTypeStr) {
      case "ADV": // got advertisement fetch (data interest)
        return this.advertise(interest); // return advertisement
      case "UPD": // got incoming update (sync interest)
        return this.ackUpdate(interest);
      default:
        console.warn(`Received unknown message type: ${msgTypeStr}`);
    }
  }

  async fetchAllAdvertisements() {
    await Promise.allSettled(
      this.config.links.map((link) => this.fetchAdvertisement(link))
    );
  }

  async fetchAdvertisement(link: ILink) {
    try {
      const interest = new Interest(
        `${this.config.sync}/${link.other_name}/ADV`,
        Interest.MustBeFresh,
        Interest.Lifetime(1000)
      );
      const data = await consume(interest);
      const newAdvert = decodeAdv(data.content);

      link.advErrors = 0;
      if (!deepEqual(newAdvert, link.advert)) {
        link.advert = newAdvert;
        this.scheduleRibUpdate();
      }
    } catch (e) {
      if (link.advErrors < NUM_FAILS) {
        console.error(
          `Failed to fetch advertisement from ${link.other_name}: ${e}`
        );
      }

      link.advErrors++;
      if (link.advErrors >= NUM_FAILS && link.advert) {
        console.error(
          `Too many errors, removing advertisements from ${link.other_name}. Suppressing further error logs.`
        );
        link.advert = undefined;
        this.scheduleRibUpdate();
      }
    }
  }

  async notifyChange() {
    // update interest
    await Promise.allSettled(
      this.config.links.map((link) =>
        (async () => {
          const interest = new Interest(
            `${this.config.sync}/${link.other_name}/${this.config.name}/UPD`,
            Interest.MustBeFresh
          );
          await consume(interest);
        })()
      )
    );
  }

  scheduleRibUpdate() {
    if (this.ribUpdateTimer) return;

    this.ribUpdateTimer = setTimeout(() => {
      this.ribUpdateTimer = null;

      const oldRib = this.rib;
      const newRib = this.computeNewRib();

      if (!deepEqual(oldRib, newRib)) {
        this.rib = newRib;
        this.notifyChange();
        this.updateFib(oldRib, newRib);

        // Log new RIB
        console.log("Newly computed RIB:", this.getMyAdvertisement());
      }
    }, Math.random() * 100);
  }

  computeNewRib() {
    const newRib: Record<string, IRibEntry> = {};

    // Add own prefixes
    for (const adv of this.advertisements) {
      const pfx = adv.name.toString();
      newRib[pfx] = { 0: { cost: 0 } };
    }

    // Add neighbor prefixes
    for (const link of this.config.links) {
      if (!link.advert) continue;

      for (const [name, entry] of Object.entries(link.advert.rib)) {
        // our cost to destination through this neighbor
        let cost = entry.cost + 1;
        const nexthop = link.faceid!;

        // poison reverse
        if (link.advert.nexthops[Number(entry.nexthop)] === this.config.name) {
          // unless there are others, and this is not our own prefix
          if (!entry.other || newRib[name]?.[0]) {
            continue;
          }

          // use other cost
          cost = entry.other! + 1;
        }

        // count to infinity
        if (cost >= 16) continue;

        // best route
        newRib[name] ??= {};
        newRib[name][nexthop] = { cost };
      }
    }

    return newRib;
  }

  updateFib(
    oldRib: Record<string, IRibEntry>,
    newRib: Record<string, IRibEntry>
  ) {
    for (const [prefix, newEntry] of Object.entries(newRib)) {
      if (!deepEqual(oldRib[prefix] ?? {}, newEntry)) {
        this.fibUpdateQueue.set(prefix, newEntry);
      }
    }

    for (const [prefix, oldEntry] of Object.entries(oldRib)) {
      if (!newRib[prefix]) {
        this.fibUpdateQueue.set(prefix, {
          0: { cost: Number.MAX_SAFE_INTEGER },
        });
      }
    }
  }

  async processFibUpdate() {
    if (this.fibUpdateTimer) {
      console.warn("[BUG] processFibUpdate called while timer is active");
      return;
    }

    try {
      while (this.fibUpdateQueue.size > 0) {
        const val = this.fibUpdateQueue.entries().next().value;
        if (!val) break;

        const [prefix, entry] = val as [string, IRibEntry];
        this.fibUpdateQueue.delete(prefix);

        // changes to the fib
        const diff = structuredClone(entry);

        // remove entries that have changed
        const oldFibEntry = this.fib[prefix];
        if (oldFibEntry) {
          for (const [nexthop, params] of Object.entries(oldFibEntry)) {
            const nh = Number(nexthop);

            // entry is the same, just skip
            if (deepEqual(params, diff[nh])) {
              delete diff[nh];
              continue;
            }

            // remove this route, may be added later
            await proc.removeRoute(prefix, nh);
            console.log(`Removed route to ${prefix} via faceid ${nexthop}`);
            delete oldFibEntry[nh];
          }
        }

        // add new entries
        for (const [nexthop, params] of Object.entries(diff)) {
          const nh = Number(nexthop);

          if (params.cost >= 16) continue;
          if (nh <= 0) continue;

          await proc.addRoute(prefix, nh, params.cost);
          console.log(`Added route to ${prefix} via faceid ${nexthop}`);

          this.fib[prefix] ??= {};
          this.fib[prefix][nh] = params;
        }
        console.log("fib:", this.fib);
      }
    } catch (e) {
      console.error(`Error during FIB update: ${e}`);
    }

    this.fibUpdateTimer = setTimeout(() => {
      this.fibUpdateTimer = null;
      this.processFibUpdate();
    }, 500);
  }
}
