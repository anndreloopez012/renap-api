/**
 * info controller
 */

import { factories } from '@strapi/strapi';

type QueryValue =
  | string
  | number
  | boolean
  | null
  | QueryValue[]
  | { [key: string]: QueryValue };

const sanitizeQuery = (query: unknown): QueryValue => {
  if (
    query === null ||
    typeof query === 'string' ||
    typeof query === 'number' ||
    typeof query === 'boolean'
  ) {
    return query as QueryValue;
  }

  if (Array.isArray(query)) {
    return query.map((value) => sanitizeQuery(value));
  }

  if (typeof query === 'object') {
    const entries = Object.entries(query as Record<string, unknown>).map(([key, value]) => [
      key,
      sanitizeQuery(value),
    ]);

    return Object.fromEntries(entries);
  }

  return String(query);
};

const toPositiveInt = (value: unknown, fallback: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), max);
};

export default factories.createCoreController('api::info.info', ({ strapi }) => ({
  async find(ctx) {
    const response = await super.find(ctx);
    await this.logInfoQuery(ctx);

    return response;
  },

  async findOne(ctx) {
    const response = await super.findOne(ctx);
    await this.logInfoQuery(ctx);

    return response;
  },

  async search(ctx) {
    const term = String(ctx.query.q ?? '').trim();
    const limit = toPositiveInt(ctx.query.limit, 20, 100);
    const page = toPositiveInt(ctx.query.page, 1, 100000);
    const offset = (page - 1) * limit;

    if (!term) {
      return ctx.badRequest('Debes enviar el parametro q con el termino a buscar.');
    }

    const isNumericTerm = /^\d+$/.test(term);
    const normalizedTerm = term.toLowerCase();

    const fullNameExpr =
      "lower(unaccent(trim(concat_ws(' ', primer_nombre, segundo_nombre, tercer_nombre, primer_apellido, segundo_apellido))))";

    const nameExpressions = [
      "lower(unaccent(coalesce(primer_nombre, '')))",
      "lower(unaccent(coalesce(segundo_nombre, '')))",
      "lower(unaccent(coalesce(tercer_nombre, '')))",
      "lower(unaccent(coalesce(primer_apellido, '')))",
      "lower(unaccent(coalesce(segundo_apellido, '')))",
    ];

    const sql = `
      SELECT
        id,
        document_id AS "documentId",
        cui AS "CUI",
        primer_nombre AS "PRIMER_NOMBRE",
        segundo_nombre AS "SEGUNDO_NOMBRE",
        tercer_nombre AS "TERCER_NOMBRE",
        primer_apellido AS "PRIMER_APELLIDO",
        segundo_apellido AS "SEGUNDO_APELLIDO",
        fecha_nacimiento AS "FECHA_NACIMIENTO",
        correo_electronico AS "CORREO_ELECTRONICO",
        telefono AS "TELEFONO",
        pais_residencia AS "PAIS_RESIDENCIA",
        depto_residencia AS "DEPTO_RESIDENCIA",
        munic_residencia AS "MUNIC_RESIDENCIA",
        direccion AS "DIRECCION",
        ws_mides AS "WS_MIDES",
        ws_maga AS "WS_MAGA",
        ws_mspas AS "WS_MSPAS",
        ws_mineco AS "WS_MINECO",
        similarity(${fullNameExpr}, lower(unaccent(?))) AS relevance
      FROM infos
      WHERE
        (
          (? = true AND cui::text LIKE ?)
          OR ${fullNameExpr} % lower(unaccent(?))
          OR ${fullNameExpr} LIKE '%' || lower(unaccent(?)) || '%'
          OR ${nameExpressions.map((expr) => `${expr} % lower(unaccent(?))`).join(' OR ')}
          OR ${nameExpressions.map((expr) => `${expr} LIKE '%' || lower(unaccent(?)) || '%'`).join(' OR ')}
        )
      ORDER BY
        CASE
          WHEN (? = true AND cui::text = ?) THEN 0
          WHEN ${fullNameExpr} = lower(unaccent(?)) THEN 1
          WHEN ${fullNameExpr} % lower(unaccent(?)) THEN 2
          ELSE 3
        END,
        relevance DESC,
        id DESC
      LIMIT ?
      OFFSET ?
    `;

    const bindings = [
      term,
      isNumericTerm,
      `${term}%`,
      term,
      term,
      ...Array(nameExpressions.length).fill(term),
      ...Array(nameExpressions.length).fill(term),
      isNumericTerm,
      term,
      term,
      term,
      limit,
      offset,
    ];

    const rawResult = await strapi.db.connection.raw(sql, bindings);
    const rows = Array.isArray(rawResult?.rows)
      ? rawResult.rows
      : Array.isArray(rawResult?.[0])
        ? rawResult[0]
        : [];

    await this.logInfoQuery(ctx);

    return {
      data: rows,
      meta: {
        pagination: {
          page,
          pageSize: limit,
          count: rows.length,
        },
        query: normalizedTerm,
      },
    };
  },

  async logInfoQuery(ctx) {
    try {
      const authenticatedUser = ctx.state.user;
      const userLabel =
        authenticatedUser?.username ||
        authenticatedUser?.email ||
        (authenticatedUser?.id ? `user-${authenticatedUser.id}` : 'anonymous');

      await strapi.entityService.create('api::info-log.info-log', {
        data: {
          searchedAt: new Date().toISOString(),
          userLabel,
          searchFilters: sanitizeQuery(ctx.query),
          requestPath: ctx.request.path,
          requestMethod: ctx.request.method,
          user: authenticatedUser?.id ?? null,
        },
      });
    } catch (error) {
      strapi.log.warn(`No se pudo guardar log de consulta de info: ${String(error)}`);
    }
  },
}));
