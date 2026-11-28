# TYPO3 setup

Connect Text to TYPO3 to a TYPO3 instance with the MCP server extension.

## Required TYPO3 packages

Install the TYPO3 MCP server extension in the TYPO3 instance:

```bash
composer require hn/typo3-mcp-server
```

The extension supports TYPO3 13.4 and 14.3 and installs Workspaces as a dependency.

## Optional TYPO3 packages

Install `EXT:news` only if the TYPO3 instance should expose news records to MCP tools or if the scaffold workflow should seed a demo news article:

```bash
composer require georgringer/news
```

## Enable and verify TYPO3

After installing the Composer package, set up the extension and check its MCP endpoint.

1. Run `vendor/bin/typo3 extension:setup --extension=mcp_server`.
2. Sign in to the TYPO3 backend with a user who has access to the MCP server.
3. Open **MCP Server** from the username menu and copy the server URL.

## Local TYPO3 v14 demo

Run these commands from the local DDEV TYPO3 project to install the exact revision used by the demo.

```bash
ddev composer require 'hn/typo3-mcp-server:dev-main#2f1eac930f67f5d99830718f154086812747bb95'
ddev exec vendor/bin/typo3 extension:setup --extension=mcp_server
```

This upstream revision includes fixes for page mount checks and blocks record writes without an active workspace. The setup command installs the MCP extension's OAuth refresh-token schema.

Use a dedicated non-admin backend user with one page mount and a writable workspace. Give the user read and edit access to the target page and content types. For file workflows, give the user a dedicated writable file mount and the permissions listed below. Keep workspace publishing with its owner.

Create a manual bearer token in **MCP Server**, or run the command below with the dedicated backend username. Store the token in the app's local environment file.

```bash
ddev exec vendor/bin/typo3 mcp:oauth create text-to-typo3-demo --client-name='Text to TYPO3 local v14 demo'
```

In a separate app checkout, copy `.env.example` to `.env.local` and set its permissions with `chmod 600 .env.local`. Keep the existing v13 checkout and its environment file available for v13 work. Fill in the required app secrets from the example and set the demo values below.

```dotenv
TYPO3_BASE_URL=https://typo3-v14.ddev.site
TYPO3_MCP_URL=https://typo3-v14.ddev.site/mcp
TYPO3_MCP_ACCESS_TOKEN=replace-with-manual-demo-token
TYPO3_LOCAL_USER_NAME=Text to TYPO3 demo
TYPO3_OAUTH_MODE=
TYPO3_OAUTH_CLIENT_ID=
TYPO3_OAUTH_CLIENT_SECRET=
NEXT_PUBLIC_APP_URL=http://127.0.0.1:3014
DATABASE_PATH=data/typo3-v14-demo.db
```

From the app checkout, install dependencies and start the demo on loopback.

```bash
pnpm install
pnpm dev --hostname 127.0.0.1 --port 3014
```

If Node does not trust the DDEV certificate on macOS, use `NODE_OPTIONS=--use-system-ca` with a Node version that supports it, or set `NODE_EXTRA_CA_CERTS` to the local DDEV CA certificate. Open [the local app](http://127.0.0.1:3014) and use the MCP connection test in Settings.

The Camino fixture is page `142` at `/camino/text-to-typo3-demo`. Use `1:/text-to-typo3-demo/` as the upload target. Sign in with a workspace owner in the TYPO3 backend to review the staged edits. [Pinned MCP server revision](https://github.com/hauptsacheNet/typo3-mcp-server/tree/2f1eac930f67f5d99830718f154086812747bb95)

## TYPO3 MCP tools

- `GetPageTree`
- `GetPage`
- `Search`
- `ListTables`
- `ReadTable`
- `GetTableSchema`
- `GetFlexFormSchema`
- `WriteTable`
- `UploadFile`

The server advertises its tools, input schemas, and annotations through `tools/list`. The app treats tools marked `readOnlyHint: true` as reads. For tools marked as write-capable or without an annotation, the app applies the conversation's write approval setting.

Use the advertised schema for search-and-replace edits, record moves, file references, field filters, and translation. The available tables and fields depend on the backend user's permissions and the target page.

`ReadTable` can return `sys_file` records with `public_url` values. The app shows links to available files and inline thumbnails for images on the configured TYPO3 host.

`WriteTable` stages changes in a TYPO3 workspace. Review and publish them in the TYPO3 backend. The app shows the write result and counts pending record changes. When TYPO3 returns both page URLs, the app labels the live page and the workspace preview separately.

Treat a workspace preview URL as a credential. Anyone with the link can see unpublished changes in the workspace until it expires. The app shows the link in tool details and removes it from model input and Markdown exports. The lifetime comes from the workspace settings. The local demo uses one hour. Turn off `workspacePreviewLinks` in the MCP extension settings if your workspace requires backend-only previews.

Translation support is available through `WriteTable` but is experimental upstream. The assistant should only use translation workflows when the editor explicitly asks for translation work.

The app supports multi-step MCP runs, so a single user request can read page context, inspect table schema, and continue into follow-up TYPO3 tool calls before the response is finalized. `TYPO3_AGENT_MAX_STEPS` controls the request-level step cap.

OpenAI, LM Studio, and custom OpenAI-compatible models all use this toolset. The app routes provider requests differently where needed, but TYPO3-side MCP capabilities stay the same.

Most MCP requests time out after 5 seconds. An `UploadFile` call with a URL has 305 seconds to allow TYPO3 to download the file. The client caches MCP sessions for up to 25 minutes and reinitializes expired sessions using the server's negotiated protocol version.

For content creation and updates, TYPO3 users should have:

- access to the relevant pages and tables
- a writable workspace
- permission to create and edit records in the target TYPO3 area

When TYPO3 returns validation feedback, the assistant can inspect schema details and retry with corrected input in the same response.

For LM Studio mutation requests, the tool loop is kept in tool-calling mode until a write succeeds or the request reaches the configured step limit, which helps local models avoid stopping after the first read tool call.

## Upload files to TYPO3

`UploadFile` supports four workflows.

| Workflow | Input |
| --- | --- |
| Import a public file URL | Give chat a public HTTP or HTTPS URL. TYPO3 downloads the file into the target folder. |
| Add online media | Give chat a supported YouTube or Vimeo URL. TYPO3 stores a media reference to the video. |
| Save text as a file | Ask chat to save text in a supported format, such as CSV or WebVTT. Supply a filename with the extension. |
| Upload a local file | Ask chat for an upload, select the file in the chat or Activity panel, then submit it. The app sends the bytes without including them in model context. |

Set `targetFolder` to a writable FAL folder within the backend user's file mount. Use TYPO3's combined identifier, such as `1:/text-to-typo3-demo/`, when the user's default storage folder is outside the mount.

The extension adds files to storage immediately. A record that references an uploaded file still requires a separate `WriteTable` action in the workspace. File uploads do not increase the pending record-change count. TYPO3 renames files on filename conflicts and can reuse an identical file already in storage.

Local upload grants belong to the current app process and are single-use. They expire at the earlier of TYPO3's expiration time or 15 minutes. Use one app process for local uploads. Request a new upload if the app process restarts, the grant expires, or an upload attempt fails. The app accepts up to 500 MiB per local file with a 60-second upload deadline. TYPO3 and any proxy can enforce lower limits. [Upstream file handling](https://github.com/hauptsacheNet/typo3-mcp-server/blob/2f1eac930f67f5d99830718f154086812747bb95/TECHNICAL_OVERVIEW.md#imagefile-handling)

The completed upload receipt stays in the current browser tab and survives a reload. To find the UID later or from another tab or device, refer to a sent message that includes the UID or look up the file in TYPO3 storage.

## Environment values

This project expects the following TYPO3-related values in `.env.local`:

```bash
TYPO3_BASE_URL=
TYPO3_MCP_URL=
TYPO3_MCP_ACCESS_TOKEN=
TYPO3_LOCAL_USER_NAME=
TYPO3_OAUTH_MODE=
TYPO3_OAUTH_CLIENT_ID=
TYPO3_OAUTH_CLIENT_SECRET=
TYPO3_AGENT_MAX_STEPS=
NEXT_PUBLIC_APP_URL=
```

## Supported authentication modes

### Existing TYPO3 OAuth integration

Use this mode for TYPO3 instances that expose the OAuth endpoints the app uses for sign-in and user identity.

- `/oauth/authorize`
- `/oauth/token`
- `/oauth/userinfo`
- `/oauth/revoke`

In this mode, the required values are:

- `TYPO3_BASE_URL`
- `TYPO3_OAUTH_CLIENT_ID`
- `TYPO3_OAUTH_CLIENT_SECRET`
- `NEXT_PUBLIC_APP_URL`

In OAuth mode, visiting the app without an active session starts the TYPO3 browser login flow automatically.

### Native MCP OAuth

Use this mode to sign in through the MCP extension's OAuth endpoints. Register a public client once with the exact app callback URL. The example below uses a separate local app on port `3015`.

```bash
curl -fsS https://typo3-v14.ddev.site/mcp_oauth/register \
  -H 'Content-Type: application/json' \
  --data '{
    "client_name": "Text to TYPO3",
    "redirect_uris": ["http://127.0.0.1:3015/api/auth/callback"],
    "token_endpoint_auth_method": "none",
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "scope": "mcp_access"
  }' | jq -r .client_id
```

Set the app's environment values for native MCP OAuth.

```dotenv
TYPO3_BASE_URL=https://typo3-v14.ddev.site
TYPO3_OAUTH_MODE=mcp
TYPO3_OAUTH_CLIENT_ID=replace-with-registered-client-id
TYPO3_OAUTH_CLIENT_SECRET=
TYPO3_MCP_URL=
TYPO3_MCP_ACCESS_TOKEN=
NEXT_PUBLIC_APP_URL=http://127.0.0.1:3015
```

The app uses authorization code with PKCE. It refreshes the access token when needed during the session. Upstream supplies opaque tokens without a stable user identity, so each authorization creates a separate local profile and conversation history. Signing out ends the local app session. Use **MCP Server** in the TYPO3 backend to revoke the upstream grant. Use manual bearer-token mode for a local demo that should retain one profile across sessions. [Upstream OAuth endpoints](https://github.com/hauptsacheNet/typo3-mcp-server/blob/2f1eac930f67f5d99830718f154086812747bb95/Classes/Middleware/McpServerMiddleware.php)

### Token-based MCP mode

Use token-based MCP mode for a dedicated local account. The backend user's TYPO3 permissions apply to each request. The MCP server can provide a manual bearer token or a URL that includes the token.

```text
https://your-typo3.example/mcp?token=...
```

In this mode, the simplest setup is:

```bash
TYPO3_BASE_URL=https://your-typo3.example
TYPO3_MCP_URL=https://your-typo3.example/mcp?token=...
NEXT_PUBLIC_APP_URL=http://localhost:3002
```

Optional:

```bash
TYPO3_LOCAL_USER_NAME=Local TYPO3 Token
```

`TYPO3_MCP_ACCESS_TOKEN` is available for setups that use a raw bearer token instead of the full tokenized MCP URL.

In token-based MCP mode, the app skips the browser OAuth redirect and opens directly into the chat interface.

### `TYPO3_BASE_URL`

`TYPO3_BASE_URL` is the site origin of the TYPO3 instance, without `/mcp` and without a trailing slash.

Examples:

- `https://my-project.ddev.site`
- `https://cms.example.com`

How to get it:

1. Open `[Username] -> MCP Server` in TYPO3.
2. Copy the server URL shown there.
3. Remove the trailing `/mcp`.

Example:

- MCP Server URL: `https://my-project.ddev.site/mcp`
- `.env.local` value: `TYPO3_BASE_URL=https://my-project.ddev.site`

### `TYPO3_MCP_URL`

`TYPO3_MCP_URL` is the full MCP endpoint URL. In token-based mode it can include the `?token=...` query parameter exactly as shown in the TYPO3 backend MCP Server screen.

How to get it:

1. Open `[Username] -> MCP Server` in TYPO3.
2. Copy the token URL shown in the setup box.
3. Paste that exact URL into `.env.local`.

Example:

```bash
TYPO3_MCP_URL=https://typo3-v13.ddev.site/mcp?token=your-token-from-typo3
```

### `TYPO3_MCP_ACCESS_TOKEN`

`TYPO3_MCP_ACCESS_TOKEN` is an optional raw token value for MCP calls when the TYPO3 instance expects bearer-token MCP access.

If TYPO3 only provides the full tokenized MCP URL, `TYPO3_MCP_URL` is the better setting to use.

### `TYPO3_LOCAL_USER_NAME`

`TYPO3_LOCAL_USER_NAME` is the local display name used by the app in token-based mode. It does not have to match a TYPO3 backend username.

### `TYPO3_OAUTH_MODE`

Set `TYPO3_OAUTH_MODE=mcp` for native MCP OAuth. Leave it empty for an existing TYPO3 OAuth integration.

### `TYPO3_OAUTH_CLIENT_ID`

`TYPO3_OAUTH_CLIENT_ID` is the OAuth client ID for this Next.js app inside TYPO3.

How to get it:

1. Register an OAuth client in TYPO3 for this app.
2. Use this app's callback URL as the redirect URI:

```text
${NEXT_PUBLIC_APP_URL}/api/auth/callback
```

3. Copy the generated or configured client ID from TYPO3 into `.env.local`.

Example:

```bash
TYPO3_OAUTH_CLIENT_ID=text-to-typo3-web
```

### `TYPO3_OAUTH_CLIENT_SECRET`

`TYPO3_OAUTH_CLIENT_SECRET` is the client secret for the existing TYPO3 OAuth integration. Leave it empty for the public client used by native MCP OAuth.

How to get it:

1. Open the TYPO3 OAuth client registration for this app.
2. Copy the client secret shown by TYPO3.
3. Paste it into `.env.local`.

Example:

```bash
TYPO3_OAUTH_CLIENT_SECRET=super-secret-value
```

### `NEXT_PUBLIC_APP_URL`

`NEXT_PUBLIC_APP_URL` is the externally reachable base URL of the Next.js app.

Examples:

- `http://localhost:3000`
- `https://chat.example.com`

TYPO3 must use this exact value when registering the callback URL.

## Exact OAuth Redirect Value

When TYPO3 registers the OAuth client for this app, the redirect URI must be:

```text
${NEXT_PUBLIC_APP_URL}/api/auth/callback
```

For a standard local setup:

```text
http://localhost:3000/api/auth/callback
```

## Supported Setup Paths

### Existing TYPO3 Instance

Use this path when TYPO3 already exists.

1. Install the required Composer package:

```bash
composer require hn/typo3-mcp-server
```

2. Log into TYPO3 backend.
3. Open `[Username] -> MCP Server`.
4. Copy the MCP server URL and derive `TYPO3_BASE_URL` from it.
5. Choose one connection mode:

- For an existing TYPO3 OAuth integration, register the app callback and copy the client ID and secret into `.env.local`.
- For native MCP OAuth, register a public client and set `TYPO3_OAUTH_MODE=mcp`.
- For token-based MCP mode, copy a manual bearer token into `TYPO3_MCP_ACCESS_TOKEN` or set `TYPO3_MCP_URL` to the tokenized URL.

### Scaffolded TYPO3 Instance

Use this path when the repository provisions TYPO3 for you.

1. Run:

```bash
pnpm scaffold
```

2. Open the generated `.env.local`.
3. Use the generated values for:

- `TYPO3_BASE_URL`
- `TYPO3_OAUTH_CLIENT_ID`
- `TYPO3_OAUTH_CLIENT_SECRET`

4. Register those same OAuth client values inside TYPO3.

The scaffold command can automate this registration step through:

- `TYPO3_SCAFFOLD_OAUTH_CLIENT_COMMAND`

If that hook is not set, the scaffold summary tells you to register the client manually.

## Minimum TYPO3 Endpoint Checklist

This app expects TYPO3 to answer at:

- `${TYPO3_MCP_URL}` or `${TYPO3_BASE_URL}/mcp`

The existing TYPO3 OAuth integration also expects the following endpoints.

- `${TYPO3_BASE_URL}/oauth/authorize`
- `${TYPO3_BASE_URL}/oauth/token`
- `${TYPO3_BASE_URL}/oauth/userinfo`
- `${TYPO3_BASE_URL}/oauth/revoke`

Native MCP OAuth expects `${TYPO3_BASE_URL}/mcp_oauth/authorize` and `${TYPO3_BASE_URL}/mcp_oauth/token`. Check the server's OAuth metadata at `${TYPO3_BASE_URL}/.well-known/oauth-authorization-server` and verify that the registered redirect URI matches the app callback.

## TYPO3 permission checklist

For end-to-end TYPO3 editing workflows, the backend user or token should be able to:

- read the page tree and page records
- read `tt_content` and any extension tables involved in the workflow
- inspect table schemas through the MCP server
- create or update records through `WriteTable`
- work inside a writable TYPO3 workspace
- browse and add files in the target file mount for `UploadFile`
- read `sys_file` and create `sys_file_reference` where the content workflow uses file references

If reads succeed and writes fail, check the user's page mount, page rights, workspace membership, and table, field, and content-type permissions. For file errors, check the target folder and the file mount's browse and add permissions.

## Working Example

```bash
TYPO3_BASE_URL=https://my-project.ddev.site
TYPO3_MCP_URL=
TYPO3_MCP_ACCESS_TOKEN=
TYPO3_LOCAL_USER_NAME=Local TYPO3 Token
TYPO3_OAUTH_CLIENT_ID=text-to-typo3-web
TYPO3_OAUTH_CLIENT_SECRET=replace-with-your-secret
NEXT_PUBLIC_APP_URL=http://localhost:3000
OPENAI_API_KEY=your-openai-api-key
ENCRYPTION_KEY=generate-a-64-char-hex-key
SESSION_SECRET=generate-a-long-random-secret
TYPO3_AGENT_MAX_STEPS=12
MODEL_CATALOG_TIMEOUT_MS=4000
DATABASE_PATH=data/app.db
```
### Working Example For Token-Based MCP Mode

```bash
TYPO3_BASE_URL=https://typo3-v13.ddev.site
TYPO3_MCP_URL=https://typo3-v13.ddev.site/mcp?token=replace-with-token-from-typo3
TYPO3_LOCAL_USER_NAME=Local TYPO3 Token
NEXT_PUBLIC_APP_URL=http://localhost:3002
OPENAI_API_KEY=your-openai-api-key
ENCRYPTION_KEY=generate-a-64-char-hex-key
SESSION_SECRET=generate-a-long-random-secret
TYPO3_AGENT_MAX_STEPS=12
MODEL_CATALOG_TIMEOUT_MS=4000
DATABASE_PATH=data/app.db
```
