import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'overview',
      component: () => import('@/views/OverviewView.vue'),
    },
    {
      path: '/line/:id',
      name: 'line-detail',
      component: () => import('@/views/LineDetailView.vue'),
      props: route => ({
        id: route.params.id,
        direction: route.query.direction,
        cityCode: route.query.cityCode,
      }),
    },
    {
      path: '/platform',
      name: 'platform',
      component: () => import('@/views/PlatformView.vue'),
    },
    {
      path: '/kiosk',
      name: 'kiosk',
      component: () => import('@/views/KioskView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
    },
    {
      // Catch-all: an unmatched path must SAY so. Rendering nothing leaves the
      // page silently blank, which reads as a broken app rather than a bad URL
      // (e.g. /line/ with the line id missing).
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
    },
  ],
})

export default router
