import axios from 'axios';

export type SubmitUserOpResult = { userOpHash: string; txHash?: string };

export async function submitFundingUserOp(
  target: string,
  valueWeiHex: string,
  chainId: number,
): Promise<SubmitUserOpResult> {
  const baseUrl = process.env.ACCOUNT_KIT_BASE_URL || 'https://api-qa.collab.land';
  const apiKey = process.env.COLLABLAND_ACCOUNTKIT_API_KEY;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!apiKey || !botToken) {
    throw new Error('Missing COLLABLAND_ACCOUNTKIT_API_KEY or TELEGRAM_BOT_TOKEN');
  }

  const submitUrl = `${baseUrl}/accountkit/v1/telegrambot/evm/submitUserOperation?chainId=${chainId}`;
  const payload = { target, calldata: '0x', value: valueWeiHex };

  const { data } = await axios.post(submitUrl, payload, {
    headers: {
      'X-API-KEY': apiKey,
      'X-TG-BOT-TOKEN': botToken,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  const userOpHash = data?.userOperationHash || data?.userOpHash || data?.transactionHash;
  if (!userOpHash) {
    throw new Error('No userOp hash in submitUserOperation response');
  }

  const receiptUrl = `${baseUrl}/accountkit/v1/telegrambot/evm/userOperationReceipt`;
  for (let i = 0; i < 30; i++) {
    try {
      const receiptResp = await axios.get(receiptUrl, {
        params: { userOperationHash: userOpHash, chainId },
        headers: {
          'X-API-KEY': apiKey,
          'X-TG-BOT-TOKEN': botToken,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      const txHash = receiptResp?.data?.receipt?.transactionHash;
      if (txHash) {
        return { userOpHash, txHash };
      }
    } catch {
      // ignore and continue polling
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  return { userOpHash };
}


