'use strict';

/**
 * Migration: Create GIN trigram + B-tree indexes on infos table
 * for fast full-text name search and CUI lookup on 12M+ records.
 *
 * NOTE: This migration creates indexes WITHOUT CONCURRENTLY (required
 * inside a transaction). For production with active traffic, you may
 * prefer to run the SQL manually with CONCURRENTLY during off-peak hours:
 *
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_infos_cui ON infos (cui);
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_infos_fullname_trgm
 *     ON infos USING gin (
 *       lower(unaccent(trim(concat_ws(' ', primer_nombre, segundo_nombre,
 *         tercer_nombre, primer_apellido, segundo_apellido)))) gin_trgm_ops
 *     );
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_infos_primer_nombre_trgm
 *     ON infos USING gin (lower(unaccent(coalesce(primer_nombre, ''))) gin_trgm_ops);
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_infos_primer_apellido_trgm
 *     ON infos USING gin (lower(unaccent(coalesce(primer_apellido, ''))) gin_trgm_ops);
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_infos_segundo_apellido_trgm
 *     ON infos USING gin (lower(unaccent(coalesce(segundo_apellido, ''))) gin_trgm_ops);
 */

/** @type {import('@strapi/strapi').MigrationModule} */
module.exports = {
  async up(knex) {
    // Required PostgreSQL extensions
    await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await knex.raw('CREATE EXTENSION IF NOT EXISTS unaccent');

    // unaccent() is STABLE → create IMMUTABLE wrapper calling the C function directly.
    await knex.raw(`
      CREATE OR REPLACE FUNCTION f_unaccent(text)
      RETURNS text
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
      $$ SELECT unaccent('unaccent', $1) $$
    `);

    // concat_ws() is also STABLE → create IMMUTABLE full-name helper.
    // Uses coalesce + || (both IMMUTABLE) instead of concat_ws.
    // Returns lower(f_unaccent(trimmed full name)) ready for GIN trigram comparison.
    await knex.raw(`
      CREATE OR REPLACE FUNCTION f_fullname(text, text, text, text, text)
      RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
      $$
        SELECT lower(f_unaccent(trim(
          coalesce($1, '') || ' ' ||
          coalesce($2, '') || ' ' ||
          coalesce($3, '') || ' ' ||
          coalesce($4, '') || ' ' ||
          coalesce($5, '')
        )))
      $$
    `);

    // B-tree index on CUI (biginteger) → exact match in O(log n)
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_infos_cui ON infos (cui)');

    // GIN trigram index on the full name via f_fullname (fully IMMUTABLE chain)
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_infos_fullname_trgm ON infos
      USING gin (
        f_fullname(primer_nombre, segundo_nombre, tercer_nombre, primer_apellido, segundo_apellido)
        gin_trgm_ops
      )
    `);

    // GIN trigram indexes on individual name columns
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_infos_primer_nombre_trgm ON infos
      USING gin (lower(f_unaccent(coalesce(primer_nombre, ''))) gin_trgm_ops)
    `);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_infos_primer_apellido_trgm ON infos
      USING gin (lower(f_unaccent(coalesce(primer_apellido, ''))) gin_trgm_ops)
    `);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_infos_segundo_apellido_trgm ON infos
      USING gin (lower(f_unaccent(coalesce(segundo_apellido, ''))) gin_trgm_ops)
    `);
  },

  async down(knex) {
    await knex.raw('DROP INDEX IF EXISTS idx_infos_cui');
    await knex.raw('DROP INDEX IF EXISTS idx_infos_fullname_trgm');
    await knex.raw('DROP INDEX IF EXISTS idx_infos_primer_nombre_trgm');
    await knex.raw('DROP INDEX IF EXISTS idx_infos_primer_apellido_trgm');
    await knex.raw('DROP INDEX IF EXISTS idx_infos_segundo_apellido_trgm');
    await knex.raw('DROP FUNCTION IF EXISTS f_fullname(text, text, text, text, text)');
    await knex.raw('DROP FUNCTION IF EXISTS f_unaccent(text)');
  },
};
