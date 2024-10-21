import { Encoder, Decoder } from "@ndn/tlv";

import { Name, Component } from "@ndn/packet";
import assert from "node:assert/strict";

import { Adv, RIBEntry } from "./tlv.mjs";

const entry1 = new RIBEntry();
entry1.destination = new Name("alice");
entry1.nextHop = new Name("bob");
entry1.cost = 100;
entry1.other = 200;

const entry2 = new RIBEntry();
entry2.destination = new Name("ucla");
entry2.nextHop = new Name("usc");
entry2.cost = 300;
entry2.other = 400;

const c1 = new Component(Encoder.encode(entry1));
const c2 = new Component(Encoder.encode(entry2));

const adv = new Adv();
const ribWire = [c1, c2];
adv.rib = ribWire;

const advWire = Encoder.encode(adv);

const adv1 = Decoder.decode(advWire, Adv);
const rib1 = Decoder.decode(adv1.rib[0].tlv, RIBEntry);
const rib2 = Decoder.decode(adv1.rib[1].tlv, RIBEntry);

assert.deepEqual(rib1.destination.toString(), "/8=alice");
assert.deepEqual(rib1.nextHop.toString(), "/8=bob");
assert.deepEqual(rib1.cost, 100);
assert.deepEqual(rib1.other, 200);

console.log(
  rib1.destination.toString(),
  rib1.nextHop.toString(),
  rib1.cost,
  rib1.other
);

assert.deepEqual(rib2.destination.toString(), "/8=ucla");
assert.deepEqual(rib2.nextHop.toString(), "/8=usc");
assert.deepEqual(rib2.cost, 300);
assert.deepEqual(rib2.other, 400);

console.log(
  rib2.destination.toString(),
  rib2.nextHop.toString(),
  rib2.cost,
  rib2.other
);
