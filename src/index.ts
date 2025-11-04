#!/usr/bin/env node

import {
  Implementation,
  toMetaMaskSmartAccount,
} from "@metamask/delegation-toolkit";
import { Domain, SigningCoordinatorAgent } from "@nucypher/shared";
import { conditions, domains, initialize, signUserOp } from "@nucypher/taco";
import type { CustomContextParam } from "@nucypher/taco/dist/src/conditions/context";
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import nacl from "tweetnacl";
import { Address, createPublicClient, http, parseEther } from "viem";
import {
  createBundlerClient,
  createPaymasterClient,
  getUserOperationHash,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";
import { JSONPath } from "@astronautlabs/jsonpath";
import * as fs from "fs";

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

    console.log("📝 Building user operation (offline)...");
    const calls = [
      {
        target: tipRecipient,
        value: BigInt(transferAmount.toString()),
        data: "0x" as `0x${string}`,
      },
    ];
    console.log(
      `💸 Transfer amount: ${ethers.utils.formatEther(transferAmount)} ETH\n`,
    );

    // Encode execute((address,uint256,bytes)) - tuple syntax WITHOUT 'tuple' keyword
    // Must match Python: Web3.keccak(text="execute((address,uint256,bytes))")
    const ifaceExec = new ethers.utils.Interface([
      "function execute((address,uint256,bytes))",
    ]);
    const callDataForSigning = ifaceExec.encodeFunctionData("execute", [
      [tipRecipient, transferAmount, "0x"],
    ]) as `0x${string}`;
    console.log(
      "🔎 execute(to,value,data) selector:",
      callDataForSigning.slice(0, 10),
    );
    console.log(
      "🔎 callDataForSigning prefix:",
      callDataForSigning.slice(0, 18),
    );
    if (callDataForSigning === "0x") {
      console.warn(
        "⚠️  callDataForSigning is 0x; ABI validations in cohort may fail.",
      );
    }

    // Try decoding callData against common AA execute ABIs to see what we're actually sending
    try {
      const decodedResults: Array<{
        label: string;
        ok: boolean;
        error?: string;
        args?: unknown;
      }> = [];
      const candidates: Array<{
        label: string;
        iface: ethers.utils.Interface;
        fn: string;
      }> = [
        {
          label: "execute(address to,uint256 value,bytes data)",
          iface: new ethers.utils.Interface([
            "function execute(address to,uint256 value,bytes data)",
          ]),
          fn: "execute",
        },
        {
          label:
            "execute(tuple(address target,uint256 value,bytes data)[] calls)",
          iface: new ethers.utils.Interface([
            "function execute(tuple(address target,uint256 value,bytes data)[] calls)",
          ]),
          fn: "execute",
        },
        {
          label:
            "executeBatch(tuple(address target,uint256 value,bytes data)[] calls)",
          iface: new ethers.utils.Interface([
            "function executeBatch(tuple(address target,uint256 value,bytes data)[] calls)",
          ]),
          fn: "executeBatch",
        },
      ];
      for (const c of candidates) {
        try {
          const decoded = c.iface.decodeFunctionData(c.fn, callDataForSigning);
          console.log(`🔬 Decoded via ${c.label}:`);
          console.log(decoded);
          decodedResults.push({ label: c.label, ok: true, args: decoded });
        } catch {
          // ignore
          decodedResults.push({ label: c.label, ok: false });
        }
      }
      const out = {
        selector: callDataForSigning.slice(0, 10),
        callData: callDataForSigning,
        candidates: decodedResults,
      };
      const outPath = `${process.cwd()}/callData.decoded.json`;
      try {
        fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
      } catch {}
      console.log(`💾 Saved callData decode report to ${outPath}`);
    } catch (e) {
      console.log(
        "⚠️  callData decode attempt failed:",
        (e as Error)?.message || String(e),
      );
    }

    // Assert Discord payload matches the intended call
    try {
      const rawDiscordForAssert = process.env.CONTEXT_DISCORD_PAYLOAD;
      if (!rawDiscordForAssert) {
        throw new Error("Missing CONTEXT_DISCORD_PAYLOAD");
      }
      const parsed = JSON.parse(rawDiscordForAssert);
      const opts = parsed?.data?.options || [];
      const amountOpt = opts.find((o: any) => o?.name === "amount")?.value;
      const recipientOpt = opts.find(
        (o: any) => o?.name === "recipient",
      )?.value;
      const amtWei = ethers.utils.parseEther(String(amountOpt));
      if (!transferAmount.eq(amtWei)) {
        throw new Error(
          `amount mismatch (discordETH=${String(amountOpt)} callETH=${ethers.utils.formatEther(transferAmount)})`,
        );
      }
      if (
        String(tipRecipient).toLowerCase() !==
        String(recipientOpt || "").toLowerCase()
      ) {
        throw new Error(
          `recipient mismatch (discord=${String(recipientOpt)} call=${String(tipRecipient)})`,
        );
      }
    } catch (e) {
      throw new Error(
        `Discord payload and call data mismatch: ${(e as Error)?.message || String(e)}`,
      );
    }

    // Gas limits matching Python implementation
    const callGasLimit = BigInt(300_000);
    const verificationGasLimit = BigInt(1_000_000);
    const preVerificationGas = BigInt(60_000);

    const userOpShell = {
      sender: smartAccount.address,
      nonce: 0,
      factory: "0x",
      factoryData: "0x",
      callData: callDataForSigning,
      callGasLimit: Number(callGasLimit),
      verificationGasLimit: Number(verificationGasLimit),
      preVerificationGas: Number(preVerificationGas),
      maxFeePerGas: Number(fee.maxFeePerGas),
      maxPriorityFeePerGas: Number(fee.maxPriorityFeePerGas),
      paymaster: "0x",
      paymasterVerificationGasLimit: 0,
      paymasterPostOpGasLimit: 0,
      paymasterData: "0x",
      signature: "0x",
    } as const;

    // Print raw cohort condition for debugging schema mismatches
    try {
      const rawCondition =
        await SigningCoordinatorAgent.getSigningCohortConditions(
          provider,
          TACO_DOMAIN,
          COHORT_ID,
          SIGNING_CHAIN_ID,
        );
      console.log("📜 Cohort condition (raw):");
      console.log(rawCondition);

      // Decode and evaluate JSONPath conditions locally against :discordPayload
      try {
        const asJson = JSON.parse(
          ethers.utils.toUtf8String(rawCondition as string),
        );
        const jsonConditions: Array<{
          data?: string;
          query?: string;
          path?: string;
          returnTest?: unknown;
        }> = [];

        const collectJsonConds = (node: unknown) => {
          if (!node || typeof node !== "object") return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const obj = node as Record<string, any>;
          if (
            (obj.conditionType === "json" || obj.conditionType === "rpc") &&
            (obj.query || obj.path)
          ) {
            jsonConditions.push({
              data: obj.data,
              query: obj.query,
              path: obj.path,
              returnTest: obj.returnValueTest,
            });
          }
          for (const v of Object.values(obj)) collectJsonConds(v);
        };
        collectJsonConds(asJson);

        const rawDiscord = process.env.CONTEXT_DISCORD_PAYLOAD || "";
        const parsedDiscord = rawDiscord ? JSON.parse(rawDiscord) : undefined;
        console.log("🔎 JSON conditions discovered:", jsonConditions.length);
        for (const [idx, c] of jsonConditions.entries()) {
          try {
            if (c.data && c.data !== ":discordPayload") {
              console.log(`   [${idx}] skip (data=${c.data})`);
              continue;
            }
            const expr = (c.query || c.path || "").toString();
            if (!expr) {
              console.log(`   [${idx}] no query/path`);
              continue;
            }
            if (!parsedDiscord) {
              console.log(`   [${idx}] no discord payload available`);
              continue;
            }
            const result = JSONPath.query(parsedDiscord, expr);
            console.log(`   [${idx}] JSONPath: ${expr}`);
            console.log(`          Result:`, result);
            if (c.returnTest) {
              console.log(`          ReturnTest:`, c.returnTest);
            }
          } catch (e) {
            console.log(
              `   [${idx}] eval error:`,
              (e as Error)?.message || String(e),
            );
          }
        }
      } catch (e) {
        console.log(
          "⚠️  Failed to parse/evaluate cohort JSON conditions:",
          (e as Error)?.message || String(e),
        );
      }
    } catch (e) {
      console.log("⚠️  Failed to fetch cohort condition:", e);
    }

    console.log("🔏 Signing with TACo...");
    // Build context required by cohort (e.g., ':message', ':signature').
    // Note: message preimage here is a placeholder; replace with canonical ERC-4337 userOp hash if required.
    const messagePreimage = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(JSON.stringify(userOpShell)),
    );
    const eoa = new ethers.Wallet(process.env.PRIVATE_KEY as string, provider);

    // Prefer canonical ERC-4337 userOp hash for ':message'
    const entryPointFromEnv = process.env.ENTRYPOINT_ADDRESS as
      | `0x${string}`
      | undefined;
    const entryPointFromAccount = (
      smartAccount as unknown as { entryPoint?: `0x${string}` }
    )?.entryPoint;
    const entryPointAddress = (entryPointFromEnv || entryPointFromAccount) as
      | `0x${string}`
      | undefined;

    let canonicalUserOpHash: `0x${string}` | undefined = undefined;
    try {
      if (entryPointAddress) {
        const userOpForHash = {
          sender: smartAccount.address as Address,
          nonce: 0n,
          factory: userOpShell.factory as `0x${string}`,
          factoryData: userOpShell.factoryData as `0x${string}`,
          callData: userOpShell.callData as `0x${string}`,
          callGasLimit: BigInt(userOpShell.callGasLimit),
          verificationGasLimit: BigInt(userOpShell.verificationGasLimit),
          preVerificationGas: BigInt(userOpShell.preVerificationGas),
          maxFeePerGas: fee.maxFeePerGas as bigint,
          maxPriorityFeePerGas: fee.maxPriorityFeePerGas as bigint,
          paymaster: userOpShell.paymaster as `0x${string}`,
          paymasterVerificationGasLimit: BigInt(
            userOpShell.paymasterVerificationGasLimit,
          ),
          paymasterPostOpGasLimit: BigInt(userOpShell.paymasterPostOpGasLimit),
          paymasterData: userOpShell.paymasterData as `0x${string}`,
          signature: "0x" as `0x${string}`,
        } as const;

        canonicalUserOpHash = getUserOperationHash({
          chain: selectedViemChain,
          entryPointAddress,
          userOperation: userOpForHash,
        });
      }
    } catch {
      // fall back to placeholder below
    }

    const overrideMessage = process.env.CONTEXT_MESSAGE_HEX as
      | `0x${string}`
      | undefined;
    const overrideSignature = process.env.CONTEXT_SIGNATURE_HEX as
      | string
      | undefined;
    const messageForContext = (overrideMessage ||
      canonicalUserOpHash ||
      messagePreimage) as `0x${string}`;
    console.log("🧩 Context message (hex):", messageForContext);

    let eoaSigHex: string;
    if (overrideSignature) {
      eoaSigHex = overrideSignature.replace(/^0x/, "");
      console.log("🧩 Context signature (override, no 0x):", eoaSigHex);
    } else {
      // Try EIP-191 style first; if cohort expects digest, flip implementation below
      const eip191Sig = await eoa.signMessage(
        ethers.utils.arrayify(messageForContext),
      );
      eoaSigHex = eip191Sig.replace(/^0x/, "");
      if (!eoaSigHex || eoaSigHex.length % 2 !== 0) {
        const rawSig = await eoa._signingKey().signDigest(messageForContext);
        eoaSigHex = ethers.utils.joinSignature(rawSig).replace(/^0x/, "");
      }
      console.log("🧩 Context signature (computed, no 0x):", eoaSigHex);
    }

    // Extra diagnostics for Discord Ed25519 path
    try {
      if (
        overrideMessage &&
        overrideSignature &&
        process.env.DISCORD_PUBLIC_KEY
      ) {
        const msgHex = overrideMessage.replace(/^0x/, "");
        const sigHex = overrideSignature.replace(/^0x/, "");
        const pubHex = (process.env.DISCORD_PUBLIC_KEY || "").replace(
          /^0x/,
          "",
        );
        const ok = nacl.sign.detached.verify(
          Buffer.from(msgHex, "hex"),
          Buffer.from(sigHex, "hex"),
          Buffer.from(pubHex, "hex"),
        );
        console.log(
          `🔎 Ed25519(local): msgBytes=${msgHex.length / 2} sigBytes=${sigHex.length / 2} ok=${ok}`,
        );
      }
    } catch (e) {
      console.warn(
        "⚠️  Local Ed25519 verify failed to run:",
        (e as Error)?.message || String(e),
      );
    }

    const discordBody = process.env.CONTEXT_DISCORD_PAYLOAD;
    const discordMessageHexRaw = process.env.CONTEXT_MESSAGE_HEX;
    const discordSignatureRaw = process.env.CONTEXT_SIGNATURE_HEX;
    if (!discordBody || !discordMessageHexRaw || !discordSignatureRaw) {
      throw new Error(
        "Missing Discord context: require CONTEXT_MESSAGE_HEX, CONTEXT_SIGNATURE_HEX, CONTEXT_DISCORD_PAYLOAD",
      );
    }
    const discordMessageHex = discordMessageHexRaw.startsWith("0x")
      ? (discordMessageHexRaw as `0x${string}`)
      : (`0x${discordMessageHexRaw}` as `0x${string}`);
    const discordSignatureNo0x = discordSignatureRaw.replace(/^0x/, "");

    let signingContextRaw: Record<string, CustomContextParam> = {
      ":message": discordMessageHex as `0x${string}`,
      ":signature": discordSignatureNo0x,
      ":discordPayload": discordBody,
    };
    try {
      const ctx = await conditions.context.ConditionContext.forSigningCohort(
        provider,
        TACO_DOMAIN,
        COHORT_ID,
        SIGNING_CHAIN_ID,
      );
      const requestedParams = Array.from(ctx.requestedContextParameters || []);
      console.log("🔎 Requested context params:", requestedParams);

      const additions: Record<string, CustomContextParam> = {};
      // Compare Discord options with intended call data for debugging mismatches
      try {
        const rawDiscord = process.env.CONTEXT_DISCORD_PAYLOAD;
        if (rawDiscord) {
          const parsed = JSON.parse(rawDiscord);
          const opts = parsed?.data?.options || [];
          const amountOpt = opts.find((o: any) => o?.name === "amount")?.value;
          const recipientOpt = opts.find(
            (o: any) => o?.name === "recipient",
          )?.value;
          console.log("🔎 Comparison (discord vs call):", {
            discordAmount: String(amountOpt),
            discordRecipient: String(recipientOpt || ""),
            callAmountEth: ethers.utils.formatEther(transferAmount),
            callRecipient: tipRecipient,
          });
        }
      } catch (e) {
        console.warn(
          "⚠️  Failed to parse CONTEXT_DISCORD_PAYLOAD for comparison:",
          (e as Error)?.message || String(e),
        );
      }
      if (requestedParams.includes(":message")) {
        additions[":message"] = discordMessageHex as `0x${string}`;
      }
      if (requestedParams.includes(":signature")) {
        additions[":signature"] = discordSignatureNo0x;
      }
      if (requestedParams.includes(":discordPayload")) {
        additions[":discordPayload"] = discordBody;
        console.log("🧩 Context :discordPayload: <raw from interactions>");
      }
      if (Object.keys(additions).length > 0) {
        ctx.addCustomContextParameterValues(additions);
      }
      // Convert to context parameters but keep type loose for signUserOp
      const finalized = await ctx.toContextParameters();
      signingContextRaw = finalized as unknown as Record<
        string,
        CustomContextParam
      >;
    } catch (e) {
      console.warn(
        "⚠️  Context parsing failed; using raw Discord context. Error:",
        (e as Error)?.message || String(e),
      );
      signingContextRaw = {
        ":message": discordMessageHex as `0x${string}`,
        ":signature": discordSignatureNo0x,
        ":discordPayload": discordBody,
      };
    }

    let signature;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // Log final context keys and sizes prior to TACo signing
      try {
        const ctxEntries = Object.entries(signingContextRaw).map(([k, v]) => {
          const s = typeof v === "string" ? v : String(v);
          return [k, { length: s.length, preview: s.slice(0, 64) }];
        });
        console.log(
          "🧾 Final context for TACo:",
          Object.fromEntries(ctxEntries),
        );
      } catch {}

      signature = await signUserOp(
        provider,
        TACO_DOMAIN,
        COHORT_ID,
        SIGNING_CHAIN_ID,
        userOpShell,
        AA_VERSION,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signingContextRaw as any,
      );
    } catch (e) {
      // Extra diagnostics to locate source of failure
      console.error(
        "TACo signing failed with error:",
        e instanceof Error ? e.message : String(e),
      );
      if (e instanceof Error && e.stack) {
        console.error("Stack:", e.stack);
      }
      throw e;
    }
    console.log(
      `✅ Signature collected (${signature.aggregatedSignature.length / 2 - 1} bytes)\n`,
    );

    console.log("🚀 Executing transaction...");
    // @ts-expect-error viem AA types are incompatible in this demo context
    const userOpHash = await bundlerClient.sendUserOperation({
      account: smartAccount,
      callData: callDataForSigning,
      callGasLimit,
      verificationGasLimit,
      preVerificationGas,
      maxFeePerGas: fee.maxFeePerGas as bigint,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas as bigint,
      factory: userOpShell.factory,
      factoryData: userOpShell.factoryData,
      paymaster: userOpShell.paymaster,
      paymasterVerificationGasLimit: BigInt(
        userOpShell.paymasterVerificationGasLimit,
      ),
      paymasterPostOpGasLimit: BigInt(userOpShell.paymasterPostOpGasLimit),
      paymasterData: userOpShell.paymasterData as `0x${string}`,
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
