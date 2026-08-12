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
//   LLM_BASE_URL=https://openrouter.ai/api/v1 \
//   LLM_API_KEY=sk-or-... \
//   MODEL=openai/gpt-4o-mini \
//   AGENT_NAME=Cobra AGENT_PRIVATE_KEY=0x... \
//   MAX_STAKE=5 OPEN_STAKE=2 PERSONA="a sharp, frugal negotiator" \
//   SYSTEM_PROMPT="Play defensively: survive, farm food, avoid clashes." \
//   node examples/llm-agent.mjs
//
// Everything is configurable via env: the LLM backend (LLM_BASE_URL, any
// OpenAI-compatible API), its key (LLM_API_KEY), the model (MODEL), how the
// agent negotiates (PERSONA) and how it plays (SYSTEM_PROMPT). Bring a wallet
// + an LLM, get an autonomous arena agent.

import { runAgent, greedyMover } from "../dist/index.js";

const {
  AGENT_PRIVATE_KEY,
  ARENA_URL = "https://arena.p1x3lz.io/mcp",
  RPC_URL = "https://sepolia.base.org",
  AGENT_NAME = "LlmAgent",
  MODEL = "openai/gpt-4o-mini",
  // The LLM backend is fully configurable. Point LLM_BASE_URL at any
  // OpenAI-compatible chat-completions API (OpenRouter, OpenAI, a local
  // llama.cpp/vLLM server, ...). LLM_API_KEY is the credential for it;
  // OPENROUTER_API_KEY is kept as a fallback for back-compat.
  LLM_BASE_URL = "https://openrouter.ai/api/v1",
  LLM_API_KEY,
  OPENROUTER_API_KEY,
  MAX_STAKE,
  OPEN_STAKE,
  PERSONA = "a sharp, competitive Snake player who negotiates hard but fairly",
  // SYSTEM_PROMPT defines the agent's TYPE OF PLAY — its in-match strategy, fed
  // to the LLM that drives the snake. Change it to change how the agent plays
  // (hunt the rival, farm food, play defensively, control the centre, ...).
  // The immutable board mechanics + output contract are always kept around it
  // so a custom prompt can shape strategy without breaking the protocol.
  SYSTEM_PROMPT,
} = process.env;

// The strategy half of the mover's system prompt: SYSTEM_PROMPT if you set one,
// otherwise the default "survive and eat" playstyle.
const STRATEGY =
  SYSTEM_PROMPT?.trim() ||
  "SURVIVE and EAT: every pellet is worth 100 points, so pick the safe move " +
    "that closes the distance to the nearest food. Stay away from the rival's " +
    "head — a head-on collision kills you. Repeating your current heading tick " +
    "after tick is the losing strategy — decide fresh from the board every turn.";

const apiKey = LLM_API_KEY || OPENROUTER_API_KEY;
if (!AGENT_PRIVATE_KEY) throw new Error("set AGENT_PRIVATE_KEY");
if (!apiKey) throw new Error("set LLM_API_KEY (or OPENROUTER_API_KEY)");

const maxStake = MAX_STAKE ? Number(MAX_STAKE) : 5;
const tag = `[${AGENT_NAME}:${MODEL}]`;
// Normalise the base URL (drop any trailing slash) and derive the endpoint.
const chatUrl = `${LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;

/** One chat-completions call to the configured LLM backend. Returns the
 *  assistant text, or null on any failure so the caller can fall back to a
 *  safe deterministic choice. */
async function chat(messages, { timeoutMs = 8000, maxTokens = 200 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(chatUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
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

/** LLM mover: reads the board and returns a move, greedy fallback on failure.
 *
 *  10s per move, not the old 1.5s. The match is LOCKSTEP: llmcomm waits for
 *  every seat before advancing the tick (60s budget in prod), so a slow think
 *  costs pace, never the turn. At 1.5s the model lost the race on most ticks
 *  and the greedy fallback did the actual playing — the snake moved, but the
 *  LLM brain was decoration.
 *
 *  The prompt has to FORCE a decision. The observation's footer ends with
 *  "heading LEFT", and a small model shown that will answer "left" — measured
 *  at 5/5 on a live board, and a whole production match where one seat
 *  submitted the same direction 256 ticks out of 257. On a wrapping grid a
 *  straight line never dies, so the snake "plays" every tick and looks frozen.
 *  So the board is augmented with the wrapped vector to the rival and the
 *  agent's own recent moves, and the instruction names the failure mode. */
let recentMoves = [];

function rivalVector(board) {
  // Both positions come from the observation's structured footer lines:
  //   you: pid 2, head (0,14), heading LEFT, ...
  //   rival: pid 1, head (10,5), heading UP, ...
  const you = board.match(/you: .*?head \((\d+),(\d+)\)/);
  const rival = board.match(/rival: .*?head \((\d+),(\d+)\)/);
  const size = board.match(/grid (\d+)x(\d+)/);
  if (!you || !rival || !size) return null;
  const [w, h] = [Number(size[1]), Number(size[2])];
  // Shortest wrapped delta on each axis: the toroidal board means the rival
  // can be closer through the edge than across the middle.
  const wrap = (d, span) => {
    let v = d % span;
    if (v > span / 2) v -= span;
    if (v < -span / 2) v += span;
    return v;
  };
  const dx = wrap(Number(rival[1]) - Number(you[1]), w);
  const dy = wrap(Number(rival[2]) - Number(you[2]), h);
  const xWord = dx === 0 ? "same column" : `${Math.abs(dx)} ${dx > 0 ? "right" : "left"}`;
  const yWord = dy === 0 ? "same row" : `${Math.abs(dy)} ${dy > 0 ? "down" : "up"}`;
  return `Rival head, shortest wrapped path: ${xWord}, ${yWord} — keep clear of it.`;
}

/** The nearest pellet and the moves that reach it, from the observation's own
 *  "food: (x,y) …" footer. Named outright: a small model told only a vector
 *  still parrots its current heading; told "the eating moves are up and
 *  right" it has to actively reject the meal to keep drifting. */
function foodAdvice(board) {
  const you = board.match(/you: .*?head \((\d+),(\d+)\)/);
  const size = board.match(/grid (\d+)x(\d+)/);
  const line = board.match(/^food: (.+)$/m);
  if (!you || !size || !line) return null;
  const [w, h] = [Number(size[1]), Number(size[2])];
  const wrap = (d, span) => {
    let v = d % span;
    if (v > span / 2) v -= span;
    if (v < -span / 2) v += span;
    return v;
  };
  const me = { x: Number(you[1]), y: Number(you[2]) };
  let best = null;
  for (const m of line[1].matchAll(/\((\d+),(\d+)\)/g)) {
    const dx = wrap(Number(m[1]) - me.x, w);
    const dy = wrap(Number(m[2]) - me.y, h);
    const dist = Math.abs(dx) + Math.abs(dy);
    if (!best || dist < best.dist) best = { dx, dy, dist, x: m[1], y: m[2] };
  }
  if (!best) return null;
  const moves = [];
  if (best.dx > 0) moves.push("right");
  if (best.dx < 0) moves.push("left");
  if (best.dy > 0) moves.push("down");
  if (best.dy < 0) moves.push("up");
  return (
    `Nearest food at (${best.x},${best.y}), ${best.dist} cells away.` +
    (moves.length ? ` Moves that reach it: ${moves.join(", ")}.` : "")
  );
}

async function llmMover(grid) {
  // The arena serves the board as a ready-to-read ASCII string (with its own
  // legend + your/rival positions). Older builds got an array of rows and did
  // grid.join("\n"); calling .join on the string threw, killing the turn before
  // any move was submitted, so the snake was disqualified for AFK.
  const board = typeof grid === "string" ? grid : grid.join("\n");
  const vector = rivalVector(board);
  const history = recentMoves.length
    ? `Your last moves: ${recentMoves.join(", ")}.`
    : "";
  const reply = await chat(
    [
      {
        role: "system",
        content:
          // --- immutable board mechanics (always present) ---
          "You control a snake on a wrapping grid (stepping off one edge reappears " +
          "on the opposite side — there are no walls). Legend: @=your head, " +
          "o=your body, X=rival head, x=rival body, *=food, .=empty. Row 0 is " +
          "the top; up decreases y. Never step onto a body.\n" +
          // --- strategy: SYSTEM_PROMPT or the default survive-and-eat playstyle ---
          `Strategy: ${STRATEGY}\n` +
          // --- immutable output contract (always present) ---
          "Answer with ONE word only: up, down, left, or right.",
      },
      { role: "user", content: [board, foodAdvice(board), vector, history].filter(Boolean).join("\n") },
    ],
    { timeoutMs: 10_000, maxTokens: 8 },
  );
  const m = (reply || "").toLowerCase().match(/up|down|left|right/);
  const move = m ? m[0] : greedyMover(grid);
  if (move) {
    recentMoves.push(move);
    if (recentMoves.length > 6) recentMoves.shift();
  }
  return move;
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

console.log(tag, `running — LLM brain online via ${chatUrl}`);
console.log(tag, `play strategy: ${SYSTEM_PROMPT?.trim() ? "custom SYSTEM_PROMPT" : "default (survive & eat)"}`);
process.on("SIGINT", async () => {
  await agent.stop();
  process.exit(0);
});
