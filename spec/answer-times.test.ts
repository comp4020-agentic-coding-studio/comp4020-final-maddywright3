import { expect, inject, it } from "vitest";
import { newBrowserCookie } from "./test-helpers.ts";

// Choosing a reason and saying what helped now also stamp reason_at and
// helped_at (for the per-press activity log's AEST times). The stamp is in
// the same single UPDATE as the answer, so the lock must hold exactly as
// before: the first answer is taken, a second is refused.
const baseUrl = inject("baseUrl");

async function createLecture(title: string): Promise<string> {
  const creator = await newBrowserCookie("demo");
  const html = await (
    await fetch(new URL("/new", baseUrl), {
      method: "POST",
      headers: { cookie: creator, "content-type": "application/x-www-form-urlencoded" },
      body: `title=${encodeURIComponent(title)}&slides=60&minutes=60`,
    })
  ).text();
  const id = html.match(/Student link: <a href="\/l\/([a-f0-9]+)"/)?.[1];
  if (!id) throw new Error("couldn't parse the new lecture's id");
  return id;
}

function post(lectureId: string, path: string, cookie: string, body: Record<string, string>): Promise<Response> {
  return fetch(new URL(`/l/${lectureId}/${path}`, baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

it("a reason is still taken once on a fresh lecture: 303, then 409 for a second", async () => {
  const id = await createLecture("Reason time test");
  const cookie = await newBrowserCookie(id);
  expect((await post(id, "tap", cookie, { slide: "1" })).status).toBe(303);
  expect((await post(id, "reason", cookie, { slide: "1", reason: "Too fast" })).status).toBe(303);
  expect((await post(id, "reason", cookie, { slide: "1", reason: "Notation" })).status).toBe(409);
});

it("what helped is still taken once on a fresh lecture: 303, then 409 for a second", async () => {
  const id = await createLecture("Helped time test");
  const cookie = await newBrowserCookie(id);
  expect((await post(id, "tap", cookie, { slide: "1" })).status).toBe(303);
  expect((await post(id, "resolve", cookie, { slide: "1" })).status).toBe(303);
  expect((await post(id, "helped", cookie, { slide: "1", helped: "The example" })).status).toBe(303);
  expect((await post(id, "helped", cookie, { slide: "1", helped: "Re-reading it" })).status).toBe(409);
});
