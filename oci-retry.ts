import {
  MaxAttemptsTerminationStrategy,
  OciSdkDefaultRetryConfiguration,
  type RetryConfiguration,
} from "oci-common";

const ORACLE_GENERATIVE_AI_MAX_ATTEMPTS = 4;

// Keep OCI's default retry condition and jittered backoff, but cap attempts
// so transient 429/5xx errors get another chance without stretching latency too far.
export const ORACLE_GENERATIVE_AI_RETRY_CONFIGURATION: RetryConfiguration = {
  ...OciSdkDefaultRetryConfiguration,
  terminationStrategy: new MaxAttemptsTerminationStrategy(ORACLE_GENERATIVE_AI_MAX_ATTEMPTS),
};
