export interface Config {
    sync: string;
    name: string;
    links: {
        from: string;
        to: string;
        faceid?: number;
    }[];
}