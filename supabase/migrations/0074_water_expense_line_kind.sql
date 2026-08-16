/**
 * A billed share of the water expense.
 *
 * Electricity has always had one of these: the generator's fuel and servicing
 * is a building cost that no per-kWh rate covers, so it is shared out by each
 * tenant's kWh. Water has the same kind of cost -- pumping, tank cleaning,
 * treatment -- and until now there was nowhere to put it.
 *
 * It is its own line kind rather than folded into the metered water charge,
 * because a tenant reading their bill should see what they used and what they
 * are carrying a share of as two separate figures.
 *
 * Alone in its own migration: Postgres refuses to use a new enum value in the
 * same transaction that adds it, so the code that reads it lands next.
 */

alter type public.invoice_line_kind add value if not exists 'water_expense';
