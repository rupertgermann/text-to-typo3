import http from "node:http";

type JsonRpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type FakeMcpToolCall = {
  name: string;
  arguments: unknown;
};

export type FakeMcpServer = {
  requests: JsonRpcRequest[];
  toolCalls: FakeMcpToolCall[];
  url: string;
  close: () => Promise<void>;
};

const defaultTools = [
  {
    name: "GetPageTree",
    description: "Read the TYPO3 page tree.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "ReadTable",
    description: "Read TYPO3 table records.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        table: { type: "string" },
      },
    },
  },
  {
    name: "GetTableSchema",
    description: "Inspect a TYPO3 table schema.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        table: { type: "string" },
      },
    },
  },
  {
    name: "WriteTable",
    description: "Write TYPO3 table records.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        table: { type: "string" },
        data: { type: "object" },
      },
    },
  },
];

export async function startFakeMcpServer(): Promise<FakeMcpServer> {
  const requests: JsonRpcRequest[] = [];
  const toolCalls: FakeMcpToolCall[] = [];

  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }

    const payload = JSON.parse(await readRequestBody(request)) as JsonRpcRequest;
    requests.push(payload);

    response.setHeader("Content-Type", "application/json");
    response.setHeader("Mcp-Session-Id", "fake-mcp-session");

    if (payload.method === "initialize") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "fake-typo3-mcp", version: "0.1.0" },
          },
        }),
      );
      return;
    }

    if (payload.method === "tools/list") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: { tools: defaultTools },
        }),
      );
      return;
    }

    if (payload.method === "tools/call") {
      const params = payload.params ?? {};
      const name = typeof params.name === "string" ? params.name : "unknown";
      const toolArguments = params.arguments ?? {};
      toolCalls.push({ name, arguments: toolArguments });

      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: toolResult(name, toolArguments),
        }),
      );
      return;
    }

    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id ?? null,
        error: { code: -32601, message: `Unknown method ${payload.method}` },
      }),
    );
  });

  await listen(server);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Fake MCP server did not bind to a TCP port");
  }

  return {
    requests,
    toolCalls,
    url: `http://127.0.0.1:${address.port}`,
    close: () => close(server),
  };
}

function toolResult(name: string, input: unknown): Record<string, unknown> {
  if (name === "GetPageTree") {
    return {
      content: [{ type: "text", text: "Home page uid 1 with About child uid 2." }],
      pages: [{ uid: 1, title: "Home", children: [{ uid: 2, title: "About" }] }],
      input,
    };
  }

  if (name === "GetTableSchema") {
    return {
      table: "tt_content",
      fields: [
        { name: "header", required: false },
        { name: "bodytext", required: false },
      ],
    };
  }

  if (name === "WriteTable") {
    return {
      table: "tt_content",
      uid: 123,
      isError: false,
      input,
    };
  }

  return {
    content: [{ type: "text", text: `Result from ${name}` }],
    input,
  };
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
  });
}
