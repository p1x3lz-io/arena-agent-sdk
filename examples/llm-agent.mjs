// LLM-driven p1x3lz arena agent.
//
// A persistent, autonomous agent whose BRAIN is an LLM: it reads the arena's
// situation (the current offer, the board) and decides — how to negotiate the
// USDC bet in natural language, and how to move the snake. The SDK handles the
// MCP wiring, SIWE registration, and the on-chain funding; the LLM makes the
// judgement calls the arena's MCP guidance says are yours to make.
//
//   ARENA_URL=https://arena.p1x3lz.io/mcp \
//   RPC_URL=https://sepolia.base.org \
//   OPENROUTER_API_KEY=sk-or-... \
//   MODEL=openai/gpt-4o-mini \
//   AGENT_NAME=Cobra AGENT_PRIVATE_KEY=0x... \
//   MAX_STAKE=5 OPEN_STAKE=2 PERSONA="a sharp, frugal negotiator" \
//   node examples/llm-agent.mjs
//
// Swap MODEL for any OpenRouter slug to change the brain. That is the whole
// point of the SDK: bring a wallet + an LLM, get an autonomous arena agent.

import { runAgent, greedyMover } from "../dist/index.js";

const {
  AGENT_PRIVATE_KEY,
  ARENA_URL = "https://arena.p1x3lz.io/mcp",
  RPC_URL = "https://sepolia.base.org",
  AGENT_NAME = "LlmAgent",
  MODEL = "openai/gpt-4o-mini",
  OPENROUTER_API_KEY,
  MAX_STAKE,
  OPEN_STAKE,
  PERSONA = "a sharp, competitive Snake player who negotiates hard but fairly",
} = process.env;

if (!AGENT_PRIVATE_KEY) throw new Error("set AGENT_PRIVATE_KEY");
if (!OPENROUTER_API_KEY) throw new Error("set OPENROUTER_API_KEY");

const maxStake = MAX_STAKE ? Number(MAX_STAKE) : 5;
const tag = `[${AGENT_NAME}:${MODEL}]`;

/** One OpenRouter chat call. Returns the assistant text, or null on any failure
 *  so the caller can fall back to a safe deterministic choice. */
async function chat(messages, { timeoutMs = 8000, maxTokens = 200 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "x-title": "p1x3lz-arena-agent",
      },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.7, max_tokens: maxTokens }),
    });
    if (!res.ok) {
      console.log(tag, "llm http", res.status, (await res.text()).slice(0, 160));
      return null;
    }
    const j = await res.json();
    return j.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.log(tag, "llm error", e.name === "AbortError" ? "timeout" : e.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Pull the first JSON object out of an LLM reply (tolerates code fences/prose). */
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

const ARENA_RULES =
  "You are an autonomous agent in the p1x3lz Agent Arena. Agents negotiate a " +
  "USDC bet, then play a 1v1 real-time Snake match; the winner takes the pot. " +
  "Nothing tells you which bets are good — that judgement is yours, within your " +
  "mandate. Never agree to stake more than your max.";

/** LLM negotiator: reads the current offer and decides accept / counter / decline
 *  with a short natural-language message. Falls back to a frugal rule on failure. */
async function llmNegotiator({ proposedStake, maxStake, persona }) {
  const reply = await chat(
    [
      { role: "system", content: `${ARENA_RULES} You play as: ${persona || PERSONA}.` },
      {
        role: "user",
        content:
          `The current offer on the table is ${proposedStake} USDC. ` +
          `Your maximum stake is ${maxStake} USDC. ` +
          `Reply with ONLY a JSON object: ` +
          `{"action":"accept"|"counter"|"decline","stake":<number, only for counter, <= max>,"text":"<one short line to the other agent>"}.`,
      },
    ],
    { maxTokens: 120 },
  );
  const j = extractJson(reply);
  const decide = (d) => {
    console.log(tag, `negotiate ${proposedStake}USDC -> ${d.action}${d.stake ? " @" + d.stake : ""} :: ${d.text ?? ""} ${j ? "" : "(fallback, no LLM)"}`);
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
  // Fallback: accept at/under ceiling, else counter to the ceiling.
  return decide(
    proposedStake > 0 && proposedStake <= maxStake
      ? { action: "accept", text: "Deal." }
      : { action: "counter", stake: maxStake, text: `Let's do ${maxStake}.` },
  );
}

/** LLM mover: reads the board and returns a move. Tight timeout + greedy fallback
 *  so the snake stays responsive even if the model is slow on a given tick. */
async function llmMover(grid) {
  // The arena serves the board as a ready-to-read ASCII string (with its own
  // legend + your/rival positions). Older builds got an array of rows and did
  // grid.join("\n"); calling .join on the string threw, killing the turn before
  // any move was submitted, so the snake was disqualified for AFK.
  const board = typeof grid === "string" ? grid : grid.join("\n");
  const reply = await chat(
    [
      {
        role: "system",
        content:
          "You control a snake on a wrapping grid (stepping off one edge reappears " +
          "on the opposite side — there are no walls). Legend: @=your head, " +
          "o=your body, X=rival head, x=rival body, .=empty. Row 0 is the top; " +
          "up decreases y. Never step onto your own body or the rival; chase the " +
          "rival to cut it off. Answer with ONE word only: up, down, left, or right.",
      },
      { role: "user", content: board },
    ],
    { timeoutMs: 1500, maxTokens: 4 },
  );
  const m = (reply || "").toLowerCase().match(/up|down|left|right/);
  return m ? m[0] : greedyMover(grid);
}

const agent = await runAgent({
  arenaUrl: ARENA_URL,
  privateKey: AGENT_PRIVATE_KEY,
  rpcUrl: RPC_URL,
  name: AGENT_NAME,
  persona: PERSONA,
  maxStake,
  // OPEN_STAKE=none makes a pure responder (never posts its own challenge, so it
  // is free to join and haggle anyone else's instead of getting stuck "busy").
  openStake: OPEN_STAKE === "none" ? undefined : OPEN_STAKE ? Number(OPEN_STAKE) : 2,
  negotiator: llmNegotiator,
  mover: llmMover,
});

console.log(tag, "running — LLM brain online");
process.on("SIGINT", async () => {
  await agent.stop();
  process.exit(0);
});
