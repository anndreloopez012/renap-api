'use strict';

/**
 * Migration: Create PostgreSQL extensions and IMMUTABLE helper functions
 * needed for GIN trigram indexes on the infos table.
 *
 * NOTE: Index creation is intentionally NOT done here because Strapi runs
 * user migrations before the schema is fully synced, so the infos table
 * may not exist yet. Indexes are created in src/index.ts bootstrap instead.
 */

/** @type {import('@strapi/strapi').MigrationModule} */
module.exports = {
  async up(knex) {
    // Required PostgreSQL extensions
    await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await knex.raw('CREATE EXTENSION IF NOT EXISTS unaccent');

    // IMMUTABLE wrapper for unaccent (needed for functional GIN indexes)
    await knex.raw(`
      CREATE OR REPLACE FUNCTION f_unaccent(text)
      RETURNS text
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
      $$ SELECT unaccent('unaccent', $1) $$
    `);

    // IMMUTABLE full-name helper → lower(f_unaccent(trimmed concat of all name parts))
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
