import { TT as l3TT, Name } from "@ndn/packet";

export interface Config {
  sync: string;
  name: string;
  unix: string;
  links: ILink[];
}

export interface ILink {
  other_ip: string;
  other_name: string;

  faceid?: number;
  advert?: IAdvertisement;
  nerrors: number;
}

export type IRibEntry = Record<
  number,
  {
    cost: number;
  }
>;

export type IPrefixUpdate = Record<string, "add" | "rmv">;

export interface ISvEntry {
  processed: number;
  pending: number;
}

export interface IAdvertisement {
  nexthops: Record<number, string>;
  rib: Record<
    string,
    {
      nexthop: number;
      cost: number;
      other: number | null;
    }
  >;
}

export interface IPrefixOps {
  router: string;
  updates?: IPrefixUpdate[];
  reset?: boolean;
}

export const TT = {
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
  list: 221,
  reset: 222,
  update: 223,
  add: 224,
  remove: 225,
};
