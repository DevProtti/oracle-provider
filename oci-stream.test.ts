import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth-api-key";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOracleRuntimeAuthToken, ORACLE_PROFILE_ID, ORACLE_PROVIDER_ID } from "./oci-auth.js";
import { convertPiMessagesToOracleMessages, createOracleStreamFn } from "./oci-stream.js";

const oracleFixtureDirs: string[] = [];

const ORACLE_RUNTIME_AUTH = buildOracleRuntimeAuthToken({
  configFile: "/tmp/oracle-config",
  profile: "DEFAULT",
  compartmentId: "ocid1.compartment.oc1..test",
  tenancyId: "ocid1.tenancy.oc1..tenant",
});

function writeOracleFixture(): {
  agentDir: string;
  configFile: string;
  profile: string;
  compartmentId: string;
  tenancyId: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oracle-"));
  oracleFixtureDirs.push(dir);

  const agentDir = path.join(dir, "agent");
  const configFile = path.join(dir, "config");
  const keyFile = path.join(dir, "oci_api_key.pem");
  const profile = "DEFAULT";
  const compartmentId = "ocid1.compartment.oc1..examplecompartment";
  const tenancyId = "ocid1.tenancy.oc1..exampletenancy";

  fs.writeFileSync(
    keyFile,
    [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    configFile,
    [
      `[${profile}]`,
      "user=ocid1.user.oc1..exampleuser",
      "fingerprint=11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00",
      "key_file=./oci_api_key.pem",
      `tenancy=${tenancyId}`,
      "region=us-chicago-1",
      "",
    ].join("\n"),
    "utf8",
  );

  upsertAuthProfile({
    agentDir,
    profileId: ORACLE_PROFILE_ID,
    credential: {
      type: "api_key",
      provider: ORACLE_PROVIDER_ID,
      key: configFile,
      metadata: {
        profile,
        compartmentId,
        tenancyId,
      },
    },
  });

  return {
    agentDir,
    configFile,
    profile,
    compartmentId,
    tenancyId,
  };
}

async function collectOracleEvents(stream: AsyncIterable<unknown>) {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function collectStreamEvents(stream: ReturnType<ReturnType<typeof createOracleStreamFn>>) {
  const resolved = await Promise.resolve(stream);
  return collectOracleEvents(resolved as AsyncIterable<unknown>);
}

function getDoneEvent(events: unknown[]) {
  const doneEvent = events.find(
    (event) => (event as { type?: unknown } | undefined)?.type === "done",
  );
  expect(doneEvent).toBeDefined();
  return doneEvent as {
    type: "done";
    reason: "stop" | "length" | "toolUse";
    message: {
      stopReason?: string;
      content?: unknown[];
      usage?: { input?: number; output?: number; totalTokens?: number };
    };
  };
}

async function runOracleStream(params: {
  modelId: string;
  messages: unknown[];
  tools?: unknown[];
  systemPrompt?: string;
  response: unknown;
  options?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  };
}) {
  const requests: unknown[] = [];
  const close = vi.fn();
  const chat = vi.fn(async (request: unknown) => {
    requests.push(request);
    return params.response;
  });
  const streamFn = createOracleStreamFn(
    (() =>
      ({
        chat: chat as never,
        close: close as never,
      }) as never) as never,
  );
  const events = await collectStreamEvents(
    streamFn(
      {
        id: params.modelId,
        api: "openai-completions",
        provider: "oracle",
      } as never,
      {
        systemPrompt: params.systemPrompt,
        messages: params.messages,
        tools: params.tools,
      } as never,
      {
        apiKey: ORACLE_RUNTIME_AUTH,
        ...(typeof params.options?.temperature === "number"
          ? { temperature: params.options.temperature }
          : {}),
        maxTokens: params.options?.maxTokens ?? 256,
        ...(typeof params.options?.topP === "number" ? { topP: params.options.topP } : {}),
      } as never,
    ),
  );

  expect(chat).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(1);
  return {
    events,
    request: requests[0] as {
      chatDetails?: {
        chatRequest?: Record<string, unknown>;
      };
    },
  };
}

afterEach(() => {
  for (const dir of oracleFixtureDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.OCI_CONFIG_FILE;
  delete process.env.OCI_PROFILE;
  delete process.env.OCI_CLI_PROFILE;
  delete process.env.OCI_COMPARTMENT_ID;
});

describe("convertPiMessagesToOracleMessages", () => {
  it("forwards user images as OCI IMAGE blocks for vision-capable models", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "openai.gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What colour is this?" },
            { type: "image", data: "QUJD", mimeType: "image/png" },
          ],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [
          { type: "TEXT", text: "What colour is this?" },
          {
            type: "IMAGE",
            imageUrl: { url: "data:image/png;base64,QUJD", detail: "AUTO" },
          },
        ],
      },
    ]);
  });

  it("keeps flattening images to text for models without image support", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "cohere.command-r-08-2024",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What colour is this?" },
            { type: "image", data: "QUJD", mimeType: "image/png" },
          ],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [{ type: "TEXT", text: "What colour is this?\n[Image omitted]" }],
      },
    ]);
  });

  it("passes through image data that is already a data URI", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "openai.gpt-5.5",
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "data:image/jpeg;base64,QUJD", mimeType: "image/jpeg" }],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [
          {
            type: "IMAGE",
            imageUrl: { url: "data:image/jpeg;base64,QUJD", detail: "AUTO" },
          },
        ],
      },
    ]);
  });

  it("falls back to a placeholder for image types Oracle cannot decode", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "openai.gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", data: "UklGRg==", mimeType: "image/webp" },
          ],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [{ type: "TEXT", text: "What is this?\n[Image omitted]" }],
      },
    ]);
  });

  it("rejects an unsupported type declared inside a data URI", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "openai.gpt-5.5",
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "data:image/webp;base64,UklGRg==", mimeType: "image/webp" }],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [{ type: "TEXT", text: "[Image omitted]" }],
      },
    ]);
  });

  it("pairs Gemini tool calls with tool results when the model ref is family-detectable", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "google.gemini-2.5-pro",
      messages: [
        {
          role: "user",
          content: "Use tools",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Working on it" },
            { type: "toolCall", id: "call_1", name: "toolOne", arguments: { a: 1 } },
            { type: "toolCall", id: "call_2", name: "toolTwo", arguments: { b: 2 } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "text", text: "first result" }],
        },
        {
          role: "toolResult",
          toolCallId: "call_2",
          content: [{ type: "text", text: "second result" }],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [{ type: "TEXT", text: "Use tools" }],
      },
      {
        role: "ASSISTANT",
        content: [{ type: "TEXT", text: "Working on it" }],
        toolCalls: [{ id: "call_1", type: "FUNCTION", name: "toolOne", arguments: '{"a":1}' }],
      },
      {
        role: "TOOL",
        toolCallId: "call_1",
        content: [{ type: "TEXT", text: "first result" }],
      },
      {
        role: "ASSISTANT",
        toolCalls: [{ id: "call_2", type: "FUNCTION", name: "toolTwo", arguments: '{"b":2}' }],
      },
      {
        role: "TOOL",
        toolCallId: "call_2",
        content: [{ type: "TEXT", text: "second result" }],
      },
    ]);
  });

  it("leaves opaque OCI ids on the generic tool-call path", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "ocid1.model.oc1..opaquegeminiid",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_1", name: "toolOne", arguments: { a: 1 } },
            { type: "toolCall", id: "call_2", name: "toolTwo", arguments: { b: 2 } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "text", text: "first result" }],
        },
        {
          role: "toolResult",
          toolCallId: "call_2",
          content: [{ type: "text", text: "second result" }],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "ASSISTANT",
        toolCalls: [
          { id: "call_1", type: "FUNCTION", name: "toolOne", arguments: '{"a":1}' },
          { id: "call_2", type: "FUNCTION", name: "toolTwo", arguments: '{"b":2}' },
        ],
      },
      {
        role: "TOOL",
        toolCallId: "call_1",
        content: [{ type: "TEXT", text: "first result" }],
      },
      {
        role: "TOOL",
        toolCallId: "call_2",
        content: [{ type: "TEXT", text: "second result" }],
      },
    ]);
  });
});

describe("createOracleStreamFn auth resolution", () => {
  it("uses the stored Oracle profile when runtime auth token is absent", async () => {
    const fixture = writeOracleFixture();

    const chat = vi.fn(async () => ({
      chatResult: {
        chatResponse: {
          choices: [
            {
              message: {
                content: [{ type: "TEXT", text: "Oracle says hi" }],
              },
              finishReason: "STOP",
            },
          ],
        },
      },
    }));
    const close = vi.fn();
    const createClient = vi.fn((auth: unknown) => {
      expect(auth).toEqual({
        configFile: fixture.configFile,
        profile: fixture.profile,
        compartmentId: fixture.compartmentId,
        tenancyId: fixture.tenancyId,
      });
      return { chat, close } as never;
    });

    const streamFn = createOracleStreamFn({
      agentDir: fixture.agentDir,
      createClient: createClient as never,
    });
    const stream = await streamFn(
      {
        api: "openai-completions",
        provider: "oracle",
        id: "google.gemini-2.5-pro",
      } as never,
      {
        messages: [{ role: "user", content: "Hello OCI" }],
        tools: [],
      } as never,
      undefined,
    );
    const events = await collectOracleEvents(stream);

    expect(createClient).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "done",
        reason: "stop",
      }),
    );
  });

  it("keeps the stored Oracle profile metadata when the caller passes the source config path", async () => {
    const fixture = writeOracleFixture();

    const chat = vi.fn(async () => ({
      chatResult: {
        chatResponse: {
          choices: [
            {
              message: {
                content: [{ type: "TEXT", text: "Source auth path works" }],
              },
              finishReason: "STOP",
            },
          ],
        },
      },
    }));
    const close = vi.fn();
    const createClient = vi.fn((auth: unknown) => {
      expect(auth).toEqual({
        configFile: fixture.configFile,
        profile: fixture.profile,
        compartmentId: fixture.compartmentId,
        tenancyId: fixture.tenancyId,
      });
      return { chat, close } as never;
    });

    const streamFn = createOracleStreamFn({
      agentDir: fixture.agentDir,
      createClient: createClient as never,
    });
    const stream = await streamFn(
      {
        api: "openai-completions",
        provider: "oracle",
        id: "meta.llama-3.3-70b-instruct",
      } as never,
      {
        messages: [{ role: "user", content: "Hello OCI" }],
        tools: [],
      } as never,
      {
        apiKey: fixture.configFile,
      } as never,
    );
    const events = await collectOracleEvents(stream);

    expect(createClient).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "done",
        reason: "stop",
      }),
    );
  });
});

describe("createOracleStreamFn routing", () => {
  it("uses GENERIC formatting for non-Cohere OCI model families", async () => {
    const genericModelIds = [
      "openai.gpt-5.4",
      "openai.gpt-oss-120b",
      "xai.grok-4.20-reasoning",
      "google.gemini-2.5-flash",
      "meta.llama-4-scout-17b-16e-instruct",
    ];

    for (const modelId of genericModelIds) {
      const { request } = await runOracleStream({
        modelId,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "lookup",
            description: "Look something up",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The query text",
                },
              },
              required: ["query"],
            },
          },
        ],
        response: {
          chatResult: {
            modelId,
            chatResponse: {
              apiFormat: "GENERIC",
              choices: [
                {
                  message: {
                    role: "ASSISTANT",
                    content: [{ type: "TEXT", text: "ok" }],
                  },
                  finishReason: "STOP",
                },
              ],
              usage: {
                promptTokens: 2,
                completionTokens: 1,
                totalTokens: 3,
              },
            },
          },
        },
      });

      const chatRequest = request.chatDetails?.chatRequest as {
        apiFormat?: string;
        tools?: Array<{ parameters?: Record<string, unknown> }>;
      };
      expect(chatRequest.apiFormat).toBe("GENERIC");
      expect(chatRequest.tools?.[0]?.parameters).toMatchObject({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The query text",
          },
        },
        required: ["query"],
      });
    }
  });

  it("filters Gemini Flash Lite tools down to the explicitly named tool", async () => {
    const { request } = await runOracleStream({
      modelId: "google.gemini-2.5-flash-lite",
      messages: [
        {
          role: "user",
          content:
            "Use exactly one tool, session_status, to report the current UTC time. Do not call any other tool.",
        },
      ],
      tools: [
        {
          name: "session_status",
          description: "Inspect the current session",
          parameters: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "google.gemini-2.5-flash-lite",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  toolCalls: [
                    {
                      id: "call_1",
                      type: "FUNCTION",
                      name: "session_status",
                      arguments: "{}",
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      tools?: Array<{ name?: string }>;
      toolChoice?: { type?: string; name?: string };
      isParallelToolCalls?: boolean;
    };
    expect(chatRequest.tools?.map((tool) => tool.name)).toEqual(["session_status"]);
    expect(chatRequest.toolChoice).toEqual({ type: "FUNCTION", name: "session_status" });
    expect(chatRequest.isParallelToolCalls).toBe(false);
  });

  it("removes Gemini Flash Lite tools when the prompt explicitly forbids tool use", async () => {
    const { request } = await runOracleStream({
      modelId: "google.gemini-2.5-flash-lite",
      messages: [
        {
          role: "user",
          content: 'Reply with exactly SIMPLE_OK and nothing else. Do not use any tools.',
        },
      ],
      tools: [
        {
          name: "message",
          description: "Send a message",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string" },
              message: { type: "string" },
            },
            required: ["action", "message"],
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "google.gemini-2.5-flash-lite",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "SIMPLE_OK" }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      tools?: Array<{ name?: string }>;
      toolChoice?: { type?: string; name?: string };
    };
    expect(chatRequest.tools).toBeUndefined();
    expect(chatRequest.toolChoice).toBeUndefined();
  });

  it("preserves the OpenClaw web_search tool on the generic path", async () => {
    const { request } = await runOracleStream({
      modelId: "google.gemini-2.5-flash",
      systemPrompt: "Be concise.",
      messages: [
        {
          role: "user",
          content:
            "Use the web_search tool exactly once to verify who is the current CEO of OpenAI as of today.",
        },
      ],
      tools: [
        {
          name: "web_search",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
        {
          name: "session_status",
          description: "Inspect the current session",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "google.gemini-2.5-flash",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "Sam Altman — openai.com" }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
      options: {
        maxTokens: 64,
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      messages?: Array<{ role?: string; content?: Array<{ text?: string }> }>;
      tools?: Array<{ name?: string }>;
      maxTokens?: number;
    };
    expect(chatRequest.tools?.map((tool) => tool.name)).toEqual(["web_search", "session_status"]);
    expect("webSearchOptions" in chatRequest).toBe(false);
    expect(chatRequest.maxTokens).toBe(64);
    expect(chatRequest.messages?.[0]?.role).toBe("SYSTEM");
    expect(chatRequest.messages?.[0]?.content?.[0]?.text).toBe("Be concise.");
  });

  it("uses COHERE formatting for all current Cohere v1 OCI aliases", async () => {
    const cohereV1ModelIds = [
      "cohere.command-r-08-2024",
      "cohere.command-r-plus-08-2024",
      "cohere.command-latest",
      "cohere.command-plus-latest",
      "cohere.command-r-16k",
      "cohere.command-r-plus",
    ];

    for (const modelId of cohereV1ModelIds) {
      const { request } = await runOracleStream({
        modelId,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "lookup",
            description: "Look something up",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The query text",
                },
              },
              required: ["query"],
            },
          },
        ],
        response: {
          chatResult: {
            modelId,
            chatResponse: {
              apiFormat: "COHERE",
              text: "ok",
              finishReason: "COMPLETE",
              usage: {
                promptTokens: 2,
                completionTokens: 1,
                totalTokens: 3,
              },
            },
          },
        },
      });

      const chatRequest = request.chatDetails?.chatRequest as {
        apiFormat?: string;
        tools?: Array<{
          name?: string;
          parameterDefinitions?: Record<string, { type?: string; isRequired?: boolean }>;
        }>;
      };
      expect(chatRequest.apiFormat).toBe("COHERE");
      expect(chatRequest.tools?.[0]).toMatchObject({
        name: "lookup",
        parameterDefinitions: {
          query: {
            type: "str",
            isRequired: true,
          },
        },
      });
    }
  });

  it("defaults temperature to the minimum safe value when none is provided", async () => {
    const { request } = await runOracleStream({
      modelId: "google.gemini-2.5-flash",
      messages: [{ role: "user", content: "hello" }],
      response: {
        chatResult: {
          modelId: "google.gemini-2.5-flash",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "ok" }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      temperature?: number;
    };
    expect(chatRequest.temperature).toBe(0);
  });


  it("omits explicit temperature for GPT-5-family Oracle OpenAI models", async () => {
    const { request } = await runOracleStream({
      modelId: "oracle/openai.gpt-5",
      messages: [{ role: "user", content: "hello" }],
      response: {
        chatResult: {
          modelId: "oracle/openai.gpt-5",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "ok" }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      temperature?: number;
    };
    expect(chatRequest.temperature).toBeUndefined();
  });

  it("strips strict JSON Schema keywords that Gemini rejects from tool parameters", async () => {
    const { request } = await runOracleStream({
      modelId: "google.gemini-2.5-flash",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "complex_tool",
          description: "A tool with strict JSON Schema constraints",
          parameters: {
            type: "object",
            properties: {
              value: {
                type: "number",
                minimum: 0,
                exclusiveMinimum: 1,
                maximum: 10,
                exclusiveMaximum: 9,
              },
            },
            required: ["value"],
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "google.gemini-2.5-flash",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "ok" }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      tools?: Array<{ parameters?: Record<string, unknown> }>;
    };
    expect(chatRequest.tools?.[0]?.parameters).toMatchObject({
      type: "object",
      properties: {
        value: {
          type: "number",
        },
      },
      required: ["value"],
    });
    expect(JSON.stringify(chatRequest.tools?.[0]?.parameters)).not.toContain("exclusiveMinimum");
    expect(JSON.stringify(chatRequest.tools?.[0]?.parameters)).not.toContain("exclusiveMaximum");
  });

  it("forces a high maxTokens budget for Cohere requests", async () => {
    const cohereV1 = await runOracleStream({
      modelId: "cohere.command-latest",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "lookup",
          description: "Look something up",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "cohere.command-latest",
          chatResponse: {
            apiFormat: "COHERE",
            text: "ok",
            finishReason: "COMPLETE",
            usage: {
              promptTokens: 2,
              completionTokens: 1,
              totalTokens: 3,
            },
          },
        },
      },
      options: {
        maxTokens: 15,
      },
    });

    const cohereV2 = await runOracleStream({
      modelId: "cohere.command-a-03-2025",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "lookup",
          description: "Look something up",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "cohere.command-a-03-2025",
          chatResponse: {
            apiFormat: "COHEREV2",
            message: {
              role: "ASSISTANT",
              content: [{ type: "TEXT", text: "ok" }],
            },
            finishReason: "COMPLETE",
            usage: {
              promptTokens: 2,
              completionTokens: 1,
              totalTokens: 3,
            },
          },
        },
      },
      options: {
        maxTokens: 15,
      },
    });

    const generic = await runOracleStream({
      modelId: "google.gemini-2.5-pro",
      messages: [{ role: "user", content: "hello" }],
      response: {
        chatResult: {
          modelId: "google.gemini-2.5-pro",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "ok" }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
      options: {
        maxTokens: 15,
      },
    });

    expect((cohereV1.request.chatDetails?.chatRequest as { maxTokens?: number }).maxTokens).toBe(256);
    expect((cohereV2.request.chatDetails?.chatRequest as { maxTokens?: number }).maxTokens).toBe(256);
    expect((generic.request.chatDetails?.chatRequest as { maxTokens?: number }).maxTokens).toBe(15);
  });

  it("keeps Cohere tool results in chatHistory when replaying a multistep turn", async () => {
    const { request } = await runOracleStream({
      modelId: "cohere.command-latest",
      messages: [
        { role: "user", content: "Use a tool to tell me the current UTC time." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will check the current UTC time." },
            { type: "toolCall", id: "call_1", name: "session_status", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "text", text: "UTC time is 15:34." }],
        },
      ],
      response: {
        chatResult: {
          modelId: "cohere.command-latest",
          chatResponse: {
            apiFormat: "COHERE",
            text: "Current UTC time is 15:34.",
            finishReason: "COMPLETE",
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      message?: string;
      chatHistory?: Array<Record<string, unknown>>;
      toolResults?: Array<Record<string, unknown>>;
    };

    expect(chatRequest.message).toBe("");
    expect(chatRequest.chatHistory).toEqual([
      {
        role: "CHATBOT",
        message: "I will check the current UTC time.",
        toolCalls: [
          {
            name: "session_status",
            parameters: {},
          },
        ],
      },
    ]);
    expect(chatRequest.toolResults).toEqual([
      {
        call: {
          name: "session_status",
          parameters: {},
        },
        outputs: [{ text: "UTC time is 15:34." }],
      },
    ]);
  });

  it("uses COHEREV2 formatting for all current Cohere v2 OCI aliases", async () => {
    const cohereV2ModelIds = [
      "cohere.command-a-vision",
      "cohere.command-a-reasoning",
      "cohere.command-a-03-2025",
    ];

    for (const modelId of cohereV2ModelIds) {
      const { request } = await runOracleStream({
        modelId,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "lookup",
            description: "Look something up",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The query text",
                },
              },
              required: ["query"],
            },
          },
        ],
        response: {
          chatResult: {
            modelId,
            chatResponse: {
              apiFormat: "COHEREV2",
              message: {
                role: "ASSISTANT",
                content: [{ type: "TEXT", text: "ok" }],
              },
              finishReason: "COMPLETE",
              usage: {
                promptTokens: 2,
                completionTokens: 1,
                totalTokens: 3,
              },
            },
          },
        },
      });

      const chatRequest = request.chatDetails?.chatRequest as {
        apiFormat?: string;
        tools?: Array<{
          type?: string;
          function?: { parameters?: Record<string, unknown> };
        }>;
      };
      expect(chatRequest.apiFormat).toBe("COHEREV2");
      expect(chatRequest.tools?.[0]).toMatchObject({
        type: "FUNCTION",
        function: {
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The query text",
              },
            },
            required: ["query"],
          },
        },
      });
    }
  });

  it("uses maxCompletionTokens instead of maxTokens for OCI OpenAI generic models", async () => {
    const { request } = await runOracleStream({
      modelId: "openai.gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      response: {
        chatResult: {
          modelId: "openai.gpt-5.4",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "ok" }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
      options: {
        maxTokens: 64,
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      apiFormat?: string;
      maxTokens?: number;
      maxCompletionTokens?: number;
    };
    expect(chatRequest.apiFormat).toBe("GENERIC");
    expect(chatRequest.maxCompletionTokens).toBe(64);
    expect(chatRequest.maxTokens).toBeUndefined();
  });
});

describe("createOracleStreamFn response handling", () => {
  it("maps lowercase generic length finish reasons to length", async () => {
    const { events } = await runOracleStream({
      modelId: "openai.gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      response: {
        chatResult: {
          modelId: "openai.gpt-5.4",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "truncated" }],
                },
                finishReason: "max_tokens",
                usage: {
                  promptTokens: 3,
                  completionTokens: 5,
                  totalTokens: 8,
                },
              },
            ],
          },
        },
      },
    });

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("length");
    expect(doneEvent.message.stopReason).toBe("length");
    expect(doneEvent.message.content).toEqual([{ type: "text", text: "truncated" }]);
  });

  it("preserves generic follow-up tool calling request and response handling", async () => {
    const { request, events } = await runOracleStream({
      modelId: "xai.grok-4",
      systemPrompt: "Use tools when needed.",
      messages: [
        { role: "user", content: "Read the file." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "call_generic",
              name: "read_file",
              arguments: { path: "README.md" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_generic",
          content: [{ type: "text", text: "README contents" }],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "xai.grok-4",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "Calling another tool." }],
                  toolCalls: [
                    {
                      id: "call_generic_out",
                      type: "FUNCTION",
                      name: "summarize",
                      arguments: '{"path":"README.md"}',
                    },
                  ],
                },
                finishReason: "stop",
                usage: {
                  promptTokens: 12,
                  completionTokens: 4,
                  totalTokens: 16,
                },
              },
            ],
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      apiFormat?: string;
      messages?: Array<Record<string, unknown>>;
    };
    expect(chatRequest.apiFormat).toBe("GENERIC");
    expect(chatRequest.messages).toEqual([
      {
        role: "SYSTEM",
        content: [{ type: "TEXT", text: "Use tools when needed." }],
      },
      {
        role: "USER",
        content: [{ type: "TEXT", text: "Read the file." }],
      },
      {
        role: "ASSISTANT",
        toolCalls: [
          {
            id: "call_generic",
            type: "FUNCTION",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
        ],
      },
      {
        role: "TOOL",
        toolCallId: "call_generic",
        content: [{ type: "TEXT", text: "README contents" }],
      },
    ]);

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.stopReason).toBe("toolUse");
    expect(doneEvent.message.content).toEqual([
      { type: "text", text: "Calling another tool." },
      {
        type: "toolCall",
        id: "call_generic_out",
        name: "summarize",
        arguments: { path: "README.md" },
      },
    ]);
  });

  it("parses Meta fallback tool-call text when Oracle returns only a bare invocation", async () => {
    const { events } = await runOracleStream({
      modelId: "meta.llama-4-maverick-17b-128e-instruct-fp8",
      messages: [{ role: "user", content: "Use a tool." }],
      tools: [
        {
          name: "session_status",
          description: "Inspect the session state",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "meta.llama-4-maverick-17b-128e-instruct-fp8",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "session_status()" }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
    });

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.stopReason).toBe("toolUse");
    expect(doneEvent.message.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^oracle_call_/),
        name: "session_status",
        arguments: {},
      },
    ]);
  });

  it("parses Meta bracket fallback tool-call text when Oracle returns only a tool label", async () => {
    const { events } = await runOracleStream({
      modelId: "meta.llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: "Use a tool." }],
      tools: [
        {
          name: "session_status",
          description: "Inspect the session state",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "meta.llama-4-scout-17b-16e-instruct",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "[session_status]" }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
    });

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.stopReason).toBe("toolUse");
    expect(doneEvent.message.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^oracle_call_/),
        name: "session_status",
        arguments: {},
      },
    ]);
  });


  it("parses Meta fallback tool-call text with named arguments for web_search", async () => {
    const { events } = await runOracleStream({
      modelId: "meta.llama-4-maverick-17b-128e-instruct-fp8",
      messages: [{ role: "user", content: "Use web search." }],
      tools: [
        {
          name: "web_search",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query",
              },
            },
            required: ["query"],
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "meta.llama-4-maverick-17b-128e-instruct-fp8",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: 'web_search(query="OpenAI current CEO today")' }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
    });

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.stopReason).toBe("toolUse");
    expect(doneEvent.message.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^oracle_call_/),
        name: "web_search",
        arguments: { query: "OpenAI current CEO today" },
      },
    ]);
  });

  it("preserves Cohere v1 tool calling request and response handling", async () => {
    const { request, events } = await runOracleStream({
      modelId: "cohere.command-r-08-2024",
      systemPrompt: "Be helpful.",
      messages: [
        { role: "user", content: "Look up alpha." },
        {
          role: "assistant",
          content: [
            {
              type: "function_call",
              id: "call_cohere_v1",
              name: "lookup",
              arguments: { query: "alpha" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_cohere_v1",
          content: [{ type: "text", text: "alpha result" }],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look something up",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The query text",
              },
            },
            required: ["query"],
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "cohere.command-r-08-2024",
          chatResponse: {
            apiFormat: "COHERE",
            text: "Running the lookup tool.",
            toolCalls: [
              {
                name: "lookup",
                parameters: { query: "alpha" },
              },
            ],
            finishReason: "COMPLETE",
            usage: {
              promptTokens: 7,
              completionTokens: 3,
              totalTokens: 10,
            },
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      apiFormat?: string;
      message?: string;
      preambleOverride?: string;
      chatHistory?: Array<Record<string, unknown>>;
      toolResults?: Array<Record<string, unknown>>;
    };
    expect(chatRequest).toMatchObject({
      apiFormat: "COHERE",
      message: "",
      preambleOverride: "Be helpful.",
      chatHistory: [
        {
          role: "CHATBOT",
          toolCalls: [
            {
              name: "lookup",
              parameters: { query: "alpha" },
            },
          ],
        },
      ],
      toolResults: [
        {
          call: {
            name: "lookup",
            parameters: { query: "alpha" },
          },
          outputs: [{ text: "alpha result" }],
        },
      ],
    });

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.content).toEqual([
      { type: "text", text: "Running the lookup tool." },
      {
        type: "toolCall",
        id: expect.stringMatching(/^oracle_call_/),
        name: "lookup",
        arguments: { query: "alpha" },
      },
    ]);
  });

  it("parses generic-style tool calls for cohere.command-latest responses", async () => {
    const { events } = await runOracleStream({
      modelId: "cohere.command-latest",
      messages: [{ role: "user", content: "Look up gamma." }],
      tools: [
        {
          name: "lookup",
          description: "Look something up",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The query text",
              },
            },
            required: ["query"],
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "cohere.command-latest",
          chatResponse: {
            apiFormat: "COHERE",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "Calling the lookup tool." }],
                  toolCalls: [
                    {
                      id: "call_latest",
                      type: "FUNCTION",
                      name: "lookup",
                      arguments: '{"query":"gamma"}',
                    },
                  ],
                },
                finishReason: "TOOL_CALL",
                usage: {
                  promptTokens: 9,
                  completionTokens: 3,
                  totalTokens: 12,
                },
              },
            ],
          },
        },
      },
    });

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.stopReason).toBe("toolUse");
    expect(doneEvent.message.content).toEqual([
      { type: "text", text: "Calling the lookup tool." },
      {
        type: "toolCall",
        id: "call_latest",
        name: "lookup",
        arguments: { query: "gamma" },
      },
    ]);
  });

  it("preserves Cohere v2 tool calling request and response handling", async () => {
    const { request, events } = await runOracleStream({
      modelId: "cohere.command-a-03-2025",
      systemPrompt: "Use tools when useful.",
      messages: [
        { role: "user", content: "Look up beta." },
        {
          role: "assistant",
          content: [
            {
              type: "function_call",
              id: "call_cohere_v2",
              name: "lookup",
              arguments: { query: "beta" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_cohere_v2",
          content: [{ type: "text", text: "beta result" }],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look something up",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The query text",
              },
            },
            required: ["query"],
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "cohere.command-a-03-2025",
          chatResponse: {
            apiFormat: "COHEREV2",
            message: {
              role: "ASSISTANT",
              content: [{ type: "TEXT", text: "Running the lookup tool." }],
              toolCalls: [
                {
                  id: "call_cohere_v2_out",
                  type: "FUNCTION",
                  function: {
                    name: "lookup",
                    arguments: '{"query":"beta"}',
                  },
                },
              ],
            },
            finishReason: "TOOL_CALL",
            usage: {
              promptTokens: 8,
              completionTokens: 3,
              totalTokens: 11,
            },
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      apiFormat?: string;
      messages?: Array<Record<string, unknown>>;
    };
    expect(chatRequest).toMatchObject({
      apiFormat: "COHEREV2",
      messages: [
        {
          role: "SYSTEM",
          content: [{ type: "TEXT", text: "Use tools when useful." }],
        },
        {
          role: "USER",
          content: [{ type: "TEXT", text: "Look up beta." }],
        },
        {
          role: "ASSISTANT",
          content: [],
          toolCalls: [
            {
              id: "call_cohere_v2",
              type: "FUNCTION",
              function: {
                name: "lookup",
                arguments: '{"query":"beta"}',
              },
            },
          ],
        },
        {
          role: "TOOL",
          toolCallId: "call_cohere_v2",
          content: [{ type: "TEXT", text: "beta result" }],
        },
      ],
    });

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.content).toEqual([
      { type: "text", text: "Running the lookup tool." },
      {
        type: "toolCall",
        id: "call_cohere_v2_out",
        name: "lookup",
        arguments: { query: "beta" },
      },
    ]);
  });
});
