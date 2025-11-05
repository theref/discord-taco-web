#!/usr/bin/env tsx

import { ethers } from 'ethers';
import { Domain, SigningCoordinatorAgent } from '@nucypher/shared';
import { domains } from '@nucypher/taco';
import * as dotenv from 'dotenv';

dotenv.config();

function findVerifyingKey(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  // direct hit
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = node as Record<string, any>;
  if (typeof obj.verifyingKey === 'string') return obj.verifyingKey;
  for (const value of Object.values(obj)) {
    const maybe = findVerifyingKey(value);
    if (maybe) return maybe;
  }
  return undefined;
}

async function main(): Promise<void> {
  const TACO_DOMAIN: Domain = (process.env.TACO_DOMAIN as Domain) || domains.DEVNET;
  const CHAIN_ID = parseInt(process.env.CHAIN_ID || '11155111', 10);
  const COHORT_ID = parseInt(process.env.COHORT_ID || '1', 10);
  const RPC_URL = process.env.RPC_URL;
  const botKeyEnv = (process.env.DISCORD_PUBLIC_KEY || '').replace(/^0x/, '').toLowerCase();

  if (!RPC_URL) {
    throw new Error('Missing RPC_URL');
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

  const raw = await SigningCoordinatorAgent.getSigningCohortConditions(
    provider,
    TACO_DOMAIN,
    COHORT_ID,
    CHAIN_ID,
  );

  console.log('📦 Raw cohort condition (hex prefix):', String(raw).slice(0, 66), '...');

  let jsonStr = '';
  try {
    jsonStr = ethers.utils.toUtf8String(raw as string);
  } catch (e) {
    console.error('Failed to decode UTF-8 from hex:', (e as Error)?.message || String(e));
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error('Failed to parse JSON:', (e as Error)?.message || String(e));
    process.exit(1);
  }

  const cohortVK = (findVerifyingKey(parsed) || '').replace(/^0x/, '').toLowerCase();
  console.log('🔑 cohort verifyingKey:', cohortVK);
  console.log('🔑 bot DISCORD_PUBLIC_KEY:', botKeyEnv);
  if (!cohortVK) {
    console.log('⚠️  No verifyingKey found in cohort condition JSON.');
  }
  if (!botKeyEnv) {
    console.log('⚠️  DISCORD_PUBLIC_KEY is empty or not set.');
  }
  if (cohortVK && botKeyEnv) {
    const match = cohortVK === botKeyEnv;
    console.log(`✅ Match: ${match}`);
    if (!match) {
      console.log('❌ Keys differ. Update the cohort to the bot key or run a bot using the cohort key.');
    }
  }
}

main().catch((e) => {
  console.error('Error:', e?.message || String(e));
  process.exit(1);
});


