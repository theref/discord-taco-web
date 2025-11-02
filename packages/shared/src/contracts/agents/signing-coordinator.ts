import { getContractAddress } from '../address-resolver';
import { ethers } from 'ethers';

import { Domain } from '../../porter';
import { SigningCoordinator__factory } from '../ethers-typechain';
import { SigningCoordinator } from '../ethers-typechain/SigningCoordinator';

type SignerInfo = {
  operator: string;
  provider: string;
  signature: string;
};

function getDefaultParentRpcUrl(domain: Domain): string {
  // lynx (DEVNET) and tapir (TESTNET) parent live on Ethereum Sepolia
  if (domain === 'lynx' || domain === 'tapir') {
    return process.env.TACO_PARENT_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
  }
  // mainnet domain lives on Ethereum mainnet
  return process.env.TACO_PARENT_RPC_URL || 'https://ethereum.publicnode.com';
}

async function getParentProvider(
  currentProvider: ethers.providers.Provider,
  domain: Domain,
): Promise<ethers.providers.Provider> {
  const { chainId } = await currentProvider.getNetwork();
  const isAlreadyParent = chainId === 1 || chainId === 11155111;
  if (isAlreadyParent) return currentProvider;
  return new ethers.providers.JsonRpcProvider(getDefaultParentRpcUrl(domain));
}

export class SigningCoordinatorAgent {
  public static async getParticipants(
    provider: ethers.providers.Provider,
    domain: Domain,
    cohortId: number,
  ): Promise<SignerInfo[]> {
    // Read participants from parent coordinator (canonical source)
    const parentProvider = await getParentProvider(provider, domain);
    const coordinator = await this.connectReadOnly(parentProvider, domain);
    const participants = await coordinator.getSigners(cohortId);

    return participants.map(
      (
        participant: SigningCoordinator.SigningCohortParticipantStructOutput,
      ) => {
        return {
          operator: participant.operator,
          provider: participant.provider,
          signature: participant.signature,
        };
      },
    );
  }

  public static async getThreshold(
    provider: ethers.providers.Provider,
    domain: Domain,
    cohortId: number,
  ): Promise<number> {
    // Read threshold from parent coordinator (canonical source)
    const parentProvider = await getParentProvider(provider, domain);
    const coordinator = await this.connectReadOnly(parentProvider, domain);
    const cohort = await coordinator.signingCohorts(cohortId);
    return cohort.threshold;
  }

  public static async getSigningCohortConditions(
    provider: ethers.providers.Provider,
    domain: Domain,
    cohortId: number,
    chainId: number,
  ): Promise<string> {
    // Read cohort conditions from parent coordinator (canonical source)
    const parentProvider = await getParentProvider(provider, domain);
    const coordinator = await this.connectReadOnly(parentProvider, domain);
    return await coordinator.getSigningCohortConditions(cohortId, chainId);
  }

  public static async setSigningCohortConditions(
    provider: ethers.providers.Provider,
    domain: Domain,
    cohortId: number,
    chainId: number,
    conditions: Uint8Array,
    signer: ethers.Signer,
  ): Promise<ethers.ContractTransaction> {
    const coordinator = await this.connect(provider, domain, signer);
    return await coordinator.setSigningCohortConditions(
      cohortId,
      chainId,
      conditions,
    );
  }

  public static async getCohortMultisigAddress(
    provider: ethers.providers.Provider,
    domain: Domain,
    cohortId: number,
    chainId: number,
  ): Promise<string> {
    const network = await provider.getNetwork();
    let childAddress: string;

    if (network.chainId === chainId) {
      // Already on the child chain; resolve the child coordinator directly
      childAddress = getContractAddress(domain, chainId, 'SigningCoordinator');
    } else {
      // On parent; fetch the child coordinator address for the target chain
      const coordinator = await this.connectReadOnly(provider, domain);
      childAddress = await coordinator.getSigningCoordinatorChild(chainId);
    }

    const childContract = new ethers.Contract(
      childAddress,
      ['function cohortMultisigs(uint32) view returns (address)'],
      provider,
    );
    return await childContract.cohortMultisigs(cohortId);
  }

  private static async connectReadOnly(
    provider: ethers.providers.Provider,
    domain: Domain,
  ) {
    return await this.connect(provider, domain);
  }

  private static async connect(
    provider: ethers.providers.Provider,
    domain: Domain,
    signer?: ethers.Signer,
  ): Promise<SigningCoordinator> {
    const network = await provider.getNetwork();
    const contractAddress = getContractAddress(
      domain,
      network.chainId,
      'SigningCoordinator',
    );
    // Debug: print resolved coordinator address and source chain
    // eslint-disable-next-line no-console
    console.log(
      `SigningCoordinator address [domain=${String(domain)} chainId=${network.chainId}]: ${contractAddress}`,
    );
    return SigningCoordinator__factory.connect(
      contractAddress,
      signer ?? provider,
    );
  }
}
