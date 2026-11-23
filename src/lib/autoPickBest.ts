export interface BurstCandidate {
  path: string;
  groupId: number | null;
  focusConfidence: number;
  focusKind: string;
  sharpnessVerdict?: string;
}

export interface AutoPickBestResult {
  groupCount: number;
  bestPaths: string[];
  rejectedPaths: string[];
}

function candidateQualityScore(candidate: BurstCandidate): number {
  let score = 0;
  if (candidate.sharpnessVerdict === "sharp") {
    score += 100;
  } else if (candidate.sharpnessVerdict === "soft") {
    score -= 40;
  }

  if (candidate.focusKind === "localized" || candidate.focusKind === "multiple") {
    score += 30;
  } else if (candidate.focusKind === "full-frame") {
    score += 20;
  }

  score += Number.isFinite(candidate.focusConfidence) ? candidate.focusConfidence * 50 : 0;
  return score;
}

/**
 * Given burst/similarity-grouped photos, pick the sharpest frame from every
 * multi-shot group and return the remaining duplicates as reject candidates.
 */
export function computeAutoPickBest(candidates: BurstCandidate[]): AutoPickBestResult {
  const byGroup = new Map<number, BurstCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.groupId === null) continue;
    let list = byGroup.get(candidate.groupId);
    if (!list) {
      list = [];
      byGroup.set(candidate.groupId, list);
    }
    list.push(candidate);
  }

  const bestPaths: string[] = [];
  const rejectedPaths: string[] = [];
  let groupCount = 0;

  for (const group of byGroup.values()) {
    if (group.length < 2) continue;
    groupCount += 1;

    let best = group[0];
    let bestScore = candidateQualityScore(best);
    for (let i = 1; i < group.length; i++) {
      const score = candidateQualityScore(group[i]);
      if (score > bestScore) {
        best = group[i];
        bestScore = score;
      }
    }

    bestPaths.push(best.path);
    for (const item of group) {
      if (item.path !== best.path) {
        rejectedPaths.push(item.path);
      }
    }
  }

  return { groupCount, bestPaths, rejectedPaths };
}
