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

    // B-tree index on CUI (biginteger) → exact match in O(log n)
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS idx_infos_cui ON infos (cui)'
    );

    // GIN trigram index on the full concatenated name expression.
    // Matches the exact expression used in the WHERE clause of the search query,
    // enabling PostgreSQL to use this index for both % (similarity) and LIKE '%term%'.
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_infos_fullname_trgm ON infos
      USING gin (
        lower(unaccent(trim(concat_ws(' ',
          primer_nombre,
          segundo_nombre,
          tercer_nombre,
          primer_apellido,
          segundo_apellido
        )))) gin_trgm_ops
      )
    `);

    // GIN trigram index on individual name columns for single-word matching
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_infos_primer_nombre_trgm ON infos
      USING gin (lower(unaccent(coalesce(primer_nombre, ''))) gin_trgm_ops)
    `);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_infos_primer_apellido_trgm ON infos
      USING gin (lower(unaccent(coalesce(primer_apellido, ''))) gin_trgm_ops)
    `);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_infos_segundo_apellido_trgm ON infos
      USING gin (lower(unaccent(coalesce(segundo_apellido, ''))) gin_trgm_ops)
    `);
  },

  async down(knex) {
    await knex.raw('DROP INDEX IF EXISTS idx_infos_cui');
    await knex.raw('DROP INDEX IF EXISTS idx_infos_fullname_trgm');
    await knex.raw('DROP INDEX IF EXISTS idx_infos_primer_nombre_trgm');
    await knex.raw('DROP INDEX IF EXISTS idx_infos_primer_apellido_trgm');
    await knex.raw('DROP INDEX IF EXISTS idx_infos_segundo_apellido_trgm');
  },
};
