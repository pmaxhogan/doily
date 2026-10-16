-- doily schema v1: request bookkeeping lives in the SciNetRequest DO; D1 holds the daily spend ledger.
CREATE TABLE IF NOT EXISTS scinet_spend (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0);
