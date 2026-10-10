"use client";

import { chartAxisTicks, donutArcPath, downsampleChartPoints, linearSvgPath, niceChartAxis, type SvgPoint } from "@/lib/charts/chart-geometry";
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import ChartErrorBoundary from "./chart-error-boundary";

function useChartSelection<T>(data: T[], identity: unknown = data) {
  const [selection, setSelection] = useState<{ data: T[]; identity: unknown; index: number } | null>(null);
  const activeIndex = selection?.data === data && selection.identity === identity
    && selection.index >= 0 && selection.index < data.length ? selection.index : null;
  const setActiveIndex = (next: number | null | ((current: number | null) => number | null)) => {
    setSelection((previous) => {
      const current = previous?.data === data && previous.identity === identity
        && previous.index < data.length ? previous.index : null;
      const index = typeof next === "function" ? next(current) : next;
      return index == null || index < 0 || index >= data.length ? null : { data, identity, index };
    });
  };
  return [activeIndex, setActiveIndex] as const;
}

type ChartSeries<T> = {
  key: string;
  name: string;
  read: (item: T) => number;
  stroke: string;
  strokeWidth?: number;
  strokeDasharray?: string;
  fillOpacity?: number;
};

/** A shaded time interval behind an intraday series, e.g. a trading session. */
export type ChartBand = {
  /** Unix ms. */
  start: number;
  end: number;
  color: string;
  /** strong: tinted band with edge lines (regular session); soft: light tint (extended hours); none: label only (lunch break). */
  emphasis: "strong" | "soft" | "none";
  label?: string;
  /** Lower draws its label first when labels would collide. */
  priority: number;
};

const BAND_LABEL_SIZE = 9;
/** A time-axis gap longer than this (and than 3× the usual spacing) is drawn flat, then a step. */
const GAP_MIN_MS = 15 * 60_000;
/** Approximate rendered width: full-width glyphs ≈ 1em, others ≈ 0.6em. */
const labelWidth = (text: string, fontSize: number) => [...text].reduce((width, char) => width + (/[\u3000-\u9fff\uff00-\uffef]/u.test(char) ? fontSize : fontSize * 0.6), 0);

type LightweightAreaChartProps<T> = {
  data: T[];
  /** Unix ms of a point. When given, x is proportional to time instead of to the point index. */
  xTime?: (item: T) => number;
  /** Shaded intervals behind the series; drawn only on a time axis. */
  bands?: ChartBand[];
  domain: [number, number];
  series: Array<ChartSeries<T>>;
  xValue: (item: T) => string;
  xTickFormatter: (value: string) => string;
  yTickFormatter: (value: number) => string;
  tickCount: number;
  yAxisWidth: number;
  xAxisHeight: number;
  tickMargin: number;
  minTickGap: number;
  top: number;
  right: number;
  minHeight: number;
  showYAxis?: boolean;
  detailsEnabled?: boolean;
  tooltipContent?: (item: T) => ReactNode;
  ariaLabel: string;
};


function useResponsiveSize(minHeight: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: minHeight });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(minHeight, Math.round(rect.height));
      setSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const onVisibility = () => {
      if (document.visibilityState === "visible") update();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [minHeight]);
  return { ref, size };
}

export function LightweightAreaChart<T>(props: LightweightAreaChartProps<T>) {
  return <ChartErrorBoundary resetKey={props.data}><LightweightAreaChartView {...props} /></ChartErrorBoundary>;
}

function LightweightAreaChartView<T>({
  data,
  xTime,
  bands,
  domain,
  series,
  xValue,
  xTickFormatter,
  yTickFormatter,
  tickCount,
  yAxisWidth,
  xAxisHeight,
  tickMargin,
  minTickGap,
  top,
  right,
  minHeight,
  showYAxis = true,
  detailsEnabled = false,
  tooltipContent,
  ariaLabel,
}: LightweightAreaChartProps<T>) {
  const rawId = useId();
  const gradientId = `light-chart-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { ref, size } = useResponsiveSize(minHeight);
  const [activeIndex, setActiveIndex] = useChartSelection(data, series);
  const left = showYAxis ? yAxisWidth : 8;
  const bottom = xAxisHeight;
  const plotWidth = Math.max(1, size.width - left - right);
  const plotHeight = Math.max(1, size.height - top - bottom);
  const times = useMemo(() => (xTime && data.length > 1 ? data.map(xTime) : null), [data, xTime]);
  const timeStart = times?.[0] ?? 0;
  const timeSpan = times ? Math.max(1, times.at(-1)! - timeStart) : 1;
  const xOfTime = (time: number) => left + ((time - timeStart) / timeSpan) * plotWidth;
  const xAt = (index: number) => times ? xOfTime(times[index]) : left + (data.length <= 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth);
  const yAt = (value: number) => top + ((domain[1] - value) / Math.max(Number.EPSILON, domain[1] - domain[0])) * plotHeight;

  // On a time axis, a gap well beyond the usual point spacing is a closed market: nothing traded, so the value
  // holds flat across it and moves only at the next point.
  const holdsBefore = useMemo(() => {
    if (!times || times.length < 3) return null;
    const spacing = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b);
    const gap = Math.max(GAP_MIN_MS, spacing[spacing.length >> 1] * 3);
    return times.map((time, index) => index > 0 && time - times[index - 1] > gap);
  }, [times]);
  const sampled = useMemo(() => {
    const picked = downsampleChartPoints(data, Math.max(160, Math.floor(plotWidth * 1.5)), series.map((item) => item.read));
    if (!holdsBefore || picked.length === data.length) return picked;
    // Keep both ends of every gap so its flat stretch starts at the true last value.
    const kept = new Set(picked.map((point) => point.index));
    holdsBefore.forEach((hold, index) => {
      if (hold) kept.add(index - 1).add(index);
    });
    return [...kept].sort((a, b) => a - b).map((index) => ({ index, value: data[index] }));
  }, [data, holdsBefore, plotWidth, series]);
  const paths = useMemo(() => series.map((item) => {
    const points: Array<SvgPoint & { hold?: boolean }> = sampled.map(({ index, value }) => ({ x: xAt(index), y: yAt(item.read(value)), hold: holdsBefore?.[index] }));
    const line = linearSvgPath(points);
    const area = points.length ? `${line} L${points.at(-1)!.x.toFixed(2)},${(top + plotHeight).toFixed(2)} L${points[0].x.toFixed(2)},${(top + plotHeight).toFixed(2)} Z` : "";
    return { ...item, points, line, area };
  }), [plotHeight, sampled, series, size.width, domain, top, holdsBefore]);
  const yTicks = useMemo(() => chartAxisTicks(domain, tickCount), [domain, tickCount]);
  const xTickCount = Math.min(data.length, Math.max(2, Math.min(4, Math.floor(plotWidth / Math.max(54, minTickGap + 28)))));
  const xTickIndexes = useMemo(() => [...new Set(Array.from({ length: xTickCount }, (_, index) => Math.round(((index + 1) * (data.length - 1)) / xTickCount)))], [data.length, xTickCount]);
  // Time axis: ticks on whole Tokyo hours, as few as fit.
  const timeTicks = useMemo(() => {
    if (!times) return [];
    const hour = 3_600_000;
    const step = [1, 2, 3, 4, 6, 8, 12, 24].map((hours) => hours * hour).find((candidate) => timeSpan / candidate <= xTickCount + 0.5) ?? 24 * hour;
    const tokyo = 9 * hour;
    const ticks: number[] = [];
    for (let time = Math.ceil((timeStart + tokyo) / step) * step - tokyo; time <= timeStart + timeSpan; time += step) ticks.push(time);
    return ticks;
  }, [timeSpan, timeStart, times, xTickCount]);

  // Session bands clipped to the plotted time range, and labels placed by priority without overlap.
  const bandShapes = useMemo(() => {
    if (!times || !bands?.length) return { rects: [], labels: [] };
    const end = timeStart + timeSpan;
    const rects = bands.filter((band) => band.end > timeStart && band.start < end).map((band) => {
      const x1 = xOfTime(Math.max(band.start, timeStart));
      const x2 = xOfTime(Math.min(band.end, end));
      return { ...band, x1, x2, startsInside: band.start >= timeStart, endsInside: band.end <= end };
    });
    const placed: Array<[number, number]> = [];
    const labels: Array<{ key: string; x: number; text: string; color: string }> = [];
    // A session still running at the latest point is labelled first, newest first: one that just opened is only a
    // sliver wide, so its label may reach left past the band's start instead of being dropped.
    const live = (rect: (typeof rects)[number]) => rect.end >= end;
    const order = [...rects].sort((a, b) => Number(live(b)) - Number(live(a)) || (live(a) ? b.start - a.start : 0) || a.priority - b.priority || a.x1 - b.x1);
    for (const rect of order) {
      if (!rect.label) continue;
      const width = labelWidth(rect.label, BAND_LABEL_SIZE) + 4;
      const plotEnd = left + plotWidth;
      const x = live(rect) ? Math.max(left, Math.min(Math.max(rect.x1, left) + 2, plotEnd - width)) : Math.max(rect.x1, left) + 2;
      if (!live(rect) && (x + width > rect.x2 + 1 || x + width > plotEnd)) continue;
      if (placed.some(([from, to]) => x < to + 3 && x + width > from - 3)) continue;
      placed.push([x, x + width]);
      labels.push({ key: `${rect.start}-${rect.color}-${rect.label}`, x, text: rect.label, color: rect.color });
    }
    return { rects, labels };
  }, [bands, left, plotWidth, timeSpan, timeStart, times]); // eslint-disable-line react-hooks/exhaustive-deps

  const activateAt = (clientX: number, target: SVGSVGElement) => {
    if (!detailsEnabled || !data.length) return;
    const rect = target.getBoundingClientRect();
    const localX = Math.min(left + plotWidth, Math.max(left, clientX - rect.left));
    const fraction = (localX - left) / plotWidth;
    if (!times) return setActiveIndex(Math.round(fraction * Math.max(0, data.length - 1)));
    // Nearest point in time.
    const time = timeStart + fraction * timeSpan;
    let low = 0;
    let high = times.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (times[middle] < time) low = middle + 1;
      else high = middle;
    }
    setActiveIndex(low > 0 && time - times[low - 1] < times[low] - time ? low - 1 : low);
  };
  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => activateAt(event.clientX, event.currentTarget);
  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!detailsEnabled || !data.length || !["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") return setActiveIndex(null);
    if (event.key === "Home") return setActiveIndex(0);
    if (event.key === "End") return setActiveIndex(data.length - 1);
    setActiveIndex((current) => Math.min(data.length - 1, Math.max(0, (current ?? data.length - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
  };
  const activeX = activeIndex == null ? null : xAt(activeIndex);

  return (
    <div ref={ref} className="lightweight-chart" style={{ minHeight }} data-source-points={data.length} data-rendered-points={sampled.length}>
      {size.width > 0 && <svg
        className="lightweight-chart-surface"
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
        role="application"
        aria-label={ariaLabel}
        tabIndex={detailsEnabled ? 0 : -1}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerMove}
        onPointerLeave={(event) => { if (event.pointerType === "mouse") setActiveIndex(null); }}
        onKeyDown={handleKeyDown}
      >
        <defs>
          {paths.filter((path) => Number(path.fillOpacity ?? 0) > 0).map((path) => <linearGradient key={path.key} id={`${gradientId}-${path.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={path.stroke} stopOpacity={path.fillOpacity}/>
            <stop offset="1" stopColor={path.stroke} stopOpacity="0"/>
          </linearGradient>)}
        </defs>
        <g aria-hidden="true">
          {bandShapes.rects.map((band) => <g key={`band-${band.start}-${band.color}-${band.label ?? ""}`} className="chart-session-band">
            {band.emphasis !== "none" && <rect x={band.x1} y={top} width={Math.max(0, band.x2 - band.x1)} height={plotHeight} fill={band.color} fillOpacity={band.emphasis === "strong" ? 0.11 : 0.05}/>}
            {band.emphasis === "strong" && band.startsInside && <line x1={band.x1} x2={band.x1} y1={top} y2={top + plotHeight} stroke={band.color} strokeOpacity="0.55" strokeWidth="1"/>}
            {band.emphasis === "strong" && band.endsInside && <line x1={band.x2} x2={band.x2} y1={top} y2={top + plotHeight} stroke={band.color} strokeOpacity="0.55" strokeWidth="1"/>}
            {band.emphasis === "none" && band.startsInside && <line x1={band.x1} x2={band.x1} y1={top} y2={top + plotHeight} stroke={band.color} strokeOpacity="0.35" strokeWidth="1" strokeDasharray="2 3"/>}
          </g>)}
          {bandShapes.labels.map((label) => <text key={label.key} className="chart-session-label" x={label.x} y={top + 2} dy="0.8em" fill={label.color} fontSize={BAND_LABEL_SIZE} fontWeight="700">{label.text}</text>)}
          {yTicks.map((tick, index) => <line key={`grid-${index}`} x1={left} x2={left + plotWidth} y1={yAt(tick)} y2={yAt(tick)} stroke="var(--line)" strokeWidth="1"/>)}
          {showYAxis && yTicks.map((tick, index) => <text key={`y-${index}`} x={left - 6} y={yAt(tick)} dy="0.32em" textAnchor="end" fill="var(--muted)" fontSize={minHeight <= 125 ? 9.5 : 11}>{yTickFormatter(tick)}</text>)}
          {times && timeTicks.map((time) => {
            const x = xOfTime(time);
            const anchor = x < left + 16 ? "start" : x > left + plotWidth - 16 ? "end" : "middle";
            return <text key={`xt-${time}`} x={x} y={top + plotHeight + tickMargin} dy="0.8em" textAnchor={anchor} fill="var(--muted)" fontSize={minHeight <= 125 ? 9.5 : 11}>{xTickFormatter(new Date(time).toISOString())}</text>;
          })}
          {!times && xTickIndexes.map((index, tickIndex) => {
            const isFirst = tickIndex === 0;
            const isLast = tickIndex === xTickIndexes.length - 1;
            const anchor = isLast ? "end" : isFirst && !showYAxis ? "start" : "middle";
            return (
              <text
                key={`x-${index}`}
                x={xAt(index)}
                y={top + plotHeight + tickMargin}
                dy="0.8em"
                textAnchor={anchor}
                fill="var(--muted)"
                fontSize={minHeight <= 125 ? 9.5 : 11}
              >
                {xTickFormatter(xValue(data[index]))}
              </text>
            );
          })}
          {paths.map((path) => <g key={path.key}>
            {Number(path.fillOpacity ?? 0) > 0 && <path d={path.area} fill={`url(#${gradientId}-${path.key})`} stroke="none"/>}
            <path d={path.line} fill="none" stroke={path.stroke} strokeWidth={path.strokeWidth ?? 1.7} strokeDasharray={path.strokeDasharray} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
          </g>)}
          {activeX != null && <line x1={activeX} x2={activeX} y1={top} y2={top + plotHeight} stroke="var(--line-strong)" strokeWidth="1"/>}
          {activeIndex != null && paths.map((path) => <circle key={`active-${path.key}`} cx={activeX!} cy={yAt(path.read(data[activeIndex]))} r="3" fill={path.stroke} stroke="var(--panel)" strokeWidth="1.5"/>)}
        </g>
      </svg>}
      {activeIndex != null && tooltipContent && <div className={`lightweight-chart-tooltip ${activeX != null && activeX > size.width / 2 ? "align-right" : ""}`} style={{ left: activeX ?? 0, top: Math.max(4, top + 4) }}>
        {tooltipContent(data[activeIndex])}
      </div>}
    </div>
  );
}

export type LightweightDonutItem = { name: string; value: number; color: string };

const DONUT_LABEL_ROOM = 96;
const DONUT_LABEL_GAP = 34;

/** Shortens a label to an approximate pixel width: full-width glyphs ≈ 1em, others ≈ 0.6em. */
function fitLabel(text: string, maxWidth: number, fontSize: number) {
  const glyph = (char: string) => (/[\u3000-\u9fff\uff00-\uffef]/u.test(char) ? fontSize : fontSize * 0.6);
  let width = 0;
  const chars = [...text];
  for (let index = 0; index < chars.length; index += 1) {
    width += glyph(chars[index]);
    if (width > maxWidth) return `${chars.slice(0, Math.max(1, index - 1)).join("")}…`;
  }
  return text;
}

export function LightweightDonutChart(props: { items: LightweightDonutItem[]; height?: number }) {
  return <ChartErrorBoundary resetKey={props.items}><LightweightDonutChartView {...props}/></ChartErrorBoundary>;
}
function LightweightDonutChartView({ items, height = 340 }: { items: LightweightDonutItem[]; height?: number }) {
  const { ref, size } = useResponsiveSize(height);
  const geometry = useMemo(() => {
    const total = items.reduce((sum, item) => sum + item.value, 0);
    const cx = size.width / 2;
    const cy = size.height / 2;
    const maximumRadius = Math.max(1, Math.min(size.width - 16, size.height - 48) / 2);
    // Narrow screens give the callout labels room by shrinking the ring, never below 56px.
    const outerRadius = Math.max(Math.min(56, maximumRadius * 0.58), Math.min(maximumRadius * 0.58, size.width / 2 - 23 - DONUT_LABEL_ROOM));
    const innerRadius = outerRadius * (0.38 / 0.58);
    const padding = Math.PI / 180;
    let currentAngle = 0;
    const slices = items.map((item, index) => {
      const angle = total > 0 ? (item.value / total) * Math.PI * 2 : 0;
      const startAngle = currentAngle - Math.min(padding, angle / 4);
      const endAngle = currentAngle - angle + Math.min(padding, angle / 4);
      const midAngle = currentAngle - angle / 2;
      currentAngle -= angle;
      return { ...item, index, percent: total > 0 ? item.value / total : 0, startAngle, endAngle, midAngle };
    });

    type Callout = typeof slices[number] & { isRight: boolean; sx: number; sy: number; relY: number };
    const groups: [Callout[], Callout[]] = [[], []];
    for (const slice of slices) {
      if (slice.percent < 0.015) continue;
      const isRight = Math.cos(slice.midAngle) >= 0;
      const start = { x: cx + (outerRadius + 3) * Math.cos(slice.midAngle), y: cy + (outerRadius + 3) * Math.sin(slice.midAngle) };
      groups[isRight ? 0 : 1].push({ ...slice, isRight, sx: start.x, sy: start.y, relY: (outerRadius + 14) * Math.sin(slice.midAngle) });
    }
    // Each side holds as many labels as fit vertically; the smallest slices give way (the legend lists all).
    const capacity = Math.max(1, Math.floor((size.height - 24) / DONUT_LABEL_GAP));
    for (const [side, group] of groups.entries()) {
      if (group.length > capacity) groups[side] = group.sort((a, b) => b.percent - a.percent).slice(0, capacity);
    }
    const limit = cy - 18;
    for (const group of groups) {
      group.sort((a, b) => a.relY - b.relY);
      for (let iteration = 0; iteration < 8; iteration += 1) {
        for (let index = 1; index < group.length; index += 1) group[index].relY = Math.max(group[index].relY, group[index - 1].relY + DONUT_LABEL_GAP);
        for (let index = group.length - 2; index >= 0; index -= 1) group[index].relY = Math.min(group[index].relY, group[index + 1].relY - DONUT_LABEL_GAP);
      }
      // Keep the stack inside the chart: shift it down if it starts above the top, up if it ends below the bottom.
      const shift = Math.max(0, -limit - (group[0]?.relY ?? 0)) - Math.max(0, (group.at(-1)?.relY ?? 0) - limit);
      for (const item of group) item.relY += shift;
    }
    const callouts = groups.flat().map((item) => {
      const y = cy + item.relY;
      const middleX = item.isRight ? cx + outerRadius + 8 : cx - outerRadius - 8;
      const endX = item.isRight ? middleX + 10 : middleX - 10;
      const labelX = endX + (item.isRight ? 5 : -5);
      const room = (item.isRight ? size.width - labelX : labelX) - 4;
      return { ...item, y, middleX, endX, labelX, label: fitLabel(item.name, room, 12.5), anchor: item.isRight ? "start" as const : "end" as const };
    });
    return { cx, cy, innerRadius, outerRadius, slices, callouts };
  }, [items, size.height, size.width]);

  return <div ref={ref} className="lightweight-donut" style={{ height, minHeight: height }}>
    {size.width > 0 && <svg className="lightweight-donut-surface" width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label="資産構成比率チャート">
      <g aria-hidden="true">
        {geometry.slices.map((slice) => <path key={`${slice.name}-${slice.index}`} d={donutArcPath(geometry.cx, geometry.cy, geometry.innerRadius, geometry.outerRadius, slice.startAngle, slice.endAngle)} fill={slice.color} stroke="var(--panel)" strokeWidth="2"/>)}
        {geometry.callouts.map((item) => <g className="pie-callout" key={`callout-${item.name}-${item.index}`}>
          <path d={`M${item.sx},${item.sy} L${item.middleX},${item.y} L${item.endX},${item.y}`} stroke={item.color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx={item.endX} cy={item.y} r="2.5" fill={item.color}/>
          <text x={item.labelX} y={item.y} textAnchor={item.anchor} style={{ pointerEvents: "none", userSelect: "none" }}>
            <tspan x={item.labelX} dy="-0.25em" fill="var(--text)" fontSize="12.5px" fontWeight="750">{item.label}</tspan>
            <tspan x={item.labelX} dy="1.25em" fill="var(--muted)" fontSize="11px" fontWeight="700">{(item.percent * 100).toFixed(1)}%</tspan>
          </text>
        </g>)}
      </g>
    </svg>}
  </div>;
}

export type LightweightLineChartProps<T> = {
  data: T[];
  xKey: (item: T) => string;
  xLabel: (item: T) => string;
  yValue: (item: T) => number;
  yTickFormatter: (value: number) => string;
  tickCount?: number;
  yAxisWidth?: number;
  xAxisHeight?: number;
  top?: number;
  right?: number;
  minHeight: number;
  showYAxis?: boolean;
  selectedKey?: string | null;
  onSelectItem?: (item: T) => void;
  tooltipContent?: (item: T) => ReactNode;
  ariaLabel: string;
};

export function LightweightLineChart<T>(props: LightweightLineChartProps<T>) {
  return <ChartErrorBoundary resetKey={props.data}><LightweightLineChartView {...props}/></ChartErrorBoundary>;
}

function LightweightLineChartView<T>({
  data,
  xKey,
  xLabel,
  yValue,
  yTickFormatter,
  tickCount = 5,
  yAxisWidth = 60,
  xAxisHeight = 38,
  top = 20,
  right = 16,
  minHeight,
  showYAxis = true,
  selectedKey = null,
  onSelectItem,
  tooltipContent,
  ariaLabel,
}: LightweightLineChartProps<T>) {
  const rawId = useId();
  const gradientId = `line-chart-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { ref, size } = useResponsiveSize(minHeight);
  const [activeIndex, setActiveIndex] = useChartSelection(data);

  const { domain, ticks: yTicks } = useMemo(() => {
    let maxY = 1;
    for (const point of data) { const value = yValue(point); if (Number.isFinite(value) && value > maxY) maxY = value; }
    return niceChartAxis(maxY, tickCount);
  }, [data, yValue, tickCount]);

  const left = showYAxis ? yAxisWidth : 12;
  const bottom = xAxisHeight;
  const plotWidth = Math.max(1, size.width - left - right);
  const plotHeight = Math.max(1, size.height - top - bottom);

  const xAt = (index: number) => left + (data.length <= 1 ? plotWidth / 2 : (index / Math.max(1, data.length - 1)) * plotWidth);
  const yAt = (val: number) => top + ((domain[1] - val) / Math.max(Number.EPSILON, domain[1] - domain[0])) * plotHeight;

  // Straight line points without fitting or curves
  const points = useMemo(() => {
    return data.map((item, index) => {
      const val = yValue(item);
      const key = xKey(item);
      return {
        item,
        index,
        key,
        val,
        x: xAt(index),
        y: yAt(val),
      };
    });
  }, [data, domain, plotHeight, plotWidth, left, top]);

  // Straight linear SVG path (M x0,y0 L x1,y1 L x2,y2 ...)
  const linearPath = useMemo(() => {
    if (!points.length) return "";
    return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  }, [points]);

  // Gradient area underneath the straight line
  const areaPath = useMemo(() => {
    if (!points.length) return "";
    return `${linearPath} L ${points[points.length - 1].x.toFixed(2)},${(top + plotHeight).toFixed(2)} L ${points[0].x.toFixed(2)},${(top + plotHeight).toFixed(2)} Z`;
  }, [linearPath, points, plotHeight, top]);

  // Smart X-axis tick calculation for long/short series
  const xTicks = useMemo(() => {
    if (data.length <= 14) {
      return data.map((item, index) => ({
        index,
        x: xAt(index),
        label: xLabel(item),
      }));
    }
    const maxLabels = Math.max(3, Math.min(8, Math.floor(plotWidth / 64)));
    const step = (data.length - 1) / (maxLabels - 1);
    const result = [];
    for (let i = 0; i < maxLabels; i++) {
      const idx = Math.min(data.length - 1, Math.round(i * step));
      result.push({
        index: idx,
        x: xAt(idx),
        label: xLabel(data[idx]),
      });
    }
    return result;
  }, [data, plotWidth, xLabel, left]);

  const activateAt = (clientX: number, target: SVGSVGElement) => {
    if (!data.length) return;
    const rect = target.getBoundingClientRect();
    const localX = Math.min(left + plotWidth, Math.max(left, clientX - rect.left));
    const index = Math.min(data.length - 1, Math.max(0, Math.round(((localX - left) / plotWidth) * Math.max(1, data.length - 1))));
    setActiveIndex(index);
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => activateAt(event.clientX, event.currentTarget);
  const handleClick = () => {
    if (!data.length || activeIndex == null) return;
    const item = data[activeIndex];
    onSelectItem?.(item);
  };

  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!data.length || !["ArrowLeft", "ArrowRight", "Home", "End", "Escape", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") return setActiveIndex(null);
    if (event.key === "Enter" || event.key === " ") {
      if (activeIndex != null) onSelectItem?.(data[activeIndex]);
      return;
    }
    if (event.key === "Home") return setActiveIndex(0);
    if (event.key === "End") return setActiveIndex(data.length - 1);
    setActiveIndex((current) => Math.min(data.length - 1, Math.max(0, (current ?? data.length - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
  };

  const activePoint = activeIndex != null && points[activeIndex] ? points[activeIndex] : null;

  return (
    <div ref={ref} className="lightweight-chart lightweight-line-chart dividend-line-chart dividend-bar-chart" style={{ minHeight }}>

      {size.width > 0 && (
        <svg
          className="lightweight-chart-surface"
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="application"
          aria-label={ariaLabel}
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerMove}
          onClick={handleClick}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") setActiveIndex(null);
          }}
          onKeyDown={handleKeyDown}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          <g aria-hidden="true">
            {/* Horizontal Grid lines */}
            {yTicks.map((tick, index) => (
              <line
                key={`grid-${index}`}
                x1={left}
                x2={left + plotWidth}
                y1={yAt(tick)}
                y2={yAt(tick)}
                stroke="var(--line)"
                strokeWidth="1"
                strokeDasharray={tick === 0 ? undefined : "3,3"}
              />
            ))}

            {/* Baseline */}
            <line
              x1={left}
              x2={left + plotWidth}
              y1={yAt(0)}
              y2={yAt(0)}
              stroke="var(--line-strong)"
              strokeWidth="1.2"
            />

            {/* Y-axis Labels */}
            {showYAxis &&
              yTicks.map((tick, index) => (
                <text
                  key={`y-${index}`}
                  x={left - 8}
                  y={yAt(tick)}
                  dy="0.32em"
                  textAnchor="end"
                  fill="var(--muted)"
                  fontSize={size.width < 400 ? 10 : 11.5}
                  fontWeight="600"
                >
                  {yTickFormatter(tick)}
                </text>
              ))}

            {/* X-axis Labels */}
            {xTicks.map((t, index) => {
              const isFirst = index === 0;
              const isLast = index === xTicks.length - 1;
              const anchor = isLast ? "end" : isFirst && !showYAxis ? "start" : "middle";
              const isSelected = selectedKey != null && data[t.index] && xKey(data[t.index]) === selectedKey;
              return (
                <text
                  key={`x-${t.index}`}
                  x={t.x}
                  y={top + plotHeight + 16}
                  textAnchor={anchor}
                  fill={isSelected ? "var(--accent)" : "var(--text)"}
                  fontSize={size.width < 400 ? 10 : 11.5}
                  fontWeight={isSelected ? 800 : 650}
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {t.label}
                </text>
              );
            })}

            {/* Gradient Area below Straight Line */}
            {areaPath && (
              <path d={areaPath} fill={`url(#${gradientId})`} />
            )}

            {/* Straight Line (no curve, straight line segments) */}
            {linearPath && (
              <path
                d={linearPath}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Discrete Data Dots */}
            {data.length <= 48 &&
              points.map((p) => {
                const isSelected = selectedKey === p.key;
                return (
                  <circle
                    key={`dot-${p.key}-${p.index}`}
                    cx={p.x}
                    cy={p.y}
                    r={isSelected ? 5 : p.val > 0 ? 3.5 : 2}
                    fill={isSelected ? "var(--text)" : p.val > 0 ? "var(--accent)" : "var(--line-strong)"}
                    stroke="var(--panel)"
                    strokeWidth="1.5"
                    style={{ cursor: "pointer" }}
                  />
                );
              })}

            {/* Active Crosshair & Highlight Dot */}
            {activePoint && (
              <g>
                <line
                  x1={activePoint.x}
                  x2={activePoint.x}
                  y1={top}
                  y2={top + plotHeight}
                  stroke="var(--line-strong)"
                  strokeWidth="1"
                  strokeDasharray="3,3"
                />
                <circle
                  cx={activePoint.x}
                  cy={activePoint.y}
                  r="6"
                  fill="var(--accent)"
                  stroke="var(--panel)"
                  strokeWidth="2"
                  filter="drop-shadow(0 0 8px color-mix(in srgb, var(--accent) 70%, transparent))"
                />
              </g>
            )}
          </g>

        </svg>
      )}

      {/* Floating interactive tooltip */}
      {activeIndex != null && tooltipContent && (
        <div
          className={`lightweight-chart-tooltip ${
            activePoint != null && activePoint.x > size.width / 2 ? "align-right" : ""
          }`}
          style={{
            left: activePoint?.x ?? 0,
            top: Math.max(4, top + 4),
          }}
        >
          {tooltipContent(data[activeIndex])}
        </div>
      )}
    </div>
  );
}