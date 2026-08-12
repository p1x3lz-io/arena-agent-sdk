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
 * Strategy: survive and eat. Step onto an empty or food cell (never into a
 * body/head, never voluntarily beside a rival head), and among the safe
 * options head toward the nearest food pellet — the rival's head becomes the
 * target only on a bare board. Good enough to keep the snake alive, moving
 * and scoring; swap in your own `Mover` for anything smarter. Accepts the raw
 * observation string or a pre-split row array.
 */
export function greedyMover(input: string | string[]): Move | null {
  const lines = (typeof input === "string" ? input.split("\n") : input).map((r) =>
    r.replace(/\r$/, ""),
  );
  // Keep only the board rows — lines made entirely of cell glyphs. This drops
  // the tick header, the legend, and the "you: … / rival: …" footers.
  const rows = lines.filter((r) => r.length > 0 && /^[@oXx.*]+$/.test(r));
  if (rows.length === 0) return null;

  const height = rows.length;
  let head: { x: number; y: number } | null = null;
  const rivals: { x: number; y: number }[] = [];
  const food: { x: number; y: number }[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const c = rows[y][x];
      if (c === "@") head = { x, y };
      else if (c === "X") rivals.push({ x, y });
      else if (c === "*") food.push({ x, y });
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
  // Empty and food cells are both walkable — stepping onto a pellet IS eating.
  const candidates = options.filter((c) => cellAt(c.x, c.y) === "." || cellAt(c.x, c.y) === "*");

  if (candidates.length === 0) return null;

  const width = rows[head.y].length;
  const wrapDist = (ax: number, ay: number, bx: number, by: number): number =>
    Math.min(Math.abs(ax - bx), width - Math.abs(ax - bx)) +
    Math.min(Math.abs(ay - by), height - Math.abs(ay - by));

  // Food first: pellets are where the points are (100 each, same economy as
  // the human ladder), and a snake that eats grows into a wall the rival has
  // to respect. The rival's head is only the target when the board is bare —
  // and never something to step next to voluntarily: any candidate adjacent
  // to a rival head risks a head-on collision the engine settles against us.
  const targets = food.length > 0 ? food : rivals;
  const risky = (c: { x: number; y: number }): boolean =>
    rivals.some((r) => wrapDist(c.x, c.y, r.x, r.y) <= 1);
  const pool = candidates.filter((c) => !risky(c)).length > 0
    ? candidates.filter((c) => !risky(c))
    : candidates;
  if (targets.length === 0) return pool[0].move;

  pool.sort((a, b) => {
    const da = Math.min(...targets.map((t) => wrapDist(a.x, a.y, t.x, t.y)));
    const db = Math.min(...targets.map((t) => wrapDist(b.x, b.y, t.x, t.y)));
    return da - db;
  });
  return pool[0].move;
}
