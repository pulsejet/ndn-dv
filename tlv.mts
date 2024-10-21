import { StructBuilder, StructFieldNNI } from "@ndn/tlv";

import {
  TT as l3TT,
  StructFieldName,
  StructFieldComponentNested,
} from "@ndn/packet";

const TT = {
  ...l3TT,
  advertisement: 201,
  link: 202,
  intf: 203,
  neighbor: 204,
  ribEntry: 205,
  destination: 206,
  nextHop: 207,
  cost: 208,
  other: 209,
} as const;

const buildAdv = new StructBuilder("advertisement", TT.advertisement)
  .add(TT.link, "links", StructFieldComponentNested, {
    required: true,
    repeat: true,
  })
  .add(TT.ribEntry, "ribEntries", StructFieldComponentNested, {
    required: true,
    repeat: true,
  });

export class Adv extends buildAdv.baseClass<Adv>() {}

buildAdv.subclass = Adv;

const buildLink = new StructBuilder("link", TT.link)
  .add(TT.intf, "intf", StructFieldNNI, {
    required: true,
  })
  .add(TT.neighbor, "neighbor", StructFieldName, {
    required: true,
  });

export class Link extends buildLink.baseClass<Link>() {}

buildLink.subclass = Link;

const buildRIBEntry = new StructBuilder("ribEntry", TT.ribEntry)
  .add(TT.destination, "destination", StructFieldName, { required: true })
  .add(TT.nextHop, "nextHop", StructFieldName, { required: true })
  .add(TT.cost, "cost", StructFieldNNI, { required: true })
  .add(TT.other, "other", StructFieldNNI);

export class RIBEntry extends buildRIBEntry.baseClass<RIBEntry>() {}

buildRIBEntry.subclass = RIBEntry;
