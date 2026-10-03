export type IndexedChartPoint<T> = { index: number; value: T };
export type SvgPoint = { x: number; y: number };

export function downsampleChartPoints<T>(
  data: T[],
  maxPoints: number,
  values: Array<(item: T) => number>,
): Array<IndexedChartPoint<T>> {
  if (data.length <= maxPoints || maxPoints < 4) return data.map((value, index) => ({ index, value }));

  const bucketCount = Math.max(1, Math.floor((maxPoints - 2) / 2));
  const interiorLength = data.length - 2;
  const selected = new Set<number>([0, data.length - 1]);

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor((bucket * interiorLength) / bucketCount);
    const end = 1 + Math.floor(((bucket + 1) * interiorLength) / bucketCount);
    let minimumIndex = start;
    let maximumIndex = start;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;

    for (let index = start; index < Math.max(start + 1, end); index += 1) {
      for (const read of values) {
        const value = read(data[index]);
        if (!Number.isFinite(value)) continue;
        if (value < minimum) {
          minimum = value;
          minimumIndex = index;
        }
        if (value > maximum) {
          maximum = value;
          maximumIndex = index;
        }
      }
    }
    selected.add(minimumIndex);
    selected.add(maximumIndex);
  }

  return [...selected].sort((a, b) => a - b).map((index) => ({ index, value: data[index] }));
}

export function monotoneSvgPath(points: SvgPoint[]): string {
  const finite = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!finite.length) return "";
  if (finite.length === 1) return `M${finite[0].x.toFixed(2)},${finite[0].y.toFixed(2)}`;

  const slopes = finite.slice(0, -1).map((point, index) => {
    const next = finite[index + 1];
    return (next.y - point.y) / Math.max(Number.EPSILON, next.x - point.x);
  });
  const tangents = new Array<number>(finite.length);
  tangents[0] = slopes[0];
  tangents[finite.length - 1] = slopes.at(-1)!;
  for (let index = 1; index < finite.length - 1; index += 1) {
    const before = slopes[index - 1];
    const after = slopes[index];
    if (before === 0 || after === 0 || before * after <= 0) {
      tangents[index] = 0;
    } else {
      const leftWidth = finite[index].x - finite[index - 1].x;
      const rightWidth = finite[index + 1].x - finite[index].x;
      const firstWeight = 2 * rightWidth + leftWidth;
      const secondWeight = rightWidth + 2 * leftWidth;
      tangents[index] = (firstWeight + secondWeight) / (firstWeight / before + secondWeight / after);
    }
  }

  let path = `M${finite[0].x.toFixed(2)},${finite[0].y.toFixed(2)}`;
  for (let index = 0; index < finite.length - 1; index += 1) {
    const current = finite[index];
    const next = finite[index + 1];
    const width = next.x - current.x;
    path += ` C${(current.x + width / 3).toFixed(2)},${(current.y + tangents[index] * width / 3).toFixed(2)}`;
    path += ` ${(next.x - width / 3).toFixed(2)},${(next.y - tangents[index + 1] * width / 3).toFixed(2)}`;
    path += ` ${next.x.toFixed(2)},${next.y.toFixed(2)}`;
  }
  return path;
}

export function chartAxisTicks(domain: [number, number], count: number): number[] {
  const [minimum, maximum] = domain;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum || count <= 1) return [minimum];
  if (minimum !== 0) {
    return Array.from({ length: count }, (_, index) => minimum + ((maximum - minimum) * index) / (count - 1));
  }

  const rawStep = maximum / (count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rawStep, Number.EPSILON)));
  const halfMagnitude = magnitude / 2;
  const step = Math.ceil(rawStep / halfMagnitude) * halfMagnitude;
  const ticks = Array.from({ length: count - 1 }, (_, index) => index * step).filter((value) => value < maximum);
  if (ticks.at(-1) !== maximum) ticks.push(maximum);
  return ticks.slice(0, count);
}

export function niceChartAxis(maxY: number, targetTicks = 5): { domain: [number, number]; ticks: number[] } {
  if (!Number.isFinite(maxY) || maxY <= 0) {
    return { domain: [0, 1], ticks: [0, 1] };
  }
  const count = Math.max(2, targetTicks);
  const rawStep = maxY / (count - 1);
  const exponent = Math.floor(Math.log10(Math.max(rawStep, Number.EPSILON)));
  const fraction = rawStep / (10 ** exponent);

  let niceFraction: number;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 2.5) niceFraction = 2.5;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;

  const step = niceFraction * (10 ** exponent);
  const niceMax = step * (count - 1);
  const ticks: number[] = [];
  for (let i = 0; i < count; i++) {
    ticks.push(Number((i * step).toFixed(6)));
  }

  return { domain: [0, niceMax], ticks };
}

const polarPoint = (cx: number, cy: number, radius: number, angle: number): SvgPoint => ({
  x: cx + radius * Math.cos(angle),
  y: cy + radius * Math.sin(angle),
});

export function donutArcPath(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const outerStart = polarPoint(cx, cy, outerRadius, startAngle);
  const outerEnd = polarPoint(cx, cy, outerRadius, endAngle);
  const innerEnd = polarPoint(cx, cy, innerRadius, endAngle);
  const innerStart = polarPoint(cx, cy, innerRadius, startAngle);
  const largeArc = Math.abs(endAngle - startAngle) > Math.PI ? 1 : 0;
  const sweep = endAngle >= startAngle ? 1 : 0;
  return [
    `M${outerStart.x.toFixed(2)},${outerStart.y.toFixed(2)}`,
    `A${outerRadius.toFixed(2)},${outerRadius.toFixed(2)} 0 ${largeArc} ${sweep} ${outerEnd.x.toFixed(2)},${outerEnd.y.toFixed(2)}`,
    `L${innerEnd.x.toFixed(2)},${innerEnd.y.toFixed(2)}`,
    `A${innerRadius.toFixed(2)},${innerRadius.toFixed(2)} 0 ${largeArc} ${sweep ? 0 : 1} ${innerStart.x.toFixed(2)},${innerStart.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}
