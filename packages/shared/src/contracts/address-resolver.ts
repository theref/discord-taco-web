import { getContract } from '@nucypher/nucypher-contracts';

import { Domain } from '../porter';

function toEnvKey(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toUpperCase();
}

function domainToKey(domain: Domain): string {
  // Known domains in this repo map to these strings
  // lynx -> DEVNET, tapir -> TESTNET, mainnet -> MAINNET
  const mapping: Record<string, string> = {
    lynx: 'DEVNET',
    tapir: 'TESTNET',
    mainnet: 'MAINNET',
  };
  return mapping[domain] ?? toEnvKey(String(domain));
}

/**
 * Resolve a contract address with optional environment variable overrides.
 *
 * Priority:
 * 1. TACO_<NAME>_ADDRESS_<CHAINID>_<DOMAIN>
 * 2. TACO_<NAME>_ADDRESS_<CHAINID>
 * 3. TACO_<NAME>_ADDRESS
 * 4. Fallback to @nucypher/nucypher-contracts.getContract(domain, chainId, name)
 */
export function getContractAddress(
  domain: Domain,
  chainId: number,
  name: string,
): string {
  const nameKey = toEnvKey(name);
  const domainKey = domainToKey(domain);

  const candidates = [
    `TACO_${nameKey}_ADDRESS_${chainId}_${domainKey}`,
    `TACO_${nameKey}_ADDRESS_${chainId}`,
    `TACO_${nameKey}_ADDRESS`,
  ];

  for (const key of candidates) {
    const value = process.env[key];
    if (value && /^0x[a-fA-F0-9]{40}$/.test(value)) {
      // eslint-disable-next-line no-console
      console.log(
        `Resolved ${name} via env override: ${key}=${value} (domain=${String(
          domain,
        )}, chainId=${chainId})`,
      );
      return value;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `Falling back to registry for ${name} (domain=${String(
      domain,
    )}, chainId=${chainId})`,
  );
  return getContract(domain, chainId, name);
}


