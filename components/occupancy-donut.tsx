/**
 * Occupied against vacant, as a ring.
 *
 * This is a meter rather than a pie: one arc fills a track of the same hue, and
 * the rate is stated in the middle. Two wedges you have to compare by eye would
 * be a worse read than the number itself -- the ring is here to make the split
 * visible at a glance, not to be measured off.
 *
 * The two steps are validated against both surfaces: light uses brand-300 track
 * with a brand-600 fill, dark swaps them so the fill stays the lighter of the
 * pair. Both clear the 2:1 contrast floor against their surface.
 */
export function OccupancyDonut({
  occupied,
  vacant,
}: {
  occupied: number;
  vacant: number;
}) {
  const total = occupied + vacant;
  const rate = total > 0 ? (occupied / total) * 100 : 0;

  // Geometry. The stroke is thin so the ring reads as a mark, not a block.
  const size = 132;
  const stroke = 14;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  // A 2px gap in the surface colour separates the two arcs, the same spacer a
  // stacked bar uses. Only when there is something on both sides to separate.
  const gap = total > 0 && occupied > 0 && vacant > 0 ? 2 : 0;
  const filled = total > 0 ? (occupied / total) * circumference : 0;
  const dash = Math.max(0, filled - gap);

  return (
    <div className="flex items-center gap-4 flex-wrap">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Occupancy ${Math.round(rate)} percent. ${occupied} occupied, ${vacant} vacant, of ${total} units.`}
        style={{ flexShrink: 0 }}
      >
        {/* Track: the whole portfolio. */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--occupancy-track)"
          strokeWidth={stroke}
        >
          <title>{`Vacant — ${vacant} of ${total} units`}</title>
        </circle>

        {/* Fill: the occupied share, starting at twelve o'clock. */}
        {occupied > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--occupancy-fill)"
            strokeWidth={stroke}
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeLinecap="butt"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          >
            <title>{`Occupied — ${occupied} of ${total} units`}</title>
          </circle>
        ) : null}

        {/* The rate belongs in the middle; proportional figures, not tabular. */}
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--text)"
          style={{ fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em" }}
        >
          {Math.round(rate)}%
        </text>
      </svg>

      {/* Legend. Identity never rests on colour alone -- each swatch is labelled
          and carries its count. */}
      <dl className="text-sm">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="rounded-full"
            style={{
              width: "0.6rem",
              height: "0.6rem",
              background: "var(--occupancy-fill)",
              flexShrink: 0,
            }}
          />
          <dt>Occupied</dt>
          <dd className="font-semibold tabular-nums">{occupied}</dd>
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <span
            aria-hidden="true"
            className="rounded-full"
            style={{
              width: "0.6rem",
              height: "0.6rem",
              background: "var(--occupancy-track)",
              flexShrink: 0,
            }}
          />
          <dt>Vacant</dt>
          <dd className="font-semibold tabular-nums">{vacant}</dd>
        </div>
        <p className="text-xs muted mt-2">{total} units in total</p>
      </dl>
    </div>
  );
}
