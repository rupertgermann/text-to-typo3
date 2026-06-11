# Context

Glossary of domain terms for text-to-typo3. Definitions only — no implementation details.

## Terms

### Conversation
A persistent chat thread between an editor and the assistant about one TYPO3 instance. Carries its own title, history of Messages, and its own Write Approval mode (auto-approve on or off).

### Message
One entry in a Conversation: a user prompt (text, optionally with image attachments) or an assistant response. Assistant Messages may contain prose, Tool Calls, and token-usage information. A user Message can be edited and re-run, which replays the Conversation from that point.

### Tool Call
A single operation the assistant performs against the TYPO3 instance (read or write) during a response. Tool Calls are visible to the editor inline in the transcript and in the Activity view.

### Write Operation
A Tool Call that changes TYPO3 state (as opposed to inspecting it). Write Operations are subject to Write Approval.

### Write Approval
The editor's explicit consent required before a Write Operation executes. While approval is pending, the assistant's work on that operation is blocked until the editor approves or denies. A Conversation with auto-approve enabled skips this gate for its Write Operations.

### Activity
The filterable side view listing all Tool Calls of the current Conversation, separate from the transcript.

### Provider
A source of language models the editor can chat with: OpenAI, LM Studio, or a custom OpenAI-compatible endpoint.

### Model Catalog
The set of models currently available to one editor, combined across all of that editor's configured Providers.

### Starter Prompt
A predefined, editable example task shown in an empty Conversation to help the editor begin.
