import { Component, Data, Interest, NackHeader, Name } from "@ndn/packet";
import { SvSync, type SyncNode, type SyncUpdate } from "@ndn/svs";
import {
  Config,
  IAdvertisement,
  ILink,
  IRibEntry,
  IPrefixOps,
  ISvEntry,
  IPrefixUpdate,
} from "./typings.mjs";
import { Adv, RIBEntry, Link } from "./tlv-adv.mjs";
import { Encoder, Decoder } from "@ndn/tlv";
import { encodeAdv, decodeAdv } from "./tlv-adv.mjs";
import { encodeOpList, decodeOpList } from "./tlv-prefix.mjs";

import * as proc from "./proc.js";
import { consume, produce } from "@ndn/endpoint";
import deepEqual from "deep-equal";
import equal from "fast-deep-equal/es6";
import { openSocket } from "@ndn/node-transport/lib/udp-helper.js";
import { isJSDocThisTag } from "typescript";

const NUM_FAILS = 5;

export class DV {
  private rib: Record<string, IRibEntry> = {};

  private fib: Record<string, IRibEntry> = {};
  private fibUpdateQueue = new Map<string, IRibEntry>();
  private fibStateVector: Map<string, ISvEntry>;

  private advNode?: SyncNode;
  private prefixNode?: SyncNode;
  private prefixUpdates: Map<number, IPrefixOps>;
  private prefixTable: Map<string, Set<string>>;
  private syncInsts: Map<Name, SvSync>;
  private advStateVector: Map<Name, number>;
  private nodeId: Name;

  constructor(private config: Config) {
    this.advStateVector = new Map();
    this.fibStateVector = new Map();
    this.syncInsts = new Map();
    this.nodeId = new Name(config.name);
    this.prefixUpdates = new Map();
    this.prefixTable = new Map();
    console.log(`${config.sync}/${config.name}`);
    this.createSyncGroups().then(() => this.setup());
  }

  async createSyncGroups() {
    // advertisement sync group
    await SvSync.create({
      describe: `/${this.config.name}/32=DV/32=ADS`,
      syncPrefix: new Name(`/${this.config.name}/32=DV/32=ADS`),
      steadyTimer: [1000, 0.1],
      initialize: (svSync: SvSync) => {
        this.syncInsts.set(new Name(this.config.name), svSync);
        this.advNode = svSync.add(this.config.name); // advNode only publishers
        console.log(svSync);
      },
    });

    await SvSync.create({
      // initialize global prefix sync group node
      describe: `${this.config.sync}/32=DV/32=PFXS`,
      syncPrefix: new Name(`${this.config.sync}/32=DV/32=PFXS`),
      steadyTimer: [1000, 0.1],
      initialize: (svSync: SvSync) => {
        this.syncInsts.set(new Name(this.config.name), svSync);
        this.prefixNode = svSync.add(this.config.name); // advNode only publishers
        svSync.addEventListener("update", (update) => {
          this.handlePrefixSyncUpdate(update);
        });
        console.log(svSync);
      },
    });

    // join neighbor sync groups
    for (const link of this.config.links) {
      console.log(`/${link.other_name}/32=DV/32=ADS`);
      await SvSync.create({
        describe: `/${link.other_name}/32=DV/32=ADS`,
        syncPrefix: new Name(`/${link.other_name}/32=DV/32=ADS`),
        steadyTimer: [1000, 0.1],
        initialize: (svSync: SvSync) => {
          this.syncInsts.set(new Name(link.other_name), svSync);
          svSync.addEventListener("update", (update) => {
            this.handleAdvSyncUpdate(update);
          });
          console.log(svSync);
        },
      });
    }
  }

  async setup() {
    // set prefix sync group in NFD to be multicast
    await proc.setStrategy(
      `${this.config.sync}/32=DV/32=PFXS`,
      "/localhost/nfd/strategy/multicast"
    );

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
      const adv_sync_route = `/${this.config.name}/32=DV/32=ADS`;
      console.log(`Added route to ${adv_sync_route} via faceid ${link.faceid}`);
      const adv_data_route = `/${link.other_name}/32=DV/32=ADV`;
      console.log(`Added route to ${adv_data_route} via faceid ${link.faceid}`);
      const prefix_sync_route = `${this.config.sync}/32=DV/32=PFXS`;
      console.log(
        `Added route to ${prefix_sync_route} via faceid ${link.faceid}`
      );
      const prefix_data_route = `/${link.other_name}/32=DV/32=PFX`;
      console.log(
        `Added route to ${prefix_data_route} via faceid ${link.faceid}`
      );
      try {
        await proc.addRoute(adv_sync_route, link.faceid);
        await proc.addRoute(adv_data_route, link.faceid);
        await proc.addRoute(prefix_sync_route, link.faceid);
        await proc.addRoute(prefix_data_route, link.faceid);
      } catch (e) {
        console.error(
          `Failed to add route to ${adv_sync_route} or ${adv_data_route} or ${prefix_sync_route} or ${prefix_data_route}: ${e}`
        );
      }

      // Other initializations
      link.nerrors ??= 0;
    }

    // Register own advertisement prefix
    produce(`/${this.config.name}/32=DV/32=ADV`, this.advertise.bind(this));

    const ops: IPrefixOps = { router: this.config.name };
    ops.updates = [];
    [0, 1, 2].forEach((n) => {
      const prefix = new Name(`/${this.config.name}_${n}`).toString();
      this.prefixTable.set(
        prefix,
        new Set([new Name(this.config.name).toString()])
      );
      (ops.updates as IPrefixUpdate[]).push({
        [prefix]: "add" as "add" | "rmv",
      });
    });

    produce(
      `/${this.config.name}/32=DV/32=PFX`,
      this.getPrefixUpdates.bind(this)
    );

    setInterval(() => {
      this.prefixNode!.seqNum++;
      this.prefixUpdates.set(this.prefixNode!.seqNum, ops);
    }, 5000);

    // set adv sync group in NFD to be multicast
    await proc.setStrategy(
      `/${this.config.name}/32=DV/32=ADS`,
      "/localhost/nfd/strategy/multicast"
    );

    // Initial RIB computation
    this.scheduleRibUpdate();

    // Initial FIB scheduler
    this.processFibUpdate();

    // setInterval(async () => {
    //   this.produceSyncUpdate();
    // }, 1000);
  }

  // handle incoming advertisement sync updates
  async handleAdvSyncUpdate(update: SyncUpdate) {
    const { id: rawId, hiSeqNum: seqNum } = update;
    const id = rawId.toString().slice(3); // remove "/8=" prefix
    console.log("adv id:", id, "seqNum:", seqNum);
    if (this.advStateVector.get(new Name(id)) ?? 0 > seqNum) return; // stale update
    this.advStateVector.set(new Name(id), seqNum);
    const link = this.config.links.find((link) => link.other_name === id);
    if (link) {
      this.fetchAdvertisement(link, seqNum);
    } else if (id !== this.nodeId) {
      console.warn(
        `Received advertisement update notification from unknown neighbor ${id}`
      );
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
        `/${link.other_name}/32=DV/32=ADV/58=${seqNum}`,
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
    const oldRib = this.rib;
    const newRib = this.computeNewRib();

    if (!deepEqual(oldRib, newRib)) {
      this.rib = newRib;
      this.produceRIBSyncUpdate();
      this.updateFib(oldRib, newRib);
      this.updateRoutes(oldRib, newRib);

      // Log new RIB
      console.log("Newly computed advertisement:", this.getMyAdvertisement());
    }
  }

  // produce an sync update from this router (how to do this?)
  async produceRIBSyncUpdate() {
    if (this.advNode === undefined) {
      console.warn("[BUG] advNode undefined");
      return;
    }

    this.advNode.seqNum++; // just inc this and that should handle it
    console.log(`DV ${this.nodeId}: Published adv update`);
  }

  computeNewRib() {
    const newRib: Record<string, IRibEntry> = {};

    // Add own prefix
    const self = new Name(this.config.name).toString();
    newRib[self] = { 0: { cost: 0 } };

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

  // handle incoming prefix table sync updates
  async handlePrefixSyncUpdate(update: SyncUpdate) {
    console.log(`handling prefix sync update from ${update.id.toString()}`);
    const { id: rawId, hiSeqNum: seqNum } = update;
    const id = rawId.toString().slice(3); // remove "/8="
    console.log("prefix router id:", id, "seqNum:", seqNum);
    if (!this.fibStateVector.has(id)) {
      this.fibStateVector.set(id, { processed: 0, pending: 0 });
    }
    this.fibStateVector.get(id)!.pending = Math.max(
      this.fibStateVector.get(id)!.pending,
      seqNum
    );
    await this.fetchPrefixData(id, seqNum);
  }

  async fetchPrefixData(id: string, seqNum: number) {
    let nerrors = 0;
    try {
      const state = this.fibStateVector.get(id)!;
      while (state.processed < state.pending) {
        const interest = new Interest(
          `/${id}/32=DV/32=PFX/58=${seqNum}`,
          Interest.MustBeFresh,
          Interest.Lifetime(1000)
        );
        const data = await consume(interest);
        const opList = decodeOpList(data.content);
        state.processed++;

        if (opList.reset) {
          this.resetPrefixTable(opList.router);
        }
        if (opList.updates) {
          this.updatePrefixTable(opList);
        }
      }
    } catch (e) {
      if (nerrors < NUM_FAILS) {
        console.error(`Failed to fetch prefixes from ${id}: ${e}`);
      }

      nerrors++;
      if (nerrors >= NUM_FAILS) {
        console.error(
          `Too many errors, aborting prefix fetch. Suppressing further error logs.`
        );
      }
    }
  }

  async resetPrefixTable(router: string) {
    for (const [prefix, routers] of this.prefixTable) {
      routers.delete(router);
    }
  }

  async updatePrefixTable(ops: IPrefixOps) {
    console.log("prefix table update ops: ", ops);
    if (ops.updates) {
      for (const entry of ops.updates) {
        const [prefix, op] = Object.entries(entry)[0];
        if (op === "add") {
          if (!this.prefixTable.has(prefix)) {
            this.prefixTable.set(prefix, new Set());
          }
          this.prefixTable.get(prefix)!.add(ops.router);
          this.fibUpdateQueue.set(ops.router, this.rib[ops.router]);
        } else {
          const [prefix, op] = Object.entries(entry)[0];
          this.prefixTable.get(prefix)!.delete(ops.router);
          this.fibUpdateQueue.set(ops.router, {
            [-1]: { cost: Number.MAX_SAFE_INTEGER },
          });
        }
      }
    }
    console.log("New prefix table:", this.prefixTable);
    this.processFibUpdate();
  }

  // producePrefixTableUpdates(
  //   oldPrefixes: Set<string>,
  //   newPrefixes: Set<string>
  // ) {
  //   // Map<string, Set<string>>;
  //   const ops: IPrefixOps = { router: this.config.name };
  //   ops.updates = [];

  //   for (const prefix of newPrefixes) {
  //     if (!oldPrefixes.has(prefix)) {
  //       ops.updates.push({ [prefix]: "add" });
  //     }
  //   }

  //   for (const prefix of oldPrefixes) {
  //     if (!newPrefixes.has(prefix)) {
  //       ops.updates.push({ [prefix]: "rmv" });
  //     }
  //   }

  //   if (ops.updates && ops.updates.length) {
  //     this.prefixNode!.seqNum++;
  //     produce(
  //       `/${this.config.name}/32=DV/32=PFX/${this.prefixNode?.seqNum}`,
  //       async () => {
  //         return new Data(encodeOpList(ops));
  //       }
  //     );
  //   }
  // }

  async getPrefixUpdates(interest: Interest) {
    try {
      console.log("getting prefix update at name:", interest.name.toString());
      // Map<string, Set<string>>;
      const seqNum = Number(
        interest.name.toString().split("/").at(-1)!.slice(3)
      ); // remove "/58=" prefix
      if (this.prefixUpdates.has(seqNum)) {
        const content = this.prefixUpdates.get(seqNum) as IPrefixOps;
        return new Data(
          interest.name,
          encodeOpList(content),
          Data.FreshnessPeriod(1000)
        );
      } else {
        throw new Error(`Accessed invalid prefix sequence number: ${seqNum}`);
      }
    } catch (e) {
      console.error(e);
    }
  }

  updateFib(
    oldRib: Record<string, IRibEntry>,
    newRib: Record<string, IRibEntry>
  ) {
    for (const [router, newEntry] of Object.entries(newRib)) {
      if (!deepEqual(oldRib[router] ?? {}, newEntry)) {
        this.fibUpdateQueue.set(router, newEntry);
      }
    }

    for (const [router, oldEntry] of Object.entries(oldRib)) {
      if (!newRib[router]) {
        this.fibUpdateQueue.set(router, {
          [-1]: { cost: Number.MAX_SAFE_INTEGER },
        });
      }
    }

    console.log(this.fibUpdateQueue);

    // produce fib update
    this.processFibUpdate();
  }

  async updateRoutes(
    oldRib: Record<string, IRibEntry>,
    newRib: Record<string, IRibEntry>
  ) {
    for (const [router, newEntry] of Object.entries(newRib)) {
      if (!deepEqual(oldRib[router] ?? {}, newEntry)) {
        const [nh, params] = Object.entries(newEntry)[0];
        const nextHop = Number(nh);
        console.log("nh and params: ", nh, params);
        if (nextHop > 0) {
          const prefix_data_route = `${router}/32=DV/32=PFX`;
          await proc.addRoute(prefix_data_route, nextHop, params.cost);
          console.log(`Added route to ${prefix_data_route} via faceid ${nh}`);
        }
      }
    }

    for (const [router, oldEntry] of Object.entries(oldRib)) {
      if (!newRib[router]) {
        const [nh, params] = Object.entries(oldEntry)[0];
        const nextHop = Number(nh);
        console.log("nh and params: ", nh, params);
        if (nextHop > 0) {
          const prefix_data_route = `${router}/32=DV/32=PFX`;
          await proc.removeRoute(prefix_data_route, nextHop);
          console.log(`Removed route to ${prefix_data_route} via faceid ${nh}`);
        }
      }
    }
  }

  async processFibUpdate() {
    if (this.prefixNode === undefined) {
      console.warn("[BUG] prefixNode undefined");
      return;
    }
    try {
      while (this.fibUpdateQueue.size > 0) {
        const val = this.fibUpdateQueue.entries().next().value;
        if (!val) break;

        const [router, entry] = val as [string, IRibEntry];

        this.fibUpdateQueue.delete(router);

        // changes to the fib
        const diff = structuredClone(entry);

        for (const [prefix, routers] of this.prefixTable) {
          if (routers.has(router)) {
            if (this.fib[prefix]) {
              // console.log(
              //   "inside loop:",
              //   this.fib[prefix],
              //   prefix,
              //   routers,
              //   router
              // );
              for (const [nexthop, params] of Object.entries(
                this.fib[prefix]
              )) {
                const nh = Number(nexthop);
                console.log(params, diff[nh]);

                // entry is the same, just skip
                if (deepEqual(params, diff[nh])) {
                  continue;
                }

                // remove this route, may be added later
                delete this.fib[prefix][nh];
                // if prefix is no longer reachable from router, delete from fib
                if (Object.keys(this.fib[prefix]).length === 0) {
                  delete this.fib[prefix];
                }
              }
            }

            // add new entries
            for (const [nexthop, params] of Object.entries(diff)) {
              const nh = Number(nexthop);

              if (params.cost >= 16) continue;
              if (nh < 0) continue;

              // if fib previously didn't have entry for prefix, add to fib
              this.fib[prefix] ??= {};
              this.fib[prefix][nh] = params;
            }
          }
        }
      }
      console.log("Newly computed FIB:", this.fib);
    } catch (e) {
      console.error(`Error during FIB update: ${e}`);
    }
  }
}
