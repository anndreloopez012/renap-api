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

  const run = async (sql: string) => {
    await strapi.db.connection.raw(sql);
  };

  await run('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
  await run('CREATE EXTENSION IF NOT EXISTS unaccent;');
  await run("CREATE OR REPLACE FUNCTION immutable_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT unaccent($1) $$;");

  const statements = [
    'CREATE INDEX IF NOT EXISTS idx_infos_cui ON infos (cui);',

    'DROP INDEX IF EXISTS idx_infos_primer_nombre_trgm;',
    "CREATE INDEX idx_infos_primer_nombre_trgm ON infos USING gin (lower(immutable_unaccent(coalesce(primer_nombre, ''))) gin_trgm_ops);",

    'DROP INDEX IF EXISTS idx_infos_segundo_nombre_trgm;',
    "CREATE INDEX idx_infos_segundo_nombre_trgm ON infos USING gin (lower(immutable_unaccent(coalesce(segundo_nombre, ''))) gin_trgm_ops);",

    'DROP INDEX IF EXISTS idx_infos_tercer_nombre_trgm;',
    "CREATE INDEX idx_infos_tercer_nombre_trgm ON infos USING gin (lower(immutable_unaccent(coalesce(tercer_nombre, ''))) gin_trgm_ops);",

    'DROP INDEX IF EXISTS idx_infos_primer_apellido_trgm;',
    "CREATE INDEX idx_infos_primer_apellido_trgm ON infos USING gin (lower(immutable_unaccent(coalesce(primer_apellido, ''))) gin_trgm_ops);",

    'DROP INDEX IF EXISTS idx_infos_segundo_apellido_trgm;',
    "CREATE INDEX idx_infos_segundo_apellido_trgm ON infos USING gin (lower(immutable_unaccent(coalesce(segundo_apellido, ''))) gin_trgm_ops);",

    'DROP INDEX IF EXISTS idx_infos_full_name_trgm;',
    "CREATE INDEX idx_infos_full_name_trgm ON infos USING gin (lower(immutable_unaccent(trim(concat_ws(' ', primer_nombre, segundo_nombre, tercer_nombre, primer_apellido, segundo_apellido)))) gin_trgm_ops);",
  ];

  for (const sql of statements) {
    try {
      await run(sql);
    } catch (error) {
      strapi.log.warn(`[info-search] No se pudo ejecutar indice: ${sql}`);
      strapi.log.warn(`[info-search] Motivo: ${String(error)}`);
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
