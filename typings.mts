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

export type IRibEntry = Record<number, {
    cost: number;
}>;

export interface IAdvertisement {
    nexthops: Record<number, string>;
    rib: Record<string, {
        nexthop: number;
        cost: number;
        other: number | null;
    }>;
}