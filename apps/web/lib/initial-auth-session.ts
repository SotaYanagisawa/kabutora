export type InitialAuthSessionSource<User> = {
  completeRedirect: () => Promise<unknown>;
  authStateReady: () => Promise<void>;
  currentUser: () => User | null;
};

export async function settleInitialAuthSession<User>(source: InitialAuthSessionSource<User>) {
  let redirectFailed = false;
  try {
    await source.completeRedirect();
  } catch {
    redirectFailed = true;
  }
  await source.authStateReady();
  return { user: source.currentUser(), redirectFailed };
}
