"use client";

import { useState } from "react";

export type UtilityUsagePoint = {
  periodId: string;
  periodStart: string;
  periodLabel: string;
  monthLabel: string;
  utility: string;
  /** Signed recovery: negative is consumption lost, positive is over-recorded. */
  unbilledUnits: number;
  unbilledPct: number;
  unit: string;
  locationCode: string;
};

/**
 * Unbilled utility consumption, month by month, one chart per utility.
 *
 * Electricity is kWh and water is cubic metres, so they get separate charts
 * rather than a shared axis — each keeps its own units, which is what the
 * meter reader and the provider's bill are actually denominated in.
 *
 * The measure is signed and the zero line is the point of the chart. Below it
 * the building drew more than the sub-meters recorded, so the difference is
 * absorbed and never billed to anyone -- a loss, which is why it hangs
 * downward. Above it the sub-meters read higher than the provider billed.
 */
export function UtilityUsageChart({
  points,
  months,
}: {
  points: UtilityUsagePoint[];
  /** The last twelve months, oldest first, as YYYY-MM. */
  months: { key: string; label: string }[];
}) {
  const utilities = [...new Set(points.map((p) => p.utility))].sort();
  if (points.length === 0) return null;

  return (
    <div className="viz-root grid gap-5">
      <style>{`
        .viz-root {
          --viz-surface: var(--surface);
          /* Unrecovered is the money lost, so it takes the warm pole. */
          --viz-loss: #e34948;
          --viz-over: #2a78d6;
          --viz-grid: color-mix(in srgb, var(--text) 12%, transparent);
        }
        @media (prefers-color-scheme: dark) {
          :root:where(:not([data-theme="light"])) .viz-root {
            --viz-loss: #e66767;
            --viz-over: #3987e5;
          }
        }
        :root[data-theme="dark"] .viz-root {
          --viz-loss: #e66767;
          --viz-over: #3987e5;
        }
      `}</style>

      <div className="flex items-center gap-4 flex-wrap text-xs">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            style={{
              width: "0.7rem",
              height: "0.7rem",
              borderRadius: "2px",
              background: "var(--viz-loss)",
            }}
          />
          Unrecovered — the building used more than the meters recorded, so it’s a loss (below the line)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            style={{
              width: "0.7rem",
              height: "0.7rem",
              borderRadius: "2px",
              background: "var(--viz-over)",
            }}
          />
          Over-recorded — the meters read higher than the provider billed, so it’s a gain (above the line)
        </span>
      </div>

      {utilities.map((utility) => (
        <UtilityBars
          key={utility}
          utility={utility}
          months={months}
          rows={points.filter((p) => p.utility === utility)}
        />
      ))}
    </div>
  );
}

function UtilityBars({
  utility,
  rows,
  months,
}: {
  utility: string;
  rows: UtilityUsagePoint[];
  months: { key: string; label: string }[];
}) {
  const [hover, setHover] = useState<UtilityUsagePoint | null>(null);
  if (rows.length === 0) return null;

  // Every month of the year gets a slot whether or not it was billed, so a
  // month with no period reads as a gap rather than vanishing.
  const byMonth = new Map(rows.map((row) => [row.periodStart.slice(0, 7), row]));
  const slots = months.map((month) => ({
    ...month,
    row: byMonth.get(month.key) ?? null,
  }));

  const unit = rows[0].unit;
  const width = 720;
  const height = 190;
  const padLeft = 62;
  const padRight = 12;
  const padTop = 14;
  const padBottom = 34;

  const values = rows.map((r) => r.unbilledUnits);
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  const span = rawMax - rawMin || 1;
  const max = rawMax + span * 0.1;
  const min = rawMin - span * 0.1;

  const plotWidth = width - padLeft - padRight;
  const slot = plotWidth / slots.length;
  // A 2px surface gap between neighbouring bars, per the mark spec.
  const barWidth = Math.max(6, Math.min(46, slot - 8));

  const y = (value: number) =>
    padTop + ((max - value) / (max - min)) * (height - padTop - padBottom);
  const zeroY = y(0);
  const xCentre = (i: number) => padLeft + slot * i + slot / 2;

  const compact = (value: number) =>
    Math.abs(value) >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : String(Math.round(value));

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
        <p className="text-sm font-semibold">
          {utility === "water" ? "Water" : "Electricity"}
          <span className="muted font-normal"> · {unit} unaccounted</span>
        </p>
        <p className="text-xs" style={{ minHeight: "1rem" }} aria-live="polite">
          {hover ? (
            <>
              <strong>{hover.periodLabel}</strong> · {hover.locationCode} —{" "}
              {hover.unbilledUnits.toLocaleString()} {unit} (
              {hover.unbilledPct.toFixed(1)}%)
            </>
          ) : (
            <span className="muted">Hover a bar for the month.</span>
          )}
        </p>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto" }}
        role="img"
        aria-label={`${utility} unaccounted consumption by month, in ${unit}`}
      >
        {[max, 0, min].map((tick, i) => (
          <g key={i}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? "var(--text)" : "var(--viz-grid)"}
              strokeWidth="1"
              strokeOpacity={tick === 0 ? 0.45 : 1}
            />
            <text
              x={padLeft - 8}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize="11"
              fill="var(--text-muted, #6b7280)"
            >
              {compact(tick)}
            </text>
          </g>
        ))}

        {slots.map((slotItem, i) => {
          const row = slotItem.row;
          const value = row?.unbilledUnits ?? 0;
          const top = value >= 0 ? y(value) : zeroY;
          const barHeight = row ? Math.max(2, Math.abs(zeroY - y(value))) : 0;
          // Below the line is consumption lost, above it is over-recorded.
          const isOver = value > 0;
          return (
            <g key={slotItem.key}>
              {row ? (
                <>
                  <rect
                    x={xCentre(i) - barWidth / 2}
                    y={top}
                    width={barWidth}
                    height={barHeight}
                    rx="3"
                    fill={isOver ? "var(--viz-over)" : "var(--viz-loss)"}
                  />
                  {/* Hit target spans the slot, so a short bar is still easy
                      to reach. */}
                  <rect
                    x={xCentre(i) - slot / 2}
                    y={padTop}
                    width={slot}
                    height={height - padTop - padBottom}
                    fill="transparent"
                    tabIndex={0}
                    role="img"
                    aria-label={`${row.periodLabel}: ${row.unbilledUnits} ${unit} unaccounted, ${row.unbilledPct.toFixed(1)} percent`}
                    onMouseEnter={() => setHover(row)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(row)}
                    onBlur={() => setHover(null)}
                    style={{ cursor: "pointer" }}
                  />
                </>
              ) : null}
              <text
                x={xCentre(i)}
                y={height - padBottom + 16}
                textAnchor="middle"
                fontSize="10"
                fill="var(--text-muted, #6b7280)"
                opacity={row ? 1 : 0.45}
              >
                {slotItem.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
