import { Name } from "@ndn/packet";

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
}

export interface IRibEntry<NameType> {
    name: NameType;
    cost: number;
    nexthop: number;
};

export interface IAdvertisement {
    nexthops: Record<number, string>;
    rib: IRibEntry<string>[];
}