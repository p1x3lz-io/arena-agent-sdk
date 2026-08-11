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
      const view = d?.deal ?? d;
      let dfi = view?.funding;
      // Status deliberately stays compact and the persisted deal view does not
      // expose wallet-specific vouchers. Re-entering accept on an already-open
      // challenge is idempotent and returns this agent's fresh funding
      // instructions, which is the recovery path after a runner restart.
      if (!dfi?.memo && view?.source === "challenge" && view?.sourceId && view?.offer?.id) {
        const accepted = await client
          .call<any>("arena_accept_challenge", {
            challengeId: view.sourceId,
            offerId: view.offer.id,
          })
          .catch(() => null);
        dfi = accepted?.funding;
      }
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
      log(
        `staked deal ${dealId.slice(0, 8)} approve=${res.approveTx ?? "already-approved"} join=${res.joinTx}`,
      );
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
      } catch (e) {
        log(`await_turn failed: ${(e as Error).message}`);
        break;
      }
      if (
        !turn ||
        turn.status === "MATCH_FINISHED" ||
        turn.status === "finished" ||
        turn.finished ||
        turn.gameOver ||
        turn.result ||
        turn.ended
      )
        break;
      // The arena serves the board as `observation` (an ASCII string). A
      // `status: "waiting"` reply carries no observation — loop and poll again.
      // The older grid/view/board names never existed on this payload, so the
      // snake never got a board, never submitted a move, and was disqualified
      // for AFK at tick 2.
      const grid: string | string[] | undefined =
        turn.observation ?? turn.grid ?? turn.view ?? turn.board;
      if (!grid) continue;
      const move = await mover(grid);
      if (move)
        // UPPERCASE, because that is what the tool validates. `Move` is
        // lowercase — it is this SDK's public contract, and a custom mover
        // returns "up" — while arena_submit_move takes z.enum(["UP", "DOWN",
        // "LEFT", "RIGHT"]). Every move was therefore rejected with
        // "-32602 Invalid arguments", and the swallowed rejection below made it
        // silent: the snake never turned, llmcomm waited out its 60s decide
        // timeout on every tick, and the match died at the third one with both
        // snakes drifting. Normalised here, at the boundary, so the mover API
        // stays lowercase for whoever writes one.
        await client
          .call("arena_submit_move", {
            gameId,
            direction: move.toUpperCase(),
          })
          .catch((e) => log(`submit failed: ${(e as Error).message}`));
    }
    playing.delete(gameId);
    log(`match ${gameId} over`);
  }

  let posted = false;
  let myChallengeId: string | null = null; // our own open challenge, if any
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
          // The arena reports a live match keyed by `gameRef` (= the deal's
          // game_ref); arena_await_turn/arena_submit_move look the match up via
          // findByGameRef(gameId), so gameId MUST be that gameRef. The older
          // gameId/id/matchId names never exist on this payload — reading them
          // left `gid` undefined, play() was never entered, no moves were ever
          // submitted, and both snakes were disqualified for AFK at tick 2.
          const gid = g.gameRef ?? g.gameId ?? g.dealId ?? g.id ?? g.matchId;
          if (gid) play(gid).catch((e) => log("play:", (e as Error).message));
        }

        // 3) Matchmake. One MATCH at a time — but negotiate freely: an agent may
        //    hold its own challenge AND join others, and let them race to a deal.
        //    We only stop looking once actually committed to a live match (the
        //    arena refuses a second deal at birth, so this is the SDK mirroring
        //    that invariant rather than deadlocking on our own open challenge).
        const inLiveMatch =
          (st?.liveMatches ?? st?.activeGames ?? []).length > 0 || playing.size > 0;
        if (!inLiveMatch) {
          const fm = await client.call<any>("arena_find_match", { maxStake: String(maxStake) }).catch(() => null);
          const routes = fm?.affordable ?? fm?.matches ?? fm?.routes ?? (Array.isArray(fm) ? fm : []);
          const route = routes.find((r: any) => !skip.has(r.challengeId ?? r.id));
          // Re-arm posting once our previous challenge is done. `posted` is a
          // one-shot latch, so without this an agent posts a single challenge
          // for its whole lifetime — the moment every agent's one challenge has
          // resolved (a match, or expiry) nobody re-posts and the arena goes
          // silent. Reset only on an explicit terminal status so a flaky read
          // never spams new challenges.
          if (posted && myChallengeId) {
            const ch = await client
              .call<any>("arena_get_challenge", { challengeId: myChallengeId })
              .catch(() => null);
            const status = String(ch?.challenge?.status ?? ch?.status ?? "").toUpperCase();
            if (["EXPIRED", "CLOSED", "ABORTED", "SETTLED", "CANCELLED", "CANCELED", "DONE"].includes(status)) {
              posted = false;
              myChallengeId = null;
            }
          }
          if (route) {
            await engage(route.challengeId ?? route.id ?? route.challenge?.id);
          } else if (config.openStake != null && !posted) {
            const s = Math.min(config.openStake, maxStake);
            await client
              .call<any>("arena_post_challenge", { stakeMin: String(s), stakeMax: String(s), seats: 2, message: `${config.name} wants a match.` })
              .then((res: any) => {
                posted = true;
                myChallengeId = res?.challengeId ?? res?.challenge?.id ?? res?.id ?? null;
                log(`posted challenge @ ${s} USDC`);
              })
              .catch(() => {});
          }
          // Push every negotiation we are party to toward a close as well.
          for (const n of st?.openNegotiations ?? []) {
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
