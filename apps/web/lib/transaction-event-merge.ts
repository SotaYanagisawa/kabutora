export type RevisionedTransaction = {
  id: string;
  version?: number | null;
  updatedAt?: string | null;
  createdAt?: string | null;
};

const revision = (transaction: RevisionedTransaction) => ({
  version: Number(transaction.version ?? 0),
  updatedAt: Date.parse(transaction.updatedAt ?? transaction.createdAt ?? "") || 0,
});

export const isNewerTransaction = <T extends RevisionedTransaction>(candidate: T, current: T) => {
  const next = revision(candidate);
  const previous = revision(current);
  return next.version > previous.version || (next.version === previous.version && next.updatedAt > previous.updatedAt);
};

export const mergeLatestTransactions = <T extends RevisionedTransaction>(...groups: T[][]) => {
  const merged = new Map<string, T>();
  for (const transaction of groups.flat()) {
    const current = merged.get(transaction.id);
    if (!current || isNewerTransaction(transaction, current)) merged.set(transaction.id, transaction);
  }
  return [...merged.values()];
};

export const diffTransactionChanges = <T extends RevisionedTransaction>(current: T[], next: T[]) => {
  const currentById = new Map(current.map((transaction) => [transaction.id, transaction]));
  const nextIds = new Set(next.map((transaction) => transaction.id));
  return {
    upserts: next.filter((transaction) => {
      const existing = currentById.get(transaction.id);
      return !existing || isNewerTransaction(transaction, existing);
    }),
    deletions: current.filter((transaction) => !nextIds.has(transaction.id)),
  };
};
