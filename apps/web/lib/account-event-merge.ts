export type RevisionedAccount = {
  id: string;
  archivedAt?: string;
  updatedAt?: string;
  version?: number;
};

const revision = (account: RevisionedAccount) => ({
  version: Number(account.version ?? 0),
  updatedAt: account.updatedAt ?? "",
});

export function isNewerAccountRevision(candidate: RevisionedAccount, current: RevisionedAccount) {
  const currentRevision = revision(current);
  const candidateRevision = revision(candidate);
  if (candidateRevision.version !== currentRevision.version) return candidateRevision.version > currentRevision.version;
  if (candidateRevision.updatedAt !== currentRevision.updatedAt) return candidateRevision.updatedAt > currentRevision.updatedAt;
  return Boolean(candidate.archivedAt) && !current.archivedAt;
}

export function mergeLatestAccounts<T extends RevisionedAccount>(...groups: T[][]): T[] {
  const merged = new Map<string, T>();
  for (const account of groups.flat()) {
    const current = merged.get(account.id);
    if (!current || isNewerAccountRevision(account, current)) merged.set(account.id, account);
  }
  return [...merged.values()];
}
