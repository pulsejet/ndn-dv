import { StructBuilder, StructFieldNNI } from "@ndn/tlv";
import { Encoder, Decoder } from "@ndn/tlv";
import {
  Name,
  Component,
  StructFieldName,
  StructFieldComponentNested,
} from "@ndn/packet";

import { IAdvertisement, TT } from "./typings.mjs";

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
  .add(TT.nextHop, "nextHop", StructFieldNNI, { required: true })
  .add(TT.cost, "cost", StructFieldNNI, { required: true })
  .add(TT.other, "other", StructFieldNNI);

export class RIBEntry extends buildRIBEntry.baseClass<RIBEntry>() {}

buildRIBEntry.subclass = RIBEntry;

export function encodeAdv(adv: IAdvertisement) {
  const links = [];
  for (const intf of Object.keys(adv.nexthops)) {
    const link = new Link();
    link.intf = Number(intf);
    link.neighbor = new Name(adv.nexthops[link.intf]);
    links.push(new Component(Encoder.encode(link)));
  }

  const rib = [];
  for (const destination of Object.keys(adv.rib)) {
    const ribEntry = new RIBEntry();
    const { nexthop, cost, other } = adv.rib[destination];
    ribEntry.destination = new Name(destination);
    ribEntry.nextHop = nexthop;
    ribEntry.cost = cost;
    if (other) ribEntry.other = other;
    rib.push(new Component(Encoder.encode(ribEntry)));
  }

  const advObj = new Adv();
  advObj.links = links;
  advObj.ribEntries = rib;
  return Encoder.encode(advObj);
}

export function decodeAdv(data: Uint8Array) {
  const adv: IAdvertisement = {
    nexthops: {},
    rib: {},
  };

  const dataObj = Decoder.decode(data, Adv);
  for (const link of dataObj.links) {
    const linkObj = Decoder.decode(link.tlv, Link);
    adv.nexthops[linkObj.intf] = linkObj.neighbor.toString();
  }

  for (const ribEntry of dataObj.ribEntries) {
    const entryObj = Decoder.decode(ribEntry.tlv, RIBEntry);
    const { destination, nextHop, cost, other } = entryObj;
    adv.rib[destination.toString()] = {
      nexthop: nextHop,
      cost,
      other: other || null,
    };
  }
  return adv;
}
