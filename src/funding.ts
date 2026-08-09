import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { FundingMemo } from "./types.js";

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

// GameFactory routes the join and (for ERC20) pulls the stake with
// `usdcToken.safeTransferFrom(msg.sender, instance, stake)` — so the *factory*
// is the spender the agent approves, not the instance.
const FACTORY_ABI = [
  {
    type: "function",
    name: "joinGame",
    stateMutability: "payable",
    inputs: [
      { name: "gameId", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export interface FundResult {
  approveTx?: Hex;
  joinTx: Hex;
}

/**
 * Stake into an accepted deal: approve the stake token to the GameFactory
 * (skipped if allowance already covers it), then call `joinGame` with the
 * arena-minted join voucher. Native-ETH stakes (`token` = zero, `valueWei` > 0)
 * are supported too — the value is forwarded and no approval is sent.
 *
 * Waits for both receipts, so a resolved promise means the stake has landed.
 */
export async function fundDeal(opts: {
  privateKey: Hex;
  rpcUrl: string;
  memo: FundingMemo;
}): Promise<FundResult> {
  const account = privateKeyToAccount(opts.privateKey);
  const chain = defineChain({
    id: opts.memo.chainId,
    name: `chain-${opts.memo.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const wallet = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });
  const pub = createPublicClient({ chain, transport: http(opts.rpcUrl) });

  const factory = getAddress(opts.memo.factory);
  const amount = BigInt(opts.memo.tokenAmountWei ?? "0");
  const value = BigInt(opts.memo.valueWei ?? "0");

  let approveTx: Hex | undefined;
  const isErc20 =
    opts.memo.token &&
    opts.memo.token !== "0x0000000000000000000000000000000000000000" &&
    amount > 0n;

  if (isErc20) {
    const token = getAddress(opts.memo.token);
    const allowance = (await pub.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, factory],
    })) as bigint;
    if (allowance < amount) {
      approveTx = await wallet.writeContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [factory, amount],
      });
      await pub.waitForTransactionReceipt({ hash: approveTx });
    }
  }

  const joinTx = await wallet.writeContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "joinGame",
    args: [
      BigInt(opts.memo.gameId),
      BigInt(opts.memo.nonce),
      BigInt(opts.memo.deadline),
      opts.memo.signature as Hex,
    ],
    value,
  });
  await pub.waitForTransactionReceipt({ hash: joinTx });

  return { approveTx, joinTx };
}
