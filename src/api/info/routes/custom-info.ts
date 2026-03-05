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
  ],
};
