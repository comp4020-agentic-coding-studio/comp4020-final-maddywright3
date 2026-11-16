// Formats a stored ISO time for the lecturer's activity log in AEST
// (Australia/Brisbane: UTC+10, no daylight saving). Time only when it's the
// same AEST calendar day as `now`, otherwise with the day and month. `iso`
// echoes the input for a <time datetime>.
const parts = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Brisbane",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function aestParts(date: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts.formatToParts(date)) out[p.type] = p.value;
  return out;
}

export function formatAest(iso: string | null, now: Date = new Date()): { text: string; iso: string } {
  if (!iso) return { text: "time not recorded", iso: "" };
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { text: "time not recorded", iso: "" };
  const at = aestParts(date);
  const today = aestParts(now);
  const time = `${at.hour}:${at.minute}:${at.second} AEST`;
  const sameDay = at.year === today.year && at.month === today.month && at.day === today.day;
  return { text: sameDay ? time : `${Number(at.day)} ${MONTHS[Number(at.month) - 1]}, ${time}`, iso };
}
