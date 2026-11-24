import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPeopleOrganizeAssignments,
  computeMergedPeopleView,
} from "../src/lib/peopleOrganization.ts";

test("computeMergedPeopleView merges split clusters and updates solo vs group photos", () => {
  const people = [
    {
      personId: "person-1",
      defaultName: "人物 1",
      avatarDataUrl: "data:image/jpeg;base64,AAA",
      faceCount: 2,
      photoPaths: ["/s/1.jpg", "/s/3.jpg"],
      soloPhotoPaths: ["/s/1.jpg"],
    },
    {
      personId: "person-2",
      defaultName: "人物 2",
      avatarDataUrl: "data:image/jpeg;base64,BBB",
      faceCount: 1,
      photoPaths: ["/s/2.jpg"],
      soloPhotoPaths: ["/s/2.jpg"],
    },
    {
      personId: "person-3",
      defaultName: "人物 3",
      avatarDataUrl: null,
      faceCount: 1,
      photoPaths: ["/s/3.jpg"],
      soloPhotoPaths: [],
    },
  ];
  const photos = [
    { path: "/s/1.jpg", fileName: "1.jpg", modified: 1, size: 100, companionFiles: ["1.xmp"], personIds: ["person-1"], primaryPersonId: "person-1" },
    { path: "/s/2.jpg", fileName: "2.jpg", modified: 2, size: 100, companionFiles: [], personIds: ["person-2"], primaryPersonId: "person-2" },
    { path: "/s/3.jpg", fileName: "3.jpg", modified: 3, size: 100, companionFiles: [], personIds: ["person-1", "person-3"], primaryPersonId: "person-1" },
    { path: "/s/4.jpg", fileName: "4.jpg", modified: 4, size: 100, companionFiles: [], personIds: [], primaryPersonId: null },
  ];

  // Merge person-2 into person-1 (e.g. side profile merged with front view)
  const merged = computeMergedPeopleView(
    people,
    photos,
    { "person-1": "模特A", "person-3": "模特B" },
    { "person-2": "person-1" }
  );

  assert.equal(merged.mergedPeople.length, 2);
  assert.equal(merged.mergedPeople[0].name, "模特A");
  assert.deepEqual(merged.mergedPeople[0].photoPaths, ["/s/1.jpg", "/s/2.jpg", "/s/3.jpg"]);
  assert.deepEqual(merged.mergedPeople[0].soloPhotoPaths, ["/s/1.jpg", "/s/2.jpg"]);
  assert.equal(merged.groupPhotos.length, 1);
  assert.equal(merged.noFacePhotos.length, 1);

  const plan = buildPeopleOrganizeAssignments({
    people,
    photos,
    personNames: { "person-1": "模特A", "person-3": "模特B" },
    mergedInto: { "person-2": "person-1" },
    enabledPersonIds: { "person-1": true, "person-3": true },
    multiPersonMode: "group_folder",
    includeGroupPhotos: true,
    groupFolderName: "多人合照",
    includeNoFacePhotos: false,
    noFaceFolderName: "未检测到人脸",
  });

  assert.equal(plan.assignments.length, 3);
  assert.equal(plan.companionCount, 1);
  assert.deepEqual(
    plan.assignments.map((a) => [a.sourcePath, a.targetFolderName]),
    [
      ["/s/1.jpg", "模特A"],
      ["/s/2.jpg", "模特A"],
      ["/s/3.jpg", "多人合照"],
    ]
  );
});
