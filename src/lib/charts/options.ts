import type { EChartsCoreOption } from "echarts/core";
import { type ChartSpec, formatValue } from "./spec";

// Chart ink for Romanum's dark canvas. Marks carry colour; text always uses these tokens.
// Charts sit on #1b1b1b cards, so gaps and rings use that grey.
export const INK = {
  surface: "#1b1b1b",
  primary: "#ededed",
  secondary: "#afafaf",
  muted: "#838383",
  grid: "#262626",
  axis: "#333333",
  tooltip: "#1b1b1b",
} as const;

type Params = { name: string; value: unknown; color: string; dataIndex: number; seriesIndex: number; seriesName: string };

const HEIGHTS = {
  column: { small: 200, medium: 260, large: 340 },
  line: { small: 220, medium: 280, large: 360 },
  donut: { small: 220, medium: 280, large: 340 },
  treemap: { small: 220, medium: 300, large: 400 },
  scatter: { small: 240, medium: 300, large: 380 },
  radar: { small: 240, medium: 300, large: 360 },
} as const;

/** Pixel height for the chart body. Horizontal bars grow with their rows so labels never get squeezed. */
export function chartHeight(spec: ChartSpec): number {
  const size = spec.size ?? "medium";
  if (spec.kind === "bar" || spec.kind === "stacked_bar") {
    const legend = spec.series.length > 1 ? 32 : 0;
    return Math.min(640, spec.categories.length * 32 + 36 + legend);
  }
  if (spec.kind === "stat_tiles") return 0;
  return HEIGHTS[spec.kind][size];
}

// ECharts 6 replacement for containLabel: keep axis labels inside the chart area.
const CONTAIN_LABELS = { outerBoundsMode: "same", outerBoundsContain: "axisLabel" } as const;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Tooltips render as HTML, so every piece of text from data is escaped.
function tooltipHeader(title: string): string {
  return `<div style="color:${INK.primary};font-weight:500;margin-bottom:2px">${escapeHtml(title)}</div>`;
}

function tooltipRow(color: string | null, label: string, value: string): string {
  const swatch = color ? `<span style="width:8px;height:8px;border-radius:2px;background:${color}"></span>` : "";
  return `<div style="display:flex;align-items:center;gap:8px;margin-top:4px">${swatch}<span style="color:${INK.secondary}">${escapeHtml(label)}</span><span style="margin-left:auto;padding-left:16px;color:${INK.primary}">${escapeHtml(value)}</span></div>`;
}

const TOOLTIP = {
  confine: true,
  backgroundColor: INK.tooltip,
  borderColor: INK.axis,
  borderWidth: 1,
  padding: [8, 10],
  textStyle: { color: INK.primary, fontSize: 12 },
  extraCssText: "border-radius:8px;box-shadow:none;",
};

const LEGEND = {
  icon: "roundRect",
  itemWidth: 10,
  itemHeight: 10,
  itemGap: 16,
  textStyle: { color: INK.secondary },
  inactiveColor: "#4a4a4a",
};

function colorOf(spec: ChartSpec, categoryIndex: number, seriesIndex: number): string {
  return spec.colorBy === "category"
    ? spec.colors[spec.categories[categoryIndex].key]
    : spec.colors[spec.series[seriesIndex].key];
}

const positive = (values: (number | null)[]) => values.every((v) => v === null || v > 0);
const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function barOption(spec: ChartSpec, width: number): EChartsCoreOption {
  const horizontal = spec.kind !== "column";
  const stacked = spec.kind === "stacked_bar";
  const multi = spec.series.length > 1;
  const format = spec.series[0].format;
  const log = !!spec.logScale && !stacked && spec.series.every((s) => positive(s.values));
  const last = spec.series.length - 1;
  const totals = spec.categories.map((_, i) => spec.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));

  // When every bar carries its value, the value axis only repeats it, so it goes.
  const labelled = !!spec.showValues && !multi;
  const valueAxis = {
    type: log ? "log" : "value",
    axisLabel: { show: !labelled, color: INK.muted, formatter: (v: number) => formatValue(v, format) },
    splitLine: { show: !labelled, lineStyle: { color: INK.grid, width: 1 } },
    splitNumber: width < 400 ? 3 : 5,
    axisLine: { show: false },
    axisTick: { show: false },
  };
  // Game names get about a third of the width, so narrow cards still leave room for the bars.
  const nameWidth = Math.round(Math.min(150, Math.max(64, width * 0.32)));
  const categoryAxis = {
    type: "category",
    data: spec.categories.map((c) => c.label),
    inverse: horizontal,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: INK.axis } },
    axisLabel: horizontal
      ? { color: INK.secondary, width: nameWidth, overflow: "truncate" }
      : { color: INK.secondary, width: 90, overflow: "truncate", interval: 0, rotate: spec.categories.length > 5 ? 30 : 0 },
  };
  // Rounded at the data end, square at the baseline.
  const radius = horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];

  return {
    // Per-point colours don't update ECharts' legend palette on their own.
    color: spec.colorBy === "series" ? spec.series.map((series) => spec.colors[series.key]) : undefined,
    tooltip: {
      ...TOOLTIP,
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(255,255,255,0.04)" } },
      formatter: (raw: unknown) => {
        const params = raw as Params[];
        if (!params.length) return "";
        const i = params[0].dataIndex;
        const rows = params.map((p) => {
          const s = spec.series[p.seriesIndex];
          return tooltipRow(p.color, s.label, formatValue(s.values[i], s.format));
        });
        if (stacked) rows.push(tooltipRow(null, "Total", formatValue(totals[i], format)));
        return tooltipHeader(spec.categories[i].label) + rows.join("");
      },
    },
    legend: multi ? { ...LEGEND, top: 0, left: 0 } : undefined,
    grid: { left: 0, right: spec.showValues ? 52 : 12, top: multi ? 36 : 8, bottom: 0, ...CONTAIN_LABELS },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series: spec.series.map((s, si) => ({
      type: "bar",
      name: s.label,
      stack: stacked ? "total" : undefined,
      barMaxWidth: 24,
      barGap: "20%",
      barCategoryGap: "35%",
      data: s.values.map((value, i) => ({ value, itemStyle: { color: colorOf(spec, i, si) } })),
      itemStyle: stacked
        ? { borderRadius: si === last ? radius : 0, borderColor: INK.surface, borderWidth: 1 }
        : { borderRadius: radius },
      label:
        spec.showValues && (!stacked || si === last)
          ? {
              show: true,
              position: horizontal ? "right" : "top",
              color: INK.secondary,
              formatter: (p: { dataIndex: number; value: number }) => formatValue(stacked ? totals[p.dataIndex] : p.value, format),
            }
          : { show: false },
      emphasis: { focus: multi ? "series" : "none" },
    })),
  };
}

/** Values over time. Categories are timestamps (epoch ms as keys); each series is one line. */
function lineOption(spec: ChartSpec, width: number): EChartsCoreOption {
  const times = spec.categories.map((c) => Number(c.key));
  const single = spec.series.length === 1;
  // Direct labels at the line ends work up to four lines; past that the legend carries identity.
  const endLabels = spec.series.length <= 4 && width >= 360;
  const format = spec.series[0].format;
  const lastValue = (values: (number | null)[]) => [...values].reverse().find((v) => v !== null) ?? null;
  // Daily series are UTC days (every point at a UTC midnight): shown as dates in UTC, so no time zone shifts the day.
  const daily = times.length > 0 && times.every((t) => t % 86_400_000 === 0);
  const when = (t: number) =>
    daily
      ? new Date(t).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" })
      : new Date(t).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return {
    useUTC: daily,
    tooltip: {
      ...TOOLTIP,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: INK.axis, width: 1 } },
      formatter: (raw: unknown) => {
        const params = raw as Params[];
        if (!params.length) return "";
        const i = params[0].dataIndex;
        const rows = params.map((p) => {
          const s = spec.series[p.seriesIndex];
          return tooltipRow(p.color, s.label, formatValue(s.values[i], s.format));
        });
        return tooltipHeader(when(times[i])) + rows.join("");
      },
    },
    legend: single ? undefined : { ...LEGEND, top: 0, left: 0 },
    grid: { left: 0, right: endLabels ? 112 : 16, top: single ? 12 : 36, bottom: 0, ...CONTAIN_LABELS },
    xAxis: {
      type: "time",
      axisLabel: { color: INK.muted, hideOverlap: true },
      axisLine: { lineStyle: { color: INK.axis } },
      axisTick: { show: false },
      splitLine: { show: false },
    },
    yAxis: {
      type: spec.logScale && spec.series.every((s) => positive(s.values)) ? "log" : "value",
      scale: true,
      splitNumber: 4,
      // Exact tick labels keep nearby counts from rounding to the same label.
      axisLabel: { color: INK.muted, formatter: (v: number) => format === "compact" ? v.toLocaleString("en-US") : formatValue(v, format) },
      splitLine: { lineStyle: { color: INK.grid, width: 1 } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: spec.series.map((s) => {
      const color = spec.colors[s.key];
      return {
        type: "line",
        name: s.label,
        data: times.map((t, i) => [t, s.values[i]]),
        // Missing snapshots stay as gaps rather than being bridged.
        connectNulls: false,
        smooth: false,
        // Isolated observations either side of a gap must remain visible.
        showSymbol: true,
        symbol: "circle",
        symbolSize: 8,
        lineStyle: { width: 2, color, cap: "round", join: "round" },
        itemStyle: { color, borderColor: INK.surface, borderWidth: 2 },
        areaStyle: single ? { color, opacity: 0.1 } : undefined,
        endLabel: endLabels
          ? {
              show: true,
              color: INK.secondary,
              formatter: () => `${truncate(s.label, 14)} ${formatValue(lastValue(s.values), s.format)}`,
            }
          : undefined,
        emphasis: { focus: "series" },
      };
    }),
  };
}

function shareOption(spec: ChartSpec): EChartsCoreOption {
  const series = spec.series[0];
  const total = series.values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const share = (v: number | null) => (total > 0 && v !== null ? `${((v / total) * 100).toFixed(1)}%` : "–");
  const data = spec.categories.map((c, i) => ({
    name: c.label,
    value: series.values[i],
    itemStyle: { color: spec.colors[c.key] },
  }));
  const tooltip = {
    ...TOOLTIP,
    trigger: "item",
    formatter: (raw: unknown) => {
      const p = raw as Params;
      const value = series.values[p.dataIndex];
      return tooltipHeader(p.name) + tooltipRow(p.color, series.label, formatValue(value, series.format)) + tooltipRow(null, "Share", share(value));
    },
  };

  if (spec.kind === "donut") {
    return {
      tooltip,
      legend: {
        ...LEGEND,
        bottom: 0,
        left: "center",
        formatter: (name: string) => {
          const i = spec.categories.findIndex((c) => c.label === name);
          return `${truncate(name, 24)}  ${share(series.values[i])}`;
        },
      },
      series: [
        {
          type: "pie",
          radius: ["44%", "68%"],
          center: ["50%", "42%"],
          label: { show: false },
          itemStyle: { borderColor: INK.surface, borderWidth: 2, borderRadius: 4 },
          data,
        },
      ],
    };
  }

  return {
    tooltip,
    series: [
      {
        type: "treemap",
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        itemStyle: { borderColor: INK.surface, borderWidth: 2, gapWidth: 2, borderRadius: 4 },
        label: {
          show: true,
          color: "#ffffff",
          fontSize: 12,
          overflow: "truncate",
          formatter: (p: { name: string; value: number }) => `${p.name}\n${formatValue(p.value, series.format)}`,
        },
        upperLabel: { show: false },
        data,
      },
    ],
  };
}

function scatterOption(spec: ChartSpec): EChartsCoreOption {
  const [x, y, size] = spec.series;
  const logX = !!spec.logScale && positive(x.values);
  const logY = !!spec.logScale && positive(y.values);
  const maxSize = size ? Math.max(...size.values.map((v) => v ?? 0), 1) : 1;
  const axis = (s: typeof x, log: boolean, vertical: boolean) => ({
    type: log ? "log" : "value",
    name: s.label,
    nameLocation: "middle",
    nameGap: vertical ? 52 : 28,
    nameTextStyle: { color: INK.muted },
    axisLabel: { color: INK.muted, formatter: (v: number) => formatValue(v, s.format) },
    splitLine: { lineStyle: { color: INK.grid, width: 1 } },
    axisLine: { lineStyle: { color: INK.axis } },
    axisTick: { show: false },
    scale: true,
  });

  return {
    tooltip: {
      ...TOOLTIP,
      trigger: "item",
      formatter: (raw: unknown) => {
        const p = raw as Params;
        const rows = spec.series.map((s) => tooltipRow(null, s.label, formatValue(s.values[p.dataIndex], s.format)));
        return tooltipHeader(p.name) + rows.join("");
      },
    },
    grid: { left: 12, right: 24, top: 16, bottom: 32, outerBoundsMode: "same", outerBoundsContain: "all" },
    xAxis: axis(x, logX, false),
    yAxis: axis(y, logY, true),
    series: [
      {
        type: "scatter",
        data: spec.categories.map((c, i) => ({
          name: c.label,
          value: [x.values[i], y.values[i]],
          // Bubble area follows the size metric; plain points stay at a readable 12px.
          symbolSize: size ? 10 + 30 * Math.sqrt((size.values[i] ?? 0) / maxSize) : 12,
          itemStyle: { color: spec.colors[c.key], borderColor: INK.surface, borderWidth: 2 },
        })),
        label: {
          show: !!spec.showValues || spec.categories.length <= 8,
          position: "right",
          color: INK.secondary,
          fontSize: 11,
          formatter: "{b}",
        },
        emphasis: { focus: "self" },
      },
    ],
  };
}

function radarOption(spec: ChartSpec, width: number): EChartsCoreOption {
  // Each axis is scaled to the highest value in the chart; tooltips show the real values.
  const maxes = spec.series.map((s) => Math.max(...s.values.map((v) => v ?? 0), 0) || 1);
  // Axis names sit outside the polygon, so narrow cards need a smaller radar to keep them on screen.
  const narrow = width < 440;
  return {
    tooltip: {
      ...TOOLTIP,
      trigger: "item",
      formatter: (raw: unknown) => {
        const p = raw as Params;
        const rows = spec.series.map((s) => tooltipRow(null, s.label, formatValue(s.values[p.dataIndex], s.format)));
        return tooltipHeader(p.name) + rows.join("");
      },
    },
    legend: spec.categories.length > 1 ? { ...LEGEND, bottom: 0, left: "center" } : undefined,
    radar: {
      indicator: spec.series.map((s) => ({ name: s.label, max: 1 })),
      radius: narrow ? "46%" : "60%",
      center: ["50%", "46%"],
      splitNumber: 4,
      shape: "polygon",
      axisName: { color: INK.secondary, fontSize: 11, width: narrow ? 64 : 110, overflow: "break" },
      splitLine: { lineStyle: { color: INK.grid } },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: INK.axis } },
    },
    series: [
      {
        type: "radar",
        symbol: "circle",
        symbolSize: 8,
        data: spec.categories.map((c, i) => {
          const color = spec.colors[c.key];
          return {
            name: c.label,
            value: spec.series.map((s, si) => (s.values[i] ?? 0) / maxes[si]),
            lineStyle: { width: 2, color },
            itemStyle: { color, borderColor: INK.surface, borderWidth: 2 },
            areaStyle: { color, opacity: 0.1 },
          };
        }),
      },
    ],
  };
}

/** Turns a chart spec into ECharts options in Romanum's dark style, sized for the given width. */
export function buildOption(spec: ChartSpec, width: number): EChartsCoreOption {
  const body =
    spec.kind === "donut" || spec.kind === "treemap"
      ? shareOption(spec)
      : spec.kind === "scatter"
        ? scatterOption(spec)
        : spec.kind === "radar"
          ? radarOption(spec, width)
          : spec.kind === "line"
            ? lineOption(spec, width)
            : barOption(spec, width);
  return {
    backgroundColor: "transparent",
    animationDuration: 500,
    animationEasing: "cubicOut",
    textStyle: { color: INK.secondary, fontSize: 12 },
    ...body,
  };
}
