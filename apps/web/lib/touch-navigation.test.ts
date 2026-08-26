import { describe, expect, it } from "vitest";
import {
  adjacentTouchView,
  isInteractiveInputTarget,
  isSwipeBlockedTarget,
  nativeSwipeCommitDistance,
  resolveTouchAxis,
  shouldCommitNativeSwipe,
  shouldCommitSwipe,
  swipeCommitDistance,
} from "./touch-navigation";

describe("touch navigation", () => {
  const order = ["activity", "watchlist", "overview", "notifications", "settings"] as const;

  it("locks only after deliberate horizontal movement and rejects diagonal movement", () => {
    expect(resolveTouchAxis(5, 2)).toBe("pending");
    expect(resolveTouchAxis(18, 4)).toBe("horizontal");
    expect(resolveTouchAxis(8, 20)).toBe("vertical");
    expect(resolveTouchAxis(15, 12)).toBe("vertical");
    expect(resolveTouchAxis(20, 15)).toBe("vertical");
  });

  it("moves in the visible navigation order without wrapping", () => {
    expect(adjacentTouchView("activity", -60, order)).toBe("watchlist");
    expect(adjacentTouchView("watchlist", -60, order)).toBe("overview");
    expect(adjacentTouchView("overview", -60, order)).toBe("notifications");
    expect(adjacentTouchView("notifications", -60, order)).toBe("settings");
    expect(adjacentTouchView("overview", 60, order)).toBe("watchlist");
    expect(adjacentTouchView("watchlist", 60, order)).toBe("activity");
    expect(adjacentTouchView("activity", 60, order)).toBeNull();
    expect(adjacentTouchView("settings", -60, order)).toBeNull();
  });

  it("accepts a committed distance or a short, fast flick", () => {
    expect(swipeCommitDistance(390)).toBe(62.4);
    expect(shouldCommitSwipe(70, 0.1, 390, true)).toBe(true);
    expect(shouldCommitSwipe(30, 0.5, 390, true)).toBe(true);
    expect(shouldCommitSwipe(30, 0.2, 390, true)).toBe(false);
    expect(shouldCommitSwipe(90, 0.8, 390, false)).toBe(false);
  });

  it("uses a decisive native snap without making deliberate swipes feel heavy", () => {
    expect(nativeSwipeCommitDistance(390)).toBeCloseTo(54.6);
    expect(shouldCommitNativeSwipe(55, 0.1, 390, true)).toBe(true);
    expect(shouldCommitNativeSwipe(20, 0.35, 390, true)).toBe(true);
    expect(shouldCommitNativeSwipe(40, 0.2, 390, true)).toBe(false);
    expect(shouldCommitNativeSwipe(90, 0.8, 390, false)).toBe(false);
  });

  it("correctly identifies interactive input elements vs swipe blocked targets", () => {
    expect(isInteractiveInputTarget(null)).toBe(false);
    expect(isInteractiveInputTarget({})).toBe(false);

    const inputElement = {
      closest: (selector: string) => selector.includes("input") ? {} : null,
    };
    expect(isInteractiveInputTarget(inputElement)).toBe(true);
    expect(isSwipeBlockedTarget(inputElement)).toBe(true);

    const buttonElement = {
      closest: (selector: string) => selector.includes("button") ? {} : null,
    };
    expect(isInteractiveInputTarget(buttonElement)).toBe(false);
    expect(isSwipeBlockedTarget(buttonElement)).toBe(true);
  });

  it("correctly identifies interactive and chart elements to block page swipe gestures", () => {
    expect(isSwipeBlockedTarget(null)).toBe(false);
    expect(isSwipeBlockedTarget({})).toBe(false);

    const normalElement = {
      closest: (selector: string) => selector.includes(".daily-chart") ? null : null,
    };
    expect(isSwipeBlockedTarget(normalElement)).toBe(false);

    const chartElement = {
      closest: (selector: string) => selector.includes(".lightweight-chart") ? {} : null,
    };
    expect(isSwipeBlockedTarget(chartElement)).toBe(true);

    const ignoredElement = {
      closest: (selector: string) => selector.includes("[data-swipe-ignore]") ? {} : null,
    };
    expect(isSwipeBlockedTarget(ignoredElement)).toBe(true);

    const bottomNavElement = {
      closest: (selector: string) => selector.includes(".mobile-nav") ? {} : null,
    };
    expect(isSwipeBlockedTarget(bottomNavElement)).toBe(true);

    const bottomDockElement = {
      closest: (selector: string) => selector.includes(".mobile-control-dock") ? {} : null,
    };
    expect(isSwipeBlockedTarget(bottomDockElement)).toBe(true);

    const buttonElement = {
      closest: (selector: string) => selector.includes("button") ? {} : null,
    };
    expect(isSwipeBlockedTarget(buttonElement)).toBe(true);
  });
});
