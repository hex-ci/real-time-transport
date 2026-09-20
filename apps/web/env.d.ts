/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Pin the position to fixed coordinates (development only). */
  readonly VITE_GPS_SIMULATION?: string
  readonly VITE_GPS_SIM_LAT?: string
  readonly VITE_GPS_SIM_LNG?: string
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

declare module 'vue-konva'
