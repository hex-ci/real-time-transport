<template>
  <!--
    设置's route frame: nothing but the outlet.

    WHY THE CHILDREN ARE NESTED (`router/index.ts`), which is the one structural fact this
    file exists for: the top nav renders its 「设置」 item as a `<RouterLink to="/settings">`
    with vue-router's own `active-class`, and that matching follows matched route RECORDS.
    With the four domains as CHILDREN of `/settings`, `/settings/lines` still matches the
    parent record, so the nav item stays lit on every sub-page; as four flat sibling routes
    it would go dark the moment a sub-page opened.

    No padding, no width, no heading lives here: the index is `max-w-2xl` and every
    sub-page is `max-w-3xl`, and a wrapper that carried either would be a third place the
    layout of a settings screen is decided.
  -->
  <RouterView />
</template>
