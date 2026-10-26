自备单位图标目录（R12 单位自定义）

控制台「高级 → 单位与图标」里给某个单位换图标时，值写 custom/文件名.png，
文件放在本目录（60x48 PNG 最佳，与 byid 图标同尺寸）。

访问路径：
  serve.py / mo_hud.exe 模式：/custom_icons/<文件名>.png
  file:// 直开页面：custom_icons/<文件名>.png（相对 Demo/index.html）

被引用的图标浏览器会缓存；更换同名文件后刷新页面即可。
