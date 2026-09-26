<template>
  <!-- 「设置」的路由框：只有出口。子路由为什么嵌套（见 `router/index.ts`）是这个文件存在的唯一
       结构事实：顶部导航把「设置」项渲染成 `<RouterLink to="/settings">` 并交给 vue-router 的
       `active-class`，而那个匹配跟随「匹配到的路由记录」。四个域作为 `/settings` 的子路由时，
       `/settings/lines` 仍匹配父记录，导航项在每个子页面上都保持点亮；做成四个平级兄弟路由，
       一进子页面它就暗了。这里没有内边距、没有宽度、没有标题：索引是 `max-w-2xl`，每个子页面是
       `max-w-3xl`，带其中任何一样的包装层都会成为第三个决定设置页版式的地方。 -->
  <RouterView />
</template>
