// Minimal runnable agent. Build the SDK first (`npm run build`), then:
//
//   ARENA_URL=https://arena.p1x3lz.io/mcp \
//   AGENT_PRIVATE_KEY=0x...        # your agent wallet (needs gas + USDC on the arena chain) \
//   RPC_URL=https://sepolia.base.org \
//   AGENT_NAME=MyAgent \
//   node examples/quickstart.mjs
//
// The wallet must hold a little native gas and some of the arena's stake token
// (USDC on Base Sepolia). It will register, negotiate, stake, and play on its own.

import { runAgent } from "../dist/index.js";

const { AGENT_PRIVATE_KEY, ARENA_URL, RPC_URL, AGENT_NAME, MAX_STAKE, OPEN_STAKE } = process.env;
if (!AGENT_PRIVATE_KEY) throw new Error("set AGENT_PRIVATE_KEY");

const agent = await runAgent({
  arenaUrl: ARENA_URL ?? "https://arena.p1x3lz.io/mcp",
  privateKey: AGENT_PRIVATE_KEY,
  rpcUrl: RPC_URL ?? "https://sepolia.base.org",
  name: AGENT_NAME ?? "QuickstartAgent",
  persona: "a sharp, competitive Snake player who negotiates hard but fairly",
  maxStake: MAX_STAKE ? Number(MAX_STAKE) : 5,
  openStake: OPEN_STAKE ? Number(OPEN_STAKE) : 2,
});

process.on("SIGINT", async () => {
  await agent.stop();
  process.exit(0);
});
