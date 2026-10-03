"use client";

import { chartAxisTicks, donutArcPath, downsampleChartPoints, monotoneSvgPath, niceChartAxis, type SvgPoint } from "@/lib/charts/chart-geometry";
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

type LightweightAreaChartProps<T> = {
  data: T[];
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
  const xAt = (index: number) => left + (data.length <= 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth);
  const yAt = (value: number) => top + ((domain[1] - value) / Math.max(Number.EPSILON, domain[1] - domain[0])) * plotHeight;

  const sampled = useMemo(
    () => downsampleChartPoints(data, Math.max(160, Math.floor(plotWidth * 1.5)), series.map((item) => item.read)),
    [data, plotWidth, series],
  );
  const paths = useMemo(() => series.map((item) => {
    const points: SvgPoint[] = sampled.map(({ index, value }) => ({ x: xAt(index), y: yAt(item.read(value)) }));
    const line = monotoneSvgPath(points);
    const area = points.length ? `${line} L${points.at(-1)!.x.toFixed(2)},${(top + plotHeight).toFixed(2)} L${points[0].x.toFixed(2)},${(top + plotHeight).toFixed(2)} Z` : "";
    return { ...item, points, line, area };
  }), [plotHeight, sampled, series, size.width, domain, top]);
  const yTicks = useMemo(() => chartAxisTicks(domain, tickCount), [domain, tickCount]);
  const xTickCount = Math.min(data.length, Math.max(2, Math.min(4, Math.floor(plotWidth / Math.max(54, minTickGap + 28)))));
  const xTickIndexes = useMemo(() => [...new Set(Array.from({ length: xTickCount }, (_, index) => Math.round(((index + 1) * (data.length - 1)) / xTickCount)))], [data.length, xTickCount]);

  const activateAt = (clientX: number, target: SVGSVGElement) => {
    if (!detailsEnabled || !data.length) return;
    const rect = target.getBoundingClientRect();
    const localX = Math.min(left + plotWidth, Math.max(left, clientX - rect.left));
    setActiveIndex(Math.round(((localX - left) / plotWidth) * Math.max(0, data.length - 1)));
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
          {yTicks.map((tick, index) => <line key={`grid-${index}`} x1={left} x2={left + plotWidth} y1={yAt(tick)} y2={yAt(tick)} stroke="var(--line)" strokeWidth="1"/>)}
          {showYAxis && yTicks.map((tick, index) => <text key={`y-${index}`} x={left - 6} y={yAt(tick)} dy="0.32em" textAnchor="end" fill="var(--muted)" fontSize={minHeight <= 125 ? 9.5 : 11}>{yTickFormatter(tick)}</text>)}
          {xTickIndexes.map((index, tickIndex) => {
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
    const outerRadius = maximumRadius * 0.58;
    const innerRadius = maximumRadius * 0.38;
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
    for (const group of groups) {
      group.sort((a, b) => a.relY - b.relY);
      for (let iteration = 0; iteration < 8; iteration += 1) {
        for (let index = 1; index < group.length; index += 1) group[index].relY = Math.max(group[index].relY, group[index - 1].relY + 34);
        for (let index = group.length - 2; index >= 0; index -= 1) group[index].relY = Math.min(group[index].relY, group[index + 1].relY - 34);
      }
    }
    const callouts = groups.flat().map((item) => {
      const y = cy + item.relY;
      const middleX = item.isRight ? cx + outerRadius + 8 : cx - outerRadius - 8;
      const endX = item.isRight ? middleX + 10 : middleX - 10;
      return { ...item, y, middleX, endX, labelX: endX + (item.isRight ? 5 : -5), anchor: item.isRight ? "start" as const : "end" as const };
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
            <tspan x={item.labelX} dy="-0.25em" fill="var(--text)" fontSize="12.5px" fontWeight="750">{item.name.length > 13 ? `${item.name.slice(0, 12)}…` : item.name}</tspan>
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