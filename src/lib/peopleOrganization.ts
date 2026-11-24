export type MultiPersonMode = "group_folder" | "primary_person" | "duplicate_to_all";

export interface PersonClusterLike {
  personId: string;
  defaultName: string;
  avatarDataUrl: string | null;
  faceCount: number;
  photoPaths: string[];
  soloPhotoPaths: string[];
}

export interface PeoplePhotoLike {
  path: string;
  fileName: string;
  modified: number | null;
  size: number;
  companionFiles: string[];
  personIds: string[];
  primaryPersonId: string | null;
}

export interface MergedPersonView {
  personId: string;
  name: string;
  avatarDataUrl: string | null;
  photoPaths: string[];
  soloPhotoPaths: string[];
  mergedIds: string[];
}

export interface PlannedPersonAssignment {
  sourcePath: string;
  targetFolderName: string;
  companionCount: number;
}

export function resolveCanonicalPersonId(
  personId: string,
  mergedInto: Record<string, string>
): string {
  let cur = personId;
  const visited = new Set<string>();
  while (mergedInto[cur] && !visited.has(cur)) {
    visited.add(cur);
    cur = mergedInto[cur];
  }
  return cur;
}

export function computeMergedPeopleView(
  people: PersonClusterLike[],
  photos: PeoplePhotoLike[],
  personNames: Record<string, string>,
  mergedInto: Record<string, string>
): {
  mergedPeople: MergedPersonView[];
  groupPhotos: PeoplePhotoLike[];
  noFacePhotos: PeoplePhotoLike[];
  effectivePhotos: Array<
    PeoplePhotoLike & { effectivePersonIds: string[]; effectivePrimaryId: string | null }
  >;
} {
  const byId = new Map<string, PersonClusterLike>();
  for (const p of people) {
    byId.set(p.personId, p);
  }

  const effectivePhotos = photos.map((photo) => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const pid of photo.personIds) {
      const canonical = resolveCanonicalPersonId(pid, mergedInto);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        ids.push(canonical);
      }
    }
    const primary = photo.primaryPersonId
      ? resolveCanonicalPersonId(photo.primaryPersonId, mergedInto)
      : (ids[0] ?? null);
    return {
      ...photo,
      effectivePersonIds: ids,
      effectivePrimaryId: primary,
    };
  });

  const mergedMap = new Map<string, MergedPersonView>();
  for (const p of people) {
    const canonical = resolveCanonicalPersonId(p.personId, mergedInto);
    let view = mergedMap.get(canonical);
    if (!view) {
      const base = byId.get(canonical) ?? p;
      view = {
        personId: canonical,
        name: (personNames[canonical] ?? base.defaultName).trim() || base.defaultName,
        avatarDataUrl: base.avatarDataUrl ?? p.avatarDataUrl,
        photoPaths: [],
        soloPhotoPaths: [],
        mergedIds: [canonical],
      };
      mergedMap.set(canonical, view);
    }
    if (canonical !== p.personId && !view.mergedIds.includes(p.personId)) {
      view.mergedIds.push(p.personId);
    }
    if (!view.avatarDataUrl && p.avatarDataUrl) {
      view.avatarDataUrl = p.avatarDataUrl;
    }
  }

  const groupPhotos: PeoplePhotoLike[] = [];
  const noFacePhotos: PeoplePhotoLike[] = [];

  for (const photo of effectivePhotos) {
    if (photo.effectivePersonIds.length === 0) {
      noFacePhotos.push(photo);
      continue;
    }
    for (const pid of photo.effectivePersonIds) {
      const view = mergedMap.get(pid);
      if (view) view.photoPaths.push(photo.path);
    }
    if (photo.effectivePersonIds.length === 1) {
      const view = mergedMap.get(photo.effectivePersonIds[0]);
      if (view) view.soloPhotoPaths.push(photo.path);
    } else {
      groupPhotos.push(photo);
    }
  }

  const mergedPeople = Array.from(mergedMap.values()).sort(
    (a, b) => b.photoPaths.length - a.photoPaths.length
  );

  return { mergedPeople, groupPhotos, noFacePhotos, effectivePhotos };
}

export function buildPeopleOrganizeAssignments(params: {
  people: PersonClusterLike[];
  photos: PeoplePhotoLike[];
  personNames: Record<string, string>;
  mergedInto: Record<string, string>;
  enabledPersonIds: Record<string, boolean>;
  multiPersonMode: MultiPersonMode;
  includeGroupPhotos: boolean;
  groupFolderName: string;
  includeNoFacePhotos: boolean;
  noFaceFolderName: string;
}): {
  assignments: PlannedPersonAssignment[];
  folderCount: number;
  companionCount: number;
} {
  const { mergedPeople, effectivePhotos } = computeMergedPeopleView(
    params.people,
    params.photos,
    params.personNames,
    params.mergedInto
  );

  const nameById = new Map<string, string>();
  for (const p of mergedPeople) {
    nameById.set(p.personId, p.name);
  }

  const assignments: PlannedPersonAssignment[] = [];
  const folders = new Set<string>();
  let companionCount = 0;

  for (const photo of effectivePhotos) {
    const pids = photo.effectivePersonIds;
    if (pids.length === 0) {
      if (params.includeNoFacePhotos && params.noFaceFolderName.trim()) {
        const folder = params.noFaceFolderName.trim();
        assignments.push({
          sourcePath: photo.path,
          targetFolderName: folder,
          companionCount: photo.companionFiles.length,
        });
        folders.add(folder);
        companionCount += photo.companionFiles.length;
      }
      continue;
    }

    if (pids.length === 1) {
      const pid = pids[0];
      if (!params.enabledPersonIds[pid]) continue;
      const folder = nameById.get(pid);
      if (!folder) continue;
      assignments.push({
        sourcePath: photo.path,
        targetFolderName: folder,
        companionCount: photo.companionFiles.length,
      });
      folders.add(folder);
      companionCount += photo.companionFiles.length;
      continue;
    }

    // Multi-person photo
    if (params.multiPersonMode === "group_folder") {
      if (params.includeGroupPhotos && params.groupFolderName.trim()) {
        const folder = params.groupFolderName.trim();
        assignments.push({
          sourcePath: photo.path,
          targetFolderName: folder,
          companionCount: photo.companionFiles.length,
        });
        folders.add(folder);
        companionCount += photo.companionFiles.length;
      }
    } else if (params.multiPersonMode === "primary_person") {
      const primary = photo.effectivePrimaryId;
      if (primary && params.enabledPersonIds[primary]) {
        const folder = nameById.get(primary);
        if (folder) {
          assignments.push({
            sourcePath: photo.path,
            targetFolderName: folder,
            companionCount: photo.companionFiles.length,
          });
          folders.add(folder);
          companionCount += photo.companionFiles.length;
        }
      }
    } else if (params.multiPersonMode === "duplicate_to_all") {
      for (const pid of pids) {
        if (!params.enabledPersonIds[pid]) continue;
        const folder = nameById.get(pid);
        if (!folder) continue;
        assignments.push({
          sourcePath: photo.path,
          targetFolderName: folder,
          companionCount: photo.companionFiles.length,
        });
        folders.add(folder);
        companionCount += photo.companionFiles.length;
      }
    }
  }

  return { assignments, folderCount: folders.size, companionCount };
}
