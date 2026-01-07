#!/usr/bin/env npx tsx
/**
 * Compute the bytecodeHash for cohort 3's smart accounts.
 *
 * The bytecodeHash is keccak256(proxyCreationCode) where proxyCreationCode
 * is the ERC1967Proxy bytecode + implementation address + initcode.
 *
 * This value is deterministic per cohort because signers/threshold are fixed.
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
import { Address, createPublicClient, http, keccak256, pad } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

dotenv.config();

const BASE_SEPOLIA_CHAIN_ID = 84532;
const TACO_DOMAIN: Domain =
  (process.env.TACO_DOMAIN as Domain) || domains.DEVNET;
const COHORT_ID = parseInt(process.env.COHORT_ID || '3', 10);

async function main() {
  await initialize();

  console.log('Computing bytecodeHash for cohort', COHORT_ID);
  console.log('Chain:', BASE_SEPOLIA_CHAIN_ID);
  console.log('TACo Domain:', TACO_DOMAIN);
  console.log();

  // Get delegation environment for Base Sepolia
  const environment = getDeleGatorEnvironment(BASE_SEPOLIA_CHAIN_ID);
  console.log('SimpleFactory:', environment.SimpleFactory);
  console.log(
    'MultiSigDeleGatorImpl:',
    environment.implementations.MultiSigDeleGatorImpl,
  );
  console.log();

  // Fetch cohort signers and threshold from L1 coordinator
  const signingCoordinatorProvider = new ethers.providers.JsonRpcProvider(
    process.env.ETH_RPC_URL!,
  );

  console.log('Fetching cohort participants...');
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
  console.log();

  // Create a public client for viem
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.SIGNING_CHAIN_RPC_URL),
  });

  // Create a dummy signatory (we just need the factory data, not actual signing)
  // Using a random private key - doesn't matter since we're not signing anything
  const dummyAccount = privateKeyToAccount(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  );

  // Create a dummy smart account to get the factory data
  // The factory data contains the proxyCreationCode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const smartAccount = await (toMetaMaskSmartAccount as any)({
    client: publicClient,
    implementation: Implementation.MultiSig,
    deployParams: [signers, BigInt(threshold)],
    deploySalt: '0x0000000000000000000000000000000000000000000000000000000000000000',
    signatory: [{ account: dummyAccount }],
  });

  // Debug: log smartAccount properties
  console.log('Smart account keys:', Object.keys(smartAccount));
  console.log('Smart account address:', smartAccount.address);
  console.log('Smart account isDeployed:', await smartAccount.isDeployed());
  console.log('Smart account environment:', smartAccount.environment);

  // Get factory args which contains factory address and factoryData
  const factoryArgs = await smartAccount.getFactoryArgs();
  console.log('Factory args:', factoryArgs);

  // If account is deployed, factoryArgs will be undefined
  // We need to compute the bytecodeHash directly
  if (!factoryArgs || !factoryArgs.factoryData) {
    console.log('\nAccount appears deployed or factoryData unavailable.');
    console.log('Computing bytecodeHash directly...');

    // Import the required ABIs and bytecode
    const { MultiSigDeleGator, ERC1967Proxy } = await import(
      '@metamask/delegation-utils'
    );
    const { encodeFunctionData, encodeDeployData } = await import('viem');

    // Build the initcode for MultiSig initialize(owners, threshold)
    const initcode = encodeFunctionData({
      abi: MultiSigDeleGator.abi,
      functionName: 'initialize',
      args: [signers, BigInt(threshold)],
    });

    console.log('Initcode:', initcode.slice(0, 100), '...');

    // Build the proxy creation code (ERC1967Proxy deployment bytecode)
    const proxyCreationCode = encodeDeployData({
      abi: ERC1967Proxy.abi,
      args: [environment.implementations.MultiSigDeleGatorImpl, initcode],
      bytecode: ERC1967Proxy.bytecode as `0x${string}`,
    });

    console.log('Proxy creation code length:', proxyCreationCode.length / 2 - 1, 'bytes');

    // Compute bytecodeHash
    const bytecodeHash = keccak256(proxyCreationCode);
    console.log();
    console.log('='.repeat(60));
    console.log('BYTECODE HASH FOR COHORT', COHORT_ID);
    console.log('='.repeat(60));
    console.log(bytecodeHash);
    console.log('='.repeat(60));

    // Output for conditions.json
    console.log();
    console.log('='.repeat(60));
    console.log('VALUES FOR conditions.json:');
    console.log('='.repeat(60));
    console.log(`"bytecodeHash": "${bytecodeHash}"`);
    console.log(`"factoryAddress": "${environment.SimpleFactory}"`);
    console.log(`"chainId": ${BASE_SEPOLIA_CHAIN_ID}`);
    console.log('='.repeat(60));

    return;
  }

  const factoryData = factoryArgs.factoryData as `0x${string}`;
  console.log('Factory data length:', factoryData.length);

  // SimpleFactory.deploy(bytes _bytecode, bytes32 _salt)
  // Function selector: 0x9c4ae2d0 (first 4 bytes / 10 chars including 0x)
  // Then: offset to bytecode (32 bytes), salt (32 bytes), bytecode length (32 bytes), bytecode
  //
  // ABI encoding:
  // 0x9c4ae2d0                                                         - selector
  // 0000000000000000000000000000000000000000000000000000000000000040     - offset to bytecode (64)
  // <salt 32 bytes>                                                     - salt
  // <bytecode length 32 bytes>                                          - bytecode length
  // <bytecode>                                                          - bytecode

  // Skip selector (10 chars = 0x + 8 hex), then read the structure
  const withoutSelector = factoryData.slice(10);

  // First 64 chars = offset (should be 0x40 = 64)
  // Next 64 chars = salt
  // Then we need to follow the offset to get bytecode

  // The offset points to where the bytecode data starts (relative to start of params)
  // offset = 64 bytes = skip to position 64
  // At position 64: first 32 bytes = length of bytecode, then bytecode

  // Position in hex chars: offset is at 0, salt is at 64, bytecode data starts at 128
  // Each 32 bytes = 64 hex chars

  // Extract bytecode: skip offset (64) + salt (64) = 128 chars, then read length + data
  const bytecodeSection = withoutSelector.slice(128); // Skip offset and salt
  const bytecodeLength = parseInt(bytecodeSection.slice(0, 64), 16);
  const bytecode = ('0x' + bytecodeSection.slice(64, 64 + bytecodeLength * 2)) as `0x${string}`;

  console.log('Proxy creation code length:', bytecodeLength, 'bytes');

  // Compute bytecodeHash
  const bytecodeHash = keccak256(bytecode);
  console.log();
  console.log('='.repeat(60));
  console.log('BYTECODE HASH FOR COHORT', COHORT_ID);
  console.log('='.repeat(60));
  console.log(bytecodeHash);
  console.log('='.repeat(60));

  // Verify by computing an address
  const testSalt = pad('0x1234', { size: 32 });
  console.log();
  console.log('Verification - computing address with test salt:', testSalt);

  // The smart account address we got
  console.log('Smart account address (salt=0x0):', smartAccount.address);

  // Now test with a different salt to verify our bytecodeHash works
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const testAccount = await (toMetaMaskSmartAccount as any)({
    client: publicClient,
    implementation: Implementation.MultiSig,
    deployParams: [signers, BigInt(threshold)],
    deploySalt: testSalt,
    signatory: [{ account: dummyAccount }],
  });
  console.log('Smart account address (salt=0x1234...):', testAccount.address);

  // Output for conditions.json
  console.log();
  console.log('='.repeat(60));
  console.log('VALUES FOR conditions.json:');
  console.log('='.repeat(60));
  console.log(`"bytecodeHash": "${bytecodeHash}"`);
  console.log(`"factoryAddress": "${environment.SimpleFactory}"`);
  console.log(`"chainId": ${BASE_SEPOLIA_CHAIN_ID}`);
  console.log('='.repeat(60));
}

main().catch(console.error);
