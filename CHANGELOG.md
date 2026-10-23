# Changelog

## v0.2.1 — Fix Basecamp authorization renewal

- Use Basecamp Launchpad's required `type=refresh` parameter when access tokens
  expire, so translations can continue without manual reconnection.
- Use `type=web_server` for initial authorization and code exchange too.
- Preserve an existing refresh token when Basecamp does not rotate it, and
  reject incomplete responses before overwriting stored credentials.
- Add regression tests for expired tokens, successive renewals, malformed
  responses, safe errors, and retryable translation events (40 tests total).

Existing installations must redeploy the updated code. If authorization has
already stopped working, reconnect the same bot through `/setup`; do not reset
its password or change `SETUP_PASSWORD`. See the README's upgrade instructions.

## v0.2.0 — Configurable language pairs

- Choose any two Google NMT-supported languages per Basecamp project in setup.
- Use Google language detection instead of English/Spanish keyword heuristics.
- Show the selected language codes in bilingual to-dos and the target language
  name in translated comment headers.
- Fetch/cache Google's supported-language catalog; handle legacy language codes
  and unambiguous regional/script variants.
- Count both detection and translation against the application character guard.
- Preserve existing Spanish/English configurations through an additive migration.
- Protect existing bilingual content when a configured pair is changed.

Provider calls in automated tests are mocked; no translation credits are needed.

## v0.1.0 — Initial public release

- English/Spanish to-do and comment translation, guided self-hosted setup,
  Cloudflare deployment button, and an MIT license.
