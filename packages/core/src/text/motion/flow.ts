export function flowAlpha(arrivedAt: number, now: number, reducedMotion = false): number {
  if (reducedMotion) return 1;
  const age = Math.max(0, now - arrivedAt);
  return Math.min(1, age / 180);
}

export function flowOffset(arrivedAt: number, now: number, reducedMotion = false): number {
  if (reducedMotion) return 0;
  const progress = flowAlpha(arrivedAt, now);
  return (1 - progress) * 4;
}
