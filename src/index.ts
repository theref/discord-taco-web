#!/usr/bin/env node

import {
  Implementation,
  toMetaMaskSmartAccount,
} from "@metamask/delegation-toolkit";
import {
  Domain,
  SigningCoordinatorAgent,
  UserOperation,
} from "@nucypher/shared";
import { conditions, domains, initialize, signUserOp } from "@nucypher/taco";
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { Address, createPublicClient, http } from "viem";
import {
  createBundlerClient,
  createPaymasterClient,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";

import { createViemTacoAccount } from "./taco-account";
// Collab.Land Account Kit funding removed in this branch; using local EOA funding

dotenv.config();

const TACO_DOMAIN: Domain =
  (process.env.TACO_DOMAIN as Domain) || domains.DEVNET;
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "11155111", 10);
// Some TACo infra may require the parent chain for signing lookups.
// Allow overriding the chain used inside TACo signing separately.
const SIGNING_CHAIN_ID = parseInt(
  process.env.SIGNING_CHAIN_ID ||
    String(
      process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 11155111,
    ),
  10,
);
const COHORT_ID = parseInt(process.env.COHORT_ID || "1", 10);
const AA_VERSION = "mdt";

async function createTacoSmartAccount(
  publicClient: unknown,
  provider: ethers.providers.JsonRpcProvider,
) {
  await initialize();
  const participants = await SigningCoordinatorAgent.getParticipants(
    provider,
    TACO_DOMAIN,
    COHORT_ID,
  );
  const threshold = await SigningCoordinatorAgent.getThreshold(
    provider,
    TACO_DOMAIN,
    COHORT_ID,
  );
  const signers = participants.map((p) => p.operator as Address).sort();

  // Get the cohort's actual multisig contract address
  const cohortMultisigAddress =
    await SigningCoordinatorAgent.getCohortMultisigAddress(
      provider,
      TACO_DOMAIN,
      COHORT_ID,
      CHAIN_ID,
    );

  // Create a TACo account using the cohort's multisig address
  // This satisfies MetaMask's signatory requirement and uses the proper cohort multisig
  const tacoAccount = createViemTacoAccount(cohortMultisigAddress as Address);
  console.log(`🎯 Using cohort multisig: ${cohortMultisigAddress}`);

  // Type mismatch between viem client and delegation-toolkit expected client.
  // @ts-expect-error Incompatible viem Client type; safe at runtime for this demo
  const smartAccount = await toMetaMaskSmartAccount({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: publicClient as any,
    implementation: Implementation.MultiSig,
    deployParams: [signers, BigInt(threshold)],
    deploySalt: "0x" as `0x${string}`,
    signatory: [{ account: tacoAccount }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as any);

  return { smartAccount, threshold };
}

// signUserOpWithTaco helper removed; we sign inline to provide explicit context

async function logBalances(
  provider: ethers.providers.JsonRpcProvider,
  eoaAddress: string,
  smartAccountAddress: string,
) {
  const eoaBalance = await provider.getBalance(eoaAddress);
  const smartAccountBalance = await provider.getBalance(smartAccountAddress);
  console.log(`\n💳 EOA Balance: ${ethers.utils.formatEther(eoaBalance)} ETH`);
  console.log(
    `🏦 Smart Account: ${ethers.utils.formatEther(smartAccountBalance)} ETH\n`,
  );
}

async function main() {
  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL!);
    const localAccount = privateKeyToAccount(
      process.env.PRIVATE_KEY as `0x${string}`,
    );
    const selectedViemChain = CHAIN_ID === 84532 ? baseSepolia : sepolia;
    const publicClient = createPublicClient({
      chain: selectedViemChain,
      transport: http(process.env.RPC_URL),
    });

    const paymasterClient = createPaymasterClient({
      transport: http(process.env.BUNDLER_URL),
    });
    const bundlerClient = createBundlerClient({
      transport: http(process.env.BUNDLER_URL),
      paymaster: paymasterClient,
      chain: selectedViemChain,
    });

    // Gas price matching Python implementation (1,100,000 wei)
    const fee = {
      maxFeePerGas: BigInt(1_100_000),
      maxPriorityFeePerGas: BigInt(1_100_000),
    };

    console.log("🔧 Creating TACo smart account...\n");
    // No bot wallet address in EOA funding mode
    // Type cast to relax viem client type for toolkit interop in this demo
    // @ts-expect-error Viem client type mismatch acceptable in demo
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { smartAccount, threshold } = await createTacoSmartAccount(
      publicClient as any,
      provider,
    );
    console.log(`✅ Smart account created: ${smartAccount.address}`);
    console.log(`🔐 Threshold: ${threshold} signatures required\n`);

    await logBalances(provider, localAccount.address, smartAccount.address);

    const smartAccountBalance = await provider.getBalance(smartAccount.address);
    const minSa = ethers.utils.parseEther(
      process.env.MIN_SA_BALANCE_ETH || "0.001",
    );
    if (smartAccountBalance.lt(minSa)) {
      const fundingPk = (process.env.BOT_FUNDING_PRIVATE_KEY ||
        process.env.PRIVATE_KEY) as string;
      const usingBot = Boolean(process.env.BOT_FUNDING_PRIVATE_KEY);
      console.log(
        `💰 Funding smart account via ${usingBot ? "bot wallet" : "local EOA"}...`,
      );
      const fundingWallet = new ethers.Wallet(fundingPk, provider);
      const fundTx = await fundingWallet.sendTransaction({
        to: smartAccount.address,
        value: ethers.utils.parseEther(
          process.env.FUNDING_AMOUNT_ETH || "0.001",
        ),
      });
      await fundTx.wait();
      console.log(`✅ Funded successfully!\n🔗 Tx: ${fundTx.hash}`);
      await logBalances(provider, localAccount.address, smartAccount.address);
    }

    // Derive tip parameters from Discord payload if available to guarantee match
    let tipRecipient: Address =
      (process.env.TIP_RECIPIENT as Address) ||
      (localAccount.address as Address);
    // Amount is provided in ETH (string) via env or Discord; parse to wei
    let transferAmount = ethers.utils.parseEther(
      process.env.TIP_AMOUNT_ETH || "0.0001",
    );
    try {
      const rawDiscord = process.env.CONTEXT_DISCORD_PAYLOAD;
      if (rawDiscord) {
        const parsed = JSON.parse(rawDiscord);
        const opts = parsed?.data?.options || [];
        const amtOpt = opts.find((o: any) => o?.name === "amount");
        const rcptOpt = opts.find((o: any) => o?.name === "recipient");
        if (amtOpt?.value != null)
          transferAmount = ethers.utils.parseEther(String(amtOpt.value));
        if (rcptOpt?.value) tipRecipient = rcptOpt.value as Address;
      }
    } catch {
      // ignore parse errors and keep env/defaults
    }

    console.log("📝 Preparing user operation...");
    console.log(
      `💸 Transfer amount: ${ethers.utils.formatEther(transferAmount)} ETH`,
    );
    console.log(`🎯 Recipient: ${tipRecipient}\n`);

    // Use bundlerClient to prepare UserOp with proper encoding
    const userOp = await bundlerClient.prepareUserOperation({
      account: smartAccount,
      calls: [
        {
          target: tipRecipient,
          value: BigInt(transferAmount.toString()),
          data: "0x" as `0x${string}`,
        },
      ],
      ...fee,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Debug: show prepared UserOp details
    console.log("📋 Prepared UserOp:");
    console.log(`   Nonce: ${userOp.nonce}`);
    console.log(
      `   CallData: ${userOp.callData.slice(0, 10)}... (${userOp.callData.length} chars)`,
    );
    console.log(`   CallData selector: ${userOp.callData.slice(0, 10)}`);
    console.log(
      `   Gas limits: call=${userOp.callGasLimit}, verification=${userOp.verificationGasLimit}`,
    );
    console.log();

    console.log("🔏 Signing with TACo...");

    // Build Discord context for TACo signing
    const discordBody = process.env.CONTEXT_DISCORD_PAYLOAD;
    const discordMessageHex = process.env.CONTEXT_MESSAGE_HEX;
    const discordSignature = process.env.CONTEXT_SIGNATURE_HEX;

    if (!discordBody || !discordMessageHex || !discordSignature) {
      throw new Error(
        "Missing Discord context: require CONTEXT_MESSAGE_HEX, CONTEXT_SIGNATURE_HEX, CONTEXT_DISCORD_PAYLOAD",
      );
    }

    // Ensure message hex has 0x prefix
    const messageWithPrefix = discordMessageHex.startsWith("0x")
      ? discordMessageHex
      : `0x${discordMessageHex}`;
    // Signature without 0x prefix
    const signatureNo0x = discordSignature.replace(/^0x/, "");

    console.log("🔏 Discord context:");
    console.log(
      `   Message: ${messageWithPrefix.slice(0, 20)}... (${messageWithPrefix.length} chars)`,
    );
    console.log(
      `   Signature: ${signatureNo0x.slice(0, 20)}... (${signatureNo0x.length} chars)`,
    );
    console.log(`   Payload: ${discordBody.slice(0, 80)}...`);
    console.log();

    // Create signing context
    const signingContext =
      await conditions.context.ConditionContext.forSigningCohort(
        provider,
        TACO_DOMAIN,
        COHORT_ID,
        SIGNING_CHAIN_ID,
      );

    signingContext.addCustomContextParameterValues({
      ":message": messageWithPrefix,
      ":signature": signatureNo0x,
      ":discordPayload": discordBody,
    });

    // Convert userOp to TACo UserOperation format
    const tacoUserOp: UserOperation = {
      sender: userOp.sender,
      nonce: Number(userOp.nonce),
      factory: userOp.factory || "0x",
      factoryData: userOp.factoryData || "0x",
      callData: userOp.callData,
      callGasLimit: Number(userOp.callGasLimit),
      verificationGasLimit: Number(userOp.verificationGasLimit),
      preVerificationGas: Number(userOp.preVerificationGas),
      maxFeePerGas: Number(userOp.maxFeePerGas),
      maxPriorityFeePerGas: Number(userOp.maxPriorityFeePerGas),
      paymaster: userOp.paymaster || "0x",
      paymasterVerificationGasLimit: Number(
        userOp.paymasterVerificationGasLimit || 0,
      ),
      paymasterPostOpGasLimit: Number(userOp.paymasterPostOpGasLimit || 0),
      paymasterData: userOp.paymasterData || "0x",
      signature: "0x",
    };

    console.log("⏳ Requesting signatures from TACo network...");
    let signature;
    try {
      signature = await signUserOp(
        provider,
        TACO_DOMAIN,
        COHORT_ID,
        SIGNING_CHAIN_ID,
        tacoUserOp,
        AA_VERSION,
        signingContext,
      );
    } catch (e) {
      console.error(
        "❌ TACo signing failed:",
        e instanceof Error ? e.message : String(e),
      );
      if (e instanceof Error && e.stack) {
        console.error("Stack trace:", e.stack);
      }
      throw e;
    }
    console.log(
      `✅ Signature collected: ${signature.aggregatedSignature.slice(0, 20)}... (${signature.aggregatedSignature.length / 2 - 1} bytes)\n`,
    );

    console.log("🚀 Executing transaction...");
    const userOpHash = await bundlerClient.sendUserOperation({
      ...userOp,
      signature: signature.aggregatedSignature as `0x${string}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    console.log(`📝 UserOp Hash: ${userOpHash}`);

    const { receipt } = await bundlerClient.waitForUserOperationReceipt({
      hash: userOpHash,
    });
    console.log(`\n🎉 Transaction successful!`);
    console.log(`🔗 Tx: ${receipt.transactionHash}`);
    const explorerBase =
      CHAIN_ID === 84532
        ? "https://sepolia.basescan.org"
        : "https://sepolia.etherscan.io";
    console.log(
      `🌐 View on Explorer: ${explorerBase}/tx/${receipt.transactionHash}\n`,
    );

    await logBalances(provider, localAccount.address, smartAccount.address);
    console.log("✨ Demo completed successfully! ✨");
    process.exit(0);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Demo failed: ${errorMessage}`);
    process.exit(1);
  }
}

if (require.main === module) {
  // Check if --dry-run flag is present (used for CI syntax checking)
  if (process.argv.includes("--dry-run")) {
    console.log("✓ Syntax check passed");
    process.exit(0);
  }
  main();
}
