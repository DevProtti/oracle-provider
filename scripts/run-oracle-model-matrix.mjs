import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "/home/ubuntu/.npm-global/bin/openclaw";
const PROFILE = process.env.OPENCLAW_PROFILE ?? "oracle-matrix";
const OUTPUT_BASENAME =
  process.env.ORACLE_MATRIX_REPORT_BASENAME ?? "/home/ubuntu/oracle-model-matrix-report";
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.ORACLE_MATRIX_CONCURRENCY ?? "4", 10));
const TIMEOUT_SECONDS = Math.max(
  60,
  Number.parseInt(process.env.ORACLE_MATRIX_TIMEOUT_SECONDS ?? "180", 10),
);

const EXCLUDED_MODELS = [
  "oracle/cohere.command-a-vision",
  "oracle/xai.grok-4.20-multi-agent",
  "oracle/xai.grok-4.20-multi-agent-0309",
];

const EXCLUDED_PATTERNS = [
  "oracle/meta.llama-3*",
  "oracle/openai.*codex*",
  "oracle/openai.*search-preview*",
  "oracle/openai.*-pro*",
];

const ACTIVE_MODELS = [
  "oracle/cohere.command-a-03-2025",
  "oracle/cohere.command-latest",
  "oracle/cohere.command-plus-latest",
  "oracle/cohere.command-r-08-2024",
  "oracle/cohere.command-r-plus-08-2024",
  "oracle/google.gemini-2.5-flash",
  "oracle/google.gemini-2.5-flash-lite",
  "oracle/google.gemini-2.5-pro",
  "oracle/meta.llama-3-70b-instruct",
  "oracle/meta.llama-3.1-405b-instruct",
  "oracle/meta.llama-3.1-70b-instruct",
  "oracle/meta.llama-3.2-11b-vision-instruct",
  "oracle/meta.llama-3.2-90b-vision-instruct",
  "oracle/meta.llama-3.3-70b-instruct",
  "oracle/meta.llama-4-maverick-17b-128e-instruct-fp8",
  "oracle/meta.llama-4-scout-17b-16e-instruct",
  "oracle/openai.gpt-4.1",
  "oracle/openai.gpt-4.1-2025-04-14",
  "oracle/openai.gpt-4.1-mini",
  "oracle/openai.gpt-4.1-mini-2025-04-14",
  "oracle/openai.gpt-4.1-nano",
  "oracle/openai.gpt-4.1-nano-2025-04-14",
  "oracle/openai.gpt-4o",
  "oracle/openai.gpt-4o-2024-08-06",
  "oracle/openai.gpt-4o-2024-11-20",
  "oracle/openai.gpt-4o-mini",
  "oracle/openai.gpt-4o-mini-2024-07-18",
  "oracle/openai.gpt-5",
  "oracle/openai.gpt-5-2025-08-07",
  "oracle/openai.gpt-5-mini",
  "oracle/openai.gpt-5-mini-2025-08-07",
  "oracle/openai.gpt-5-nano",
  "oracle/openai.gpt-5-nano-2025-08-07",
  "oracle/openai.gpt-5.1",
  "oracle/openai.gpt-5.1-2025-11-13",
  "oracle/openai.gpt-5.1-chat-latest",
  "oracle/openai.gpt-5.2",
  "oracle/openai.gpt-5.2-2025-12-11",
  "oracle/openai.gpt-5.2-chat-latest",
  "oracle/openai.gpt-5.2-pro",
  "oracle/openai.gpt-5.2-pro-2025-12-11",
  "oracle/openai.gpt-5.4",
  "oracle/openai.gpt-5.4-2026-03-05",
  "oracle/openai.gpt-5.4-mini",
  "oracle/openai.gpt-5.4-mini-2026-03-17",
  "oracle/openai.gpt-5.4-nano",
  "oracle/openai.gpt-5.4-nano-2026-03-17",
  "oracle/openai.gpt-5.4-pro",
  "oracle/openai.gpt-5.4-pro-2026-03-05",
  "oracle/openai.gpt-5.5",
  "oracle/openai.gpt-5.5-2026-04-23",
  "oracle/openai.gpt-5.5-pro",
  "oracle/openai.gpt-5.5-pro-2026-04-23",
  "oracle/openai.gpt-oss-120b",
  "oracle/openai.gpt-oss-20b",
  "oracle/xai.grok-4.20-0309-non-reasoning",
  "oracle/xai.grok-4.20-0309-reasoning",
  "oracle/xai.grok-4.20-non-reasoning",
  "oracle/xai.grok-4.20-reasoning",
  "oracle/xai.grok-4.3",
  "oracle/xai.grok-code-fast-1",
];

const REQUESTED_MODELS = (process.env.ORACLE_MATRIX_MODELS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const REQUESTED_SCENARIOS = new Set(
  (process.env.ORACLE_MATRIX_SCENARIOS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const FOCUS_MODELS = new Set([
  "oracle/cohere.command-latest",
  "oracle/cohere.command-plus-latest",
  "oracle/cohere.command-r-plus-08-2024",
  "oracle/meta.llama-4-maverick-17b-128e-instruct-fp8",
  "oracle/google.gemini-2.5-flash",
  "oracle/google.gemini-2.5-flash-lite",
  "oracle/google.gemini-2.5-pro",
  "oracle/openai.gpt-oss-20b",
]);

const SCENARIOS = [
  {
    id: "simple",
    prompt: "Reply with exactly SIMPLE_OK and nothing else. Do not use any tools.",
  },
  {
    id: "tool",
    prompt:
      "Use exactly one tool, session_status, to report the current UTC time. Do not answer from memory. Do not write files. Do not call any tool other than session_status.",
  },
  {
    id: "web",
    prompt:
      "Use the web_search tool exactly once to verify who is the current CEO of OpenAI as of today, then answer in one short sentence with the name and source domain. Do not use any other tool.",
  },
];

function matchesExcludedPattern(model) {
  return EXCLUDED_PATTERNS.some((pattern) => {
    const regex = new RegExp(`^${pattern.replaceAll('.', '\.').replaceAll('*', '.*')}$`);
    return regex.test(model);
  });
}

function isExcludedModel(model) {
  return EXCLUDED_MODELS.includes(model) || matchesExcludedPattern(model);
}

const BASE_MODELS = REQUESTED_MODELS.length
  ? ACTIVE_MODELS.filter((model) => REQUESTED_MODELS.includes(model))
  : ACTIVE_MODELS;

const SELECTED_MODELS = BASE_MODELS.filter((model) => !isExcludedModel(model));

const SELECTED_SCENARIOS = REQUESTED_SCENARIOS.size
  ? SCENARIOS.filter((scenario) => REQUESTED_SCENARIOS.has(scenario.id))
  : SCENARIOS;

function nowIso() {
  return new Date().toISOString();
}

function sanitizeSlug(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

const RUN_STAMP = sanitizeSlug(nowIso());

function buildSessionKey(model, scenarioId) {
  return `matrix-${RUN_STAMP}-${scenarioId}-${sanitizeSlug(model)}`;
}

function buildPreview(text) {
  if (!text) {
    return "";
  }
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function extractJsonBlob(text) {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function stripAgentNoise(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("[agent] run "))
    .join("\n");
}

function summarizeError(stderr, stdout, fallback = "Command failed.") {
  const combined = [stderr, stdout]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("\n");
  if (!combined) {
    return fallback;
  }

  const lines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const interesting =
    lines.find((line) => /entity with key|not supported|invalid request|failed|exception|error/i.test(line)) ??
    lines.at(-1);
  return interesting || fallback;
}

function extractPayloadText(parsed) {
  const direct =
    parsed?.meta?.finalAssistantVisibleText ??
    parsed?.meta?.finalAssistantRawText ??
    parsed?.finalAssistantVisibleText ??
    parsed?.finalAssistantRawText;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const payloadTexts = Array.isArray(parsed?.payloads)
    ? parsed.payloads
        .map((payload) => (typeof payload?.text === "string" ? payload.text : ""))
        .filter(Boolean)
    : [];
  return payloadTexts.join("\n").trim();
}

function normalizeToolSummary(parsed) {
  return {
    calls: Number(parsed?.meta?.toolSummary?.calls ?? parsed?.toolSummary?.calls ?? 0),
    failures: Number(parsed?.meta?.toolSummary?.failures ?? parsed?.toolSummary?.failures ?? 0),
    tools: Array.isArray(parsed?.meta?.toolSummary?.tools)
      ? parsed.meta.toolSummary.tools
      : Array.isArray(parsed?.toolSummary?.tools)
        ? parsed.toolSummary.tools
        : [],
  };
}

function classifyScenario({ scenarioId, parsed, exitCode, durationMs, stdout, stderr }) {
  const payloadText = extractPayloadText(parsed);
  const preview = buildPreview(payloadText || summarizeError(stderr, stdout));
  const toolSummary = normalizeToolSummary(parsed);
  const stopReason =
    parsed?.meta?.completion?.stopReason ?? parsed?.meta?.stopReason ?? parsed?.completion?.stopReason ?? parsed?.stopReason ?? "error";
  const finishReason =
    parsed?.meta?.completion?.finishReason ?? parsed?.meta?.stopReason ?? parsed?.completion?.finishReason ?? parsed?.stopReason ?? "error";
  const usedWebSearch = toolSummary.tools.includes("web_search");
  const usedSessionStatus = toolSummary.tools.includes("session_status");
  const base = {
    worked: false,
    status: "fail",
    stopReason,
    finishReason,
    durationMs: Number(parsed?.meta?.durationMs ?? durationMs),
    payloadText: payloadText || summarizeError(stderr, stdout),
    payloadPreview: preview,
    toolCalls: toolSummary.calls,
    toolFailures: toolSummary.failures,
    toolsUsed: toolSummary.tools,
    usedWebSearch,
    sessionFile: parsed?.meta?.agentMeta?.sessionFile ?? null,
    rawError: stripAgentNoise(stderr).trim() || null,
    exactSimpleMatch: null,
  };

  if (exitCode !== 0 || stopReason === "error") {
    return base;
  }

  if (scenarioId === "simple") {
    const exactSimpleMatch = payloadText.trim() === "SIMPLE_OK";
    return {
      ...base,
      worked: exactSimpleMatch && toolSummary.calls === 0 && toolSummary.failures === 0,
      status: exactSimpleMatch && toolSummary.calls === 0 && toolSummary.failures === 0 ? "pass" : "fail",
      exactSimpleMatch,
    };
  }

  if (scenarioId === "tool") {
    const worked =
      usedSessionStatus && toolSummary.calls >= 1 && toolSummary.failures === 0 && stopReason !== "error";
    return {
      ...base,
      worked,
      status: worked ? "pass" : "fail",
    };
  }

  const worked = usedWebSearch && toolSummary.calls >= 1 && toolSummary.failures === 0;
  return {
    ...base,
    worked,
    status: worked ? "pass" : "fail",
  };
}

function buildArgs(model, scenario) {
  return [
    "--log-level",
    "silent",
    "--profile",
    PROFILE,
    "agent",
    "--local",
    "--session-key",
    buildSessionKey(model, scenario.id),
    "--message",
    scenario.prompt,
    "--model",
    model,
    "--json",
    "--timeout",
    String(TIMEOUT_SECONDS),
  ];
}

function runOpenClaw(model, scenario) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = buildArgs(model, scenario);
    const child = spawn(OPENCLAW_BIN, args, {
      env: {
        ...process.env,
        OCI_CONFIG_FILE: process.env.OCI_CONFIG_FILE ?? "/home/ubuntu/.oci/config",
        OCI_PROFILE: process.env.OCI_PROFILE ?? "DEFAULT",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, TIMEOUT_SECONDS * 1000 + 5000);
    timeoutHandle.unref();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startedAt;
      const jsonBlob = extractJsonBlob(`${stdout}
${stderr}`);
      let parsed = null;
      if (jsonBlob) {
        try {
          parsed = JSON.parse(jsonBlob);
        } catch {
          parsed = null;
        }
      }
      resolve({
        exitCode: exitCode ?? (timedOut ? 124 : 1),
        durationMs,
        stdout,
        stderr,
        parsed,
        timedOut,
      });
    });
  });
}

async function writeProgressLine(progressPath, line) {
  await fs.appendFile(progressPath, `${line}\n`, "utf8");
}

async function runMatrix() {
  const reportJsonPath = `${OUTPUT_BASENAME}.json`;
  const reportMdPath = `${OUTPUT_BASENAME}.md`;
  const progressPath = `${OUTPUT_BASENAME.replace(/-report$/, "")}-progress.log`;
  await fs.mkdir(path.dirname(reportJsonPath), { recursive: true });
  await fs.writeFile(progressPath, "", "utf8");

  const jobs = SELECTED_MODELS.flatMap((model) =>
    SELECTED_SCENARIOS.map((scenario) => ({
      model,
      scenario,
    })),
  );

  let cursor = 0;
  let completed = 0;
  const scenarioResults = new Map();
  const startIso = nowIso();

  async function worker(workerId) {
    while (true) {
      const index = cursor;
      cursor += 1;
      const job = jobs[index];
      if (!job) {
        return;
      }

      const { model, scenario } = job;
      await writeProgressLine(
        progressPath,
        `${nowIso()} START ${index + 1}/${jobs.length} worker=${workerId} ${model} ${scenario.id}`,
      );

      const raw = await runOpenClaw(model, scenario);
      const classified = classifyScenario({
        scenarioId: scenario.id,
        parsed: raw.parsed,
        exitCode: raw.exitCode,
        durationMs: raw.durationMs,
        stdout: raw.stdout,
        stderr: raw.stderr,
      });

      const result = {
        scenario: scenario.id,
        model,
        worked: classified.worked,
        status: classified.status,
        stopReason: classified.stopReason,
        finishReason: classified.finishReason,
        durationMs: classified.durationMs,
        payloadText: classified.payloadText,
        payloadPreview: classified.payloadPreview,
        exactSimpleMatch: classified.exactSimpleMatch,
        toolCalls: classified.toolCalls,
        toolFailures: classified.toolFailures,
        toolsUsed: classified.toolsUsed,
        usedWebSearch: classified.usedWebSearch,
        replayInvalid: Boolean(raw.parsed?.meta?.replayInvalid ?? raw.parsed?.replayInvalid),
        rawError: classified.rawError,
        elapsedMs: raw.durationMs,
        exitCode: raw.exitCode,
        timedOut: raw.timedOut,
        sessionFile: classified.sessionFile,
      };

      if (!scenarioResults.has(model)) {
        scenarioResults.set(model, {});
      }
      scenarioResults.get(model)[scenario.id] = result;

      completed += 1;
      await writeProgressLine(
        progressPath,
        `${nowIso()} DONE ${completed}/${jobs.length} worker=${workerId} ${model} ${scenario.id} status=${result.status} stop=${result.stopReason} tools=${result.toolsUsed.join(",") || "-"} err=${buildPreview(result.rawError || "") || "-"} preview=${result.payloadPreview || "-"}`,
      );
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) => worker(index + 1)));

  const results = SELECTED_MODELS.map((model) => ({
    model,
    focus: FOCUS_MODELS.has(model),
    scenarios: scenarioResults.get(model) ?? {},
  }));

  const summary = {
    generatedAt: nowIso(),
    startedAt: startIso,
    modelCount: SELECTED_MODELS.length,
    scenarioCount: SELECTED_SCENARIOS.length,
    requestCount: jobs.length,
    excludedModels: EXCLUDED_MODELS,
    excludedPatterns: EXCLUDED_PATTERNS,
    aliases: {
      "oracle/google.gemini-2.5-flash-pro": "oracle/google.gemini-2.5-pro",
    },
    focusModels: [...FOCUS_MODELS],
    scenarios: Object.fromEntries(
      SELECTED_SCENARIOS.map((scenario) => {
        const scenarioRows = results.map((row) => row.scenarios[scenario.id]).filter(Boolean);
        const passed = scenarioRows.filter((row) => row.status === "pass").length;
        return [
          scenario.id,
          {
            passed,
            failed: scenarioRows.length - passed,
          },
        ];
      }),
    ),
  };

  const report = {
    meta: {
      profile: PROFILE,
      openclawBin: OPENCLAW_BIN,
      timeoutSeconds: TIMEOUT_SECONDS,
      concurrency: CONCURRENCY,
      prompts: Object.fromEntries(SELECTED_SCENARIOS.map((scenario) => [scenario.id, scenario.prompt])),
      ...summary,
    },
    results,
  };

  await fs.writeFile(reportJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(reportMdPath, buildMarkdownReport(report), "utf8");
  await writeProgressLine(
    progressPath,
    `${nowIso()} COMPLETE report_json=${reportJsonPath} report_md=${reportMdPath}`,
  );

  console.log(`Wrote ${reportJsonPath}`);
  console.log(`Wrote ${reportMdPath}`);
}

function buildMarkdownReport(report) {
  const lines = [];
  lines.push("# Oracle GenAI OpenClaw Model Matrix");
  lines.push("");
  lines.push(`Generated: ${report.meta.generatedAt}`);
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push(`- Models tested: ${report.meta.modelCount}`);
  lines.push(`- Scenarios per model: ${report.meta.scenarioCount}`);
  lines.push(`- Total requests: ${report.meta.requestCount}`);
  lines.push(`- Profile: ${report.meta.profile}`);
  lines.push(
    `- Excluded exact models: ${report.meta.excludedModels.length ? report.meta.excludedModels.join(", ") : "none"}`,
  );
  lines.push(`- Excluded patterns: ${report.meta.excludedPatterns.join(", ")}`);
  lines.push(
    `- Alias used: oracle/google.gemini-2.5-flash-pro -> ${report.meta.aliases["oracle/google.gemini-2.5-flash-pro"]}`,
  );
  lines.push("");
  lines.push("## Scenario Summary");
  lines.push("");
  lines.push("| Scenario | Pass | Fail |");
  lines.push("| --- | ---: | ---: |");
  for (const [scenarioId, counts] of Object.entries(report.meta.scenarios)) {
    lines.push(`| ${scenarioId} | ${counts.passed} | ${counts.failed} |`);
  }
  lines.push("");
  lines.push("## Focus Models");
  lines.push("");
  lines.push("| Model | Simple | Tool | Web | Tool Calls | Tool Failures | Notes |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | --- |");
  for (const row of report.results.filter((entry) => entry.focus)) {
    lines.push(formatModelRow(row));
  }
  lines.push("");
  lines.push("## Full Matrix");
  lines.push("");
  lines.push("| Model | Simple | Tool | Web | Tool Calls | Tool Failures | Notes |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | --- |");
  for (const row of report.results) {
    lines.push(formatModelRow(row));
  }
  lines.push("");
  lines.push("## Remaining Failures");
  lines.push("");
  const failures = [];
  for (const row of report.results) {
    for (const scenario of SELECTED_SCENARIOS) {
      const result = row.scenarios[scenario.id];
      if (result?.status === "fail") {
        failures.push(`- ${row.model} · ${scenario.id}: ${buildPreview(result.payloadText || result.rawError || "failed")}`);
      }
    }
  }
  lines.push(...(failures.length ? failures : ["- None."]));
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatModelRow(row) {
  const simple = row.scenarios.simple;
  const tool = row.scenarios.tool;
  const web = row.scenarios.web;
  const toolCalls = Math.max(
    Number(tool?.toolCalls ?? 0),
    Number(web?.toolCalls ?? 0),
  );
  const toolFailures = Math.max(
    Number(tool?.toolFailures ?? 0),
    Number(web?.toolFailures ?? 0),
  );
  const notes = [
    simple?.status === "fail" ? `simple: ${buildPreview(simple?.payloadText)}` : "",
    tool?.status === "fail" ? `tool: ${buildPreview(tool?.payloadText)}` : "",
    web?.status === "fail" ? `web: ${buildPreview(web?.payloadText)}` : "",
  ]
    .filter(Boolean)
    .join(" / ");
  return `| ${row.model} | ${simple?.status?.toUpperCase() ?? "-"} | ${tool?.status?.toUpperCase() ?? "-"} | ${web?.status?.toUpperCase() ?? "-"} | ${toolCalls} | ${toolFailures} | ${notes} |`;
}

runMatrix().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
