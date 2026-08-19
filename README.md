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

- **Any OpenAI-compatible model endpoint.** Pick the `custom` provider and
  point it at Azure AI Foundry, Groq, OpenRouter, LM Studio, vLLM, a LiteLLM
  proxy, or a local Ollama server. Pasted URLs are normalized, so a base URL
  copied straight from a provider's docs works.
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

Open the model dialog, choose a provider, and fill in the model name, API key,
and (for `custom`) the API base URL. Examples:

| Provider | Model | API base |
|---|---|---|
| `custom` | your deployment name | `https://<resource>.openai.azure.com/openai/v1` |
| `custom` | `llama-3.3-70b-versatile` | `https://api.groq.com/openai/v1` |
| `custom` | `llama3` | `http://localhost:11434/v1` |
| `openai` | `gpt-4.1` | *(blank — uses the default endpoint)* |

Press **Test** to confirm connectivity before using the model.

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
menu:

- **Chart image (PNG)** — 2× resolution, matching what is on screen.
- **Excel — table only (.xlsx)** — the full table, not just the rows on
  display.
- **Excel — table + chart (.xlsx)** — three sheets: `Data` (the full table),
  `ChartData` (the exact values the chart plots), and `Chart` (a real Excel
  chart bound to the `ChartData` ranges, so it stays editable and updates when
  those cells change). Chart types Excel cannot draw natively — maps, box
  plots, radar — fall back to an embedded image.

## Documentation

- [PRIVACY.md](PRIVACY.md) — what leaves the machine, and how to verify it
- [SECURITY.md](SECURITY.md) — reporting issues, hardening a shared instance
- [DEVELOPMENT.md](DEVELOPMENT.md) — local development, deployment profiles,
  configuration reference

## License

MIT — see [LICENSE](LICENSE).
