import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Thin wrapper over the arena's MCP surface. Handles the connection, the SIWE
 * registration handshake, and threading the returned `agentToken` onto every
 * subsequent tool call.
 */
export class ArenaClient {
  private client: Client;
  private token: string | null = null;
  readonly wallet: string;
  private readonly privateKey: Hex;

  constructor(
    private readonly arenaUrl: string,
    privateKey: Hex,
    private readonly agentName: string,
  ) {
    this.privateKey = privateKey;
    this.wallet = getAddress(privateKeyToAccount(privateKey).address);
    this.client = new Client({ name: agentName, version: "0.1.0" });
  }

  async connect(): Promise<void> {
    await this.client.connect(new StreamableHTTPClientTransport(new URL(this.arenaUrl)));
  }

  /** Call any arena tool. The agent token is attached automatically once registered. */
  async call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const withTok = this.token && name !== "arena_register_agent" ? { agentToken: this.token, ...args } : args;
    const res = await this.client.callTool({ name, arguments: withTok });
    const content = (res as any).content;
    const text = Array.isArray(content) ? content.find((c: any) => c.type === "text")?.text : undefined;
    if ((res as any).isError) {
      throw new Error(typeof text === "string" ? text : `arena tool ${name} failed`);
    }
    if (typeof text !== "string") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** SIWE-register the wallet, capture the agent token, and record the mandate. */
  async register(opts: {
    persona?: string;
    settlementAccount?: string;
    maxStake?: number;
  }): Promise<{ agentId?: string }> {
    const account = privateKeyToAccount(this.privateKey);
    const message = `p1x3lz-arena:register:${this.wallet}:${this.agentName}`;
    const signature = await account.signMessage({ message });
    const settlement = opts.settlementAccount ?? this.wallet;

    const reg = await this.call<{ agentToken?: string; agentId?: string }>("arena_register_agent", {
      name: this.agentName,
      wallet: this.wallet,
      signature,
      persona: opts.persona ?? "",
      settlementAccount: settlement,
    });
    if (!reg?.agentToken) throw new Error("register returned no agentToken");
    this.token = reg.agentToken;

    // Best-effort setup: none of these should abort a working registration.
    await this.tryCall("arena_set_settlement_account", { settlementAccount: settlement });
    if (opts.maxStake != null) {
      await this.tryCall("arena_set_mandate", {
        maxStakePerMatch: String(opts.maxStake),
        maxDailyExposure: null,
      });
    }
    return { agentId: reg.agentId };
  }

  private async tryCall(name: string, args: Record<string, unknown>): Promise<void> {
    try {
      await this.call(name, args);
    } catch {
      /* optional surface — ignore */
    }
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
  }
}
