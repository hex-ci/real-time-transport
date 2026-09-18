import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import type { TransitCity } from '@real-time-transport/shared'
import { DEFAULT_CITY_CODE } from '@real-time-transport/shared'

const STORAGE_KEY = 'rt-transit-city'

export const useCityStore = defineStore('city', () => {
  const cities = shallowRef<TransitCity[]>([])
  const currentCode = shallowRef<string>(
    localStorage.getItem(STORAGE_KEY) || DEFAULT_CITY_CODE,
  )
  const isLoading = shallowRef(false)

  const currentCity = computed<TransitCity | undefined>(() =>
    cities.value.find(c => c.code === currentCode.value),
  )

  const currentCityName = computed<string>(() => currentCity.value?.name || '北京')

  const hotCities = computed(() => cities.value.filter(c => c.hot))

  async function fetchCities(): Promise<void> {
    if (cities.value.length > 0) return
    isLoading.value = true
    try {
      const res = await fetch('/api/transit/cities')
      const json = await res.json()
      if (json.success && Array.isArray(json.data)) {
        cities.value = json.data
      }
    }
    catch (err) {
      console.warn('Failed to load city dictionary:', err)
    }
    finally {
      isLoading.value = false
    }
  }

  function setCity(code: string): void {
    currentCode.value = code
    localStorage.setItem(STORAGE_KEY, code)
  }

  /** Filter a keyword against name / pinyin prefix. */
  function matchCity(keyword: string): TransitCity[] {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return hotCities.value
    return cities.value.filter(c =>
      c.name.includes(keyword.trim())
      || c.pinyin.toLowerCase().startsWith(kw)
      || c.pinyin.toLowerCase().includes(kw),
    )
  }

  return {
    cities,
    currentCode,
    currentCity,
    currentCityName,
    hotCities,
    isLoading,
    fetchCities,
    setCity,
    matchCity,
  }
})
