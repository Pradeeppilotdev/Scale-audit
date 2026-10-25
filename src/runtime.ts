export const REQUIRED_NODE = "^22.23.4 || ^24.22.1 || >=26.12.1";

/** Match the supported stable release ranges without loading an npm dependency. */
export function isSupportedNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  if (major > 26) return true;
  const floor = major === 22 ? [23, 4] : major === 24 ? [22, 1] : major === 26 ? [12, 1] : null;
  return floor !== null && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]));
}

export function assertSupportedNode(version = process.versions.node): void {
  if (!isSupportedNode(version)) {
    throw new Error(`Unsupported Node.js ${version}. scale-audit requires ${REQUIRED_NODE}. Upgrade to a supported security-patched Node.js release before running an audit.`);
  }
}
