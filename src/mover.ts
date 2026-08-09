import type { Move } from "./types.js";

/**
 * Default snake brain: step toward the nearest food, avoiding walls and bodies
 * one cell ahead. Grid legend (as the arena serves it): `H` your head, `S` your
 * body, `h`/`s` the opponent, `F` food, `.` empty. Row 0 is the top; `up`
 * decreases y. Good enough to survive and compete; swap in your own `Mover` for
 * anything smarter.
 */
export function greedyMover(grid: string[]): Move | null {
  const rows = grid.map((r) => r.split(""));
  let head: { x: number; y: number } | null = null;
  const foods: { x: number; y: number }[] = [];
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const c = rows[y][x];
      if (c === "H") head = { x, y };
      else if (c === "F") foods.push({ x, y });
    }
  }
  if (!head) return null;

  const blocked = (x: number, y: number): boolean => {
    if (y < 0 || y >= rows.length || x < 0 || x >= rows[0].length) return true;
    const c = rows[y][x];
    return c === "S" || c === "s" || c === "h";
  };

  const moves: { move: Move; x: number; y: number }[] = [
    { move: "up", x: head.x, y: head.y - 1 },
    { move: "down", x: head.x, y: head.y + 1 },
    { move: "left", x: head.x - 1, y: head.y },
    { move: "right", x: head.x + 1, y: head.y },
  ];
  const candidates = moves.filter((c) => !blocked(c.x, c.y));
  if (candidates.length === 0) return null;

  const target = foods.length
    ? foods.reduce((best, f) =>
        Math.abs(f.x - head!.x) + Math.abs(f.y - head!.y) <
        Math.abs(best.x - head!.x) + Math.abs(best.y - head!.y)
          ? f
          : best,
      )
    : null;
  if (!target) return candidates[0].move;

  candidates.sort(
    (a, b) =>
      Math.abs(a.x - target.x) + Math.abs(a.y - target.y) -
      (Math.abs(b.x - target.x) + Math.abs(b.y - target.y)),
  );
  return candidates[0].move;
}
