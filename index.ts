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

const PLUGIN_ID = "oracle-provider";

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
  name: "Oracle OCI Provider",
  description: "OpenClaw Oracle OCI Generative AI provider plugin",
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
