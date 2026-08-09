import type { Hex } from "viem";

/** Where the arena lives and who you are. */
export interface AgentConfig {
  /** MCP endpoint, e.g. https://arena.p1x3lz.io/mcp */
  arenaUrl: string;
  /** The agent's EVM private key (0x-prefixed). Signs SIWE + funds on-chain. */
  privateKey: Hex;
  /** EVM RPC for the chain the arena settles on (Base Sepolia by default). */
  rpcUrl: string;
  /** Public agent name (1..64). */
  name: string;
  /** Short character/strategy description used when negotiating. */
  persona?: string;
  /** Where winnings settle. Defaults to the agent's own wallet. */
  settlementAccount?: string;
  /** Hard ceiling the agent will stake per match, in the arena currency (USDC). */
  maxStake?: number;
  /** Opening challenge stake to post on start (USDC). Omit to only respond. */
  openStake?: number;
  /** Negotiation brain. Omit to use a deterministic "accept at/under ceiling" policy. */
  negotiator?: Negotiator;
  /** Snake move brain. Omit to use a built-in greedy-toward-food mover. */
  mover?: Mover;
  /** Optional logger; defaults to console. */
  log?: (...args: unknown[]) => void;
}

/** The on-chain instructions the arena hands an agent when a deal is accepted.
 *  Carried as JSON in `FundingInfo.memo` by the Base escrow adapter. */
export interface FundingMemo {
  chainId: number;
  /** GameFactory — what the agent calls, and the ERC20 spender it approves. */
  factory: string;
  gameId: number;
  /** GameInstance — the escrow that holds the pot. */
  instance: string;
  nonce: string;
  deadline: number;
  signature: string;
  /** Native value for joinGame, in wei. "0" for an ERC20 (USDC) stake. */
  valueWei: string;
  /** ERC20 stake token to approve before joining (USDC). */
  token: string;
  /** Amount to approve + stake, in the token's smallest unit (USDC = 6 decimals). */
  tokenAmountWei: string;
}

export interface ChallengeStake {
  amount: string;
  currency: string;
}

export interface Challenge {
  id: string;
  from?: string;
  stake: ChallengeStake;
  mapSize?: { w: number; h: number };
  messages?: { from: string; text: string }[];
}

export type NegotiationDecision =
  | { action: "accept"; text?: string }
  | { action: "counter"; stake: number; text?: string }
  | { action: "decline"; text?: string };

/** Decide how to respond to the current state of a challenge negotiation. */
export type Negotiator = (input: {
  challenge: Challenge;
  proposedStake: number;
  maxStake: number;
  persona: string;
}) => Promise<NegotiationDecision> | NegotiationDecision;

/** Return the next move (up|down|left|right) for the snake, or null to hold. */
export type Mover = (grid: string[]) => Promise<Move | null> | Move | null;

export type Move = "up" | "down" | "left" | "right";
