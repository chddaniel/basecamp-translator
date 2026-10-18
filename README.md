# Basecamp Translator

**English ↔ Spanish translations for Basecamp to-dos and comments.**

By [Daniel Ch](https://github.com/chddaniel). Free, open source, and made to save
other teams the time we spent building it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chddaniel/basecamp-translator)
[![Check](https://github.com/chddaniel/basecamp-translator/actions/workflows/check.yml/badge.svg)](https://github.com/chddaniel/basecamp-translator/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What it does

Write a comment in Spanish; your Translate Bot replies in English. Write in
English; it replies in Spanish. Replies identify the original author and link
to their comment:

> **English translation** · Alex Rivera · 4:01 PM
>
> Please confirm the meeting date for the team.

New or edited to-dos get both languages in the title and description, separated
by `[ES]` and `[EN]`. Edit the appropriate language section to update the other.
Attachments stay in the original comment; attachment-only comments are skipped.

This is **v0.1, a community-supported self-hosted release** of a bot we use in
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
really belong to your bot. Mark the people who normally write to-dos in Spanish;
other members default to English for ambiguous to-dos. Comments use a simple
language heuristic instead of the author's identity.

Choose a monthly character allowance (default: 100,000). This is checked against
the **shared usage for that Basecamp account**; set the same allowance on its
projects for a consistent account-wide guard.

Confirm the posting identity and click **Enable translation for this project**.
Setup creates the Basecamp webhook and activates the project. If permissions
prevent webhook creation, it leaves translation paused and displays an error.

### 5. Try one comment

In a test to-do, post something clear, such as:

```text
Por favor, confirma la fecha de la reunión para el equipo.
```

The bot should reply in English shortly. Check the author and attribution, then
try an English comment. An ambiguous message such as “OK” may be skipped.
There is no automatic paid translation test during setup.

## Costs and privacy

The source code is free under MIT. Each installation uses its owner's Cloudflare,
Google Cloud, and Basecamp accounts. Check current provider pricing; this is not
a promise of free infrastructure. Google's NMT tier currently includes a monthly
credit for the first 500,000 characters, then charges for additional usage.

- [Google Cloud Translation pricing](https://cloud.google.com/products/translate/pricing)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)

Your text goes from Basecamp to your Worker and Google Translation, and the
translation returns to Basecamp. This project has no analytics, telemetry, or
developer-operated backend. Daniel does not receive your content or credentials.
Your own cloud providers still process/store data according to their terms.

OAuth tokens are encrypted in D1; API credentials stay in Worker secrets. Queues
carry event identifiers, not message bodies. D1 stores project settings, usage
counts, hashes, record IDs, and event status. See [operations and removal](docs/OPERATIONS.md).

## Limits worth knowing

- **English and Spanish only.** Other languages need code changes.
- **To-dos are edited in place.** Start with a test project. The bot preserves
  the assignment/date fields it reads, but avoid simultaneous human/bot edits.
- Comments are translated on creation; later edits to a source comment do not
  update an existing translated reply. Deleting an original does not remove its
  translation automatically.
- Language detection is a small heuristic. Short, mixed-language, or unusual
  comments can be skipped or misclassified. Machine translations need review
  where accuracy matters.
- Links and code blocks are preserved rather than translated. To-do attachment
  references are preserved; comment attachments are omitted from replies.
- The character guard includes HTML and retries, and does not govern other uses
  of your Google key. Configure provider quotas/billing alerts as appropriate.
- A single bot authorization is stored per installation. Add projects accessible
  to that bot; deploy a separate copy for an unrelated bot identity.
- There is no uptime guarantee or guaranteed support response. Contributions,
  reproducible bug reports, and documentation improvements are welcome.

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
I wanted other teams to be able to use it instead of repeating that work.

If it saves you time, that's the point. — **Daniel Ch**
