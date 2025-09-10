import { getContract } from '@nucypher/nucypher-contracts';
import { ethers } from 'ethers';

import { Domain } from '../../porter';
import { SigningCoordinator__factory } from '../ethers-typechain';
import { SigningCoordinator } from '../ethers-typechain/SigningCoordinator';

type SignerInfo = {
  operator: string;
  provider: string;
  signature: string;
};

export class SigningCoordinatorAgent {
  public static async getParticipants(
    provider: ethers.providers.Provider,
    domain: Domain,
    cohortId: number,
  ): Promise<SignerInfo[]> {
    const coordinator = await this.connectReadOnly(provider, domain);
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
    const coordinator = await this.connectReadOnly(provider, domain);
    const cohort = await coordinator.signingCohorts(cohortId);
    return cohort.threshold;
  }

  public static async getSigningCohortConditions(
    provider: ethers.providers.Provider,
    domain: Domain,
    cohortId: number,
    chainId: number,
  ): Promise<string> {
    const coordinator = await this.connectReadOnly(provider, domain);
    const cohortCondition = await coordinator.getSigningCohortConditions(
      cohortId,
      chainId,
    );
    return cohortCondition;
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
    const coordinator = await this.connectReadOnly(provider, domain);

    // Get the SigningCoordinatorChild contract address for this chain
    const childAddress = await coordinator.getSigningCoordinatorChild(chainId);

    // Create a contract instance for the child (using generic Contract interface)
    const childContract = new ethers.Contract(
      childAddress,
      [
        // ABI for the cohortMultisigs function
        'function cohortMultisigs(uint32) view returns (address)',
      ],
      provider,
    );

    // Get the multisig address for this cohort
    const multisigAddress = await childContract.cohortMultisigs(cohortId);
    return multisigAddress;
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
    const contractAddress = getContract(
      domain,
      network.chainId,
      'SigningCoordinator',
    );
    return SigningCoordinator__factory.connect(
      contractAddress,
      signer ?? provider,
    );
  }
}
