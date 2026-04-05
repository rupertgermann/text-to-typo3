# Plan: text-to-typo3

> Source PRD: [rupertgermann/text-to-typo3#1](https://github.com/rupertgermann/text-to-typo3/issues/1)

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

### What to build

Bootstrap the Next.js 15 App Router project with TypeScript, Tailwind, and shadcn/ui. Implement the full TYPO3 OAuth 2.0 + PKCE login flow: redirect to TYPO3 consent screen, handle callback, exchange code for tokens, store tokens encrypted in SQLite, issue an Iron Session cookie. Add a session middleware that protects all routes except `/api/auth/*`. Show a simple "logged in as [TYPO3 display name]" home screen and a logout button that clears the session and revokes the token. Multiple concurrent users with different TYPO3 identities must each get isolated sessions.

### Acceptance criteria

- [ ] `pnpm dev` starts the app; unauthenticated requests to `/` redirect to `/api/auth/login`
- [ ] `/api/auth/login` redirects to the configured TYPO3 OAuth consent screen with PKCE challenge
- [ ] After approving, `/api/auth/callback` exchanges the code, stores encrypted tokens, and sets a session cookie
- [ ] The home page shows the authenticated user's TYPO3 display name
- [ ] Page refresh preserves the session (token read from DB, not just memory)
- [ ] Token refresh runs transparently when the access token is expired
- [ ] Logging out clears the session cookie and removes the DB session row
- [ ] Two different TYPO3 users can be logged in concurrently in different browsers with isolated data

---

## Phase 2: Basic streaming chat

**User stories**: 6, 7, 8, 9, 10, 29

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

### What to build

Implement the server-side MCP client that connects to the TYPO3 MCP server over HTTP, forwarding the user's Bearer token. At the start of each `/api/chat` request, fetch (and cache per session) the full MCP tool schema and convert it into Vercel AI SDK `tool()` definitions. Pass these tools into `streamText` so the AI can call them. On the client, render each tool invocation as an inline collapsible card showing the tool name, input parameters, and output. Read operations (GetPage, ReadTable, Search, GetPageTree, ListTables, GetTableSchema) use a neutral/blue card style; write operations (WriteTable) use an amber card. Write cards include a direct link to the affected record in the TYPO3 backend. Failed tool calls render a red error card with the error message. The AI system prompt is augmented with TYPO3-specific context (site name, base URL) from the `TYPO3_MCP_SYSTEM_PROMPT` env var.

### Acceptance criteria

- [ ] "What pages exist on my TYPO3 site?" triggers a `GetPageTree` MCP call and the AI summarizes the result
- [ ] "Create a content element on page X saying Y" triggers a `WriteTable` call and creates a workspace record in TYPO3
- [ ] Each MCP tool call appears as a collapsed card in the chat thread
- [ ] Clicking a card expands to show input JSON and output JSON
- [ ] Read cards are visually distinct from write cards
- [ ] Write cards show a link that opens the TYPO3 backend record
- [ ] A failed MCP call renders a red error card; the AI acknowledges the failure in its response
- [ ] The MCP tool schema is fetched once per session, not on every message

---

## Phase 4: Conversation management

**User stories**: 29, 30, 31, 32, 33, 34

### What to build

Add a left sidebar listing all conversations for the current user, sorted by most recently updated. Each conversation shows its title and relative timestamp. Users can create a new conversation (navigates to `/conversations/[new-id]`), rename a conversation inline, and delete one (with a confirmation prompt). After the first assistant reply in a new conversation, auto-generate a title from the first 6 words of the user's opening message. Switching conversations loads the full message history for that conversation. The active conversation is highlighted in the sidebar.

### Acceptance criteria

- [ ] The sidebar lists all user conversations, most recent first
- [ ] Creating a new conversation opens a fresh empty chat and adds it to the sidebar
- [ ] New conversations auto-title after the first AI reply
- [ ] Double-clicking a conversation title allows inline rename; Enter/blur saves it
- [ ] Deleting a conversation removes it from the sidebar and DB; a confirmation dialog is shown
- [ ] Switching conversations loads the correct message history without a full page reload
- [ ] The sidebar is responsive — collapses on narrow viewports

---

## Phase 5: Model selection (OpenAI + LM Studio)

**User stories**: 23, 24, 25, 26, 27, 28

### What to build

Add a model picker dropdown in the chat header. It lists available OpenAI models (fetched from the OpenAI models API, filtered to chat-capable ones) and, if the user has configured a LM Studio base URL, the models available at that endpoint. Each model entry shows its name and a tooltip with context window size. The user's selection is persisted to `user_settings` and restored on next login. A settings panel (accessible from the header) lets users enter their own OpenAI API key (overriding the server default) and a LM Studio base URL + model. The `/api/chat` route reads the user's settings and instantiates the correct provider.

### Acceptance criteria

- [ ] The model picker shows at least the available OpenAI models when `OPENAI_API_KEY` is set server-side
- [ ] Selecting a model and sending a message uses that model for the response
- [ ] The model selection persists across page refreshes
- [ ] Entering a LM Studio base URL in settings and clicking "Fetch models" populates the picker with LM Studio models
- [ ] Selecting a LM Studio model and chatting produces responses from the local model
- [ ] Entering a personal OpenAI key in settings overrides the server key for that user's requests
- [ ] Model picker tooltip shows context window size

---

## Phase 6: Chat UI polish + activity sidebar

**User stories**: 11, 12, 13, 14, 18, 19, 22

### What to build

Complete the chat interface with all remaining UX features. Add an edit button on user messages that puts the message into an editable state; submitting re-runs the conversation from that point (truncating subsequent messages). Add a copy-to-clipboard button on every message bubble. Add timestamps displayed on hover. Add image attachment support (drag-and-drop onto the chat input or file picker button) — images are base64-encoded and passed to the AI as vision content. Add a collapsible right sidebar ("Activity") showing a chronological feed of all MCP tool calls in the current conversation, filterable by read/write. Write tool-call entries in the activity sidebar include the TYPO3 backend link.

### Acceptance criteria

- [ ] Clicking Edit on a user message makes it editable; submitting re-runs from that point and removes subsequent messages
- [ ] Every message has a Copy button that copies the raw text to clipboard
- [ ] Message timestamps are visible on hover
- [ ] Dragging an image file onto the chat input attaches it; the AI can describe or reference it
- [ ] The activity sidebar toggles open/closed via a button in the header
- [ ] The activity sidebar shows all MCP tool calls for the current conversation in chronological order
- [ ] Filtering the sidebar by "Writes only" shows only WriteTable calls

---

## Phase 7: Settings panel + conversation extras

**User stories**: 35, 36, 42, 43, 44

### What to build

Expand the settings panel into a full modal with three sections: AI Model (model picker, OpenAI key), LM Studio (base URL, model picker with live fetch), and Account (TYPO3 display name, TYPO3 base URL display, logout). Add conversation search: a search input at the top of the conversation sidebar filters conversations by title and message content (SQLite FTS). Add Markdown export: a menu option on each conversation downloads a `.md` file of the full conversation including tool-call summaries. The TYPO3 base URL is configurable via `TYPO3_BASE_URL` env var, allowing the app to point at any TYPO3 instance.

### Acceptance criteria

- [ ] The settings modal opens from the header and has all three sections
- [ ] Saving settings persists them and the next chat request uses the updated config
- [ ] Typing in the conversation search input filters the sidebar list in real time
- [ ] "Export as Markdown" on a conversation downloads a `.md` file with all messages and tool-call summaries
- [ ] Setting `TYPO3_BASE_URL` in `.env` to a different TYPO3 instance routes all MCP and OAuth calls there

---

## Phase 8: Scaffold CLI

**User stories**: 45, 46, 47, 48, 49, 50, 51, 52

### What to build

Implement `pnpm scaffold` as a Node.js ESM CLI script. It checks for required prerequisites (`ddev`, `composer`, `php`) and exits with clear error messages if any are missing. It then: initializes a DDEV project in `./typo3-instance/` (TYPO3 v13 recipe), installs TYPO3 v13 via `composer create-project` inside DDEV, installs `hn/typo3-mcp-server` via Composer, runs TYPO3 CLI setup commands (admin user creation, site configuration, workspace creation, OAuth client registration), seeds demo content (home page, sub-pages, text content elements, one news article if EXT:news is available), and writes a `.env.local` in the project root with `TYPO3_BASE_URL`, `TYPO3_OAUTH_CLIENT_ID`, `TYPO3_OAUTH_CLIENT_SECRET`, and test credentials. Re-running the script on an existing DDEV project updates configuration without destroying existing content. The script ends by printing a formatted summary: TYPO3 backend URL, chat app start command, test editor credentials.

### Acceptance criteria

- [ ] Running `pnpm scaffold` with DDEV and Composer available completes without errors
- [ ] Missing `ddev` or `composer` exits immediately with a human-readable error message
- [ ] After scaffold, `ddev start` (inside `./typo3-instance/`) brings up a working TYPO3 v13 backend
- [ ] The MCP server is accessible at `[TYPO3_BASE_URL]/mcp`
- [ ] `.env.local` is written with correct OAuth credentials
- [ ] `pnpm dev` after scaffolding connects to the DDEV TYPO3 instance; login with the test editor account works
- [ ] The scaffolded TYPO3 instance has at least 3 pages and 5 content elements visible in the AI chat
- [ ] Re-running `pnpm scaffold` on an already-scaffolded directory prints "already set up" and exits cleanly
