// Every form and request the persistence check makes, in one place. When the
// app's routes or form fields change (one tap per slide, reasons and notes
// carrying deck and slide, runs), this is the only file to update.

export const REASON = "Missed a step";
export const BROWSERS = 5;
export const SLIDES = [1, 2];

export interface Lecture {
  id: string;
  code: string;
  lecturerCookie: string;
}

export class App {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private async post(path: string, cookie: string, form: Record<string, string>): Promise<Response> {
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    });
    await res.arrayBuffer();
    if (res.status >= 400) throw new Error(`POST ${path} -> ${res.status}`);
    return res;
  }

  async newBrowser(lectureId: string): Promise<string> {
    const res = await fetch(this.url(`/l/${lectureId}`));
    await res.arrayBuffer();
    const bid = res.headers.getSetCookie().find((c) => c.startsWith("bid="));
    if (!bid) throw new Error("no bid cookie minted");
    return bid.split(";")[0];
  }

  async createLecture(title: string): Promise<Lecture> {
    const res = await fetch(this.url("/new"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title }).toString(),
    });
    const html = await res.text();
    if (res.status !== 200) throw new Error(`/new -> ${res.status}`);
    const id = html.match(/\/l\/([a-f0-9]+)/)?.[1];
    const code = html.match(/<strong>([A-Z0-9]+)<\/strong>/)?.[1];
    if (!id || !code) throw new Error("couldn't read the new lecture's id and code");

    const cookie = await this.newBrowser(id);
    const login = await this.post(`/l/${id}/lecturer`, cookie, { code });
    const lsess = login.headers.getSetCookie().find((c) => c.startsWith("lsess="));
    if (!lsess) throw new Error("lecturer login failed");
    return { id, code, lecturerCookie: `${cookie}; ${lsess.split(";")[0]}` };
  }

  nextSlide(lecture: Lecture): Promise<Response> {
    return this.post(`/l/${lecture.id}/lecturer/slide/next`, lecture.lecturerCookie, {});
  }

  // One browser's whole visit to one slide. Today a browser has one live tap
  // at a time, so it resolves before moving on.
  async visitSlide(lectureId: string, cookie: string, slide: number, note: string): Promise<void> {
    await this.post(`/l/${lectureId}/tap`, cookie, { slide: String(slide) });
    await this.post(`/l/${lectureId}/reason`, cookie, { reason: REASON });
    await this.post(`/l/${lectureId}/note`, cookie, { slide: String(slide), text: note });
    await this.post(`/l/${lectureId}/resolve`, cookie, {});
  }

  studentPagePath(lectureId: string): string {
    return `/l/${lectureId}`;
  }

  lecturerPagePath(lectureId: string): string {
    return `/l/${lectureId}/lecturer`;
  }

  async page(path: string, cookie: string): Promise<{ status: number; html: string }> {
    const res = await fetch(this.url(path), { headers: { cookie } });
    return { status: res.status, html: await res.text() };
  }

  // The first frame of a stream, then the stream is closed, so nothing is
  // left open to keep the machine awake.
  async firstFrame(path: string, cookie: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(this.url(path), { headers: { cookie }, signal: controller.signal });
      if (!res.body) throw new Error(`no body from ${path}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`${path} closed before a frame`);
        buffer += decoder.decode(value, { stream: true });
        const sep = buffer.indexOf("\n\n");
        if (sep === -1) continue;
        const data = buffer.slice(0, sep).split("\n").find((l) => l.startsWith("data: "));
        if (!data) {
          buffer = buffer.slice(sep + 2);
          continue;
        }
        await reader.cancel();
        return JSON.parse(data.slice(6));
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  studentStreamPath(lectureId: string): string {
    return `/l/${lectureId}/events`;
  }

  lecturerStreamPath(lectureId: string): string {
    return `/l/${lectureId}/lecturer/events`;
  }
}
