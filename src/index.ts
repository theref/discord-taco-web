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

// USDC contract on Base Sepolia (official Circle deployment)
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;

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
 * Uses: keccak256("{DISCORD_USER_ID}|Discord|Collabland")
 *
 * The Discord ID comes first to match TaCo's += operation order
 * (variable + value = discordId + "|Discord|Collabland")
 */
async function deriveDiscordUserAA(
  publicClient: PublicClient,
  signingCoordinatorProvider: ethers.providers.JsonRpcProvider,
  signingChainProvider: ethers.providers.JsonRpcProvider,
  discordUserId: string,
): Promise<Address> {
  const collablandId = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(`${discordUserId}|Discord|Collabland`),
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

  console.log("[TACo] Calling signUserOp...");
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
    console.log("[TACo] signUserOp succeeded");
    return result;
  } catch (err) {
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
  try {
    // Validate required Discord context
    const discordTimestamp = process.env.CONTEXT_TIMESTAMP;
    const discordSignature = process.env.CONTEXT_SIGNATURE_HEX;
    const discordPayload = process.env.CONTEXT_DISCORD_PAYLOAD;
    const recipientUserId = process.env.TIP_RECIPIENT_USER_ID;

    if (
      !discordTimestamp ||
      !discordSignature ||
      !discordPayload ||
      !recipientUserId
    ) {
      throw new Error(
        "Missing Discord context. Required: CONTEXT_TIMESTAMP, CONTEXT_SIGNATURE_HEX, CONTEXT_DISCORD_PAYLOAD, TIP_RECIPIENT_USER_ID",
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

    // Create smart account
    console.log("Creating TACo smart account...\n");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { smartAccount, threshold } = await createTacoSmartAccount(
      publicClient as any,
      signingCoordinatorProvider,
      signingChainProvider,
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

    // Parse tip parameters from Discord payload
    const parsed = JSON.parse(discordPayload);

    // Get sender's Discord ID from payload
    const senderDiscordId = String(parsed?.member?.user?.id || "");
    if (!senderDiscordId) {
      throw new Error("Missing member.user.id in Discord payload");
    }

    const opts = parsed?.data?.options || [];
    const amountOpt = opts.find(
      (o: { name: string }) => o?.name === "amount",
    )?.value;
    const tokenOpt = opts.find(
      (o: { name: string }) => o?.name === "token",
    )?.value;
    const tokenType = String(tokenOpt ?? process.env.TIP_TOKEN_TYPE ?? "ETH");
    const transferAmount = ethers.utils.parseEther(
      String(amountOpt ?? process.env.TIP_AMOUNT_ETH ?? "0.0001"),
    );

    // Derive sender AA address (the person running the command)
    console.log(`Deriving sender AA for Discord user ${senderDiscordId}...`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const senderAA = await deriveDiscordUserAA(
      publicClient as any,
      signingCoordinatorProvider,
      signingChainProvider,
      senderDiscordId,
    );
    console.log(`Sender AA: ${senderAA}`);

    // Derive recipient AA address
    console.log(`Deriving recipient AA for Discord user ${recipientUserId}...`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recipientAA = await deriveDiscordUserAA(
      publicClient as any,
      signingCoordinatorProvider,
      signingChainProvider,
      recipientUserId,
    );
    console.log(`Recipient AA: ${recipientAA}\n`);

    // Prepare user operation calls based on token type
    console.log("Preparing user operation...");
    console.log(
      `Transfer: ${ethers.utils.formatEther(transferAmount)} ${tokenType}\n`,
    );

    // Build calls array based on token type
    const calls: Array<{ to: Address; value: bigint; data?: `0x${string}` }> =
      tokenType === "USDC"
        ? [
            {
              to: USDC_ADDRESS,
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

    // Transaction succeeded - output success info for Discord bot
    const txHash = receipt.transactionHash;
    const explorerUrl = `https://sepolia.basescan.org/tx/${txHash}`;
    console.log(`\nTransaction successful!`);
    console.log(`Tx: ${txHash}`);
    console.log(`Explorer: ${explorerUrl}\n`);

    // Try to log balances but don't fail if RPC has issues
    try {
      await logBalances(
        signingChainProvider,
        localAccount.address,
        smartAccount.address,
      );
    } catch (balanceErr) {
      console.log("(Could not fetch final balances - RPC error)");
    }

    console.log("Demo completed successfully!");
    // Output structured success for Discord bot parsing
    console.log(`SUCCESS:${txHash}:${explorerUrl}`);
    process.exit(0);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Demo failed: ${errorMessage}`);
    console.log("FAILED:" + errorMessage);
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
