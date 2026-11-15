import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

// decodeURIComponent throws on malformed percent-encoding (e.g. a lone "%E0",
// which isn't valid UTF-8). The server calls it on both the URL path segment
// and, via cookie parsing, on cookie values — a malformed request must not
// crash the single Node process that every other open connection depends on.
it("a malformed URI in the path doesn't crash the server", async () => {
  const res = await fetch(new URL("/l/%E0", baseUrl));
  expect(res.status).not.toBe(0); // fetch would throw/reject on a dropped connection, not return 0, but a response at all means the process is still up
  expect([400, 404]).toContain(res.status);
});

it("a malformed URI on the events path doesn't crash the server", async () => {
  const res = await fetch(new URL("/l/%E0/events", baseUrl));
  expect([400, 403, 404]).toContain(res.status);
});

it("a malformed cookie value doesn't crash the server", async () => {
  const res = await fetch(new URL("/l/demo", baseUrl), { headers: { cookie: "bid=%E0" } });
  expect(res.status).toBe(200); // an invalid bid cookie just means a fresh one gets minted
});

it("the server is still up after malformed requests", async () => {
  const res = await fetch(new URL("/", baseUrl));
  expect(res.status).toBe(200);
});
