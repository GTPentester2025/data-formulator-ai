# Privacy — where your data goes

This fork is audited to make one guarantee: **the only service that receives
your data is the AI endpoint you configure yourself.** Nothing else — no
analytics, no telemetry, no vendor.

## What leaves your machine

| Destination | What is sent | When |
|---|---|---|
| **The AI endpoint you configure** (OpenAI / Azure AI Foundry / Ollama / any OpenAI-compatible URL) | Column schemas plus a small data sample (about 5 rows and 7 example values per column), your questions, and generated code | Only when you ask the AI something |
| Nothing else | — | — |

Your full dataset never leaves the machine. Uploads are processed locally
(DuckDB) and stored as parquet under `~/.data_formulator`.

## What is deliberately not present

* **No telemetry or analytics.** No Application Insights, Sentry, Clarity,
  Google Analytics, PostHog, or usage pings anywhere in the frontend or
  backend. The packages are not installed.
* **No CDN or webfonts.** All scripts, styles, and fonts are served from this
  app's own origin.
* **No model-cost phone-home.** litellm normally fetches a pricing file from
  `raw.githubusercontent.com` on every server start. This fork forces the
  bundled offline copy (`py-src/data_formulator/__init__.py`), so the request
  never happens.
* **No third-party basemaps.** Map charts previously fetched topojson from
  `vega.github.io`. Those files are vendored in `public/geo/` and the URLs are
  rewritten both at build time (`vite.config.ts`) and at runtime
  (`src/app/geoAssets.ts`). Any other remote URL appearing in a chart spec is
  stripped rather than fetched.
* **AI-generated code cannot call out.** It runs in a sandbox that blocks
  sockets, `urllib`/`requests`/`http`, `subprocess`, and file writes.

## Things that do reach out — and only when you choose them

* **"Open in Vega Editor"** — sends the chart spec, *including its data rows*,
  to `vega.github.io/editor`. It is a small link at the bottom of the
  encoding-shelf popover (the ⚙/Tune button on the chart toolbar). Never
  automatic; avoid it for sensitive data.
* **URL data sources** — if you load a table from a URL, your browser fetches
  that URL directly and re-polls it on a timer while the session is open.
* **Example datasets / demo streams** — fetch from GitHub, USGS, Open-Meteo, or
  Yahoo Finance only if you open those specific sample sources.
* **Database connectors, SSO, Azure Blob workspaces** — inert unless you
  configure them.

## Verifying the claims

```bash
# No telemetry SDKs
grep -ril "applicationinsights\|sentry\|posthog\|mixpanel\|segment" src py-src

# No external hosts in the built frontend
grep -o "https://[a-z0-9.-]*" py-src/data_formulator/dist/DataFormulator.js | sort -u

# Confirm litellm loads pricing locally with no network
uv run python -c "import data_formulator, os; print(os.environ['LITELLM_LOCAL_MODEL_COST_MAP'])"
```

## Hardening for shared deployments

* `DF_ALLOWED_API_BASES` — allowlist of LLM endpoint URLs (open by default,
  which is fine for single-user local use).
* `--disable-custom-models`, `--disable-data-connectors`,
  `--disable-display-keys` — see `DEVELOPMENT.md` deployment profiles.
