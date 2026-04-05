# TYPO3 Setup

This guide covers the TYPO3-side requirements for `text-to-typo3`, including the exact Composer packages to install, how each TYPO3 value maps into `.env.local`, and when to use OAuth mode versus token-based MCP mode.

## Required TYPO3 Packages

Install the TYPO3 MCP server extension in the TYPO3 instance:

```bash
composer require hn/typo3-mcp-server
```

The package metadata for `hn/typo3-mcp-server` requires TYPO3 13.4+ and also requires `typo3/cms-workspaces`, so Workspaces is part of the supported setup already.

## Optional TYPO3 Packages

Install `EXT:news` only if the TYPO3 instance should expose news records to MCP tools or if the scaffold workflow should seed a demo news article:

```bash
composer require georgringer/news
```

## Enable And Verify TYPO3

After installing the Composer package:

1. Run the normal TYPO3 extension setup flow for the instance.
2. Log into the TYPO3 backend with a backend user that has access to the MCP server.
3. Open `[Username] -> MCP Server` in the TYPO3 backend.
4. Confirm that TYPO3 shows the MCP Server screen and a server URL.

The public package documentation for `hn/typo3-mcp-server` describes this backend flow and says the MCP Server screen is available under `[Username] -> MCP Server`.

## `.env.local` Values And Where They Come From

This project expects the following TYPO3-related values in `.env.local`:

```bash
TYPO3_BASE_URL=
TYPO3_MCP_URL=
TYPO3_MCP_ACCESS_TOKEN=
TYPO3_LOCAL_USER_NAME=
TYPO3_OAUTH_CLIENT_ID=
TYPO3_OAUTH_CLIENT_SECRET=
NEXT_PUBLIC_APP_URL=
```

## Supported Auth Modes

### OAuth mode

Use OAuth mode when the TYPO3 instance exposes:

- `/oauth/authorize`
- `/oauth/token`
- `/oauth/userinfo`
- `/oauth/revoke`

In this mode, the required values are:

- `TYPO3_BASE_URL`
- `TYPO3_OAUTH_CLIENT_ID`
- `TYPO3_OAUTH_CLIENT_SECRET`
- `NEXT_PUBLIC_APP_URL`

### Token-based MCP mode

Use token-based MCP mode when the TYPO3 backend MCP Server screen shows a tokenized URL like:

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

`TYPO3_OAUTH_CLIENT_SECRET` is the OAuth client secret that belongs to the same TYPO3 OAuth client as the client ID.

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

- OAuth mode:
  Register an OAuth client in TYPO3 for this app with redirect URI `${NEXT_PUBLIC_APP_URL}/api/auth/callback`, then copy the client ID and client secret into `.env.local`.
- token-based MCP mode:
  Copy the tokenized MCP URL from the TYPO3 MCP Server screen into `TYPO3_MCP_URL`.

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

OAuth mode also expects:

- `${TYPO3_BASE_URL}/oauth/authorize`
- `${TYPO3_BASE_URL}/oauth/token`
- `${TYPO3_BASE_URL}/oauth/userinfo`
- `${TYPO3_BASE_URL}/oauth/revoke`

If login fails, verify those routes first.

If token-based mode is used, the MCP URL itself is the critical endpoint to verify.

## Working Example

```bash
TYPO3_BASE_URL=https://my-project.ddev.site
TYPO3_MCP_URL=
TYPO3_MCP_ACCESS_TOKEN=
TYPO3_LOCAL_USER_NAME=Local TYPO3 Token
TYPO3_OAUTH_CLIENT_ID=text-to-typo3-web
TYPO3_OAUTH_CLIENT_SECRET=replace-with-your-secret
NEXT_PUBLIC_APP_URL=http://localhost:3000
OPENAI_API_KEY=sk-...
ENCRYPTION_KEY=replace-with-a-long-random-string
SESSION_SECRET=replace-with-a-long-random-string
```

### Working Example For Token-Based MCP Mode

```bash
TYPO3_BASE_URL=https://typo3-v13.ddev.site
TYPO3_MCP_URL=https://typo3-v13.ddev.site/mcp?token=replace-with-token-from-typo3
TYPO3_LOCAL_USER_NAME=Local TYPO3 Token
NEXT_PUBLIC_APP_URL=http://localhost:3002
OPENAI_API_KEY=sk-...
ENCRYPTION_KEY=replace-with-a-long-random-string
SESSION_SECRET=replace-with-a-long-random-string
```

## Notes About The TYPO3 OAuth Values

The MCP extension documentation publicly confirms the MCP Server backend screen and the server URL. This application additionally requires an OAuth client ID and secret because it uses the TYPO3 OAuth authorization code flow directly from the browser.

That means the values for `TYPO3_OAUTH_CLIENT_ID` and `TYPO3_OAUTH_CLIENT_SECRET` always come from the TYPO3-side OAuth client registration for this app, whether they are generated manually in TYPO3 or pre-generated by the scaffold command and then registered there.
