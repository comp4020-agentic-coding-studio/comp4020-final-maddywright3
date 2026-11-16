import { createHash } from "node:crypto";

export type LogAction =
  | "page_view"
  | "tap"
  | "tap_ignored"
  | "tap_reopened"
  | "tap_rejected"
  | "stream_open"
  | "stream_close"
  | "lecturer_login_ok"
  | "lecturer_login_failed"
  | "lecture_created"
  | "slide_changed"
  | "slide_change_rejected"
  | "lecture_started"
  | "lecture_start_rejected"
  | "reason_set"
  | "reason_rejected"
  | "reason_refused"
  | "helped_set"
  | "helped_rejected"
  | "helped_refused"
  | "tap_resolved"
  | "note_submitted"
  | "note_rejected"
  | "note_hidden"
  | "run_started"
  | "run_start_rejected"
  | "help_url_set"
  | "help_url_rejected";

// `who` is never the raw browser ID: a real ID is hashed (one-way, so repeat
// activity from the same browser still correlates in the logs); a missing
// cookie is the sentinel "no-cookie" rather than sha256(""), which is a
// fixed, real-looking hash that could be mistaken for genuine data. Exported
// so the top-level error handler can use the same hashing for its own `who`
// field, rather than a second implementation drifting from this one.
export function who(browserId: string | undefined): string {
  if (!browserId) return "no-cookie";
  return createHash("sha256").update(browserId).digest("hex").slice(0, 8);
}

export function logAction(action: LogAction, lectureId: string, browserId: string | undefined): void {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      action,
      lecture: lectureId,
      who: who(browserId),
    }),
  );
}
