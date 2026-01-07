#!/usr/bin/env npx tsx
/**
 * Validate that on-chain AA address derivation matches local computation.
 *
 * This script:
 * 1. Takes a Discord user ID
 * 2. Computes salt: keccak256("{discordId}|Discord|Collabland")
 * 3. Calls SimpleFactory.computeAddress(bytecodeHash, salt) on Base Sepolia
 * 4. Compares to deriveDiscordUserAA() result from MetaMask Delegation Toolkit
 */

import {
  Implementation,
  toMetaMaskSmartAccount,
} from '@metamask/delegation-toolkit';
import { getDeleGatorEnvironment } from '@metamask/delegation-utils';
import { SigningCoordinatorAgent } from '@nucypher/shared';
import { Domain, domains, initialize } from '@nucypher/taco';
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { Address, createPublicClient, http, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

dotenv.config();

const BASE_SEPOLIA_CHAIN_ID = 84532;
const TACO_DOMAIN: Domain = (process.env.TACO_DOMAIN as Domain) || domains.DEVNET;
const COHORT_ID = parseInt(process.env.COHORT_ID || '3', 10);

// The bytecodeHash we computed
const BYTECODE_HASH = '0x210ffc0da7f274285c4d6116aaef8420ecb9054faced33862197d6b951cb32f5';

// SimpleFactory address on Base Sepolia
const SIMPLE_FACTORY = '0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c';

// SimpleFactory ABI for computeAddress
const SIMPLE_FACTORY_ABI = [
  {
    name: 'computeAddress',
    type: 'function',
    inputs: [
      { name: '_bytecodeHash', type: 'bytes32', internalType: 'bytes32' },
      { name: '_salt', type: 'bytes32', internalType: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
] as const;

async function main() {
  // Get Discord user ID from args or use default test value
  const discordUserId = process.argv[2] || '412648164710023168';

  console.log('='.repeat(60));
  console.log('AA Address Derivation Validation');
  console.log('='.repeat(60));
  console.log();
  console.log('Discord User ID:', discordUserId);
  console.log('Cohort:', COHORT_ID);
  console.log('Chain:', BASE_SEPOLIA_CHAIN_ID);
  console.log('TACo Domain:', TACO_DOMAIN);
  console.log();

  await initialize();

  // Step 1: Compute salt using our formula
  const saltInput = `${discordUserId}|Discord|Collabland`;
  const salt = keccak256(toBytes(saltInput));
  console.log('Salt input:', saltInput);
  console.log('Salt (keccak256):', salt);
  console.log();

  // Create clients
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.SIGNING_CHAIN_RPC_URL),
  });

  const signingCoordinatorProvider = new ethers.providers.JsonRpcProvider(
    process.env.ETH_RPC_URL!,
  );

  // Step 2: Call SimpleFactory.computeAddress on-chain
  console.log('Calling SimpleFactory.computeAddress on-chain...');
  const onChainAddress = await publicClient.readContract({
    address: SIMPLE_FACTORY,
    abi: SIMPLE_FACTORY_ABI,
    functionName: 'computeAddress',
    args: [BYTECODE_HASH as `0x${string}`, salt],
  });
  console.log('On-chain computed address:', onChainAddress);
  console.log();

  // Step 3: Compute locally using MetaMask Delegation Toolkit
  console.log('Computing locally using MetaMask Delegation Toolkit...');

  // Fetch cohort signers and threshold
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

  console.log('Signers:', signers);
  console.log('Threshold:', threshold);

  // Create a dummy signatory for the toolkit
  const dummyAccount = privateKeyToAccount(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const smartAccount = await (toMetaMaskSmartAccount as any)({
    client: publicClient,
    implementation: Implementation.MultiSig,
    deployParams: [signers, BigInt(threshold)],
    deploySalt: salt,
    signatory: [{ account: dummyAccount }],
  });

  const localAddress = smartAccount.address;
  console.log('Local computed address:', localAddress);
  console.log();

  // Step 4: Compare
  console.log('='.repeat(60));
  console.log('COMPARISON');
  console.log('='.repeat(60));
  console.log('On-chain address:', onChainAddress);
  console.log('Local address:   ', localAddress);
  console.log();

  if (onChainAddress.toLowerCase() === localAddress.toLowerCase()) {
    console.log('✅ MATCH! The derivation is correct.');
  } else {
    console.log('❌ MISMATCH! The addresses do not match.');
    console.log();
    console.log('This could mean:');
    console.log('1. bytecodeHash is incorrect');
    console.log('2. Salt computation differs');
    console.log('3. Factory or implementation addresses differ');
  }
  console.log('='.repeat(60));
}

main().catch(console.error);
