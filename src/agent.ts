import { ArenaClient } from "./client.js";
import { fundDeal } from "./funding.js";
import { greedyMover } from "./mover.js";
import type { AgentConfig, FundingMemo, NegotiationDecision } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic fallback negotiator: accept any stake at/under the ceiling,
 *  otherwise counter down to the ceiling once, then decline. */
function defaultDecision(proposed: number, max: number, rounds: number): NegotiationDecision {
  if (proposed <= max) return { action: "accept", text: "Deal." };
  if (rounds < 2) return { action: "counter", stake: max, text: `Let's do ${max}.` };
  return { action: "decline", text: "Above my ceiling." };
}

/**
 * Run an autonomous arena agent until the process is stopped. It registers,
 * optionally opens a challenge, negotiates every challenge it sees, funds each
 * accepted deal on-chain (USDC approve + joinGame), and plays every match.
 *
 * Returns a `stop()` you can call to shut the client down.
 */
export async function runAgent(config: AgentConfig): Promise<{ stop: () => Promise<void> }> {
  const log = config.log ?? ((...a) => console.log(`[${config.name}]`, ...a));
  const maxStake = config.maxStake ?? 5;
  const client = new ArenaClient(config.arenaUrl, config.privateKey, config.name);

  await client.connect();
  const { agentId } = await client.register({
    persona: config.persona,
    settlementAccount: config.settlementAccount,
    maxStake,
  });
  log(`registered ${agentId ?? ""} wallet=${client.wallet}`);

  if (config.openStake != null) {
    await client
      .call("arena_post_challenge", {
        stakeMin: String(Math.min(config.openStake, maxStake)),
        stakeMax: String(Math.min(config.openStake, maxStake)),
        seats: 2,
        message: `${config.name} is looking for a match.`,
      })
      .then((r) => log("posted challenge", r))
      .catch((e) => log("post_challenge failed:", (e as Error).message));
  }

  const rounds = new Map<string, number>();
  const funded = new Set<string>();
  const playing = new Set<string>();
  const skip = new Set<string>();
  let running = true;

  async function decide(challengeId: string, proposed: number): Promise<NegotiationDecision> {
    const r = rounds.get(challengeId) ?? 0;
    rounds.set(challengeId, r + 1);
    if (config.negotiator) {
      return config.negotiator({
        challenge: { id: challengeId, stake: { amount: String(proposed), currency: "USDC" } },
        proposedStake: proposed,
        maxStake,
        persona: config.persona ?? "",
      });
    }
    return defaultDecision(proposed, maxStake, r);
  }

  async function fund(dealId: string, memoRaw: unknown): Promise<void> {
    if (funded.has(dealId) || skip.has(dealId)) return;
    let memo: FundingMemo | undefined;
    try {
      const src = typeof memoRaw === "string" ? JSON.parse(memoRaw) : memoRaw;
      memo = (src?.memo && typeof src.memo === "string" ? JSON.parse(src.memo) : src) as FundingMemo;
    } catch {
      /* fall through */
    }
    if (!memo?.factory) {
      // Pull the deal to get its funding memo if the event didn't carry it.
      const d = await client.call<any>("arena_get_deal", { dealId }).catch(() => null);
      const fi = d?.deal?.funding ?? d?.funding;
      const raw = typeof fi?.memo === "string" ? fi.memo : undefined;
      if (raw) {
        try {
          memo = JSON.parse(raw) as FundingMemo;
        } catch {
          /* ignore */
        }
      }
    }
    if (!memo?.factory) {
      log(`deal ${dealId.slice(0, 8)}: no funding memo yet`);
      return;
    }
    try {
      const res = await fundDeal({ privateKey: config.privateKey, rpcUrl: config.rpcUrl, memo });
      log(`staked deal ${dealId.slice(0, 8)} join=${res.joinTx}`);
      await client.call("arena_fund_deal", { dealId }).catch(() => {});
      funded.add(dealId);
    } catch (e) {
      log(`fund ${dealId.slice(0, 8)} failed:`, (e as Error).message);
      skip.add(dealId);
    }
  }

  async function play(gameId: string): Promise<void> {
    const mover = config.mover ?? greedyMover;
    log(`playing ${gameId}`);
    while (running) {
      let turn: any;
      try {
        turn = await client.call("arena_await_turn", { gameId });
      } catch {
        break;
      }
      if (!turn || turn.finished || turn.gameOver || turn.result) break;
      const grid: string[] | undefined = turn.grid ?? turn.view ?? turn.board;
      if (!grid) continue;
      const move = await mover(grid);
      if (move) await client.call("arena_submit_move", { gameId, direction: move }).catch(() => {});
    }
    playing.delete(gameId);
    log(`match ${gameId} over`);
  }

  (async () => {
    let cursor: string | number | undefined;
    while (running) {
      try {
        // 1) Fund any accepted deal that is waiting on our stake.
        const st = await client.call<any>("arena_status", {});
        for (const f of st?.awaitingFunding ?? []) {
          const dealId = f.dealId ?? f.id ?? f.deal?.id;
          if (dealId && !f.yourStakeCommitted) await fund(dealId, f.funding ?? f);
        }

        // 2) Drain events: negotiate messages, kick off matches.
        const evs = await client.call<any>("arena_await_event", { since: cursor }).catch(() => null);
        const list = evs?.events ?? (Array.isArray(evs) ? evs : []);
        for (const ev of list) {
          cursor = ev.cursor ?? ev.id ?? cursor;
          const type = String(ev.type ?? "");
          if (/game_started|match_started/i.test(type)) {
            const gameId = ev.gameId ?? ev.game?.id;
            if (gameId && !playing.has(gameId)) {
              playing.add(gameId);
              play(gameId).catch((e) => log("play error:", (e as Error).message));
            }
          } else if (/message|offer|counter|challenge/i.test(type)) {
            const chId = ev.challengeId ?? ev.payload?.challengeId;
            if (!chId || skip.has(chId)) continue;
            const proposed = Number(ev.proposedStake ?? ev.stake?.amount ?? ev.stake ?? maxStake);
            const d = await decide(chId, proposed);
            if (d.action === "accept") {
              const acc = await client
                .call<any>("arena_accept_challenge", { challengeId: chId, offerId: ev.offerId })
                .catch((e) => {
                  log("accept failed:", (e as Error).message);
                  return null;
                });
              const dealId = acc?.dealId ?? acc?.deal?.id;
              if (dealId) await fund(dealId, acc?.funding);
            } else if (d.action === "counter") {
              await client
                .call("arena_send_message", {
                  challengeId: chId,
                  text: d.text ?? `Let's do ${d.stake}.`,
                  counterOffer: { stakeAmount: String(d.stake) },
                })
                .catch(() => {});
            }
          }
        }
      } catch (e) {
        log("loop:", (e as Error).message);
      }
      await sleep(1500);
    }
  })();

  return {
    stop: async () => {
      running = false;
      await client.close();
    },
  };
}
