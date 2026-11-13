# pointer

The AI coding assistant for Visual Studio Code that stays inside your network. Code completion, inline edits, chat, code review and more, on a model server you choose: on your machine, on another of your devices, on a hosted API, or on one gateway your whole team shares. Free, open source, MIT licensed, no telemetry, no sign-in.

[Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=pointer.pointer) · [Documentation](https://docs.github.com/pointersh/Pointer/) · [What's new](https://docs.github.com/pointersh/Pointer/reference/whats-new/) · [Changelog](CHANGELOG.md) · [Teams](https://docs.github.com/pointersh/Pointer/teams/overview/) · [中文](README.zh-CN.md) · [Português (BR)](README.pt-BR.md)

**For teams:** one gateway on your network serves every developer's VS Code, with a key per person, usage, policy and an admin page. `npx pointer-server quickstart` sets it up. Free for five developers, $15 a seat a month after that, $29 once for one person who wants every licence feature, and a [30-day trial](https://github.com/pointersh/Pointer/#trial) with no card. Details, prices and a live admin page at [github.com/pointersh/Pointer](https://github.com/pointersh/Pointer/#teams).

## Getting started

1. Install pointer from the Marketplace (VS Code 1.93 or newer).
2. Run a model server. Ollama, LM Studio and llama.cpp are found on their usual ports at first start; pointer asks which models to use.
3. Type. Completions appear as ghost text; the sidebar has chat.

The [quick start](https://docs.github.com/pointersh/Pointer/getting-started/quick-start/) covers picking a server and models for your hardware, and [troubleshooting](https://docs.github.com/pointersh/Pointer/getting-started/troubleshooting/) explains every error message.

## What it does

- **[Code completion](https://docs.github.com/pointersh/Pointer/features/code-completion/).** Fill-in-the-middle suggestions as you type, streamed as ghost text and stopped at a sensible end. Context comes from open files, imports, the language server and your recent edits. Tuned to work well with a 7B model.
- **[Inline edit](https://docs.github.com/pointersh/Pointer/features/inline-edit/).** Ctrl+I, describe a change, and review it as a diff in the editor. Accept or reject per hunk. *Fix with pointer* on any diagnostic.
- **[Chat](https://docs.github.com/pointersh/Pointer/features/chat/)** with your code. Type `@` to attach files, symbols, the problems panel, the git diff, the terminal, or a search of the workspace index. Conversations are kept.
- **[Agent mode](https://docs.github.com/pointersh/Pointer/features/agent-mode/)** (experimental). A switch in the chat, or Shift+Tab, lets the model read, search and edit files and run commands in the workspace, each step shown in the reply. Commands ask first unless you say otherwise.
- **[Workspace index](https://docs.github.com/pointersh/Pointer/features/workspace-index/).** Hybrid keyword and vector search over the workspace, reranked before it reaches the prompt, updated on save. Sources show under replies. Indexes are isolated by workspace identity. After updating from name-based index storage, rebuild once in the Embeddings tab; existing indexes are left untouched.
- **[Code review](https://docs.github.com/pointersh/Pointer/features/code-review/)** of the working tree, a branch against its base, or a GitHub pull request, and **[commit messages](https://docs.github.com/pointersh/Pointer/features/commit-messages/)** from the staged diff.
- **[Terminal](https://docs.github.com/pointersh/Pointer/features/terminal/).** Write a command from a description, shown before it runs. When one fails, pointer finds the file and line and offers the fix.
- **[Prompt templates](https://docs.github.com/pointersh/Pointer/features/templates/)** you can edit, and every feature is a plain VS Code command you can rebind.

Everything runs against a server you control. No telemetry, no account. See [Status bar, logs and privacy](https://docs.github.com/pointersh/Pointer/features/status-and-logs/).

## Model servers and providers

| Where the model runs | How |
| --- | --- |
| **On your machine** | [Ollama](https://docs.github.com/pointersh/Pointer/providers/ollama/), [LM Studio](https://docs.github.com/pointersh/Pointer/providers/lm-studio/), [llama.cpp](https://docs.github.com/pointersh/Pointer/providers/llama-cpp/), QVAC, Oobabooga, LiteLLM, Open WebUI, or [any OpenAI-compatible server](https://docs.github.com/pointersh/Pointer/providers/other-local-servers/). |
| **On another of your computers** | [Devices](https://docs.github.com/pointersh/Pointer/providers/devices/): pair with a code and use that machine's GPU over an encrypted peer-to-peer link. No account, no relay. |
| **On a hosted API** | [OpenAI, Anthropic, Mistral (Codestral for completion), DeepSeek, OpenRouter, Gemini, Groq, Cohere, Perplexity](https://docs.github.com/pointersh/Pointer/providers/hosted-apis/). |
| **On your team's gateway** | Connect to a `pointer-server` and use the models the team set up. See below. |

Mix them: a local model for completion, a hosted one for chat. The [supported models](https://docs.github.com/pointersh/Pointer/providers/supported-models/) page says which models work for which job on which hardware.

## Teams: one gateway for everyone

`pointer-server` is a small dependency-free server that runs on the machine with the models and serves chat, completion and embeddings to every developer's VS Code. Prompts go to your gateway and your backend, nowhere else.

```sh
npx pointer-server quickstart
```

That finds your model server, writes a configuration, makes an admin key and serves. From the admin page you set the team's default models, send each developer an invite link that opens VS Code and connects them, and see usage per person and per model.

- **A key per developer**, stored as a hash, revoked live. Usage, failures and tokens per person and per model; never the content.
- **Pool the team's own computers.** A developer flips *Share this computer* and their local server serves the team through the gateway. No port to open.
- **Plugins** (licence): pull requests and issues from GitHub, GitLab, Gitea and Bitbucket listed on the admin page and reviewed by your own models, with the review posted back to the host, and shared with the developers you choose; Slack, Discord and Teams notifications; SSO sign-in with any OpenID Connect provider; one shared context index for every developer's chat; nightly backups.
- **Team policy** (licence): team-only providers, locked defaults, routing rules that keep a workspace on local backends, a team system prompt. Shown for consent before connecting.
- **Recording** (licence): keep prompts and replies on the gateway, disclosed to every developer, exported as training data.
- **Operations**: a hash-chained audit log of every admin change, read-only admin keys, Prometheus metrics, costs per developer when a model has a price, a request queue for a shared GPU, Docker and a Helm chart.

Free for five developers, forever. A licence bought by card at [github.com/pointersh/Pointer](https://github.com/pointersh/Pointer/#pricing) adds seats and switches on policy, recording and plugins; it is checked locally and the gateway never phones home. Working alone? **Personal** is $29 once: the same features on your own gateway, for good. A [30-day trial](https://github.com/pointersh/Pointer/#trial) token with every feature is issued by email, no card. See the [teams guide](https://docs.github.com/pointersh/Pointer/teams/overview/), [licensing and seats](https://docs.github.com/pointersh/Pointer/teams/licensing/), and the operator reference in [docs/gateway.md](docs/gateway.md).

## Repository layout

| Path | What |
| --- | --- |
| `src/extension` | The VS Code extension, by feature: completion, chat, inline edit, review, terminal, embeddings, providers, team connection. |
| `src/webview` | The sidebar (React). |
| `src/protocol` | The wire protocol between the extension and a gateway, and the WebSocket peer protocol for pooled computers. |
| `src/gateway` | The gateway: routes, keys, usage, licensing, admin page, plugins. Built into `packages/pointer-server/cli.js`. |
| `src/licensing` | Licence token verification (the signing side is private). |
| `packages/pointer-server` | The npm package and Docker files for the gateway. |
| `deploy/helm` | Helm chart for Kubernetes. |
| `docs` | The operator reference for the gateway and design notes. |

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/pointersh/Pointer). Describe a larger change in an issue first. [CONTRIBUTING.md](CONTRIBUTING.md) has the build and test steps; the suite runs headless with `xvfb-run -a npm test`. Questions go to [discussions](https://github.com/pointersh/Pointer/discussions) or [@pointersh](https://x.com/pointersh).

## Support pointer

pointer is free and open source, written and maintained by one person since 2023. If it earns its keep, [buying a licence](https://github.com/pointersh/Pointer/#pricing) is the best way to support it: Personal is $29 once.

## License

MIT. pointer is actively developed and provided as is.
