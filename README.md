# Basecamp Translator

**Automatic translation between any Google NMT-supported language pair for Basecamp to-dos and comments.**

By [Daniel Ch](https://github.com/chddaniel). Free, open source, and made to save
other teams the time we spent building it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chddaniel/basecamp-translator)
[![Check](https://github.com/chddaniel/basecamp-translator/actions/workflows/check.yml/badge.svg)](https://github.com/chddaniel/basecamp-translator/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What it does

Choose two languages for each project: English ↔ Portuguese, French ↔ German,
Japanese ↔ Arabic, or any other pair in Google's NMT language list. Write in
either language; your Translate Bot replies in the other. Different projects
can use different pairs, with no code changes. Replies identify the original
author and link to their comment. For example, in a Spanish/English project:

> **English translation** · Alex Rivera · 4:01 PM
>
> Please confirm the meeting date for the team.

New or edited to-dos get both languages in the title and description, separated
by their language codes, such as `[FR]` and `[DE]` or `[JA]` and `[AR]`. Edit the
appropriate language section to update the other.
Attachments stay in the original comment; attachment-only comments are skipped.

This is **v0.2.1, a community-supported self-hosted release** of a bot we use in
our own projects. It covers to-dos and their comments, not Campfire, Message
Boards, files, or other tools. It does not translate project history on install.

## Before you start

You need:

- A GitHub and Cloudflare account for your own copy.
- A Google Cloud project with billing, **Cloud Translation API (Basic/NMT)**
  enabled, and an API key restricted to that API.
- A dedicated Basecamp user, such as **Translate Bot**, added to the projects
  you want to translate. It must be able to read/edit to-dos and post comments.
  Creating/managing webhooks requires a full team member, not a client; your
  account's administrator may need to help with that permission.
- Your own [Basecamp OAuth application](https://launchpad.37signals.com/integrations).

The bot posts as the Basecamp identity that authorizes it. Use a separate browser
profile for that identity to avoid accidentally connecting your personal account.
Your Basecamp plan may charge for an extra member; check your own plan first.

## Install

### 1. Create your accounts and keys

Enable Google Cloud Translation and obtain your key. Register the Basecamp
OAuth application and keep its client ID and secret. If you do not know your
Worker URL yet, use a temporary redirect URI in the Basecamp registration and
replace it after deployment, before connecting the bot.

### 2. Deploy your own copy

Click **Deploy to Cloudflare** above. Cloudflare copies this repository into
your GitHub account and provisions the Worker, D1 database, and two queues.
Accept the repository's deploy command, which applies the database migrations
before publishing the Worker.

Supply these four secrets in the deployment form:

| Secret | Value |
| --- | --- |
| `SETUP_PASSWORD` | A new random password, at least 24 characters. Save it in your password manager. |
| `BASECAMP_CLIENT_ID` | Client ID from your Basecamp OAuth application. |
| `BASECAMP_CLIENT_SECRET` | Client secret from that same application. |
| `TRANSLATION_API_KEY` | Your Google Cloud Translation API key. |

**Keep the setup password.** It protects setup and derives the encryption key for
your stored Basecamp tokens. Changing it also changes webhook URLs and prevents
existing tokens from decrypting. See [recovery](docs/OPERATIONS.md#password-and-token-recovery).

The default time zone is UTC. Change `PROJECT_TIME_ZONE` in Worker settings to
an IANA zone such as `Europe/Madrid` or `America/Mexico_City` if you prefer. It
controls the timestamp in translation headers for the entire installation.

### 3. Connect Basecamp

Open `https://YOUR-WORKER.workers.dev/setup` and enter your setup password.

The setup page shows your exact callback URL:

```text
https://YOUR-WORKER.workers.dev/oauth/callback
```

Set that exact URL as your OAuth application's redirect URI in Basecamp.
In the browser profile signed into Basecamp as **Translate Bot**, click
**Connect Basecamp** and authorize your own application. The callback uses an
expiring, single-use state and requires your setup browser session.

### 4. Choose a project

Select a Basecamp account and project. Verify that the displayed name/email
really belong to your bot. Choose **language A** and **language B** from the
supported-language selectors. The choices come from Google's NMT API and are
cached for a day, so new supported languages do not require a code release.

Mark the people who normally write to-dos in language A; other members use
language B as their preference. Google detects the language of comments and new
to-dos. Member preferences help when an unclassified to-do is ambiguous or both
halves of a bilingual to-do change. Text detected outside the selected pair is
skipped. Very short and mixed-language text can still be misidentified.

Pick the pair before enabling. Once a project has bilingual to-dos, its pair is
locked to avoid mislabeling their existing content. Configure another project
for a different pair. Legacy v0.1 state lacks project IDs and is protected
conservatively when an existing project's pair would change.

Choose a monthly character allowance (default: 100,000). This is checked against
the **shared usage for that Basecamp account**; set the same allowance on its
projects for a consistent account-wide guard.

Confirm the posting identity and click **Enable translation for this project**.
Setup creates the Basecamp webhook and activates the project. If permissions
prevent webhook creation, it leaves translation paused and displays an error.

### 5. Try one comment

In a test to-do, post a clear sentence in one of your selected languages. For
example, if you selected Spanish and English:

```text
Por favor, confirma la fecha de la reunión para el equipo.
```

The bot should reply in English shortly. Check the author and attribution, then
try a comment in the other selected language. An ambiguous message such as “OK”
may be skipped or misidentified by language detection.
There is no automatic paid translation test during setup.

## Costs and privacy

The source code is free under MIT. Each installation uses its owner's Cloudflare,
Google Cloud, and Basecamp accounts. Check current provider pricing; this is not
a promise of free infrastructure. Google's NMT tier currently includes a monthly
credit for the first 500,000 characters, then charges for additional usage.

Automatic language detection is also metered. A new plain comment or to-do
usually sends its text once for detection and once for translation. Both
requests count toward the application's allowance and Google's usage. Updating
one labeled half of a bilingual to-do does not require another detection call.
The supported-language list contains metadata, not project content.

- [Google Cloud Translation pricing](https://cloud.google.com/products/translate/pricing)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)

Your text goes from Basecamp to your Worker and Google for detection and translation, and the
translation returns to Basecamp. This project has no analytics, telemetry, or
developer-operated backend. Daniel does not receive your content or credentials.
Your own cloud providers still process/store data according to their terms.

OAuth tokens are encrypted in D1; API credentials stay in Worker secrets. Queues
carry event identifiers, not message bodies. D1 stores project settings, usage
counts, hashes, record IDs, and event status. See [operations and removal](docs/OPERATIONS.md).

## Limits worth knowing

- **Any two languages supported by Google NMT per project.** This is a bilingual
  workflow, not simultaneous translation into every project member's language.
  The provider's [current language list](https://docs.cloud.google.com/translate/docs/languages#nmt)
  defines coverage; the bot does not add languages or dialects Google lacks.
- **To-dos are edited in place.** Start with a test project. The bot preserves
  the assignment/date fields it reads, but avoid simultaneous human/bot edits.
- Comments are translated on creation; later edits to a source comment do not
  update an existing translated reply. Deleting an original does not remove its
  translation automatically.
- Language detection uses Google's API. Short, mixed-language, or unusual
  comments can be skipped or misclassified. Machine translations need review
  where accuracy matters.
- Links and code blocks are preserved rather than translated. To-do attachment
  references are preserved; comment attachments are omitted from replies.
- The character guard includes detection, HTML, and retries, and does not govern other uses
  of your Google key. Configure provider quotas/billing alerts as appropriate.
- A single bot authorization is stored per installation. Add projects accessible
  to that bot; deploy a separate copy for an unrelated bot identity.
- There is no uptime guarantee or guaranteed support response. Contributions,
  reproducible bug reports, and documentation improvements are welcome.

## Upgrading an existing installation

Update your deployment source to **v0.2.1 or later** and redeploy your existing
Worker. For a manual checkout, pull the update, run `npm ci`, then `npm run deploy`.
Keep your existing Worker configuration, D1 database, queues, and secrets;
do not replace them with a fresh installation or change `SETUP_PASSWORD`.

Versions before v0.2.1 used incorrect Basecamp OAuth parameters, which could
stop translations when the access token expired. This release fixes initial
connection and automatic renewal using
[Basecamp's documented OAuth parameters](https://github.com/basecamp/api/blob/master/sections/authentication.md).
If your bot has already stopped with `Basecamp OAuth refresh 401`, sign into
your existing `/setup` page and reconnect **the same bot account**. No password
reset is needed. Setup rejects reconnection as a different Basecamp user.

Updating does not automatically backfill missed comments. Events still in the
queue's retry window can retry; events already moved to the dead-letter queue
need to be replayed separately. Preserve their original event IDs so existing
deduplication can prevent duplicate replies.

## Local development / manual installation

Requires Node.js 22.13+ and npm. No live provider calls are needed for tests.

```sh
npm ci
npm run check
npm test
cp .dev.vars.example .dev.vars
# Fill .dev.vars with your own development credentials.
npx wrangler d1 migrations apply DB --local
npm run dev
```

For manual deployment, run `npx wrangler login`, create a D1 database and both
queues, put the returned database ID into `wrangler.jsonc`, and set the four
secrets with `npx wrangler secret put SECRET_NAME`. Then run `npm run deploy`.
Keep the queue names in the configuration and the created resources consistent.

Cloudflare's deployment button uses supported automatic resource provisioning:
[official documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

## Why this exists

We needed English- and Spanish-speaking teammates to work in the same Basecamp
project without translating every comment manually. After getting it working,
I wanted other teams to be able to use it instead of repeating that work. The
public version lets every project choose its own language pair.

If it saves you time, that's the point. — **Daniel Ch**
