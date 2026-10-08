# Quick Start

Teleton Agent is an autonomous Telegram and TON agent. The WebUI is the operator console: you finish the initial setup, sign in with a token, and from there you manage everything — agents, tools, prompts, autonomous tasks, security, analytics — without ever opening a config file by hand.

This page is the first thing to read after a fresh install. It explains what you need, how the setup wizard works, how to sign in, and how to launch the very first task.

## Before you begin

You need:

- **Node.js 20** or newer.
- A working **LLM provider key** (Anthropic, OpenAI, Groq, …) unless you use a keyless provider such as Claude Code, Cocoon, or a local server.
- A **Telegram account or bot token** that you are willing to automate. Do not connect your main personal account if you are not prepared for the agent to read dialogs and send messages on its behalf.
- Your **Telegram numeric user ID** (you will paste it as the first admin ID).
- For personal-account mode: **API ID and API hash** from <https://my.telegram.org/apps>.

> ⚠️ **Important** — The agent can read dialogs, send messages, move TON funds, and execute shell commands when those tools are enabled. Treat the WebUI like an admin console: keep it on `localhost`, protect the auth token, and review the [Security Center](08-security.md) policies before turning anything risky on.

## Install

For most operators the published CLI is enough:

```bash
npm install -g teleton@latest
teleton setup --ui
```

For development from source:

```bash
git clone https://github.com/xlabtg/teleton-agent.git
cd teleton-agent
npm install
npm run build
npm run dev:cli -- setup --ui
```

The `setup --ui` command starts a temporary local server and prints a one-time URL. Open it in your browser — the URL contains a short-lived nonce that authenticates you for the wizard.

## Setup wizard

![Setup wizard — Welcome step](../assets/screenshots/common/setup-welcome.png)

The wizard has six numbered steps in the top progress bar plus a final confirmation:

1. **Welcome.** Read the *Security Notice* (expandable banner), enter the agent display name (default: `Nova`), and tick **I understand the risks and accept full responsibility**. The "Next" button stays disabled until the box is ticked.
2. **Provider.** Pick the LLM provider and model. Provider cards include Anthropic, OpenAI, Groq, Claude Code, Cocoon, OpenAI-compatible local servers, and others. If the provider needs an API key, paste it; the wizard validates it before letting you continue.
3. **Config.** Enter or confirm the agent name, default model, and your numeric Telegram user ID (this becomes the first entry in `telegram.admin_ids`). You can also enable the WebUI itself here.
4. **Wallet.** Generate a fresh TON wallet, import a mnemonic, or skip wallet provisioning. If you generate, you must confirm the mnemonic on the next sub-screen.
5. **Telegram.** Choose user mode (API ID + API hash + phone) or bot mode (bot token). For user mode pick **QR code** or **Phone code** authentication. The QR code refreshes itself; if your network blocks the Telegram CDN, switch to phone code or configure an MTProto proxy.
6. **Connect.** The wizard runs a connection test against Telegram and the LLM provider. You can skip the test, but skipping will require fixing problems later from the [Configuration](11-settings.md) page.

When everything passes, the wizard shows the **Setup Complete** card with the raw WebUI auth token. **Copy this token now** — it is shown exactly once and is required to sign in. The agent persists only the hash inside `config.yaml`.

## First sign-in

![Sign-in screen](../assets/screenshots/common/login-screen.png)

After setup, start the agent in WebUI mode:

```bash
teleton start --webui
```

The terminal prints a local URL (default: `http://127.0.0.1:8080`). Open it. You will see the **Teleton** card with a single token field, the placeholder *Paste token from config…*, and the **Sign In** button. Paste your token and press Enter or click **Sign In**.

If you used the in-terminal startup link, the URL fragment carries the token automatically and you skip the token field.

## Sidebar tour

After login the layout splits into:

- **Top of the sidebar** — search bar (`Ctrl+K` / `Cmd+K`) and 22 page links.
- **Bottom of the sidebar** — agent switcher, agent control buttons (start / stop / restart), the theme toggle (Dark ↔ Light), the Logout button, and the build version.
- **Main area** — the page you selected.

The 22 pages, in order, are: Dashboard, Agents, Tools, Plugins, Soul, Memory, Workspace, Tasks, Workflows, Pipelines, Events, MCP, Integrations, Network, Hooks, Sessions, Analytics, Feedback, Security, Self-Improve, Autonomous, Configuration. Each one has its own chapter in this guide.

The **Command Palette** (`Ctrl+K`) lets you jump to any page or launch helpers such as *Generate Widget* without using the mouse.

## Your first autonomous task

1. Open **Autonomous** in the sidebar.
2. Click **+ New task**.
3. In the natural-language box, describe the goal in plain English:

   ```text
   Monitor new DeDust pools every 5 minutes and report to @ton_ops
   when more than three pools appear.
   ```

4. Click **Parse with AI**. The structured fields (goal, success criteria, failure conditions, allowed/restricted tools, strategy, priority, iteration limit, duration limit, budget) get filled with a confidence score.
5. Read every field. If the confidence is below 70%, re-write the prompt or fill the fields manually. Pay particular attention to **restricted tools** — high-risk tools like `ton_send`, `jetton_send`, and `exec_run` should stay restricted unless the goal explicitly needs them.
6. Click **💾 Save & Start**. The task moves from `pending` to `queued` and then `running`; the live event log shows `plan`, `tool_call`, `tool_result`, `reflect`, `checkpoint` events.

See [Autonomous Mode](03-autonomous-mode.md) for the full life-cycle and pause/resume rules.

## Sanity check

Within the first ten minutes after launch:

- **Dashboard** — provider, model, uptime, and "agent ready" indicator are green.
- **Sessions** — your test message appears with the correct agent reply.
- **Tools** — only the tools you intend to allow are enabled and at the right scope.
- **Security** — the `agent_start` event is in the audit trail; the audit chain verifies.

## Recovery checklist

| Symptom | First check |
| --- | --- |
| The Sign In page rejects the token. | Restart the agent and use the startup link printed in the terminal; that link refreshes the auth nonce. |
| Login works, but the Dashboard shows "Not connected". | Click the bottom-of-sidebar agent control to start the runtime. |
| Autonomous tasks never leave `pending`. | Open Configuration → Telegram and confirm `admin_ids` has at least one numeric ID. |
| Telegram shows "Auth failed". | Recheck the API ID and API hash, then the phone country code, then the MTProto proxy. |
| Tool calls fail with "denied". | Open Tools and confirm the tool is enabled and in the right scope; cross-check the [Security Center](08-security.md) validation log. |

## Next steps

- [Dashboard](02-dashboard.md) — daily overview, widgets, the widget generator.
- [Configuration](11-settings.md) — every settings tab in detail.
- [Security Center](08-security.md) — policies, audit, approvals.
