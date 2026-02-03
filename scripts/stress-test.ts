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

interface Config {
  defaults: {
    mode: "steady" | "burst" | "sweep";
    duration: number;
    rates: number[];
    rate: number;
    requests?: number;
  };
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
  targetRate: number;
  actualRate: number;
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

  const defaults = config.defaults || {
    mode: "steady",
    duration: 60,
    rates: [0.5, 1, 3, 5, 10],
    rate: 1,
  };

  return {
    config,
    mode: cliOptions.mode || defaults.mode || "steady",
    rate: cliOptions.rate ?? defaults.rate ?? 1,
    duration: cliOptions.duration ?? defaults.duration ?? 60,
    requests: cliOptions.requests ?? defaults.requests,
    rates: cliOptions.rates || defaults.rates || [0.5, 1, 3, 5, 10],
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

async function executeSigningRequest(payload: Payload): Promise<RequestResult> {
  const startTime = Date.now();
  let tacoSigningTimeMs: number | undefined;

  try {
    // Parse body
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

    // Create smart account for sender (reusing main module function)
    const senderSalt = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(`${senderDiscordId}|Discord|Collab.Land`),
    ) as `0x${string}`;

    const { smartAccount } = await createTacoSmartAccount(
      publicClient,
      signingCoordinatorProvider,
      signingChainProvider,
      senderSalt,
    );

    // Derive recipient address (reusing main module function)
    const recipientAA = await deriveDiscordUserAA(
      publicClient,
      signingCoordinatorProvider,
      signingChainProvider,
      payload.recipientUserId,
    );

    // Parse amount
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

    // Sign with TACo (reusing main module function)
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
      error: errorMessage,
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
  rate: number,
  duration: number,
  requestCount?: number,
): Promise<RequestResult[]> {
  const results: RequestResult[] = [];
  const batchSize = Math.ceil(rate);
  const totalBatches = requestCount
    ? Math.ceil(requestCount / batchSize)
    : Math.floor(duration);
  const totalRequests = requestCount ?? totalBatches * batchSize;
  let payloadIndex = 0;
  let requestIndex = 0;

  console.log(
    `[stress-test] Starting burst mode: ${batchSize} concurrent, ${totalBatches} batches`,
  );

  const startTime = Date.now();

  for (let batch = 0; batch < totalBatches; batch++) {
    const batchStartTime = Date.now();
    const batchPromises: Promise<RequestResult>[] = [];
    const currentBatchSize = Math.min(batchSize, totalRequests - requestIndex);

    for (let i = 0; i < currentBatchSize; i++) {
      const payload = payloads[payloadIndex % payloads.length];
      payloadIndex++;
      const idx = requestIndex++;
      batchPromises.push(
        executeSigningRequest(payload).then((r) => ({ ...r, index: idx })),
      );
    }

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

    // Wait between batches
    if (batch < totalBatches - 1) {
      const batchDuration = Date.now() - batchStartTime;
      const waitTime = Math.max(0, 1000 - batchDuration);
      if (waitTime > 0) {
        await sleep(waitTime);
      }
    }
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
  const actualRate = results.length / totalDuration;

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
  console.log(
    `Mode: ${mode} | Rate: ${rate} RPS | Duration: ${totalDuration.toFixed(1)}s`,
  );
  console.log();
  console.log("THROUGHPUT");
  console.log(`    Target RPS:  ${rate.toFixed(2)}`);
  console.log(`    Actual RPS:  ${actualRate.toFixed(2)}`);
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
    actualRate: Math.round(actualRate * 100) / 100,
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
  --rate=<n>          Requests per second (default: 1)
  --duration=<sec>    Duration per rate level (default: 60)
  --requests=<n>      Fixed request count (overrides duration)
  --rates=<list>      Comma-separated rates for sweep mode
  --output=<file>     Save JSON report to file

Examples:
  npx tsx scripts/stress-test.ts --config=stress-test.config.yml
  npx tsx scripts/stress-test.ts --config=stress-test.config.yml --mode=sweep
  npx tsx scripts/stress-test.ts --config=stress-test.config.yml --rate=5 --duration=120
`);
    process.exit(1);
  }

  const { config, mode, rate, duration, requests, rates, output } =
    loadConfig(cliOptions);

  console.log("[stress-test] TACo Stress Test Tool");
  console.log(`[stress-test] Config: ${cliOptions.config}`);
  console.log(`[stress-test] Mode: ${mode}`);
  console.log(`[stress-test] Payloads: ${config.payloads.length}`);

  await initializeClients();

  const allResults: RunResult[] = [];

  if (mode === "sweep") {
    console.log(
      `\n[stress-test] Starting sweep mode with rates: ${rates.join(", ")}`,
    );
    console.log(`[stress-test] Duration per rate: ${duration}s`);
    console.log(`[stress-test] Modes: steady, burst\n`);

    for (const testRate of rates) {
      // Steady mode
      console.log(`\n${"=".repeat(60)}`);
      console.log(`SWEEP: steady @ ${testRate} RPS`);
      console.log("=".repeat(60));
      const steadyResults = await runSteadyMode(
        config.payloads,
        testRate,
        duration,
        requests,
      );
      allResults.push(printResults(steadyResults, "steady", testRate));

      console.log("\n[stress-test] Pausing 5s before next test...\n");
      await sleep(5000);

      // Burst mode
      console.log(`\n${"=".repeat(60)}`);
      console.log(`SWEEP: burst @ ${testRate} RPS`);
      console.log("=".repeat(60));
      const burstResults = await runBurstMode(
        config.payloads,
        testRate,
        duration,
        requests,
      );
      allResults.push(printResults(burstResults, "burst", testRate));

      if (testRate !== rates[rates.length - 1]) {
        console.log("\n[stress-test] Pausing 10s before next rate level...\n");
        await sleep(10000);
      }
    }

    // Summary
    console.log("\n\n" + "=".repeat(60));
    console.log("                    SWEEP SUMMARY");
    console.log("=".repeat(60));
    console.log();
    console.log(
      "Rate (RPS) | Mode   | Actual RPS | Success % | Latency p50 | TACo p50",
    );
    console.log("-".repeat(75));
    for (const r of allResults) {
      const successPct = (
        (r.requests.success / r.requests.total) *
        100
      ).toFixed(1);
      const tacoP50 = r.tacoSigningTime ? `${r.tacoSigningTime.p50}ms` : "N/A";
      console.log(
        `${r.targetRate.toString().padStart(10)} | ${r.mode.padEnd(6)} | ` +
          `${r.actualRate.toFixed(2).padStart(10)} | ${successPct.padStart(9)}% | ` +
          `${(r.latency.p50 + "ms").padStart(11)} | ${tacoP50.padStart(8)}`,
      );
    }
    console.log();
  } else {
    const results =
      mode === "burst"
        ? await runBurstMode(config.payloads, rate, duration, requests)
        : await runSteadyMode(config.payloads, rate, duration, requests);

    allResults.push(printResults(results, mode, rate));
  }

  // Save report
  if (output) {
    const totalRequests = allResults.reduce((a, r) => a + r.requests.total, 0);
    const totalSuccess = allResults.reduce((a, r) => a + r.requests.success, 0);
    const overallSuccessRate = (totalSuccess / totalRequests) * 100;

    if (output.endsWith(".json")) {
      // JSON report
      const report = {
        timestamp: new Date().toISOString(),
        config: { mode, rate, duration, rates },
        results: allResults,
        summary: { totalRequests, totalSuccess, overallSuccessRate },
      };
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
    } else {
      // Markdown report
      const lines: string[] = [];
      lines.push("# TACo Stress Test Report");
      lines.push("");
      lines.push(`**Generated:** ${new Date().toISOString()}`);
      lines.push("");
      lines.push("## Configuration");
      lines.push("");
      lines.push(`- **Mode:** ${mode}`);
      lines.push(`- **Duration per rate:** ${duration}s`);
      if (mode === "sweep") {
        lines.push(`- **Rates tested:** ${rates.join(", ")} RPS`);
      } else {
        lines.push(`- **Rate:** ${rate} RPS`);
      }
      lines.push("");
      lines.push("## Summary");
      lines.push("");
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Total Requests | ${totalRequests} |`);
      lines.push(
        `| Successful | ${totalSuccess} (${overallSuccessRate.toFixed(1)}%) |`,
      );
      lines.push(
        `| Failed | ${totalRequests - totalSuccess} (${(100 - overallSuccessRate).toFixed(1)}%) |`,
      );
      lines.push("");
      lines.push("## Results by Rate");
      lines.push("");
      lines.push(
        "| Rate (RPS) | Mode | Actual RPS | Success % | Latency p50 | Latency p95 | TACo p50 | TACo p95 |",
      );
      lines.push(
        "|------------|------|------------|-----------|-------------|-------------|----------|----------|",
      );

      for (const r of allResults) {
        const successPct = (
          (r.requests.success / r.requests.total) *
          100
        ).toFixed(1);
        const tacoP50 = r.tacoSigningTime
          ? `${r.tacoSigningTime.p50}ms`
          : "N/A";
        const tacoP95 = r.tacoSigningTime
          ? `${r.tacoSigningTime.p95}ms`
          : "N/A";
        lines.push(
          `| ${r.targetRate} | ${r.mode} | ${r.actualRate.toFixed(2)} | ${successPct}% | ${r.latency.p50}ms | ${r.latency.p95}ms | ${tacoP50} | ${tacoP95} |`,
        );
      }

      lines.push("");
      lines.push("## Detailed Results");

      for (const r of allResults) {
        lines.push("");
        lines.push(`### ${r.mode} @ ${r.targetRate} RPS`);
        lines.push("");
        lines.push("**Throughput**");
        lines.push("");
        lines.push(`| Metric | Value |`);
        lines.push(`|--------|-------|`);
        lines.push(`| Target RPS | ${r.targetRate} |`);
        lines.push(`| Actual RPS | ${r.actualRate.toFixed(2)} |`);
        lines.push(`| Duration | ${r.duration}s |`);
        lines.push(`| Total Requests | ${r.requests.total} |`);
        lines.push(
          `| Successful | ${r.requests.success} (${((r.requests.success / r.requests.total) * 100).toFixed(1)}%) |`,
        );
        lines.push(`| Failed | ${r.requests.failed} |`);
        lines.push("");
        lines.push("**Latency (ms)**");
        lines.push("");
        lines.push(`| Metric | Value |`);
        lines.push(`|--------|-------|`);
        lines.push(`| Min | ${r.latency.min} |`);
        lines.push(`| Max | ${r.latency.max} |`);
        lines.push(`| Mean | ${r.latency.mean} |`);
        lines.push(`| p50 | ${r.latency.p50} |`);
        lines.push(`| p95 | ${r.latency.p95} |`);
        lines.push(`| p99 | ${r.latency.p99} |`);

        if (r.tacoSigningTime) {
          lines.push("");
          lines.push("**TACo Signing Time (ms)**");
          lines.push("");
          lines.push(`| Metric | Value |`);
          lines.push(`|--------|-------|`);
          lines.push(`| Min | ${r.tacoSigningTime.min} |`);
          lines.push(`| Max | ${r.tacoSigningTime.max} |`);
          lines.push(`| Mean | ${r.tacoSigningTime.mean} |`);
          lines.push(`| p50 | ${r.tacoSigningTime.p50} |`);
          lines.push(`| p95 | ${r.tacoSigningTime.p95} |`);
          lines.push(`| p99 | ${r.tacoSigningTime.p99} |`);
        }

        if (r.errors.length > 0) {
          lines.push("");
          lines.push("**Errors**");
          lines.push("");
          for (const err of r.errors.slice(0, 5)) {
            const shortErr = err.length > 80 ? err.slice(0, 80) + "..." : err;
            lines.push(`- ${shortErr}`);
          }
          if (r.errors.length > 5) {
            lines.push(`- ... and ${r.errors.length - 5} more`);
          }
        }
      }

      lines.push("");
      fs.writeFileSync(output, lines.join("\n"));
    }

    console.log(`[stress-test] Report saved to: ${output}`);
  }

  console.log("\n[stress-test] Done!");
}

main().catch((err) => {
  console.error("[stress-test] Fatal error:", err);
  process.exit(1);
});
