import { supportedLanguages } from "./languages";
import {
  type Env, basecampGet, basecampPost, basecampRequest, getBasecampToken,
  encrypt, sha256, escapeHtml as h, isBasecampApiUrl,
} from "./index";

type Account = { id: number; name: string; product: string };
type Person = { id: number; name: string; email_address?: string; client?: boolean };
type Project = { id: number; name: string };
type Config = { account_id: string; project_id: string; enabled: number; bot_person_id: string; monthly_char_budget: number; language_a: string; language_b: string; language_a_name: string; language_b_name: string };
const encoder = new TextEncoder();
const cookieName = "translator_setup";
const api = "https://3.basecampapi.com";
const userAgent = "Basecamp Translator (https://github.com/chddaniel/basecamp-translator)";

export async function prepareEnv(env: Env): Promise<Env> {
  if (!env.SETUP_PASSWORD || env.SETUP_PASSWORD.length < 24) throw new Error("Setup password too short");
  return {
    ...env,
    TOKEN_ENCRYPTION_KEY: await sha256(`encryption:${env.SETUP_PASSWORD}`),
    WEBHOOK_PATH_SECRET: (await sha256(`webhook:${env.SETUP_PASSWORD}`)).replace(/[+/=]/g, ""),
  };
}

async function signature(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function equal(a: string, b: string): Promise<boolean> {
  return (await sha256(a)) === (await sha256(b));
}

async function sessionValid(request: Request, env: Env): Promise<boolean> {
  const value = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!value) return false;
  const [expiry, nonce, mac] = value.split(".");
  if (!expiry || !nonce || !mac || Number(expiry) <= Date.now()) return false;
  return equal(mac, await signature(`${expiry}.${nonce}`, env.SETUP_PASSWORD));
}

function redirect(path: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location: path, "cache-control": "no-store", ...headers } });
}

function page(content: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Basecamp Translator · Daniel Ch</title><style>
  :root{font:17px/1.6 system-ui,sans-serif;color:#172a35;background:#f4f7f6}body{max-width:850px;margin:50px auto;padding:0 24px}h1{font-size:2.4rem;letter-spacing:-.04em;margin:0}h2{font-size:1.3rem}a{color:#16614e}header{margin-bottom:28px}main,.card{background:white;border:1px solid #dce6e1;border-radius:16px;padding:28px;margin-bottom:22px}label{display:block;margin:12px 0}input:not([type=checkbox]),select{display:block;box-sizing:border-box;padding:12px;width:100%;font:inherit;border:1px solid #b8c9c0;border-radius:7px}input[type=checkbox]{width:18px;height:18px;margin-right:8px}button,.button{display:inline-block;background:#17634f;color:white;border:0;border-radius:8px;padding:12px 20px;font:inherit;cursor:pointer;text-decoration:none}small,.muted{color:#51665b}code{overflow-wrap:anywhere;font-size:.87em}fieldset{border:1px solid #dce6e1;border-radius:8px;margin:20px 0;padding:16px}footer{font-size:.85rem;margin:24px 0}.notice{background:#eff7f2;padding:16px;border-radius:8px}details{margin:20px 0}hr{border:0;border-top:1px solid #dce6e1;margin:24px 0}
  </style></head><body><header><h1>Basecamp Translator</h1><div class="muted">Two languages. One Basecamp project.</div></header><main>${content}</main><footer>Made by <a href="https://github.com/chddaniel">Daniel Ch</a> · <a href="https://github.com/chddaniel/basecamp-translator">Free & open source</a> · Community-supported</footer></body></html>`, {
    status, headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    },
  });
}

function loginPage(message = ""): Response {
  return page(`<h2>Set up your translator</h2><p>This is your private installation. Connect a dedicated Basecamp bot account, then choose the projects to translate.</p>${message ? `<p>${h(message)}</p>` : ""}<form method="post" action="/setup/login"><label>Setup password<input type="password" name="password" required autocomplete="current-password" maxlength="512"></label><button>Continue</button></form><p><small>Use the SETUP_PASSWORD you supplied when deploying this Worker.</small></p>`);
}

async function accounts(env: Env): Promise<Account[]> {
  const token = await getBasecampToken(env);
  const response = await fetch("https://launchpad.37signals.com/authorization.json", {
    headers: { authorization: `Bearer ${token}`, "user-agent": userAgent }, redirect: "error",
  });
  if (!response.ok) throw new Error(`Authorization lookup failed (${response.status})`);
  const value = await response.json() as { accounts: Account[] };
  return value.accounts.filter(account => account.product === "bc3");
}

async function all<T>(url: string, accountId: string, env: Env): Promise<T[]> {
  const items: T[] = [];
  for (let page = 0; url && page < 100; page++) {
    if (!isBasecampApiUrl(url, accountId)) throw new Error("Invalid pagination URL");
    const response = await basecampRequest(url, "GET", undefined, env);
    items.push(...await response.json() as T[]);
    url = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? "";
  }
  if (url) throw new Error("Too many pages; use a smaller account");
  return items;
}

async function authorizedAccount(id: string, env: Env): Promise<Account> {
  const account = (await accounts(env)).find(item => String(item.id) === id);
  if (!account) throw new Error("This bot cannot access that account");
  return account;
}

function numeric(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Choose a valid account/project");
  return value;
}

export async function handleSetupRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method !== "GET" && request.method !== "POST") return page("Method not allowed", 405);
    if (request.method === "POST" && request.headers.get("origin") !== url.origin) return page("Request origin was not accepted.", 403);
    if (request.method === "POST" && Number(request.headers.get("content-length") ?? 0) > 16000) return page("Form is too large", 413);
    if (url.pathname === "/setup/login" && request.method === "POST") {
      const form = await request.formData();
      const supplied = String(form.get("password") ?? "");
      if (!await equal(supplied, env.SETUP_PASSWORD)) return loginPage("That password was not accepted.");
      const payload = `${Date.now() + 60 * 60 * 1000}.${crypto.randomUUID()}`;
      const value = `${payload}.${await signature(payload, env.SETUP_PASSWORD)}`;
      return redirect("/setup", { "set-cookie": `${cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${url.protocol === "https:" ? "; Secure" : ""}` });
    }
    if (!await sessionValid(request, env)) return loginPage();
    if (url.pathname === "/setup/logout" && request.method === "POST") {
      return redirect("/setup", { "set-cookie": `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
    }
    if (url.pathname === "/setup/connect" && request.method === "POST") {
      if (!env.BASECAMP_CLIENT_ID || !env.BASECAMP_CLIENT_SECRET) throw new Error("Set BASECAMP_CLIENT_ID and BASECAMP_CLIENT_SECRET in Worker secrets first.");
      const state = crypto.randomUUID();
      await env.DB.prepare("DELETE FROM setup_oauth_state WHERE expires_at < ?").bind(Date.now()).run();
      await env.DB.prepare("INSERT INTO setup_oauth_state(state_hash, expires_at) VALUES (?, ?)").bind(await sha256(state), Date.now() + 600000).run();
      const auth = new URL("https://launchpad.37signals.com/authorization/new");
      auth.search = new URLSearchParams({ type: "web_server", client_id: env.BASECAMP_CLIENT_ID, redirect_uri: `${url.origin}/oauth/callback`, state }).toString();
      return redirect(auth.href);
    }
    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      if (url.searchParams.has("error")) throw new Error("Basecamp authorization was cancelled. You can try again.");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) throw new Error("Missing authorization code or state. Start again from setup.");
      const valid = await env.DB.prepare("DELETE FROM setup_oauth_state WHERE state_hash = ? AND expires_at > ? RETURNING state_hash").bind(await sha256(state), Date.now()).first();
      if (!valid) throw new Error("Authorization expired or was already used. Start again from setup.");
      const response = await fetch("https://launchpad.37signals.com/authorization/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "error",
        body: new URLSearchParams({ type: "web_server", code, client_id: env.BASECAMP_CLIENT_ID, client_secret: env.BASECAMP_CLIENT_SECRET, redirect_uri: `${url.origin}/oauth/callback` }),
      });
      if (!response.ok) throw new Error("Basecamp could not exchange the authorization code. Start again from setup.");
      const token = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
      if (typeof token.access_token !== "string" || !token.access_token || typeof token.refresh_token !== "string" || !token.refresh_token || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new Error("Incomplete authorization response");
      // Reconnection must preserve the identity already configured for each account.
      const configured = (await env.DB.prepare("SELECT DISTINCT account_id, bot_person_id FROM project_config").all<Config>()).results;
      for (const config of configured) {
        const profile = await fetch(`${api}/${config.account_id}/my/profile.json`, { headers: { authorization: `Bearer ${token.access_token}`, "user-agent": userAgent }, redirect: "error" });
        if (!profile.ok || String((await profile.json() as Person).id) !== config.bot_person_id) throw new Error("This is a different Basecamp user. Reconnect as the original Translate Bot.");
      }
      await env.DB.prepare("INSERT INTO oauth_token(token_name, access_ciphertext, refresh_ciphertext, expires_at) VALUES ('basecamp', ?, ?, ?) ON CONFLICT(token_name) DO UPDATE SET access_ciphertext=excluded.access_ciphertext, refresh_ciphertext=excluded.refresh_ciphertext, expires_at=excluded.expires_at")
        .bind(await encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY), await encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY), new Date(Date.now() + token.expires_in * 1000).toISOString()).run();
      return redirect("/setup");
    }
    if (url.pathname === "/setup/enable" && request.method === "POST") {
      const form = await request.formData();
      const accountId = numeric(form.get("account"));
      const projectId = numeric(form.get("project"));
      await authorizedAccount(accountId, env);
      const profile = await basecampGet<Person>(`${api}/${accountId}/my/profile.json`, env);
      if (String(form.get("confirm_bot")) !== String(profile.id)) throw new Error("Confirm the posting identity first.");
      const people = await all<Person>(`${api}/${accountId}/projects/${projectId}/people.json`, accountId, env);
      if (!people.some(person => person.id === profile.id)) throw new Error("Add the bot to this project first.");
      const languages = await supportedLanguages(env);
      const languageA = languages.find(item => item.language === String(form.get("language_a") ?? "es"));
      const languageB = languages.find(item => item.language === String(form.get("language_b") ?? "en"));
      if (!languageA || !languageB || languageA.language === languageB.language) throw new Error("Choose two different languages supported by Google NMT.");
      const existing = await env.DB.prepare("SELECT * FROM project_config WHERE account_id=? AND project_id=?").bind(accountId, projectId).first<Config>();
      if (existing && (existing.language_a !== languageA.language || existing.language_b !== languageB.language)) {
        const translatedTodos = await env.DB.prepare("SELECT 1 FROM todo_state WHERE account_id=? AND (project_id=? OR project_id IS NULL) LIMIT 1").bind(accountId, projectId).first();
        // v0.1 state did not record project IDs: protect those older rows too.
        if (translatedTodos) throw new Error("Bilingual to-dos already use this project's pair (or legacy v0.1 state exists). Keep the existing pair; configure a new project for another pair.");
      }
      const groupA = [...form.getAll("language_a_people"), ...form.getAll("spanish")].map(numeric);
      if (groupA.some(id => !people.some(person => String(person.id) === id)) || groupA.includes(String(profile.id))) throw new Error("Choose project members other than the bot.");
      const groupB = people.filter(person => person.id !== profile.id && !groupA.includes(String(person.id))).map(person => String(person.id));
      const budget = Number(form.get("budget"));
      if (!Number.isSafeInteger(budget) || budget < 1000 || budget > 500000) throw new Error("Choose a monthly budget between 1,000 and 500,000 characters.");
      if (!env.TRANSLATION_API_KEY) throw new Error("Set TRANSLATION_API_KEY in Worker secrets before enabling translation.");
      // Pause while configuring, so partial setup never starts translating.
      await env.DB.prepare("INSERT INTO project_config(account_id,project_id,creator_person_ids,team_person_ids,bot_person_id,enabled,monthly_char_budget,language_a,language_b,language_a_name,language_b_name) VALUES (?,?,?,?,?,0,?,?,?,?,?) ON CONFLICT(account_id,project_id) DO UPDATE SET creator_person_ids=excluded.creator_person_ids,team_person_ids=excluded.team_person_ids,bot_person_id=excluded.bot_person_id,enabled=0,monthly_char_budget=excluded.monthly_char_budget,language_a=excluded.language_a,language_b=excluded.language_b,language_a_name=excluded.language_a_name,language_b_name=excluded.language_b_name")
        .bind(accountId, projectId, JSON.stringify(groupA), JSON.stringify(groupB), String(profile.id), budget, languageA.language, languageB.language, languageA.name, languageB.name).run();
      const payload = `${url.origin}/webhooks/basecamp/${env.WEBHOOK_PATH_SECRET}`;
      const hooks = await all<{ id: number; payload_url: string; active: boolean; types: string[] }>(`${api}/${accountId}/buckets/${projectId}/webhooks.json`, accountId, env);
      const hook = hooks.find(item => item.payload_url === payload);
      if (!hook) await basecampPost(`/buckets/${projectId}/webhooks.json`, { payload_url: payload, types: ["Todo", "Comment"] }, env, accountId);
      else await basecampRequest(`${api}/${accountId}/webhooks/${hook.id}.json`, "PUT", { payload_url: payload, types: ["Todo", "Comment"], active: true }, env);
      await env.DB.prepare("UPDATE project_config SET enabled=1 WHERE account_id=? AND project_id=?").bind(accountId, projectId).run();
      return redirect(`/setup?account=${accountId}&project=${projectId}&saved=1`);
    }
    if (url.pathname === "/setup/pause" && request.method === "POST") {
      const form = await request.formData();
      const accountId = numeric(form.get("account")); const projectId = numeric(form.get("project"));
      await authorizedAccount(accountId, env);
      await env.DB.prepare("UPDATE project_config SET enabled=0 WHERE account_id=? AND project_id=?").bind(accountId, projectId).run();
      return redirect(`/setup?account=${accountId}&project=${projectId}`);
    }
    if (request.method !== "GET" || !["/", "/setup"].includes(url.pathname)) return page("Not found", 404);
    const tokenRow = await env.DB.prepare("SELECT token_name FROM oauth_token WHERE token_name='basecamp'").first();
    let content = `<form method="post" action="/setup/logout"><button>Sign out</button></form>`;
    content += `<details${tokenRow ? "" : " open"}><summary>1. Connect your Basecamp bot</summary><p>Create a dedicated Basecamp user named Translate Bot and add it to the projects you want translated. Sign into Basecamp as that bot before continuing. An administrator may need to create its project webhooks.</p><p>Register your own OAuth app at <a href="https://launchpad.37signals.com/integrations">Basecamp integrations</a>. Its redirect URI must be:</p><code>${h(url.origin)}/oauth/callback</code><p>Add its client ID and secret to this Worker's secrets if you haven't already.</p><form method="post" action="/setup/connect"><button>${tokenRow ? "Reconnect same bot" : "Connect Basecamp"}</button></form></details>`;
    if (!tokenRow) return page(content);
    const available = await accounts(env);
    content += `<h2>2. Choose your account and project</h2><p>${available.map(account => `<a href="/setup?account=${account.id}">${h(account.name)}</a>`).join(" · ") || "No Basecamp accounts available for this bot."}</p>`;
    const accountId = url.searchParams.get("account");
    if (!accountId) return page(content);
    numeric(accountId); await authorizedAccount(accountId, env);
    const projects = await all<Project>(`${api}/${accountId}/projects.json`, accountId, env);
    content += `<form method="get" action="/setup"><input type="hidden" name="account" value="${accountId}"><label>Project<select name="project">${projects.map(project => `<option value="${project.id}"${String(project.id) === url.searchParams.get("project") ? " selected" : ""}>${h(project.name)}</option>`).join("")}</select></label><button>Choose project</button></form>`;
    const projectId = url.searchParams.get("project");
    if (!projectId) return page(content);
    numeric(projectId);
    if (!projects.some(project => String(project.id) === projectId)) throw new Error("Choose a project available to this bot.");
    const profile = await basecampGet<Person>(`${api}/${accountId}/my/profile.json`, env);
    const people = await all<Person>(`${api}/${accountId}/projects/${projectId}/people.json`, accountId, env);
    const config = await env.DB.prepare("SELECT * FROM project_config WHERE account_id=? AND project_id=?").bind(accountId, projectId).first<Config & { creator_person_ids: string }>();
    const groupA: string[] = config ? JSON.parse(config.creator_person_ids) : [];
    const languages = await supportedLanguages(env);
    const options = (selected: string) => languages.map(language => `<option value="${h(language.language)}"${language.language === selected ? " selected" : ""}>${h(language.name)} (${h(language.language)})</option>`).join("");
    const usage = await env.DB.prepare("SELECT characters FROM usage_counter WHERE account_id=? AND month=?").bind(accountId, new Date().toISOString().slice(0, 7)).first<{ characters: number }>();
    content += `<hr><p class="notice">Translations will be posted as <strong>${h(profile.name)}</strong>${profile.email_address ? ` (${h(profile.email_address)})` : ""}. Check this is your bot before enabling.</p><p>Status: <strong>${config?.enabled ? "Enabled" : "Paused / not configured"}</strong>. Account usage this month: ${(usage?.characters ?? 0).toLocaleString()} characters.</p>`;
    if (url.searchParams.has("saved")) content += `<p class="notice">Ready. New to-dos and to-do comments in this project will be translated. Existing history is not backfilled.</p>`;
    content += `<form method="post" action="/setup/enable"><input type="hidden" name="account" value="${accountId}"><input type="hidden" name="project" value="${projectId}"><fieldset><legend>Project language pair</legend><label>Language A<select name="language_a">${options(config?.language_a ?? "es")}</select></label><label>Language B<select name="language_b">${options(config?.language_b ?? "en")}</select></label><p><small>Choose any two languages in Google's NMT list. Pick the pair before enabling: once this project has bilingual to-dos, its pair is locked to protect their labels.</small></p></fieldset><fieldset><legend>Who normally writes to-dos in language A?</legend><p><small>Other people use language B as their preference for ambiguous to-dos. Google detects comment and new to-do languages; text outside this pair is skipped. Very short or mixed text can be misidentified.</small></p>${people.filter(person => person.id !== profile.id).map(person => `<label><input type="checkbox" name="language_a_people" value="${person.id}"${groupA.includes(String(person.id)) ? " checked" : ""}>${h(person.name)}</label>`).join("")}</fieldset><label>Monthly character limit for this project (checked against shared account usage)<input type="number" name="budget" min="1000" max="500000" value="${config?.monthly_char_budget ?? 100000}" required></label><p><small>This is an application guard, not a Google billing cap. Use the same limit for projects sharing an account. Retries also consume allowance.</small></p><label><input type="checkbox" name="confirm_bot" value="${profile.id}" required>I confirm ${h(profile.name)} is the account that should post translations.</label><p>Enabling creates or updates this installation's project webhook. To-do titles and descriptions will become bilingual; comments get a separate translated reply. Text is sent to your Google Translation project for language detection and translation. Both consume character allowance.</p><button>Enable translation for this project</button></form>`;
    if (config?.enabled) content += `<hr><form method="post" action="/setup/pause"><input type="hidden" name="account" value="${accountId}"><input type="hidden" name="project" value="${projectId}"><button>Pause translation</button></form>`;
    return page(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Setup could not complete";
    // Only controlled errors/statuses are displayed; never reflect upstream response bodies or secrets.
    return page(`<h2>Setup needs attention</h2><p>${h(message)}</p><p>Check bot membership, admin permissions, OAuth settings and Worker secrets.</p><a href="/setup">Back to setup</a>`, 400);
  }
}
