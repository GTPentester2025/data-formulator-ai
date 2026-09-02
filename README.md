<h1 align="center">
  <img src="./public/favicon.ico" alt="Data Formulator icon" width="28">&nbsp;
  Data Formulator: AI-powered Data Visualization
</h1>


<p align="center">
  🪄 Explore data with visualizations, powered by AI agents.
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

## Why Data Formulator?

Working with data is hard for two simple reasons:

1. **Data lives everywhere.** Connecting agents to files, databases,
   warehouses, and BI tools takes time. It is even harder when agents start
   answering before the relationships between data sources are clear.
2. **Questions evolve as you explore.** Each answer can lead to follow-up
   questions, comparisons, and new directions. A long chat history makes it
   hard to see where you are and how you got there.

Data Formulator provides one visual workspace for exploring and analyzing data:

1. **Data connectors** give agents a common way to connect to different data
   sources and maintain a data memory that remembers the relationships between
   them.
2. **Data Threads** let you branch into different questions, compare paths,
   and use visualizations to discover deeper insights without losing context.

## Overview

**Data Formulator** combines *UI interactions* with *natural language* so
analysts can communicate intent, branch into alternative analyses, and share
results — starting from any data format (screenshot, text, CSV, or database).

This build adds:

- **One model provider: your own OpenAI-compatible endpoint.** Point it at an
  internal gateway, Azure AI Foundry, Groq, OpenRouter, LM Studio, vLLM, a
  LiteLLM proxy, or a local Ollama server. There are no hosted-provider
  shortcuts to configure or audit — the base URL is what decides where a call
  goes. Pasted URLs are normalized, so a base URL copied straight from a
  provider's docs works, and an internal CA can be trusted with
  `DF_LLM_CA_BUNDLE`.
- **Models are an administrator's setting.** They come from the server's
  environment file; everyone else sees the loaded list, read-only, and cannot
  point the server at an endpoint of their own.
- **Export that leaves the app.** Copy a chart image to the clipboard,
  download it as a PNG, or download Excel workbooks — table only, or table
  plus a **native, editable Excel chart** whose series are linked to the
  worksheet cells it was built from. Every data table also has CSV and
  Excel download buttons.
- **No third-party calls.** The only service that receives your data is the
  AI endpoint you configure. See [PRIVACY.md](PRIVACY.md).

## Get Started

- **Option 1: Install via uv (recommended)**

  [uv](https://docs.astral.sh/uv/) is an extremely fast Python package manager.

  ```bash
  uv sync
  uv run data_formulator
  ```

  Run `uv run data_formulator --help` to see all available options, such as
  custom port, sandboxing mode, and data storage location.

- **Option 2: Install via pip**

  ```bash
  pip install -r requirements.txt
  python -m data_formulator
  ```

  Data Formulator opens in the browser at
  [http://localhost:5567](http://localhost:5567).

- **Option 3: Run with Docker**

  ```bash
  docker compose up --build
  ```

  Open [http://localhost:5567](http://localhost:5567) in your browser. To stop,
  press `Ctrl+C` or run `docker compose down`.

- **Option 4: Working as a developer**

  Build the frontend and run against it — see [DEVELOPMENT.md](DEVELOPMENT.md).

## Connecting a model

Every model is one OpenAI-compatible endpoint: a base URL, a model id, and an
optional API key. Set them in the server's `.env` (see `.env.template`), where
they are available to everyone who uses the server:

```env
MYGATEWAY_ENABLED=true
MYGATEWAY_API_BASE=https://your-gateway.example.com/v1
MYGATEWAY_API_KEY=sk-...
MYGATEWAY_MODELS=gpt-4.1,gpt-4.1-mini
```

The prefix is just a label — it groups the models in the picker. Base URLs are
normalized, so all of these work:

| Model | API base |
|---|---|
| your deployment name | `https://<resource>.openai.azure.com/openai/v1` |
| `llama-3.3-70b-versatile` | `https://api.groq.com/openai/v1` |
| `llama3` | `http://localhost:11434/v1` (keyless — omit the key) |

An administrator can also add a model from the model dialog and press **Test**
to confirm connectivity. Everyone else picks from the loaded list; the
configuration controls are neither shown to them nor accepted from them, since
a model configuration names an outbound destination and spends the server's
credentials. Who counts as an administrator: the `admin` role under
`AUTH_PROVIDER=local`, the person at the keyboard in single-user localhost
mode, or anyone named in `DF_ADMIN_USERS`.

## Using Data Formulator

Start with the data you already have: upload CSV, TSV, Excel, JSON,
screenshots, or text; connect to databases and data platforms; or ask the
analyst to find and load the data you need. The analyst can discover sources,
clarify your request, propose a loading plan, and let you review the data
before adding it to the workspace.

Continue the conversation in the **Data Thread**. Ask questions in natural
language and follow the reasoning through explanations, tables, and editable
charts in one history. Refine a result directly, branch from any earlier step
to explore an alternative, or delegate the next investigation to the analyst.
When the analysis is ready, compose the results into a report to share.

## Exporting

The chart toolbar (top right of the canvas) has a copy button and a download
menu; every data table has its own **Download Excel** button.

- **Chart image (PNG)** — 2× resolution, matching what is on screen.
- **Excel workbook…** — opens a dialog where you pick what goes in. The table
  in view is always written as a `Data` sheet; the rest are optional:

| Option | Sheets added | What you get |
|---|---|---|
| *(always)* | `Data` | The full table — not just the rows on display. |
| **Chart** | `ChartData`, `Chart` | A real Excel chart whose series are bound to the `ChartData` ranges, so it stays editable and redraws when those cells change. Chart types Excel cannot draw natively — maps, box plots, radar — fall back to an embedded image. |
| **Pivot table** | `PivotTable` | A genuine Excel PivotTable over the `Data` sheet, with a pivot cache behind it. Drag fields between Rows, Columns and Values in Excel to re-slice it. |
| **Source data** | one per upstream table | The tables this result was derived from, walked back to the files you originally loaded — so the workbook shows the whole chain from raw input to result. |

Because everything lands in a single workbook, a reader can follow the process
end to end: the original uploads, the table the agent produced from them, the
values behind the chart, and a pivot to explore the numbers further.

## Documentation

- [PRIVACY.md](PRIVACY.md) — what leaves the machine, and how to verify it
- [SECURITY.md](SECURITY.md) — reporting issues, hardening a shared instance
- [DEVELOPMENT.md](DEVELOPMENT.md) — local development, deployment profiles,
  configuration reference

## License

MIT — see [LICENSE](LICENSE).
