export default {
  routes: [
    {
      method: 'GET',
      path: '/infos/search',
      handler: 'info.search',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/infos/import',
      handler: 'info.import',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/infos/import/chunk',
      handler: 'info.importChunk',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/infos/import/process',
      handler: 'info.importProcess',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
