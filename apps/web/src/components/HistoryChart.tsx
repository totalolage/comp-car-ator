/**
 * The price history chart: weekly median asking price per Market as lines, from
 * lib/history-chart. The lines are a stretched SVG; labels, the legend and the hover layer
 * are HTML on top, so text stays readable at phone width. Hovering (or touching) the plot
 * shows a crosshair at the nearest date with every Market's value; the same numbers are in
 * a table under the chart, built when it is opened. Market colours follow the Market, never
 * the series order.
 */

import { useState } from "preact/hooks";
import type { I18n } from "../i18n/i18n.ts";
import { columnAt, historyChart } from "../lib/history-chart.ts";
import type { HistorySeries } from "../lib/listing-view.ts";

/** Points get visible dots up to this many per series; longer series show only their last. */
const DOTS_MAX = 30;

export default function HistoryChart({ series, t }: { series: HistorySeries[]; t: I18n }) {
  const chart = historyChart(series);
  const [hover, setHover] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  if (!chart) {
    return (
      <figure class="chart">
        <h2 class="section-title">{t.t("model.history")}</h2>
        <p class="facet-note">{t.t("model.historyEmpty")}</p>
      </figure>
    );
  }
  const column = hover ? chart.columns.find((c) => c.date === hover) : undefined;
  const track = (e: PointerEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHover(columnAt(chart, ((e.clientX - box.left) / box.width) * 100).date);
  };
  return (
    <figure class="chart" aria-labelledby="history-title">
      <h2 class="section-title" id="history-title">
        {t.t("model.history")}
      </h2>
      <ul class="chart-legend">
        {chart.lines.map((line) => (
          <li key={line.market} class="chart-key" data-market={line.market}>
            {t.label("market", line.market)}
          </li>
        ))}
      </ul>
      <div class="chart-box" aria-hidden="true">
        <div
          class="chart-plot"
          onPointerMove={track}
          onPointerDown={track}
          onPointerLeave={() => setHover(null)}
        >
          {chart.yTicks.map((tick) => (
            <span key={tick.value} class="chart-y" style={`top:${tick.y}%`}>
              {t.czkShort(tick.value)}
            </span>
          ))}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="presentation">
            {chart.yTicks.map((tick) => (
              <line key={tick.value} class="chart-grid" x1="0" x2="100" y1={tick.y} y2={tick.y} />
            ))}
            {chart.lines.map((line) => (
              <path key={line.market} class="chart-line" data-market={line.market} d={line.d} />
            ))}
          </svg>
          {chart.lines.map((line) =>
            line.points
              .filter((_, i) => line.points.length <= DOTS_MAX || i === line.points.length - 1)
              .map((p) => (
                <span
                  key={`${line.market}-${p.date}`}
                  class="chart-dot"
                  data-market={line.market}
                  style={`left:${p.x}%;top:${p.y}%`}
                />
              )),
          )}
          {chart.lines.map((line) => {
            const p = line.points[line.points.length - 1];
            return (
              p && (
                <span key={line.market} class="chart-label" style={`left:${p.x}%;top:${p.y}%`}>
                  {line.market}
                </span>
              )
            );
          })}
          {chart.xTicks.map((tick) => (
            <span key={tick.date} class="chart-x" style={`left:${tick.x}%`}>
              {chart.xUnit === "month" ? t.monthYear(tick.date) : t.dayMonth(tick.date)}
            </span>
          ))}
          {column && (
            <>
              <span class="chart-cross" style={`left:${column.x}%`} />
              {column.points.map((p) => (
                <span
                  key={p.market}
                  class="chart-dot chart-hover"
                  data-market={p.market}
                  style={`left:${p.x}%;top:${p.y}%`}
                />
              ))}
              <div
                class="chart-tip"
                style={`left:${column.x}%`}
                data-flip={column.x > 60 || undefined}
              >
                <strong>{t.date(column.date)}</strong>
                {column.points.map((p) => (
                  <span key={p.market} class="chart-key" data-market={p.market}>
                    {t.label("market", p.market)}: {t.czk(p.medianCzk)} ({p.count})
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <figcaption class="facet-note">{t.t("model.historyNote")}</figcaption>
      <details
        class="chart-data"
        onToggle={(e) => setTable((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>{t.t("model.historyData")}</summary>
        {table && (
          <div class="table-scroll">
            <table class="data data-auto">
              <thead>
                <tr>
                  <th scope="col">{t.t("model.date")}</th>
                  {chart.lines.map((line) => (
                    <th key={line.market} scope="col" class="num">
                      {t.label("market", line.market)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...chart.columns].reverse().map((c) => (
                  <tr key={c.date}>
                    <th scope="row">{t.date(c.date)}</th>
                    {chart.lines.map((line) => {
                      const p = c.points.find((q) => q.market === line.market);
                      return (
                        <td key={line.market} class="num">
                          {p ? `${t.czk(p.medianCzk)} (${p.count})` : ""}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </figure>
  );
}
