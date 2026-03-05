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
