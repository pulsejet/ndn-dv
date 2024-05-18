export interface Config {
    sync: string;
    name: string;
    unix: string;
    links: {
        from: string;
        to: string;
        faceid?: number;
    }[];
}