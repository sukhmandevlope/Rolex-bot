CREATE OR REPLACE FUNCTION reject_financial_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial_ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS financial_ledger_no_update ON financial_ledger;
CREATE TRIGGER financial_ledger_no_update
BEFORE UPDATE OR DELETE ON financial_ledger
FOR EACH ROW EXECUTE FUNCTION reject_financial_ledger_mutation();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_ledger_positive_amount') THEN
    ALTER TABLE financial_ledger
      ADD CONSTRAINT financial_ledger_positive_amount CHECK (amount > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_ledger_valid_side') THEN
    ALTER TABLE financial_ledger
      ADD CONSTRAINT financial_ledger_valid_side CHECK (side IN ('debit', 'credit'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_balanced_financial_transaction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE imbalance numeric;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN side='debit' THEN amount ELSE -amount END),0)
    INTO imbalance FROM financial_ledger WHERE transaction_public_id=NEW.transaction_public_id;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'financial transaction % is not balanced', NEW.transaction_public_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS financial_ledger_balanced ON financial_ledger;
CREATE CONSTRAINT TRIGGER financial_ledger_balanced
AFTER INSERT ON financial_ledger DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_balanced_financial_transaction();