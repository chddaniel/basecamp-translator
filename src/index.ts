import { handleSetupRequest, prepareEnv } from "./setup";

export interface Env {
  DB: D1Database;
  TRANSLATION_QUEUE: Queue<QueuedEvent>;
  BASECAMP_CLIENT_ID: string;
  BASECAMP_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  WEBHOOK_PATH_SECRET: string;
  TRANSLATION_PROVIDER?: string;
  TRANSLATION_API_URL?: string;
  TRANSLATION_API_KEY?: string;
  BASECAMP_WEBHOOK_HMAC_SECRET?: string;
  PROJECT_TIME_ZONE?: string;
  SETUP_PASSWORD: string;
}

type Lang = "es" | "en";

interface WebhookEvent {
  id: number | string;
  kind: string;
  created_at?: string;
  creator?: { id: number | string };
  recording?: {
    id: number | string;
    type?: string;
    url?: string;
    bucket?: { id: number | string };
    parent?: { id: number | string };
    creator?: { id: number | string };
  };
}

interface QueuedEvent {
  accountId: string;
  projectId: string;
  event: WebhookEvent;
}

interface ProjectConfig {
  account_id: string;
  project_id: string;
  creator_person_ids: string;
  team_person_ids: string;
  bot_person_id: string;
  enabled: number;
  monthly_char_budget: number;
}

interface Todo {
  id: number | string;
  type: "Todo";
  content: string;
  description: string;
  assignees?: Array<{ id: number | string }>;
  completion_subscribers?: Array<{ id: number | string }>;
  due_on?: string | null;
  starts_on?: string | null;
}

interface Comment {
  id: number | string;
  type: "Comment";
  content: string;
  created_at?: string;
  app_url?: string;
  creator?: { id: number | string; name?: string };
  parent?: { id: number | string; type?: string };
  bucket?: { id: number | string };
}

const TODO_KINDS = new Set([
  "todo_created",
  "todo_active",
  "todo_title_updated",
  "todo_content_updated",
]);

const encoder = new TextEncoder();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    try { env = await prepareEnv(env); }
    catch { return new Response("Set a unique SETUP_PASSWORD of at least 24 characters in Worker secrets before setup.", { status: 503 }); }
    if (url.pathname === "/" || url.pathname.startsWith("/setup") || url.pathname === "/oauth/callback") {
      return handleSetupRequest(request, env);
    }

    const prefix = "/webhooks/basecamp/";
    if (request.method !== "POST" || !url.pathname.startsWith(prefix)) {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname.slice(prefix.length) !== env.WEBHOOK_PATH_SECRET) {
      return new Response("Not found", { status: 404 });
    }

    const rawBody = await request.text();
    if (rawBody.length > 1_000_000) {
      return new Response("Payload too large", { status: 413 });
    }
    if (env.BASECAMP_WEBHOOK_HMAC_SECRET) {
      const signature = request.headers.get("X-Basecamp-Signature");
      if (!signature || !(await verifyHmac(rawBody, signature, env.BASECAMP_WEBHOOK_HMAC_SECRET))) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const event = parseEvent(rawBody);
    if (!event) return new Response("Bad request", { status: 400 });

    const recording = event.recording;
    const accountId = getAccountId(recording?.url);
    const projectId = String(recording?.bucket?.id ?? "");
    if (!accountId || !projectId || !recording?.url || !isBasecampApiUrl(recording.url, accountId)) {
      return new Response("Accepted", { status: 202 });
    }

    const config = await getProjectConfig(env.DB, accountId, projectId);
    if (!config || !config.enabled || !isRelevant(event.kind)) {
      return new Response("Accepted", { status: 202 });
    }

    // Queue identifiers only; fetch content with the bot's own access.
    await env.TRANSLATION_QUEUE.send({ accountId, projectId, event: {
      id: event.id, kind: event.kind, created_at: event.created_at,
      creator: event.creator ? { id: event.creator.id } : undefined,
      recording: { id: recording.id, url: recording.url, bucket: { id: projectId } },
    } });
    return new Response("Accepted", { status: 202 });
  },

  async queue(batch: MessageBatch<QueuedEvent>, env: Env): Promise<void> {
    env = await prepareEnv(env);
    for (const message of batch.messages) {
      try {
        await processEvent(message.body, env);
        message.ack();
      } catch (error) {
        console.error("event processing failed", safeError(error));
        if (safeError(error) === "monthly translation budget exceeded") message.ack();
        else message.retry();
      }
    }
  },
};

function parseEvent(rawBody: string): WebhookEvent | null {
  try {
    const value = JSON.parse(rawBody) as WebhookEvent;
    if (!value.id || !value.kind || !value.recording?.id) return null;
    return value;
  } catch {
    return null;
  }
}

function isRelevant(kind: string): boolean {
  return kind === "comment_created" || TODO_KINDS.has(kind);
}

function getAccountId(resourceUrl?: string): string | null {
  if (!resourceUrl) return null;
  const match = resourceUrl.match(/^https:\/\/3\.basecampapi\.com\/(\d+)\//);
  return match?.[1] ?? null;
}

async function processEvent(item: QueuedEvent, env: Env): Promise<void> {
  const eventKey = `${item.accountId}:${String(item.event.id)}`;
  const existing = await env.DB.prepare(
    "SELECT status FROM webhook_events WHERE account_id = ? AND event_id = ?",
  )
    .bind(item.accountId, eventKey)
    .first<{ status: string }>();
  if (existing?.status === "done") return;
  if (!existing) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO webhook_events(account_id, event_id, received_at, status) VALUES (?, ?, datetime('now'), 'pending')",
    )
      .bind(item.accountId, eventKey)
      .run();
  }

  const config = await getProjectConfig(env.DB, item.accountId, item.projectId);
  if (!config || !config.enabled) return;

  if (item.event.kind === "comment_created") {
    await processComment(item, config, env);
  } else if (TODO_KINDS.has(item.event.kind)) {
    await processTodo(item, config, env);
  }
  await env.DB.prepare("UPDATE webhook_events SET status = 'done' WHERE account_id = ? AND event_id = ?")
    .bind(item.accountId, eventKey)
    .run();
}

async function processComment(
  item: QueuedEvent,
  config: ProjectConfig,
  env: Env,
): Promise<void> {
  const comment = await basecampGet<Comment>(item.event.recording?.url!, env);
  if (comment.type !== "Comment" || !comment.parent?.id || comment.parent.type !== "Todo") return;
  if (comment.bucket && String(comment.bucket.id) !== item.projectId) return;
  if (String(comment.creator?.id) === config.bot_person_id) return;
  if (hasTranslationMarker(comment.content)) return;

  const translatableContent = removeAttachments(comment.content);
  const sourceText = stripHtml(translatableContent);
  if (!sourceText) return;

  const sourceLang = detectLanguage(sourceText);
  if (!sourceLang) return;
  const targetLang: Lang = sourceLang === "es" ? "en" : "es";
  const sourceHash = await sha256(`${sourceLang}:${translatableContent}`);

  const prior = await env.DB.prepare(
    "SELECT 1 FROM comment_state WHERE account_id = ? AND source_comment_id = ? AND source_hash = ?",
  )
    .bind(item.accountId, String(comment.id), sourceHash)
    .first();
  if (prior) return;

  const label = targetLang === "en" ? "English translation" : "Traducción al español";
  const author = comment.creator?.name?.trim() || "Basecamp user";
  const time = formatCommentTime(comment.created_at ?? item.event.created_at, env.PROJECT_TIME_ZONE);
  const sourceLink = `https://app.basecamp.com/${item.accountId}/buckets/${item.projectId}/todos/${comment.parent.id}#__recording_${comment.id}`;
  const timeHtml = time
    ? sourceLink
      ? `<a href="${escapeHtml(sourceLink)}">${escapeHtml(time)}</a>`
      : escapeHtml(time)
    : "";
  const attribution = [escapeHtml(author), timeHtml].filter(Boolean).join(" · ");
  const existing = await basecampGet<Comment[]>(
    `https://3.basecampapi.com/${item.accountId}/recordings/${comment.parent.id}/comments.json`,
    env,
  );
  const alreadyPosted = existing.some(
    (candidate) =>
      String(candidate.creator?.id) === config.bot_person_id &&
      Boolean(sourceLink && candidate.content.includes(`__recording_${comment.id}`)),
  );
  if (alreadyPosted) return;

  await chargeUsage(env.DB, item.accountId, config.monthly_char_budget, translatableContent.length);
  const translated = await translateRichHtml(translatableContent, sourceLang, targetLang, env);
  const body = `<div><strong>${escapeHtml(label)}</strong>${attribution ? ` · ${attribution}` : ""}</div>${translated}`;
  const created = await basecampPost<{ id: number | string }>(
    `/recordings/${comment.parent.id}/comments.json`,
    { content: body },
    env,
    item.accountId,
  );

  await env.DB.prepare(
    "INSERT INTO comment_state(account_id, source_comment_id, source_hash, translation_comment_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
  )
    .bind(item.accountId, String(comment.id), sourceHash, String(created.id))
    .run();
}

async function processTodo(
  item: QueuedEvent,
  config: ProjectConfig,
  env: Env,
): Promise<void> {
  const todo = await basecampGet<Todo>(item.event.recording?.url!, env);
  if (todo.type !== "Todo") return;

  const parsed = parseBilingualTodo(todo.content, todo.description);
  const prior = await env.DB.prepare(
    "SELECT es_hash, en_hash FROM todo_state WHERE account_id = ? AND todo_id = ?",
  )
    .bind(item.accountId, String(todo.id))
    .first<{ es_hash: string; en_hash: string }>();

  let esTitle: string;
  let enTitle: string;
  let esDescription: string;
  let enDescription: string;
  let sourceLang: Lang;

  if (parsed) {
    esTitle = parsed.esTitle;
    enTitle = parsed.enTitle;
    esDescription = parsed.esDescription;
    enDescription = parsed.enDescription;
    const esHash = await hashTodoLanguage(esTitle, esDescription);
    const enHash = await hashTodoLanguage(enTitle, enDescription);
    if (prior && esHash === prior.es_hash && enHash === prior.en_hash) return;

    const esChanged = !prior || esHash !== prior.es_hash;
    const enChanged = !prior || enHash !== prior.en_hash;
    sourceLang = esChanged && !enChanged ? "es" : enChanged && !esChanged ? "en" : sourceFromActor(item, config) ?? detectLanguage(stripHtml(todo.content)) ?? "en";
  } else {
    sourceLang = sourceFromActor(item, config) ?? detectLanguage(stripHtml(todo.content)) ?? "en";
    esTitle = sourceLang === "es" ? todo.content : "";
    enTitle = sourceLang === "en" ? todo.content : "";
    esDescription = sourceLang === "es" ? todo.description : "";
    enDescription = sourceLang === "en" ? todo.description : "";
  }

  const sourceTitle = sourceLang === "es" ? esTitle : enTitle;
  if (!sourceTitle.trim()) return;
  const targetLang: Lang = sourceLang === "es" ? "en" : "es";

  const sourceDescription = sourceLang === "es" ? esDescription : enDescription;
  await chargeUsage(env.DB, item.accountId, config.monthly_char_budget, sourceTitle.length + sourceDescription.length);
  const translatedTitle = await translateRichHtml(sourceTitle, sourceLang, targetLang, env);
  const translatedDescription = sourceDescription.trim()
    ? await translateRichHtml(sourceDescription, sourceLang, targetLang, env)
    : "";
  if (sourceLang === "es") {
    enTitle = translatedTitle;
    enDescription = translatedDescription;
  } else {
    esTitle = translatedTitle;
    esDescription = translatedDescription;
  }

  const title = `[ES] ${esTitle} — [EN] ${enTitle}`;
  const description = composeBilingualDescription(esDescription, enDescription);

  await basecampPut(
    `/todos/${todo.id}.json`,
    {
      content: title,
      description,
      assignee_ids: (todo.assignees ?? []).map((person) => person.id),
      completion_subscriber_ids: (todo.completion_subscribers ?? []).map((person) => person.id),
      due_on: todo.due_on ?? null,
      starts_on: todo.starts_on ?? null,
    },
    env,
    item.accountId,
  );

  await env.DB.prepare(
    "INSERT INTO todo_state(account_id, todo_id, es_hash, en_hash, updated_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(account_id, todo_id) DO UPDATE SET es_hash=excluded.es_hash, en_hash=excluded.en_hash, updated_at=excluded.updated_at",
  )
    .bind(item.accountId, String(todo.id), await hashTodoLanguage(esTitle, esDescription), await hashTodoLanguage(enTitle, enDescription))
    .run();
}

function sourceFromActor(item: QueuedEvent, config: ProjectConfig): Lang | null {
  const actor = String(item.event.creator?.id ?? "");
  const creators = parseIds(config.creator_person_ids);
  const team = parseIds(config.team_person_ids);
  if (creators.includes(actor)) return "es";
  if (team.includes(actor) || actor === config.bot_person_id) return "en";
  return null;
}

function parseIds(value: string): string[] {
  try {
    const ids = JSON.parse(value) as Array<string | number>;
    return ids.map(String);
  } catch {
    return [];
  }
}

function parseBilingualTodo(
  title: string,
  description: string,
): { esTitle: string; enTitle: string; esDescription: string; enDescription: string } | null {
  const match = title.match(/^\[ES\]\s*([\s\S]*?)\s+—\s+\[EN\]\s*([\s\S]*)$/);
  if (!match) return null;
  const esToken = description.includes("[BC-ES]") ? "[BC-ES]" : "[ES]";
  const enToken = description.includes("[BC-EN]") ? "[BC-EN]" : "[EN]";
  const esMarker = description.indexOf(esToken);
  const enMarker = description.indexOf(enToken);
  if (esMarker < 0 || enMarker < 0) {
    return { esTitle: match[1], enTitle: match[2], esDescription: description, enDescription: "" };
  }
  return {
    esTitle: match[1],
    enTitle: match[2],
    esDescription: cleanDescriptionSegment(description.slice(esMarker + esToken.length, enMarker)),
    enDescription: cleanDescriptionSegment(description.slice(enMarker + enToken.length)),
  };
}

function cleanDescriptionSegment(value: string): string {
  return value
    .replace(/^\s*(?:<\/strong><\/div>|<\/h1>)/i, "")
    .replace(/(?:<div>\s*<strong>|<h1(?:\s[^>]*)?>)\s*$/i, "")
    .trim();
}

function composeBilingualDescription(es: string, en: string): string {
  if (!es.trim() && !en.trim()) return "";
  const normalizedEs = normalizeRichTextAttachments(es);
  const normalizedEn = normalizeRichTextAttachments(en);
  const longMessage = stripHtml(normalizedEs).length + stripHtml(normalizedEn).length >= 600;
  const marker = (language: "ES" | "EN") =>
    longMessage ? `<h1>[${language}]</h1>` : `<div><strong>[${language}]</strong></div>`;
  return `${marker("ES")}${normalizedEs}${marker("EN")}${normalizedEn}`;
}

function normalizeRichTextAttachments(value: string): string {
  return value.replace(
    /<bc-attachment\b([^>]*)>[\s\S]*?<\/bc-attachment>/gi,
    (_match, attributes: string) => `<bc-attachment${attributes}></bc-attachment>`,
  );
}

async function hashTodoLanguage(title: string, description: string): Promise<string> {
  return sha256(`${title}\n---\n${description}`);
}

function detectLanguage(text: string): Lang | null {
  const value = text.toLowerCase();
  const spanish = (value.match(/\b(el|la|los|las|que|para|con|una|por|del|este|esta|necesito|puede|gracias)\b/g) ?? []).length;
  const english = (value.match(/\b(the|and|for|with|this|that|need|please|thanks|can|will)\b/g) ?? []).length;
  if (/[ñ¿¡]/.test(value) || spanish >= english + 1) return "es";
  if (english >= spanish + 1) return "en";
  return null;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function removeAttachments(value: string): string {
  return value
    .replace(/<bc-attachment\b[\s\S]*?<\/bc-attachment>/gi, "")
    .replace(/<bc-attachment\b[^>]*\/?\s*>/gi, "")
    .trim();
}

function hasTranslationMarker(value: string): boolean {
  return /(?:\[(?:EN translation|Traducción ES)[^\]]*\]|English translation|Traducción al español)/i.test(stripHtml(value));
}

function formatCommentTime(value?: string, timeZone = "UTC"): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    }).format(date);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function translateRichHtml(html: string, sourceLang: Lang, targetLang: Lang, env: Env): Promise<string> {
  const { masked, restore } = maskRichHtml(html);
  if (env.TRANSLATION_PROVIDER === "google_nmt") {
    if (!env.TRANSLATION_API_KEY) throw new Error("Google Translation API key is not configured");
    const endpoint = new URL(env.TRANSLATION_API_URL ?? "https://translation.googleapis.com/language/translate/v2");
    endpoint.searchParams.set("key", env.TRANSLATION_API_KEY);
    const result = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        q: masked,
        source: sourceLang,
        target: targetLang,
        format: "html",
      }),
    });
    if (!result.ok) throw new Error(`Google Translation API ${result.status}`);
    const payload = (await result.json()) as { data?: { translations?: Array<{ translatedText?: string }> } };
    const translated = payload.data?.translations?.[0]?.translatedText;
    if (!translated) throw new Error("Google Translation API returned no translation");
    return restore(translated);
  }

  throw new Error("translation provider is not configured");
}

function maskRichHtml(value: string): { masked: string; restore: (value: string) => string } {
  const preserved: string[] = [];
  const hold = (part: string): string => {
    // Keep the sentinel ASCII-only. The translation model can drop the
    // Unicode brackets that were previously used here, causing BC0/BC1 to
    // leak into the translated content instead of being restored.
    const token = `__BC_TAG_${preserved.length}__`;
    preserved.push(part);
    return token;
  };
  const masked = normalizeRichTextAttachments(value)
    .replace(/<bc-attachment\b[\s\S]*?<\/bc-attachment>/gi, hold)
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, hold)
    .replace(/<a\b[\s\S]*?<\/a>/gi, hold)
    .replace(/https?:\/\/[^\s<]+/gi, hold)
    .replace(/<[^>]+>/g, hold);
  return {
    masked,
    restore: (translated) =>
      translated.replace(
        /__\s*BC[_ -]*TAG[_ -]*(\d+)\s*__/gi,
        (match, index: string) => preserved[Number(index)] ?? match,
      ),
  };
}

async function basecampGet<T>(resourceUrl: string, env: Env): Promise<T> {
  const response = await basecampRequest(resourceUrl, "GET", undefined, env);
  return (await response.json()) as T;
}

async function basecampPost<T>(path: string, body: unknown, env: Env, accountId: string): Promise<T> {
  const response = await basecampRequest(`${accountId}${path}`, "POST", body, env);
  return (await response.json()) as T;
}

async function basecampPut(path: string, body: unknown, env: Env, accountId: string): Promise<void> {
  await basecampRequest(`${accountId}${path}`, "PUT", body, env);
}

async function basecampRequest(resourceOrPath: string, method: string, body: unknown, env: Env): Promise<Response> {
  const token = await getBasecampToken(env);
  const url = resourceOrPath.startsWith("https://")
    ? resourceOrPath
    : `https://3.basecampapi.com/${resourceOrPath.replace(/^\/+/, "")}`;
  if (!isBasecampApiUrl(url)) throw new Error("Invalid Basecamp API URL");
  const response = await fetch(url, {
    redirect: "error",
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "user-agent": "Basecamp Translator (https://github.com/chddaniel/basecamp-translator)",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Basecamp ${method} ${response.status}`);
  return response;
}

async function getProjectConfig(db: D1Database, accountId: string, projectId: string): Promise<ProjectConfig | null> {
  return db.prepare("SELECT * FROM project_config WHERE account_id = ? AND project_id = ?").bind(accountId, projectId).first<ProjectConfig>();
}

async function chargeUsage(db: D1Database, accountId: string, budget: number, amount: number): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  if (amount > budget) throw new Error("monthly translation budget exceeded");
  const reserved = await db.prepare("INSERT INTO usage_counter(account_id, month, characters) VALUES (?, ?, ?) ON CONFLICT(account_id, month) DO UPDATE SET characters=characters+excluded.characters WHERE characters+excluded.characters <= ? RETURNING characters")
    .bind(accountId, month, amount, budget).first();
  if (!reserved) throw new Error("monthly translation budget exceeded");
}

async function getBasecampToken(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT * FROM oauth_token WHERE token_name = 'basecamp'").first<{ access_ciphertext: string; refresh_ciphertext: string; expires_at: string }>();
  if (!row) throw new Error("Basecamp OAuth token is not initialized");
  if (Date.parse(row.expires_at) > Date.now() + 120_000) return decrypt(row.access_ciphertext, env.TOKEN_ENCRYPTION_KEY);

  const refreshToken = await decrypt(row.refresh_ciphertext, env.TOKEN_ENCRYPTION_KEY);
  const response = await fetch("https://launchpad.37signals.com/authorization/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: env.BASECAMP_CLIENT_ID, client_secret: env.BASECAMP_CLIENT_SECRET }),
  });
  if (!response.ok) throw new Error(`Basecamp OAuth refresh ${response.status}`);
  const token = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
  await env.DB.prepare("UPDATE oauth_token SET access_ciphertext = ?, refresh_ciphertext = ?, expires_at = ? WHERE token_name = 'basecamp'").bind(await encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY), await encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY), new Date(Date.now() + token.expires_in * 1000).toISOString()).run();
  return token.access_token;
}

async function encrypt(value: string, keyText: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", decodeBase64(keyText), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value)));
  return `${toBase64(iv)}.${toBase64(ciphertext)}`;
}

async function decrypt(value: string, keyText: string): Promise<string> {
  const [ivText, ciphertextText] = value.split(".");
  const key = await crypto.subtle.importKey("raw", decodeBase64(keyText), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(ivText) }, key, decodeBase64(ciphertextText));
  return new TextDecoder().decode(plaintext);
}

async function sha256(value: string): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

function toBase64(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += String.fromCharCode(byte);
  return btoa(result);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function verifyHmac(payload: string, supplied: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  const expected = toBase64(signature);
  const candidate = supplied.replace(/^sha256=/i, "");
  if (candidate.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ candidate.charCodeAt(index);
  return difference === 0;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export function isBasecampApiUrl(value: string, accountId?: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://3.basecampapi.com" && !url.username && !url.password &&
      /^\/\d+\//.test(url.pathname) && (!accountId || url.pathname.startsWith(`/${accountId}/`));
  } catch { return false; }
}

export { basecampGet, basecampPost, basecampRequest, getBasecampToken, encrypt, sha256,
  escapeHtml, removeAttachments, parseBilingualTodo, composeBilingualDescription, maskRichHtml };
