const VISUAL_DISTANCE_THRESHOLD = 0.42;
const HASH_DISTANCE_THRESHOLD = 0.16;
const EDGE_DISTANCE_THRESHOLD = 0.38;

const INDEXED_HASH_LENGTH = 256;
const HASH_INDEX_CHUNKS = 16;
const HASH_CHUNK_BITS = INDEXED_HASH_LENGTH / HASH_INDEX_CHUNKS;
const MAX_INDEXED_HASH_DIFFERENCES = Math.floor(INDEXED_HASH_LENGTH * HASH_DISTANCE_THRESHOLD);
const HASH_CHUNK_RADIUS = Math.floor(MAX_INDEXED_HASH_DIFFERENCES / HASH_INDEX_CHUNKS);

export interface GroupablePhotoFeatures {
  path: string;
  imageWidth: number;
  imageHeight: number;
  fingerprint: ArrayLike<number>;
  hashBits: ArrayLike<number>;
  edgeFingerprint: ArrayLike<number>;
}

interface PhotoGroup<T extends GroupablePhotoFeatures> {
  representative: T;
  members: T[];
}

function createChunkDifferenceMasks() {
  const masks = [0];
  for (let first = 0; first < HASH_CHUNK_BITS; first += 1) {
    masks.push(1 << first);
  }
  for (let first = 0; first < HASH_CHUNK_BITS; first += 1) {
    for (let second = first + 1; second < HASH_CHUNK_BITS; second += 1) {
      masks.push((1 << first) | (1 << second));
    }
  }
  return masks;
}

const HASH_CHUNK_DIFFERENCE_MASKS = createChunkDifferenceMasks();

function getHashChunk(hashBits: ArrayLike<number>, chunkIndex: number) {
  const start = chunkIndex * HASH_CHUNK_BITS;
  let value = 0;
  for (let offset = 0; offset < HASH_CHUNK_BITS; offset += 1) {
    value = (value << 1) | (hashBits[start + offset] ? 1 : 0);
  }
  return value;
}

/**
 * Multi-index hashing keeps grouping exact while avoiding an all-pairs scan.
 * With 16 chunks, any 256-bit hash within 40 differing bits must have at
 * least one 16-bit chunk within two differences (pigeonhole principle).
 */
class PhotoHashIndex {
  private readonly buckets = Array.from(
    { length: HASH_INDEX_CHUNKS },
    () => new Map<number, number[]>()
  );
  private groupCount = 0;

  add(groupIndex: number, hashBits: ArrayLike<number>) {
    this.groupCount = Math.max(this.groupCount, groupIndex + 1);
    if (hashBits.length !== INDEXED_HASH_LENGTH) return;

    for (let chunkIndex = 0; chunkIndex < HASH_INDEX_CHUNKS; chunkIndex += 1) {
      const chunk = getHashChunk(hashBits, chunkIndex);
      const bucket = this.buckets[chunkIndex].get(chunk) ?? [];
      bucket.push(groupIndex);
      this.buckets[chunkIndex].set(chunk, bucket);
    }
  }

  findCandidates(hashBits: ArrayLike<number>) {
    if (hashBits.length !== INDEXED_HASH_LENGTH || HASH_CHUNK_RADIUS !== 2) {
      return Array.from({ length: this.groupCount }, (_, index) => index);
    }

    const candidates = new Set<number>();
    for (let chunkIndex = 0; chunkIndex < HASH_INDEX_CHUNKS; chunkIndex += 1) {
      const chunk = getHashChunk(hashBits, chunkIndex);
      const buckets = this.buckets[chunkIndex];
      for (const differenceMask of HASH_CHUNK_DIFFERENCE_MASKS) {
        const matches = buckets.get(chunk ^ differenceMask);
        if (!matches) continue;
        for (const groupIndex of matches) candidates.add(groupIndex);
      }
    }

    return [...candidates].sort((first, second) => first - second);
  }
}

function hashesAreWithinThreshold(first: ArrayLike<number>, second: ArrayLike<number>) {
  const length = Math.min(first.length, second.length);
  if (length === 0) return false;
  const maximumDifferences = Math.floor(length * HASH_DISTANCE_THRESHOLD);
  let different = 0;
  for (let index = 0; index < length; index += 1) {
    if (first[index] === second[index]) continue;
    different += 1;
    if (different > maximumDifferences) return false;
  }
  return true;
}

function fingerprintsAreWithinThreshold(
  first: ArrayLike<number>,
  second: ArrayLike<number>,
  threshold: number
) {
  const length = Math.min(first.length, second.length);
  if (length === 0) return false;
  const maximumSquaredDistance = threshold * threshold * length;
  let squaredDistance = 0;
  for (let index = 0; index < length; index += 1) {
    const delta = first[index] - second[index];
    squaredDistance += delta * delta;
    if (squaredDistance > maximumSquaredDistance) return false;
  }
  return true;
}

function isSameView(first: GroupablePhotoFeatures, second: GroupablePhotoFeatures) {
  const firstAspect = first.imageWidth / Math.max(first.imageHeight, 1);
  const secondAspect = second.imageWidth / Math.max(second.imageHeight, 1);
  if (Math.abs(Math.log(firstAspect / secondAspect)) > 0.08) return false;
  if (!hashesAreWithinThreshold(first.hashBits, second.hashBits)) return false;
  if (
    !fingerprintsAreWithinThreshold(
      first.fingerprint,
      second.fingerprint,
      VISUAL_DISTANCE_THRESHOLD
    )
  ) {
    return false;
  }
  return fingerprintsAreWithinThreshold(
    first.edgeFingerprint,
    second.edgeFingerprint,
    EDGE_DISTANCE_THRESHOLD
  );
}

export function groupPhotoFeatures<T extends GroupablePhotoFeatures>(
  featuresInFolderOrder: T[]
): Map<string, number | null> {
  const groups = new Map<string, number | null>();
  const candidates: PhotoGroup<T>[] = [];
  const hashIndex = new PhotoHashIndex();

  for (const features of featuresInFolderOrder) {
    const matchingGroupIndex = hashIndex.findCandidates(features.hashBits).find((groupIndex) => {
      const candidate = candidates[groupIndex];
      return (
        candidate !== undefined &&
        isSameView(candidate.representative, features) &&
        candidate.members.every((member) => isSameView(member, features))
      );
    });

    if (matchingGroupIndex === undefined) {
      const groupIndex = candidates.length;
      candidates.push({ representative: features, members: [features] });
      hashIndex.add(groupIndex, features.hashBits);
    } else {
      candidates[matchingGroupIndex].members.push(features);
    }
  }

  candidates.forEach((candidate, groupId) => {
    if (candidate.members.length < 2) return;
    for (const member of candidate.members) groups.set(member.path, groupId);
  });

  return groups;
}
