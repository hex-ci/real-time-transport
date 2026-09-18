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
  ],
})

export default router
