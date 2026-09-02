# Running this as a shared server

This mode gives every person their own login and their own data. Nobody —
including the administrator — can open anyone else's workspaces or sessions.

## Start it

```bash
# Windows PowerShell
$env:AUTH_PROVIDER            = "local"        # built-in username/password accounts
$env:ALLOW_ANONYMOUS          = "false"        # no access without signing in
$env:FLASK_SECRET_KEY         = "<paste 64 random hex chars>"
$env:WORKSPACE_BACKEND        = "ephemeral"    # data expires (see below)
$env:EPHEMERAL_WORKSPACE_TTL_HOURS = "2"       # 2 hours of inactivity
$env:EPHEMERAL_WORKSPACE_CLEANUP_INTERVAL_SECONDS = "600"
$env:DISABLE_DATA_CONNECTORS  = "true"         # file upload only
$env:DISABLE_DISPLAY_KEYS     = "true"         # hide server-side API keys

# The model everyone will use. Any OpenAI-compatible endpoint; the prefix is
# just a label. Add DF_LLM_CA_BUNDLE if it presents an internal certificate.
$env:MYGATEWAY_ENABLED        = "true"
$env:MYGATEWAY_API_BASE       = "https://your-gateway.example.com/v1"
$env:MYGATEWAY_API_KEY        = "<your key>"
$env:MYGATEWAY_MODELS         = "gpt-4.1"

uv run data_formulator --host 0.0.0.0 -p 5567
```

Generate a secret key once and keep it:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

> **`--host 0.0.0.0` is required.** Bound to `127.0.0.1`, the app runs in
> single-user localhost mode, where every visitor shares one identity and one
> workspace — including visitors arriving through a reverse proxy. The server
> logs a loud warning if you start it that way with accounts enabled, and
> refusing to ignore that warning is the single most important thing on this
> page.

## First sign-in

With no accounts yet, the server creates an administrator on startup and logs
a one-time password:

```
====================================================================
  Created administrator 'admin' with a one-time password:
      3Xq7f2LmR8vT
  Sign in and change it now - this is the only time it is shown.
====================================================================
```

Set `DF_ADMIN_USERNAME` and `DF_ADMIN_PASSWORD` beforehand to choose them
yourself instead.

## Managing people

Sign in as the administrator and open the **people icon** in the top bar:

- **Add user** — pick a username, take the suggested password (or type one),
  choose `user` or `admin`. The password is shown once, right there.
- **Reset password** — issues a new one-time password for someone locked out.
- **Delete user** — removes the account *and* everything it stored.

Accounts created or reset by an administrator must choose a new password at
their next sign-in, so the password you handed over stops working as soon as
they use it.

The last administrator cannot be deleted or demoted, so the server can never
end up with nobody able to manage it.

## What each person can see

| | Their own data | Other people's data | Accounts | Model configuration |
|---|---|---|---|---|
| User | yes | no | no | sees the loaded models, read-only |
| Admin | yes | **no** | yes | yes |

Isolation comes from storage paths keyed to the signed-in account, not from a
role check, which is why an administrator has no way to read another person's
workspaces. Manage-accounts is a separate power from read-data.

## Models

The models people can pick come from the environment variables above. Adding
one names an outbound destination and an API key the server spends on
everyone's behalf, so only administrators may do it: the configuration
controls are hidden from everyone else, and every model route refuses a
non-admin request that carries its own endpoint. Users see the loaded list and
choose from it.

`DF_ADMIN_USERS=alice,bob` grants the same power to named accounts — useful
when this server authenticates through SSO instead of local accounts, where
there is no `admin` role to read.

Set `DISABLE_CUSTOM_MODELS=true` to take the configuration UI away from
administrators too, leaving the environment file as the only way in.

## The two-hour rule

Workspace data is deleted after **2 hours without activity**. A sweeper runs
on a timer (`EPHEMERAL_WORKSPACE_CLEANUP_INTERVAL_SECONDS`), so expiry happens
on schedule rather than waiting for someone's next visit.

Accounts survive; only the data goes. Someone returning after a long gap signs
in normally to an empty workspace.

Raise `EPHEMERAL_WORKSPACE_TTL_HOURS` if two hours proves too aggressive — it
is measured from last activity, not from login.

## Serving it over HTTPS

Terminate TLS in a reverse proxy in front of the app, and keep the app itself
on `0.0.0.0`:

```nginx
location / {
    proxy_pass http://127.0.0.1:5567;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Session cookies are `HttpOnly` and `SameSite=Lax`. Serve the site over HTTPS
so they are not readable in transit.

## Backups

Two files matter. Losing them cannot be undone:

| File | Loses |
|---|---|
| `~/.data_formulator/users.db` | every account |
| `FLASK_SECRET_KEY` | every active login session |

Workspace data under `~/.data_formulator/ephemeral` is disposable by design.
