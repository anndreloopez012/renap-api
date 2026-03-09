import type { Core } from '@strapi/strapi';

const warmIpSecurityCache = async (strapi: Core.Strapi) => {
  strapi.log.info('[ip-security] Precargando listas de seguridad en cache...');
  try {
    const [wl, bl, rb] = await Promise.all([
      strapi.entityService.findMany('api::ip-whitelist.ip-whitelist', {
        filters: { active: true },
        fields: ['ip'],
        pagination: { pageSize: 1000 },
      }),
      strapi.entityService.findMany('api::ip-blacklist.ip-blacklist', {
        filters: { active: true },
        fields: ['ip'],
        pagination: { pageSize: 5000 },
      }),
      strapi.entityService.findMany('api::region-block.region-block', {
        filters: { active: true },
        fields: ['countryCode'],
        pagination: { pageSize: 300 },
      }),
    ]);
    strapi.log.info(
      `[ip-security] Cache cargada: ${(wl as any[]).length} whitelist | ${(bl as any[]).length} blacklist | ${(rb as any[]).length} regiones bloqueadas.`
    );
  } catch (err) {
    strapi.log.warn(`[ip-security] No se pudo precargar cache de seguridad: ${err}`);
  }
};

const ensureInfoSearchIndexes = async (strapi: Core.Strapi) => {
  const client = strapi.config.get('database.connection.client');
  if (client !== 'postgres') {
    strapi.log.info('[info-search] Indices de busqueda omitidos: base de datos no es postgres.');
    return;
  }

  strapi.log.info('[info-search] Verificando extensiones e indices de busqueda...');

  const knex = strapi.db.connection;

  // Extensions (idempotent)
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS unaccent');

  // IMMUTABLE helper functions (idempotent via CREATE OR REPLACE)
  await knex.raw(`
    CREATE OR REPLACE FUNCTION f_unaccent(text)
    RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
    $$ SELECT unaccent('unaccent', $1) $$
  `);
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

  // Indexes — only created if missing, never dropped (safe for 12M+ rows)
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_infos_cui ON infos (cui)',
    `CREATE INDEX IF NOT EXISTS idx_infos_fullname_trgm ON infos
      USING gin (f_fullname(primer_nombre, segundo_nombre, tercer_nombre, primer_apellido, segundo_apellido) gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_infos_primer_nombre_trgm ON infos
      USING gin (lower(f_unaccent(coalesce(primer_nombre, ''))) gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_infos_segundo_nombre_trgm ON infos
      USING gin (lower(f_unaccent(coalesce(segundo_nombre, ''))) gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_infos_tercer_nombre_trgm ON infos
      USING gin (lower(f_unaccent(coalesce(tercer_nombre, ''))) gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_infos_primer_apellido_trgm ON infos
      USING gin (lower(f_unaccent(coalesce(primer_apellido, ''))) gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_infos_segundo_apellido_trgm ON infos
      USING gin (lower(f_unaccent(coalesce(segundo_apellido, ''))) gin_trgm_ops)`,
  ];

  for (const sql of indexes) {
    try {
      await knex.raw(sql);
    } catch (error) {
      strapi.log.warn(`[info-search] No se pudo crear indice: ${String(error)}`);
    }
  }

  strapi.log.info('[info-search] Verificacion de indices finalizada.');
};

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await ensureInfoSearchIndexes(strapi);
    await warmIpSecurityCache(strapi);
  },
};
