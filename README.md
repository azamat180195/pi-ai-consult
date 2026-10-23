# 🤖 pi-ai-consult

**Web AI Consultation Extension for [Pi Coding Agent](https://github.com/earendil-works/pi)**

Connect your local Pi Coding Agent to your logged-in **Claude (claude.ai)**, **ChatGPT (chatgpt.com)**, and **Google Gemini (gemini.google.com)** accounts via browser automation (Chrome DevTools Protocol). 

Get senior engineering reviews, architecture advice, and complete code artifacts from the world's most powerful reasoning models before executing critical tasks — **without requiring expensive API tokens or paid API tiers**.

---

## 🎯 Who Is This For?

- **Developers & DevOps Engineers** using Pi Coding Agent who want their autonomous agent to consult flagship reasoning models (like **Claude Sonnet 5.5 / Opus**, **ChatGPT Think mode**, and **Google Gemini 4 Argon**) using their existing web subscriptions (Claude Pro, ChatGPT Plus/Free, Google One AI Premium).
- **Security-Conscious Teams**: Built-in AST-like regex redaction ensures production passwords, SSH private keys, database connection strings, and cloud tokens are **never** leaked to external web models.
- **Teams tired of API token costs**: Access reasoning models with multi-thousand-token contexts without paying per-token API fees.

---

## ✨ Key Features

### 1. 🧠 Multi-Provider Web Consultation
- **Google Gemini**: Access **Gemini 4 Argon** (Сложные задачи) with deep reasoning (`Высокая`, `Средний`, `Низкая`), as well as `3.1 Pro` and `3.8 Flash`.
- **Claude (Anthropic)**: Access **Claude Sonnet 5.5**, **Opus**, and **Haiku** with customizable effort levels (`Low`, `Medium`, `High`, `Extra`, `Max`).
- **ChatGPT (OpenAI)**: Automatic **Think (Reasoning) Mode** activation (`think: true`) for complex debugging and architectural design.
- **Unified Tool (`consult_ai`)**: A single unified tool that can consult any of the three providers seamlessly.

### 2. 🛡️ Zero-Leak Secret & Credential Redactor
Automatically analyzes outgoing prompts and redacts credentials before transmission:
- **Passwords & Secrets**: `password: "..."`, `DB_PASSWORD=...`, `secret_key=...` ➔ `[REDACTED_SECRET]`
- **Database Connection Strings**: `postgres://user:pass@host/db` ➔ `postgres://user:[REDACTED_PASSWORD]@host/db`
- **Private Keys**: `-----BEGIN OPENSSH PRIVATE KEY-----` ➔ `[REDACTED_SSH_PRIVATE_KEY]`
- **API & Cloud Tokens**: AWS, Anthropic, OpenAI, GitHub PATs, GitLab tokens, Telegram bot tokens, JWTs.

### 3. 📦 Full Artifact & Canvas Harvesting
Web AI models often generate code inside separate panels rather than in the chat stream:
- **Claude Artifacts**: Automatically detects when Claude generates a file/artifact (e.g. `main.py`), opens the Artifact Drawer, strips line numbers, and extracts 100% of the raw source code.
- **ChatGPT Canvas / Documents**: Automatically extracts full document and code contents from ChatGPT Canvas containers.
- **Gemini Code Panels**: Extracts source code from dedicated code preview panels.

The local agent receives both the explanation AND the complete source code formatted in standard Markdown blocks ready to be deployed.

### 4. ⏳ Adaptive Streaming Budget & Completion Invariant
- **No Truncation**: Standard 360-second soft deadline dynamically extends by 60 seconds (up to 15 minutes) as long as new tokens/text are streaming.
- **Strict Completion Proof**: Guarantees that `success: true` is **never** returned on a partial or cut-off response. Requires explicit proof (Stop button gone, Copy button present, stream quiescence).
- **SPA Hydration Barrier**: Handles slow networks and heavy React SPAs by waiting for full hydration before evaluation.

### 5. 🔄 Turn-Anchored Recovery & Zero-Token Resumption
- Generates unique turn nonces (`[ref <hex>]`) to anchor observations strictly to the current turn, completely avoiding previous conversation turns.
- **Crash & Power-Cut Recovery**: Active chat URLs and nonces are persisted in `~/.pi/agent/ai-consult-last-chat.json`. If power cuts or the agent restarts, it reconnects to the exact chat and harvests the completed response in seconds without resending prompts or burning message quotas.

### 6. ⚡ Multi-Session Parallelism (CDP on Port 19222 / 9222)
- Runs over Chrome DevTools Protocol (`--remote-debugging-port=19222`). Auto-detects ports and avoids Windows Hyper-V port exclusion conflicts.
- Multiple Pi agent sessions run concurrently in parallel without locking Chrome profiles or killing each other's browser tabs.

### 7. 🩺 Self-Diagnostic Doctor Command
Run `/ai-consult doctor` to verify Pi version compatibility, Playwright driver status, Chrome CDP connectivity, and provider health in 1 second.

---

## 🚀 Installation & Setup

### Prerequisites
- Node.js 18+ (Node 20+ or 22+ recommended)
- Google Chrome installed on your machine
- [Pi Coding Agent](https://github.com/earendil-works/pi) installed

### Step 1: Install the Extension

#### Method A: Direct Pi Package Install (Recommended)
You can install this extension directly using Pi's built-in package manager:

```bash
pi install git:github.com/azamat180195/pi-ai-consult
```

Pi will automatically clone, install dependencies, and register the extension into your settings.

#### Method B: Manual Git Clone
Alternatively, you can clone it manually into your user extensions directory:

```bash
# Windows
git clone https://github.com/azamat180195/pi-ai-consult.git "%USERPROFILE%\.pi\agent\extensions\ai-consult"
cd "%USERPROFILE%\.pi\agent\extensions\ai-consult"
npm install

# Linux / macOS
git clone https://github.com/azamat180195/pi-ai-consult.git ~/.pi/agent/extensions/ai-consult
cd ~/.pi/agent/extensions/ai-consult
npm install
```

### Step 2: Log In to Your Accounts

Run the login commands from inside Pi (or launch Chrome with `--remote-debugging-port=19222`):

```bash
# In Pi terminal:
/ai-consult login claude    # Opens claude.ai -> log in to your account
/ai-consult login chatgpt   # Opens chatgpt.com -> log in to your account
/ai-consult login gemini    # Opens gemini.google.com -> log in to your account
```

You only need to log in **once**. Cookies and sessions are safely preserved in your persistent profile (`~/.pi/agent/ai-consult-profile`).

### Step 3: Verify Setup

Run the health check command:

```bash
/ai-consult doctor
```

Output:
```text
🩺 [ai-consult Doctor - System Health Check]:
  Pi Core Version: 1.3.0
  Extension Directory: ~/.pi/agent/extensions/ai-consult
  Playwright Driver: Installed & Active
  Browser Mode: CDP (remote debugging on port 19222)
  Update Survivability: Isolated user extension directory (100% update-proof)
  Summary: All systems healthy and ready!
```

---

## 🛠️ Usage

### 1. In Pi Coding Agent Prompts
You can now ask your Pi agent to consult external models before implementing tasks:

```text
"Review our Nginx upstream configuration and consult Claude Sonnet before making changes."
```
```text
"Ask ChatGPT with Think mode to design the zero-downtime deployment script."
```
```text
"Consult Google Gemini 4 Argon with High Reasoning on memory leak issues in our Node.js microservice."
```

Pi will autonomously call `consult_claude`, `consult_chatgpt`, or `consult_gemini`, evaluate their recommendations, extract any generated code/artifacts, and apply the validated solution to your repository.

### 2. Available Tools for Agent

| Tool Name | Provider | Key Options | Description |
| :--- | :--- | :--- | :--- |
| `consult_claude` | Anthropic Claude | `model`, `effort`, `newChat`, `timeoutSeconds` | Consults Claude (Sonnet, Opus, Haiku) with reasoning effort. |
| `consult_chatgpt` | OpenAI ChatGPT | `think` (default `true`), `newChat`, `timeoutSeconds` | Consults ChatGPT with automated Think reasoning mode. |
| `consult_gemini` | Google Gemini | `model` (default `4 Argon`), `reasoning` (default `Высокая`) | Consults Gemini 4 Argon or Pro models. |
| `consult_ai` | Universal | `provider` (`claude` \| `chatgpt` \| `gemini`), `prompt` | Universal tool to route prompts to any provider. |

### 3. Interactive Slash Commands

| Command | Description |
| :--- | :--- |
| `/ai-consult status` | Displays active browser mode (CDP / Persistent), port, and open tabs. |
| `/ai-consult doctor` | Runs complete diagnostics on driver, connection, and version compatibility. |
| `/ai-consult login [claude\|chatgpt\|gemini]` | Opens the browser to log in to the chosen provider. |
| `/ai-consult effort [Low\|Medium\|High\|Extra\|Max]` | Changes the default Claude reasoning effort level. |
| `/ai-consult claude <question>` | Sends a quick question to Claude directly from the terminal. |
| `/ai-consult chatgpt <question>` | Sends a quick question to ChatGPT directly from the terminal. |
| `/ai-consult reset-limit` | Clears any cached rate limit state after cooldown expires. |
| `/ai-consult close` | Gracefully closes background browser tabs. |

---

## 🔒 Privacy & Security Guarantee

- **No Cookies or Credentials in Git**: Local session tokens, cookies, and profile data live strictly in `~/.pi/agent/ai-consult-profile` and `~/.pi/agent/ai-consult-last-chat.json` on your local disk. None of this data is ever committed to source control.
- **Client-Side Redaction**: `SecretRedactor` executes entirely on your local machine before any HTTP/WebSocket frame is dispatched to browser tabs.

---

## 📄 License

MIT License. Free for personal and commercial use.
