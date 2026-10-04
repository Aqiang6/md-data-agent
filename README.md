# MD Data Agent

English | [中文](README.zh.md)

A database analysis assistant built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and Cordis. It reads schema and business Markdown with the same file tools, clarifies ambiguous metrics, runs SQL, and preserves prompts, tool calls and results in a trace you can inspect.

<a id="run"></a>

<a id="run-from-source"></a>

## Run

Install Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`. On Windows, run `start.bat` to install dependencies, build missing artifacts and launch the dedicated Data Agent profile. For an explicit source setup:

```sh
pnpm install
pnpm run build
pnpm --filter dataagent-ui run build
pnpm exec tsx scripts/prepare-data-agent-profile.ts
pnpm dsh --profile data-agent
```

The initial profile offers the official DeepSeek models and selects DeepSeek Flash. Configure your API key in Models & API, or copy `.env.example` to `.env` and fill in `DEEPSEEK_API_KEY`. Profile preparation preserves later model choices.

Connect your database and provide its schema and business Markdown through source management. The repository includes no personal connection, database, business corpus or API key. See [Data Agent UI](apps/dataagent-ui/README.md) for the workspace and [Data Agent configuration](packages/experimental/data-agent/README.md) for source permissions and document binding.

## Repository contents

The runnable Harness workspaces, vendored Cordis, build scripts and regression fixtures stay together. Local credentials, databases, business documents, generated bundles, browser recordings and benchmark runs are ignored. Official BIRD and Spider benchmark resources and runs are maintained separately from this checkout.

Before committing, run `pnpm run check:git-files`. The commit hook rejects ignored files that were forcibly added to the Git index; this check does not scan earlier Git history or determine whether arbitrary source text contains secrets.

## Development

Start with [architecture](docs/architecture.md), [development](docs/development.md) and [AGENTS.md](AGENTS.md). This repository extends DeepSeek Harness; upstream framework source remains under its original package names and license.

## License

[MIT](LICENSE). Dependency licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
