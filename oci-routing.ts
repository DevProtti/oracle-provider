export type OracleChatApiFormat = "GENERIC" | "COHERE" | "COHEREV2";

export type OracleChatRequestFamily = "generic" | "cohere" | "cohere-v2";

export type OracleOutputTokenField = "maxTokens" | "maxCompletionTokens";

export type OracleModelRouting = {
  apiFormat: OracleChatApiFormat;
  family: OracleChatRequestFamily;
  outputTokenField: OracleOutputTokenField;
  catalogVisible: boolean;
  supportsImages: boolean;
};

// Image blocks are only emitted on the GENERIC request path, so a model is
// advertised as image-capable only when it is vision-capable upstream *and*
// routed through that path. Cohere formats carry images differently and are
// deliberately left out.
const ORACLE_VISION_MODEL_PATTERNS: RegExp[] = [
  /^openai\.gpt-4o(?:$|[-.])/,
  /^openai\.gpt-4\.1(?:$|[-.])/,
  /^openai\.gpt-5(?:$|[-.])/,
  /^google\.gemini(?:$|[-.])/,
  /^meta\.llama-4(?:$|[-.])/,
];

const ORACLE_HIDDEN_ON_DEMAND_MODELS = new Set([
  "cohere.command-a-reasoning",
  "cohere.command-r-16k",
  "cohere.command-r-plus",
]);

const ORACLE_API_FORMAT_RULES: Array<{
  pattern: RegExp;
  apiFormat: OracleChatApiFormat;
}> = [
  { pattern: /^cohere\.command-a(?:$|[-.])/, apiFormat: "COHEREV2" },
  { pattern: /^cohere\.command-r7b(?:$|[-.])/, apiFormat: "COHEREV2" },
  { pattern: /^cohere\.command(?:$|[-.])/, apiFormat: "COHERE" },
];

function normalizeOracleModelId(modelId: string | undefined): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = modelId.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveOracleChatApiFormat(modelId: string | undefined): OracleChatApiFormat {
  const normalized = normalizeOracleModelId(modelId);
  if (!normalized) {
    return "GENERIC";
  }

  for (const rule of ORACLE_API_FORMAT_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.apiFormat;
    }
  }

  if (!normalized.startsWith("cohere.")) {
    return "GENERIC";
  }

  return "COHERE";
}

function resolveOracleImageSupport(
  modelId: string | undefined,
  apiFormat: OracleChatApiFormat,
): boolean {
  if (apiFormat !== "GENERIC" || !modelId) {
    return false;
  }
  return ORACLE_VISION_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

export function resolveOracleModelRouting(modelId: string | undefined): OracleModelRouting {
  const normalized = normalizeOracleModelId(modelId);
  const apiFormat = resolveOracleChatApiFormat(normalized);

  return {
    apiFormat,
    family: apiFormat === "COHERE" ? "cohere" : apiFormat === "COHEREV2" ? "cohere-v2" : "generic",
    outputTokenField:
      apiFormat === "GENERIC" && normalized?.startsWith("openai.")
        ? "maxCompletionTokens"
        : "maxTokens",
    catalogVisible: normalized ? !ORACLE_HIDDEN_ON_DEMAND_MODELS.has(normalized) : true,
    supportsImages: resolveOracleImageSupport(normalized, apiFormat),
  };
}

export function isOracleCatalogModelVisible(modelId: string | undefined): boolean {
  return resolveOracleModelRouting(modelId).catalogVisible;
}

export function doesOracleModelSupportImages(modelId: string | undefined): boolean {
  return resolveOracleModelRouting(modelId).supportsImages;
}
