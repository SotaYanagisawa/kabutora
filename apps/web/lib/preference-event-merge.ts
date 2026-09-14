import type { SearchSecurity, UserPreferences } from "@/components/dashboard/types";

export type PreferenceEventItem = {
  kind: "preferences";
  value: UserPreferences;
  updatedAt?: string;
  clientTimestamp?: string;
  clientSeq?: number;
};

export type WatchlistEventItem = {
  kind: "watchlist";
  value: SearchSecurity[];
  updatedAt?: string;
  clientTimestamp?: string;
  clientSeq?: number;
};

export function getPreferenceEventSequence(event: {
  clientSeq?: number;
  clientTimestamp?: string;
  updatedAt?: string;
  value?: unknown;
}): number {
  if (typeof event.clientSeq === "number" && Number.isFinite(event.clientSeq) && event.clientSeq > 0) {
    return event.clientSeq;
  }
  const valueObj = event.value && typeof event.value === "object" && !Array.isArray(event.value)
    ? (event.value as { updatedAt?: string; deletedAt?: string })
    : undefined;
  const timestampStr = event.updatedAt ?? event.clientTimestamp ?? valueObj?.updatedAt ?? valueObj?.deletedAt;
  return timestampStr ? Date.parse(timestampStr) || 0 : 0;
}

export function mergeLatestPreferences(
  basePreferences: UserPreferences | undefined,
  events: PreferenceEventItem[],
  currentLocalPreferences?: UserPreferences | null,
): UserPreferences {
  if (!events.length && !currentLocalPreferences) {
    return basePreferences ?? {};
  }

  // Sort events chronologically ascending: oldest first, newest last
  const sortedEvents = [...events].sort((a, b) => getPreferenceEventSequence(a) - getPreferenceEventSequence(b));

  const reducedFromEvents = sortedEvents.reduce<UserPreferences>((acc, item) => ({
    ...acc,
    ...item.value,
    ...(acc.readNotifications || item.value.readNotifications ? {
      readNotifications: [...new Set([...(acc.readNotifications ?? []), ...(item.value.readNotifications ?? [])])],
    } : {}),
    ...(acc.acknowledgedActions || item.value.acknowledgedActions ? {
      acknowledgedActions: [...new Set([...(acc.acknowledgedActions ?? []), ...(item.value.acknowledgedActions ?? [])])],
    } : {}),
    updatedAt: item.updatedAt ?? item.value.updatedAt ?? acc.updatedAt,
  }), basePreferences ?? {});

  if (!currentLocalPreferences) {
    return reducedFromEvents;
  }

  // Check if currentLocalPreferences is newer than reducedFromEvents
  const localSeq = getPreferenceEventSequence({ value: currentLocalPreferences, updatedAt: currentLocalPreferences.updatedAt });
  const remoteSeq = getPreferenceEventSequence({ value: reducedFromEvents, updatedAt: reducedFromEvents.updatedAt });

  if (localSeq > remoteSeq) {
    // Local preferences are newer than remote snapshot: keep local scalar preferences, union sets
    return {
      ...reducedFromEvents,
      ...currentLocalPreferences,
      ...(reducedFromEvents.readNotifications || currentLocalPreferences.readNotifications ? {
        readNotifications: [...new Set([...(reducedFromEvents.readNotifications ?? []), ...(currentLocalPreferences.readNotifications ?? [])])],
      } : {}),
      ...(reducedFromEvents.acknowledgedActions || currentLocalPreferences.acknowledgedActions ? {
        acknowledgedActions: [...new Set([...(reducedFromEvents.acknowledgedActions ?? []), ...(currentLocalPreferences.acknowledgedActions ?? [])])],
      } : {}),
      updatedAt: currentLocalPreferences.updatedAt ?? reducedFromEvents.updatedAt,
    };
  }

  return reducedFromEvents;
}

export function selectLatestWatchlist(
  baseWatchlist: SearchSecurity[] | undefined,
  events: WatchlistEventItem[],
  currentLocalWatchlist?: SearchSecurity[] | null,
  localWatchlistUpdatedAt?: number,
): SearchSecurity[] | undefined {
  if (!events.length) {
    return currentLocalWatchlist ?? baseWatchlist;
  }

  const sortedEvents = [...events].sort((a, b) => getPreferenceEventSequence(a) - getPreferenceEventSequence(b));
  const latestEvent = sortedEvents.at(-1)!;
  const latestEventSeq = getPreferenceEventSequence(latestEvent);

  if (currentLocalWatchlist && localWatchlistUpdatedAt && localWatchlistUpdatedAt > latestEventSeq) {
    return currentLocalWatchlist;
  }

  return latestEvent.value;
}
