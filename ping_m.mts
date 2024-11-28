import { consume } from "@ndn/endpoint";
import { UnixTransport } from "@ndn/node-transport";
import { Interest } from "@ndn/packet";
import { promises as fs } from "fs";

export default async function main() {
  // Prefix
  const pfx = process.argv[2];

  // read ~/.ndn/client.conf
  const config = await fs.readFile(
    `${process.env.HOME}/.ndn/client.conf`,
    "utf8"
  );

  // get transport=unix:///run/nfd/a.sock
  const unix = config.match(/transport=unix:\/\/(\/\S+)/)?.[1];
  if (!unix) {
    throw new Error("Cannot find unix transport");
  }

  // Connect to local NFD
  console.log(`Connecting to NFD via ${unix}`);
  await UnixTransport.createFace({}, unix);

  // Start consumer
  const NCCT = 40;
  let PC = 0;

  let i = Math.round(Math.random() * 1e12);
  setInterval(async () => {
    i++;
    const name = `${pfx}/${i}`;
    const interest = new Interest(name, Interest.Lifetime(2000));

    try {
      await consume(interest, {
        retx: {
          limit: 2,
          interval: 500,
        },
      });
      process.stdout.write(".");
    } catch (e) {
      console.log(e);
      process.stdout.write("x");
    } finally {
      PC++;
    }

    if (PC % NCCT === 0) process.stdout.write("\n");
  }, 20);
}
