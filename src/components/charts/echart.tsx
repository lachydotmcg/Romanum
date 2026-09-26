"use client";

import { useEffect, useRef } from "react";
// Renamed: ECharts' use() registers modules; it isn't React's use() hook.
import { getInstanceByDom, init, use as registerModules, type EChartsCoreOption } from "echarts/core";
import { BarChart, LineChart, PieChart, RadarChart, ScatterChart, TreemapChart } from "echarts/charts";
import { GridComponent, LegendComponent, RadarComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

// Only the pieces the chart kinds use, to keep the bundle small.
registerModules([
  BarChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  TreemapChart,
  GridComponent,
  LegendComponent,
  RadarComponent,
  TooltipComponent,
  SVGRenderer,
]);

/** Options are rebuilt when the width changes enough to matter, e.g. how much room game names get. */
const widthStep = (width: number) => Math.round(width / 40);

export function EChart({
  build,
  height,
  label,
}: {
  build: (width: number) => EChartsCoreOption;
  height: number;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current!;
    // Fast Refresh can leave an instance behind on the element.
    getInstanceByDom(el)?.dispose();
    const chart = init(el, undefined, { renderer: "svg" });
    // Chart text uses the page's font, which is only known once rendered.
    const fontFamily = getComputedStyle(el).fontFamily;
    let width = el.clientWidth;
    const render = () => {
      chart.setOption(build(width), true);
      chart.setOption({ textStyle: { fontFamily } });
    };
    render();

    const observer = new ResizeObserver(() => {
      const next = el.clientWidth;
      if (widthStep(next) !== widthStep(width)) {
        width = next;
        render();
      }
      chart.resize();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [build]);

  return <div ref={ref} role="img" aria-label={label} style={{ height }} />;
}
