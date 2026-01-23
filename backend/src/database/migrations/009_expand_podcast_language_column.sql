-- Expand language column to handle longer language codes
-- Some podcast feeds have language values longer than 10 characters
ALTER TABLE podcasts ALTER COLUMN language TYPE VARCHAR(100);
