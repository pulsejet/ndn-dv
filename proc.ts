import { spawn } from 'child_process';

export async function exec(command: string, args: string[]) {
    return new Promise<{
        stdout: string;
        stderr: string;
        status: number | null;
    }>((resolve, reject) => {
        const child = spawn(command, args);
        let stdout = '', stderr = '';
        child.stdout.on('data', (data) => stdout += data);
        child.stderr.on('data', (data) => stderr += data);
        child.on('exit', (status) => resolve({ stdout, stderr, status }));
    });
}

export async function createFace(dest: string): Promise<number> {
    const res = await exec('nfdc', [
        'face', 'create',
        'remote', `udp4://${dest}:6363`,
        'persistency', 'permanent',
    ]);

    if (res.status !== 0) {
        throw new Error(`Failed to create face to ${dest}: ${res.stderr}`);
    }

    const faceid = res.stdout.split(' ').find((x) => x.startsWith('id='))?.split('=')[1];
    if (!faceid) {
        throw new Error(`Failed to parse face id: ${res.stdout}`);
    }

    return parseInt(faceid);
}

export async function setStrategy(prefix: string, strategy: string) {
    const res = await exec('nfdc', [
        'strategy', 'set',
        'prefix', prefix,
        'strategy', strategy,
    ]);

    if (res.status !== 0) {
        throw new Error(`Failed to set strategy for ${prefix}: ${res.stderr}`);
    }
}