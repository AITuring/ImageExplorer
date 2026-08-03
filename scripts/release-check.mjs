import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "src-tauri/tauri.conf.json",
  "src-tauri/Entitlements.plist",
  "src-tauri/capabilities/default.json",
  "README.md",
  "README.zh-CN.md",
];

for (const file of requiredFiles) {
  await access(file);
}

const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
if (!tauriConfig.bundle?.active || !tauriConfig.bundle?.macOS?.entitlements) {
  throw new Error("Tauri bundle or macOS entitlements configuration is incomplete");
}

const updater = tauriConfig.plugins?.updater;
if (!updater?.pubkey || !updater?.endpoints?.length) {
  throw new Error("Tauri updater endpoint or public key configuration is incomplete");
}
if (process.env.RELEASE_STRICT === "1" && updater.pubkey.includes("REPLACE_WITH")) {
  throw new Error("Replace the updater public key before a strict release build");
}

const strict = process.env.RELEASE_STRICT === "1";
const signingVariables = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_PASSWORD",
];
const missingSigning = signingVariables.filter((name) => !process.env[name]);

if (missingSigning.length > 0) {
  const message = `Missing signing/notarization variables: ${missingSigning.join(", ")}`;
  if (strict) throw new Error(message);
  console.warn(`[release-check] ${message}`);
}

console.log("[release-check] bundle, entitlements, and documentation checks passed");
