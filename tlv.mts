import { StructBuilder, StructFieldNNI } from "@ndn/tlv";

import {
  TT as l3TT,
  StructFieldName,
  StructFieldComponentNested,
} from "@ndn/packet";

const TT = {
  ...l3TT,
  advertisement: 201,
  rib: 202,
  destination: 203,
  nextHop: 204,
  cost: 205,
  other: 206,
} as const;

const buildAdv = new StructBuilder("Advertisement", TT.advertisement).add(
  TT.rib,
  "rib",
  StructFieldComponentNested,
  { required: true, repeat: true }
);

export class Adv extends buildAdv.baseClass<Adv>() {}

buildAdv.subclass = Adv;

const buildRIBEntry = new StructBuilder("ribEntry", TT.rib)
  .add(TT.destination, "destination", StructFieldName, { required: true })
  .add(TT.nextHop, "nextHop", StructFieldName, { required: true })
  .add(TT.cost, "cost", StructFieldNNI, { required: true })
  .add(TT.other, "other", StructFieldNNI);

export class RIBEntry extends buildRIBEntry.baseClass<RIBEntry>() {}

buildRIBEntry.subclass = RIBEntry;
