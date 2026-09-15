/**
 * Healthy encrypted preference saves are background work, not an actionable
 * warning. Offline saves should be surfaced quickly; an online save only
 * becomes visible when it is unusually slow and the user may need to retry.
 */
export const pendingSyncIndicatorDelay = (online: boolean) => online ? 10_000 : 300;
