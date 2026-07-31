-- A draft journal entry that will not proceed needs somewhere to go other than
-- deletion. Added on its own so the new enum value is committed before the
-- next migration references it.

alter type public.journal_status add value if not exists 'cancelled';
