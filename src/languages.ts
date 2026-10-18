import type { Env } from "./index";

export type Language = { language: string; name: string };
export type LanguagePair = { a: string; b: string };
export const DEFAULT_PAIR: LanguagePair = { a: "es", b: "en" };

// Google uses legacy identifiers for a few languages in different API responses.
function canonical(code: string): string {
  const value = code.toLowerCase();
  return ({ iw: "he", jw: "jv", fil: "tl", nb: "no", "zh-hans": "zh-cn", "zh-hant": "zh-tw" } as Record<string, string>)[value] ?? value;
}

export function matchPairLanguage(detected: string, pair: LanguagePair): string | null {
  const value = canonical(detected);
  const exact = [pair.a, pair.b].find(code => canonical(code) === value);
  if (exact) return exact;
  // Detection can return a base code (e.g. zh) while a configured language uses
  // a region/script code (e.g. zh-TW). Only resolve an unambiguous base match.
  const candidates = [pair.a, pair.b].filter(code => canonical(code).split("-")[0] === value.split("-")[0]);
  return candidates.length === 1 ? candidates[0] : null;
}

export async function supportedLanguages(env: Env): Promise<Language[]> {
  const cached = await env.DB.prepare("SELECT payload FROM provider_cache WHERE cache_key='google_nmt_languages' AND expires_at>?")
    .bind(Date.now()).first<{ payload: string }>();
  if (cached) return JSON.parse(cached.payload) as Language[];
  if (!env.TRANSLATION_API_KEY) throw new Error("Set TRANSLATION_API_KEY before choosing your languages.");
  const endpoint = new URL("https://translation.googleapis.com/language/translate/v2/languages");
  endpoint.search = new URLSearchParams({ key: env.TRANSLATION_API_KEY, target: "en", model: "nmt" }).toString();
  const response = await fetch(endpoint, { redirect: "error" });
  if (!response.ok) throw new Error(`Google language list unavailable (${response.status}). Check your API key and retry.`);
  const data = await response.json() as { data?: { languages?: Language[] } };
  const languages = data.data?.languages?.filter(item => /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(item.language) && typeof item.name === "string");
  if (!languages?.length) throw new Error("Google returned no supported languages.");
  languages.sort((a, b) => a.name.localeCompare(b.name));
  await env.DB.prepare("INSERT INTO provider_cache(cache_key,payload,expires_at) VALUES ('google_nmt_languages',?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at")
    .bind(JSON.stringify(languages), Date.now() + 86400000).run();
  return languages;
}

export async function detectGoogleLanguage(text: string, env: Env): Promise<string | null> {
  if (!env.TRANSLATION_API_KEY) throw new Error("Google Translation API key is not configured");
  const endpoint = new URL("https://translation.googleapis.com/language/translate/v2/detect");
  endpoint.searchParams.set("key", env.TRANSLATION_API_KEY);
  const response = await fetch(endpoint, {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: text }),
  });
  if (!response.ok) throw new Error(`Google language detection ${response.status}`);
  const data = await response.json() as { data?: { detections?: Array<Array<{ language?: string }>> } };
  const detected = data.data?.detections?.[0]?.[0]?.language;
  // Google's Basic API deprecates confidence/isReliable; don't invent thresholds.
  return detected && detected !== "und" ? detected : null;
}
