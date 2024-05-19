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
}