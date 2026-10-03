"use client";

import { Component, type ReactNode } from "react";

/** A chart failure must not lock users out of their ledger or recovery controls. */
export default class ChartErrorBoundary extends Component<
  { children: ReactNode; resetKey: unknown },
  { failed: boolean; resetKey: unknown }
> {
  state = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props: { resetKey: unknown }, state: { resetKey: unknown }) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="empty-state chart-recovery" role="status">
      <span>チャートを表示できませんでした</span>
      <button className="text-button" onClick={() => this.setState({ failed: false })}>チャートを再表示</button>
    </div>;
  }
}
