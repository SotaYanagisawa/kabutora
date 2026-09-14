"use client";
import { Component, type ReactNode } from "react";

/** Preserve navigation state while allowing the dashboard's idle warm-up to
 * render hidden screens before the user first opens them. */
export class RetainedView extends Component<{ active: boolean; children: ReactNode }> {
  shouldComponentUpdate(next: Readonly<{ active: boolean; children: ReactNode }>) {
    return this.props.active || next.active;
  }
  render() {
    return <div className={`view-cache ${this.props.active ? "active" : ""}`} style={{ display: this.props.active ? "block" : "none" }}>{this.props.children}</div>;
  }
}
