#!/usr/bin/env node

/**
 * TACo Stress Test Tool
 *
 * Tests TACo signing performance at various request rates to identify
 * bottlenecks and validate efficiency improvements.
 *
 * Usage:
 *   npx tsx scripts/stress-test.ts --config=stress-test.config.yml
 *   npx tsx scripts/stress-test.ts --config=stress-test.config.yml --mode=sweep
 *   npx tsx scripts/stress-test.ts --config=stress-test.config.yml --rate=5 --duration=120
 */

import { initialize } from "@nucypher/taco";
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { createPublicClient, encodeFunctionData, http, Address } from "viem";
import {
  createBundlerClient,
  createPaymasterClient,
} from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";

import { SigningCoordinatorAgent } from "@nucypher/shared";
import {
  conditions,
  domains,
  Domain,
  signUserOp,
  UserOperationToSign,
} from "@nucypher/taco";
import {
  Implementation,
  toMetaMaskSmartAccount,
} from "@metamask/delegation-toolkit";
import { createViemTacoAccount } from "../src/taco-account";

// =============================================================================
// Configuration (duplicated to avoid importing from src/index.ts which has side effects)
// =============================================================================

const BASE_SEPOLIA_CHAIN_ID = 84532;
const TACO_DOMAIN: Domain =
  (process.env.TACO_DOMAIN as Domain) || domains.DEVNET;
const COHORT_ID = parseInt(process.env.COHORT_ID || "3", 10);
const SIGNING_COORDINATOR_CHILD_ADDRESS =
  "0xcc537b292d142dABe2424277596d8FFCC3e6A12D";
const AA_VERSION = "mdt";

const TOKEN_ADDRESSES: Record<string, Address> = {
  USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

dotenv.config();

// =============================================================================
// TACo Helper Functions
// =============================================================================

async function createTacoSmartAccount(
  publicClient: any,
  signingCoordinatorProvider: ethers.providers.JsonRpcProvider,
  signingChainProvider: ethers.providers.JsonRpcProvider,
  deploySalt: `0x${string}` = "0x",
) {
  const coordinator = new ethers.Contract(
    SIGNING_COORDINATOR_CHILD_ADDRESS,
    ["function cohortMultisigs(uint32) view returns (address)"],
    signingChainProvider,
  );
  const cohortMultisigAddress = await coordinator.cohortMultisigs(COHORT_ID);

  const participants = await SigningCoordinatorAgent.getParticipants(
    signingCoordinatorProvider,
    TACO_DOMAIN,
    COHORT_ID,
  );
  const threshold = await SigningCoordinatorAgent.getThreshold(
    signingCoordinatorProvider,
    TACO_DOMAIN,
    COHORT_ID,
  );
  const signers = participants.map((p) => p.signerAddress as Address);

  const tacoAccount = createViemTacoAccount(cohortMultisigAddress as Address);

  const smartAccount = await (toMetaMaskSmartAccount as any)({
    client: publicClient,
    implementation: Implementation.MultiSig,
    deployParams: [signers, BigInt(threshold)],
    deploySalt,
    signatory: [{ account: tacoAccount }],
  });

  return { smartAccount, threshold, signers, cohortMultisigAddress };
}

async function deriveDiscordUserAA(
  publicClient: any,
  signingCoordinatorProvider: ethers.providers.JsonRpcProvider,
  signingChainProvider: ethers.providers.JsonRpcProvider,
  discordUserId: string,
): Promise<Address> {
  const salt = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(`${discordUserId}|Discord|Collab.Land`),
  ) as `0x${string}`;

  const { smartAccount } = await createTacoSmartAccount(
    publicClient,
    signingCoordinatorProvider,
    signingChainProvider,
    salt,
  );

  return smartAccount.address;
}

async function signUserOpWithTaco(
  userOp: Record<string, unknown>,
  provider: ethers.providers.JsonRpcProvider,
  discordContext: {
    timestamp: string;
    signature: string;
    payload: string;
  },
) {
  const signingContext =
    await conditions.context.ConditionContext.forSigningCohort(
      provider,
      TACO_DOMAIN,
      COHORT_ID,
      BASE_SEPOLIA_CHAIN_ID,
    );

  (signingContext as any).customContextParameters = {
    ":timestamp": discordContext.timestamp,
    ":signature": discordContext.signature,
    ":discordPayload": discordContext.payload,
  };

  const startTime = Date.now();
  const result = await signUserOp(
    provider,
    TACO_DOMAIN,
    COHORT_ID,
    BASE_SEPOLIA_CHAIN_ID,
    userOp as UserOperationToSign,
    AA_VERSION,
    signingContext,
  );
  const signingTimeMs = Date.now() - startTime;

  return { ...result, signingTimeMs };
}

// =============================================================================
// Types
// =============================================================================

interface Payload {
  name?: string;
  timestamp: string;
  signature: string;
  recipientUserId: string;
  body?: Record<string, unknown>;
  bodyJson?: string;
}

interface ConfigDefaults {
  mode?: "steady" | "burst" | "sweep";
  duration?: number;
  rates?: number[];
  rate?: number;
  requests?: number;
  burstSizes?: number[];
  batchesPerBurst?: number;
}

interface Config {
  defaults?: ConfigDefaults;
  payloads: Payload[];
}

interface CLIOptions {
  config: string;
  mode?: "steady" | "burst" | "sweep";
  rate?: number;
  duration?: number;
  requests?: number;
  rates?: number[];
  output?: string;
}

interface RequestResult {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  success: boolean;
  error?: string;
  tacoSigningTimeMs?: number;
}

interface Stats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  stdDev: number;
}

interface RunResult {
  mode: "steady" | "burst";
  // For steady mode: target requests per second
  // For burst mode: burst size (concurrent requests per batch)
  targetRate: number;
  duration: number;
  requests: {
    total: number;
    success: number;
    failed: number;
  };
  latency: Stats;
  tacoSigningTime: Stats | null;
  errors: string[];
}

// =============================================================================
// YAML Parser (minimal, no external dependency)
// =============================================================================

function parseYAML(content: string): Config {
  const lines = content.split("\n");
  const result: Record<string, unknown> = {};
  const stack: {
    indent: number;
    obj: Record<string, unknown>;
    key?: string;
  }[] = [{ indent: -1, obj: result }];
  let currentArray: unknown[] | null = null;
  let currentArrayKey: string | null = null;
  let inMultilineObject = false;
  let multilineIndent = 0;
  let currentPayload: Record<string, unknown> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.search(/\S/);

    if (trimmed.startsWith("- ")) {
      const content = trimmed.slice(2);

      if (currentArrayKey === "payloads") {
        if (Object.keys(currentPayload).length > 0) {
          (result.payloads as unknown[]).push(currentPayload);
        }
        currentPayload = {};
        inMultilineObject = true;
        multilineIndent = indent;

        if (content.includes(":")) {
          const [key, ...valueParts] = content.split(":");
          const value = valueParts.join(":").trim();
          if (value) {
            currentPayload[key.trim()] = parseValue(value);
          }
        }
        continue;
      }

      if (currentArray) {
        if (content.startsWith("[") && content.endsWith("]")) {
          currentArray.push(parseInlineArray(content));
        } else {
          currentArray.push(parseValue(content));
        }
      }
      continue;
    }

    if (inMultilineObject && indent > multilineIndent) {
      if (trimmed.includes(":")) {
        const colonIndex = trimmed.indexOf(":");
        const key = trimmed.slice(0, colonIndex).trim();
        const value = trimmed.slice(colonIndex + 1).trim();

        if (value) {
          currentPayload[key] = parseValue(value);
        }
      }
      continue;
    }

    if (inMultilineObject && indent <= multilineIndent) {
      if (Object.keys(currentPayload).length > 0) {
        (result.payloads as unknown[]).push(currentPayload);
        currentPayload = {};
      }
      inMultilineObject = false;
    }

    if (trimmed.includes(":")) {
      const colonIndex = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();

      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1].obj;

      if (!value) {
        if (key === "payloads") {
          result.payloads = [];
          currentArray = result.payloads as unknown[];
          currentArrayKey = "payloads";
        } else {
          parent[key] = {};
          stack.push({ indent, obj: parent[key] as Record<string, unknown> });
        }
      } else if (value.startsWith("[") && value.endsWith("]")) {
        parent[key] = parseInlineArray(value);
      } else {
        parent[key] = parseValue(value);
      }
    }
  }

  if (Object.keys(currentPayload).length > 0) {
    if (!result.payloads) result.payloads = [];
    (result.payloads as unknown[]).push(currentPayload);
  }

  return result as unknown as Config;
}

function parseValue(value: string): string | number | boolean {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;
  return value;
}

function parseInlineArray(value: string): (string | number)[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => {
    const trimmed = item.trim();
    const num = Number(trimmed);
    return isNaN(num) ? trimmed : num;
  });
}

// =============================================================================
// CLI Parsing
// =============================================================================

function parseArgs(args: string[]): CLIOptions {
  const options: CLIOptions = { config: "" };

  for (const arg of args) {
    if (arg.startsWith("--config=")) {
      options.config = arg.slice(9);
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice(7) as "steady" | "burst" | "sweep";
    } else if (arg.startsWith("--rate=")) {
      options.rate = parseFloat(arg.slice(7));
    } else if (arg.startsWith("--duration=")) {
      options.duration = parseInt(arg.slice(11), 10);
    } else if (arg.startsWith("--requests=")) {
      options.requests = parseInt(arg.slice(11), 10);
    } else if (arg.startsWith("--rates=")) {
      options.rates = arg
        .slice(8)
        .split(",")
        .map((r) => parseFloat(r.trim()));
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice(9);
    }
  }

  return options;
}

function loadConfig(cliOptions: CLIOptions): {
  config: Config;
  mode: "steady" | "burst" | "sweep";
  rate: number;
  duration: number;
  requests?: number;
  rates: number[];
  burstSizes: number[];
  batchesPerBurst: number;
  output?: string;
} {
  if (!cliOptions.config) {
    console.error("Error: --config=<file> is required");
    process.exit(1);
  }

  const configPath = path.resolve(process.cwd(), cliOptions.config);
  if (!fs.existsSync(configPath)) {
    console.error(`Error: Config file not found: ${configPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(configPath, "utf-8");
  const config = parseYAML(content);

  if (!config.payloads || config.payloads.length === 0) {
    console.error("Error: Config must contain at least one payload");
    process.exit(1);
  }

  const configDefaults = config.defaults || {};

  const mode = cliOptions.mode || configDefaults.mode || "steady";
  const rate = cliOptions.rate ?? configDefaults.rate ?? 1;
  const duration = cliOptions.duration ?? configDefaults.duration ?? 60;
  const requests = cliOptions.requests ?? configDefaults.requests;
  const rates = cliOptions.rates || configDefaults.rates || [0.5, 1, 3, 5, 10];
  const burstSizes = configDefaults.burstSizes || [1, 3, 5, 10];
  const batchesPerBurst = configDefaults.batchesPerBurst || 10;

  return {
    config,
    mode: mode as "steady" | "burst" | "sweep",
    rate,
    duration,
    requests,
    rates,
    burstSizes,
    batchesPerBurst,
    output: cliOptions.output,
  };
}

// =============================================================================
// Global State
// =============================================================================

let signingCoordinatorProvider: ethers.providers.JsonRpcProvider;
let signingChainProvider: ethers.providers.JsonRpcProvider;
let publicClient: any;
let bundlerClient: any;
let initialized = false;

async function initializeClients(): Promise<void> {
  if (initialized) return;

  console.log("[stress-test] Initializing...");
  await initialize();

  signingCoordinatorProvider = new ethers.providers.JsonRpcProvider(
    process.env.ETH_RPC_URL!,
  );
  signingChainProvider = new ethers.providers.JsonRpcProvider(
    process.env.SIGNING_CHAIN_RPC_URL!,
  );
  publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.SIGNING_CHAIN_RPC_URL),
  });

  const paymasterClient = createPaymasterClient({
    transport: http(process.env.BUNDLER_URL),
  });
  bundlerClient = createBundlerClient({
    transport: http(process.env.BUNDLER_URL),
    paymaster: paymasterClient,
    chain: baseSepolia,
  });

  console.log("[stress-test] Initialized");
  initialized = true;
}

// =============================================================================
// Request Executor
// =============================================================================

const REQUEST_TIMEOUT_MS = 60_000; // 60 second timeout per request

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeoutId),
  );
}

async function executeSigningRequest(payload: Payload): Promise<RequestResult> {
  const startTime = Date.now();

  // Wrap the entire execution in a timeout
  return withTimeout(
    executeSigningRequestInner(payload, startTime),
    REQUEST_TIMEOUT_MS,
    `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
  ).catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      duration: Date.now() - startTime,
      startTime,
      endTime: Date.now(),
      error: `[timeout] ${errorMessage}`,
      index: 0,
    };
  });
}

async function executeSigningRequestInner(
  payload: Payload,
  startTime: number,
): Promise<RequestResult> {
  let tacoSigningTimeMs: number | undefined;
  let phase = "init";

  try {
    // Parse body
    phase = "parse-payload";
    const body = payload.bodyJson ? JSON.parse(payload.bodyJson) : payload.body;
    if (!body) {
      throw new Error("Payload must have either 'body' or 'bodyJson'");
    }

    const senderDiscordId = String(body?.member?.user?.id || "");
    if (!senderDiscordId) {
      throw new Error("Missing member.user.id in payload body");
    }

    // Extract transfer parameters
    const executeCmd = body?.data?.options?.find(
      (o: any) => o?.name === "execute",
    );
    const opts = executeCmd?.options || [];
    const amountOpt = opts.find((o: any) => o?.name === "amount")?.value;
    const tokenOpt = opts.find((o: any) => o?.name === "token")?.value;
    const tokenType = String(tokenOpt ?? "ETH").toUpperCase();

    // Create smart account for sender
    phase = "create-smart-account";
    const senderSalt = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(`${senderDiscordId}|Discord|Collab.Land`),
    ) as `0x${string}`;

    const { smartAccount } = await createTacoSmartAccount(
      publicClient,
      signingCoordinatorProvider,
      signingChainProvider,
      senderSalt,
    );

    // Derive recipient address
    phase = "derive-recipient";
    const recipientAA = await deriveDiscordUserAA(
      publicClient,
      signingCoordinatorProvider,
      signingChainProvider,
      payload.recipientUserId,
    );

    // Parse amount
    phase = "build-userop";
    const amountStr = String(amountOpt ?? "0.0001");
    const tokenDecimals = tokenType === "USDC" ? 6 : 18;
    const transferAmount = ethers.utils.parseUnits(amountStr, tokenDecimals);

    // Build calls array
    const tokenAddress = TOKEN_ADDRESSES[tokenType];
    const calls: Array<{ to: Address; value: bigint; data?: `0x${string}` }> =
      tokenAddress
        ? [
            {
              to: tokenAddress,
              value: 0n,
              data: encodeFunctionData({
                abi: ERC20_TRANSFER_ABI,
                functionName: "transfer",
                args: [recipientAA, BigInt(transferAmount.toString())],
              }),
            },
          ]
        : [
            {
              to: recipientAA,
              value: BigInt(transferAmount.toString()),
            },
          ];

    // Prepare UserOp using bundler
    phase = "prepare-userop";
    const userOp = await bundlerClient.prepareUserOperation({
      account: smartAccount,
      calls,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 3_000_000_000n,
      verificationGasLimit: BigInt(500_000),
    });

    // Build Discord context
    const bodyString = payload.bodyJson || JSON.stringify(payload.body);
    const discordContext = {
      timestamp: payload.timestamp,
      signature: payload.signature.replace(/^0x/, ""),
      payload: bodyString,
    };

    // Sign with TACo
    phase = "taco-signing";
    const tacoStartTime = Date.now();
    await signUserOpWithTaco(
      userOp,
      signingCoordinatorProvider,
      discordContext,
    );
    tacoSigningTimeMs = Date.now() - tacoStartTime;

    const endTime = Date.now();
    return {
      index: 0,
      startTime,
      endTime,
      duration: endTime - startTime,
      success: true,
      tacoSigningTimeMs,
    };
  } catch (error) {
    const endTime = Date.now();
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      index: 0,
      startTime,
      endTime,
      duration: endTime - startTime,
      success: false,
      error: `[${phase}] ${errorMessage}`,
      tacoSigningTimeMs,
    };
  }
}

// =============================================================================
// Statistics
// =============================================================================

function calculateStats(values: number[]): Stats {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0, stdDev: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;

  const squaredDiffs = sorted.map((v) => Math.pow(v - mean, 2));
  const avgSquaredDiff =
    squaredDiffs.reduce((a, b) => a + b, 0) / sorted.length;
  const stdDev = Math.sqrt(avgSquaredDiff);

  const percentile = (p: number) => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  };

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(mean),
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    stdDev: Math.round(stdDev),
  };
}

// =============================================================================
// Rate Controllers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSteadyMode(
  payloads: Payload[],
  rate: number,
  duration: number,
  requestCount?: number,
): Promise<RequestResult[]> {
  const intervalMs = 1000 / rate;
  const totalRequests = requestCount ?? Math.floor(duration * rate);
  let payloadIndex = 0;
  let completedCount = 0;

  console.log(
    `[stress-test] Starting steady mode: ${rate} RPS, ${totalRequests} requests`,
  );

  const startTime = Date.now();
  const pendingRequests: Promise<RequestResult>[] = [];

  // Fire requests at the target rate (don't wait for completion)
  for (let i = 0; i < totalRequests; i++) {
    const payload = payloads[payloadIndex % payloads.length];
    payloadIndex++;
    const requestIndex = i;

    // Fire the request (don't await)
    const requestPromise = executeSigningRequest(payload).then((result) => {
      result.index = requestIndex;
      completedCount++;

      // Progress update on completion
      const elapsed = (Date.now() - startTime) / 1000;
      const inFlight = pendingRequests.length - completedCount;
      console.log(
        `[${elapsed.toFixed(0).padStart(3, "0")}s] Completed ${completedCount}/${totalRequests} | ` +
          `in-flight: ${inFlight} | ` +
          `${result.success ? "ok" : "FAIL"} ${result.duration}ms` +
          (result.tacoSigningTimeMs
            ? ` | taco: ${result.tacoSigningTimeMs}ms`
            : ""),
      );

      return result;
    });

    pendingRequests.push(requestPromise);

    // Wait for next interval before firing the next request
    if (i < totalRequests - 1) {
      const elapsed = Date.now() - startTime;
      const expectedElapsed = (i + 1) * intervalMs;
      const waitTime = Math.max(0, expectedElapsed - elapsed);
      if (waitTime > 0) {
        await sleep(waitTime);
      }
    }
  }

  // Wait for all requests to complete
  console.log(
    `[stress-test] All ${totalRequests} requests fired, waiting for completion...`,
  );
  const results = await Promise.all(pendingRequests);

  return results;
}

async function runBurstMode(
  payloads: Payload[],
  burstSize: number,
  totalBatches: number,
): Promise<RequestResult[]> {
  const results: RequestResult[] = [];
  const totalRequests = totalBatches * burstSize;
  let payloadIndex = 0;
  let requestIndex = 0;

  console.log(
    `[stress-test] Starting burst mode: size=${burstSize}, batches=${totalBatches}`,
  );

  const startTime = Date.now();

  for (let batch = 0; batch < totalBatches; batch++) {
    const batchPromises: Promise<RequestResult>[] = [];
    const currentBatchSize = Math.min(burstSize, totalRequests - requestIndex);

    for (let i = 0; i < currentBatchSize; i++) {
      const payload = payloads[payloadIndex % payloads.length];
      payloadIndex++;
      const idx = requestIndex++;
      batchPromises.push(
        executeSigningRequest(payload).then((r) => ({ ...r, index: idx })),
      );
    }

    // Wait for ALL requests in this batch to complete before next batch
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Progress update
    const elapsed = (Date.now() - startTime) / 1000;
    const successCount = results.filter((r) => r.success).length;
    const avgDuration =
      results.reduce((a, r) => a + r.duration, 0) / results.length;
    const tacoResults = results.filter((r) => r.tacoSigningTimeMs);
    const avgTaco =
      tacoResults.length > 0
        ? tacoResults.reduce((a, r) => a + (r.tacoSigningTimeMs || 0), 0) /
          tacoResults.length
        : 0;

    console.log(
      `[${elapsed.toFixed(0).padStart(3, "0")}s] Batch ${batch + 1}/${totalBatches} | ` +
        `${results.length}/${totalRequests} requests | ` +
        `${successCount} ok, ${results.length - successCount} fail | ` +
        `avg: ${(avgDuration / 1000).toFixed(2)}s | taco: ${(avgTaco / 1000).toFixed(2)}s`,
    );
  }

  return results;
}

// =============================================================================
// Reporter
// =============================================================================

function formatStats(stats: Stats, unit: string = "ms"): string {
  return (
    `    Min:    ${stats.min.toLocaleString()} ${unit}\n` +
    `    Max:    ${stats.max.toLocaleString()} ${unit}\n` +
    `    Mean:   ${stats.mean.toLocaleString()} ${unit}\n` +
    `    p50:    ${stats.p50.toLocaleString()} ${unit}\n` +
    `    p95:    ${stats.p95.toLocaleString()} ${unit}\n` +
    `    p99:    ${stats.p99.toLocaleString()} ${unit}\n` +
    `    StdDev: ${stats.stdDev.toLocaleString()} ${unit}`
  );
}

function printResults(
  results: RequestResult[],
  mode: string,
  rate: number,
): RunResult {
  const totalDuration =
    (results[results.length - 1].endTime - results[0].startTime) / 1000;
  const successResults = results.filter((r) => r.success);
  const failedResults = results.filter((r) => !r.success);

  const latencies = results.map((r) => r.duration);
  const latencyStats = calculateStats(latencies);

  const tacoTimes = results
    .filter((r) => r.tacoSigningTimeMs !== undefined)
    .map((r) => r.tacoSigningTimeMs!);
  const tacoStats = tacoTimes.length > 0 ? calculateStats(tacoTimes) : null;

  const errors = failedResults.map((r) => r.error || "Unknown error");
  const uniqueErrors = [...new Set(errors)];

  console.log("\n" + "=".repeat(60));
  console.log("                    STRESS TEST RESULTS");
  console.log("=".repeat(60));
  console.log();
  const modeLabel =
    mode === "burst" ? `Burst size: ${rate}` : `Rate: ${rate} RPS`;
  console.log(
    `Mode: ${mode} | ${modeLabel} | Duration: ${totalDuration.toFixed(1)}s`,
  );
  console.log();
  console.log("REQUESTS");
  console.log(`    Total:       ${results.length} requests`);
  console.log(
    `    Success:     ${successResults.length} (${((successResults.length / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `    Failed:      ${failedResults.length} (${((failedResults.length / results.length) * 100).toFixed(1)}%)`,
  );
  console.log();
  console.log("LATENCY");
  console.log(formatStats(latencyStats));

  if (tacoStats) {
    console.log();
    console.log("TACO SIGNING TIME");
    console.log(formatStats(tacoStats));
  }

  if (uniqueErrors.length > 0) {
    console.log();
    console.log("ERRORS");
    for (const err of uniqueErrors.slice(0, 5)) {
      const count = errors.filter((e) => e === err).length;
      const shortErr = err.length > 60 ? err.slice(0, 60) + "..." : err;
      console.log(`    [${count}x] ${shortErr}`);
    }
    if (uniqueErrors.length > 5) {
      console.log(`    ... and ${uniqueErrors.length - 5} more unique errors`);
    }
  }

  console.log();
  console.log("=".repeat(60));

  return {
    mode: mode as "steady" | "burst",
    targetRate: rate,
    duration: Math.round(totalDuration * 10) / 10,
    requests: {
      total: results.length,
      success: successResults.length,
      failed: failedResults.length,
    },
    latency: latencyStats,
    tacoSigningTime: tacoStats,
    errors: uniqueErrors,
  };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));

  if (!cliOptions.config) {
    console.log(`
TACo Stress Test Tool

Usage:
  npx tsx scripts/stress-test.ts --config=<file.yml> [options]

Options:
  --config=<file>     Config file with payloads and defaults (required)
  --mode=<mode>       steady, burst, or sweep (default: steady)
  --rate=<n>          Requests per second for steady / burst size for burst (default: 1)
  --duration=<sec>    Duration per rate level for steady mode (default: 60)
  --requests=<n>      Fixed request count (overrides duration)
  --rates=<list>      Comma-separated rates for sweep mode steady tests
  --output=<file>     Save report to file (.html for interactive report, .json for data)

Modes:
  steady    Fire requests at a fixed rate (e.g., 1 RPS = 1 request every 1s)
  burst     Fire N requests simultaneously, wait for all to complete, repeat
  sweep     Run all steady rate tests, then all burst size tests (recommended)

Examples:
  npx tsx scripts/stress-test.ts --config=stress-test.config.yml --mode=sweep --output=report.html
  npx tsx scripts/stress-test.ts --config=stress-test.config.yml --mode=steady --rate=5 --duration=120
  npx tsx scripts/stress-test.ts --config=stress-test.config.yml --mode=burst --rate=10
`);
    process.exit(1);
  }

  const {
    config,
    mode,
    rate,
    duration,
    requests,
    rates,
    burstSizes,
    batchesPerBurst,
    output,
  } = loadConfig(cliOptions);

  console.log("[stress-test] TACo Stress Test Tool");
  console.log(`[stress-test] Config: ${cliOptions.config}`);
  console.log(`[stress-test] Mode: ${mode}`);
  console.log(`[stress-test] Payloads: ${config.payloads.length}`);

  await initializeClients();

  const steadyResults: RunResult[] = [];
  const burstResults: RunResult[] = [];

  if (mode === "sweep") {
    console.log(`\n[stress-test] Starting sweep mode`);
    console.log(`[stress-test] Steady rates: ${rates.join(", ")} RPS`);
    console.log(`[stress-test] Burst sizes: ${burstSizes.join(", ")}`);
    console.log(`[stress-test] Duration per steady rate: ${duration}s`);
    console.log(`[stress-test] Batches per burst size: ${batchesPerBurst}\n`);

    // Run all steady rate tests first
    console.log("\n" + "=".repeat(60));
    console.log("              STEADY RATE TESTS");
    console.log("=".repeat(60));

    for (const testRate of rates) {
      console.log(`\n${"─".repeat(60)}`);
      console.log(`Steady @ ${testRate} RPS`);
      console.log("─".repeat(60));
      const results = await runSteadyMode(
        config.payloads,
        testRate,
        duration,
        requests,
      );
      steadyResults.push(printResults(results, "steady", testRate));

      if (testRate !== rates[rates.length - 1]) {
        console.log("\n[stress-test] Pausing 10s before next rate...\n");
        await sleep(10000);
      }
    }

    // Then run all burst tests
    console.log("\n\n" + "=".repeat(60));
    console.log("              BURST SIZE TESTS");
    console.log("=".repeat(60));

    for (const burstSize of burstSizes) {
      console.log(`\n${"─".repeat(60)}`);
      console.log(`Burst size ${burstSize} (${batchesPerBurst} batches)`);
      console.log("─".repeat(60));
      const results = await runBurstMode(
        config.payloads,
        burstSize,
        batchesPerBurst,
      );
      burstResults.push(printResults(results, "burst", burstSize));

      if (burstSize !== burstSizes[burstSizes.length - 1]) {
        console.log("\n[stress-test] Pausing 10s before next burst size...\n");
        await sleep(10000);
      }
    }

    // Summary
    console.log("\n\n" + "=".repeat(60));
    console.log("                    SWEEP SUMMARY");
    console.log("=".repeat(60));

    console.log("\nSteady Rate Results:");
    console.log("Rate (RPS) | Requests | Success % | Latency p50 | TACo p50");
    console.log("-".repeat(65));
    for (const r of steadyResults) {
      const successPct = (
        (r.requests.success / r.requests.total) *
        100
      ).toFixed(1);
      const tacoP50 = r.tacoSigningTime ? `${r.tacoSigningTime.p50}ms` : "N/A";
      console.log(
        `${r.targetRate.toString().padStart(10)} | ` +
          `${r.requests.total.toString().padStart(8)} | ${successPct.padStart(9)}% | ` +
          `${(r.latency.p50 + "ms").padStart(11)} | ${tacoP50.padStart(8)}`,
      );
    }

    console.log("\nBurst Size Results:");
    console.log("Burst Size | Total Reqs | Success % | Latency p50 | TACo p50");
    console.log("-".repeat(65));
    for (const r of burstResults) {
      const successPct = (
        (r.requests.success / r.requests.total) *
        100
      ).toFixed(1);
      const tacoP50 = r.tacoSigningTime ? `${r.tacoSigningTime.p50}ms` : "N/A";
      console.log(
        `${r.targetRate.toString().padStart(10)} | ` +
          `${r.requests.total.toString().padStart(10)} | ${successPct.padStart(9)}% | ` +
          `${(r.latency.p50 + "ms").padStart(11)} | ${tacoP50.padStart(8)}`,
      );
    }
    console.log();
  } else if (mode === "burst") {
    const burstSize = rate; // Use rate as burst size for single burst mode
    const results = await runBurstMode(
      config.payloads,
      burstSize,
      batchesPerBurst,
    );
    burstResults.push(printResults(results, "burst", burstSize));
  } else {
    const results = await runSteadyMode(
      config.payloads,
      rate,
      duration,
      requests,
    );
    steadyResults.push(printResults(results, "steady", rate));
  }

  const allResults = [...steadyResults, ...burstResults];

  // Save report
  if (output) {
    const totalRequests = allResults.reduce((a, r) => a + r.requests.total, 0);
    const totalSuccess = allResults.reduce((a, r) => a + r.requests.success, 0);
    const overallSuccessRate = (totalSuccess / totalRequests) * 100;

    if (output.endsWith(".json")) {
      // JSON report
      const report = {
        timestamp: new Date().toISOString(),
        config: { mode, rate, duration, rates, burstSizes, batchesPerBurst },
        steadyResults,
        burstResults,
        summary: { totalRequests, totalSuccess, overallSuccessRate },
      };
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
    } else {
      // HTML report with Chart.js
      const formatDuration = (ms: number): string => {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        const mins = Math.floor(ms / 60000);
        const secs = ((ms % 60000) / 1000).toFixed(0);
        return `${mins}m ${secs}s`;
      };

      // Collect all errors for the error section
      const allErrors: Array<{ source: string; errors: string[] }> = [];
      for (const r of steadyResults) {
        if (r.errors.length > 0) {
          allErrors.push({
            source: `Steady @ ${r.targetRate} RPS`,
            errors: r.errors,
          });
        }
      }
      for (const r of burstResults) {
        if (r.errors.length > 0) {
          allErrors.push({
            source: `Burst size ${r.targetRate}`,
            errors: r.errors,
          });
        }
      }

      // Group and count errors
      const groupErrors = (
        errors: string[],
      ): Map<string, { count: number; full: string }> => {
        const errorCounts = new Map<string, { count: number; full: string }>();
        for (const err of errors) {
          let errorType: string;
          if (err.includes("Threshold of signatures not met")) {
            errorType = "Threshold of signatures not met";
          } else if (
            err.includes("NETWORK_ERROR") ||
            err.includes("could not detect network")
          ) {
            errorType = "Network error (RPC overload)";
          } else if (err.includes("missing revert data")) {
            errorType = "Contract revert (missing revert data)";
          } else if (err.includes("timeout")) {
            errorType = "Request timeout";
          } else {
            // Extract phase from error if present
            const phaseMatch = err.match(/^\[([^\]]+)\]/);
            errorType = phaseMatch
              ? `[${phaseMatch[1]}] error`
              : err.slice(0, 60);
          }

          const existing = errorCounts.get(errorType);
          if (existing) {
            existing.count++;
          } else {
            errorCounts.set(errorType, { count: 1, full: err });
          }
        }
        return errorCounts;
      };

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TACo Stress Test Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg: #1a1a2e;
      --card-bg: #16213e;
      --text: #eee;
      --text-muted: #888;
      --accent: #4fc3f7;
      --success: #66bb6a;
      --warning: #ffa726;
      --error: #ef5350;
      --border: #333;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2rem;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.5rem; margin: 2rem 0 1rem; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
    h3 { font-size: 1.2rem; margin: 1.5rem 0 0.75rem; }
    .timestamp { color: var(--text-muted); margin-bottom: 2rem; }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .summary-card {
      background: var(--card-bg);
      border-radius: 8px;
      padding: 1.5rem;
      text-align: center;
    }
    .summary-card .value {
      font-size: 2rem;
      font-weight: bold;
      color: var(--accent);
    }
    .summary-card .label { color: var(--text-muted); font-size: 0.9rem; }
    .summary-card.success .value { color: var(--success); }
    .summary-card.warning .value { color: var(--warning); }
    .summary-card.error .value { color: var(--error); }
    .chart-container {
      background: var(--card-bg);
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .chart-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 1.5rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 1.5rem;
    }
    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th { background: rgba(79, 195, 247, 0.1); color: var(--accent); font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    tr:hover { background: rgba(255,255,255,0.02); }
    .error-section {
      background: var(--card-bg);
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1rem;
    }
    .error-type {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--border);
    }
    .error-type:last-child { border-bottom: none; }
    .error-count {
      background: var(--error);
      color: white;
      padding: 0.25rem 0.75rem;
      border-radius: 12px;
      font-size: 0.85rem;
      font-weight: bold;
    }
    .error-example {
      font-family: monospace;
      font-size: 0.8rem;
      color: var(--text-muted);
      background: rgba(0,0,0,0.2);
      padding: 0.5rem;
      margin-top: 0.5rem;
      border-radius: 4px;
      word-break: break-all;
      max-height: 100px;
      overflow-y: auto;
    }
    details { margin-bottom: 0.5rem; }
    summary { cursor: pointer; padding: 0.5rem 0; }
    summary:hover { color: var(--accent); }
    .glossary {
      background: var(--card-bg);
      border-radius: 8px;
      padding: 1.5rem;
      margin-top: 2rem;
    }
    .glossary dt { color: var(--accent); font-weight: 600; margin-top: 0.75rem; }
    .glossary dd { color: var(--text-muted); margin-left: 1rem; }
    .config-list { list-style: none; }
    .config-list li { padding: 0.25rem 0; }
    .config-list strong { color: var(--accent); }
  </style>
</head>
<body>
  <div class="container">
    <h1>TACo Stress Test Report</h1>
    <p class="timestamp">Generated: ${new Date().toISOString()}</p>

    <div class="summary-grid">
      <div class="summary-card">
        <div class="value">${totalRequests}</div>
        <div class="label">Total Requests</div>
      </div>
      <div class="summary-card success">
        <div class="value">${overallSuccessRate.toFixed(1)}%</div>
        <div class="label">Success Rate</div>
      </div>
      <div class="summary-card">
        <div class="value">${totalSuccess}</div>
        <div class="label">Successful</div>
      </div>
      <div class="summary-card ${totalRequests - totalSuccess > 0 ? "error" : ""}">
        <div class="value">${totalRequests - totalSuccess}</div>
        <div class="label">Failed</div>
      </div>
    </div>

    <h2>Configuration</h2>
    <ul class="config-list">
      <li><strong>Mode:</strong> ${mode}</li>
      <li><strong>Steady Rates:</strong> ${rates.join(", ")} RPS</li>
      <li><strong>Duration per Rate:</strong> ${duration}s</li>
      <li><strong>Burst Sizes:</strong> ${burstSizes.join(", ")}</li>
      <li><strong>Batches per Burst:</strong> ${batchesPerBurst}</li>
    </ul>

    ${
      steadyResults.length > 0
        ? `
    <h2>Steady Rate Tests</h2>
    <p style="color: var(--text-muted); margin-bottom: 1rem;">
      Tests sustained load by firing requests at fixed intervals. At higher rates, more requests will be in-flight concurrently
      since each TACo signing takes ~10s to complete.
    </p>

    <div class="chart-row">
      <div class="chart-container">
        <canvas id="steadySuccessChart"></canvas>
      </div>
      <div class="chart-container">
        <canvas id="steadyLatencyChart"></canvas>
      </div>
    </div>

    <h3>Detailed Results</h3>
    <table>
      <thead>
        <tr>
          <th>Request Rate</th>
          <th>Total Requests</th>
          <th>Success %</th>
          <th>Latency p50</th>
          <th>Latency p95</th>
          <th>TACo p50</th>
          <th>TACo p95</th>
        </tr>
      </thead>
      <tbody>
        ${steadyResults
          .map((r) => {
            const successPct = (
              (r.requests.success / r.requests.total) *
              100
            ).toFixed(1);
            return `<tr>
            <td>${r.targetRate} RPS</td>
            <td>${r.requests.total}</td>
            <td>${successPct}%</td>
            <td>${formatDuration(r.latency.p50)}</td>
            <td>${formatDuration(r.latency.p95)}</td>
            <td>${r.tacoSigningTime ? formatDuration(r.tacoSigningTime.p50) : "N/A"}</td>
            <td>${r.tacoSigningTime ? formatDuration(r.tacoSigningTime.p95) : "N/A"}</td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>
    `
        : ""
    }

    ${
      burstResults.length > 0
        ? `
    <h2>Burst Size Tests</h2>
    <p style="color: var(--text-muted); margin-bottom: 1rem;">
      Tests concurrent request handling by firing N requests simultaneously, waiting for all to complete, then repeating.
      This measures how the system handles spikes of concurrent load.
    </p>

    <div class="chart-row">
      <div class="chart-container">
        <canvas id="burstSuccessChart"></canvas>
      </div>
      <div class="chart-container">
        <canvas id="burstLatencyChart"></canvas>
      </div>
    </div>

    <h3>Detailed Results</h3>
    <table>
      <thead>
        <tr>
          <th>Burst Size</th>
          <th>Total Requests</th>
          <th>Batches</th>
          <th>Success %</th>
          <th>Latency p50</th>
          <th>Latency p95</th>
          <th>TACo p50</th>
          <th>TACo p95</th>
        </tr>
      </thead>
      <tbody>
        ${burstResults
          .map((r) => {
            const successPct = (
              (r.requests.success / r.requests.total) *
              100
            ).toFixed(1);
            const batches = r.requests.total / r.targetRate;
            return `<tr>
            <td>${r.targetRate}</td>
            <td>${r.requests.total}</td>
            <td>${batches}</td>
            <td>${successPct}%</td>
            <td>${formatDuration(r.latency.p50)}</td>
            <td>${formatDuration(r.latency.p95)}</td>
            <td>${r.tacoSigningTime ? formatDuration(r.tacoSigningTime.p50) : "N/A"}</td>
            <td>${r.tacoSigningTime ? formatDuration(r.tacoSigningTime.p95) : "N/A"}</td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>
    `
        : ""
    }

    ${
      allErrors.length > 0
        ? `
    <h2>Error Analysis</h2>
    ${allErrors
      .map(({ source, errors }) => {
        const grouped = groupErrors(errors);
        return `
      <div class="error-section">
        <h3>${source}</h3>
        ${Array.from(grouped.entries())
          .map(
            ([errorType, { count, full }]) => `
          <details>
            <summary class="error-type">
              <span>${errorType}</span>
              <span class="error-count">${count}</span>
            </summary>
            <div class="error-example">${full.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
          </details>
        `,
          )
          .join("")}
      </div>
    `;
      })
      .join("")}
    `
        : ""
    }

    <details class="glossary">
      <summary><h2 style="display: inline;">Glossary</h2></summary>
      <dl>
        <dt>Target RPS</dt>
        <dd>The rate at which new requests are initiated (e.g., 1 RPS = 1 new request every second)</dd>
        <dt>Burst Size</dt>
        <dd>Number of requests fired simultaneously in each batch</dd>
        <dt>Latency</dt>
        <dd>Total time from request start to completion (includes network, TACo signing, and all overhead)</dd>
        <dt>TACo Signing Time</dt>
        <dd>Time spent specifically in the TACo threshold signing operation</dd>
        <dt>p50 / p95 / p99</dt>
        <dd>Percentiles - p50 is median, p95 means 95% of requests were faster than this value</dd>
      </dl>
    </details>
  </div>

  <script>
    const steadyData = ${JSON.stringify(
      steadyResults.map((r) => ({
        rate: r.targetRate,
        successPct: (r.requests.success / r.requests.total) * 100,
        latencyP50: r.latency.p50,
        latencyP95: r.latency.p95,
        latencyP99: r.latency.p99,
        tacoP50: r.tacoSigningTime?.p50 || 0,
        tacoP95: r.tacoSigningTime?.p95 || 0,
      })),
    )};

    const burstData = ${JSON.stringify(
      burstResults.map((r) => ({
        size: r.targetRate,
        successPct: (r.requests.success / r.requests.total) * 100,
        latencyP50: r.latency.p50,
        latencyP95: r.latency.p95,
        latencyP99: r.latency.p99,
        tacoP50: r.tacoSigningTime?.p50 || 0,
        tacoP95: r.tacoSigningTime?.p95 || 0,
      })),
    )};

    const chartColors = {
      accent: '#4fc3f7',
      success: '#66bb6a',
      warning: '#ffa726',
      p50: '#4fc3f7',
      p95: '#ffa726',
      p99: '#ef5350',
    };

    // Steady Rate Charts
    if (steadyData.length > 0) {
      // Success Rate Chart
      new Chart(document.getElementById('steadySuccessChart'), {
        type: 'bar',
        data: {
          labels: steadyData.map(d => d.rate + ' RPS'),
          datasets: [{
            label: 'Success Rate %',
            data: steadyData.map(d => d.successPct),
            backgroundColor: steadyData.map(d => d.successPct >= 95 ? chartColors.success : d.successPct >= 80 ? chartColors.warning : chartColors.p99),
          }],
        },
        options: {
          responsive: true,
          plugins: {
            title: { display: true, text: 'Success Rate by Target RPS', color: '#eee' },
            legend: { display: false },
          },
          scales: {
            x: { ticks: { color: '#888' }, grid: { color: '#333' } },
            y: { ticks: { color: '#888' }, grid: { color: '#333' }, min: 0, max: 100, title: { display: true, text: 'Success %', color: '#888' } },
          },
        },
      });

      // Latency Chart
      new Chart(document.getElementById('steadyLatencyChart'), {
        type: 'line',
        data: {
          labels: steadyData.map(d => d.rate + ' RPS'),
          datasets: [
            {
              label: 'Latency p50',
              data: steadyData.map(d => d.latencyP50 / 1000),
              borderColor: chartColors.p50,
              fill: false,
              tension: 0.1,
            },
            {
              label: 'Latency p95',
              data: steadyData.map(d => d.latencyP95 / 1000),
              borderColor: chartColors.p95,
              fill: false,
              tension: 0.1,
            },
            {
              label: 'TACo p50',
              data: steadyData.map(d => d.tacoP50 / 1000),
              borderColor: chartColors.p50,
              borderDash: [5, 5],
              fill: false,
              tension: 0.1,
            },
            {
              label: 'TACo p95',
              data: steadyData.map(d => d.tacoP95 / 1000),
              borderColor: chartColors.p95,
              borderDash: [5, 5],
              fill: false,
              tension: 0.1,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: {
            title: { display: true, text: 'Latency by Target RPS (solid = total, dashed = TACo only)', color: '#eee' },
            legend: { labels: { color: '#eee' } },
          },
          scales: {
            x: { ticks: { color: '#888' }, grid: { color: '#333' } },
            y: { ticks: { color: '#888' }, grid: { color: '#333' }, title: { display: true, text: 'Seconds', color: '#888' } },
          },
        },
      });
    }

    // Burst Size Charts
    if (burstData.length > 0) {
      // Success Rate Chart
      new Chart(document.getElementById('burstSuccessChart'), {
        type: 'bar',
        data: {
          labels: burstData.map(d => 'Size ' + d.size),
          datasets: [{
            label: 'Success Rate %',
            data: burstData.map(d => d.successPct),
            backgroundColor: burstData.map(d => d.successPct >= 95 ? chartColors.success : d.successPct >= 80 ? chartColors.warning : chartColors.p99),
          }],
        },
        options: {
          responsive: true,
          plugins: {
            title: { display: true, text: 'Success Rate by Burst Size', color: '#eee' },
            legend: { display: false },
          },
          scales: {
            x: { ticks: { color: '#888' }, grid: { color: '#333' } },
            y: { ticks: { color: '#888' }, grid: { color: '#333' }, min: 0, max: 100, title: { display: true, text: 'Success %', color: '#888' } },
          },
        },
      });

      // Latency Chart
      new Chart(document.getElementById('burstLatencyChart'), {
        type: 'line',
        data: {
          labels: burstData.map(d => 'Size ' + d.size),
          datasets: [
            {
              label: 'Latency p50',
              data: burstData.map(d => d.latencyP50 / 1000),
              borderColor: chartColors.p50,
              fill: false,
              tension: 0.1,
            },
            {
              label: 'Latency p95',
              data: burstData.map(d => d.latencyP95 / 1000),
              borderColor: chartColors.p95,
              fill: false,
              tension: 0.1,
            },
            {
              label: 'TACo p50',
              data: burstData.map(d => d.tacoP50 / 1000),
              borderColor: chartColors.p50,
              borderDash: [5, 5],
              fill: false,
              tension: 0.1,
            },
            {
              label: 'TACo p95',
              data: burstData.map(d => d.tacoP95 / 1000),
              borderColor: chartColors.p95,
              borderDash: [5, 5],
              fill: false,
              tension: 0.1,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: {
            title: { display: true, text: 'Latency by Burst Size (solid = total, dashed = TACo only)', color: '#eee' },
            legend: { labels: { color: '#eee' } },
          },
          scales: {
            x: { ticks: { color: '#888' }, grid: { color: '#333' } },
            y: { ticks: { color: '#888' }, grid: { color: '#333' }, title: { display: true, text: 'Seconds', color: '#888' } },
          },
        },
      });
    }
  </script>
</body>
</html>`;

      fs.writeFileSync(output, html);
    }

    console.log(`[stress-test] Report saved to: ${output}`);
  }

  console.log("\n[stress-test] Done!");
}

main().catch((err) => {
  console.error("[stress-test] Fatal error:", err);
  process.exit(1);
});
