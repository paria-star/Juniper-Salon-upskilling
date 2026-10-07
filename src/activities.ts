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
