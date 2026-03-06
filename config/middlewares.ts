import type { Core } from '@strapi/strapi';

const config: Core.Config.Middlewares = [
  'strapi::logger',
  'strapi::errors',
  'global::ip-security',
  'strapi::security',

  {
    name: 'strapi::cors',
    config: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      headers: '*',
      keepHeaderOnError: true,
    },
  },

  'strapi::poweredBy',
  'strapi::query',
  {
    name: 'strapi::body',
    config: {
      formLimit: '5gb',
      jsonLimit: '10mb',
      textLimit: '10mb',
      formidable: {
        maxFileSize: 5 * 1024 * 1024 * 1024, // 5 GB
      },
    },
  },
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];

export default config;