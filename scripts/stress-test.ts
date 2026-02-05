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
  timeout: number,
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
    undefined, // porterUris
    timeout,
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

// Pre-computed data for a payload (expensive setup done once)
interface PreparedPayload {
  payload: Payload;
  smartAccount: any;
  recipientAA: Address;
  calls: Array<{ to: Address; value: bigint; data?: `0x${string}` }>;
  userOp: Record<string, unknown>;
  discordContext: {
    timestamp: string;
    signature: string;
    payload: string;
  };
}

interface ConfigDefaults {
  mode?: "steady" | "burst" | "sweep";
  duration?: number;
  rates?: number[];
  rate?: number;
  requests?: number;
  burstSizes?: number[];
  batchesPerBurst?: number;
  cooldown?: number;
  timeout?: number;
  maxDuration?: number;
  maxConsecutiveFailures?: number;
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
  fromData?: string;
  regenerate?: boolean;
  maxDuration?: number;
  maxConsecutiveFailures?: number;
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

interface NodeFailure {
  address: string;
  timeouts: number;
  otherErrors: number;
}

interface ErrorWithCount {
  message: string;
  count: number;
}

interface TimelineRequest {
  index: number;
  timestamp: number; // absolute time (Date.now())
  elapsedSec: number; // seconds since test start
  duration: number; // total request time (ms)
  tacoSigningTimeMs: number | null;
  success: boolean;
  error?: string;
  inFlight: number; // requests still waiting when this one completed
}

type StopReason = "duration" | "consecutive-failures" | "completed";

interface RunResult {
  mode: "steady" | "burst";
  // For steady mode: target requests per minute
  // For burst mode: burst size (concurrent requests per batch)
  targetRate: number;
  duration: number;
  requests: {
    total: number;
    success: number;
    failed: number;
  };
  latency: Stats;
  successLatency: Stats | null;
  failureLatency: Stats | null;
  tacoSigningTime: Stats | null;
  successTacoSigningTime: Stats | null;
  failureTacoSigningTime: Stats | null;
  nodeFailures: NodeFailure[];
  errors: ErrorWithCount[];
  // Timeline data for steady mode
  timeline?: TimelineRequest[];
  stopReason?: StopReason;
  consecutiveFailuresAtStop?: number;
}

interface TestData {
  version: 1;
  timestamp: string;
  config: {
    mode: string;
    rate: number;
    duration: number;
    rates: number[];
    burstSizes: number[];
    batchesPerBurst: number;
    maxDuration?: number;
    maxConsecutiveFailures?: number;
  };
  steadyResults: RunResult[];
  burstResults: RunResult[];
}

// =============================================================================
// Results Directory Management
// =============================================================================

const RESULTS_DIR = "stress-test-results";
const DATA_DIR = path.join(RESULTS_DIR, "data");
const REPORTS_DIR = path.join(RESULTS_DIR, "reports");

function ensureResultsDirs(): void {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR);
  }
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
  }
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR);
  }
}

function generateTimestamp(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}${min}${ss}`;
}

function saveTestData(data: TestData): string {
  ensureResultsDirs();
  const timestamp = generateTimestamp();
  const filename = `${timestamp}.json`;
  const filepath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

function loadTestData(filepath: string): TestData {
  const content = fs.readFileSync(filepath, "utf-8");
  return JSON.parse(content) as TestData;
}

function getLatestDataFile(): string | null {
  ensureResultsDirs();
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;
  files.sort().reverse();
  return path.join(DATA_DIR, files[0]);
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
    } else if (arg.startsWith("--from-data=")) {
      options.fromData = arg.slice(12);
    } else if (arg === "--regenerate") {
      options.regenerate = true;
    } else if (arg.startsWith("--max-duration=")) {
      options.maxDuration = parseInt(arg.slice(15), 10);
    } else if (arg.startsWith("--max-failures=")) {
      options.maxConsecutiveFailures = parseInt(arg.slice(15), 10);
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
  cooldown: number;
  maxDuration?: number;
  maxConsecutiveFailures?: number;
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
  const cooldown = configDefaults.cooldown ?? 30;
  const timeout = configDefaults.timeout ?? 120;
  const maxDuration = cliOptions.maxDuration ?? configDefaults.maxDuration;
  const maxConsecutiveFailures =
    cliOptions.maxConsecutiveFailures ?? configDefaults.maxConsecutiveFailures;

  return {
    config,
    mode: mode as "steady" | "burst" | "sweep",
    rate,
    duration,
    requests,
    rates,
    burstSizes,
    batchesPerBurst,
    cooldown,
    timeout,
    maxDuration,
    maxConsecutiveFailures,
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
// Payload Preparation (expensive setup done once per payload)
// =============================================================================

async function preparePayload(payload: Payload): Promise<PreparedPayload> {
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

  // Create smart account for sender (expensive - calls RPC)
  const senderSalt = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(`${senderDiscordId}|Discord|Collab.Land`),
  ) as `0x${string}`;

  const { smartAccount } = await createTacoSmartAccount(
    publicClient,
    signingCoordinatorProvider,
    signingChainProvider,
    senderSalt,
  );

  // Derive recipient address (expensive - calls RPC)
  const recipientAA = await deriveDiscordUserAA(
    publicClient,
    signingCoordinatorProvider,
    signingChainProvider,
    payload.recipientUserId,
  );

  // Parse amount and build calls array
  const amountStr = String(amountOpt ?? "0.0001");
  const tokenDecimals = tokenType === "USDC" ? 6 : 18;
  const transferAmount = ethers.utils.parseUnits(amountStr, tokenDecimals);

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

  // Build Discord context
  const bodyString = payload.bodyJson || JSON.stringify(payload.body);
  const discordContext = {
    timestamp: payload.timestamp,
    signature: payload.signature.replace(/^0x/, ""),
    payload: bodyString,
  };

  // Prepare UserOp using bundler (expensive - calls RPC for nonce and gas estimates)
  const userOp = await bundlerClient.prepareUserOperation({
    account: smartAccount,
    calls,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 3_000_000_000n,
    verificationGasLimit: BigInt(500_000),
  });

  return {
    payload,
    smartAccount,
    recipientAA,
    calls,
    userOp,
    discordContext,
  };
}

async function prepareAllPayloads(
  payloads: Payload[],
): Promise<PreparedPayload[]> {
  console.log(`[stress-test] Preparing ${payloads.length} payload(s)...`);
  const prepared: PreparedPayload[] = [];

  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    console.log(
      `[stress-test]   Preparing payload ${i + 1}/${payloads.length}...`,
    );
    prepared.push(await preparePayload(payload));
  }

  console.log(`[stress-test] All payloads prepared`);
  return prepared;
}

// =============================================================================
// Request Executor
// =============================================================================

// Global timeout setting (in seconds) - set by config, used by request executor
let REQUEST_TIMEOUT_SECONDS = 120;

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

async function executeSigningRequest(
  prepared: PreparedPayload,
): Promise<RequestResult> {
  const startTime = Date.now();

  // Suppress console.error during request execution to avoid noisy Porter error logs
  // The errors are still captured and reported in the test results
  const originalConsoleError = console.error;
  console.error = () => {}; // Suppress

  try {
    const timeoutMs = REQUEST_TIMEOUT_SECONDS * 1000;
    return await withTimeout(
      executeSigningRequestInner(prepared, startTime),
      timeoutMs,
      `Request timed out after ${REQUEST_TIMEOUT_SECONDS}s`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      duration: Date.now() - startTime,
      startTime,
      endTime: Date.now(),
      error: `[timeout] ${errorMessage}`,
      index: 0,
    };
  } finally {
    console.error = originalConsoleError; // Restore
  }
}

async function executeSigningRequestInner(
  prepared: PreparedPayload,
  startTime: number,
): Promise<RequestResult> {
  let tacoSigningTimeMs: number | undefined;

  try {
    // Sign with TACo (uses pre-computed userOp and discord context)
    const tacoStartTime = Date.now();
    await signUserOpWithTaco(
      prepared.userOp,
      signingCoordinatorProvider,
      prepared.discordContext,
      REQUEST_TIMEOUT_SECONDS,
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
      error: `[taco-signing] ${errorMessage}`,
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

interface SteadyModeOptions {
  rate: number;
  duration?: number;
  requestCount?: number;
  maxDuration?: number;
  maxConsecutiveFailures?: number;
}

interface SteadyModeResult {
  results: RequestResult[];
  timeline: TimelineRequest[];
  stopReason: StopReason;
  consecutiveFailuresAtStop?: number;
}

async function runSteadyMode(
  preparedPayloads: PreparedPayload[],
  options: SteadyModeOptions,
): Promise<SteadyModeResult> {
  const { rate, duration, requestCount, maxDuration, maxConsecutiveFailures } =
    options;
  const intervalMs = 60000 / rate; // rate is requests per minute

  // Determine if we're in "timeline mode" (with stop conditions) or "fixed count mode"
  const hasStopConditions =
    maxDuration !== undefined || maxConsecutiveFailures !== undefined;

  // For fixed count mode, calculate total requests upfront
  const totalRequests = !hasStopConditions
    ? (requestCount ?? Math.floor(((duration || 60) / 60) * rate))
    : undefined;

  let payloadIndex = 0;
  let completedCount = 0;
  let consecutiveFailures = 0;

  const modeDesc = hasStopConditions
    ? `${rate} requests/min, max ${maxDuration || "∞"}s, max ${maxConsecutiveFailures || "∞"} consecutive failures`
    : `${rate} requests/min, ${totalRequests} total requests`;

  console.log(`[stress-test] Starting steady mode: ${modeDesc}`);

  const testStartTime = Date.now();
  const results: RequestResult[] = [];
  const timeline: TimelineRequest[] = [];
  const pendingRequests: Map<number, Promise<RequestResult>> = new Map();
  let nextRequestIndex = 0;
  let stopReason: StopReason = "completed";
  let shouldStop = false;

  // Process completed request and update state
  const processResult = (result: RequestResult): boolean => {
    completedCount++;
    results.push(result);

    // Track consecutive failures
    if (result.success) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
    }

    // Add to timeline
    const elapsed = (result.endTime - testStartTime) / 1000;
    const inFlight = pendingRequests.size;
    timeline.push({
      index: result.index,
      timestamp: result.endTime,
      elapsedSec: elapsed,
      duration: result.duration,
      tacoSigningTimeMs: result.tacoSigningTimeMs ?? null,
      success: result.success,
      error: result.error,
      inFlight,
    });

    // Progress update
    const totalDesc = totalRequests ? `/${totalRequests}` : "";
    console.log(
      `[${elapsed.toFixed(0).padStart(3, "0")}s] Completed ${completedCount}${totalDesc} | ` +
        `in-flight: ${inFlight} | ` +
        `${result.success ? "ok" : "FAIL"} ${result.duration}ms` +
        (result.tacoSigningTimeMs
          ? ` | taco: ${result.tacoSigningTimeMs}ms`
          : "") +
        (consecutiveFailures > 0
          ? ` | consec-fail: ${consecutiveFailures}`
          : ""),
    );

    // Check stop conditions
    if (
      maxConsecutiveFailures !== undefined &&
      consecutiveFailures >= maxConsecutiveFailures
    ) {
      stopReason = "consecutive-failures";
      return true; // should stop
    }

    return false;
  };

  // Main loop - fire requests at rate, check stop conditions
  while (!shouldStop) {
    // Check max duration
    const elapsedSec = (Date.now() - testStartTime) / 1000;
    if (maxDuration !== undefined && elapsedSec >= maxDuration) {
      stopReason = "duration";
      break;
    }

    // Check if we've fired all requests (fixed count mode)
    if (totalRequests !== undefined && nextRequestIndex >= totalRequests) {
      break;
    }

    // Fire next request
    const prepared = preparedPayloads[payloadIndex % preparedPayloads.length];
    payloadIndex++;
    const requestIndex = nextRequestIndex++;

    const requestPromise = executeSigningRequest(prepared).then((result) => {
      result.index = requestIndex;
      pendingRequests.delete(requestIndex);
      shouldStop = processResult(result);
      return result;
    });

    pendingRequests.set(requestIndex, requestPromise);

    // Wait for next interval
    const elapsed = Date.now() - testStartTime;
    const expectedElapsed = nextRequestIndex * intervalMs;
    const waitTime = Math.max(0, expectedElapsed - elapsed);
    if (waitTime > 0) {
      await sleep(waitTime);
    }
  }

  // Abandon in-flight requests on stop condition
  if (pendingRequests.size > 0 && stopReason !== "completed") {
    console.log(
      `[stress-test] Stop condition reached, abandoning ${pendingRequests.size} in-flight requests`,
    );
  } else if (pendingRequests.size > 0) {
    // Only wait for in-flight if we completed normally (fixed count mode)
    console.log(
      `[stress-test] Waiting for ${pendingRequests.size} in-flight requests...`,
    );
    const remaining = await Promise.all(pendingRequests.values());
    for (const result of remaining) {
      if (!results.find((r) => r.index === result.index)) {
        processResult(result);
      }
    }
  }

  console.log(
    `[stress-test] Steady mode complete. Stop reason: ${stopReason}` +
      (stopReason === "consecutive-failures"
        ? ` (${consecutiveFailures} consecutive failures)`
        : ""),
  );

  return {
    results,
    timeline,
    stopReason,
    consecutiveFailuresAtStop:
      stopReason === "consecutive-failures" ? consecutiveFailures : undefined,
  };
}

async function runBurstMode(
  preparedPayloads: PreparedPayload[],
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
      const prepared = preparedPayloads[payloadIndex % preparedPayloads.length];
      payloadIndex++;
      const idx = requestIndex++;
      batchPromises.push(
        executeSigningRequest(prepared).then((r) => ({ ...r, index: idx })),
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

function parseNodeFailures(errors: string[]): NodeFailure[] {
  const nodeMap = new Map<string, { timeouts: number; otherErrors: number }>();

  for (const error of errors) {
    // Match patterns like: "Node 0x48C8039c32F4c6f5cb206A5911C8Ae814929C16B did not respond before timeout"
    const timeoutMatches = error.matchAll(
      /Node\s+(0x[a-fA-F0-9]+)\s+did not respond before timeout/g,
    );
    for (const match of timeoutMatches) {
      const addr = match[1];
      const existing = nodeMap.get(addr) || { timeouts: 0, otherErrors: 0 };
      existing.timeouts++;
      nodeMap.set(addr, existing);
    }

    // Also try to parse from JSON-like error format
    const jsonMatch = error.match(
      /TACo signing failed with errors:\s*(\{[^}]+\})/,
    );
    if (jsonMatch) {
      try {
        const errObj = JSON.parse(jsonMatch[1]);
        for (const [addr, msg] of Object.entries(errObj)) {
          const existing = nodeMap.get(addr) || { timeouts: 0, otherErrors: 0 };
          if (String(msg).includes("timeout")) {
            existing.timeouts++;
          } else {
            existing.otherErrors++;
          }
          nodeMap.set(addr, existing);
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  return Array.from(nodeMap.entries())
    .map(([address, counts]) => ({
      address,
      timeouts: counts.timeouts,
      otherErrors: counts.otherErrors,
    }))
    .sort((a, b) => b.timeouts + b.otherErrors - (a.timeouts + a.otherErrors));
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

  // Separate success/failure latencies
  const successLatencies = successResults.map((r) => r.duration);
  const failureLatencies = failedResults.map((r) => r.duration);
  const successLatencyStats =
    successLatencies.length > 0 ? calculateStats(successLatencies) : null;
  const failureLatencyStats =
    failureLatencies.length > 0 ? calculateStats(failureLatencies) : null;

  // All TACo times
  const tacoTimes = results
    .filter((r) => r.tacoSigningTimeMs !== undefined)
    .map((r) => r.tacoSigningTimeMs!);
  const tacoStats = tacoTimes.length > 0 ? calculateStats(tacoTimes) : null;

  // Separate success/failure TACo times
  const tacoSuccessTimes = successResults
    .filter((r) => r.tacoSigningTimeMs !== undefined)
    .map((r) => r.tacoSigningTimeMs!);
  const tacoFailureTimes = failedResults
    .filter((r) => r.tacoSigningTimeMs !== undefined)
    .map((r) => r.tacoSigningTimeMs!);
  const successTacoSigningTimeStats =
    tacoSuccessTimes.length > 0 ? calculateStats(tacoSuccessTimes) : null;
  const failureTacoSigningTimeStats =
    tacoFailureTimes.length > 0 ? calculateStats(tacoFailureTimes) : null;

  const allErrors = failedResults.map((r) => r.error || "Unknown error");
  const nodeFailures = parseNodeFailures(allErrors);

  // Count occurrences of each error
  const errorCountMap = new Map<string, number>();
  for (const err of allErrors) {
    errorCountMap.set(err, (errorCountMap.get(err) || 0) + 1);
  }
  const errorsWithCounts: ErrorWithCount[] = Array.from(
    errorCountMap.entries(),
  ).map(([message, count]) => ({ message, count }));

  console.log("\n" + "=".repeat(60));
  console.log("                    STRESS TEST RESULTS");
  console.log("=".repeat(60));
  console.log();
  const modeLabel =
    mode === "burst" ? `Burst size: ${rate}` : `Rate: ${rate} requests/min`;
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

  if (errorsWithCounts.length > 0) {
    console.log();
    console.log("ERRORS");
    for (const { message, count } of errorsWithCounts.slice(0, 5)) {
      const shortErr =
        message.length > 60 ? message.slice(0, 60) + "..." : message;
      console.log(`    [${count}x] ${shortErr}`);
    }
    if (errorsWithCounts.length > 5) {
      console.log(
        `    ... and ${errorsWithCounts.length - 5} more unique errors`,
      );
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
    successLatency: successLatencyStats,
    failureLatency: failureLatencyStats,
    tacoSigningTime: tacoStats,
    successTacoSigningTime: successTacoSigningTimeStats,
    failureTacoSigningTime: failureTacoSigningTimeStats,
    nodeFailures,
    errors: errorsWithCounts,
  };
}

// =============================================================================
// Report Generation
// =============================================================================

function generateHtmlReport(data: TestData): string {
  const { steadyResults, burstResults, config: testConfig } = data;
  const {
    mode,
    rate,
    rates,
    duration,
    burstSizes,
    batchesPerBurst,
    maxDuration,
    maxConsecutiveFailures,
  } = testConfig;

  // Detect timeline mode: single steady result with timeline data
  const isTimelineMode =
    steadyResults.length === 1 &&
    steadyResults[0].timeline &&
    steadyResults[0].timeline.length > 0;

  const allResults = [...steadyResults, ...burstResults];
  const totalRequests = allResults.reduce((a, r) => a + r.requests.total, 0);
  const totalSuccess = allResults.reduce((a, r) => a + r.requests.success, 0);
  const overallSuccessRate =
    totalRequests > 0 ? (totalSuccess / totalRequests) * 100 : 0;

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = ((ms % 60000) / 1000).toFixed(0);
    return `${mins}m ${secs}s`;
  };

  // Collect all errors for the error section
  const allErrors: Array<{ source: string; errors: ErrorWithCount[] }> = [];
  for (const r of steadyResults) {
    if (r.errors.length > 0) {
      allErrors.push({
        source: `Steady @ ${r.targetRate} requests/min`,
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
    errors: ErrorWithCount[],
  ): Map<string, { count: number; full: string }> => {
    const errorCounts = new Map<string, { count: number; full: string }>();
    for (const { message: err, count: errCount } of errors) {
      let errorType: string;
      if (err.includes("Gateway Timeout") || err.includes("status code 504")) {
        errorType = "Porter 504 Gateway Timeout";
      } else if (err.includes("stream timeout")) {
        errorType = "Porter stream timeout";
      } else if (err.includes("Threshold of signatures not met")) {
        errorType = "Threshold of signatures not met";
      } else if (
        err.includes("NETWORK_ERROR") ||
        err.includes("could not detect network")
      ) {
        errorType = "Network error (RPC overload)";
      } else if (err.includes("missing revert data")) {
        errorType = "Contract revert (missing revert data)";
      } else if (err.includes("timeout") || err.includes("timed out")) {
        errorType = "Request timeout";
      } else {
        const phaseMatch = err.match(/^\[([^\]]+)\]/);
        errorType = phaseMatch ? `[${phaseMatch[1]}] error` : err.slice(0, 60);
      }

      const existing = errorCounts.get(errorType);
      if (existing) {
        existing.count += errCount;
      } else {
        errorCounts.set(errorType, { count: errCount, full: err });
      }
    }
    return errorCounts;
  };

  // TACo logo as inline SVG (white version)
  const tacoLogo = `<svg width="150" height="64" viewBox="0 0 301 128" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_2309_654)"><path d="M35.9287 40.8643H33V86.8327H35.9287V40.8643Z" fill="white"/><path d="M93.9414 40.8643H91.0127V86.8327H93.9414V40.8643Z" fill="white"/><path d="M151.964 40.8643H149.035V86.8327H151.964V40.8643Z" fill="white"/><path d="M209.977 40.8643H207.048V86.8327H209.977V40.8643Z" fill="white"/><path d="M267.999 40.8643H265.07V86.8327H267.999V40.8643Z" fill="white"/><path d="M86.4775 33.4H40.4727V36.3252H86.4775V33.4Z" fill="white"/><path d="M144.492 33.4H98.4873V36.3252H144.492V33.4Z" fill="white"/><path d="M202.513 33.4H156.508V36.3252H202.513V33.4Z" fill="white"/><path d="M260.527 33.4H214.522V36.3252H260.527V33.4Z" fill="white"/><path d="M86.4775 91.3719H40.4727V94.2971H86.4775V91.3719Z" fill="white"/><path d="M144.492 91.3719H98.4873V94.2971H144.492V91.3719Z" fill="white"/><path d="M202.513 91.3719H156.508V94.2971H202.513V91.3719Z" fill="white"/><path d="M260.527 91.3719H214.522V94.2971H260.527V91.3719Z" fill="white"/><path d="M61.5334 76.8008V52.7666H54.6479C53.6563 52.7666 52.876 51.9872 52.876 50.9968V50.8501C52.876 49.8598 53.6563 49.0803 54.6479 49.0803H72.3117C73.3032 49.0803 74.0835 49.8598 74.0835 50.8501V50.9968C74.0835 51.9872 73.3032 52.7666 72.3117 52.7666H65.4261V76.8008C65.4261 77.837 64.6457 78.6164 63.5257 78.6164H63.443C62.3413 78.6164 61.5426 77.837 61.5426 76.8008H61.5334Z" fill="white"/><path d="M110.88 76.7551C110.88 76.4525 110.926 76.1315 111.027 75.7923L117.747 52.0148C118.234 50.2634 119.519 49.0621 121.318 49.0621C123.118 49.0621 124.321 50.2634 124.844 52.0148L132.023 75.8564C132.115 76.1682 132.161 76.4708 132.161 76.7459C132.161 77.8555 131.445 78.6257 130.224 78.6257H130.095C129.232 78.6257 128.571 78.2223 128.305 77.2961L126.781 72.3627H116.113L114.672 77.3878C114.414 78.2498 113.744 78.6349 112.946 78.6349H112.817C111.523 78.6349 110.88 77.8646 110.88 76.7643V76.7551ZM125.762 68.6581L121.346 53.4637H121.217L117.013 68.6581H125.762Z" fill="white"/><path d="M175.118 75.3154L171.317 68.4747C170.325 66.7049 170.096 65.3936 170.096 63.8348C170.096 62.2759 170.334 60.9646 171.317 59.1948L175.118 52.3541C176.109 50.5843 177.358 49.0621 179.974 49.0621H187.245C188.255 49.0621 189.017 49.8416 189.017 50.8319V50.9786C189.017 51.969 188.255 52.7484 187.245 52.7484H180.571C179.68 52.7484 179.175 52.9593 178.358 54.4357L174.897 60.6345C174.264 61.7716 174.007 62.661 174.007 63.8164C174.007 64.9718 174.264 65.8613 174.897 67.0075L178.358 73.2064C179.185 74.6827 179.69 74.8936 180.571 74.8936H187.245C188.255 74.8936 189.017 75.6731 189.017 76.6634V76.8101C189.017 77.8005 188.255 78.5799 187.245 78.5799H179.974C177.358 78.5799 176.109 77.0577 175.118 75.2879V75.3154Z" fill="white"/><path d="M230.771 59.7818L231.937 58.874C233.103 57.9662 234.141 57.526 235.784 57.526H239.42C241.063 57.526 242.1 57.9662 243.266 58.874L244.432 59.7818C246.269 61.2215 246.902 62.1018 246.902 64.275V71.8768C246.902 74.0501 246.269 74.9396 244.432 76.3701L243.266 77.2779C242.1 78.1857 241.063 78.6258 239.42 78.6258H235.784C234.132 78.6258 233.103 78.1857 231.937 77.2779L230.771 76.3701C228.935 74.9304 228.302 74.0501 228.302 71.8768V64.275C228.302 62.1018 228.935 61.2123 230.771 59.7818ZM233.094 73.6283L233.709 74.1143C234.49 74.7286 235.105 74.9396 236.16 74.9396H239.034C240.09 74.9396 240.696 74.7286 241.485 74.1143L242.1 73.6283C243.138 72.803 243.386 72.2344 243.386 70.8865V65.247C243.386 63.899 243.138 63.3489 242.1 62.5236L241.485 62.0376C240.705 61.4232 240.09 61.2123 239.034 61.2123H236.16C235.105 61.2123 234.49 61.4232 233.709 62.0376L233.094 62.5236C232.057 63.3489 231.809 63.899 231.809 65.247V70.8865C231.809 72.2344 232.066 72.8121 233.094 73.6283Z" fill="white"/></g><defs><clipPath id="clip0_2309_654"><rect width="235" height="60.897" fill="white" transform="translate(33 33.4)"/></clipPath></defs></svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TACo Stress Test Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg: #000000;
      --card-bg: #111111;
      --text: #ffffff;
      --text-muted: #909090;
      --accent: #96FF5E;
      --success: #96FF5E;
      --warning: #ffa726;
      --error: #ef5350;
      --border: #333333;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2rem;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    .header { display: flex; align-items: center; gap: 1.5rem; margin-bottom: 0.5rem; }
    .header svg { flex-shrink: 0; }
    h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: 0.05em; }
    h2 { font-size: 1.25rem; margin: 2rem 0 1rem; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; letter-spacing: 0.05em; }
    h3 { font-size: 1rem; margin: 1.5rem 0 0.75rem; letter-spacing: 0.03em; }
    .timestamp { color: var(--text-muted); margin-bottom: 2rem; font-size: 0.85rem; }
    .data-source { color: var(--text-muted); margin-bottom: 0.5rem; font-size: 0.8rem; }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .summary-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1.5rem;
      text-align: center;
    }
    .summary-card .value {
      font-size: 2rem;
      font-weight: bold;
      color: var(--accent);
    }
    .summary-card .label { color: var(--text-muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.1em; }
    .summary-card.success .value { color: var(--success); }
    .summary-card.warning .value { color: var(--warning); }
    .summary-card.error .value { color: var(--error); }
    .chart-container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      min-height: 350px;
    }
    .chart-container canvas {
      max-height: 320px;
    }
    .chart-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
      gap: 1.5rem;
    }
    @media (max-width: 1100px) {
      .chart-row {
        grid-template-columns: 1fr;
      }
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
    }
    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th { background: rgba(150, 255, 94, 0.1); color: var(--accent); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.8rem; }
    tr:last-child td { border-bottom: none; }
    tr:hover { background: rgba(150, 255, 94, 0.05); }
    .error-section {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
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
      border-radius: 2px;
      font-size: 0.85rem;
      font-weight: bold;
    }
    .error-example {
      font-family: 'SF Mono', 'Monaco', monospace;
      font-size: 0.75rem;
      color: var(--text-muted);
      background: rgba(0,0,0,0.3);
      padding: 0.5rem;
      margin-top: 0.5rem;
      border-radius: 2px;
      word-break: break-all;
      max-height: 100px;
      overflow-y: auto;
    }
    .stop-reason {
      padding: 0.25rem 0.5rem;
      border-radius: 3px;
      font-weight: bold;
    }
    .stop-reason-completed { background: var(--success); color: black; }
    .stop-reason-duration { background: var(--warning); color: black; }
    .stop-reason-consecutive-failures { background: var(--error); color: white; }
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
    .notes-section {
      background: var(--card-bg);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 2rem;
      border: 1px solid var(--border);
    }
    .notes-section h2 {
      margin-bottom: 0.5rem;
      font-size: 1rem;
    }
    .notes-textarea {
      width: 100%;
      min-height: 80px;
      background: rgba(0,0,0,0.3);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      font-family: inherit;
      font-size: 0.9rem;
      padding: 0.75rem;
      resize: vertical;
    }
    .notes-textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    .notes-textarea::placeholder {
      color: var(--text-muted);
    }
    .notes-saved {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${tacoLogo}
      <h1>Stress Test Report</h1>
    </div>
    <p class="timestamp">Generated: ${new Date().toISOString()}</p>
    <p class="data-source">Test data from: ${data.timestamp}</p>

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

    <div class="notes-section">
      <h2>Notes</h2>
      <textarea class="notes-textarea" id="reportNotes" placeholder="Add notes about this test run..."></textarea>
      <div class="notes-saved" id="notesSaved"></div>
    </div>

    <h2>Configuration</h2>
    ${
      isTimelineMode
        ? `
    <ul class="config-list">
      <li><strong>Mode:</strong> steady</li>
      <li><strong>Rate:</strong> ${rate} requests/min</li>
      ${maxDuration ? `<li><strong>Max Duration:</strong> ${maxDuration}s</li>` : ""}
      ${maxConsecutiveFailures ? `<li><strong>Max Consecutive Failures:</strong> ${maxConsecutiveFailures}</li>` : ""}
      <li><strong>Stop Reason:</strong> <span class="stop-reason stop-reason-${steadyResults[0].stopReason}">${steadyResults[0].stopReason === "consecutive-failures" ? `Consecutive failures (${steadyResults[0].consecutiveFailuresAtStop})` : steadyResults[0].stopReason === "duration" ? "Max duration reached" : "Completed"}</span></li>
    </ul>
    `
        : `
    <ul class="config-list">
      <li><strong>Mode:</strong> ${mode}</li>
      <li><strong>Steady Rates:</strong> ${rates.join(", ")} requests/min</li>
      <li><strong>Duration per Rate:</strong> ${duration}s</li>
      <li><strong>Burst Sizes:</strong> ${burstSizes.join(", ")}</li>
      <li><strong>Batches per Burst:</strong> ${batchesPerBurst}</li>
    </ul>
    `
    }

    ${
      isTimelineMode
        ? `
    <h2>Timeline</h2>
    <p style="color: var(--text-muted); margin-bottom: 1rem;">
      Response time for each request over time. Green = success, Red = failure.
    </p>

    <div class="chart-container" style="max-width: 100%; height: 400px;">
      <canvas id="timelineChart"></canvas>
    </div>

    <h3>Summary Statistics</h3>
    <table>
      <thead>
        <tr>
          <th>Metric</th>
          <th>Success</th>
          <th>Failure</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Count</td>
          <td>${steadyResults[0].requests.success}</td>
          <td>${steadyResults[0].requests.failed}</td>
        </tr>
        <tr>
          <td>Latency p50</td>
          <td>${steadyResults[0].successLatency ? formatDuration(steadyResults[0].successLatency.p50) : "N/A"}</td>
          <td>${steadyResults[0].failureLatency ? formatDuration(steadyResults[0].failureLatency.p50) : "N/A"}</td>
        </tr>
        <tr>
          <td>Latency p95</td>
          <td>${steadyResults[0].successLatency ? formatDuration(steadyResults[0].successLatency.p95) : "N/A"}</td>
          <td>${steadyResults[0].failureLatency ? formatDuration(steadyResults[0].failureLatency.p95) : "N/A"}</td>
        </tr>
        <tr>
          <td>TACo Time p50</td>
          <td>${steadyResults[0].successTacoSigningTime ? formatDuration(steadyResults[0].successTacoSigningTime.p50) : "N/A"}</td>
          <td>${steadyResults[0].failureTacoSigningTime ? formatDuration(steadyResults[0].failureTacoSigningTime.p50) : "N/A"}</td>
        </tr>
        <tr>
          <td>TACo Time p95</td>
          <td>${steadyResults[0].successTacoSigningTime ? formatDuration(steadyResults[0].successTacoSigningTime.p95) : "N/A"}</td>
          <td>${steadyResults[0].failureTacoSigningTime ? formatDuration(steadyResults[0].failureTacoSigningTime.p95) : "N/A"}</td>
        </tr>
      </tbody>
    </table>
    `
        : steadyResults.length > 0
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
          <th>Rate</th>
          <th>Total</th>
          <th>Success %</th>
          <th>Success Latency p50</th>
          <th>Failure Latency p50</th>
          <th>TACo Success p50</th>
          <th>TACo Failure p50</th>
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
            <td>${r.targetRate}/min</td>
            <td>${r.requests.total}</td>
            <td>${successPct}%</td>
            <td>${r.successLatency ? formatDuration(r.successLatency.p50) : "N/A"}</td>
            <td>${r.failureLatency ? formatDuration(r.failureLatency.p50) : "N/A"}</td>
            <td>${r.successTacoSigningTime ? formatDuration(r.successTacoSigningTime.p50) : "N/A"}</td>
            <td>${r.failureTacoSigningTime ? formatDuration(r.failureTacoSigningTime.p50) : "N/A"}</td>
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
          <th>Total</th>
          <th>Batches</th>
          <th>Success %</th>
          <th>Success Latency p50</th>
          <th>Failure Latency p50</th>
          <th>TACo Success p50</th>
          <th>TACo Failure p50</th>
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
            <td>${r.successLatency ? formatDuration(r.successLatency.p50) : "N/A"}</td>
            <td>${r.failureLatency ? formatDuration(r.failureLatency.p50) : "N/A"}</td>
            <td>${r.successTacoSigningTime ? formatDuration(r.successTacoSigningTime.p50) : "N/A"}</td>
            <td>${r.failureTacoSigningTime ? formatDuration(r.failureTacoSigningTime.p50) : "N/A"}</td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>
    `
        : ""
    }

    ${(() => {
      // Collect results with error analysis
      const resultsWithErrors = [...steadyResults, ...burstResults].filter(
        (r) =>
          (r as any).errorAnalysis ||
          (r.nodeFailures && r.nodeFailures.length > 0) ||
          r.errors.length > 0,
      );
      if (resultsWithErrors.length === 0) return "";

      // Aggregate node failures only from tests that have errorAnalysis
      const allNodeFailures = new Map<
        string,
        { timeouts: number; otherErrors: number }
      >();
      for (const r of resultsWithErrors) {
        const nodeErrors =
          (r as any).errorAnalysis?.nodeErrors || r.nodeFailures || [];
        for (const nf of nodeErrors) {
          const addr = nf.nodeAddress || nf.address;
          const existing = allNodeFailures.get(addr) || {
            timeouts: 0,
            otherErrors: 0,
          };
          existing.timeouts += nf.timeouts || 0;
          existing.otherErrors += nf.otherErrors || 0;
          allNodeFailures.set(addr, existing);
        }
      }
      const sortedNodes = Array.from(allNodeFailures.entries()).sort(
        (a, b) =>
          b[1].timeouts + b[1].otherErrors - (a[1].timeouts + a[1].otherErrors),
      );

      // Generate per-test error sections
      const perTestSections = resultsWithErrors
        .map((r) => {
          const nodeErrors = r.nodeFailures || [];
          const source =
            r.mode === "steady"
              ? `Steady @ ${r.targetRate} requests/min`
              : `Burst size ${r.targetRate}`;

          const totalFailures = r.requests.failed;
          if (totalFailures === 0) return "";

          // Group and count error messages for this test
          const errorCounts = groupErrors(r.errors);
          const sortedErrors = Array.from(errorCounts.entries()).sort(
            (a, b) => b[1].count - a[1].count,
          );

          // Compute error breakdown from the grouped errors
          let thresholdNotMet = 0;
          let porterTimeouts = 0;
          let otherFailures = 0;
          for (const [errorType, { count }] of errorCounts.entries()) {
            if (errorType === "Threshold of signatures not met") {
              thresholdNotMet += count;
            } else if (
              errorType === "Porter 504 Gateway Timeout" ||
              errorType === "Porter stream timeout"
            ) {
              porterTimeouts += count;
            } else {
              otherFailures += count;
            }
          }

          return `
      <div class="error-section">
        <h3>${source}</h3>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1rem;">
          <div><strong>Total:</strong> ${totalFailures}</div>
          <div><strong>Threshold not met:</strong> ${thresholdNotMet}</div>
          <div><strong>Porter timeouts:</strong> ${porterTimeouts}</div>
          <div><strong>Other:</strong> ${otherFailures}</div>
        </div>

        ${
          r.errors.length > 0
            ? `
        <details open>
          <summary>Error messages (${r.errors.length} unique)</summary>
          <div style="margin-top: 0.5rem;">
${r.errors
  .map(
    ({ message, count }) => `
            <div class="error-type">
              <span class="error-count">${count}x</span>
            </div>
            <div class="error-example">${message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
`,
  )
  .join("")}
          </div>
        </details>
        `
            : ""
        }

        ${
          nodeErrors.length > 0
            ? `
        <details>
          <summary>Node breakdown</summary>
          <table style="margin-top: 0.5rem;">
            <thead>
              <tr><th>Node</th><th>Timeouts</th><th>Other</th></tr>
            </thead>
            <tbody>
${nodeErrors
  .map(
    (nf: any) => `
                <tr>
                  <td><code>${nf.nodeAddress || nf.address}</code></td>
                  <td>${nf.timeouts || 0}</td>
                  <td>${nf.otherErrors || 0}</td>
                </tr>
`,
  )
  .join("")}
            </tbody>
          </table>
        </details>
        `
            : ""
        }
      </div>
    `;
        })
        .join("");

      return `
    <h2>Error Analysis</h2>

${
  sortedNodes.length > 0
    ? `
    <div class="error-section">
      <h3>Node-Level Failures (Aggregated)</h3>
      <table>
        <thead>
          <tr>
            <th>Node Address</th>
            <th>Timeouts</th>
            <th>Other Errors</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
${sortedNodes
  .map(
    ([addr, counts]) => `
            <tr>
              <td><code>${addr}</code></td>
              <td>${counts.timeouts}</td>
              <td>${counts.otherErrors}</td>
              <td>${counts.timeouts + counts.otherErrors}</td>
            </tr>
`,
  )
  .join("")}
        </tbody>
      </table>
    </div>
`
    : ""
}

${perTestSections}
`;
    })()}

    <details class="glossary">
      <summary><h2 style="display: inline;">Glossary</h2></summary>
      <dl>
        <dt>Request Rate</dt>
        <dd>The rate at which new requests are initiated (e.g., 1/sec = 1 new request every second)</dd>
        <dt>Burst Size</dt>
        <dd>Number of requests fired simultaneously in each batch</dd>
        <dt>TACo Signing Time</dt>
        <dd>Time spent specifically in the TACo threshold signing operation</dd>
        <dt>p50 / p95 / p99</dt>
        <dd>Percentiles - p50 is median, p95 means 95% of requests were faster than this value</dd>
      </dl>
    </details>
  </div>

  <script>
    const isTimelineMode = ${isTimelineMode};
    const timelineData = ${JSON.stringify(
      isTimelineMode && steadyResults[0].timeline
        ? steadyResults[0].timeline.map((t, i) => ({
            x: i + 1,
            y: t.duration / 1000,
            success: t.success,
            error: t.error,
            tacoTime: t.tacoSigningTimeMs ? t.tacoSigningTimeMs / 1000 : null,
            inFlight: t.inFlight ?? 0,
          }))
        : [],
    )};
    const timelineP50 = ${isTimelineMode && steadyResults[0].latency ? steadyResults[0].latency.p50 / 1000 : "null"};
    const timelineP95 = ${isTimelineMode && steadyResults[0].latency ? steadyResults[0].latency.p95 / 1000 : "null"};

    const steadyData = ${JSON.stringify(
      steadyResults.map((r) => ({
        rate: r.targetRate,
        total: r.requests.total,
        success: r.requests.success,
        failed: r.requests.failed,
        successPct: (r.requests.success / r.requests.total) * 100,
        tacoP50: r.tacoSigningTime?.p50 || 0,
        tacoP95: r.tacoSigningTime?.p95 || 0,
        successP50: r.successTacoSigningTime?.p50 || null,
        successP95: r.successTacoSigningTime?.p95 || null,
        failureP50: r.failureLatency?.p50 || null,
        failureP95: r.failureLatency?.p95 || null,
      })),
    )};

    const burstData = ${JSON.stringify(
      burstResults.map((r) => ({
        size: r.targetRate,
        total: r.requests.total,
        success: r.requests.success,
        failed: r.requests.failed,
        successPct: (r.requests.success / r.requests.total) * 100,
        tacoP50: r.tacoSigningTime?.p50 || 0,
        tacoP95: r.tacoSigningTime?.p95 || 0,
        successP50: r.successTacoSigningTime?.p50 || null,
        successP95: r.successTacoSigningTime?.p95 || null,
        failureP50: r.failureLatency?.p50 || null,
        failureP95: r.failureLatency?.p95 || null,
      })),
    )};

    // Chart.js global defaults for better legibility
    Chart.defaults.font.family = "'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace";
    Chart.defaults.font.size = 12;
    Chart.defaults.color = '#ffffff';

    // Common chart options
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: true,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        title: {
          display: true,
          color: '#ffffff',
          font: { size: 14, weight: 'bold' },
          padding: { top: 10, bottom: 20 },
        },
        legend: {
          position: 'bottom',
          labels: {
            color: '#ffffff',
            padding: 15,
            usePointStyle: true,
            pointStyle: 'circle',
            font: { size: 11 },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(17, 17, 17, 0.95)',
          titleColor: '#96FF5E',
          bodyColor: '#ffffff',
          borderColor: '#333333',
          borderWidth: 1,
          padding: 12,
          titleFont: { size: 13, weight: 'bold' },
          bodyFont: { size: 12 },
          displayColors: true,
          callbacks: {},
        },
      },
      scales: {
        x: {
          ticks: { color: '#909090', font: { size: 11 } },
          grid: { color: 'rgba(51, 51, 51, 0.5)', drawBorder: false },
          title: { display: true, color: '#909090', font: { size: 12 } },
        },
        y: {
          ticks: { color: '#909090', font: { size: 11 } },
          grid: { color: 'rgba(51, 51, 51, 0.5)', drawBorder: false },
          title: { display: true, color: '#909090', font: { size: 12 } },
        },
      },
    };

    // Timeline Chart (for steady mode with stop conditions)
    if (isTimelineMode && timelineData.length > 0) {
      const successData = timelineData.filter(d => d.success);
      const failureData = timelineData.filter(d => !d.success);
      const inFlightData = timelineData.map(d => ({ x: d.x, y: d.inFlight }));

      new Chart(document.getElementById('timelineChart'), {
        type: 'scatter',
        data: {
          datasets: [
            {
              label: 'Still waiting',
              data: inFlightData,
              type: 'line',
              backgroundColor: 'rgba(80, 80, 80, 0.15)',
              borderColor: 'rgba(100, 100, 100, 0.4)',
              borderWidth: 1,
              fill: true,
              tension: 0.3,
              pointRadius: 0,
              yAxisID: 'y2',
              order: 2,
            },
            {
              label: 'Success',
              data: successData,
              backgroundColor: '#96FF5E',
              borderColor: '#96FF5E',
              pointRadius: 6,
              pointHoverRadius: 8,
              order: 1,
            },
            {
              label: 'Failure',
              data: failureData,
              backgroundColor: '#ef5350',
              borderColor: '#ef5350',
              pointRadius: 6,
              pointHoverRadius: 8,
              order: 1,
            },
          ],
        },
        options: {
          ...commonOptions,
          plugins: {
            ...commonOptions.plugins,
            title: { ...commonOptions.plugins.title, text: 'Response Time by Request' },
            tooltip: {
              ...commonOptions.plugins.tooltip,
              callbacks: {
                title: (items) => 'Request #' + items[0].parsed.x,
                label: (ctx) => {
                  const d = ctx.raw;
                  if (ctx.dataset.label === 'Still waiting') {
                    return 'Still waiting: ' + d.y;
                  }
                  const lines = [
                    ctx.dataset.label + ': ' + d.y.toFixed(2) + 's',
                  ];
                  if (d.tacoTime) {
                    lines.push('TACo: ' + d.tacoTime.toFixed(2) + 's');
                  }
                  if (d.error) {
                    lines.push('Error: ' + d.error.slice(0, 50));
                  }
                  return lines;
                },
              },
            },
            annotation: timelineP50 ? {
              annotations: {
                p50Line: {
                  type: 'line',
                  yMin: timelineP50,
                  yMax: timelineP50,
                  borderColor: 'rgba(150, 255, 94, 0.5)',
                  borderWidth: 2,
                  borderDash: [5, 5],
                  label: {
                    display: true,
                    content: 'p50: ' + timelineP50.toFixed(1) + 's',
                    position: 'start',
                    backgroundColor: 'rgba(0,0,0,0.7)',
                    color: '#96FF5E',
                  },
                },
                p95Line: {
                  type: 'line',
                  yMin: timelineP95,
                  yMax: timelineP95,
                  borderColor: 'rgba(255, 167, 38, 0.5)',
                  borderWidth: 2,
                  borderDash: [5, 5],
                  label: {
                    display: true,
                    content: 'p95: ' + timelineP95.toFixed(1) + 's',
                    position: 'start',
                    backgroundColor: 'rgba(0,0,0,0.7)',
                    color: '#ffa726',
                  },
                },
              },
            } : {},
          },
          scales: {
            x: {
              ...commonOptions.scales.x,
              type: 'linear',
              title: { ...commonOptions.scales.x.title, text: 'Request Number' },
              ticks: { ...commonOptions.scales.x.ticks, callback: (v) => '#' + v },
            },
            y: {
              ...commonOptions.scales.y,
              position: 'left',
              beginAtZero: true,
              title: { ...commonOptions.scales.y.title, text: 'Response Time (seconds)' },
              ticks: { ...commonOptions.scales.y.ticks, callback: (v) => v + 's' },
            },
            y2: {
              position: 'right',
              beginAtZero: true,
              grid: { display: false },
              title: { display: true, text: 'Still Waiting', color: '#909090', font: { size: 12 } },
              ticks: { color: '#606060', font: { size: 11 } },
            },
          },
        },
      });
    }

    // Steady Rate Charts
    if (steadyData.length > 0 && !isTimelineMode) {
      // Success Rate Chart
      new Chart(document.getElementById('steadySuccessChart'), {
        type: 'line',
        data: {
          labels: steadyData.map(d => d.rate + '/min'),
          datasets: [{
            label: 'Success Rate',
            data: steadyData.map(d => d.successPct),
            borderColor: '#96FF5E',
            backgroundColor: 'rgba(150, 255, 94, 0.1)',
            borderWidth: 3,
            fill: true,
            tension: 0.2,
            pointRadius: 6,
            pointHoverRadius: 8,
            pointBackgroundColor: steadyData.map(d =>
              d.successPct >= 95 ? '#96FF5E' :
              d.successPct >= 80 ? '#ffa726' : '#ef5350'
            ),
            pointBorderColor: '#000000',
            pointBorderWidth: 2,
          }],
        },
        options: {
          ...commonOptions,
          plugins: {
            ...commonOptions.plugins,
            title: { ...commonOptions.plugins.title, text: 'Success Rate vs Request Rate' },
            legend: { display: false },
            tooltip: {
              ...commonOptions.plugins.tooltip,
              callbacks: {
                title: (items) => 'Request Rate: ' + items[0].label,
                label: (ctx) => {
                  const d = steadyData[ctx.dataIndex];
                  return [
                    'Success: ' + d.successPct.toFixed(1) + '%',
                    'Succeeded: ' + d.success + ' / ' + d.total,
                    'Failed: ' + d.failed,
                  ];
                },
              },
            },
          },
          scales: {
            x: {
              ...commonOptions.scales.x,
              title: { ...commonOptions.scales.x.title, text: 'Request Rate (requests/min)' },
            },
            y: {
              ...commonOptions.scales.y,
              min: 0,
              max: 100,
              title: { ...commonOptions.scales.y.title, text: 'Success Rate (%)' },
              ticks: { ...commonOptions.scales.y.ticks, callback: (v) => v + '%' },
            },
          },
        },
      });

      // TACo Signing Time Chart (Success vs Failure)
      new Chart(document.getElementById('steadyLatencyChart'), {
        type: 'line',
        data: {
          labels: steadyData.map(d => d.rate + '/min'),
          datasets: [
            {
              label: 'Success TACo p50',
              data: steadyData.map(d => d.successP50 ? d.successP50 / 1000 : null),
              borderColor: '#96FF5E',
              backgroundColor: 'rgba(150, 255, 94, 0.1)',
              borderWidth: 3,
              fill: false,
              tension: 0.2,
              pointRadius: 6,
              pointHoverRadius: 8,
              pointBackgroundColor: '#96FF5E',
              pointBorderColor: '#000000',
              pointBorderWidth: 2,
              spanGaps: true,
            },
            {
              label: 'Success TACo p95',
              data: steadyData.map(d => d.successP95 ? d.successP95 / 1000 : null),
              borderColor: '#96FF5E',
              backgroundColor: 'rgba(150, 255, 94, 0.1)',
              borderWidth: 2,
              borderDash: [5, 5],
              fill: false,
              tension: 0.2,
              pointRadius: 4,
              pointHoverRadius: 6,
              pointBackgroundColor: '#96FF5E',
              pointBorderColor: '#000000',
              pointBorderWidth: 1,
              spanGaps: true,
            },
            {
              label: 'Failure Latency p50',
              data: steadyData.map(d => d.failureP50 ? d.failureP50 / 1000 : null),
              borderColor: '#ef5350',
              backgroundColor: 'rgba(239, 83, 80, 0.1)',
              borderWidth: 3,
              fill: false,
              tension: 0.2,
              pointRadius: 6,
              pointHoverRadius: 8,
              pointBackgroundColor: '#ef5350',
              pointBorderColor: '#000000',
              pointBorderWidth: 2,
              spanGaps: true,
            },
            {
              label: 'Failure Latency p95',
              data: steadyData.map(d => d.failureP95 ? d.failureP95 / 1000 : null),
              borderColor: '#ef5350',
              backgroundColor: 'rgba(239, 83, 80, 0.1)',
              borderWidth: 2,
              borderDash: [5, 5],
              fill: false,
              tension: 0.2,
              pointRadius: 4,
              pointHoverRadius: 6,
              pointBackgroundColor: '#ef5350',
              pointBorderColor: '#000000',
              pointBorderWidth: 1,
              spanGaps: true,
            },
          ],
        },
        options: {
          ...commonOptions,
          plugins: {
            ...commonOptions.plugins,
            title: { ...commonOptions.plugins.title, text: 'Response Time vs Request Rate' },
            tooltip: {
              ...commonOptions.plugins.tooltip,
              callbacks: {
                title: (items) => 'Request Rate: ' + items[0].label,
                label: (ctx) => ctx.parsed.y !== null ? ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + 's' : ctx.dataset.label + ': N/A',
              },
            },
          },
          scales: {
            x: {
              ...commonOptions.scales.x,
              title: { ...commonOptions.scales.x.title, text: 'Request Rate (requests/min)' },
            },
            y: {
              ...commonOptions.scales.y,
              beginAtZero: true,
              title: { ...commonOptions.scales.y.title, text: 'TACo Signing Time (seconds)' },
              ticks: { ...commonOptions.scales.y.ticks, callback: (v) => v + 's' },
            },
          },
        },
      });
    }

    // Burst Size Charts
    if (burstData.length > 0) {
      // Success Rate Chart
      new Chart(document.getElementById('burstSuccessChart'), {
        type: 'line',
        data: {
          labels: burstData.map(d => d.size + ' concurrent'),
          datasets: [{
            label: 'Success Rate',
            data: burstData.map(d => d.successPct),
            borderColor: '#96FF5E',
            backgroundColor: 'rgba(150, 255, 94, 0.1)',
            borderWidth: 3,
            fill: true,
            tension: 0.2,
            pointRadius: 6,
            pointHoverRadius: 8,
            pointBackgroundColor: burstData.map(d =>
              d.successPct >= 95 ? '#96FF5E' :
              d.successPct >= 80 ? '#ffa726' : '#ef5350'
            ),
            pointBorderColor: '#000000',
            pointBorderWidth: 2,
          }],
        },
        options: {
          ...commonOptions,
          plugins: {
            ...commonOptions.plugins,
            title: { ...commonOptions.plugins.title, text: 'Success Rate vs Burst Size' },
            legend: { display: false },
            tooltip: {
              ...commonOptions.plugins.tooltip,
              callbacks: {
                title: (items) => 'Burst Size: ' + items[0].label,
                label: (ctx) => {
                  const d = burstData[ctx.dataIndex];
                  return [
                    'Success: ' + d.successPct.toFixed(1) + '%',
                    'Succeeded: ' + d.success + ' / ' + d.total,
                    'Failed: ' + d.failed,
                  ];
                },
              },
            },
          },
          scales: {
            x: {
              ...commonOptions.scales.x,
              title: { ...commonOptions.scales.x.title, text: 'Burst Size (concurrent requests)' },
            },
            y: {
              ...commonOptions.scales.y,
              min: 0,
              max: 100,
              title: { ...commonOptions.scales.y.title, text: 'Success Rate (%)' },
              ticks: { ...commonOptions.scales.y.ticks, callback: (v) => v + '%' },
            },
          },
        },
      });

      // Response Time Chart (Success vs Failure)
      new Chart(document.getElementById('burstLatencyChart'), {
        type: 'line',
        data: {
          labels: burstData.map(d => d.size + ' concurrent'),
          datasets: [
            {
              label: 'Success TACo p50',
              data: burstData.map(d => d.successP50 ? d.successP50 / 1000 : null),
              borderColor: '#96FF5E',
              backgroundColor: 'rgba(150, 255, 94, 0.1)',
              borderWidth: 3,
              fill: false,
              tension: 0.2,
              pointRadius: 6,
              pointHoverRadius: 8,
              pointBackgroundColor: '#96FF5E',
              pointBorderColor: '#000000',
              pointBorderWidth: 2,
              spanGaps: true,
            },
            {
              label: 'Success TACo p95',
              data: burstData.map(d => d.successP95 ? d.successP95 / 1000 : null),
              borderColor: '#96FF5E',
              backgroundColor: 'rgba(150, 255, 94, 0.1)',
              borderWidth: 2,
              borderDash: [5, 5],
              fill: false,
              tension: 0.2,
              pointRadius: 4,
              pointHoverRadius: 6,
              pointBackgroundColor: '#96FF5E',
              pointBorderColor: '#000000',
              pointBorderWidth: 1,
              spanGaps: true,
            },
            {
              label: 'Failure Latency p50',
              data: burstData.map(d => d.failureP50 ? d.failureP50 / 1000 : null),
              borderColor: '#ef5350',
              backgroundColor: 'rgba(239, 83, 80, 0.1)',
              borderWidth: 3,
              fill: false,
              tension: 0.2,
              pointRadius: 6,
              pointHoverRadius: 8,
              pointBackgroundColor: '#ef5350',
              pointBorderColor: '#000000',
              pointBorderWidth: 2,
              spanGaps: true,
            },
            {
              label: 'Failure Latency p95',
              data: burstData.map(d => d.failureP95 ? d.failureP95 / 1000 : null),
              borderColor: '#ef5350',
              backgroundColor: 'rgba(239, 83, 80, 0.1)',
              borderWidth: 2,
              borderDash: [5, 5],
              fill: false,
              tension: 0.2,
              pointRadius: 4,
              pointHoverRadius: 6,
              pointBackgroundColor: '#ef5350',
              pointBorderColor: '#000000',
              pointBorderWidth: 1,
              spanGaps: true,
            },
          ],
        },
        options: {
          ...commonOptions,
          plugins: {
            ...commonOptions.plugins,
            title: { ...commonOptions.plugins.title, text: 'Response Time vs Burst Size' },
            tooltip: {
              ...commonOptions.plugins.tooltip,
              callbacks: {
                title: (items) => 'Burst Size: ' + items[0].label,
                label: (ctx) => ctx.parsed.y !== null ? ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + 's' : ctx.dataset.label + ': N/A',
              },
            },
          },
          scales: {
            x: {
              ...commonOptions.scales.x,
              title: { ...commonOptions.scales.x.title, text: 'Burst Size (concurrent requests)' },
            },
            y: {
              ...commonOptions.scales.y,
              beginAtZero: true,
              title: { ...commonOptions.scales.y.title, text: 'TACo Signing Time (seconds)' },
              ticks: { ...commonOptions.scales.y.ticks, callback: (v) => v + 's' },
            },
          },
        },
      });
    }

    // Notes persistence using localStorage
    const reportId = '${data.timestamp}';
    const notesKey = 'stress-test-notes-' + reportId;
    const notesTextarea = document.getElementById('reportNotes');
    const notesSaved = document.getElementById('notesSaved');

    // Load saved notes
    const savedNotes = localStorage.getItem(notesKey);
    if (savedNotes) {
      notesTextarea.value = savedNotes;
    }

    // Save notes on change (debounced)
    let saveTimeout;
    notesTextarea.addEventListener('input', () => {
      clearTimeout(saveTimeout);
      notesSaved.textContent = 'Saving...';
      saveTimeout = setTimeout(() => {
        localStorage.setItem(notesKey, notesTextarea.value);
        notesSaved.textContent = 'Saved';
        setTimeout(() => { notesSaved.textContent = ''; }, 2000);
      }, 500);
    });
  </script>
</body>
</html>`;
}

function saveReport(data: TestData, outputPath?: string): string {
  ensureResultsDirs();
  const html = generateHtmlReport(data);
  const filepath =
    outputPath || path.join(REPORTS_DIR, `${generateTimestamp()}.html`);
  fs.writeFileSync(filepath, html);
  return filepath;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));

  // Handle --from-data: regenerate report from existing data
  if (cliOptions.fromData) {
    const dataPath = cliOptions.fromData;
    if (!fs.existsSync(dataPath)) {
      console.error(`Error: Data file not found: ${dataPath}`);
      process.exit(1);
    }
    console.log(`[stress-test] Loading test data from: ${dataPath}`);
    const data = loadTestData(dataPath);
    const reportPath = saveReport(data, cliOptions.output);
    console.log(`[stress-test] Report generated: ${reportPath}`);
    process.exit(0);
  }

  // Handle --regenerate: regenerate report from latest data
  if (cliOptions.regenerate) {
    const latestData = getLatestDataFile();
    if (!latestData) {
      console.error("Error: No test data found in stress-test-results/data/");
      process.exit(1);
    }
    console.log(`[stress-test] Loading latest test data: ${latestData}`);
    const data = loadTestData(latestData);
    const reportPath = saveReport(data, cliOptions.output);
    console.log(`[stress-test] Report generated: ${reportPath}`);
    process.exit(0);
  }

  if (!cliOptions.config) {
    console.log(`
TACo Stress Test Tool

Usage:
  npx tsx scripts/stress-test.ts --config=<file.yml> [options]
  npx tsx scripts/stress-test.ts --from-data=<file.json> [--output=<file.html>]
  npx tsx scripts/stress-test.ts --regenerate [--output=<file.html>]

Options:
  --config=<file>     Config file with payloads and defaults (required for running tests)
  --mode=<mode>       steady, burst, or sweep (default: steady)
  --rate=<n>          Requests per minute for steady / burst size for burst (default: 1)
  --duration=<sec>    Duration per rate level for steady mode (default: 60)
  --requests=<n>      Fixed request count (overrides duration)
  --rates=<list>      Comma-separated rates for sweep mode steady tests
  --max-duration=<s>  Max test duration in seconds (steady mode stop condition)
  --max-failures=<n>  Max consecutive failures before stopping (steady mode stop condition)
  --output=<file>     Custom output path for report (default: stress-test-results/reports/)
  --from-data=<file>  Generate report from existing test data JSON file
  --regenerate        Generate report from the most recent test data

Modes:
  steady    Fire requests at a fixed rate (e.g., 1 request/sec = 1 request every 1s)
            With --max-duration or --max-failures, generates a timeline report
  burst     Fire N requests simultaneously, wait for all to complete, repeat
  sweep     Run all steady rate tests, then all burst size tests (recommended)

Output:
  Test data is saved to:    stress-test-results/data/<timestamp>.json
  Reports are saved to:     stress-test-results/reports/<timestamp>.html

  You can regenerate reports from saved data without re-running tests:
    --from-data=stress-test-results/data/2024-01-15-143000.json
    --regenerate  (uses most recent data file)

Examples:
  # Run a full sweep test
  npx tsx scripts/stress-test.ts --config=stress-test.config.yml --mode=sweep

  # Run a specific test
  npx tsx scripts/stress-test.ts --config=stress-test.config.yml --mode=steady --rate=5 --duration=120

  # Run steady mode with stop conditions (generates timeline report)
  npx tsx scripts/stress-test.ts --config=stress-test.config.yml --rate=6 --max-duration=300 --max-failures=5

  # Regenerate report from saved data
  npx tsx scripts/stress-test.ts --regenerate
  npx tsx scripts/stress-test.ts --from-data=stress-test-results/data/2024-01-15-143000.json
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
    cooldown,
    timeout,
    maxDuration,
    maxConsecutiveFailures,
    output,
  } = loadConfig(cliOptions);

  // Set global timeout for request executor
  REQUEST_TIMEOUT_SECONDS = timeout;

  console.log("[stress-test] TACo Stress Test Tool");
  console.log(`[stress-test] Config: ${cliOptions.config}`);
  console.log(`[stress-test] Mode: ${mode}`);
  console.log(`[stress-test] Payloads: ${config.payloads.length}`);
  console.log(`[stress-test] Timeout: ${timeout}s`);
  console.log(`[stress-test] Cooldown: ${cooldown}s`);

  await initializeClients();

  // Pre-compute all expensive setup once (smart accounts, recipient addresses, etc.)
  const preparedPayloads = await prepareAllPayloads(config.payloads);

  const steadyResults: RunResult[] = [];
  const burstResults: RunResult[] = [];

  if (mode === "sweep") {
    console.log(`\n[stress-test] Starting sweep mode`);
    console.log(`[stress-test] Steady rates: ${rates.join(", ")} requests/min`);
    console.log(`[stress-test] Burst sizes: ${burstSizes.join(", ")}`);
    console.log(`[stress-test] Duration per steady rate: ${duration}s`);
    console.log(`[stress-test] Batches per burst size: ${batchesPerBurst}\n`);

    // Run all steady rate tests first
    console.log("\n" + "=".repeat(60));
    console.log("              STEADY RATE TESTS");
    console.log("=".repeat(60));

    for (const testRate of rates) {
      console.log(`\n${"─".repeat(60)}`);
      console.log(`Steady @ ${testRate} requests/min`);
      console.log("─".repeat(60));
      const steadyResult = await runSteadyMode(preparedPayloads, {
        rate: testRate,
        duration,
        requestCount: requests,
      });
      steadyResults.push(
        printResults(steadyResult.results, "steady", testRate),
      );

      if (testRate !== rates[rates.length - 1]) {
        console.log(
          `\n[stress-test] Cooling down ${cooldown}s before next rate...\n`,
        );
        await sleep(cooldown * 1000);
      }
    }

    // Cooldown between steady and burst sections
    console.log(
      `\n[stress-test] Cooling down ${cooldown}s before burst tests...\n`,
    );
    await sleep(cooldown * 1000);

    // Then run all burst tests
    console.log("\n\n" + "=".repeat(60));
    console.log("              BURST SIZE TESTS");
    console.log("=".repeat(60));

    for (const burstSize of burstSizes) {
      console.log(`\n${"─".repeat(60)}`);
      console.log(`Burst size ${burstSize} (${batchesPerBurst} batches)`);
      console.log("─".repeat(60));
      const results = await runBurstMode(
        preparedPayloads,
        burstSize,
        batchesPerBurst,
      );
      burstResults.push(printResults(results, "burst", burstSize));

      if (burstSize !== burstSizes[burstSizes.length - 1]) {
        console.log(
          `\n[stress-test] Cooling down ${cooldown}s before next burst size...\n`,
        );
        await sleep(cooldown * 1000);
      }
    }

    // Summary
    console.log("\n\n" + "=".repeat(60));
    console.log("                    SWEEP SUMMARY");
    console.log("=".repeat(60));

    console.log("\nSteady Rate Results:");
    console.log("Rate       | Requests | Success % | Latency p50 | TACo p50");
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
      preparedPayloads,
      burstSize,
      batchesPerBurst,
    );
    burstResults.push(printResults(results, "burst", burstSize));
  } else {
    const steadyResult = await runSteadyMode(preparedPayloads, {
      rate,
      duration,
      requestCount: requests,
      maxDuration,
      maxConsecutiveFailures,
    });
    const runResult = printResults(steadyResult.results, "steady", rate);
    // Add timeline data for steady mode reports
    runResult.timeline = steadyResult.timeline;
    runResult.stopReason = steadyResult.stopReason;
    runResult.consecutiveFailuresAtStop =
      steadyResult.consecutiveFailuresAtStop;
    steadyResults.push(runResult);
  }

  // Save test data (always)
  const testData: TestData = {
    version: 1,
    timestamp: new Date().toISOString(),
    config: {
      mode,
      rate,
      duration,
      rates,
      burstSizes,
      batchesPerBurst,
      maxDuration,
      maxConsecutiveFailures,
    },
    steadyResults,
    burstResults,
  };

  const dataPath = saveTestData(testData);
  console.log(`\n[stress-test] Test data saved to: ${dataPath}`);

  // Generate report
  const reportPath = saveReport(testData, output);
  console.log(`[stress-test] Report saved to: ${reportPath}`);

  console.log("\n[stress-test] Done!");
  process.exit(0);
}

main().catch((err) => {
  console.error("[stress-test] Fatal error:", err);
  process.exit(1);
});
