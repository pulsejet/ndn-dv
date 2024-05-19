import { Interest } from "@ndn/packet";

export async function onAdvertisementInterest(interest: Interest) {
    console.log(`Received interest ${interest.name}`);
    return undefined;
}