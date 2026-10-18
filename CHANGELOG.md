# Changelog

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
