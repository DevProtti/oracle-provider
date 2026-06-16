import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth-api-key";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOracleAuthenticationDetailsProvider,
  ORACLE_PROFILE_ID,
  ORACLE_PROVIDER_ID,
  resolveOracleAuth,
  resolveStoredOracleAuth,
  runOracleAuthNonInteractive,
  validateOracleConfigFile,
} from "./oci-auth.js";

const oracleFixtureDirs: string[] = [];

function writeOracleConfigFixture(params?: { relativeKeyFile?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oracle-auth-"));
  oracleFixtureDirs.push(dir);

  const profile = "DEFAULT";
  const configFile = path.join(dir, "config");
  const keyFile = path.join(dir, "key.pem");
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
      `key_file=${params?.relativeKeyFile ? "./key.pem" : keyFile}`,
      `tenancy=${tenancyId}`,
      "region=us-chicago-1",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    configFile,
    keyFile,
    profile,
    tenancyId,
  };
}

afterEach(() => {
  for (const dir of oracleFixtureDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("validateOracleConfigFile", () => {
  it("accepts OCI configs whose key_file path is relative to the config file", () => {
    const fixture = writeOracleConfigFixture({ relativeKeyFile: true });

    expect(validateOracleConfigFile(fixture.configFile, fixture.profile)).toEqual({
      configFile: fixture.configFile,
      profile: fixture.profile,
      compartmentId: fixture.tenancyId,
      tenancyId: fixture.tenancyId,
    });
  });
});

describe("resolveOracleAuth", () => {
  it("treats an explicit blank compartment as a request to use tenancy fallback", () => {
    const fixture = writeOracleConfigFixture();
    const envCompartmentId = "ocid1.compartment.oc1..env";

    expect(
      resolveOracleAuth({
        configFile: fixture.configFile,
        profile: fixture.profile,
        env: { OCI_COMPARTMENT_ID: envCompartmentId },
      }).compartmentId,
    ).toBe(envCompartmentId);

    expect(
      resolveOracleAuth({
        configFile: fixture.configFile,
        profile: fixture.profile,
        compartmentId: "",
        env: { OCI_COMPARTMENT_ID: envCompartmentId },
      }).compartmentId,
    ).toBe(fixture.tenancyId);
  });
});

describe("resolveStoredOracleAuth", () => {
  it("keeps stored profiles on tenancy fallback instead of restoring OCI_COMPARTMENT_ID", () => {
    const fixture = writeOracleConfigFixture();
    const agentDir = path.join(path.dirname(fixture.configFile), "agent");
    const previousCompartmentId = process.env.OCI_COMPARTMENT_ID;

    upsertAuthProfile({
      agentDir,
      profileId: ORACLE_PROFILE_ID,
      credential: {
        type: "api_key",
        provider: ORACLE_PROVIDER_ID,
        key: fixture.configFile,
        metadata: {
          profile: fixture.profile,
          tenancyId: fixture.tenancyId,
        },
      },
    });

    process.env.OCI_COMPARTMENT_ID = "ocid1.compartment.oc1..env";
    try {
      expect(resolveStoredOracleAuth({ agentDir })).toEqual({
        configFile: fixture.configFile,
        profile: fixture.profile,
        compartmentId: fixture.tenancyId,
        tenancyId: fixture.tenancyId,
      });
    } finally {
      if (previousCompartmentId === undefined) {
        delete process.env.OCI_COMPARTMENT_ID;
      } else {
        process.env.OCI_COMPARTMENT_ID = previousCompartmentId;
      }
    }
  });
});

describe("createOracleAuthenticationDetailsProvider", () => {
  it("loads the private key from a relative key_file path", () => {
    const fixture = writeOracleConfigFixture({ relativeKeyFile: true });

    const provider = createOracleAuthenticationDetailsProvider({
      configFile: fixture.configFile,
      profile: fixture.profile,
    });

    expect(provider.getTenantId()).toBe(fixture.tenancyId);
    expect(provider.getPrivateKey()).toContain("BEGIN PRIVATE KEY");
  });
});

describe("runOracleAuthNonInteractive", () => {
  it("lets an empty compartment option clear back to tenancy fallback", async () => {
    const fixture = writeOracleConfigFixture();
    const agentDir = path.join(path.dirname(fixture.configFile), "agent");
    const previousCompartmentId = process.env.OCI_COMPARTMENT_ID;

    process.env.OCI_COMPARTMENT_ID = "ocid1.compartment.oc1..env";
    try {
      await runOracleAuthNonInteractive({
        authChoice: "oracle-oci-config",
        config: {},
        baseConfig: {},
        opts: {
          oracleConfigFile: fixture.configFile,
          oracleProfile: fixture.profile,
          oracleCompartmentId: "",
        },
        runtime: {} as never,
        agentDir,
        resolveApiKey: async () => null,
        toApiKeyCredential: () => null,
      } as never);

      expect(ensureAuthProfileStore(agentDir).profiles[ORACLE_PROFILE_ID]).toMatchObject({
        provider: ORACLE_PROVIDER_ID,
        key: fixture.configFile,
        metadata: {
          profile: fixture.profile,
          compartmentId: fixture.tenancyId,
          tenancyId: fixture.tenancyId,
        },
      });
    } finally {
      if (previousCompartmentId === undefined) {
        delete process.env.OCI_COMPARTMENT_ID;
      } else {
        process.env.OCI_COMPARTMENT_ID = previousCompartmentId;
      }
    }
  });
});
