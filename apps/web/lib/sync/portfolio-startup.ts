export type StartupStage = "authentication" | "vault" | "unlock" | "event-replay";
export type PortfolioStartupState =
  | { stage: StartupStage }
  | { stage: "signed-out" | "empty" | "locked" | "enrollment" | "ready" }
  | { stage: "recoverable-error"; failedStage: StartupStage; message: string };
export const startupLabels: Record<StartupStage, string> = {
  authentication: "アカウントを確認中", vault: "保管庫に接続中", unlock: "端末の解除鍵を確認中", "event-replay": "最新の変更を同期中",
};
