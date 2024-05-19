export interface Config {
    sync: string;
    name: string;
    unix: string;
    links: {
        other_ip: string;
        other_name: string;
        faceid?: number;
    }[];
}