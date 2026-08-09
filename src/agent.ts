import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaClient } from "./client.js";
import { fundDeal } from "./funding.js";
import { greedyMover } from "./mover.js";
import type { AgentConfig, FundingMemo, NegotiationDecision } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic fallback negotiator: accept any stake at/under the ceiling,
 *  otherwise counter down to the ceiling once, then decline. */
function defaultDecision(proposed: number, max: number, rounds: number): NegotiationDecision {
  if (proposed <= max && proposed > 0) return { action: "accept", text: "Deal." };
  if (rounds < 2) return { action: "counter", stake: max, text: `Let's do ${max}.` };
  return { action: "decline", text: "Above my ceiling." };
}

/** The latest offer on a challenge: what stake, whose it is, and its id. */
function readOffer(ch: any): { stake: number; offerId?: string; by?: string } {
  const offers = ch?.offers ?? [];
  const cur = offers[offers.length - 1] ?? ch?.offer ?? ch?.currentOffer ?? ch ?? {};
  return {
    stake: Number(cur.stakeAmount ?? cur.amount ?? ch?.currentStake ?? ch?.stakeMax ?? 0),
    offerId: ch?.currentOfferId ?? cur.id ?? cur.offerId,
    by: cur.authorId ?? cur.by ?? cur.from ?? ch?.challengerId,
  };
}

/**
 * Run an autonomous arena agent until stopped. It registers, optionally opens a
 * challenge, negotiates the challenges it can afford, funds each accepted deal
 * on-chain (USDC approve + joinGame), and plays every match it enters.
 */
export async function runAgent(config: AgentConfig): Promise<{ stop: () => Promise<void> }> {
  const log = config.log ?? ((...a) => console.log(`[${config.name}]`, ...a));
  const maxStake = config.maxStake ?? 5;
  const tokenFile = config.tokenFile ?? join(tmpdir(), `arena-agent-${config.name}.token`);
  const client = new ArenaClient(config.arenaUrl, config.privateKey, config.name, tokenFile);

  await client.connect();
  const { agentId } = await client.register({
    persona: config.persona,
    settlementAccount: config.settlementAccount,
    maxStake,
  });
  const myId = agentId;
  log(`registered ${myId ?? ""} wallet=${client.wallet}`);

  const rounds = new Map<string, number>();
  const funded = new Set<string>();
  const playing = new Set<string>();
  const skip = new Set<string>();
  let running = true;

  async function decide(chId: string, proposed: number): Promise<NegotiationDecision> {
    const r = rounds.get(chId) ?? 0;
    rounds.set(chId, r + 1);
    if (r > 4) return { action: "decline" }; // don't haggle forever
    if (config.negotiator) {
      return config.negotiator({
        challenge: { id: chId, stake: { amount: String(proposed), currency: "USDC" } },
        proposedStake: proposed,
        maxStake,
        persona: config.persona ?? "",
      });
    }
    return defaultDecision(proposed, maxStake, r);
  }

  async function fund(dealId: string, fi: any): Promise<void> {
    if (!dealId || funded.has(dealId) || skip.has(dealId)) return;
    let memo: FundingMemo | undefined;
    const raw = typeof fi?.memo === "string" ? fi.memo : typeof fi === "string" ? fi : undefined;
    if (raw) {
      try {
        memo = JSON.parse(raw) as FundingMemo;
      } catch {
        /* ignore */
      }
    }
    if (!memo?.factory) {
      const d = await client.call<any>("arena_get_deal", { dealId }).catch(() => null);
      const dfi = d?.deal?.funding ?? d?.funding;
      if (typeof dfi?.memo === "string") {
        try {
          memo = JSON.parse(dfi.memo) as FundingMemo;
        } catch {
          /* ignore */
        }
      }
    }
    if (!memo?.factory) return; // not fundable yet
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
    if (playing.has(gameId)) return;
    playing.add(gameId);
    const mover = config.mover ?? greedyMover;
    log(`playing ${gameId}`);
    while (running) {
      let turn: any;
      try {
        turn = await client.call("arena_await_turn", { gameId });
      } catch {
        break;
      }
      if (!turn || turn.finished || turn.gameOver || turn.result || turn.ended) break;
      const grid: string[] | undefined = turn.grid ?? turn.view ?? turn.board;
      if (!grid) continue;
      const move = await mover(grid);
      if (move) await client.call("arena_submit_move", { gameId, direction: move }).catch(() => {});
    }
    playing.delete(gameId);
    log(`match ${gameId} over`);
  }

  let posted = false;
  const joined = new Set<string>(); // challenges whose party we already joined

  async function engage(chId: string): Promise<void> {
    if (skip.has(chId)) return;
    const chRes = await client.call<any>("arena_get_challenge", { challengeId: chId }).catch(() => null);
    const ch = chRes?.challenge ?? chRes;
    if (!ch || /CLOSED|EXPIRED|ABORT/i.test(ch.status ?? "")) return skip.add(chId), undefined;
    const off = readOffer(ch);
    if (off.by && myId && off.by === myId) return; // our own offer on the table
    const d = await decide(chId, off.stake);

    if (d.action === "counter") {
      await client
        .call("arena_send_message", {
          challengeId: chId,
          text: d.text ?? `Let's do ${d.stake}.`,
          counterOffer: { stakeAmount: String(d.stake) },
        })
        .catch((e) => {
          if (/range|OUT_OF|EXPIRED|CLOSED|NOT_OPEN|BUSY/i.test((e as Error).message)) skip.add(chId);
        });
      joined.add(chId);
      return;
    }
    if (d.action !== "accept") return skip.add(chId), undefined;

    // Accept = join the party (speaking joins it), then accept once it locks.
    if (!joined.has(chId)) {
      try {
        await client.call("arena_send_message", { challengeId: chId, text: "I'm in — let's settle it." });
        joined.add(chId);
      } catch (e) {
        if (/BUSY/i.test((e as Error).message)) return; // still tied to our own — wait
        skip.add(chId);
        return;
      }
    }
    const locked = (await client.call<any>("arena_get_challenge", { challengeId: chId }).catch(() => null))?.challenge ?? null;
    const cur = locked ?? ch;
    const acc = await client
      .call<any>("arena_accept_challenge", { challengeId: chId, offerId: cur.currentOfferId ?? off.offerId })
      .catch((e) => {
        if (/NOT_LOCKED/i.test((e as Error).message)) return null; // party not complete yet — retry next tick
        if (/EXPIRED|CLOSED|NOT_OPEN|already/i.test((e as Error).message)) skip.add(chId);
        return null;
      });
    const dealId = acc?.dealId ?? acc?.deal?.id;
    if (dealId) {
      log(`accepted ${chId.slice(0, 8)} -> deal ${dealId.slice(0, 8)}`);
      await fund(dealId, acc?.funding);
    }
  }

  (async () => {
    while (running) {
      try {
        const st = await client.call<any>("arena_status", {});

        // 1) Fund deals waiting on our stake.
        for (const f of st?.awaitingFunding ?? []) {
          if (!f.yourStakeCommitted) await fund(f.dealId ?? f.id ?? f.deal?.id, f.funding ?? f);
        }
        // 2) Play any live match.
        for (const g of st?.liveMatches ?? st?.activeGames ?? []) {
          const gid = g.gameId ?? g.id ?? g.matchId;
          if (gid) play(gid).catch((e) => log("play:", (e as Error).message));
        }

        // 3) Matchmake. One negotiation at a time: only engage when free, and
        //    prefer joining an existing challenge over opening our own.
        const negotiating = (st?.openNegotiations ?? []).length > 0;
        if (!negotiating) {
          const fm = await client.call<any>("arena_find_match", { maxStake: String(maxStake) }).catch(() => null);
          const routes = fm?.affordable ?? fm?.matches ?? fm?.routes ?? (Array.isArray(fm) ? fm : []);
          const route = routes.find((r: any) => !skip.has(r.challengeId ?? r.id));
          if (route) {
            await engage(route.challengeId ?? route.id ?? route.challenge?.id);
          } else if (config.openStake != null && !posted) {
            const s = Math.min(config.openStake, maxStake);
            await client
              .call("arena_post_challenge", { stakeMin: String(s), stakeMax: String(s), seats: 2, message: `${config.name} wants a match.` })
              .then(() => {
                posted = true;
                log(`posted challenge @ ${s} USDC`);
              })
              .catch(() => {});
          }
        } else if (st.openNegotiations) {
          // We're in a negotiation — try to close any that is ours to accept.
          for (const n of st.openNegotiations) {
            const chId = n.challengeId ?? n.id;
            if (chId && !skip.has(chId)) await engage(chId);
          }
        }
      } catch (e) {
        log("loop:", (e as Error).message);
      }
      await sleep(2500);
    }
  })();

  return {
    stop: async () => {
      running = false;
      await client.close();
    },
  };
}
