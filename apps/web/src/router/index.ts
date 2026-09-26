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
        // 关注线路：搜索、关注、排序，以及每条线路自己的报站屏站点。
        { path: 'lines', name: 'settings-lines', component: () => import('@/views/settings/lines.vue') },
        // 早晚高峰起止时刻，存 user_settings。
        { path: 'schedule', name: 'settings-schedule', component: () => import('@/views/settings/schedule.vue') },
        // 家 / 公司：步行时间从它们出发测量。
        { path: 'anchors', name: 'settings-anchors', component: () => import('@/views/settings/anchors.vue') },
        // 通勤链路的录入与编辑；链路页只读结论。
        { path: 'chains', name: 'settings-chains', component: () => import('@/views/settings/chains.vue') },
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
