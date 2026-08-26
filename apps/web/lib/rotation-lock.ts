export type RotationLockStatus = "locked" | "fallback" | "unlocked";

export type LockableScreenOrientation = {
  lock?: (orientation: "portrait-primary") => Promise<void>;
  unlock?: () => void;
};

export async function applyPortraitRotationLock(
  enabled: boolean,
  orientation: LockableScreenOrientation | null | undefined,
): Promise<RotationLockStatus> {
  if (!enabled) {
    try {
      orientation?.unlock?.();
    } catch {
      // The setting is still disabled even if the browser has already released the lock.
    }
    return "unlocked";
  }

  if (typeof orientation?.lock !== "function") return "fallback";

  try {
    await orientation.lock("portrait-primary");
    return "locked";
  } catch {
    // Mobile Safari and non-full-screen browser tabs need the in-app fallback.
    return "fallback";
  }
}
