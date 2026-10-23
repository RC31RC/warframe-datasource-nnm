/** Repeated rolls from the same pool; never confuse rolls with item quantity. */
export function drawMechanism(expectedDraws: number): Record<string, unknown> {
  if (!Number.isFinite(expectedDraws) || expectedDraws < 0) throw new Error(`Invalid expected draws: ${expectedDraws}`);
  if (expectedDraws <= 1) return { drawCount: 1, activationProbability: expectedDraws, drawMode: "same_pool" };
  if (Number.isSafeInteger(expectedDraws)) {
    return { drawCount: expectedDraws, activationProbability: 1, drawMode: "same_pool" };
  }
  return { expectedDrawCount: expectedDraws, drawMode: "unspecified_fractional_count", mechanismResolution: "unresolved" };
}

export function percentProbability(percent: number | null | undefined): number | null {
  if (percent === null || percent === undefined) return null;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`Per-draw percentage outside 0..100: ${percent}`);
  }
  return Number((percent / 100).toPrecision(12));
}
