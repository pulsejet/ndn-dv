import { Component, Data, Interest, Name } from "@ndn/packet";
import { StateVector, SvSync, type SyncNode, type SyncUpdate } from "@ndn/svs";
import { Config, IAdvertisement, ILink, IRibEntry } from "./typings.mjs";
import { Adv, RIBEntry, Link } from "./tlv.mjs";
import { Encoder, Decoder } from "@ndn/tlv";
import { encodeAdv, decodeAdv } from "./tlv.mjs";

import * as proc from "./proc.js";
import { consume, produce } from "@ndn/endpoint";
import deepEqual from "deep-equal";

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

  private syncNode?: SyncNode;
  private syncInsts: Map<Name, SvSync>;
  private stateVector: Map<Name, number>;
  private nodeId: Name;

  constructor(private config: Config) {
    this.stateVector = new Map();
    this.syncInsts = new Map();
    this.nodeId = new Name(config.name);
    console.log(`${config.sync}/${config.name}`);
    this.createSyncGroups();
    this.setup();
  }

  async createSyncGroups() {
    await SvSync.create({
      describe: `${this.config.sync}/${this.config.name}`,
      syncPrefix: new Name(`${this.config.sync}/${this.config.name}`),
      steadyTimer: [100, 0.1],
      initialize: (svSync: SvSync) => {
        this.syncInsts.set(new Name(this.config.name), svSync);
        this.syncNode = svSync.add(this.config.name); // syncNode only publishers
        console.log(svSync);
      },
    });
    for (const link of this.config.links) {
      console.log(`${this.config.sync}/${link.other_name}`);
      await SvSync.create({
        describe: `${this.config.sync}/${link.other_name}`,
        syncPrefix: new Name(`${this.config.sync}/${link.other_name}`),
        steadyTimer: [100, 0.1],
        initialize: (svSync: SvSync) => {
          this.syncInsts.set(new Name(link.other_name), svSync);
          svSync.addEventListener("update", (update) => {
            this.handleSyncUpdate(update);
          });
          console.log(svSync);
        },
      });
    }
  }

  async setup() {
    // Register own prefixes
    this.advertisements.push({
      name: new Name(`/${this.config.name}`),
    });

    // set sync prefix in NFD to be multicast
    await proc.setStrategy(
      `${this.config.sync}/${this.config.name}`,
      "/localhost/nfd/strategy/multicast"
    );

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
      const other_route = `/${link.other_name}/adv`;
      const svs_route = `${this.config.sync}/${this.config.name}`;
      try {
        await proc.addRoute(svs_route, link.faceid);
        await proc.addRoute(other_route, link.faceid);
        console.log(`Added route to ${svs_route} via faceid ${link.faceid}`);
        console.log(`Added route to ${other_route} via faceid ${link.faceid}`);
      } catch (e) {
        console.error(
          `Failed to add route to ${other_route} or ${svs_route}: ${e}`
        );
      }

      // Other initializations
      link.nerrors ??= 0;
    }

    // Register own advertisement prefix
    produce(`/${this.config.name}/adv`, this.advertise.bind(this));
    // Initial RIB computation
    this.scheduleRibUpdate();

    // Initial FIB scheduler
    this.processFibUpdate();

    // setInterval(async () => {
    //   this.produceSyncUpdate();
    // }, 1000);
  }

  // handle incoming sync updates
  async handleSyncUpdate(update: SyncUpdate) {
    const { id: rawId, hiSeqNum: seqNum } = update;
    const id = rawId.toString().slice(3); // remove "/8=" prefix
    console.log("id:", id, "seqNum:", seqNum);
    if (this.stateVector.get(new Name(id)) ?? 0 > seqNum) return; // stale update
    this.stateVector.set(new Name(id), seqNum);
    const link = this.config.links.find((link) => link.other_name === id);
    if (link) {
      this.fetchAdvertisement(link, seqNum);
    } else if (id !== this.nodeId) {
      console.warn(`Received update notification from unknown neighbor ${id}`);
    }
  }

  async advertise(interest: Interest) {
    const advertisement = this.getMyAdvertisement();
    const content = encodeAdv(advertisement);
    return new Data(interest.name, content, Data.FreshnessPeriod(1));
  }

  async fetchAdvertisement(link: ILink, seqNum: number) {
    try {
      const interest = new Interest(
        `/${link.other_name}/adv/${seqNum}`,
        Interest.MustBeFresh,
        Interest.Lifetime(1000)
      );
      const data = await consume(interest);
      const newAdvert = decodeAdv(data.content);

      link.nerrors = 0;
      if (!deepEqual(newAdvert, link.advert)) {
        link.advert = newAdvert;
        this.scheduleRibUpdate();
      }
    } catch (e) {
      if (link.nerrors < NUM_FAILS) {
        console.error(
          `Failed to fetch advertisement from ${link.other_name}: ${e}`
        );
      }

      link.nerrors++;
      if (link.nerrors >= NUM_FAILS && link.advert) {
        console.error(
          `Too many errors, removing advertisements from ${link.other_name}. Suppressing further error logs.`
        );
        link.advert = undefined;
        this.scheduleRibUpdate();
      }
    }
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

  scheduleRibUpdate() {
    if (this.ribUpdateTimer) return;

    this.ribUpdateTimer = setTimeout(() => {
      this.ribUpdateTimer = null;

      const oldRib = this.rib;
      const newRib = this.computeNewRib();

      if (!deepEqual(oldRib, newRib)) {
        this.rib = newRib;
        this.produceSyncUpdate();
        this.updateFib(oldRib, newRib);

        // Log new RIB
        console.log("Newly computed advertisement:", this.getMyAdvertisement());
      }
    }, Math.random() * 100);
  }

  // produce an sync update from this router (how to do this?)
  async produceSyncUpdate() {
    if (this.syncNode === undefined) {
      console.warn("[BUG] syncNode undefined");
      return;
    }

    this.syncNode.seqNum++; // just inc this and that should handle it
    console.log(this.syncNode.seqNum);
    console.log(`DV ${this.nodeId}: Published update`);
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
