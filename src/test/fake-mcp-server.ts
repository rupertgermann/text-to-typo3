import http from "node:http";
import type net from "node:net";

type JsonRpcRequest = {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type FakeMcpRequest = JsonRpcRequest & {
  headers: http.IncomingHttpHeaders;
};

export type FakeMcpToolCall = {
  name: string;
  arguments: unknown;
};

export type FakeMcpServer = {
  requests: FakeMcpRequest[];
  toolCalls: FakeMcpToolCall[];
  url: string;
  close: () => Promise<void>;
};

type FakeMcpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

const accessibleTables = [
  "pages",
  "tt_content",
  "sys_file",
  "sys_file_reference",
  "sys_file_metadata",
  "tx_news_domain_model_news",
];

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const defaultTools: FakeMcpToolDefinition[] = [
  {
    name: "GetPageTree",
    description:
      "Read the TYPO3 page hierarchy as a compact tree before creating pages, choosing parent pages, or checking page relationships.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        startPage: {
          type: "integer",
          description: "Page UID to start from; use 0 for the root.",
        },
        depth: {
          type: "integer",
          description: "Maximum depth to return. Defaults to 3.",
        },
        language: {
          type: "string",
          description: "Optional language ISO code for translated page titles.",
          enum: ["en", "de"],
        },
      },
      required: ["startPage"],
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "GetPage",
    description:
      "Read detailed TYPO3 page information by UID or URL, including page metadata and the page-owned content summary in the requested language.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        uid: {
          type: "integer",
          description: "Page UID to read.",
        },
        url: {
          type: "string",
          description: "Full URL, path, or slug to resolve instead of a UID.",
        },
        language: {
          type: "string",
          description: "Optional language ISO code for translated page and content data.",
          enum: ["en", "de"],
        },
        languageId: {
          type: "integer",
          description: "Deprecated numeric language identifier kept for compatibility.",
          deprecated: true,
        },
      },
      required: [],
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "Search",
    description:
      "Search workspace-capable TYPO3 records through TCA searchable fields, optionally narrowing by table, page, language, and result limit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        terms: {
          type: "array",
          items: { type: "string" },
          description: "Search terms to match in record content.",
        },
        termLogic: {
          type: "string",
          enum: ["AND", "OR"],
          default: "OR",
          description: "Combine multiple terms with AND or OR. Defaults to OR.",
        },
        table: {
          type: "string",
          description: "Optional workspace-capable table to search.",
          enum: accessibleTables,
        },
        pageId: {
          type: "integer",
          description: "Optional page UID to limit results to one page.",
        },
        limit: {
          type: "integer",
          description: "Maximum records per table. Defaults to 50.",
        },
        language: {
          type: "string",
          description: "Optional language ISO code to restrict results.",
          enum: ["en", "de"],
        },
      },
      required: ["terms"],
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "ListTables",
    description:
      "List TYPO3 tables available through MCP, grouped by extension and including access, table type, and workspace capability metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "ReadTable",
    description:
      "Read TYPO3 table records with filters, pagination, relation embedding, language handling, and fileadmin access through sys_file.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        table: {
          type: "string",
          description: "The TYPO3 table to read.",
          enum: accessibleTables,
        },
        pid: {
          type: "integer",
          description: "Optional page UID filter for page-owned records.",
        },
        uid: {
          oneOf: [
            { type: "integer" },
            { type: "array", items: { type: "integer" } },
          ],
          description: "Single UID or array of UIDs to fetch.",
        },
        where: {
          type: "string",
          description: "Optional SQL WHERE fragment without the WHERE keyword.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of records. Defaults to 20.",
        },
        offset: {
          type: "integer",
          description: "Pagination offset.",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Optional field whitelist; uid is always included.",
        },
        language: {
          type: "string",
          description: "Optional language ISO code. Omit for mixed-language list output.",
          enum: ["en", "de"],
        },
        includeTranslationSource: {
          type: "boolean",
          description: "Include translation source data for translated records.",
        },
      },
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "GetTableSchema",
    description:
      "Inspect fields, record types, relations, validation rules, and page TSconfig context for a TYPO3 table.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        table: {
          type: "string",
          description: "The TYPO3 table to inspect.",
          enum: accessibleTables,
        },
        type: {
          type: "string",
          description: "Optional record type, such as textmedia for tt_content.",
        },
        pid: {
          type: "integer",
          description: "Optional page UID for resolving page TSconfig.",
        },
      },
      required: ["table"],
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "GetFlexFormSchema",
    description:
      "Inspect a FlexForm data structure for a plugin or content element field, including field paths, labels, types, and configuration.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        table: {
          type: "string",
          description: "Table containing the FlexForm field. Defaults to tt_content.",
          default: "tt_content",
        },
        field: {
          type: "string",
          description: "FlexForm field name. Defaults to pi_flexform.",
          default: "pi_flexform",
        },
        identifier: {
          type: "string",
          description: "FlexForm data structure identifier, often the CType or plugin signature.",
        },
        recordUid: {
          type: "integer",
          description: "Optional record UID accepted for compatibility.",
        },
      },
      required: ["identifier"],
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "WriteTable",
    description:
      "Create, update, translate, or delete records in workspace-capable TYPO3 tables. Changes are queued in a TYPO3 workspace and must be published in the backend before they are live.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description: "Write action to perform.",
          enum: ["create", "update", "translate", "delete"],
        },
        table: {
          type: "string",
          description: "The workspace-capable TYPO3 table to write.",
          enum: accessibleTables,
        },
        uid: {
          type: "integer",
          description: "Record UID for update, translate, and delete actions.",
        },
        data: {
          type: "object",
          description:
            "Field values to write. For creates, include pid in data to choose the target page.",
          additionalProperties: true,
        },
        position: {
          type: "string",
          description:
            'Optional sorting position: "top", "bottom", "after:UID", or "before:UID".',
        },
      },
      required: ["action", "table"],
    },
    annotations: writeAnnotations,
  },
  {
    name: "LegacyMaintenanceTask",
    description:
      "Fixture-only mutation-style tool with no annotations so fail-safe tests can verify unannotated tools are not treated as safe reads.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        reason: {
          type: "string",
          description: "Why the legacy task would run.",
        },
      },
    },
  },
];

export async function startFakeMcpServer(options?: {
  hangMethods?: string[];
  protocolVersion?: string;
  sessionIds?: string[];
  statusByMethod?: Record<string, number>;
  tools?: FakeMcpToolDefinition[];
}): Promise<FakeMcpServer> {
  const requests: FakeMcpRequest[] = [];
  const sockets = new Set<net.Socket>();
  const toolCalls: FakeMcpToolCall[] = [];
  let sessionIdIndex = 0;

  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }

    const payload = JSON.parse(await readRequestBody(request)) as JsonRpcRequest;
    requests.push({ ...payload, headers: request.headers });
    const status = payload.method
      ? options?.statusByMethod?.[payload.method]
      : undefined;
    const shouldHang = payload.method
      ? options?.hangMethods?.includes(payload.method)
      : false;

    if (shouldHang) {
      return;
    }

    if (status) {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          error: { code: status, message: `HTTP ${status}` },
        }),
      );
      return;
    }

    response.setHeader("Content-Type", "application/json");
    const sessionId =
      options?.sessionIds?.[Math.min(sessionIdIndex, options.sessionIds.length - 1)] ??
      "fake-mcp-session";

    if (payload.method === "initialize" && options?.sessionIds?.length) {
      sessionIdIndex += 1;
    }

    response.setHeader("Mcp-Session-Id", sessionId);

    if (payload.method === "initialize") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            protocolVersion: options?.protocolVersion ?? "2024-11-05",
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
          result: { tools: options?.tools ?? defaultTools },
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

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
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
    close: () => close(server, sockets),
  };
}

function toolResult(name: string, input: unknown): Record<string, unknown> {
  const inputRecord =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

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

  if (name === "ReadTable") {
    const table = typeof inputRecord.table === "string" ? inputRecord.table : "tt_content";

    if (table === "sys_file") {
      return {
        table: "sys_file",
        rows: [
          {
            uid: 10,
            identifier: "/fileadmin/hero.jpg",
            filename: "hero.jpg",
            mime_type: "image/jpeg",
            public_url: "/fileadmin/hero.jpg",
          },
          {
            uid: 11,
            identifier: "/fileadmin/manual.pdf",
            filename: "manual.pdf",
            mime_type: "application/pdf",
            public_url: "/fileadmin/manual.pdf",
          },
        ],
        input,
      };
    }

    return {
      table,
      rows: [
        {
          uid: 123,
          pid: 67,
          header: "Example content",
          bodytext: "Fixture content body.",
        },
      ],
      input,
    };
  }

  if (name === "WriteTable") {
    return {
      table: typeof inputRecord.table === "string" ? inputRecord.table : "tt_content",
      uid: 123,
      workspaceUid: 123,
      workspaceId: 1,
      workspaceTitle: "Draft workspace",
      status: "queued",
      message: "Change queued in TYPO3 workspace and not live until published.",
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

function close(server: http.Server, sockets: Set<net.Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }

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
