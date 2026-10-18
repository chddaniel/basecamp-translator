# Security

Please do not report credentials, private Basecamp content, or exploitable
security details in a public issue. Use this repository's **Security → Report
a vulnerability** feature for private disclosure when enabled.

Each deployment belongs to its installer. It has one bot authorization and can
edit the configured Basecamp projects using that bot's permissions. Invite the
bot only where needed. The setup password is an administrator credential and
must be unique, random, at least 24 characters, and kept in a password manager.
Serve setup over HTTPS. Sessions last one hour and are HttpOnly/SameSite cookies;
setup pages disable caching, embedding, and external scripts.

The code and automated tests are public; this is not an independently audited
product. Test it on a project you control before using it for important work.

No Google API key, OAuth client secret, access/refresh token, production webhook
path, private account/project configuration, or local browser data belongs in
this repository. Use Worker secrets and your own D1 database.
