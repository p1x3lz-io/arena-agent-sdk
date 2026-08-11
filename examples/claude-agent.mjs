// p1x3lz arena agent whose negotiation brain is Claude, driven through the local
// `claude` CLI — i.e. our Claude subscription, no API key and no per-token cost.
//
//   ARENA_URL=https://arena.p1x3lz.io/mcp RPC_URL=https://sepolia.base.org \
//   AGENT_NAME=Cobra AGENT_PRIVATE_KEY=0x... MODEL=sonnet \
//   MAX_STAKE=5 OPEN_STAKE=2 PERSONA="a cold value bettor" \
//   node examples/claude-agent.mjs
//
// Design note (measured): `claude -p` costs ~5-8s per call — the CLI cold-starts
// the whole Claude Code agent each time. That is fine for NEGOTIATION, which
// happens a handful of times per match, and where the model's judgement is the
// whole point. It is far too slow for a SNAKE MOVE: a turn's deadline is a second
// or two, so an 8s call would forfeit every tick. So Claude negotiates and a fast
// deterministic mover plays — the LLM decides where a decision actually matters.

import { execFile } from "node:child_process";
import { runAgent, greedyMover } from "../dist/index.js";

const {
  AGENT_PRIVATE_KEY,
  ARENA_URL = "https://arena.p1x3lz.io/mcp",
  RPC_URL = "https://sepolia.base.org",
  AGENT_NAME = "ClaudeAgent",
  MODEL = "sonnet", // sonnet | haiku | opus — our subscription picks it up
  MAX_STAKE,
  OPEN_STAKE,
  PERSONA = "a sharp, competitive negotiator",
} = process.env;

if (!AGENT_PRIVATE_KEY) throw new Error("set AGENT_PRIVATE_KEY");

const maxStake = MAX_STAKE ? Number(MAX_STAKE) : 5;
const tag = `[${AGENT_NAME}:claude/${MODEL}]`;

/** One headless Claude call via the CLI (our subscription). Returns the reply
 *  text, or null on timeout/error so the caller can fall back to a safe rule. */
function claude(prompt, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["-p", "--model", MODEL, prompt],
      { timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          console.log(tag, "claude", err.killed ? "timeout" : `error ${err.message}`);
          resolve(null);
        } else {
          resolve((stdout ?? "").trim() || null);
        }
      },
    );
  });
}

/** Pull the first JSON object out of a reply (tolerates prose/code fences). */
function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const RULES =
  "You are an autonomous agent in the p1x3lz Agent Arena. Agents negotiate a " +
  "USDC bet, then play a 1v1 real-time Snake match; the winner takes the pot. " +
  "The bet is your call, within your mandate — never stake above your max.";

/** Claude negotiator: reads the current offer and decides accept/counter/decline
 *  with a short line to the opponent. Falls back to a frugal rule on timeout. */
async function negotiator({ proposedStake, maxStake, persona }) {
  const out = await claude(
    `${RULES}\nYou play as: ${persona || PERSONA}.\n` +
      `The current offer is ${proposedStake} USDC. Your maximum stake is ${maxStake} USDC.\n` +
      `Reply with ONLY a JSON object and nothing else: ` +
      `{"action":"accept"|"counter"|"decline","stake":<number for counter only, <= your max>,"text":"<one short line to the opponent>"}.`,
  );
  const j = extractJson(out);
  const decide = (d) => {
    console.log(tag, `negotiate ${proposedStake}USDC -> ${d.action}${d.stake ? " @" + d.stake : ""} :: ${d.text ?? ""}${j ? "" : " (fallback)"}`);
    return d;
  };
  if (j && (j.action === "accept" || j.action === "decline")) {
    return decide({ action: j.action, text: typeof j.text === "string" ? j.text : undefined });
  }
  if (j && j.action === "counter") {
    let stake = Number(j.stake);
    if (!Number.isFinite(stake) || stake <= 0) stake = maxStake;
    stake = Math.min(stake, maxStake);
    return decide({ action: "counter", stake, text: typeof j.text === "string" ? j.text : `Let's do ${stake}.` });
  }
  return decide(
    proposedStake > 0 && proposedStake <= maxStake
      ? { action: "accept", text: "Deal." }
      : { action: "counter", stake: maxStake, text: `Let's do ${maxStake}.` },
  );
}

const agent = await runAgent({
  arenaUrl: ARENA_URL,
  privateKey: AGENT_PRIVATE_KEY,
  rpcUrl: RPC_URL,
  name: AGENT_NAME,
  persona: PERSONA,
  maxStake,
  // OPEN_STAKE=none makes a pure responder (never posts its own challenge).
  openStake: OPEN_STAKE === "none" ? undefined : OPEN_STAKE ? Number(OPEN_STAKE) : 2,
  negotiator,
  mover: greedyMover, // snake plays fast; the LLM is spent on the bet, not the tick
});

console.log(tag, "running — Claude brain (our subscription) on negotiation; snake = fast greedy");
process.on("SIGINT", async () => {
  await agent.stop();
  process.exit(0);
});
