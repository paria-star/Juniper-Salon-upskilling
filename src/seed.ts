import type { WaitlistEntry } from "./types";

// Fake people and phone numbers for the demo. Nothing here is real personal information.
export const SERVICES = ["Haircut", "Color", "Blowout"];
export const STYLISTS = ["Lena", "Carla"];

// Assumption: Lena said "normal daytime and early evening" and "no precise cutoff", so this is a default staff can override.
export const DEFAULT_TEXTING_WINDOW = { startHour: 8, endHour: 20 };

const weekdays = { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" };
const everyDay = { days: [0, 1, 2, 3, 4, 5, 6], from: "08:00", to: "19:00" };
const weekends = { days: [0, 6], from: "10:00", to: "17:00" };
const afternoons = { days: [0, 1, 2, 3, 4, 5, 6], from: "12:00", to: "19:00" };

export function seedWaitlist(): WaitlistEntry[] {
  return [
    { id: "w01", name: "Priya N.", phone: "(555) 010-0101", service: "Haircut", stylist: "Carla", availability: everyDay, joinedAt: "2026-09-02T10:00:00Z" },
    { id: "w02", name: "Marcus T.", phone: "(555) 010-0102", service: "Haircut", availability: weekdays, joinedAt: "2026-09-03T09:30:00Z" },
    { id: "w03", name: "Joanna R.", phone: "(555) 010-0103", service: "Haircut", stylist: "Lena", availability: everyDay, joinedAt: "2026-09-04T14:00:00Z" },
    { id: "w04", name: "Sam K.", phone: "(555) 010-0104", service: "Haircut", availability: afternoons, joinedAt: "2026-09-05T11:15:00Z" },
    { id: "w05", name: "Dana W.", phone: "(555) 010-0105", service: "Haircut", stylist: "Carla", availability: weekends, joinedAt: "2026-09-06T16:00:00Z" },
    { id: "w06", name: "Elena V.", phone: "(555) 010-0106", service: "Haircut", availability: everyDay, joinedAt: "2026-09-08T08:45:00Z" },
    { id: "w07", name: "Tom B.", phone: "(555) 010-0107", service: "Color", stylist: "Lena", availability: everyDay, joinedAt: "2026-09-02T12:00:00Z" },
    { id: "w08", name: "Aisha M.", phone: "(555) 010-0108", service: "Color", availability: weekdays, joinedAt: "2026-09-04T10:00:00Z" },
    { id: "w09", name: "Ben L.", phone: "(555) 010-0109", service: "Blowout", availability: everyDay, joinedAt: "2026-09-03T15:30:00Z" },
    { id: "w10", name: "Chloe F.", phone: "(555) 010-0110", service: "Blowout", stylist: "Carla", availability: everyDay, joinedAt: "2026-09-07T13:00:00Z" },
  ];
}
