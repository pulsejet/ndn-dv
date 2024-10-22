import { Encoder, Decoder } from "@ndn/tlv";

import { Name, Component } from "@ndn/packet";
import assert from "node:assert/strict";

import { Adv, RIBEntry, Link, encodeAdv, decodeAdv } from "./tlv.mjs";

import { IAdvertisement } from "./typings.mjs";

const r1 = new RIBEntry();
r1.destination = new Name("alice");
r1.nextHop = 1234;
r1.cost = 100;
r1.other = 200;

const r2 = new RIBEntry();
r2.destination = new Name("ucla");
r2.nextHop = 5678;
r2.cost = 300;
r2.other = 400;

const l1 = new Link();
l1.intf = 1;
l1.neighbor = new Name("node1");

const l2 = new Link();
l2.intf = 2;
l2.neighbor = new Name("node2");

const adv = new Adv();
const links = [
  new Component(Encoder.encode(l1)),
  new Component(Encoder.encode(l2)),
];
const rib = [
  new Component(Encoder.encode(r1)),
  new Component(Encoder.encode(r2)),
];
adv.links = links;
adv.ribEntries = rib;

const advWire = Encoder.encode(adv);

const adv1 = Decoder.decode(advWire, Adv);
const r1d = Decoder.decode(adv1.ribEntries[0].tlv, RIBEntry);
const r2d = Decoder.decode(adv1.ribEntries[1].tlv, RIBEntry);
const l1d = Decoder.decode(adv1.links[0].tlv, Link);
const l2d = Decoder.decode(adv1.links[1].tlv, Link);

assert.deepEqual(r1d.destination.toString(), "/8=alice");
assert.deepEqual(r1d.nextHop, 1234);
assert.deepEqual(r1d.cost, 100);
assert.deepEqual(r1d.other, 200);
assert.deepEqual(l1d.intf, 1);
assert.deepEqual(l1d.neighbor.toString(), "/8=node1");

console.log(r1d.destination.toString(), r1d.nextHop, r1d.cost, r1d.other);

assert.deepEqual(r2d.destination.toString(), "/8=ucla");
assert.deepEqual(r2d.nextHop, 5678);
assert.deepEqual(r2d.cost, 300);
assert.deepEqual(r2d.other, 400);
assert.deepEqual(l2d.intf, 2);
assert.deepEqual(l2d.neighbor.toString(), "/8=node2");

console.log(r2d.destination.toString(), r2d.nextHop, r2d.cost, r2d.other);

const advOrig: IAdvertisement = {
  nexthops: { "1": "node1", "2": "node2" },
  rib: {
    alice: {
      nexthop: 1234,
      cost: 100,
      other: 200,
    },
    ucla: {
      nexthop: 5678,
      cost: 300,
      other: null,
    },
  },
};

console.log(decodeAdv(encodeAdv(advOrig)));
