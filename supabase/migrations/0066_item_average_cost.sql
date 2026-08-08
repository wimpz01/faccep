/**
 * What stock is actually worth, from what was actually paid.
 *
 * Stock value was quantity on hand times the item's unit_cost field -- a
 * number somebody has to remember to type. Nobody had, so every item sat at
 * zero: INVENTORY 1 showed a stock value of nothing while ₱700 of it had been
 * bought and four were on the shelf.
 *
 * The ledger already knows. Every movement in carries the cost it came in at,
 * so a weighted average over the inflows is the real cost per unit -- ₱700
 * over 5 received is ₱140 each, whatever the item record claims.
 *
 * The standing unit_cost is kept as the fallback for an item that has never
 * moved, and is still what a fresh adjustment values itself at until the item
 * has some history.
 */
create or replace view public.inventory_item_costs
with (security_invoker = true) as
  select
    i.id                                as item_id,
    i.company_id,
    i.quantity_on_hand,
    i.unit_cost                         as standing_cost,
    coalesce(sum(m.quantity) filter (where m.quantity > 0), 0)      as quantity_in,
    coalesce(round(sum(m.quantity * m.unit_cost)
                   filter (where m.quantity > 0), 2), 0)            as spent_in,
    -- What a unit has cost on average. Falls back to the item's own figure
    -- when nothing has ever come in.
    coalesce(
      round((sum(m.quantity * m.unit_cost) filter (where m.quantity > 0))
            / nullif(sum(m.quantity) filter (where m.quantity > 0), 0), 4),
      i.unit_cost
    )                                                               as average_cost,
    round(i.quantity_on_hand * coalesce(
      round((sum(m.quantity * m.unit_cost) filter (where m.quantity > 0))
            / nullif(sum(m.quantity) filter (where m.quantity > 0), 0), 4),
      i.unit_cost
    ), 2)                                                           as stock_value
  from public.inventory_items i
  left join public.inventory_movements m on m.item_id = i.id
 group by i.id, i.company_id, i.quantity_on_hand, i.unit_cost;

comment on view public.inventory_item_costs is
  'Weighted average cost per item from the movement ledger, and what the stock '
  'on hand is worth at it. security_invoker, so row-level security still applies.';

grant select on public.inventory_item_costs to authenticated;
