#!/usr/bin/env node

import {
  Implementation,
  toMetaMaskSmartAccount,
} from "@metamask/delegation-toolkit";
import { Domain, SigningCoordinatorAgent } from "@nucypher/shared";
import {
  conditions,
  domains,
  initialize,
  signUserOp,
  UserOperationToSign,
} from "@nucypher/taco";
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import {
  Address,
  createPublicClient,
  encodeFunctionData,
  http,
  PublicClient,
} from "viem";
import {
  createBundlerClient,
  createPaymasterClient,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { createViemTacoAccount } from "./taco-account";

dotenv.config();

// Base mainnet RPC URL for gas estimation
const BASE_MAINNET_RPC_URL =
  process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";

/**
 * Decode revert reason from hex-encoded error data.
 * Handles Error(string) format (selector 0x08c379a0).
 */
function decodeRevertReason(hexData: string): string | null {
  try {
    // Error(string) selector
    if (hexData.startsWith("0x08c379a0")) {
      const abiCoder = new ethers.utils.AbiCoder();
      const decoded = abiCoder.decode(
        ["string"],
        "0x" + hexData.slice(10), // Skip selector (4 bytes = 8 hex chars + 0x)
      );
      return decoded[0];
    }
    // Panic(uint256) selector
    if (hexData.startsWith("0x4e487b71")) {
      const abiCoder = new ethers.utils.AbiCoder();
      const decoded = abiCoder.decode(["uint256"], "0x" + hexData.slice(10));
      const panicCodes: Record<number, string> = {
        0x00: "Generic compiler panic",
        0x01: "Assertion failed",
        0x11: "Arithmetic overflow/underflow",
        0x12: "Division by zero",
        0x21: "Invalid enum value",
        0x22: "Invalid storage access",
        0x31: "Pop on empty array",
        0x32: "Array index out of bounds",
        0x41: "Out of memory",
        0x51: "Uninitialized function pointer",
      };
      return panicCodes[decoded[0].toNumber()] || `Panic code: ${decoded[0]}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse error message and return user-friendly description.
 */
function getUserFriendlyError(error: unknown, tokenType: string): string {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Try to extract and decode hex revert reason
  const hexMatch = errorMessage.match(/0x[0-9a-fA-F]{8,}/);
  if (hexMatch) {
    const decoded = decodeRevertReason(hexMatch[0]);
    if (decoded) {
      // Map common errors to user-friendly messages
      if (decoded.includes("transfer amount exceeds balance")) {
        return `Insufficient ${tokenType} balance. The sender's wallet doesn't have enough ${tokenType} to complete this transfer.`;
      }
      if (decoded.includes("insufficient allowance")) {
        return `Insufficient ${tokenType} allowance. The token approval is too low.`;
      }
      if (decoded.includes("exceeds allowance")) {
        return `${tokenType} transfer exceeds approved allowance.`;
      }
      // Return decoded message if no specific mapping
      return `Transaction failed: ${decoded}`;
    }
  }

  // Handle common error patterns
  if (errorMessage.includes("insufficient funds")) {
    return "Insufficient ETH for gas fees. Please fund the smart account with more ETH.";
  }
  if (errorMessage.includes("nonce")) {
    return "Transaction nonce error. Please try again.";
  }
  if (errorMessage.includes("gas")) {
    return "Gas estimation failed. The transaction may not be valid.";
  }

  // Truncate very long error messages
  if (errorMessage.length > 200) {
    return errorMessage.substring(0, 200) + "...";
  }

  return errorMessage;
}

/**
 * Fetch current gas price from Base mainnet for cost estimation.
 * Returns 0n on failure (graceful degradation).
 */
async function getMainnetGasPrice(): Promise<bigint> {
  try {
    const mainnetClient = createPublicClient({
      chain: {
        id: 8453,
        name: "Base",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [BASE_MAINNET_RPC_URL] } },
      } as const,
      transport: http(BASE_MAINNET_RPC_URL),
    });
    const gasPrice = await mainnetClient.getGasPrice();
    console.log(`[Gas] Mainnet gas price: ${gasPrice} wei`);
    return gasPrice;
  } catch (err) {
    console.warn("[Gas] Failed to fetch mainnet gas price:", err);
    return BigInt(0);
  }
}

/**
 * Fetch ETH/USD price from CoinGecko API for cost estimation.
 * Returns 0 on failure (graceful degradation).
 */
async function getEthUsdPrice(): Promise<number> {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    );
    const data = (await response.json()) as { ethereum?: { usd?: number } };
    const price = data?.ethereum?.usd ?? 0;
    console.log(`[Gas] ETH/USD price: $${price}`);
    return price;
  } catch (err) {
    console.warn("[Gas] Failed to fetch ETH/USD price:", err);
    return 0;
  }
}

// Token list API for contract address lookup
const TOKEN_LIST_API_URL =
  process.env.TOKEN_LIST_API_URL ||
  "https://tokens.coingecko.com/base-sepolia/all.json";

// Fallback token addresses (used if API lookup fails)
const FALLBACK_TOKEN_ADDRESSES: Record<string, Record<number, Address>> = {
  USDC: {
    84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address, // Base Sepolia
    8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address, // Base Mainnet
  },
};

// ERC20 decimals function ABI
const ERC20_DECIMALS_ABI = [
  {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
  },
] as const;

/**
 * Fetch token contract address from token list API.
 * Falls back to hardcoded addresses if API fails.
 */
async function getTokenAddress(
  tokenSymbol: string,
  chainId: number,
): Promise<Address> {
  // Normalize token symbol
  const symbol = tokenSymbol.toUpperCase();

  try {
    // Try API lookup first
    const response = await fetch(TOKEN_LIST_API_URL);
    if (response.ok) {
      const data = (await response.json()) as {
        tokens?: Array<{
          symbol: string;
          address: string;
          chainId?: number;
        }>;
      };
      const token = data.tokens?.find(
        (t) =>
          t.symbol.toUpperCase() === symbol &&
          (t.chainId === chainId || !t.chainId),
      );
      if (token?.address) {
        console.log(
          `[Token] Found ${symbol} address from API: ${token.address}`,
        );
        return token.address as Address;
      }
    }
  } catch (err) {
    console.warn(`[Token] API lookup failed for ${symbol}:`, err);
  }

  // Fallback to hardcoded addresses
  const fallback = FALLBACK_TOKEN_ADDRESSES[symbol]?.[chainId];
  if (fallback) {
    console.log(`[Token] Using fallback address for ${symbol}: ${fallback}`);
    return fallback;
  }

  throw new Error(
    `Unknown token ${symbol} on chain ${chainId}. No API result or fallback available.`,
  );
}

/**
 * Fetch token decimals from the token contract.
 * Returns 18 for ETH, calls decimals() for ERC20 tokens.
 */
async function getTokenDecimals(
  tokenSymbol: string,
  tokenAddress: Address,
  provider: ethers.providers.JsonRpcProvider,
): Promise<number> {
  const symbol = tokenSymbol.toUpperCase();

  // ETH always has 18 decimals
  if (symbol === "ETH") {
    return 18;
  }

  try {
    const contract = new ethers.Contract(
      tokenAddress,
      ["function decimals() view returns (uint8)"],
      provider,
    );
    const decimals = await contract.decimals();
    console.log(`[Token] ${symbol} decimals: ${decimals}`);
    return decimals;
  } catch (err) {
    console.warn(`[Token] Failed to fetch decimals for ${symbol}:`, err);
    // Common fallbacks
    if (symbol === "USDC" || symbol === "USDT") return 6;
    return 18;
  }
}

// ERC20 transfer function signature
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

// Configuration
const BASE_SEPOLIA_CHAIN_ID = 84532;
const TACO_DOMAIN: Domain =
  (process.env.TACO_DOMAIN as Domain) || domains.DEVNET;
const COHORT_ID = parseInt(process.env.COHORT_ID || "3", 10);
// Base Sepolia child coordinator address (hardcoded like TACoCollab)
const SIGNING_COORDINATOR_CHILD_ADDRESS =
  "0xcc537b292d142dABe2424277596d8FFCC3e6A12D";
const AA_VERSION = "mdt";

/**
 * Creates a TACo-enabled smart account
 */
async function createTacoSmartAccount(
  publicClient: PublicClient,
  signingCoordinatorProvider: ethers.providers.JsonRpcProvider,
  signingChainProvider: ethers.providers.JsonRpcProvider,
  deploySalt: `0x${string}` = "0x",
) {
  await initialize();

  // Fetch cohort multisig address from L2 child coordinator (like TACoCollab)
  const coordinator = new ethers.Contract(
    SIGNING_COORDINATOR_CHILD_ADDRESS,
    ["function cohortMultisigs(uint32) view returns (address)"],
    signingChainProvider,
  );
  const cohortMultisigAddress = await coordinator.cohortMultisigs(COHORT_ID);
  console.log(`Cohort multisig address: ${cohortMultisigAddress}`);

  // Fetch participants and threshold from parent coordinator (Ethereum Sepolia)
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
  // The signerAddress is the signer address for the cohort
  const signers = participants.map((p) => p.signerAddress as Address);

  // Create TACo account using cohort's multisig address
  const tacoAccount = createViemTacoAccount(cohortMultisigAddress as Address);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const smartAccount = await (toMetaMaskSmartAccount as any)({
    client: publicClient,
    implementation: Implementation.MultiSig,
    deployParams: [signers, BigInt(threshold)],
    deploySalt,
    signatory: [{ account: tacoAccount }],
  });

  return { smartAccount, threshold, signers, cohortMultisigAddress };
}

/**
 * Derives deterministic AA address for a Discord user.
 * Uses: keccak256("{DISCORD_USER_ID}|Discord|Collab.Land")
 *
 * The Discord ID comes first to match TaCo's += operation order
 * (variable + value = discordId + "|Discord|Collab.Land")
 */
async function deriveDiscordUserAA(
  publicClient: PublicClient,
  signingCoordinatorProvider: ethers.providers.JsonRpcProvider,
  signingChainProvider: ethers.providers.JsonRpcProvider,
  discordUserId: string,
): Promise<Address> {
  const collablandId = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(`${discordUserId}|Discord|Collab.Land`),
  ) as `0x${string}`;

  const { smartAccount } = await createTacoSmartAccount(
    publicClient,
    signingCoordinatorProvider,
    signingChainProvider,
    collablandId,
  );

  return smartAccount.address;
}

/**
 * Signs a UserOp with TACo using Discord context for condition evaluation.
 * AA addresses are derived within the TACo conditions from Discord user IDs.
 */
async function signUserOpWithTaco(
  userOp: Record<string, unknown>,
  provider: ethers.providers.JsonRpcProvider,
  discordContext: {
    timestamp: string;
    signature: string;
    payload: string;
  },
) {
  console.log("[TACo] Fetching signing context from cohort...");
  console.log(
    `[TACo] Domain: ${TACO_DOMAIN}, Cohort: ${COHORT_ID}, Chain: ${BASE_SEPOLIA_CHAIN_ID}`,
  );

  // Get the signing context from the cohort
  const signingContext =
    await conditions.context.ConditionContext.forSigningCohort(
      provider,
      TACO_DOMAIN,
      COHORT_ID,
      BASE_SEPOLIA_CHAIN_ID,
    );
  console.log("[TACo] Signing context fetched successfully");

  // Add our context parameters for condition evaluation
  (signingContext as any).customContextParameters = {
    ":timestamp": discordContext.timestamp,
    ":signature": discordContext.signature,
    ":discordPayload": discordContext.payload,
  };

  console.log("[TACo] Context parameters:");
  console.log("  :timestamp =", discordContext.timestamp);
  console.log("  :signature =", discordContext.signature);
  console.log("  :discordPayload =", discordContext.payload);

  // Log request payload size
  const requestPayload = {
    userOp,
    contextParameters: (signingContext as any).customContextParameters,
  };
  const payloadJson = JSON.stringify(requestPayload, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const payloadSizeFormatted =
    payloadBytes >= 1024 * 1024
      ? `${(payloadBytes / (1024 * 1024)).toFixed(2)} MB`
      : payloadBytes >= 1024
        ? `${(payloadBytes / 1024).toFixed(2)} KB`
        : `${payloadBytes} bytes`;
  console.log(`[TACo] Request payload size: ${payloadSizeFormatted}`);

  console.log("[TACo] Calling signUserOp...");
  const startTime = Date.now();
  try {
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

    // Log response payload size
    const responseJson = JSON.stringify(result, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    const responseBytes = Buffer.byteLength(responseJson, "utf8");
    const responseSizeFormatted =
      responseBytes >= 1024 * 1024
        ? `${(responseBytes / (1024 * 1024)).toFixed(2)} MB`
        : responseBytes >= 1024
          ? `${(responseBytes / 1024).toFixed(2)} KB`
          : `${responseBytes} bytes`;
    console.log(`[TACo] Response payload size: ${responseSizeFormatted}`);

    console.log(`[TACo] signUserOp succeeded in ${signingTimeMs}ms`);
    console.log(`TACO_SIGNING_TIME_MS:${signingTimeMs}`);
    return { ...result, signingTimeMs };
  } catch (err) {
    const signingTimeMs = Date.now() - startTime;
    console.log(`TACO_SIGNING_TIME_MS:${signingTimeMs}`);
    console.error("[TACo] ERROR in signUserOp:", err);
    throw err;
  }
}

async function logBalances(
  provider: ethers.providers.JsonRpcProvider,
  eoaAddress: string,
  smartAccountAddress: string,
) {
  const eoaBalance = await provider.getBalance(eoaAddress);
  const smartAccountBalance = await provider.getBalance(smartAccountAddress);
  console.log(`\nEOA Balance: ${ethers.utils.formatEther(eoaBalance)} ETH`);
  console.log(
    `Smart Account: ${ethers.utils.formatEther(smartAccountBalance)} ETH\n`,
  );
}

async function main() {
  // Handle balance check mode
  if (process.env.MODE === "balance") {
    try {
      const discordUserId = process.env.DISCORD_USER_ID;
      if (!discordUserId) {
        throw new Error("DISCORD_USER_ID required for balance check");
      }

      const signingChainProvider = new ethers.providers.JsonRpcProvider(
        process.env.SIGNING_CHAIN_RPC_URL!,
      );
      const signingCoordinatorProvider = new ethers.providers.JsonRpcProvider(
        process.env.ETH_RPC_URL!,
      );
      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(process.env.SIGNING_CHAIN_RPC_URL),
      });

      const aaAddress = await deriveDiscordUserAA(
        publicClient as any,
        signingCoordinatorProvider,
        signingChainProvider,
        discordUserId,
      );

      const ethBalance = await signingChainProvider.getBalance(aaAddress);
      const usdcAddress = FALLBACK_TOKEN_ADDRESSES.USDC[84532];
      const usdcContract = new ethers.Contract(
        usdcAddress,
        ["function balanceOf(address) view returns (uint256)"],
        signingChainProvider,
      );
      const usdcBalance = await usdcContract.balanceOf(aaAddress);

      console.log(
        `BALANCE:${JSON.stringify({
          discordUserId,
          aaAddress,
          eth: ethers.utils.formatEther(ethBalance),
          usdc: ethers.utils.formatUnits(usdcBalance, 6),
        })}`,
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`BALANCE_ERROR:${JSON.stringify({ error: message })}`);
      process.exit(1);
    }
  }

  let tokenType = "ETH"; // Default, will be updated from Discord payload
  try {
    // Validate required Discord context
    const discordTimestamp = process.env.CONTEXT_TIMESTAMP;
    const discordSignature = process.env.CONTEXT_SIGNATURE_HEX;
    const discordPayload = process.env.CONTEXT_DISCORD_PAYLOAD;
    const recipientUserId = process.env.TIP_RECIPIENT_USER_ID;
    const recipientAddress = process.env.TIP_RECIPIENT_ADDRESS;

    if (
      !discordTimestamp ||
      !discordSignature ||
      !discordPayload ||
      (!recipientUserId && !recipientAddress)
    ) {
      throw new Error(
        "Missing Discord context. Required: CONTEXT_TIMESTAMP, CONTEXT_SIGNATURE_HEX, CONTEXT_DISCORD_PAYLOAD, and TIP_RECIPIENT_USER_ID or TIP_RECIPIENT_ADDRESS",
      );
    }

    // Setup providers (matching TACoCollab pattern)
    const chain = baseSepolia;

    // L2 provider for signing chain (Base Sepolia)
    const signingChainProvider = new ethers.providers.JsonRpcProvider(
      process.env.SIGNING_CHAIN_RPC_URL!,
    );

    // L1 provider for SigningCoordinatorAgent (Ethereum Sepolia)
    const signingCoordinatorProvider = new ethers.providers.JsonRpcProvider(
      process.env.ETH_RPC_URL!,
    );

    const localAccount = privateKeyToAccount(
      process.env.PRIVATE_KEY as `0x${string}`,
    );
    const publicClient = createPublicClient({
      chain,
      transport: http(process.env.SIGNING_CHAIN_RPC_URL),
    });

    const paymasterClient = createPaymasterClient({
      transport: http(process.env.BUNDLER_URL),
    });
    const bundlerClient = createBundlerClient({
      transport: http(process.env.BUNDLER_URL),
      paymaster: paymasterClient,
      chain,
    });

    // Parse Discord payload to get sender ID first (needed for AA derivation)
    const parsed = JSON.parse(discordPayload);
    const senderDiscordId = String(parsed?.member?.user?.id || "");
    if (!senderDiscordId) {
      throw new Error("Missing member.user.id in Discord payload");
    }

    // Derive sender's salt for AA address using same formula as TACo conditions
    const senderSalt = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(`${senderDiscordId}|Discord|Collab.Land`),
    ) as `0x${string}`;

    // Create smart account with sender's derived salt
    console.log("Creating TACo smart account...\n");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { smartAccount, threshold } = await createTacoSmartAccount(
      publicClient as any,
      signingCoordinatorProvider,
      signingChainProvider,
      senderSalt,
    );
    console.log(`Smart account: ${smartAccount.address}`);
    console.log(`Threshold: ${threshold} signatures required\n`);

    await logBalances(
      signingChainProvider,
      localAccount.address,
      smartAccount.address,
    );

    // Fund smart account if needed
    const smartAccountBalance = await signingChainProvider.getBalance(
      smartAccount.address,
    );
    const minBalance = ethers.utils.parseEther(
      process.env.MIN_SA_BALANCE_ETH || "0.0002",
    );

    if (smartAccountBalance.lt(minBalance)) {
      const fundingPk = (process.env.BOT_FUNDING_PRIVATE_KEY ||
        process.env.PRIVATE_KEY) as string;
      console.log("Funding smart account...");
      const fundingWallet = new ethers.Wallet(fundingPk, signingChainProvider);
      // Use 'pending' nonce to account for any in-flight transactions
      const nonce = await fundingWallet.getTransactionCount("pending");
      try {
        const fundTx = await fundingWallet.sendTransaction({
          to: smartAccount.address,
          value: ethers.utils.parseEther(
            process.env.FUNDING_AMOUNT_ETH || "0.001",
          ),
          nonce,
        });
        console.log(`Funding tx sent: ${fundTx.hash}`);
        await fundTx.wait();
        console.log(`Funded!\n`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("already known") || errMsg.includes("nonce")) {
          console.log("Funding tx already pending, continuing...\n");
        } else {
          throw err;
        }
      }
      await logBalances(
        signingChainProvider,
        localAccount.address,
        smartAccount.address,
      );
    }

    // Navigate to the execute subcommand options (nested structure)
    const executeCmd = parsed?.data?.options?.find(
      (o: { name: string }) => o?.name === "execute",
    );
    const sendCmd = parsed?.data?.options?.find(
      (o: { name: string }) => o?.name === "send",
    );
    const activeCmd = executeCmd || sendCmd;
    const opts = activeCmd?.options || [];
    const amountOpt = opts.find(
      (o: { name: string }) => o?.name === "amount",
    )?.value;
    const tokenOpt = opts.find(
      (o: { name: string }) => o?.name === "token",
    )?.value;
    tokenType = String(tokenOpt ?? process.env.TIP_TOKEN_TYPE ?? "ETH");

    // Get token address and decimals dynamically
    let tokenAddress: Address | null = null;
    let tokenDecimals = 18;

    if (tokenType !== "ETH") {
      tokenAddress = await getTokenAddress(tokenType, BASE_SEPOLIA_CHAIN_ID);
      tokenDecimals = await getTokenDecimals(
        tokenType,
        tokenAddress,
        signingChainProvider,
      );
      console.log(
        `[Token] ${tokenType} address: ${tokenAddress}, decimals: ${tokenDecimals}`,
      );
    }

    // Parse amount based on token decimals
    const amountStr = String(
      amountOpt ?? process.env.TIP_AMOUNT_ETH ?? "0.0001",
    );
    const transferAmount = ethers.utils.parseUnits(amountStr, tokenDecimals);

    let recipientAA: Address;
    if (recipientAddress) {
      // Direct ETH address (from /taco send)
      console.log(`Using direct recipient address: ${recipientAddress}`);
      recipientAA = recipientAddress as Address;
    } else {
      // Discord user ID (from /taco execute) — derive AA address
      console.log(
        `Deriving recipient AA for Discord user ${recipientUserId}...`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recipientAA = await deriveDiscordUserAA(
        publicClient as any,
        signingCoordinatorProvider,
        signingChainProvider,
        recipientUserId!,
      );
    }
    console.log(`Recipient: ${recipientAA}\n`);

    // Prepare user operation calls based on token type
    console.log("Preparing user operation...");
    const formattedTransferAmount = ethers.utils.formatUnits(
      transferAmount,
      tokenDecimals,
    );
    console.log(`Transfer: ${formattedTransferAmount} ${tokenType}\n`);

    // Build calls array based on token type
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userOp = await (bundlerClient as any).prepareUserOperation({
      account: smartAccount,
      calls,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 3_000_000_000n,
      verificationGasLimit: BigInt(500_000),
    });

    // Sign with TACo
    // AA addresses are derived within TACo conditions from Discord user IDs
    console.log("Signing with TACo...");
    const discordContext = {
      timestamp: discordTimestamp,
      signature: discordSignature.replace(/^0x/, ""),
      payload: discordPayload,
    };
    const signature = await signUserOpWithTaco(
      userOp,
      signingCoordinatorProvider,
      discordContext,
    );
    console.log(
      `Signature collected (${signature.aggregatedSignature.length / 2 - 1} bytes)\n`,
    );

    // Send transaction
    console.log("Executing transaction...");
    const userOpHash = await bundlerClient.sendUserOperation({
      ...(userOp as object),
      signature: signature.aggregatedSignature as `0x${string}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    console.log(`UserOp Hash: ${userOpHash}`);

    const { receipt } = await bundlerClient.waitForUserOperationReceipt({
      hash: userOpHash,
    });

    // Transaction succeeded - output formatted success info
    const txHash = receipt.transactionHash;
    const explorerUrl = `https://sepolia.basescan.org/tx/${txHash}`;
    const formattedAmount = ethers.utils.formatUnits(
      transferAmount,
      tokenDecimals,
    );
    const shortenAddr = (addr: string) =>
      `${addr.slice(0, 10)}...${addr.slice(-8)}`;

    // Extract gas used from receipt (same on testnet/mainnet)
    const gasUsed = receipt.gasUsed ?? BigInt(0);

    // Fetch mainnet gas price and ETH/USD for cost estimation (in parallel)
    const [mainnetGasPrice, ethUsdPrice] = await Promise.all([
      getMainnetGasPrice(),
      getEthUsdPrice(),
    ]);

    // Calculate estimated mainnet cost in USD
    let estMainnetCostUsd = "N/A";
    if (mainnetGasPrice > 0n && ethUsdPrice > 0) {
      const estGasCostWei = gasUsed * mainnetGasPrice;
      const estGasCostEth = parseFloat(
        ethers.utils.formatEther(estGasCostWei.toString()),
      );
      estMainnetCostUsd = (estGasCostEth * ethUsdPrice).toFixed(4);
    }

    console.log("\n" + "=".repeat(60));
    console.log("                  TRANSACTION SUCCESSFUL");
    console.log("=".repeat(60));
    console.log();
    console.log(
      `  From:     ${shortenAddr(smartAccount.address)} (Discord: ${senderDiscordId})`,
    );
    console.log(
      `  To:       ${shortenAddr(recipientAA)} (Discord: ${recipientUserId})`,
    );
    console.log(`  Amount:   ${formattedAmount} ${tokenType}`);
    console.log(`  Chain:    Base Sepolia (${BASE_SEPOLIA_CHAIN_ID})`);
    console.log(`  TACo:     Signed in ${signature.signingTimeMs}ms`);
    console.log(`  Gas Used: ${gasUsed.toLocaleString()}`);
    console.log(`  Est. Mainnet Cost: $${estMainnetCostUsd}`);
    console.log();
    console.log(`  Tx:       ${txHash}`);
    console.log(`  Explorer: ${explorerUrl}`);
    console.log();
    console.log("=".repeat(60));

    // Output structured success for Discord bot parsing
    const successData = JSON.stringify({
      txHash,
      explorerUrl,
      from: smartAccount.address,
      fromDiscord: senderDiscordId,
      to: recipientAA,
      toDiscord: recipientUserId || "",
      amount: formattedAmount,
      token: tokenType,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      chainName: "Base Sepolia",
      tacoSigningMs: signature.signingTimeMs,
      gasUsed: gasUsed.toString(),
      estMainnetCostUsd,
    });
    console.log(`SUCCESS:${successData}`);
    process.exit(0);
  } catch (error: unknown) {
    const rawErrorMessage =
      error instanceof Error ? error.message : String(error);
    const userFriendlyError = getUserFriendlyError(error, tokenType);

    console.error(`Demo failed: ${rawErrorMessage}`);

    // Output structured error for Discord bot parsing
    const errorData = JSON.stringify({
      error: userFriendlyError,
      rawError:
        rawErrorMessage.length > 500
          ? rawErrorMessage.substring(0, 500) + "..."
          : rawErrorMessage,
    });
    console.log("FAILED:" + errorData);
    process.exit(1);
  }
}

if (require.main === module) {
  if (process.argv.includes("--dry-run")) {
    console.log("Syntax check passed");
    process.exit(0);
  }
  main();
}
