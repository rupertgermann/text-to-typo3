# Manual Test Plan

This test plan covers the main app flow from login through chat, tool usage, settings, and export.

## 1. Environment And Startup

1. Follow [docs/typo3-setup.md](./typo3-setup.md) to install the TYPO3-side Composer packages and collect the OAuth values.
2. Create `.env.local` with TYPO3 OAuth credentials, `SESSION_SECRET`, `ENCRYPTION_KEY`, and either `OPENAI_API_KEY` or a plan to enter one in Settings.
3. Run `pnpm install`.
4. Run `pnpm dev`.
5. Open `http://localhost:3000`.

Expected result:

- The app loads without build errors.
- Unauthenticated access redirects to TYPO3 OAuth login.

## 2. Authentication

1. Complete the TYPO3 OAuth login flow.
2. Return to the app.
3. Refresh the page.
4. Click `Logout`.

Expected result:

- Login succeeds.
- The app opens a conversation view.
- Refresh keeps the session alive.
- Logout clears the session and redirects back to login.

## 3. Basic Chat

1. Send a simple message such as `What pages exist on my TYPO3 site?`
2. Watch the response stream.
3. Click `Stop` during a longer response.
4. Refresh the page.

Expected result:

- The assistant response streams token-by-token.
- The loading indicator appears while generating.
- Stopping preserves the partial response.
- Refresh restores the existing transcript.

## 4. Message Editing And Attachments

1. Hover a previous user message and click the edit button.
2. Change the prompt and submit it.
3. Drag an image into the composer or attach one with the paperclip button.
4. Send a prompt that refers to the image.

Expected result:

- The composer enters edit mode.
- Resubmitting reruns the conversation from that point.
- The image appears as an attachment before send.
- The sent message keeps the attachment in the transcript after refresh.

## 5. Conversations

1. Create a new conversation.
2. Send an opening prompt.
3. Rename the conversation inline.
4. Search for it in the sidebar.
5. Export it as Markdown.
6. Delete a test conversation.

Expected result:

- The new conversation opens immediately.
- The title auto-populates from the first message.
- Inline rename persists.
- Search filters the list in real time.
- Export downloads a `.md` file.
- Delete removes the conversation after confirmation.

## 6. MCP Tool Rendering

1. Send a prompt that should trigger a TYPO3 read tool.
2. Expand a tool card in the transcript.
3. Open the Activity sidebar.
4. If available, trigger a TYPO3 write tool in a safe workspace scenario.

Expected result:

- Tool calls render as collapsible cards.
- Expanded cards show input and output JSON.
- Activity sidebar shows the same calls in order.
- Read/write filtering works.
- Write operations show a TYPO3 backend link when record metadata is present.

## 7. Settings And Models

1. Open `Settings`.
2. Inspect the AI Model, LM Studio, and Account sections.
3. If using OpenAI, select a different model.
4. If using LM Studio, enter the base URL and click `Fetch models`.
5. Use the header model picker to switch models.

Expected result:

- Settings load successfully.
- Model context-window hints appear in the settings cards and header picker.
- Model changes persist after refresh.
- LM Studio models load when the endpoint is reachable.

## 8. Scaffold CLI

1. Run `pnpm scaffold --help`.
2. Run `pnpm scaffold --dry-run --project-name demo-project`.
3. If prerequisites are installed, run `pnpm scaffold` in a clean environment.

Expected result:

- Help text shows command options and hook environment variables.
- Dry run prints the planned scaffold flow without writing TYPO3 resources.
- A real run writes `.env.local`, scaffold state, and the generated scaffold summary.
