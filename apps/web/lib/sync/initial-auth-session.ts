import { STARTUP_TIMEOUT_MS, withDeadline } from "../ui/operation-deadline";

export type InitialAuthSessionSource<User> = {
  completeRedirect: () => Promise<unknown>;
  authStateReady: () => Promise<void>;
  currentUser: () => User | null;
};

export async function settleInitialAuthSession<User>(source: InitialAuthSessionSource<User>, timeoutMs = STARTUP_TIMEOUT_MS) {
  return withDeadline(settle(source), timeoutMs, "authentication");
}

async function settle<User>(source: InitialAuthSessionSource<User>) {
  let redirectFailed = false;
  const redirectTask = Promise.resolve()
    .then(() => source.completeRedirect())
    .catch(() => { redirectFailed = true; });
  const authReadyTask = source.authStateReady();
  await Promise.all([redirectTask, authReadyTask]);
  return { user: source.currentUser(), redirectFailed };
}
