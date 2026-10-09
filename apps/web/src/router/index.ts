import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'overview',
      component: () => import('@/views/overview/index.vue'),
    },
    {
      path: '/line/:id',
      name: 'line-detail',
      component: () => import('@/views/line-detail/index.vue'),
      props: route => ({
        id: route.params.id,
        direction: route.query.direction,
        cityCode: route.query.cityCode,
      }),
    },
    {
      path: '/platform',
      name: 'platform',
      component: () => import('@/views/platform/index.vue'),
    },
    {
      // 换乘链路：一级入口，独立于关注线路列表的界面。
      path: '/commute-chain',
      name: 'commute-chain',
      component: () => import('@/views/commute-chain/index.vue'),
    },
    {
      // 设置：四个域的索引页，四个页面是它的子路由。
      //
      // 这层嵌套是承重的：顶部导航是带 active-class 的 `<RouterLink to="/settings">`，而 vue-router
      // 默认的激活匹配跟随已匹配的路由**记录**——四个域作子路由时，/settings/lines 仍匹配父记录、
      // 导航项在每个子页面保持点亮；四条平级的 /settings/… 会让它变暗。
      // 索引页本身是空路径子路由，故 /settings 仍是自己的页面。
      path: '/settings',
      component: () => import('@/views/settings/layout.vue'),
      children: [
        { path: '', name: 'settings', component: () => import('@/views/settings/index.vue') },
        // 关注线路：搜索、关注、拖动排序，以及每行一个进编辑页的入口。
        { path: 'lines', name: 'settings-lines', component: () => import('@/views/settings/lines.vue') },
        // 一条关注线路自己的页面：方向与上车点，加保存与取消关注。
        // 参数不加正则：关注行的 id 由服务端生成，取值范围是开放的（照锚点那两个子页的做法，
        // 「参数不合法」那一半由页面在列表**作答**之后说「这条关注不存在」，不发明默认值）。
        {
          path: 'lines/:favoriteId',
          name: 'settings-line-editor',
          component: () => import('@/views/settings/favorite-editor.vue'),
          props: route => ({ favoriteId: route.params.favoriteId }),
        },
        // 早晚高峰起止时刻，存 user_settings。
        { path: 'schedule', name: 'settings-schedule', component: () => import('@/views/settings/schedule.vue') },
        // 实时数据刷新间隔（秒）：驱动服务端轮询节拍，存 user_settings，保存即时生效。
        { path: 'refresh-interval', name: 'settings-refresh-interval', component: () => import('@/views/settings/refresh-interval.vue') },
        // 家 / 公司：步行时间从它们出发测量。索引页两行整行可点，各自进自己那一页。
        { path: 'anchors', name: 'settings-anchors', component: () => import('@/views/settings/anchors.vue') },
        // 两个锚点**同构**，故共用一个页面，文案与图标查 `anchor-catalog.ts` 的表。
        // 参数正则让 `home` / `work` 之外的写法落到兜底的 404 页 —— 页面自己也不发明
        // 默认值（认不出的参数按「家」渲染，会让用户在以为自己在设公司的时候改掉家）。
        {
          path: 'anchors/:anchor(home|work)',
          name: 'settings-anchor',
          component: () => import('@/views/settings/anchor-detail.vue'),
          props: route => ({ anchor: route.params.anchor }),
        },
        // 通勤链路：列表页放列表、拖动排序与「新增链路」，录入与编辑在它自己的两个子页里。
        { path: 'chains', name: 'settings-chains', component: () => import('@/views/settings/chains.vue') },
        // 新建一条链路。它是**静态**路径，故必须排在 `chains/:chainId` 之前 —— 否则 `new`
        // 会被读成一个 chainId，而那一页只能说「这条链路不存在」。
        {
          path: 'chains/new',
          name: 'settings-chain-new',
          component: () => import('@/views/settings/chain-editor.vue'),
          props: () => ({ chainId: null }),
        },
        // 一条链路自己的页面：与上面共用同一个组件，只差参数。
        // 参数不加正则：链路行的 id 由服务端生成，取值范围是开放的（照关注线路那一页的做法，
        // 「参数不合法」那一半由页面在列表**作答**之后说「这条链路不存在」，不发明默认值）。
        {
          path: 'chains/:chainId',
          name: 'settings-chain-editor',
          component: () => import('@/views/settings/chain-editor.vue'),
          props: route => ({ chainId: route.params.chainId }),
        },
      ],
    },
    {
      // 兜底路由：未匹配的路径必须说出来。渲染空白会被读成应用坏了，而不是网址错了。
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/not-found/index.vue'),
    },
  ],
})

export default router
