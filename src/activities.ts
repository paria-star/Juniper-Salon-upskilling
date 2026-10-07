import * as store from "./fulfilledStore";

// Activities are where side effects live. Here they are SIMULATED: nothing is actually sent.
// In a real system these would call an SMS provider; Temporal would retry them if they failed.

export async function sendText(input: { to: string; phone: string; text: string }): Promise<{ delivered: boolean; simulated: true }> {
  console.log(`[simulated text to ${input.to} ${input.phone}] ${input.text}`);
  return { delivered: true, simulated: true };
}

export async function notifyFrontDesk(input: { text: string }): Promise<{ delivered: boolean; simulated: true }> {
  console.log(`[simulated front-desk notification] ${input.text}`);
  return { delivered: true, simulated: true };
}

// Fulfilled requests: a person who already got an opening is not offered another for the same request.
export async function isStillWaiting(input: { entryId: string }): Promise<boolean> {
  return !(input.entryId in store.readFulfilled());
}

export async function markFulfilled(input: { entryId: string; openingId: string }): Promise<void> {
  store.markFulfilled(input.entryId, input.openingId);
}

export async function releaseEntry(input: { entryId: string; openingId: string }): Promise<void> {
  store.release(input.entryId, input.openingId);
}
