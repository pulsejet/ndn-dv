import { promises as fs } from 'fs';

interface Config {
    name: string;
    links: {
        from: string;
        to: string;
    }[];
}

async function main() {
    // Read config file
    const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as Config;

    console.log('Config is', config);
}

main();