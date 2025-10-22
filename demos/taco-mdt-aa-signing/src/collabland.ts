// Removed in EOA funding branch
export type SubmitUserOpResult = { userOpHash: string; txHash?: string };
export async function submitFundingUserOp(): Promise<SubmitUserOpResult> {
  throw new Error('Account Kit funding removed in this branch');
}


