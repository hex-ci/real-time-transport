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
      // F10: the recorded commute chains and their per-transfer conclusions. A
      // first-level entry of its own, because it is a different surface from the
      // followed-lines list rather than a block of it.
      path: '/commute-chain',
      name: 'commute-chain',
      component: () => import('@/views/commute-chain/index.vue'),
    },
    {
      // 设置: an INDEX of four domains, and the four pages are its CHILDREN.
      //
      // The nesting is load-bearing rather than cosmetic. The top nav renders its 「设置」
      // item as a `<RouterLink to="/settings">` carrying `active-class`, and vue-router's
      // default active matching follows matched route RECORDS: with the four domains as
      // children, `/settings/lines` still matches the parent record and the nav item stays
      // lit on every sub-page, where four flat `/settings/…` siblings would leave it dark.
      // The index itself is the empty-path child, so `/settings` is still its own page.
      path: '/settings',
      component: () => import('@/views/settings/layout.vue'),
      children: [
        { path: '', name: 'settings', component: () => import('@/views/settings/index.vue') },
        // 关注线路 (F9): search, follow, order, and each line's own board stops.
        { path: 'lines', name: 'settings-lines', component: () => import('@/views/settings/lines.vue') },
        // 早晚高峰起止时刻 (存 `user_settings`).
        { path: 'schedule', name: 'settings-schedule', component: () => import('@/views/settings/schedule.vue') },
        // 家 / 公司 (F2): F1's walking time is measured from them.
        { path: 'anchors', name: 'settings-anchors', component: () => import('@/views/settings/anchors.vue') },
        // 通勤链路的录入与编辑 (F10) — 链路页 only reads conclusions.
        { path: 'chains', name: 'settings-chains', component: () => import('@/views/settings/chains.vue') },
      ],
    },
    {
      // Catch-all: an unmatched path must SAY so. Rendering nothing leaves the
      // page silently blank, which reads as a broken app rather than a bad URL
      // (e.g. /line/ with the line id missing).
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/not-found/index.vue'),
    },
  ],
})

export default router
