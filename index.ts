import { definePluginEntry, type ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOracleMissingAuthMessage,
  ORACLE_ENV_VARS,
  ORACLE_PROVIDER_ID,
  runOracleAuthInteractive,
  runOracleAuthNonInteractive,
} from "./oci-auth.js";
import { createOracleStreamFn } from "./oci-stream.js";
import {
  prepareOracleRuntimeAuth,
  resolveOracleCatalogProvider,
  resolveOracleDynamicModel,
} from "./provider.js";

const PLUGIN_ID = "oracle-genai";
const MINIMUM_SUPPORTED_NODE_VERSION = { major: 24, minor: 17 };

function parseNodeMajorMinor(version: string): { major: number; minor: number } | null {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
  };
}

function isNodeVersionSupported(version: string): boolean {
  const parsed = parseNodeMajorMinor(version);
  if (!parsed) {
    return true;
  }
  if (parsed.major !== MINIMUM_SUPPORTED_NODE_VERSION.major) {
    return parsed.major > MINIMUM_SUPPORTED_NODE_VERSION.major;
  }
  return parsed.minor >= MINIMUM_SUPPORTED_NODE_VERSION.minor;
}

function ensureSupportedNodeVersion(): void {
  const version = process.version;
  if (isNodeVersionSupported(version)) {
    return;
  }
  throw new Error(
    [
      `Oracle GenAI requires Node >= ${MINIMUM_SUPPORTED_NODE_VERSION.major}.${MINIMUM_SUPPORTED_NODE_VERSION.minor}.0.`,
      `Current runtime: ${version}.`,
      "Node 24.16.x is known to break Oracle SDK requests after OpenClaw installs its global undici dispatcher.",
      "Upgrade Node to 24.17+ (24.18+ recommended) and restart OpenClaw.",
    ].join(" "),
  );
}

ensureSupportedNodeVersion();

const oracleAuthMethod: ProviderAuthMethod = {
  id: "oci-config",
  label: "OCI config file",
  hint: "API key auth via OCI config + private key",
  kind: "custom",
  wizard: {
    choiceId: "oracle-oci-config",
    choiceLabel: "OCI config file",
    choiceHint: "API key auth via OCI config + private key",
    groupId: "oracle",
    groupLabel: "Oracle OCI",
    groupHint: "OCI config file + private key",
    methodId: "oci-config",
  },
  run: async (ctx) => await runOracleAuthInteractive(ctx),
  runNonInteractive: async (ctx) => await runOracleAuthNonInteractive(ctx),
};

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Oracle GenAI",
  description: "OpenClaw Oracle GenAI provider plugin",
  register(api) {
    api.registerProvider({
      id: ORACLE_PROVIDER_ID,
      label: "Oracle OCI",
      docsPath: "/providers/models",
      envVars: [...ORACLE_ENV_VARS],
      auth: [oracleAuthMethod],
      catalog: {
        order: "simple",
        run: async (ctx) => await resolveOracleCatalogProvider(ctx),
      },
      resolveDynamicModel: (ctx) => resolveOracleDynamicModel(ctx),
      capabilities: {
        openAiCompatTurnValidation: false,
      },
      prepareRuntimeAuth: async (ctx) => await prepareOracleRuntimeAuth(ctx),
      createStreamFn: (ctx) => createOracleStreamFn({ agentDir: ctx.agentDir }),
      buildMissingAuthMessage: () => buildOracleMissingAuthMessage(),
      isModernModelRef: () => true,
    });
  },
});
