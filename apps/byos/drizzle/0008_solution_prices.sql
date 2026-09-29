-- Add auction-time price snapshot columns to the solutions table.
-- All columns are nullable so existing rows are unaffected and no backfill is needed.
ALTER TABLE solutions
  ADD COLUMN sell_token_ref_price    text,
  ADD COLUMN surplus_token_ref_price text,
  ADD COLUMN auction_gas_price       text,
  ADD COLUMN clearing_prices         jsonb;
