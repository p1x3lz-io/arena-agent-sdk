import type { Move } from "./types.js";

/**
 * Default snake brain for the p1x3lz arena observation.
 *
 * The arena serves each turn as an ASCII board wrapped in a tick header, a
 * legend, and per-snake footers. Cell glyphs (see the adapter's
 * `renderObservation`): `@` your head, `o` your body, `X` a rival head, `x` a
 * rival body, `.` empty. Edges WRAP (stepping off one side reappears on the
 * other), and there is no food — it is a survival/PvP snake. Row 0 is the top;
 * `up` decreases y.
 *
 * Strategy: step onto an empty cell (never into a body/head), and among the
 * safe options head toward the nearest rival head to force the action. Good
 * enough to keep the snake alive and moving; swap in your own `Mover` for
 * anything smarter. Accepts the raw observation string or a pre-split row array.
 */
export function greedyMover(input: string | string[]): Move | null {
  const lines = (typeof input === "string" ? input.split("\n") : input).map((r) =>
    r.replace(/\r$/, ""),
  );
  // Keep only the board rows — lines made entirely of cell glyphs. This drops
  // the tick header, the legend, and the "you: … / rival: …" footers.
  const rows = lines.filter((r) => r.length > 0 && /^[@oXx.]+$/.test(r));
  if (rows.length === 0) return null;

  const height = rows.length;
  let head: { x: number; y: number } | null = null;
  const rivals: { x: number; y: number }[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const c = rows[y][x];
      if (c === "@") head = { x, y };
      else if (c === "X") rivals.push({ x, y });
    }
  }
  if (!head) return null;

  const cellAt = (x: number, y: number): string => {
    const yy = ((y % height) + height) % height; // edges wrap
    const row = rows[yy];
    const w = row.length;
    const xx = ((x % w) + w) % w;
    return row[xx] ?? ".";
  };

  const options: { move: Move; x: number; y: number }[] = [
    { move: "up", x: head.x, y: head.y - 1 },
    { move: "down", x: head.x, y: head.y + 1 },
    { move: "left", x: head.x - 1, y: head.y },
    { move: "right", x: head.x + 1, y: head.y },
  ];
  const candidates = options.filter((c) => cellAt(c.x, c.y) === "."); // only empty cells

  if (candidates.length === 0) return null;
  if (rivals.length === 0) return candidates[0].move;

  const width = rows[head.y].length;
  const wrapDist = (ax: number, ay: number, bx: number, by: number): number =>
    Math.min(Math.abs(ax - bx), width - Math.abs(ax - bx)) +
    Math.min(Math.abs(ay - by), height - Math.abs(ay - by));

  candidates.sort((a, b) => {
    const da = Math.min(...rivals.map((r) => wrapDist(a.x, a.y, r.x, r.y)));
    const db = Math.min(...rivals.map((r) => wrapDist(b.x, b.y, r.x, r.y)));
    return da - db;
  });
  return candidates[0].move;
}
