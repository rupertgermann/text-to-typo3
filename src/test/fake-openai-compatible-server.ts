import http from "node:http";

type FakeModel = {
  id: string;
  context_length?: number;
  max_context_length?: number;
};

type FakeUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

type FakeChatResponse = {
  chunks: unknown[];
};

export type FakeOpenAICompatibleServer = {
  chatRequests: unknown[];
  modelsRequests: unknown[];
  url: string;
  close: () => Promise<void>;
};

export function createToolCallResponse({
  toolCallId,
  toolName,
  argumentsJson,
}: {
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
}): FakeChatResponse {
  return {
    chunks: [
      chatChunk({
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }),
      chatChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: toolCallId,
                  type: "function",
                  function: { name: toolName, arguments: argumentsJson },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      chatChunk({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
    ],
  };
}

export function createTextResponse({
  text,
  usage,
}: {
  text: string;
  usage?: FakeUsage;
}): FakeChatResponse {
  const chunks: unknown[] = [
    chatChunk({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    }),
    chatChunk({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
  ];

  if (usage) {
    chunks.push(
      chatChunk({
        choices: [],
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens:
            (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        },
      }),
    );
  }

  return { chunks };
}

export async function startFakeOpenAICompatibleServer({
  chatResponses,
  chatStatus = 200,
  models = [],
  modelsStatus = 200,
  modelsDelayMs = 0,
  modelsHang = false,
}: {
  chatResponses: FakeChatResponse[];
  chatStatus?: number;
  models?: FakeModel[];
  modelsStatus?: number;
  modelsDelayMs?: number;
  modelsHang?: boolean;
}): Promise<FakeOpenAICompatibleServer> {
  const chatRequests: unknown[] = [];
  const modelsRequests: unknown[] = [];
  let chatResponseIndex = 0;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/models") {
      modelsRequests.push({ headers: request.headers });
      if (modelsHang) {
        return;
      }
      if (modelsDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, modelsDelayMs));
      }
      if (modelsStatus !== 200) {
        response.writeHead(modelsStatus, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `HTTP ${modelsStatus}` } }));
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: models }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/chat/completions") {
      const chatRequest = JSON.parse(await readRequestBody(request)) as {
        stream?: boolean;
      };
      chatRequests.push(chatRequest);

      if (chatStatus !== 200) {
        response.writeHead(chatStatus, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `HTTP ${chatStatus}` } }));
        return;
      }

      const scriptedResponse = chatResponses[chatResponseIndex++];

      if (!scriptedResponse) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "No scripted response" } }));
        return;
      }

      if (chatRequest.stream !== true) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(toChatCompletion(scriptedResponse)));
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      for (const chunk of scriptedResponse.chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }

    response.writeHead(404).end();
  });

  await listen(server);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Fake OpenAI-compatible server did not bind to a TCP port");
  }

  return {
    chatRequests,
    modelsRequests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => close(server),
  };
}

function chatChunk(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-typo3-model",
    ...extra,
  };
}

function toChatCompletion(response: FakeChatResponse): Record<string, unknown> {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake-typo3-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: extractText(response),
        },
        finish_reason: "stop",
      },
    ],
    usage: extractUsage(response),
  };
}

function extractText(response: FakeChatResponse): string {
  return response.chunks
    .flatMap((chunk) => {
      const choices = (chunk as { choices?: Array<{ delta?: { content?: unknown } }> })
        .choices;
      return choices?.map((choice) => choice.delta?.content) ?? [];
    })
    .filter((content): content is string => typeof content === "string")
    .join("");
}

function extractUsage(response: FakeChatResponse): unknown {
  return (
    response.chunks.find(
      (chunk) => typeof (chunk as { usage?: unknown }).usage === "object",
    ) as { usage?: unknown } | undefined
  )?.usage ?? null;
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}
