-- Make phone_number optional so users can register without one
ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL;
