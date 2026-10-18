import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker, { type Env, encrypt, isBasecampApiUrl, maskRichHtml, parseBilingualTodo, removeAttachments } from "../src/index";
import { prepareEnv } from "../src/setup";

// Execute the actual migration SQL and application queries, with D1's small
// statement interface backed by an in-memory SQLite database.
function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_initial.sql", "0002_setup.sql"]) sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const db = {
    prepare(sql: string) {
      let values: any[] = [];
      return {
        bind(...args: any[]) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values), success: true }; },
        async run() { return { ...sqlite.prepare(sql).run(...values), success: true }; },
      };
    },
  } as unknown as D1Database;
  return { sqlite, db };
}

const origin = "https://translator.example";
let env: Env;
let sqlite: DatabaseSync;
let cookie: string;
let sent: unknown[];

async function request(path: string, data?: Record<string, string | string[]>, authenticated = true, extraHeaders: Record<string, string> = {}) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(data ?? {})) for (const item of Array.isArray(value) ? value : [value]) form.append(key, item);
  return worker.fetch(new Request(origin + path, {
    method: data ? "POST" : "GET",
    headers: { ...(authenticated && cookie ? { cookie } : {}), ...(data ? { origin, "content-type": "application/x-www-form-urlencoded" } : {}), ...extraHeaders },
    body: data ? form : undefined,
  }), env);
}

async function seedToken() {
  const prepared = await prepareEnv(env);
  await env.DB.prepare("INSERT INTO oauth_token VALUES ('basecamp',?,?,?)").bind(await encrypt("test-access", prepared.TOKEN_ENCRYPTION_KEY), await encrypt("test-refresh", prepared.TOKEN_ENCRYPTION_KEY), new Date(Date.now() + 86400000).toISOString()).run();
}

function seedProject(budget = 100000) {
  sqlite.prepare("INSERT INTO project_config VALUES ('100','200','[\"12\"]','[\"13\"]','11',1,?)").run(budget);
}

function mockServices(commentContent = "<div>Por favor, confirma la fecha para el equipo.</div>", parentType = "Todo") {
  const posts: { url: string; body: any }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && url.includes("authorization/token")) return json({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 1209600 });
    if (url.includes("authorization.json")) return json({ accounts: [{ id: 100, name: "Example team", product: "bc3" }] });
    if (url.endsWith("my/profile.json")) return json({ id: 11, name: "Translate Bot", email_address: "bot@example.com" });
    if (url.endsWith("projects.json")) return json([{ id: 200, name: "Example project" }]);
    if (url.endsWith("people.json")) return json([{ id: 11, name: "Translate Bot" }, { id: 12, name: "Alex <Rivera>" }, { id: 13, name: "Sam" }]);
    if (url.includes("translation.googleapis.com")) {
      const params = new URLSearchParams(String(init?.body));
      posts.push({ url: "google", body: Object.fromEntries(params) });
      return json({ data: { translations: [{ translatedText: params.get("q")?.replace("Por favor, confirma la fecha para el equipo.", "Please confirm the date for the team.") }] } });
    }
    if (url.endsWith("comments/300.json")) return json({ id: 300, type: "Comment", parent: { id: 250, type: parentType }, bucket: { id: 200 }, creator: { id: 12, name: "Alex <Rivera>" }, content: commentContent, created_at: "2026-10-18T13:01:00Z" });
    if (url.endsWith("comments.json") && method === "GET") return json([]);
    if (url.endsWith("webhooks.json") && method === "GET") return json([]);
    if (method === "POST") { posts.push({ url, body: JSON.parse(String(init?.body)) }); return json({ id: 999 }, 201); }
    throw new Error(`Unexpected mocked request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posts, fetchMock };
}

async function deliver() {
  const ack = vi.fn(); const retry = vi.fn();
  await worker.queue({ messages: [{ body: { accountId: "100", projectId: "200", event: { id: "event-1", kind: "comment_created", recording: { id: 300, url: "https://3.basecampapi.com/100/comments/300.json" } } }, ack, retry }] } as any, env);
  return { ack, retry };
}

beforeEach(async () => {
  const created = database(); sqlite = created.sqlite; sent = []; cookie = "";
  env = { DB: created.db, TRANSLATION_QUEUE: { send: async (value: unknown) => { sent.push(value); } }, SETUP_PASSWORD: "test-only-setup-password-32-characters", BASECAMP_CLIENT_ID: "test-client", BASECAMP_CLIENT_SECRET: "test-secret", TRANSLATION_API_KEY: "test-google", TRANSLATION_PROVIDER: "google_nmt", PROJECT_TIME_ZONE: "UTC" } as unknown as Env;
  const login = await request("/setup/login", { password: env.SETUP_PASSWORD }, false);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });

describe("private guided installation", () => {
  it("requires login, rejects cross-origin forms, and marks cookies private", async () => {
    expect(await (await request("/setup", undefined, false)).text()).toContain("Setup password");
    const rejected = await request("/setup/connect", {}, true, { origin: "https://other.example" });
    expect(rejected.status).toBe(403);
    const login = await request("/setup/login", { password: env.SETUP_PASSWORD }, false);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax");
    expect(login.headers.get("set-cookie")).toContain("Secure");
  });

  it("connects via an expiring, single-use OAuth state without exposing tokens", async () => {
    mockServices();
    const start = await request("/setup/connect", {});
    const auth = new URL(start.headers.get("location")!);
    expect(auth.searchParams.get("redirect_uri")).toBe(`${origin}/oauth/callback`);
    const callback = `/oauth/callback?code=test-code&state=${auth.searchParams.get("state")}`;
    expect((await request(callback)).status).toBe(303);
    expect((await request(callback)).status).toBe(400);
    const stored = sqlite.prepare("SELECT * FROM oauth_token").get()!;
    expect(String(stored.access_ciphertext)).not.toContain("test-access");
    expect(String(stored.refresh_ciphertext)).not.toContain("test-refresh");
  });

  it("rejects expired state and reconnection as a different bot", async () => {
    const { fetchMock } = mockServices();
    let start = await request("/setup/connect", {});
    let state = new URL(start.headers.get("location")!).searchParams.get("state");
    sqlite.prepare("UPDATE setup_oauth_state SET expires_at=0").run();
    expect((await request(`/oauth/callback?code=test-code&state=${state}`)).status).toBe(400);
    seedProject();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => String(input).endsWith("my/profile.json") ? new Response(JSON.stringify({ id: 999, name: "Wrong user" })) : original(input, init));
    start = await request("/setup/connect", {});
    state = new URL(start.headers.get("location")!).searchParams.get("state");
    const callback = await request(`/oauth/callback?code=test-code&state=${state}`);
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("different Basecamp user");
    expect(sqlite.prepare("SELECT count(*) as n FROM oauth_token").get()!.n).toBe(0);
  });

  it("shows the posting identity and creates a project webhook before enabling", async () => {
    await seedToken(); const { posts } = mockServices();
    const setup = await request("/setup?account=100&project=200");
    expect(await setup.text()).toContain("bot@example.com");
    expect((await request("/setup/enable", { account: "100", project: "200", confirm_bot: "11", budget: "100000", spanish: ["12"] })).status).toBe(303);
    const config = sqlite.prepare("SELECT * FROM project_config").get()!;
    expect(config.enabled).toBe(1);
    expect(config.creator_person_ids).toBe('["12"]');
    expect(posts[0].body.types).toEqual(["Todo", "Comment"]);
    expect(posts[0].body.payload_url).toContain(`${origin}/webhooks/basecamp/`);
  });

  it("leaves a project paused if webhook creation fails", async () => {
    await seedToken(); const { fetchMock } = mockServices();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => init?.method === "POST" && String(input).endsWith("webhooks.json") ? new Response("Forbidden", { status: 403 }) : original(input, init));
    expect((await request("/setup/enable", { account: "100", project: "200", confirm_bot: "11", budget: "100000", spanish: ["12"] })).status).toBe(400);
    expect(sqlite.prepare("SELECT enabled FROM project_config").get()!.enabled).toBe(0);
  });

  it("cannot enable another account or invent a project member", async () => {
    await seedToken(); mockServices();
    expect((await request("/setup/enable", { account: "666", project: "200", confirm_bot: "11", budget: "100000" })).status).toBe(400);
    expect((await request("/setup/enable", { account: "100", project: "200", confirm_bot: "11", budget: "100000", spanish: ["999"] })).status).toBe(400);
    expect(sqlite.prepare("SELECT count(*) as n FROM project_config").get()!.n).toBe(0);
  });

  it("pauses a project without deleting its state or making translations", async () => {
    await seedToken(); seedProject(); const { posts } = mockServices();
    expect((await request("/setup/pause", { account: "100", project: "200" })).status).toBe(303);
    await deliver();
    expect(posts).toHaveLength(0);
    expect(sqlite.prepare("SELECT enabled FROM project_config").get()!.enabled).toBe(0);
  });
});

describe("translation pipeline", () => {
  it("makes a to-do bilingual, preserves assignment/date fields, and ignores its own update", async () => {
    await seedToken(); seedProject();
    const { posts, fetchMock } = mockServices();
    const original = fetchMock.getMockImplementation()!;
    let todo = { id: 250, type: "Todo", content: "Please confirm the meeting date", description: "<div>The team needs the final date.</div>", assignees: [{ id: 13 }], completion_subscribers: [{ id: 12 }], due_on: "2026-10-25", starts_on: null };
    const writes: any[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("todos/250.json")) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)); writes.push(body);
          todo = { ...todo, content: body.content, description: body.description };
          return new Response(JSON.stringify(todo));
        }
        return new Response(JSON.stringify(todo));
      }
      return original(input, init);
    });
    const ack = vi.fn(); const retry = vi.fn();
    const event = (id: string) => ({ messages: [{ body: { accountId: "100", projectId: "200", event: { id, kind: "todo_content_updated", creator: { id: 13 }, recording: { id: 250, url: "https://3.basecampapi.com/100/todos/250.json" } } }, ack, retry }] }) as any;
    await worker.queue(event("todo-1"), env);
    expect(retry).not.toHaveBeenCalled(); expect(writes).toHaveLength(1);
    expect(writes[0].content).toMatch(/^\[ES\].+— \[EN\]/);
    expect(writes[0].description).toContain("[ES]");
    expect(writes[0].description).not.toContain("[BC-");
    expect(writes[0].assignee_ids).toEqual([13]);
    expect(writes[0].completion_subscriber_ids).toEqual([12]);
    expect(writes[0].due_on).toBe("2026-10-25");
    await worker.queue(event("todo-2"), env);
    expect(writes).toHaveLength(1); expect(posts.filter(post => post.url === "google")).toHaveLength(2);
  });

  it("translates text without attachments and attributes the original safely", async () => {
    await seedToken(); seedProject();
    const { posts } = mockServices('<div>Por favor, confirma la fecha para el equipo.</div><bc-attachment sgid="private-file"><figure>image.png</figure></bc-attachment>');
    const { ack, retry } = await deliver();
    expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
    expect(posts[0].body.q).not.toContain("attachment");
    const translated = posts[1].body.content;
    expect(translated).toContain("English translation");
    expect(translated).toContain("Alex &lt;Rivera&gt;");
    expect(translated).toContain("Please confirm the date for the team.");
    expect(translated).toContain("__recording_300");
    expect(translated).not.toContain("bc-attachment");
    expect(translated).not.toContain("__BC_TAG_");
    await deliver();
    expect(posts).toHaveLength(2); // replay is acknowledged without another call
  });

  it("skips attachment-only comments and comments outside to-dos", async () => {
    await seedToken(); seedProject();
    const { posts } = mockServices('<bc-attachment sgid="file">Please read this file</bc-attachment>');
    await deliver(); expect(posts).toHaveLength(0);
    sqlite.prepare("DELETE FROM webhook_events").run();
    const other = mockServices(undefined, "Message");
    await deliver(); expect(other.posts).toHaveLength(0);
  });

  it("translates English comments to Spanish", async () => {
    await seedToken(); seedProject();
    const { posts } = mockServices("<div>Please confirm the date for the team.</div>");
    await deliver();
    expect(posts[0].body.source).toBe("en");
    expect(posts[0].body.target).toBe("es");
    expect(posts[1].body.content).toContain("Traducción al español");
  });

  it("stops before calling Google when the account allowance is exhausted", async () => {
    await seedToken(); seedProject(1); const { posts } = mockServices();
    const { ack, retry } = await deliver();
    expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it("rejects lookalike API hosts and queues no raw webhook content", async () => {
    seedProject(); const prepared = await prepareEnv(env);
    expect(isBasecampApiUrl("https://3.basecampapi.com/100/comments/300.json", "100")).toBe(true);
    expect(isBasecampApiUrl("https://evil.example/https://3.basecampapi.com/100/comments/300.json")).toBe(false);
    expect(isBasecampApiUrl("https://3.basecampapi.com@evil.example/100/comments/300.json")).toBe(false);
    const event = { id: 1, kind: "comment_created", recording: { id: 300, url: "https://3.basecampapi.com/100/comments/300.json", bucket: { id: 200 }, content: "private source text" } };
    const response = await worker.fetch(new Request(`${origin}/webhooks/basecamp/${prepared.WEBHOOK_PATH_SECRET}`, { method: "POST", body: JSON.stringify(event) }), env);
    expect(response.status).toBe(202);
    expect(JSON.stringify(sent)).not.toContain("private source text");
  });

  it("preserves links and literal BC0 while restoring formatting", () => {
    const html = '<div>Keep BC0 and BC1 <a href="https://example.com">example</a></div>';
    const { masked, restore } = maskRichHtml(html);
    expect(restore(masked)).toBe(html);
    expect(removeAttachments('<div>Hello</div><bc-attachment sgid="x"/>')).toBe("<div>Hello</div>");
    expect(parseBilingualTodo("[ES] Hola — [EN] Hello", "<h1>[ES]</h1>Hola<h1>[EN]</h1>Hello")?.enDescription).toBe("Hello");
    expect(parseBilingualTodo("[ES] Hola — [EN] Hello", "<h1>[ES]</h1>Hola<h1>[EN]</h1>Hello")?.esDescription).toBe("Hola");
    expect(parseBilingualTodo("[ES] Hola — [EN] Hello", "<div><strong>[BC-ES]</strong></div>Hola<div><strong>[BC-EN]</strong></div>Hello")?.esDescription).toBe("Hola");
  });
});
