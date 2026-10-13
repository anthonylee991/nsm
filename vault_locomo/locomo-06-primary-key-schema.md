# Primary Key Schema Evolution (ULID vs BigInt Auto-Increment)

## sess-1
**USER**: Historical schema used BIGSERIAL auto-incrementing integer IDs for PostgreSQL tables.

## sess-2
**USER**: ADR-044: All new tables must use 26-character ULID strings stored as VARCHAR(26).

