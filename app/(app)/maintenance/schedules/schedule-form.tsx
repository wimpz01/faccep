"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : "Add to schedule"}
    </button>
  );
}

export function ScheduleForm({
  action,
  locations,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  locations: { id: string; code: string; name: string }[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div className="sm:col-span-2">
        <label className="label" htmlFor="schedule-title">
          Recurring job *
        </label>
        <input
          id="schedule-title"
          name="title"
          className="input"
          required
          placeholder="Clean gutters"
        />
      </div>

      <div>
        <label className="label" htmlFor="schedule-location">
          Location
        </label>
        <select
          id="schedule-location"
          name="location_id"
          className="select"
          defaultValue=""
        >
          <option value="">All locations</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.code} — {location.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="schedule-month">
          Month
        </label>
        <select id="schedule-month" name="month_of_year" className="select" defaultValue="">
          <option value="">Any</option>
          {MONTHS.map((month, index) => (
            <option key={month} value={index + 1}>
              {month}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="schedule-interval">
          Every (months)
        </label>
        <input
          id="schedule-interval"
          name="interval_months"
          type="number"
          min="1"
          className="input"
          defaultValue="12"
        />
      </div>

      <div>
        <label className="label" htmlFor="schedule-assignee">
          Usually done by
        </label>
        <input id="schedule-assignee" name="assigned_to" className="input" />
      </div>

      <div className="sm:col-span-3">
        <label className="label" htmlFor="schedule-description">
          Notes
        </label>
        <input id="schedule-description" name="description" className="input" />
      </div>

      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit />
        <FormError message={state.error} />
        {state.success ? (
          <p className="text-sm" style={{ color: "var(--success)" }}>
            {state.success}
          </p>
        ) : null}
      </div>
    </form>
  );
}
