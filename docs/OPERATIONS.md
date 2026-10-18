# Operating your installation

## Pause and resume

Open `/setup`, sign in, and choose the account/project. **Pause translation**
disables processing of new events, including queued events that have not yet
been handled. It does not remove anything already posted in Basecamp. Resume
with **Enable translation**. Events skipped while paused are not backfilled.

## Failures

Check Worker logs for status-only processing errors and the failed queue for
events that exhausted five retries. The queue retries transient failures;
daily/monthly provider limits and lost access need operator attention. Free
Cloudflare queues retain messages for a limited time, so investigate promptly.
Do not put tokens, webhook URLs, private messages, or logs containing those
values in public issues. Never replay events blindly: inspect the original
thread for an existing translation first.

The application reserves character allowance before each detection or translation
request. Failed requests and retries may count toward this allowance even if
Google did not bill them. The application guard is deliberately conservative.

## Password and token recovery

Keep `SETUP_PASSWORD` unchanged during normal operation. It derives the AES-GCM
key used to encrypt your bot's OAuth tokens and the private webhook path.

If it is lost, you must intentionally reset the installation:

1. Pause/remove this installation's Basecamp webhooks using an account admin.
2. Save a new random setup password in Worker secrets.
3. Clear `oauth_token` and `setup_oauth_state` in your own D1 database. These
   contain only this installation's connection state. This deletes the old
   authorization data; do not clear it merely because a token expired.
4. Open `/setup`, reconnect the **same bot**, and enable each project to create
   replacement webhooks. Remove the obsolete webhook URLs through Basecamp.

Normal token expiry refreshes automatically. To renew authorization without
changing the password, use **Reconnect same bot**. Reconnection checks the bot
person ID against the identities configured in this installation.

## Remove the installation

1. Pause each project.
2. Remove this installation's webhooks from those Basecamp projects. Do not
   delete webhooks belonging to other integrations.
3. Revoke your own OAuth application's access through Basecamp's available
   account controls, or retire the OAuth app if it is used only for this bot.
4. Delete your Worker, its two queues, and its D1 database in Cloudflare.
5. Remove the Google API key only if no other software uses it.

Existing translated to-dos and comments remain in Basecamp. Uninstall does not
delete or restore their contents. D1 state has no automatic retention cleanup
in v0.1; deletion of the installation removes it from your active database,
subject to your cloud provider's backup/retention policies.

## Updating

Cloudflare's button creates an independent copy in your GitHub account.
Upstream releases do not automatically overwrite your copy. Review new release
notes, merge the changes into your repository, and deploy with `npm run deploy`.
Do not change the setup password during an ordinary upgrade.

### Upgrading from v0.1 to v0.2

Run the normal `npm run deploy` command. Migration `0003_language_pairs.sql`
adds language settings with Spanish/English defaults, preserving the ordering
of existing `[ES]` and `[EN]` to-dos, member preferences, tokens, hashes, and usage.
The old `es_hash`/`en_hash` database columns are retained as generic A/B slots;
their names do not restrict the languages supported by the application.

New projects can use any pair from Google's NMT catalog. Existing project pairs
cannot be changed once bilingual to-do state exists, to avoid relabeling earlier
content. Old state without project IDs is protected conservatively. Language
detection now uses Google and also consumes character allowance. Update your
Google quotas and application allowance to suit your usage.
