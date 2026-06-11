# Manual Test Plan

This test plan covers the main app flow from login through chat, multi-step tool usage, Write Approval, settings, scaffold behavior, and export.

## 1. Environment And Startup

1. Follow [docs/typo3-setup.md](./typo3-setup.md) to install the TYPO3-side Composer packages and collect the OAuth values.
2. Create `.env.local` with TYPO3 OAuth credentials or token-mode MCP values, `SESSION_SECRET`, `ENCRYPTION_KEY`, and either `OPENAI_API_KEY` or a plan to enter one in Settings.
3. Run `pnpm install`.
4. Run `pnpm dev`.
5. Open `http://localhost:3000`.

Expected result:

- The app loads without build errors.
- Unauthenticated access redirects to TYPO3 OAuth login in OAuth mode and opens the chat directly in token-based MCP mode.
- During `pnpm dev`, Fast Refresh works without restarting the app for ordinary UI and route edits.

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

## 4. Multi-Step TYPO3 Tool Runs

1. Send a prompt that requires page inspection before answering, such as `Add 3 text content examples to page 67`.
2. Watch the transcript and Activity sidebar while the response is generating.
3. Confirm that the assistant continues after the first tool result instead of stopping at the initial read.

Expected result:

- The transcript can show more than one tool step inside a single assistant response.
- The Activity sidebar lists each step in order.
- Follow-up schema or write calls can happen after the initial TYPO3 read.

## 5. Message Editing And Attachments

1. Hover a previous user message and click the edit button.
2. Change the prompt and submit it.
3. Drag an image into the composer or attach one with the paperclip button.
4. Send a prompt that refers to the image.

Expected result:

- The composer enters edit mode.
- Resubmitting reruns the conversation from that point.
- The image appears as an attachment before send.
- The sent message keeps the attachment in the transcript after refresh.

## 6. Conversations

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
- Rapid typing produces debounced requests, and the previous result list stays visible while refreshed results load.
- Export downloads a `.md` file.
- Delete removes the conversation after confirmation.

## 7. MCP Tool Rendering

1. Send a prompt that should trigger a TYPO3 read tool.
2. Expand a tool card in the transcript.
3. Open the Activity sidebar.
4. Trigger a TYPO3 write tool in a safe workspace scenario.
5. Approve or deny the pending Write Approval from the banner above the composer.

Expected result:

- Tool calls render as collapsible cards.
- Expanded cards show input and output JSON.
- Activity sidebar shows the same calls in order.
- Read/write filtering works.
- Pending Write Approval appears in the banner above the composer and on the related tool card.
- Approve and Deny controls in the banner use the same approval path as the tool card controls.
- The jump action reveals the related tool card.
- Write operations show a TYPO3 backend link when record metadata is present.

## 8. TYPO3 Write Retry Behavior

1. Trigger a TYPO3 content-creation request in a writable workspace.
2. Use a prompt that may require schema lookup, such as `Create three text elements on page 67`.
3. If TYPO3 returns a validation error, continue watching the same response.

Expected result:

- The assistant treats TYPO3 validation feedback as guidance for another attempt.
- A schema lookup such as `GetTableSchema` can appear before the next `WriteTable` call.
- The assistant does not stop after the first recoverable `WriteTable` validation error.

## 9. Settings And Models

1. Open `Settings`.
2. Inspect the AI Model, Custom Endpoints, LM Studio, and Account sections.
3. If using OpenAI, select a different model.
4. If using LM Studio, enter the base URL and click `Fetch models`.
5. If using a custom OpenAI-compatible provider, enter its display name, base URL, and optional API key.
6. Test OpenAI, LM Studio, a custom provider, and MCP from Settings as applicable.
7. Select an LM Studio or custom provider model.
8. Send a TYPO3 read request such as `What pages exist on my TYPO3 site?`
9. Send a TYPO3 mutation request such as `Add 3 text content examples to page 67`.

Expected result:

- Saved Settings values appear immediately when the modal opens.
- Provider model sections show loading or unavailable states independently.
- OpenAI, LM Studio, and custom provider models can be selected from Settings.
- Model context-window hints appear in model cards where available.
- Model changes persist after refresh.
- LM Studio models load when the endpoint is reachable.
- Custom provider models load when the endpoint is reachable.
- LM Studio and custom provider models can call TYPO3 MCP tools through the app.
- OpenAI-compatible mutation requests can continue through multiple tool steps instead of stopping after the first read call.

## 10. Error Handling And Timeouts

1. Stop or block a local LM Studio or custom provider endpoint.
2. Open Settings.
3. Stop or block the TYPO3 MCP endpoint in a safe local environment.
4. Send a chat request that needs MCP tools.

Expected result:

- Dead model providers appear as unavailable within the configured model catalog timeout.
- Other provider model lists remain usable.
- A hung TYPO3 MCP server returns a categorized API error within the MCP request timeout.
- API errors use the `{ error: { code, message } }` shape.

## 11. Scaffold CLI

1. Run `pnpm scaffold --help`.
2. Run `pnpm scaffold --dry-run --project-name demo-project`.
3. Run `pnpm scaffold -i typo3-instance --php-version 8.3 --project-name demo-project --dry-run`.
4. If prerequisites are installed, run `pnpm scaffold` in a clean environment.

Expected result:

- Help text shows command options and hook environment variables.
- Dry run prints the planned scaffold flow without writing TYPO3 resources.
- A real run writes `.env.local`, scaffold state, and the generated scaffold summary.


## test prompts

- What tools does the TYPO3 MCP server offer?
- create a new sysfolder in "shared content". add some example news to this folder. then add a news plugin content element to the page named "content examples"
- translate the news and the news folder to german
