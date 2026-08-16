"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState, useTransition, type ReactNode } from "react";

import type { ActionState } from "./actions";

/**
 * One draggable block, moved by its grip rather than by its body.
 *
 * Every panel here has links inside it, so making the whole card the drag
 * target would swallow the clicks it exists for. The grip is a small handle in
 * the corner: obvious enough to find, out of the way of the figures.
 */
function Sortable({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // Kept visible while dragging rather than hidden: the preview browser
        // and a reduced-motion reader both need the static state to be right.
        opacity: isDragging ? 0.6 : 1,
        zIndex: isDragging ? 20 : undefined,
        position: "relative",
      }}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Move ${label}`}
        title={`Drag to move ${label}`}
        className="no-print"
        style={{
          position: "absolute",
          top: "0.5rem",
          right: "0.5rem",
          zIndex: 10,
          padding: "0.15rem 0.4rem",
          borderRadius: "0.375rem",
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text-muted)",
          cursor: "grab",
          lineHeight: 1,
          fontSize: "0.85rem",
          touchAction: "none",
        }}
      >
        ⠿
      </button>
      {children}
    </div>
  );
}

/**
 * The dashboard, in whatever order its reader dragged it into.
 *
 * The panels arrive already rendered from the server, so nothing about what
 * they contain or who may see them is decided here -- this only decides where
 * they sit. The new order is kept on screen straight away and saved behind it;
 * if the save fails the arrangement the reader can see is still the one they
 * made, and the message says it did not stick.
 */
export function SortableDashboard({
  tileOrder,
  panelOrder,
  defaultTileOrder,
  defaultPanelOrder,
  tiles,
  panels,
  labels,
  saveAction,
  resetAction,
}: {
  /** What is on screen now: the saved arrangement, or the default if none. */
  tileOrder: string[];
  panelOrder: string[];
  /** The order it arrives in, which Reset goes back to. */
  defaultTileOrder: string[];
  defaultPanelOrder: string[];
  tiles: Record<string, ReactNode>;
  panels: Record<string, ReactNode>;
  labels: Record<string, string>;
  saveAction: (panels: string[], tiles: string[]) => Promise<ActionState>;
  resetAction: () => Promise<ActionState>;
}) {
  const [tileIds, setTileIds] = useState(tileOrder);
  const [panelIds, setPanelIds] = useState(panelOrder);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click on the grip is
    // still a click and not an accidental half-move.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function persist(nextPanels: string[], nextTiles: string[]) {
    setMessage(null);
    startTransition(async () => {
      const result = await saveAction(nextPanels, nextTiles);
      if (result.error) setMessage(`Not saved: ${result.error}`);
    });
  }

  function move(
    event: DragEndEvent,
    ids: string[],
    setIds: (next: string[]) => void,
    persistWith: (next: string[]) => void,
  ) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setIds(next);
    persistWith(next);
  }

  const shownTiles = tileIds.filter((id) => tiles[id]);
  const shownPanels = panelIds.filter((id) => panels[id]);

  return (
    <>
      <div className="no-print flex items-center gap-3 flex-wrap mb-3">
        <p className="text-xs muted">
          Drag ⠿ to arrange this dashboard the way you work. Saved to your
          account, not this computer.
        </p>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending}
          onClick={() => {
            // Back to the built-in order, not to whatever was saved when this
            // page was drawn -- that is the arrangement being thrown away.
            setTileIds(defaultTileOrder);
            setPanelIds(defaultPanelOrder);
            setMessage(null);
            startTransition(async () => {
              const result = await resetAction();
              if (result.error) setMessage(`Not saved: ${result.error}`);
            });
          }}
        >
          Reset order
        </button>
        {pending ? <span className="text-xs muted">Saving…</span> : null}
        {message ? (
          <span className="text-xs" style={{ color: "var(--danger)" }}>
            {message}
          </span>
        ) : null}
      </div>

      {shownTiles.length > 0 ? (
        <DndContext
          // Named rather than left to dnd-kit's counter: with two contexts on
          // one page the server and the browser number them differently, and
          // React reports the announcement ids as a hydration mismatch.
          id="dashboard-tiles"
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) =>
            move(event, tileIds, setTileIds, (next) => persist(panelIds, next))
          }
        >
          <SortableContext items={shownTiles} strategy={rectSortingStrategy}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
              {shownTiles.map((id) => (
                <Sortable key={id} id={id} label={labels[id] ?? id}>
                  {tiles[id]}
                </Sortable>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : null}

      <DndContext
        id="dashboard-panels"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) =>
          move(event, panelIds, setPanelIds, (next) => persist(next, tileIds))
        }
      >
        {/* Two across on a wide screen, one on a narrow one, and reordering
            works the same either way -- a rectangle strategy reads the grid
            as it is laid out rather than assuming a single column. */}
        <SortableContext items={shownPanels} strategy={rectSortingStrategy}>
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            {shownPanels.map((id) => (
              <Sortable key={id} id={id} label={labels[id] ?? id}>
                {panels[id]}
              </Sortable>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </>
  );
}
