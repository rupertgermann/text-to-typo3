# Plan: text-to-typo3

> Source PRD: [rupertgermann/text-to-typo3#1](https://github.com/rupertgermann/text-to-typo3/issues/1)

## Progress audit

Audit date: 2026-04-05

This plan now reflects the current codebase, not just the intended roadmap. Status labels mean:

- `Implemented` = present in code and wired through the app
- `Partial` = substantial implementation exists, but there are still feature gaps or acceptance criteria drift
- `Not started` = little or no implementation found

### Phase status summary

- Phase 1: `Implemented`
- Phase 2: `Implemented`
- Phase 3: `Partial`
- Phase 4: `Implemented`
- Phase 5: `Partial`
- Phase 6: `Partial`
- Phase 7: `Partial`
- Phase 8: `Partial`

## Architectural decisions

Durable decisions that apply across all phases:

- **Routes**:
  - Pages: `/` (chat home / redirect), `/conversations/[id]` (active chat)
  - Auth API: `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout`
  - Chat API: `POST /api/chat`
  - Conversations API: `GET/POST /api/conversations`, `GET/PATCH/DELETE /api/conversations/[id]`
  - Models API: `GET /api/models`
  - Settings API: `GET/PATCH /api/settings`

- **Schema** (SQLite via Drizzle ORM):
  - `users` — `id`, `typo3_uid` (unique), `display_name`, `created_at`
  - `sessions` — `id`, `user_id`, `access_token` (encrypted), `refresh_token` (encrypted), `expires_at`, `created_at`
  - `conversations` — `id`, `user_id`, `title`, `created_at`, `updated_at`
  - `messages` — `id`, `conversation_id`, `role` (user|assistant|tool), `content`, `tool_calls` (JSON), `created_at`
  - `user_settings` — `user_id` (PK), `model_id`, `openai_api_key` (encrypted), `lmstudio_base_url`, `lmstudio_model_id`

- **Key models**: `User`, `Conversation`, `Message`, `UserSettings`

- **Auth**: TYPO3 OAuth 2.0 Authorization Code + PKCE → Iron Session encrypted cookie → session middleware guards all `/api/*` and page routes except `/api/auth/*`

- **MCP boundary**: The MCP client runs server-side only (in API route handlers). The browser never connects to TYPO3 directly. The user's TYPO3 OAuth Bearer token is forwarded on every MCP request.

- **AI provider abstraction**: Vercel AI SDK `streamText` with swappable providers — `@ai-sdk/openai` for OpenAI models; `createOpenAI({ baseURL })` for LM Studio (OpenAI-compatible endpoint).

- **Streaming protocol**: Vercel AI SDK data stream (not plain SSE). The `useChat` hook on the client consumes it natively.

---

## Phase 1: Project skeleton + TYPO3 OAuth

**User stories**: 1, 2, 3, 4, 5

**Status**: `Implemented`

### What to build

Bootstrap the Next.js 15 App Router project with TypeScript, Tailwind, and shadcn/ui. Implement the full TYPO3 OAuth 2.0 + PKCE login flow: redirect to TYPO3 consent screen, handle callback, exchange code for tokens, store tokens encrypted in SQLite, issue an Iron Session cookie. Add a session middleware that protects all routes except `/api/auth/*`. Show a simple "logged in as [TYPO3 display name]" home screen and a logout button that clears the session and revokes the token. Multiple concurrent users with different TYPO3 identities must each get isolated sessions.

### Acceptance criteria

- [ ] `pnpm dev` starts the app; unauthenticated requests to `/` redirect to `/api/auth/login`
- [x] `/api/auth/login` redirects to the configured TYPO3 OAuth consent screen with PKCE challenge
- [x] After approving, `/api/auth/callback` exchanges the code, stores encrypted tokens, and sets a session cookie
- [~] The authenticated user's TYPO3 display name is shown in the conversation header rather than on a dedicated home screen
- [x] Page refresh preserves the session (token read from DB, not just memory)
- [x] Token refresh runs transparently when the access token is expired
- [x] Logging out clears the session cookie and removes the DB session row
- [~] Multiple TYPO3 users are supported by the schema/session design; concurrent-browser behavior was not re-verified in this audit

---

## Phase 2: Basic streaming chat

**User stories**: 6, 7, 8, 9, 10, 29

**Status**: `Implemented`

### What to build

Add the core chat experience. On first login, automatically create a default conversation in SQLite. `POST /api/chat` accepts a message + conversation ID, loads message history from DB, calls `streamText` with the OpenAI default model (from server-side `OPENAI_API_KEY`), and returns a Vercel AI SDK data stream. The client uses `useChat` to display streaming tokens in real time. Responses render Markdown (headings, bold, code blocks, lists, tables). A "thinking" spinner appears while the AI is generating. A stop button aborts the stream mid-response. Messages (user + assistant) are persisted to SQLite after each exchange. A page refresh restores the full conversation history.

### Acceptance criteria

- [x] Typing a message and pressing Enter sends it; the response streams token-by-token
- [x] AI responses render Markdown correctly (headings, code blocks, bold, lists)
- [x] A spinner/indicator is visible while the AI is generating
- [x] Clicking Stop mid-stream halts generation; the partial response is saved
- [x] After page refresh, all previous messages in the conversation are visible
- [x] Failed API calls (network error, OpenAI error) show an inline error message in the chat

---

## Phase 3: MCP bridge + tool-call visualization

**User stories**: 15, 16, 17, 20, 21, 37, 38, 39, 40, 41

**Status**: `Partial`

### What to build

Implement the server-side MCP client that connects to the TYPO3 MCP server over HTTP, forwarding the user's Bearer token. At the start of each `/api/chat` request, fetch (and cache per session) the full MCP tool schema and convert it into Vercel AI SDK `tool()` definitions. Pass these tools into `streamText` so the AI can call them. On the client, render each tool invocation as an inline collapsible card showing the tool name, input parameters, and output. Read operations (GetPage, ReadTable, Search, GetPageTree, ListTables, GetTableSchema) use a neutral/blue card style; write operations (WriteTable) use an amber card. Write cards include a direct link to the affected record in the TYPO3 backend. Failed tool calls render a red error card with the error message. The AI system prompt is augmented with TYPO3-specific context (site name, base URL) from the `TYPO3_MCP_SYSTEM_PROMPT` env var.

### Acceptance criteria

- [~] "What pages exist on my TYPO3 site?" should be able to trigger `GetPageTree`; the MCP tool bridge exists, but this exact live workflow was not re-verified in this audit
- [~] "Create a content element on page X saying Y" should be able to trigger `WriteTable`; the bridge exists, but the end-to-end TYPO3 write flow was not re-verified in this audit
- [x] Each MCP tool call appears as a collapsed card in the chat thread
- [x] Clicking a card expands to show input JSON and output JSON
- [x] Read cards are visually distinct from write cards
- [x] Write cards show a link that opens the TYPO3 backend record when the MCP response includes record metadata
- [~] A failed MCP call has red-card rendering support; live failure handling still needs end-to-end verification
- [~] The MCP tool schema is cached per session ID with a 5-minute TTL; this is close to the plan but not a strict whole-session cache

---

## Phase 4: Conversation management

**User stories**: 29, 30, 31, 32, 33, 34

**Status**: `Implemented`

### What to build

Add a left sidebar listing all conversations for the current user, sorted by most recently updated. Each conversation shows its title and relative timestamp. Users can create a new conversation (navigates to `/conversations/[new-id]`), rename a conversation inline, and delete one (with a confirmation prompt). After the first assistant reply in a new conversation, auto-generate a title from the first 6 words of the user's opening message. Switching conversations loads the full message history for that conversation. The active conversation is highlighted in the sidebar.

### Acceptance criteria

- [x] The sidebar lists all user conversations, most recent first
- [x] Creating a new conversation opens a fresh empty chat and adds it to the sidebar
- [x] New conversations auto-title after the first AI reply
- [x] Double-clicking a conversation title allows inline rename; Enter/blur saves it
- [x] Deleting a conversation removes it from the sidebar and DB; a confirmation dialog is shown
- [x] Switching conversations loads the correct message history without a full page reload
- [x] The sidebar is responsive and collapses into a sheet on narrow viewports

---

## Phase 5: Model selection (OpenAI + LM Studio)

**User stories**: 23, 24, 25, 26, 27, 28

**Status**: `Partial`

### What to build

Add a model picker dropdown in the chat header. It lists available OpenAI models (fetched from the OpenAI models API, filtered to chat-capable ones) and, if the user has configured a LM Studio base URL, the models available at that endpoint. Each model entry shows its name and a tooltip with context window size. The user's selection is persisted to `user_settings` and restored on next login. A settings panel (accessible from the header) lets users enter their own OpenAI API key (overriding the server default) and a LM Studio base URL + model. The `/api/chat` route reads the user's settings and instantiates the correct provider.

### Acceptance criteria

- [x] The settings modal loads available OpenAI models when an OpenAI key is resolved for the user
- [x] Selecting a model and sending a message uses that model for the response
- [x] The model selection persists across page refreshes
- [x] Entering a LM Studio base URL in settings and clicking "Fetch models" populates the picker with LM Studio models
- [~] Selecting a LM Studio model is wired through `/api/chat`, but local-model behavior still needs end-to-end verification against a running LM Studio instance
- [x] Entering a personal OpenAI key in settings overrides the server key for that user's requests
- [~] Context-window information is shown in model cards/title text, but not yet as a richer dedicated tooltip UI

---

## Phase 6: Chat UI polish + activity sidebar

**User stories**: 11, 12, 13, 14, 18, 19, 22

**Status**: `Partial`

### What to build

Complete the chat interface with all remaining UX features. Add an edit button on user messages that puts the message into an editable state; submitting re-runs the conversation from that point (truncating subsequent messages). Add a copy-to-clipboard button on every message bubble. Add timestamps displayed on hover. Add image attachment support (drag-and-drop onto the chat input or file picker button) — images are base64-encoded and passed to the AI as vision content. Add a collapsible right sidebar ("Activity") showing a chronological feed of all MCP tool calls in the current conversation, filterable by read/write. Write tool-call entries in the activity sidebar include the TYPO3 backend link.

### Acceptance criteria

- [ ] Clicking Edit on a user message makes it editable; submitting re-runs from that point and removes subsequent messages
- [x] Every message has a Copy button that copies the raw text to clipboard
- [x] Message timestamps are visible on hover
- [ ] Dragging an image file onto the chat input attaches it; the AI can describe or reference it
- [x] The activity sidebar toggles open/closed via a button in the header
- [x] The activity sidebar shows all MCP tool calls for the current conversation in chronological order
- [x] Filtering the sidebar by "Writes only" shows only write-classified tool calls

---

## Phase 7: Settings panel + conversation extras

**User stories**: 35, 36, 42, 43, 44

**Status**: `Partial`

### What to build

Expand the settings panel into a full modal with three sections: AI Model (model picker, OpenAI key), LM Studio (base URL, model picker with live fetch), and Account (TYPO3 display name, TYPO3 base URL display, logout). Add conversation search: a search input at the top of the conversation sidebar filters conversations by title and message content (SQLite FTS). Add Markdown export: a menu option on each conversation downloads a `.md` file of the full conversation including tool-call summaries. The TYPO3 base URL is configurable via `TYPO3_BASE_URL` env var, allowing the app to point at any TYPO3 instance.

### Acceptance criteria

- [x] The settings modal opens from the header and has all three sections
- [x] Saving settings persists them and the next chat request uses the updated config
- [x] Typing in the conversation search input filters the sidebar list in real time
- [x] "Export as Markdown" on a conversation downloads a `.md` file with all messages and tool-call summaries
- [x] Setting `TYPO3_BASE_URL` in `.env` to a different TYPO3 instance routes MCP and OAuth calls there

---

## Phase 8: Scaffold CLI

**User stories**: 45, 46, 47, 48, 49, 50, 51, 52

**Status**: `Partial`

### What to build

Implement `pnpm scaffold` as a Node.js ESM CLI script. It checks for required prerequisites (`ddev`, `composer`, `php`) and exits with clear error messages if any are missing. It then: initializes a DDEV project in `./typo3-instance/` (TYPO3 v13 recipe), installs TYPO3 v13 via `composer create-project` inside DDEV, installs `hn/typo3-mcp-server` via Composer, runs TYPO3 CLI setup commands (admin user creation, site configuration, workspace creation, OAuth client registration), seeds demo content (home page, sub-pages, text content elements, one news article if EXT:news is available), and writes a `.env.local` in the project root with `TYPO3_BASE_URL`, `TYPO3_OAUTH_CLIENT_ID`, `TYPO3_OAUTH_CLIENT_SECRET`, and test credentials. Re-running the script on an existing DDEV project updates configuration without destroying existing content. The script ends by printing a formatted summary: TYPO3 backend URL, chat app start command, test editor credentials.

### Acceptance criteria

- [~] `pnpm scaffold` exists as a real CLI with a concrete step plan, but it was not executed during this audit
- [x] Missing `ddev` or `composer` exits immediately with a human-readable error message
- [~] The script provisions a TYPO3 v13 DDEV project, but the resulting backend was not re-verified in this audit
- [~] The script installs `hn/typo3-mcp-server`, but MCP reachability still needs end-to-end verification
- [x] `.env.local` is written with generated TYPO3 base URL and OAuth credentials
- [~] `pnpm dev` integration after scaffolding still needs end-to-end verification
- [ ] The script does not yet guarantee at least 3 pages and 5 content elements visible in the AI chat; it currently relies on `styleguide:generate`
- [x] Re-running `pnpm scaffold` on an already-scaffolded directory prints "already set up" and exits cleanly
