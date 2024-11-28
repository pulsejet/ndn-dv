import { Data, Interest, Name } from "@ndn/packet";
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
import { encodeAdv, decodeAdv } from "./tlv-adv.mjs";
import { encodeOpList, decodeOpList } from "./tlv-prefix.mjs";

import { Proc as proc } from "./proc.js";
import { consume, produce } from "@ndn/endpoint";
import deepEqual from "deep-equal";

const NUM_FAILS = 5;

export class DV {
  private rib: Record<string, IRibEntry> = {};

  private fib: Record<string, IRibEntry> = {};
  private fibStateVector: Map<string, ISvEntry>;

  private advNode?: SyncNode;
  private prefixNode?: SyncNode;
  private prefixUpdates: Map<number, IPrefixOps>;
  private prefixTable: Map<string, Set<string>>;
  private advStateVector: Record<string, number>;
  private prefixErrorVector: Record<string, number>;

  constructor(private config: Config) {
    this.advStateVector = {};
    this.fibStateVector = new Map();
    this.prefixErrorVector = {};
    this.prefixUpdates = new Map();
    this.prefixTable = new Map();
    this.setup();
  }

  async setup() {
    await this.setupNFDRoutes();
    await this.createSyncGroups();
    await this.start();
  }

  async setupNFDRoutes() {
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
      const adv_data_route = `/${link.other_name}/32=DV/32=ADV`;
      const prefix_sync_route = `${this.config.sync}/32=DV/32=PFXS`;
      const prefix_data_route = `/${link.other_name}/32=DV/32=PFX`;
      try {
        await proc.addRoute(adv_sync_route, link.faceid);
        console.log(
          `Added route to ${adv_sync_route} via faceid ${link.faceid}`
        );
        await proc.addRoute(adv_data_route, link.faceid);
        console.log(
          `Added route to ${adv_data_route} via faceid ${link.faceid}`
        );
        await proc.addRoute(prefix_sync_route, link.faceid);
        console.log(
          `Added route to ${prefix_sync_route} via faceid ${link.faceid}`
        );
        await proc.addRoute(prefix_data_route, link.faceid);
        console.log(
          `Added route to ${prefix_data_route} via faceid ${link.faceid}`
        );
      } catch (e) {
        console.error(
          `Failed to add route to ${adv_sync_route} or ${adv_data_route} or ${prefix_sync_route} or ${prefix_data_route}: ${e}`
        );
      }

      // Other initializations
      link.advErrors ??= 0;
      link.prefixErrors ??= 0;
    }
  }

  async createSyncGroups() {
    try {
      // advertisement sync group
      await SvSync.create({
        describe: `/${this.config.name}/32=DV/32=ADS`,
        syncPrefix: new Name(`/${this.config.name}/32=DV/32=ADS`),
        steadyTimer: [1000, 0.1],
        initialize: (svSync: SvSync) => {
          this.advNode = svSync.add(this.config.name); // advNode only publishers
        },
      });
      // set adv sync group in NFD to be multicast
      await proc.setStrategy(
        `/${this.config.name}/32=DV/32=ADS`,
        "/localhost/nfd/strategy/multicast"
      );
    } catch (e) {
      console.log(
        `Error initializing adv sync group /${this.config.name}/32=DV/32=ADS: ${e}`
      );
    }

    try {
      await SvSync.create({
        // initialize global prefix sync group node
        describe: `${this.config.sync}/32=DV/32=PFXS`,
        syncPrefix: new Name(`${this.config.sync}/32=DV/32=PFXS`),
        steadyTimer: [1000, 0.1],
        initialize: (svSync: SvSync) => {
          this.prefixNode = svSync.add(this.config.name); // advNode only publishers
          svSync.addEventListener("update", (update) => {
            this.handlePrefixSyncUpdate(update);
          });
        },
      });
      // set prefix sync group in NFD to be multicast
      await proc.setStrategy(
        `${this.config.sync}/32=DV/32=PFXS`,
        "/localhost/nfd/strategy/multicast"
      );
    } catch (e) {
      console.log(
        `Error joining prefix sync group ${this.config.sync}/32=DV/32=PFXS: ${e}`
      );

      // join neighbor sync groups
      for (const link of this.config.links) {
        try {
          await SvSync.create({
            describe: `/${link.other_name}/32=DV/32=ADS`,
            syncPrefix: new Name(`/${link.other_name}/32=DV/32=ADS`),
            steadyTimer: [1000, 0.1],
            initialize: (svSync: SvSync) => {
              svSync.addEventListener("update", (update) => {
                this.handleAdvSyncUpdate(update);
              });
            },
          });
        } catch (e) {
          console.log(
            `Error joining neighbor sync group /${link.other_name}/32=DV/32=ADS: ${e}`
          );
          continue;
        }
      }
    }
  }

  async start() {
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

    setTimeout(() => {
      this.prefixNode!.seqNum++;
      const opReset: IPrefixOps = { router: this.config.name, reset: true };
      this.prefixUpdates.set(this.prefixNode!.seqNum, opReset);

      this.prefixNode!.seqNum++;
      this.prefixUpdates.set(this.prefixNode!.seqNum, ops);
    }, 5000);

    // Initial RIB computation
    this.scheduleRibUpdate();

    // heartbeat for advertisements
    setInterval(async () => {
      this.fetchAllAdvertisements();
    }, 2000);
  }

  // handle incoming advertisement sync updates
  async handleAdvSyncUpdate(update: SyncUpdate) {
    const { id: rawId, hiSeqNum: seqNum } = update;
    const id = rawId.toString().slice(3); // remove "/8=" prefix
    console.log("adv id:", id, "seqNum:", seqNum);
    if ((this.advStateVector[id] ?? 0) > seqNum) return; // stale update
    this.advStateVector[id] = seqNum;
    const link = this.config.links.find((link) => link.other_name === id);
    if (link) {
      link.advErrors = 0;
      this.fetchAdvertisement(link, seqNum);
    } else if (id !== this.config.name) {
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

  async fetchAllAdvertisements() {
    await Promise.allSettled(
      this.config.links.map((link) =>
        this.fetchAdvertisement(link, this.advStateVector[link.other_name] ?? 1)
      )
    );
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
      if (link.advErrors >= NUM_FAILS) {
        console.error(
          `Too many errors, removing advertisements from ${link.other_name}. Suppressing further error logs.`
        );
        if (link.advert) {
          link.advert = undefined;
          this.scheduleRibUpdate();
        }
      } else {
        // retry if below allowed number of fails
        console.log(`Retrying advertisement fetch, errors: ${link.advErrors}`);
        this.fetchAdvertisement(link, seqNum);
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

  // produce an sync update from this router
  async produceRIBSyncUpdate() {
    if (this.advNode === undefined) {
      console.warn("[BUG] advNode undefined");
      return;
    }

    this.advNode.seqNum++;
    console.log(`DV ${this.config.name}: Published adv update`);
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
    this.prefixErrorVector[id] = 0;
    this.fetchPrefixData(id, seqNum);
  }

  async fetchPrefixData(id: string, seqNum: number) {
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
        this.prefixErrorVector[id] = 0;

        if (opList.reset) {
          this.resetPrefixTable(opList.router);
        }
        if (opList.updates) {
          this.updatePrefixTable(opList);
        }
      }
    } catch (e) {
      this.prefixErrorVector[id] ??= 0;
      if (this.prefixErrorVector[id] < NUM_FAILS) {
        console.error(`Failed to fetch prefixes from ${id}: ${e}`);
      }

      this.prefixErrorVector[id]++;
      if (this.prefixErrorVector[id] >= NUM_FAILS) {
        console.error(
          `Too many errors, aborting prefix fetch. Suppressing further error logs.`
        );
      } else {
        // retry if below allowed number of fails
        console.log(
          `Retrying prefix fetch, errors: ${this.prefixErrorVector[id]}`
        );
        this.fetchPrefixData(id, seqNum);
      }
    }
  }

  resetPrefixTable(router: string) {
    for (const [prefix, routers] of this.prefixTable) {
      routers.delete(router);
    }
  }

  updatePrefixTable(ops: IPrefixOps) {
    console.log("prefix table update ops: ", ops);
    if (ops.updates) {
      for (const entry of ops.updates) {
        const [prefix, op] = Object.entries(entry)[0];
        if (op === "add") {
          if (!this.prefixTable.has(prefix)) {
            this.prefixTable.set(prefix, new Set());
          }
          this.prefixTable.get(prefix)!.add(ops.router);
        } else {
          this.prefixTable.get(prefix)!.delete(ops.router);
        }
        this.processFIBUpdateFromPrefixTable(prefix, op, ops.router);
      }
    }
    console.log("New prefix table:", this.prefixTable);
  }

  async getPrefixUpdates(interest: Interest) {
    try {
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
      console.error(`Error during prefix update lookup: ${e}`);
    }
  }

  async updateFib(
    oldRib: Record<string, IRibEntry>,
    newRib: Record<string, IRibEntry>
  ) {
    for (const [router, newEntry] of Object.entries(newRib)) {
      if (!deepEqual(oldRib[router] ?? {}, newEntry)) {
        await this.processFibUpdateFromRIB(router, newEntry);
      }
    }

    for (const [router, oldEntry] of Object.entries(oldRib)) {
      if (!newRib[router]) {
        await this.processFibUpdateFromRIB(router, {
          0: { cost: Number.MAX_SAFE_INTEGER },
        });
      }
    }
    console.log("Newly computed FIB:", this.fib);
  }

  async updateRoutes(
    oldRib: Record<string, IRibEntry>,
    newRib: Record<string, IRibEntry>
  ) {
    try {
      for (const [router, newEntry] of Object.entries(newRib)) {
        if (!deepEqual(oldRib[router] ?? {}, newEntry)) {
          const [nh, params] = Object.entries(newEntry)[0];
          const nextHop = Number(nh);
          if (nextHop <= 0) continue;
          const prefix_data_route = `${router}/32=DV/32=PFX`;
          await proc.addRoute(prefix_data_route, nextHop, params.cost);
          console.log(
            `RIB router update: Added route to ${prefix_data_route} via faceid ${nh}`
          );
        }
      }

      for (const [router, oldEntry] of Object.entries(oldRib)) {
        if (!newRib[router]) {
          const [nh, params] = Object.entries(oldEntry)[0];
          const nextHop = Number(nh);
          if (nextHop <= 0) continue;
          const prefix_data_route = `${router}/32=DV/32=PFX`;
          await proc.removeRoute(prefix_data_route, nextHop);
          console.log(
            `RIB router update: Removed route to ${prefix_data_route} via faceid ${nh}`
          );
        }
      }
    } catch (e) {
      console.error(`Error during route update: ${e}`);
    }
  }

  async processFibUpdateFromRIB(router: string, entry: IRibEntry) {
    try {
      // changes to the fib
      const diff = structuredClone(entry);

      for (const [prefix, routers] of this.prefixTable) {
        if (routers.has(router)) {
          if (this.fib[prefix]) {
            for (const [nexthop, params] of Object.entries(this.fib[prefix])) {
              const nh = Number(nexthop);

              // entry is the same, just skip
              if (deepEqual(params, diff[nh])) {
                continue;
              }

              // remove this route, may be added later
              await proc.removeRoute(prefix, nh);
              console.log(
                `RIB prefix update: Removed route to ${prefix} via faceid ${nexthop}`
              );

              delete this.fib[prefix][nh];
            }
            // if prefix is no longer reachable from router, delete from fib
          }
          if (this.fib[prefix] && Object.keys(this.fib[prefix]).length === 0) {
            delete this.fib[prefix];
          }

          // add new entries
          if (diff) {
            for (const [nexthop, params] of Object.entries(diff)) {
              const nh = Number(nexthop);

              if (params.cost >= 16) continue;
              if (nh < 0) continue;

              // if fib previously didn't have entry for prefix, add to fib
              this.fib[prefix] ??= {};
              this.fib[prefix][nh] = params;

              if (nh == 0) continue;
              await proc.addRoute(prefix, nh, params.cost);
              console.log(
                `RIB prefix update: Added route to ${prefix} via faceid ${nexthop}`
              );
            }
          }
        }
      }
    } catch (e) {
      console.error(`Error during FIB update: ${e}`);
    }
  }

  async processFIBUpdateFromPrefixTable(
    prefix: string,
    op: "add" | "rmv",
    router: string
  ) {
    if (op === "add") {
      this.fib[prefix] ??= {};
      if (this.rib[router]) {
        for (const [nexthop, params] of Object.entries(this.rib[router])) {
          const nh = Number(nexthop);
          this.fib[prefix][nh] = params;
          await proc.addRoute(prefix, nh, params.cost);
          console.log(
            `Prefix table prefix update: Added route to ${prefix} via faceid ${nexthop}`
          );
        }
      }
    } else {
      if (this.rib[router]) {
        for (const [nexthop, params] of Object.entries(this.rib[router])) {
          const nh = Number(nexthop);
          await proc.removeRoute(prefix, nh);
          console.log(
            `Prefix table prefix update: Removed route to ${prefix} via faceid ${nexthop}`
          );
        }
      }
      delete this.fib[prefix];
    }
  }
}
